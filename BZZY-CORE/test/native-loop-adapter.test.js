import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexEngine, codexLaunch } from '../src/engine/engines/codex.js';
import { nativeInputEstimate, assertNativeInputFits } from '../src/engine/native-context.js';
import { createSession, loadSession, saveSession } from '../src/engine/store.js';
import { appendEvent, events, putRecord, removeRecord } from '../src/engine/database.js';
import { processIdentity } from '../src/engine/process-identity.js';
import { getProvider } from '../src/engine/providers.js';
import { newGoal } from '../src/engine/goals.js';

const keys = ['BZZY_HOME', 'BZZY_CODEX_HOME', 'BZZY_CODEX_BIN', 'BZZY_TEST_LOG', 'BZZY_TEST_SCENARIO', 'BZZY_ENV_ALLOW', 'BZZY_PROVIDER_API_KEY'];
let directory, saved, session, engine, clock, observed;
test.beforeEach(() => {
  saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-loop-adapter-')));
  Object.assign(process.env, { BZZY_HOME: path.join(directory, 'private'), BZZY_CODEX_HOME: path.join(directory, 'auth'),
    BZZY_CODEX_BIN: fileURLToPath(new URL('./fixtures/codex.mjs', import.meta.url)),
    BZZY_TEST_LOG: path.join(directory, 'calls.jsonl'), BZZY_TEST_SCENARIO: 'context-no-capability',
    BZZY_ENV_ALLOW: 'BZZY_TEST_LOG,BZZY_TEST_SCENARIO' });
  const cwd = path.join(directory, 'project'); fs.mkdirSync(cwd);
  session = createSession(getProvider('codex'), cwd, 'offline-loop-adapter');
  session.goal = newGoal('Inspect only the synthetic fixture. Never claim an unverified outcome.');
  session.goal.tokenBudget = 100000; session.executionState = 'running'; saveSession(session);
  putRecord('run', session.id, { id: 'loop-run', sessionId: session.id, goalId: session.goal.id, goalMode: true, state: 'running' });
  clock = Date.now(); observed = [];
});
test.afterEach(async () => {
  if (engine) { await engine.close(); engine = null; }
  for (const key of keys) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  fs.rmSync(directory, { recursive: true, force: true });
});
const calls = () => fs.readFileSync(process.env.BZZY_TEST_LOG, 'utf8').trim().split('\n').map(JSON.parse);
async function until(check) {
  const deadline = Date.now() + 6000;
  while (!check()) { assert.ok(Date.now() < deadline, 'offline backend reaches expected state'); await delay(5); }
}
function makeEngine(options = {}, uiOverride) {
  const host = { context: { runId: 'loop-run', goalMode: true }, async call() { return { status: 'unchanged' }; } };
  engine = new CodexEngine(getProvider('codex'), session, { toolHost: host, ...options }, {
    event(type, data) { observed.push({ type, data }); appendEvent(session.id, type, data); uiOverride?.(type, data); }, newline() {},
  });
  engine.progressClock = () => clock;
  return engine;
}
async function churn() {
  for (let i = 0; i < 9; i++) {
    clock += 40000;
    engine.notification('item/completed', { threadId: 'native-thread', turnId: 't1', item: { id: `later-compaction-${i}`, type: 'contextCompaction' } });
    for (const tool of ['get_task_state', 'assignment_status', 'activity', 'read_skill']) {
      const response = await engine.request('item/tool/call', { tool, arguments: { id: 'same-worker', name: 'same-definition', summary: `Unique plan ${i}` } });
      assert.equal(response.success, true);
    }
  }
}

test('actual native goal pauses its active turn once after compaction churn, preserving identity, history and owner allowance', async () => {
  const original = structuredClone(session.goal);
  makeEngine(); const running = engine.run('Fixture', { goal: true }); running.catch(() => {});
  await until(() => engine.activeTurns.size === 1 && session.nativeContext?.refresh?.state === 'pending');
  await churn(); await running;
  assert.equal(session.goal.id, original.id); assert.equal(session.goal.objective, original.objective);
  assert.equal(session.goal.tokenBudget, original.tokenBudget); assert.equal(session.goal.status, 'paused');
  assert.equal(session.goal.reason, 'context_no_progress'); assert.equal(loadSession(session.id).goal.reason, 'context_no_progress');
  assert.equal(session.nativeContext.refresh.state, 'pending');
  assert.equal(calls().filter(row => row.method === 'thread/start').length, 1);
  assert.equal(calls().filter(row => row.method === 'thread/goal/set' && row.params.status === 'active').length, 1);
  assert.equal(calls().filter(row => row.method === 'thread/goal/set' && row.params.status === 'paused').length, 1);
  assert.equal(events(session.id).filter(row => row.type === 'diagnostic.context' && row.data.method === 'native-progress-guard').length, 1);
  engine.operation = { goal: true, reject() {} }; engine.goalArmed = true;
  engine.updateGoal({ status: 'complete', tokensUsed: 37 });
  assert.equal(session.goal.status, 'paused');
  assert.equal(observed.filter(row => row.type === 'goal').at(-1).data.status, 'paused');
  engine.operation = null;
});

for (const scenario of ['context-guard-noack-pause', 'context-guard-ack-no-turn-complete']) test(`${scenario} force-closes boundedly and marks final usage uncertain`, async () => {
  process.env.BZZY_TEST_SCENARIO = scenario;
  makeEngine(); const running = engine.run('Fixture', { goal: true }); running.catch(() => {});
  await until(() => engine.activeTurns.size === 1 && session.nativeContext?.refresh?.state === 'pending');
  await churn();
  await Promise.race([running, delay(5500).then(() => { throw new Error('Guard did not close unresponsive backend'); })]);
  await until(() => engine.activeTurns.size === 0);
  assert.equal(engine.contextStallForcedClose, true); assert.equal(engine.activeTurns.size, 0);
  assert.equal(session.goal.status, 'paused'); assert.equal(session.goal.reason, 'context_no_progress');
  assert.equal(calls().filter(row => row.method === 'thread/start').length, 1);
  assert.equal(calls().filter(row => row.method === 'thread/goal/set' && row.params.status === 'active').length, 1);
});

test('guard reporting errors cannot turn a successful host result into failure or bypass the bounded stop', async () => {
  let stops = 0;
  makeEngine({ onContextStall() { stops++; } }, type => { if (type === 'info') throw new Error('Synthetic presentation unavailable'); });
  const running = engine.run('Fixture', { goal: true }); running.catch(() => {});
  await until(() => engine.activeTurns.size === 1 && session.nativeContext?.refresh?.state === 'pending');
  await churn(); assert.equal(stops, 1); assert.equal(session.goal.reason, 'context_no_progress');
  await engine.interrupt('context_no_progress'); await running;
});

for (const boundary of ['core-call', 'external-tool', 'pending-question', 'live-worker']) test(`native safeguard waits for ${boundary} and pauses only after its safe boundary`, async () => {
  let stops = 0, releaseCall, held;
  const host = { context: { runId: 'loop-run', goalMode: true }, async call(name) {
    if (name === 'fixture_hold') await new Promise(resolve => { releaseCall = resolve; });
    return { status: 'unchanged' };
  } };
  makeEngine({ toolHost: host, onContextStall() { stops++; } });
  const running = engine.run('Fixture', { goal: true }); running.catch(() => {});
  await until(() => engine.activeTurns.size === 1 && session.nativeContext?.refresh?.state === 'pending');
  if (boundary === 'core-call') {
    held = engine.request('item/tool/call', { tool: 'fixture_hold', arguments: {} });
    await until(() => Boolean(releaseCall));
  } else if (boundary === 'external-tool') {
    engine.notification('item/started', { threadId: 'native-thread', turnId: 't1', item: { id: 'held-read', type: 'commandExecution', command: 'pwd' } });
  } else if (boundary === 'pending-question') {
    putRecord('question', 'fixture-question', { id: 'fixture-question', sessionId: session.id, state: 'pending', kind: 'approval' });
  } else {
    putRecord('assignment', 'fixture-worker', { id: 'fixture-worker', parentSessionId: session.id, goalId: session.goal.id,
      currentRound: 1, createdAt: session.goal.createdAt });
    putRecord('round', 'fixture-worker:1', { state: 'running', runner: processIdentity(), createdAt: session.goal.createdAt });
  }
  await churn(); assert.equal(stops, 0); assert.equal(session.goal.status, 'active');
  if (boundary === 'core-call') {
    // A successful actual host mutation is productive; an inspection result
    // remains eligible for the already sustained stall decision.
    releaseCall(); await held;
    clock += 360000; await churn();
  } else if (boundary === 'external-tool') {
    engine.notification('item/completed', { threadId: 'native-thread', turnId: 't1', item: { id: 'held-read', type: 'commandExecution', command: 'pwd', exitCode: 0 } });
  } else if (boundary === 'pending-question') removeRecord('question', 'fixture-question');
  else putRecord('round', 'fixture-worker:1', { state: 'running', runner: { ...processIdentity(), pid: 2147483647 }, createdAt: session.goal.createdAt });
  engine.observeLoopProgress({ kind: 'check' });
  assert.equal(stops, 1); assert.equal(session.goal.reason, 'context_no_progress');
  await engine.interrupt('context_no_progress'); await running;
});

test('host admission respects separate input cap and native planner reserves total-window headroom without double reserving output', () => {
  const budget = { tokens: 1048576, maxInputTokens: 655360, maxOutputTokens: 393216, appliedToNativeCatalog: true };
  const estimate = nativeInputEstimate({ contextBudget: budget, prompt: 'x'.repeat(655361 * 3) });
  assert.equal(estimate.usableInputTokens, 655360);
  assert.throws(() => assertNativeInputFits(estimate), { code: 'CONTEXT_BUDGET_EXCEEDED' });
  const provider = { id: 'offline', name: 'Offline fixture', auth: 'api-key', envKey: 'BZZY_PROVIDER_API_KEY', model: 'synthetic', baseUrl: 'https://invalid.test/v1', catalogFormat: 'experiential' };
  process.env.BZZY_PROVIDER_API_KEY = 'synthetic-offline';
  for (const [input, expected] of [[655360, 589824], [5000, 4500]]) {
    session.model = 'synthetic'; session.modelCapabilities = { contextWindow: 1048576, maxInputTokens: input, maxOutputTokens: 4096 };
    const launch = codexLaunch(provider, session);
    assert.equal(launch.contextBudget.tokens, 1048576); assert.equal(launch.contextBudget.nativeAutoCompactTokens, expected);
    assert.ok(launch.args.includes(`model_auto_compact_token_limit=${expected}`));
    const catalogArg = launch.args.find(value => value.startsWith('model_catalog_json='));
    const catalog = JSON.parse(fs.readFileSync(JSON.parse(catalogArg.slice('model_catalog_json='.length)), 'utf8')).models[0];
    assert.equal(catalog.context_window, 1048576); assert.equal(catalog.auto_compact_token_limit, expected);
  }
});
