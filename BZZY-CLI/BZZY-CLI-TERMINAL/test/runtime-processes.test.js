import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { root } from '../src/process.js';
import { ensureRuntime, runtimeRequest, runtimeInfo, executeJob } from '../src/runtime.js';
import { createSession, loadSession, saveSession } from '../src/store.js';
import { BUILTINS } from '../src/providers.js';
import { prepareTask } from '../src/task.js';
import { events, getRecord, putRecord, listRecords } from '../src/database.js';
import { processIdentity, identityAlive, signalProcess } from '../src/recovery.js';
import { reserveExecutionLaunch, recordExecutionProcess, requestExecutionStop, superviseExecutions } from '../src/runtime-processes.js';
import { newGoal } from '../src/goals.js';

const keys = ['BZZY_HOME', 'BZZY_CODEX_HOME', 'BZZY_CLAUDE_HOME', 'BZZY_CODEX_BIN', 'BZZY_CLAUDE_BIN', 'BZZY_TEST_BOOT_FILE', 'BZZY_TEST_BACKEND_FILE', 'BZZY_TEST_LOG', 'NODE_OPTIONS', 'DEEPSEEK_API_KEY', 'PATH'];
let dir, work, saved;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = check(); if (value) return value; await delay(30); }
  throw new Error('Condition timed out.');
}
test.beforeEach(() => {
  saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  dir = fs.mkdtempSync('/tmp/bz-rt-'); work = fs.realpathSync(dir);
  Object.assign(process.env, { BZZY_HOME: path.join(dir, 'private'), BZZY_CODEX_HOME: path.join(dir, 'codex'), BZZY_CLAUDE_HOME: path.join(dir, 'claude'),
    BZZY_CODEX_BIN: path.join(root, 'test/fixtures/stuck-backend.mjs'), BZZY_CLAUDE_BIN: path.join(root, 'test/fixtures/stuck-backend.mjs'),
    BZZY_TEST_BOOT_FILE: path.join(dir, 'boot-mode'), BZZY_TEST_BACKEND_FILE: path.join(dir, 'backend-mode'), BZZY_TEST_LOG: path.join(dir, 'backend.log'),
    NODE_OPTIONS: `--import=${pathToFileURL(path.join(root, 'test/fixtures/runtime-preload.mjs')).href}`, DEEPSEEK_API_KEY: 'fixture-key-one' });
  fs.writeFileSync(process.env.BZZY_TEST_BOOT_FILE, 'normal'); fs.writeFileSync(process.env.BZZY_TEST_BACKEND_FILE, 'normal');
});
test.afterEach(async () => {
  const info = runtimeInfo();
  if (info && identityAlive(info.identity)) await runtimeRequest(info, 'POST', '/shutdown', {}).catch(() => {});
  if (info) await until(() => !identityAlive(info.identity), 5000);
  for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  fs.rmSync(dir, { recursive: true, force: true });
});
async function start(provider = 'claude', session) {
  session ||= createSession(BUILTINS[provider], work); prepareTask(session, {}, 'Say hello');
  const info = await ensureRuntime(), owner = randomUUID();
  await runtimeRequest(info, 'POST', `/sessions/${session.id}/claim`, { owner, takeover: true });
  const result = await runtimeRequest(info, 'POST', `/sessions/${session.id}/execute`, { owner, prompt: 'Say hello', options: {}, goal: false }, randomUUID());
  return { ...result, info, owner, session };
}
const finished = id => until(() => { const job = getRecord('execution', id); return job && !['queued', 'launching', 'running'].includes(job.state) && job; });

test('a runner startup crash becomes a visible failure with a private log instead of infinite loading', async () => {
  fs.writeFileSync(process.env.BZZY_TEST_BOOT_FILE, 'exit');
  const launched = await start(), job = await finished(launched.executionId);
  assert.equal(job.exitCode, 1); assert.equal(loadSession(launched.session.id).executionState, 'failed');
  assert.match(job.error, /exit 23/); assert.match(job.error, /Fixture runner startup failed/);
  assert.doesNotMatch(job.error, /hidden-fixture-token/); assert.equal(fs.statSync(job.logPath).mode & 0o777, 0o600);
  assert.ok(events(launched.session.id).some(event => event.type === 'execution.finished'));
  fs.writeFileSync(process.env.BZZY_TEST_BOOT_FILE, 'normal');
  assert.equal((await finished((await start('claude', loadSession(launched.session.id))).executionId)).exitCode, 0);
});

test('pause kills a runner blocked before the control polling loop starts and preserves the session', async () => {
  fs.writeFileSync(process.env.BZZY_TEST_BOOT_FILE, 'block');
  const launched = await start();
  const job = await until(() => { const job = getRecord('execution', launched.executionId); return job?.runner && identityAlive(job.runner) && job; });
  await delay(200);
  const began = Date.now();
  await runtimeRequest(launched.info, 'POST', `/sessions/${launched.session.id}/control`, { owner: launched.owner, action: 'pause' }, randomUUID());
  const stopped = await finished(job.id);
  assert.equal(stopped.exitCode, 130); assert.ok(Date.now() - began < 5000); assert.equal(identityAlive(job.runner), false);
  assert.equal(loadSession(launched.session.id).executionState, 'paused');
  fs.writeFileSync(process.env.BZZY_TEST_BOOT_FILE, 'normal');
  assert.equal((await finished((await start('claude', loadSession(launched.session.id))).executionId)).exitCode, 0);
});

for (const provider of ['codex', 'claude', 'deepseek']) test(`${provider}: pause stops an unresponsive backend and the next message works`, async () => {
  fs.writeFileSync(process.env.BZZY_TEST_BACKEND_FILE, 'block');
  const launched = await start(provider);
  const backend = await until(() => { const current = loadSession(launched.session.id); return current.backendProcess && fs.existsSync(process.env.BZZY_TEST_LOG) && current.backendProcess; });
  const began = Date.now();
  await runtimeRequest(launched.info, 'POST', `/sessions/${launched.session.id}/control`, { owner: launched.owner, action: 'pause' }, randomUUID());
  const stopped = await finished(launched.executionId);
  await until(() => !identityAlive(backend));
  assert.equal(stopped.exitCode, 130); assert.ok(Date.now() - began < 5000); assert.equal(loadSession(launched.session.id).executionState, 'paused');
  fs.writeFileSync(process.env.BZZY_TEST_BACKEND_FILE, 'normal');
  assert.equal((await finished((await start(provider, loadSession(launched.session.id))).executionId)).exitCode, 0);
});

test('stopping queued chat never launches it or changes an older completed goal', () => {
  const session = createSession(BUILTINS.claude, work); session.goal = newGoal('Previous task'); session.goal.status = 'complete'; saveSession(session);
  const job = { id: randomUUID(), sessionId: session.id, goal: false, state: 'queued', createdAt: new Date().toISOString() };
  putRecord('execution', job.id, job);
  requestExecutionStop(session.id, randomUUID(), 'pause'); superviseExecutions();
  assert.equal(getRecord('execution', job.id).exitCode, 130); assert.equal(loadSession(session.id).goal.status, 'complete');
  assert.equal(fs.existsSync(process.env.BZZY_TEST_LOG), false);
});

test('a stale scheduler candidate cannot resurrect a cancelled queued execution', () => {
  const session = createSession(BUILTINS.claude, work); session.goal = newGoal('Cancelled group task'); saveSession(session);
  const job = { id: randomUUID(), sessionId: session.id, goal: true, state: 'queued', createdAt: new Date().toISOString() };
  putRecord('execution', job.id, job);
  const candidate = listRecords('execution', { state: 'queued' })[0];
  requestExecutionStop(session.id, randomUUID(), 'cancel'); superviseExecutions();
  const cancelled = getRecord('execution', job.id);
  assert.equal(cancelled.state, 'stopped'); assert.equal(cancelled.exitCode, 130);
  assert.equal(reserveExecutionLaunch(candidate.id, path.join(dir, 'must-not-launch.log')), null);
  assert.deepEqual(getRecord('execution', job.id), cancelled);
  assert.equal(loadSession(session.id).goal.status, 'cancelled');
  assert.equal(events(session.id).filter(event => event.type === 'execution.finished').length, 1);
  assert.equal(fs.existsSync(process.env.BZZY_TEST_LOG), false);
});

test('cancellation after launch reservation prevents runner acquisition and backend execution', async () => {
  const session = createSession(BUILTINS.claude, work); session.goal = newGoal('Cancelled before runner starts'); saveSession(session);
  const job = { id: randomUUID(), sessionId: session.id, goal: true, state: 'queued', createdAt: new Date().toISOString() };
  putRecord('execution', job.id, job);
  assert.equal(reserveExecutionLaunch(job.id, path.join(dir, 'must-not-start.log')).state, 'launching');
  assert.equal(reserveExecutionLaunch(job.id, path.join(dir, 'duplicate.log')), null, 'only one launch reservation may acquire a queued job');
  requestExecutionStop(session.id, randomUUID(), 'cancel');
  const stopping = getRecord('execution', job.id);
  assert.equal(await executeJob(job.id), 0);
  assert.deepEqual(getRecord('execution', job.id), stopping, 'a runner must not acquire or clear a pending cancellation');
  assert.equal(events(session.id).some(event => event.type === 'execution.started'), false);
  assert.equal(fs.existsSync(process.env.BZZY_TEST_LOG), false);
  superviseExecutions();
  assert.equal(getRecord('execution', job.id).exitCode, 130);
  assert.equal(loadSession(session.id).goal.status, 'cancelled');
});

test('late runner identification preserves cancellation instead of restoring a stale launch state', () => {
  const session = createSession(BUILTINS.claude, work); session.goal = newGoal('Cancelled during runner identification'); saveSession(session);
  const job = { id: randomUUID(), sessionId: session.id, goal: true, state: 'queued', createdAt: new Date().toISOString() };
  putRecord('execution', job.id, job);
  assert.equal(reserveExecutionLaunch(job.id, path.join(dir, 'must-not-start.log')).state, 'launching');
  const runner = processIdentity();
  requestExecutionStop(session.id, randomUUID(), 'cancel'); superviseExecutions();
  const cancelled = getRecord('execution', job.id);
  assert.equal(cancelled.state, 'stopped'); assert.equal(cancelled.exitCode, 130);
  assert.deepEqual(recordExecutionProcess(job.id, { runner }), { ...cancelled, runner });
  const exited = { runnerExitedAt: new Date().toISOString(), runnerExitCode: 0, runnerExitSignal: null };
  assert.deepEqual(recordExecutionProcess(job.id, exited), { ...cancelled, runner, ...exited });
  assert.equal(recordExecutionProcess(job.id, { state: 'running', stopAction: null }).state, 'stopped', 'process metadata cannot change execution state');
  assert.equal(getRecord('execution', job.id).stopAction, 'cancel');
  assert.equal(loadSession(session.id).goal.status, 'cancelled');
  assert.equal(events(session.id).filter(event => event.type === 'execution.finished').length, 1);
});

test('a cooperative pause is consumed and cannot interrupt the following reply', async () => {
  fs.writeFileSync(process.env.BZZY_TEST_BACKEND_FILE, 'wait');
  const launched = await start('codex');
  await until(() => fs.existsSync(process.env.BZZY_TEST_LOG));
  const requestId = randomUUID();
  const control = await runtimeRequest(launched.info, 'POST', `/sessions/${launched.session.id}/control`, { owner: launched.owner, action: 'pause' }, requestId);
  assert.equal((await finished(launched.executionId)).exitCode, 130);
  assert.equal(getRecord('control', control.controlId).state, 'observed');
  fs.writeFileSync(process.env.BZZY_TEST_BACKEND_FILE, 'slow');
  const next = await start('codex', loadSession(launched.session.id));
  await runtimeRequest(next.info, 'POST', `/sessions/${next.session.id}/control`, { owner: next.owner, action: 'pause' }, requestId);
  assert.equal((await finished(next.executionId)).exitCode, 0, 'retrying an old pause cannot stop a new execution');
});

test('the supervisor consumes legacy pause requests even when no runner is polling them', () => {
  const session = createSession(BUILTINS.claude, work), createdAt = new Date().toISOString();
  const job = { id: randomUUID(), sessionId: session.id, goal: false, state: 'queued', createdAt };
  const control = { id: randomUUID(), sessionId: session.id, action: 'pause', state: 'queued', createdAt };
  putRecord('execution', job.id, job); putRecord('control', control.id, control);
  superviseExecutions();
  assert.equal(getRecord('execution', job.id).exitCode, 130); assert.equal(getRecord('control', control.id).state, 'observed');
});

test('legacy macOS records cannot occupy runtime slots by matching an unrelated reused PID', async () => {
  const session = createSession(BUILTINS.claude, work);
  const legacy = { pid: process.pid, start: 'platform-unverified' };
  session.backendProcess = legacy; session.executionState = 'running'; saveSession(session);
  const job = { id: randomUUID(), sessionId: session.id, goal: false, state: 'running', runner: legacy, createdAt: new Date().toISOString() };
  putRecord('execution', job.id, job);
  putRecord('run', session.id, { runner: legacy, state: 'running' });
  superviseExecutions();
  assert.equal(getRecord('execution', job.id).state, 'stopped'); assert.match(getRecord('execution', job.id).error, /stale execution/);
  assert.ok(processIdentity(process.pid), 'the unrelated PID was not signalled');
  assert.equal((await finished((await start('claude')).executionId)).exitCode, 0);
});

test('the runtime stays shared while each execution receives the caller API key and PATH', async () => {
  const first = await ensureRuntime(), same = await ensureRuntime();
  assert.equal(first.identity.pid, same.identity.pid);
  process.env.DEEPSEEK_API_KEY = 'fixture-key-two'; process.env.PATH = '/tmp/bzzy-caller-path:' + process.env.PATH;
  const second = await ensureRuntime(); assert.equal(second.identity.pid, first.identity.pid);
  assert.doesNotMatch(JSON.stringify(second), /fixture-key/);
  const launched = await start('deepseek'); assert.equal((await finished(launched.executionId)).exitCode, 0);
  const recorded = fs.readFileSync(process.env.BZZY_TEST_LOG, 'utf8').trim().split('\n').map(JSON.parse).find(record => record.keyHash);
  assert.equal(recorded.keyHash, createHash('sha256').update('fixture-key-two').digest('hex'));
  assert.ok(recorded.path.includes('/tmp/bzzy-caller-path:'));
  assert.equal(fs.existsSync(path.join(process.env.BZZY_HOME, 'runtime', `${launched.executionId}-environment.json`)), false);
  assert.doesNotMatch(JSON.stringify(getRecord('execution', launched.executionId)), /fixture-key-two/);
});

test('a completed Claude reply does not hang when native shutdown ignores EOF and signals', async () => {
  fs.writeFileSync(process.env.BZZY_TEST_BACKEND_FILE, 'linger');
  const launched = await start('claude'), job = await finished(launched.executionId);
  assert.equal(job.exitCode, 0, job.error); assert.equal(loadSession(launched.session.id).resolvedModel, 'resolved-claude-model');
});

test('macOS process identity uses ps start time and refuses to signal a reused PID', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore', env: { ...process.env, NODE_OPTIONS: '' } });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  try {
    const identity = processIdentity(child.pid, 'darwin');
    assert.equal(identity.platform, 'darwin'); assert.equal(identity.pgid, child.pid); assert.equal(identityAlive(identity), true);
    assert.equal(signalProcess({ ...identity, start: 'different birth time' }, 'SIGKILL', { group: true }), false);
    assert.equal(identityAlive(identity), true); assert.equal(signalProcess(identity, 'SIGKILL', { group: true }), true);
  } finally { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
});
