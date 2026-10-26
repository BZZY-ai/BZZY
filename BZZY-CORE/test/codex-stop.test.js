import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexEngine } from '../src/engine/engines/codex.js';
import { createSession, saveSession } from '../src/engine/store.js';
import { getProvider } from '../src/engine/providers.js';
import { newGoal } from '../src/engine/goals.js';
import { identityAlive } from '../src/engine/process-identity.js';

const keys = ['BZZY_HOME', 'BZZY_CODEX_HOME', 'BZZY_CODEX_BIN', 'BZZY_TEST_LOG', 'BZZY_TEST_SCENARIO', 'BZZY_ENV_ALLOW'];
let directory, saved, engine, session;
test.beforeEach(() => {
  saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-stop-')));
  Object.assign(process.env, { BZZY_HOME: path.join(directory, 'private'), BZZY_CODEX_HOME: path.join(directory, 'auth'),
    BZZY_CODEX_BIN: fileURLToPath(new URL('./fixtures/codex.mjs', import.meta.url)),
    BZZY_TEST_LOG: path.join(directory, 'backend.jsonl'), BZZY_TEST_SCENARIO: 'interrupt-response-race',
    BZZY_ENV_ALLOW: 'BZZY_TEST_LOG,BZZY_TEST_SCENARIO' });
  const cwd = path.join(directory, 'project'); fs.mkdirSync(cwd);
  const provider = getProvider('codex'); session = createSession(provider, cwd, 'offline-fixture');
  session.goal = newGoal('Stop this synthetic goal without reporting a backend failure.'); saveSession(session);
  engine = new CodexEngine(provider, session, {}, { event() {}, newline() {} });
});
test.afterEach(async () => {
  await engine.close();
  for (const key of keys) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  fs.rmSync(directory, { recursive: true, force: true });
});
async function until(check) {
  const deadline = Date.now() + 5000;
  while (!check()) { if (Date.now() > deadline) throw new Error('The backend fixture did not reach its expected phase.'); await delay(5); }
}
const calls = () => fs.existsSync(process.env.BZZY_TEST_LOG)
  ? fs.readFileSync(process.env.BZZY_TEST_LOG, 'utf8').trim().split('\n').map(JSON.parse) : [];

for (const goal of [true, false]) test(`${goal ? 'goal' : 'chat'} cancellation tolerates a final notification arriving before the interrupt response`, async () => {
  const running = engine.run('Synthetic request', { goal }); running.catch(() => {});
  await until(() => engine.activeTurns.size > 0);
  const backend = session.backendProcess;
  const interrupted = engine.interrupt('cancelled'); interrupted.catch(() => {});
  const results = await Promise.allSettled([interrupted, running.then(() => engine.close())]);
  assert.deepEqual(results.map(item => item.status), ['fulfilled', 'fulfilled'], results.find(item => item.reason)?.reason?.stack);
  assert.equal(engine.interrupted, true); assert.equal(identityAlive(backend), false);
  assert.notEqual(session.goal.status, 'complete');
});

for (const [scenario, method] of [['hold-initialize', 'initialize'], ['hold-goal-start', 'thread/goal/set']]) test(`a requested stop during ${method} tolerates intentional transport closure`, async () => {
  process.env.BZZY_TEST_SCENARIO = scenario;
  const running = engine.run('Synthetic request', { goal: true }); running.catch(() => {});
  await until(() => calls().some(call => call.method === method));
  await engine.interrupt('user_pause'); await engine.close();
  await assert.doesNotReject(running); assert.equal(engine.interrupted, true);
  assert.notEqual(session.goal.status, 'complete');
});

test('an unexpected backend exit during cancellation remains a real failure', async () => {
  process.env.BZZY_TEST_SCENARIO = 'exit-on-stop';
  const running = engine.run('Synthetic request', { goal: true }); running.catch(() => {});
  await until(() => engine.activeTurns.size > 0);
  await assert.rejects(engine.interrupt('user_pause'), /Backend exited \(23\)/);
  await assert.rejects(running, /Backend exited \(23\)/);
});

test('closing an active transport without a requested stop cannot silently succeed', async () => {
  const running = engine.run('Synthetic request', { goal: true }); running.catch(() => {});
  await until(() => engine.activeTurns.size > 0);
  await engine.close(); await assert.rejects(running, /Backend connection closed/);
  assert.equal(engine.interrupted, false);
});

test('a backend error with the shutdown message is still reported, rather than filtered by text', async () => {
  process.env.BZZY_TEST_SCENARIO = 'rpc-error-on-stop';
  const running = engine.run('Synthetic request', { goal: true }); running.catch(() => {});
  await until(() => engine.activeTurns.size > 0);
  await assert.rejects(engine.interrupt('user_pause'), { message: 'Backend connection closed.', rpcCode: -32603 });
  await engine.close(); await running;
});
