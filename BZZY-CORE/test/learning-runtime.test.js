import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createSession, saveSession, loadSession } from '../src/engine/store.js';
import { getProvider } from '../src/engine/providers.js';
import { initializeProject } from '../src/engine/project.js';
import { getRecord, putRecord, listRecords } from '../src/engine/database.js';
import { ToolHost } from '../src/engine/tools.js';
import { ensureRuntime, runtimeRequest, runtimeInfo, clearOperatorStopIntent } from '../src/engine/runtime.js';
import { identityAlive, processIdentity, signalProcess } from '../src/engine/process-identity.js';

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(check, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(30); }
  throw new Error('The isolated learning runtime did not reach its expected state.');
}

test('the real Core scheduler reviews only when idle, stops learning durably, and needs explicit owner resume', { timeout: 45000 }, async () => {
  const names = ['BZZY_HOME', 'BZZY_CODEX_HOME', 'BZZY_CODEX_BIN', 'BZZY_ENV_ALLOW', 'BZZY_TEST_LEARNING_LOG',
    'BZZY_TEST_LEARNING_MODE', 'BZZY_TEST_LEARNING_BAD_PROFILE', 'NODE_OPTIONS'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-learning-runtime-')));
  const modeFile = path.join(directory, 'mode'), logFile = path.join(directory, 'native.jsonl');
  let info, blocker, blockerIdentity, learningBackend;
  try {
    Object.assign(process.env, { BZZY_HOME: path.join(directory, 'private'), BZZY_CODEX_HOME: path.join(directory, 'auth'),
      BZZY_TEST_LEARNING_LOG: logFile, BZZY_TEST_LEARNING_MODE: modeFile,
      BZZY_ENV_ALLOW: 'BZZY_TEST_LEARNING_LOG,BZZY_TEST_LEARNING_MODE', NODE_OPTIONS: '' });
    delete process.env.BZZY_TEST_LEARNING_BAD_PROFILE;
    fs.mkdirSync(process.env.BZZY_CODEX_HOME, { mode: 0o700 });
    fs.writeFileSync(path.join(process.env.BZZY_CODEX_HOME, 'auth.json'), '{}', { mode: 0o600 });
    fs.writeFileSync(modeFile, 'normal');
    // Reuse the native no-model fixture. Withholding just its completion
    // notification makes an active review observable without touching targets,
    // real provider authentication, or the production adapter implementation.
    const wrapper = path.join(directory, 'codex-fixture.mjs');
    fs.writeFileSync(wrapper, `#!${process.execPath}\nimport fs from 'node:fs';
const originalWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = function(chunk, ...args) {
  let message; try { message = JSON.parse(String(chunk)); } catch {}
  if (message?.method === 'turn/completed' && fs.readFileSync(process.env.BZZY_TEST_LEARNING_MODE, 'utf8') === 'hold') return true;
  return originalWrite(chunk, ...args);
};
await import(${JSON.stringify(new URL('./fixtures/learning-codex.mjs', import.meta.url).href)});
`, { mode: 0o700 });
    process.env.BZZY_CODEX_BIN = wrapper;
    const project = path.join(directory, 'project'); fs.mkdirSync(project);
    const source = createSession(getProvider('codex'), project, 'offline-review-model'); initializeProject(source); saveSession(source);
    const host = new ToolHost(source, { event() {} });
    const nativeCalls = () => fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
    const turns = () => nativeCalls().filter(item => item.method === 'turn/start').length;
    const automatic = async label => {
      await host.call('remember', { kind: 'failed_approach', statement: `Offline fixture lesson ${label}: a banner match alone did not establish access.`, requestId: randomUUID() });
      return listRecords('core.learning.job', { sessionId: source.id }).find(job => job.state === 'queued');
    };
    const owner = (operation, input = {}) => runtimeRequest(info, 'POST', `/knowledge/${operation}`, { sessionId: source.id, ...input });
    info = await ensureRuntime();

    // A verified, test-owned idle process represents unrelated foreground work
    // in the real execution catalog. The scheduler must defer the review.
    blocker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore', env: { ...process.env, NODE_OPTIONS: '' } });
    await new Promise((resolve, reject) => { blocker.once('spawn', resolve); blocker.once('error', reject); });
    blockerIdentity = processIdentity(blocker.pid); assert.ok(blockerIdentity);
    const foreign = createSession(getProvider('codex'), directory, 'no-model'); foreign.executionState = 'running'; saveSession(foreign);
    const executionId = randomUUID(); putRecord('execution', executionId,
      { id: executionId, sessionId: foreign.id, state: 'running', runner: blockerIdentity, createdAt: new Date().toISOString() });
    const deferred = await automatic('deferred'); assert.ok(deferred);
    await owner('status'); await owner('search', { query: 'banner' }); await owner('learning.inspect', { id: deferred.id });
    await delay(350);
    assert.equal(getRecord('core.learning.job', deferred.id).state, 'queued'); assert.equal(turns(), 0);
    putRecord('execution', executionId, { ...getRecord('execution', executionId), state: 'completed' });
    foreign.executionState = 'idle'; saveSession(foreign);
    signalProcess(blockerIdentity, 'SIGKILL', { group: true }); await until(() => !identityAlive(blockerIdentity));
    await until(() => getRecord('core.learning.job', deferred.id)?.state === 'completed');
    assert.equal(turns(), 1);
    const firstStart = nativeCalls().find(item => item.method === 'thread/start');
    assert.equal(firstStart.params.permissions, 'bzzy_learning_review_v1'); assert.deepEqual(firstStart.params.dynamicTools, []);
    assert.equal(nativeCalls().find(item => item.id === 900 && !item.method).result.decision, 'decline');
    assert.equal(listRecords('execution').length, 1, 'learning did not enqueue or replay an assessment');

    fs.writeFileSync(modeFile, 'hold');
    const held = await automatic('running'); assert.ok(held);
    const backend = learningBackend = await until(() => {
      const job = getRecord('core.learning.job', held.id), review = job?.reviewSessionId && loadSession(job.reviewSessionId);
      return job?.state === 'running' && review?.backendProcess && turns() === 2 && review.backendProcess;
    });
    const pending = await automatic('pending'); assert.ok(pending); assert.notEqual(pending.id, held.id);
    await runtimeRequest(info, 'POST', '/operator-stop', { shutdown: false });
    await until(() => !identityAlive(backend));
    assert.equal(getRecord('core.learning.job', held.id).state, 'paused');
    assert.equal(getRecord('core.learning.job', pending.id).state, 'paused');
    await assert.rejects(owner('status'), failure => failure.code === 'CORE_STOPPED');

    // Explicit host restart restores availability; neither restart nor owner
    // reads constitutes permission to resume either historical review.
    const stoppedInfo = info;
    await runtimeRequest(info, 'POST', '/shutdown', {}); await until(() => !identityAlive(stoppedInfo.identity));
    clearOperatorStopIntent(); fs.writeFileSync(modeFile, 'normal'); info = await ensureRuntime();
    assert.notEqual(info.identity.pid, stoppedInfo.identity.pid);
    await owner('status'); await owner('learning.list'); await owner('learning.inspect', { id: pending.id });
    await delay(350);
    assert.equal(turns(), 2); assert.equal(getRecord('core.learning.job', held.id).state, 'paused');
    const paused = getRecord('core.learning.job', pending.id);
    await owner('learning.control', { id: pending.id, action: 'resume', expectedRevision: paused.revision });
    await until(() => getRecord('core.learning.job', pending.id)?.state === 'completed');
    assert.equal(turns(), 3); assert.equal(getRecord('core.learning.job', held.id).state, 'paused');
  } finally {
    if (learningBackend && identityAlive(learningBackend)) signalProcess(learningBackend, 'SIGKILL', { group: learningBackend.pgid === learningBackend.pid });
    if (blockerIdentity && identityAlive(blockerIdentity)) signalProcess(blockerIdentity, 'SIGKILL', { group: true });
    const current = runtimeInfo() || info;
    if (current && identityAlive(current.identity)) {
      await runtimeRequest(current, 'POST', '/shutdown', {}).catch(() => {});
      await until(() => !identityAlive(current.identity), 5000).catch(() => signalProcess(current.identity, 'SIGKILL'));
    }
    for (const name of names) if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
