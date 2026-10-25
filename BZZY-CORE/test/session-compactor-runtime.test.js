import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { CoreAssistant } from '../src/assistant.js';
import { createSession, loadSession, saveSession } from '../src/engine/store.js';
import { getProvider } from '../src/engine/providers.js';
import { appendEvent, getRecord, putRecord, listRecords } from '../src/engine/database.js';
import { queueSessionCompaction } from '../src/engine/session-compactor.js';
import { ensureRuntime, runtimeRequest, runtimeInfo, clearOperatorStopIntent } from '../src/engine/runtime.js';
import { processIdentity, identityAlive, signalProcess } from '../src/engine/process-identity.js';

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(check, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(30); }
  throw new Error('The isolated compactor runtime did not reach its expected state.');
}

test('daemon compaction defers direct CLI foreground work, uses no tools, and operator stop halts document backends durably', { timeout: 45000 }, async () => {
  const variables = ['BZZY_HOME', 'BZZY_CODEX_HOME', 'BZZY_CODEX_BIN', 'BZZY_ENV_ALLOW', 'BZZY_TEST_LEARNING_LOG',
    'BZZY_TEST_LEARNING_MODE', 'BZZY_TEST_LEARNING_BAD_PROFILE', 'NODE_OPTIONS'];
  const previous = Object.fromEntries(variables.map(key => [key, process.env[key]]));
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-compactor-runtime-')));
  const modeFile = path.join(directory, 'mode'), logFile = path.join(directory, 'backend.jsonl');
  let info, blockerIdentity, documentBackend;
  try {
    Object.assign(process.env, { BZZY_HOME: path.join(directory, 'private'), BZZY_CODEX_HOME: path.join(directory, 'fixture-auth'),
      BZZY_TEST_LEARNING_LOG: logFile, BZZY_TEST_LEARNING_MODE: modeFile,
      BZZY_ENV_ALLOW: 'BZZY_TEST_LEARNING_LOG,BZZY_TEST_LEARNING_MODE', NODE_OPTIONS: '' });
    delete process.env.BZZY_TEST_LEARNING_BAD_PROFILE;
    fs.mkdirSync(process.env.BZZY_CODEX_HOME, { mode: 0o700 });
    fs.writeFileSync(path.join(process.env.BZZY_CODEX_HOME, 'auth.json'), '{}', { mode: 0o600 });
    fs.writeFileSync(modeFile, 'normal');
    const wrapper = path.join(directory, 'codex-fixture.mjs');
    fs.writeFileSync(wrapper, `#!${process.execPath}\nimport fs from 'node:fs';
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = function(chunk, ...args) {
  let message; try { message = JSON.parse(String(chunk)); } catch {}
  if (message?.method === 'turn/completed' && fs.readFileSync(process.env.BZZY_TEST_LEARNING_MODE, 'utf8') === 'hold') return true;
  return write(chunk, ...args);
};
await import(${JSON.stringify(new URL('./fixtures/learning-codex.mjs', import.meta.url).href)});
`, { mode: 0o700 });
    process.env.BZZY_CODEX_BIN = wrapper;
    new CoreAssistant().configure({ source: 'core', provider: 'codex', model: 'offline-compactor', effort: 'default' }, { requestId: randomUUID(), expectedRevision: 0 });
    const cwd = path.join(directory, 'project'); fs.mkdirSync(cwd);
    const source = createSession(getProvider('codex'), cwd, 'foreground-model');
    const other = createSession(getProvider('codex'), cwd, 'second-foreground');
    const nativeCalls = () => fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
    const turns = () => nativeCalls().filter(call => call.method === 'turn/start').length;
    const queue = target => {
      for (let index = 0; index < 8; index++) appendEvent(target.id, index % 2 ? 'text' : 'message.user', {
        text: `Observation ${index}: ${'Keep incomplete authorization controls explicitly inconclusive. '.repeat(8)}` });
      queueSessionCompaction(target, { force: true });
      return listRecords('core.session.compactor.job', { sessionId: target.id }).find(job => job.state === 'queued');
    };
    const blocker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    await new Promise((resolve, reject) => { blocker.once('spawn', resolve); blocker.once('error', reject); });
    blockerIdentity = processIdentity(blocker.pid); assert.ok(blockerIdentity);
    const foreign = createSession(getProvider('codex'), cwd, 'direct-cli-model'); foreign.executionState = 'running'; saveSession(foreign);
    putRecord('run', foreign.id, { sessionId: foreign.id, state: 'running', runner: blockerIdentity });
    const first = queue(source); info = await ensureRuntime();
    const owner = (operation, target = source, input = {}) => runtimeRequest(info, 'POST', `/knowledge/session-memory.${operation}`, { sessionId: target.id, ...input });
    await owner('status'); await owner('read'); await delay(350);
    assert.equal(getRecord('core.session.compactor.job', first.id).state, 'queued'); assert.equal(turns(), 0);
    putRecord('run', foreign.id, { sessionId: foreign.id, state: 'idle', runner: blockerIdentity });
    foreign.executionState = 'idle'; saveSession(foreign);
    signalProcess(blockerIdentity, 'SIGKILL', { group: true }); await until(() => !identityAlive(blockerIdentity));
    await until(() => getRecord('core.session.compactor.job', first.id)?.state === 'completed'); assert.equal(turns(), 1);
    const start = nativeCalls().find(call => call.method === 'thread/start');
    assert.equal(start.params.permissions, 'bzzy_learning_review_v1'); assert.deepEqual(start.params.dynamicTools, []);
    assert.equal(nativeCalls().find(call => call.id === 900 && !call.method).result.decision, 'decline');
    assert.equal(listRecords('execution').length, 0);

    fs.writeFileSync(modeFile, 'hold'); const held = queue(source);
    documentBackend = await until(() => {
      const draft = listRecords('session').find(item => item.purpose === 'document' && item.documentSourceSessionId === source.id && identityAlive(item.backendProcess));
      return getRecord('core.session.compactor.job', held.id)?.state === 'running' && turns() === 2 && draft?.backendProcess;
    });
    const pending = queue(other); await runtimeRequest(info, 'POST', '/operator-stop', { shutdown: false });
    assert.equal(identityAlive(documentBackend), false);
    assert.equal(getRecord('core.session.compactor.job', held.id).state, 'paused'); assert.equal(getRecord('core.session.compactor.job', pending.id).state, 'paused');
    await assert.rejects(owner('status'), { code: 'CORE_STOPPED' });
    const stopped = info; await runtimeRequest(info, 'POST', '/shutdown', {}); await until(() => !identityAlive(stopped.identity));
    clearOperatorStopIntent(); fs.writeFileSync(modeFile, 'normal'); info = await ensureRuntime();
    await owner('status', other); await owner('read', other); await delay(350); assert.equal(turns(), 2);
    const status = await owner('status', other);
    await owner('control', other, { action: 'resume', expectedRevision: status.control.revision });
    await until(() => getRecord('core.session.compactor.job', pending.id)?.state === 'completed'); assert.equal(turns(), 3);
    assert.equal(getRecord('core.session.compactor.job', held.id).state, 'paused');
    assert.equal(loadSession(source.id).model, 'foreground-model');
  } finally {
    for (const identity of [documentBackend, blockerIdentity]) if (identityAlive(identity)) signalProcess(identity, 'SIGKILL', { group: identity.pgid === identity.pid });
    const current = runtimeInfo() || info;
    if (current && identityAlive(current.identity)) {
      await runtimeRequest(current, 'POST', '/shutdown', {}).catch(() => {});
      await until(() => !identityAlive(current.identity), 5000).catch(() => signalProcess(current.identity, 'SIGKILL'));
    }
    for (const key of variables) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
