import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { BzzyCore, BzzyClient, CoreMetricsClient } from '../src/index.js';
import { runtimeInfo, runtimeRequest, ensureRuntime, clearOperatorStopIntent, persistOperatorStopIntent, operatorStopRequested, pauseRuntimeExecutions } from '../src/engine/runtime.js';
import { getRecord, putRecord, listRecords, appendEvent, events } from '../src/engine/database.js';
import { loadSession, saveSession } from '../src/engine/store.js';
import { prepareTask } from '../src/engine/task.js';
import { newGoal } from '../src/engine/goals.js';
import { startAssignment } from '../src/engine/delegation.js';
import { sandboxSupport } from '../src/engine/policy.js';
import { identityAlive } from '../src/engine/process-identity.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const keys = ['BZZY_HOME', 'BZZY_CODEX_HOME', 'BZZY_CODEX_BIN', 'BZZY_TEST_SCENARIO', 'BZZY_TEST_LOG'];
let directory, workspace, core, saved;
async function waitFor(check, diagnose) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) { if (await check()) return; await delay(25); }
  const detail = diagnose ? JSON.stringify(await diagnose()).slice(0, 3500) : '';
  assert.fail('The private operator-stop fixture did not reach its expected state.' + (detail ? `\nReadiness diagnostics: ${detail}` : ''));
}
test.beforeEach(() => {
  directory = fs.mkdtempSync(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'bos-'));
  saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { BZZY_HOME: path.join(directory, 'private'), BZZY_CODEX_HOME: path.join(directory, 'codex'),
    // Strict workers may write their configured Codex home, not the surrounding
    // fixture directory. Keep startup logging inside that existing sandbox root.
    BZZY_CODEX_BIN: path.join(root, 'test/fixtures/codex.mjs'), BZZY_TEST_SCENARIO: 'interrupt', BZZY_TEST_LOG: path.join(directory, 'codex', 'native.jsonl') });
  fs.mkdirSync(process.env.BZZY_HOME, { mode: 0o700 });
  fs.writeFileSync(path.join(process.env.BZZY_HOME, 'config.json'), JSON.stringify({ executionEnvironment: { allow: ['BZZY_TEST_SCENARIO', 'BZZY_TEST_LOG'] } }));
  workspace = path.join(directory, 'project'); fs.mkdirSync(workspace); core = new BzzyCore();
});
test.afterEach(async () => {
  const info = runtimeInfo();
  if (info && identityAlive(info.identity)) await runtimeRequest(info, 'POST', '/v1/operator-stop', {}).catch(() => {});
  if (info) await waitFor(() => !identityAlive(info.identity));
  clearOperatorStopIntent();
  for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  fs.rmSync(directory, { recursive: true, force: true });
});
function conversation(parentSessionId) {
  const session = core.createConversation({ provider: 'codex', cwd: workspace }, { requestId: randomUUID() });
  if (parentSessionId) session.parentSessionId = parentSessionId;
  prepareTask(session, {}, 'Preserve the interrupted objective for explicit resume.');
  session.goal = newGoal(session.contract.objective, 1000);
  saveSession(session); return session;
}

test('operator stop pauses live parent/child inference, preserves goals/history, and idle pollers cannot restart Core', { timeout: 30000 }, async () => {
  await core.start();
  const parent = conversation(), child = conversation(parent.id), sessions = [parent, child], owner = randomUUID(), owners = sessions.map(() => owner);
  const accepted = [];
  for (const [index, session] of sessions.entries()) {
    await core.claim(session.id, owners[index]);
    accepted.push(await core.execute(session.id, { owner: owners[index], prompt: 'Wait for an explicit stop.', goal: true, requestId: randomUUID() }));
  }
  await waitFor(() => sessions.every(session => identityAlive(loadSession(session.id).backendProcess)));
  const identities = accepted.flatMap((item, index) => [getRecord('execution', item.executionId).runner, loadSession(sessions[index].id).backendProcess]);
  const preserved = appendEvent(parent.id, 'text', { text: '<message><p>Preserve this original body.</p></message>' });
  const metrics = new CoreMetricsClient(); await metrics.read();
  const info = runtimeInfo(), grant = await core.grantSession({ sessionId: parent.id });
  const observer = new BzzyClient({ url: info.url, token: grant.token });
  assert.equal((await fetch(`${info.url}/v1/operator-stop`, { method: 'POST' })).status, 401);
  await assert.rejects(observer.request('POST', '/v1/operator-stop', {}), { status: 403 });
  assert.equal(operatorStopRequested(), false);
  const stopped = await runtimeRequest(info, 'POST', '/v1/operator-stop', { shutdown: false });
  assert.equal(stopped.quiesced, true); assert.equal(stopped.runningAgentsContinue, false); assert.ok(stopped.pausedExecutions >= 2);
  assert.equal(operatorStopRequested(), true); assert.ok(identities.every(identity => !identityAlive(identity)));
  await assert.rejects(observer.metrics(), { status: 409, code: 'CORE_STOPPED' });
  await assert.rejects(observer.session(parent.id), { status: 409, code: 'CORE_STOPPED' });
  for (const session of sessions) {
    const current = loadSession(session.id);
    assert.equal(current.goal.id, session.goal.id); assert.equal(current.goal.status, 'paused');
    assert.equal(current.executionState, 'paused');
  }
  assert.equal(listRecords('execution', { states: ['queued', 'launching', 'running'] }).length, 0);
  await assert.rejects(observer.execute(parent.id, { owner: owners[0], prompt: 'Denied while stopped.', requestId: randomUUID() }), { status: 409, code: 'CORE_STOPPED' });
  await runtimeRequest(info, 'POST', '/shutdown', {}); await waitFor(() => !identityAlive(info.identity));
  await assert.rejects(metrics.read());
  await assert.rejects(metrics.read(), { code: 'CORE_STOPPED' });
  await assert.rejects(ensureRuntime(), { code: 'CORE_STOPPED' });
  assert.equal(runtimeInfo(), null);
  clearOperatorStopIntent(); await core.start(); await delay(250);
  assert.equal(listRecords('execution', { states: ['queued', 'launching', 'running'] }).length, 0);
  assert.equal(listRecords('execution').length, 2);
  assert.equal(events(parent.id, 0, 500).find(event => event.id === preserved.id).data.text, preserved.data.text);
  assert.equal(loadSession(parent.id).goal.status, 'paused');
});

test('a persisted operator stop blocks queued work even on direct supervised boot and restart never resumes it', { timeout: 20000 }, async () => {
  const parent = conversation(), child = conversation(parent.id), queued = [parent, child].map(session => {
    const id = randomUUID(); putRecord('execution', id, { id, sessionId: session.id, prompt: 'Saved queued work.', options: {}, goal: true, state: 'queued', createdAt: new Date().toISOString() }); return id;
  });
  persistOperatorStopIntent();
  const daemon = spawn(process.execPath, [path.join(root, 'bin/bzzy-engine.js'), 'internal-service'], { env: process.env, stdio: 'ignore' });
  daemon.unref();
  await waitFor(() => runtimeInfo() && identityAlive(runtimeInfo().identity));
  const info = runtimeInfo(); await delay(250);
  assert.ok(queued.every(id => getRecord('execution', id).state === 'queued'));
  assert.equal(fs.existsSync(process.env.BZZY_TEST_LOG), false);
  const stopped = await runtimeRequest(info, 'POST', '/v1/operator-stop', {});
  assert.equal(stopped.stopped, true); assert.equal(stopped.pausedExecutions, 2);
  await waitFor(() => !identityAlive(info.identity));
  assert.ok(queued.every(id => getRecord('execution', id).state === 'stopped'));
  assert.ok([parent, child].every(session => loadSession(session.id).goal.status === 'paused'));
  clearOperatorStopIntent(); await core.start(); await delay(250);
  assert.equal(listRecords('execution', { states: ['queued', 'launching', 'running'] }).length, 0);
  assert.equal(fs.existsSync(process.env.BZZY_TEST_LOG), false);
});

test('stop verification never signals an unrelated legacy PID or claims success when its identity is unverified', { timeout: 10000 }, async () => {
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    const session = conversation(), id = randomUUID();
    putRecord('execution', id, { id, sessionId: session.id, state: 'running', goal: true, createdAt: new Date().toISOString(), runner: { pid: unrelated.pid, start: 'platform-unverified' } });
    persistOperatorStopIntent();
    await assert.rejects(pauseRuntimeExecutions({ timeoutMs: 100 }), { code: 'STOP_INCOMPLETE' });
    await assert.rejects(pauseRuntimeExecutions({ timeoutMs: 100 }), { code: 'STOP_INCOMPLETE' });
    assert.equal(operatorStopRequested(), true);
    assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
    assert.equal(runtimeInfo(), null);
    const exited = once(unrelated, 'exit'); unrelated.kill('SIGTERM'); await exited;
    await pauseRuntimeExecutions({ timeoutMs: 100 });
    assert.equal(listRecords('runtime-stop-target').length, 0);
  } finally { unrelated.kill('SIGTERM'); }
});

test('operator stop also halts a detached real assignment runner and retains its interrupted work for explicit follow-up', { timeout: 25000, skip: !sandboxSupport() }, async () => {
  await core.start();
  const parent = conversation();
  prepareTask(parent, { mode: 'delegate', executor: 'codex' }, parent.goal.objective); saveSession(parent);
  const assignment = startAssignment(parent, { objective: 'Wait for operator maintenance.', context: 'Offline test, retain partial history.', acceptanceCriteria: ['Return only after explicit review.'] });
  const state = () => {
    const current = getRecord('assignment', assignment.id), worker = current?.workerSessionId && loadSession(current.workerSessionId);
    const round = getRecord('round', `${assignment.id}:1`), run = worker && getRecord('run', worker.id);
    const nativeTurnStarted = Boolean(worker && events(worker.id, 0, 500).some(event => event.type === 'backend' && event.data.method === 'turn/started'));
    return { operatorStopped: operatorStopRequested(), runtimeAlive: identityAlive(runtimeInfo()?.identity),
      assignment: { currentRound: current?.currentRound, closure: current?.closure, workerCreated: Boolean(worker) },
      round: { state: round?.state, runnerAlive: identityAlive(round?.runner), launcherAlive: identityAlive(round?.launcher) },
      worker: worker ? { state: worker.executionState, stopReason: worker.stopReason, failureCategory: worker.failure?.category,
        backendAlive: identityAlive(worker.backendProcess), runState: run?.state, nativeTurnStarted } : null,
      fixtureBackendStarted: fs.existsSync(process.env.BZZY_TEST_LOG) };
  };
  // backendProcess is recorded immediately after spawn, before native startup
  // can succeed or fail. Stop an actual running native turn, not that transient
  // launch window. The interrupt fixture holds this turn until Core stops it.
  await waitFor(() => {
    const current = state();
    return current.round.state === 'running' && current.round.runnerAlive && current.worker?.backendAlive && current.worker.nativeTurnStarted;
  }, state);
  const current = getRecord('assignment', assignment.id), round = getRecord('round', `${assignment.id}:1`), worker = loadSession(current.workerSessionId);
  const identities = [round.runner, round.launcher, worker.backendProcess];
  const partial = appendEvent(worker.id, 'text', { text: 'Retain this partial worker finding.' });
  const beforeStop = state();
  const stopped = await runtimeRequest(runtimeInfo(), 'POST', '/v1/operator-stop', { shutdown: false });
  assert.ok(stopped.pausedExecutions >= 1, `Detached assignment stop did not observe active work: ${JSON.stringify({ before: beforeStop, after: state(), pausedExecutions: stopped.pausedExecutions }).slice(0, 3500)}`);
  assert.ok(identities.every(identity => !identityAlive(identity)));
  assert.equal(getRecord('round', `${assignment.id}:1`).state, 'interrupted');
  assert.equal(getRecord('assignment', assignment.id).closure, 'open');
  assert.equal(loadSession(parent.id).goal.status, 'paused');
  assert.equal(events(worker.id, 0, 500).find(event => event.id === partial.id).data.text, partial.data.text);
});
