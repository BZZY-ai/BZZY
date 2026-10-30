import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { BzzyCore } from '../src/index.js';
import { appendEvent, getRecord, listRecords, putRecord } from '../src/engine/database.js';
import { createSession, loadSession, saveSession } from '../src/engine/store.js';
import { getProvider } from '../src/engine/providers.js';
import { newGoal } from '../src/engine/goals.js';
import { prepareTask } from '../src/engine/task.js';
import { identityAlive } from '../src/engine/process-identity.js';
import { runtimeInfo, runtimeRequest, clearOperatorStopIntent } from '../src/engine/runtime.js';
import { sessionMemoryStatus } from '../src/engine/session-memory.js';
import { beginSessionCompactionRun, queueSessionCompaction, pauseSessionCompaction, pauseAllSessionCompactions,
  controlSessionCompaction, sessionCompactionStatus, configureSessionCompaction, processSessionCompactions,
  recoverSessionCompactions, sessionCompactionUsage } from '../src/engine/session-compactor.js';

const coreRoot = fileURLToPath(new URL('../', import.meta.url));
const keys = ['BZZY_HOME', 'BZZY_CODEX_HOME', 'BZZY_CODEX_BIN', 'BZZY_TEST_SCENARIO', 'BZZY_TEST_LOG'];
let directory, workspace, previous, session;
const control = () => sessionCompactionStatus(session).control;
const jobs = () => listRecords('core.session.compactor.job', { sessionId: session.id });
async function waitFor(check) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await check()) return; await delay(25); }
  assert.fail('The isolated lifecycle fixture did not reach the expected state.');
}
test.beforeEach(() => {
  previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  directory = fs.realpathSync(fs.mkdtempSync(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'bmc-')));
  Object.assign(process.env, { BZZY_HOME: path.join(directory, 'private'), BZZY_CODEX_HOME: path.join(directory, 'codex'),
    BZZY_CODEX_BIN: path.join(coreRoot, 'test/fixtures/codex.mjs'), BZZY_TEST_SCENARIO: 'interrupt',
    BZZY_TEST_LOG: path.join(directory, 'codex', 'native.jsonl') });
  fs.mkdirSync(process.env.BZZY_HOME, { mode: 0o700 });
  fs.writeFileSync(path.join(process.env.BZZY_HOME, 'config.json'), JSON.stringify({ executionEnvironment: { allow: ['BZZY_TEST_SCENARIO', 'BZZY_TEST_LOG'] } }));
  workspace = path.join(directory, 'project'); fs.mkdirSync(workspace);
  session = createSession(getProvider('codex'), workspace, 'offline-fixture', 'memory-lifecycle');
  prepareTask(session, {}, 'Preserve only these fictional offline observations.');
  session.goal = newGoal(session.contract.objective, 10000); saveSession(session);
});
test.afterEach(async () => {
  const info = runtimeInfo();
  if (info && identityAlive(info.identity)) await runtimeRequest(info, 'POST', '/v1/operator-stop', {}).catch(() => {});
  if (info) await waitFor(() => !identityAlive(info.identity));
  clearOperatorStopIntent();
  for (const key of keys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
  fs.rmSync(directory, { recursive: true, force: true });
});
function seed() {
  for (let index = 0; index < 8; index++) {
    appendEvent(session.id, 'message.user', { text: `Inspect fictional offline baseline ${index}.` });
    const native = { runId: getRecord('run', session.id)?.id || 'fixture-source', threadRef: 'fixture-thread', turnId: `turn-${index}`, itemId: `answer-${index}` };
    appendEvent(session.id, 'text', { ...native, text: `Decision ${index}: ${'The offline control remains inconclusive and must not become a confirmed finding. '.repeat(7)}` });
    appendEvent(session.id, 'message.finalized', native);
  }
  let page; do { page = queueSessionCompaction(session, { force: true }); } while (page.indexed.indexingRemaining);
  assert.ok(jobs().length > 0);
}
function startRun(id = randomUUID()) {
  session = loadSession(session.id); session.executionState = 'running'; saveSession(session);
  putRecord('run', session.id, { id, sessionId: session.id, state: 'running' });
  beginSessionCompactionRun(session, id); return id;
}
async function derive() {
  for (let index = 0; index < 6; index++) await processSessionCompactions({ runModel: () => assert.fail('No model request is authorized by local recovery.') });
}

for (const reason of ['user_pause', 'user_cancel', 'host_operator_stop', 'host_stopped', 'source_paused', 'source_stopped']) {
  for (const first of [true, false]) test(`a fresh run recovers ${reason} with controller callback ${first ? 'first' : 'last'}, preserving old paid jobs`, async () => {
    startRun('stopped-run'); seed();
    for (const value of first ? ['source_stopped', reason] : [reason, 'source_stopped']) pauseSessionCompaction(session.id, value);
    session.executionState = 'paused'; saveSession(session);
    const paused = jobs(); configureSessionCompaction({ enabled: false }, { expectedRevision: 0 });
    recoverSessionCompactions(); await derive();
    assert.equal(sessionMemoryStatus(session).fallbackNodes, 0);
    session.executionState = 'idle'; saveSession(session);
    queueSessionCompaction(session, { force: true }); recoverSessionCompactions();
    if (reason !== 'source_stopped') assert.equal(control().state, 'paused', 'Idle queueing is not a new execution.');
    startRun('new-run'); queueSessionCompaction(session, { force: true }); await derive();
    assert.equal(control().state, 'enabled'); assert.equal(control().reasonPaused, null);
    assert.ok(sessionMemoryStatus(session).fallbackNodes > 0);
    for (const job of paused) assert.deepEqual(getRecord('core.session.compactor.job', job.id), job);
    assert.equal(sessionCompactionUsage().tokensUsed, 0);
  });
}

for (const hold of ['pause', 'cancel']) for (const reason of ['user_pause', 'user_cancel', 'host_operator_stop']) {
  test(`explicit compactor ${hold} survives ${reason}, shutdown and a fresh run`, async () => {
    startRun('initial-run'); seed();
    controlSessionCompaction(session, hold, { expectedRevision: control().revision });
    const paused = jobs(), memory = getRecord('core.session.memory', session.id);
    pauseSessionCompaction(session.id, reason); pauseSessionCompaction(session.id, 'source_stopped');
    pauseAllSessionCompactions('host_shutdown');
    configureSessionCompaction({ enabled: false }, { expectedRevision: 0 });
    startRun('new-run'); appendEvent(session.id, 'message.user', { text: 'New source capture must not advance the paused summary tree.' });
    queueSessionCompaction(session, { force: true }); recoverSessionCompactions(); await derive();
    assert.equal(control().ownerHold, hold); assert.equal(control().reasonPaused, `owner_${hold}`);
    assert.equal(control().state, hold === 'cancel' ? 'cancelled' : 'paused');
    assert.equal(sessionMemoryStatus(session).fallbackNodes, 0);
    assert.deepEqual(getRecord('core.session.memory', session.id), memory);
    for (const job of paused) assert.deepEqual(getRecord('core.session.compactor.job', job.id), job);
  });
}

test('late callbacks from an already stopped run cannot clear a new pause', () => {
  startRun('same-run'); seed(); pauseSessionCompaction(session.id, 'user_pause');
  const paused = control();
  beginSessionCompactionRun(session, 'same-run');
  beginSessionCompactionRun(session, 'unrecorded-new-run');
  assert.deepEqual(control(), paused);
});

test('only an explicit compactor resume clears its owner hold', () => {
  startRun('first-run'); seed();
  controlSessionCompaction(session, 'pause', { expectedRevision: control().revision });
  startRun('new-run'); assert.equal(control().ownerHold, 'pause');
  controlSessionCompaction(session, 'resume', { expectedRevision: control().revision });
  assert.equal(control().ownerHold, null); assert.equal(control().state, 'enabled');
});

test('new source activity keeps an uncertain paid request and its conservative charge intact', async () => {
  startRun('first-run'); seed(); const job = jobs()[0], reservationId = randomUUID();
  const uncertain = { ...job, state: 'paused', reasonPaused: 'uncertain_request', dispatched: true, attempts: 1, reservationId };
  putRecord('core.session.compactor.job', job.id, uncertain);
  putRecord('core.session.compactor.reservation', reservationId, { id: reservationId, jobId: job.id, sessionId: session.id,
    day: new Date().toISOString().slice(0, 10), state: 'settled', conservative: true, tokens: 20000 });
  pauseSessionCompaction(session.id, 'user_pause'); configureSessionCompaction({ enabled: false }, { expectedRevision: 0 });
  const reservation = getRecord('core.session.compactor.reservation', reservationId), usage = sessionCompactionUsage();
  startRun('second-run'); queueSessionCompaction(session, { force: true }); recoverSessionCompactions(); await derive();
  assert.ok(sessionMemoryStatus(session).fallbackNodes > 0);
  assert.deepEqual(getRecord('core.session.compactor.job', job.id), uncertain);
  assert.deepEqual(getRecord('core.session.compactor.reservation', reservationId), reservation);
  assert.deepEqual(sessionCompactionUsage(), usage);
});

for (const action of ['pause', 'cancel', 'core-stop']) for (const hold of [null, 'pause', 'cancel']) test(`runtime ${action} then actual execution respects compactor owner hold ${hold || 'none'}`, { timeout: 30000 }, async () => {
  const core = new BzzyCore(); await core.start(); seed();
  const owner = randomUUID(); await core.claim(session.id, owner);
  const info = runtimeInfo();
  if (hold) await runtimeRequest(info, 'POST', '/v1/knowledge/session-memory.control', { sessionId: session.id, action: hold, expectedRevision: control().revision });
  if (action === 'core-stop') {
    await runtimeRequest(info, 'POST', '/v1/operator-stop', {}); await waitFor(() => !identityAlive(info.identity));
    assert.equal(control().reasonPaused, hold ? `owner_${hold}` : 'host_operator_stop');
    clearOperatorStopIntent(); await core.start();
  } else {
    await core.control(session.id, { owner, action, requestId: randomUUID() });
    assert.equal(control().reasonPaused, hold ? `owner_${hold}` : `user_${action}`);
  }
  const paused = jobs(); configureSessionCompaction({ enabled: false }, { expectedRevision: 0 });
  const before = sessionMemoryStatus(session).fallbackNodes;
  await core.session(session.id); recoverSessionCompactions(); await derive();
  assert.equal(control().state, hold === 'cancel' ? 'cancelled' : 'paused'); assert.equal(sessionMemoryStatus(session).fallbackNodes, before);
  assert.equal(listRecords('execution', { sessionId: session.id }).length, 0, 'Start and status never resume foreground work.');
  await core.claim(session.id, owner);
  const accepted = await core.execute(session.id, { owner, prompt: 'Continue the authorized offline conversation.', requestId: randomUUID() });
  await waitFor(() => identityAlive(loadSession(session.id).backendProcess));
  assert.equal(control().state, hold === 'cancel' ? 'cancelled' : hold ? 'paused' : 'enabled');
  if (!hold) assert.equal(control().sourceRunId, getRecord('run', session.id).id);
  else assert.equal(control().ownerHold, hold);
  queueSessionCompaction(session, { force: true }); await derive();
  if (!hold) assert.ok(sessionMemoryStatus(session).fallbackNodes > before);
  else assert.equal(sessionMemoryStatus(session).fallbackNodes, before);
  for (const job of paused) assert.deepEqual(getRecord('core.session.compactor.job', job.id), job);
  assert.equal(listRecords('execution', { sessionId: session.id }).length, 1);
  await core.control(session.id, { owner, action: 'pause', requestId: randomUUID() });
  await waitFor(() => getRecord('execution', accepted.executionId).state === 'stopped');
});
