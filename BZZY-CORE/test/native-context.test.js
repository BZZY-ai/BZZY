import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { nativeContextBudget, prepareNativeReadiness, acknowledgeNativeReadiness, recordNativeCompaction,
  consumeNativeRefresh, markNativeRefreshPrepared, nativeInputEstimate, assertNativeInputFits, observeContextPressure, nativeGoalTokenBudget } from '../src/engine/native-context.js';
import { CodexEngine } from '../src/engine/engines/codex.js';
import { ClaudeEngine } from '../src/engine/engines/claude.js';
import { createSession, loadSession, saveSession } from '../src/engine/store.js';
import { appendEvent, events, getRecord, putRecord, removeRecord } from '../src/engine/database.js';
import { getProvider } from '../src/engine/providers.js';
import { newGoal } from '../src/engine/goals.js';
import { recordDiagnosticTool } from '../src/engine/session-diagnostics.js';

const keys = ['BZZY_HOME', 'BZZY_CODEX_HOME', 'BZZY_CODEX_BIN', 'BZZY_CLAUDE_HOME', 'BZZY_CLAUDE_BIN', 'BZZY_TEST_LOG', 'BZZY_TEST_SCENARIO', 'BZZY_ENV_ALLOW', 'EXPLABS_API_KEY'];
let directory, saved, session, engine, observed;
test.beforeEach(() => {
  saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-native-context-')));
  Object.assign(process.env, { BZZY_HOME: path.join(directory, 'private'), BZZY_CODEX_HOME: path.join(directory, 'auth'),
    BZZY_CODEX_BIN: fileURLToPath(new URL('./fixtures/codex.mjs', import.meta.url)),
    BZZY_TEST_LOG: path.join(directory, 'backend.jsonl'), BZZY_TEST_SCENARIO: 'context-no-capability',
    BZZY_ENV_ALLOW: 'BZZY_TEST_LOG,BZZY_TEST_SCENARIO' });
  const cwd = path.join(directory, 'project'); fs.mkdirSync(cwd);
  session = createSession(getProvider('codex'), cwd, 'offline-context-fixture');
  session.goal = newGoal('Review only this synthetic local fixture without making completion claims.');
  session.executionState = 'running'; saveSession(session);
  putRecord('run', session.id, { id: 'context-run', sessionId: session.id, goalId: session.goal.id, goalMode: true, state: 'running' });
  observed = [];
});
test.afterEach(async () => {
  if (engine) { await engine.interrupt('test_cleanup'); await engine.close(); }
  engine = null;
  for (const key of keys) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  fs.rmSync(directory, { recursive: true, force: true });
});
const calls = () => fs.existsSync(process.env.BZZY_TEST_LOG)
  ? fs.readFileSync(process.env.BZZY_TEST_LOG, 'utf8').split('\n').slice(0, -1).map(JSON.parse) : [];
async function until(check) {
  const deadline = Date.now() + 5000;
  while (!check()) { if (Date.now() > deadline) throw new Error('Native context fixture did not reach its expected phase.'); await delay(5); }
}
function createEngine() {
  const ui = { event(type, data) { observed.push({ type, data }); appendEvent(session.id, type, data); }, newline() {} };
  const host = { context: { runId: 'context-run', goalMode: true }, call() { throw new Error('No fixture tool was requested.'); } };
  engine = new CodexEngine(getProvider('codex'), session, { toolHost: host }, ui);
  return engine;
}

test('context budgets expose exact provenance and conservative unknown planning limits without template claims', () => {
  const gateway = { id: 'fixture-gateway', auth: 'api-key', catalogFormat: 'experiential', model: 'unknown' };
  const fallback = nativeContextBudget(gateway, session);
  assert.equal(fallback.tokens, 32768); assert.equal(fallback.source, 'conservative-local-fallback'); assert.equal(fallback.upstreamVerified, false);
  assert.equal(nativeContextBudget({ ...gateway, contextWindow: 64000 }, session).source, 'configured-provider-default');
  const exact = { ...gateway, modelCapabilities: { [session.model]: { contextWindow: 120000 } } };
  assert.equal(nativeContextBudget(exact, session).source, 'configured-exact-model-capability');
  const discovered = nativeContextBudget(exact, { ...session, modelCapabilities: { contextWindow: 200000 } });
  assert.equal(discovered.tokens, 200000); assert.equal(discovered.source, 'discovered-model-capability');
  assert.equal(nativeContextBudget(gateway, { ...session, modelCapabilities: { contextWindow: -1 } }).tokens, 32768);
  assert.equal(nativeContextBudget(getProvider('codex'), session).tokens, null);
});

test('readiness separates requested schemas, request acknowledgment, inherited manifests and unknown legacy schemas', () => {
  const tools = [{ name: 'list_skills', inputSchema: { type: 'object' } }];
  const first = prepareNativeReadiness(session, { backend: 'codex', tools, instructions: 'Synthetic instructions.' });
  assert.equal(first.phase, 'requested'); assert.equal(first.catalogReadiness.acknowledgment, 'not-yet-received');
  const accepted = acknowledgeNativeReadiness(session, { threadId: 'thread-1' });
  assert.equal(accepted.phase, 'request-accepted'); assert.equal(accepted.reportedTools, undefined);
  const resumed = prepareNativeReadiness(session, { backend: 'codex', threadId: 'thread-1', resumed: true, instructions: 'New synthetic instructions.' });
  assert.equal(resumed.tools.source, 'inherited-recorded-native-thread'); assert.deepEqual(resumed.tools.names, ['list_skills']);
  const legacy = prepareNativeReadiness(session, { backend: 'codex', threadId: 'legacy-thread', resumed: true });
  assert.equal(legacy.tools.source, 'unknown-legacy-native-thread'); assert.equal(legacy.tools.sha256, null);
});

test('modern compaction receipts survive reload, deduplicate lifecycle signals and coalesce matching legacy notifications', () => {
  const context = { threadId: 'thread-1', turnId: 'turn-1', itemId: 'compact-1' };
  assert.equal(recordNativeCompaction(session, { ...context, phase: 'started', at: 1000 }), true);
  assert.equal(recordNativeCompaction(session, { ...context, phase: 'started', at: 2000 }), false);
  assert.equal(recordNativeCompaction(session, { ...context, phase: 'completed', at: 4000 }), true);
  session = loadSession(session.id);
  assert.equal(recordNativeCompaction(session, { ...context, phase: 'completed', at: 5000 }), false);
  recordNativeCompaction(session, { threadId: 'thread-1', turnId: 'turn-1', phase: 'completed', legacy: true });
  assert.equal(session.nativeContext.epoch, 1); assert.equal(session.nativeContext.metrics.modernCompleted, 1);
  assert.equal(session.nativeContext.metrics.legacySignals, 1); assert.equal(session.nativeContext.metrics.completedDurationMs, 3000);
  assert.equal(session.sessionMemoryRefresh, true); assert.equal(session.nativeContext.refresh.state, 'pending');
  const diagnostic = events(session.id).find(row => row.type === 'diagnostic.context');
  assert.match(diagnostic.data.metricMeaning, /not CPU/);
});

test('refresh consumption requires the captured epoch and preserves newer compactions', () => {
  recordNativeCompaction(session, { threadId: 'thread', turnId: 't1', itemId: 'c1', phase: 'completed' });
  const epoch = session.nativeContext.epoch;
  recordNativeCompaction(session, { threadId: 'thread', turnId: 't1', itemId: 'c2', phase: 'completed' });
  consumeNativeRefresh(session, epoch, 'stale-prepared-prompt');
  assert.equal(session.nativeContext.refresh.state, 'pending'); assert.equal(session.sessionMemoryRefresh, true);
  consumeNativeRefresh(session, session.nativeContext.epoch, 'unprepared-input');
  assert.equal(session.nativeContext.refresh.state, 'pending');
  markNativeRefreshPrepared(session, session.nativeContext.epoch);
  consumeNativeRefresh(session, session.nativeContext.epoch, 'accepted-fixture-input');
  assert.equal(session.nativeContext.refresh.state, 'consumed'); assert.equal(session.sessionMemoryRefresh, false);
});

test('native context admission estimates complete source without clipping and rejects an insufficient applied budget', () => {
  const prompt = 'Original mandatory objective. '.repeat(1000);
  const estimate = nativeInputEstimate({ contextBudget: { tokens: 1024, appliedToNativeCatalog: true },
    instructions: 'Required workflow.', toolSchemaBytes: 100, prompt });
  assert.equal(estimate.components.preparedPrompt, Buffer.byteLength(prompt)); assert.equal(estimate.mandatoryExceedsBudget, true);
  assert.throws(() => assertNativeInputFits(estimate), error => error.code === 'CONTEXT_BUDGET_EXCEEDED' && /not truncated/.test(error.message));
  assert.doesNotThrow(() => assertNativeInputFits(nativeInputEstimate({ contextBudget: { tokens: null, appliedToNativeCatalog: false }, prompt })));
});

test('compaction pressure measures lifecycle union and requires explicit thresholds with consecutive breach and recovery hysteresis', () => {
  for (let index = 0; index < 5; index++) {
    const identity = { threadId: 'thread', turnId: `t${index}`, itemId: `p${index}` };
    recordNativeCompaction(session, { ...identity, phase: 'started', at: index * 10000 });
    recordNativeCompaction(session, { ...identity, phase: 'completed', at: index * 10000 + 8000 });
  }
  assert.ok(session.nativeContext.metrics.rolling.lifecycleDutyRatio > 0.8);
  assert.equal(observeContextPressure(session, null), false);
  const policy = { action: 'pause', minimumSamples: 3, maximumCompactionsPerMinute: 3, maximumDutyRatio: 0.65, consecutiveBreaches: 2, recoverySamples: 2 };
  assert.equal(observeContextPressure(session, policy), false);
  session.nativeContext.epoch++; assert.equal(observeContextPressure(session, policy), true);
  assert.equal(observeContextPressure(session, policy), false);
  session.nativeContext.metrics.rolling.compactionsPerMinute = 1; session.nativeContext.metrics.rolling.lifecycleDutyRatio = 0.1;
  session.nativeContext.epoch++; observeContextPressure(session, policy);
  session.nativeContext.epoch++; observeContextPressure(session, policy);
  assert.equal(session.nativeContext.pressure.latched, false);
});

test('task-state diagnostics count unchanged revisions, exact repeated bytes and cache hits without exposing private bindings', () => {
  const context = { runId: 'context-run', goalMode: true }, result = { revision: 'fixture-revision', contextGeneration: 'fixture:1', summary: 'Synthetic bounded state.' };
  for (const callId of ['one', 'two']) recordDiagnosticTool(session, context, { name: 'get_task_state', callId, started: Date.now(), result });
  recordDiagnosticTool(session, context, { name: 'get_task_state', callId: 'three', started: Date.now(), result: { ...result, notModified: true } });
  assert.equal(session.contextEfficiency.taskStateReads, 3); assert.equal(session.contextEfficiency.identicalPayloadReads, 1);
  assert.equal(session.contextEfficiency.repeatedPayloadBytes, Buffer.byteLength(JSON.stringify(result)));
  assert.equal(session.contextEfficiency.unchangedRevisionReads, 2); assert.equal(session.contextEfficiency.notModifiedReads, 1);
});

test('a legacy signal preceding a modern completion in the same turn is one refresh demand', () => {
  recordNativeCompaction(session, { threadId: 'thread', turnId: 't1', phase: 'completed', legacy: true });
  recordNativeCompaction(session, { threadId: 'thread', turnId: 't1', itemId: 'modern', phase: 'completed' });
  assert.equal(session.nativeContext.epoch, 1); assert.equal(session.nativeContext.metrics.modernCompleted, 1);
  recordNativeCompaction(session, { threadId: 'thread', turnId: 't1', itemId: 'modern-2', phase: 'completed' });
  assert.equal(session.nativeContext.epoch, 2);
});

test('modern compaction metrics remain bounded over a long synthetic run and unknown durations stay unknown', () => {
  for (let index = 0; index < 80; index++) recordNativeCompaction(session, {
    threadId: 'thread', turnId: `t${index}`, itemId: `c${index}`, phase: 'completed', at: index * 20000 });
  assert.equal(session.nativeContext.epoch, 80); assert.equal(session.nativeContext.metrics.recent.length, 64);
  assert.equal(session.nativeContext.metrics.durationSamples, 0); assert.equal(session.nativeContext.metrics.recent[0].durationMs, null);
});

test('Codex ignores another thread and seals complete messages with identities even when item IDs repeat across turns', async () => {
  createEngine(); engine.threadId = 'thread';
  engine.notification('item/completed', { threadId: 'foreign', turnId: 't1', item: { id: 'foreign', type: 'contextCompaction' } });
  assert.equal(session.nativeContext, undefined);
  for (const turnId of ['t1', 't2']) {
    engine.notification('turn/started', { threadId: 'thread', turn: { id: turnId } });
    engine.notification('item/agentMessage/delta', { threadId: 'thread', turnId, itemId: 'same-item', delta: `Visible ${turnId}.` });
    engine.notification('item/completed', { threadId: 'thread', turnId, item: { id: 'same-item', type: 'agentMessage', text: `Visible ${turnId}.` } });
    engine.notification('turn/completed', { threadId: 'thread', turn: { id: turnId, status: 'completed' } });
  }
  const texts = observed.filter(row => row.type === 'text'), seals = observed.filter(row => row.type === 'message.finalized');
  assert.equal(texts.length, 2); assert.equal(seals.length, 2);
  assert.deepEqual(texts.map(row => row.data.turnId), ['t1', 't2']);
  assert.ok(seals.every(row => row.data.runId === 'context-run' && row.data.threadRef && row.data.itemId === 'same-item'));
  engine.threadId = null;
});

test('an ongoing native goal retains explicit pending refresh when backend capability is unknown', async () => {
  createEngine(); const running = engine.run('Fixture', { goal: true }); running.catch(() => {});
  await until(() => session.nativeContext?.refresh?.reason === 'native-host-refresh-not-advertised');
  assert.equal(session.nativeContext.epoch, 1); assert.equal(session.nativeContext.metrics.modernCompleted, 1);
  assert.equal(calls().filter(call => call.method === 'turn/steer').length, 0);
  await engine.interrupt('user_pause'); await running;
  assert.equal(session.nativeContext.refresh.state, 'pending'); assert.notEqual(session.goal.status, 'complete');
});

test('an explicitly capable native fixture acknowledges one bounded refresh and later compactions respect cooldown', async () => {
  process.env.BZZY_TEST_SCENARIO = 'context-refresh';
  createEngine(); const running = engine.run('Fixture', { goal: true }); running.catch(() => {});
  await until(() => session.nativeContext?.refresh?.state === 'acknowledged');
  const steers = calls().filter(call => call.method === 'turn/steer');
  assert.equal(steers.length, 1); assert.equal(steers[0].params.expectedTurnId, 't1');
  assert.ok(Buffer.byteLength(steers[0].params.input[0].text) <= 12288);
  assert.equal(session.sessionMemoryRefresh, false);
  engine.notification('item/completed', { threadId: 'native-thread', turnId: 't1', item: { id: 'compact-2', type: 'contextCompaction' } });
  await until(() => session.nativeContext.refresh.reason === 'native-refresh-cooldown');
  assert.equal(calls().filter(call => call.method === 'turn/steer').length, 1);
  await engine.interrupt('user_pause'); await running;
});

for (const scenario of ['context-refresh-unacknowledged', 'context-refresh-rejected']) test(`${scenario} stays uncertain and is never blindly replayed`, async () => {
  process.env.BZZY_TEST_SCENARIO = scenario;
  createEngine(); const running = engine.run('Fixture', { goal: true }); running.catch(() => {});
  await until(() => session.nativeContext?.refresh?.state === 'uncertain');
  engine.notification('item/completed', { threadId: 'native-thread', turnId: 't1', item: { id: 'compact-later', type: 'contextCompaction' } });
  engine.queueContextRefresh(); await delay(20);
  assert.equal(session.nativeContext.refresh.state, 'uncertain');
  assert.equal(calls().filter(call => call.method === 'turn/steer').length, 1);
  await engine.interrupt('user_pause'); await running;
});

test('stop during a dispatched host refresh preserves pause and an uncertain receipt', async () => {
  process.env.BZZY_TEST_SCENARIO = 'context-refresh-held';
  createEngine(); const running = engine.run('Fixture', { goal: true }); running.catch(() => {});
  await until(() => session.nativeContext?.refresh?.state === 'dispatching');
  await engine.interrupt('user_pause'); await running; await engine.close(); await engine.refreshOperation;
  assert.equal(session.nativeContext.refresh.state, 'uncertain'); assert.equal(session.goal.status, 'paused');
  assert.equal(calls().filter(call => call.method === 'turn/steer').length, 1);
});

test('host refresh waits for unanswered approval and never answers or bypasses it', async () => {
  process.env.BZZY_TEST_SCENARIO = 'context-refresh';
  putRecord('question', 'fixture-approval', { id: 'fixture-approval', sessionId: session.id, state: 'pending', kind: 'approval' });
  createEngine(); const running = engine.run('Fixture', { goal: true }); running.catch(() => {});
  await until(() => session.nativeContext?.refresh?.reason === 'native-refresh-awaiting-host-request');
  assert.equal(calls().filter(call => call.method === 'turn/steer').length, 0);
  assert.equal(getRecord('question', 'fixture-approval').state, 'pending');
  removeRecord('question', 'fixture-approval'); engine.queueContextRefresh();
  await until(() => session.nativeContext.refresh.state === 'acknowledged');
  await engine.interrupt('user_pause'); await running;
});

test('a pause during asynchronous context preparation prevents native dispatch', async () => {
  process.env.BZZY_TEST_SCENARIO = 'context-refresh';
  createEngine();
  let release, preparing = false;
  engine.contextRefreshCapsule = () => { preparing = true; return new Promise(resolve => { release = resolve; }); };
  const running = engine.run('Fixture', { goal: true }); running.catch(() => {});
  await until(() => preparing);
  await engine.interrupt('user_pause'); await running;
  release({ revision: 'fixture', contextGeneration: 'fixture', goal: { objective: 'Synthetic context.' } });
  await engine.refreshOperation;
  assert.equal(calls().filter(call => call.method === 'turn/steer').length, 0);
  assert.equal(session.goal.status, 'paused');
});

test('recovery marks an unacknowledged dispatch uncertain without replaying it', async () => {
  recordNativeCompaction(session, { threadId: 'native-thread', turnId: 'previous', itemId: 'old-compaction', phase: 'completed' });
  session.nativeContext.refresh.state = 'dispatching'; session.nativeContext.refresh.requestId = 'previous-request';
  session.engineThreadId = 'native-thread'; session.coreSkillsProtocol = 6; saveSession(session);
  createEngine(); await engine.open();
  assert.equal(session.nativeContext.refresh.state, 'uncertain');
  assert.equal(session.nativeContext.refresh.reason, 'native-refresh-recovery-requires-safe-prompt');
  assert.equal(calls().filter(call => call.method === 'turn/steer').length, 0);
});

test('API context admission rejects an oversized original objective before dispatch without clipping it', async () => {
  process.env.EXPLABS_API_KEY = 'offline-fixture-key';
  session.provider = 'experiential'; session.backend = 'codex'; session.model = 'unknown-offline-model';
  const objective = 'Preserve this complete synthetic objective. '.repeat(5000);
  session.goal.objective = objective; saveSession(session);
  createEngine(); engine.provider = getProvider('experiential');
  await assert.rejects(engine.run('Fixture', { goal: true }), { code: 'CONTEXT_BUDGET_EXCEEDED' });
  assert.equal(session.goal.objective, objective); assert.equal(loadSession(session.id).goal.objective, objective);
  assert.equal(calls().some(call => call.method === 'thread/goal/set' && call.params.status === 'active'), false);
  const admission = events(session.id).find(row => row.type === 'diagnostic.backend' && row.data.method === 'context-admission');
  assert.equal(admission.data.outcome, 'rejected');
  assert.equal(admission.data.inputEstimate.components.mandatoryPrompt, Buffer.byteLength(objective));
});

test('input admission compacts derived handoff context once while preserving the complete current request', () => {
  const original = 'Historical derived text. '.repeat(3000);
  const source = 'Current original request — preserve every character.';
  const old = appendEvent(session.id, 'message.user', { text: original });
  session.conversationHandoff = { pending: true, throughSeq: old.seq };
  session.nativeContextBudget = { tokens: 8192, appliedToNativeCatalog: true }; saveSession(session);
  createEngine(); engine.nativeInstructions = 'Pinned full workflow.'; engine.nativeToolSchemaBytes = 100; engine.nativeToolsKnown = true;
  const prompt = engine.preparePrompt(source);
  assert.ok(prompt.includes(source)); assert.equal(prompt.includes(original), false); assert.ok(prompt.includes('CURRENT STATE CAPSULE'));
  const admission = events(session.id).find(row => row.type === 'diagnostic.backend' && row.data.method === 'context-admission');
  assert.equal(admission.data.inputEstimate.compactedDerived, true); assert.equal(admission.data.outcome, 'admitted');
});

test('an explicit pressure pause waits for a completed turn, preserves goal identity and starts no replacement work', async () => {
  createEngine(); engine.options.contextPressurePolicy = { action: 'pause', minimumSamples: 3, maximumCompactionsPerMinute: 3,
    maximumDutyRatio: 0.65, consecutiveBreaches: 2, recoverySamples: 2 };
  const goalId = session.goal.id, running = engine.run('Fixture', { goal: true }); running.catch(() => {});
  await until(() => session.nativeContext?.refresh?.state === 'pending');
  session.nativeContext.pressure = { pausePending: true, latched: true }; saveSession(session);
  engine.pauseForContextPressure(); assert.equal(engine.interrupted, false);
  engine.notification('turn/completed', { threadId: 'native-thread', turn: { id: 't1', status: 'completed' } });
  await running;
  assert.equal(session.goal.id, goalId); assert.equal(session.goal.status, 'paused'); assert.equal(session.goal.reason, 'context_pressure');
  assert.equal(calls().filter(call => call.method === 'thread/goal/set' && call.params.status === 'active').length, 1);
});

test('schema migration rotates only the native thread and cannot replenish native goal or chat budgets', async () => {
  session.coreSkillsProtocol = 5; session.engineThreadId = 'old-thread';
  session.goal.nativeTokenOffset = 20; session.goal.nativeTokensUsed = 70; session.goal.tokenBudget = 100;
  session.usage = { tokens: 90, available: true }; session.engineTokenOffset = 20; saveSession(session);
  const goalId = session.goal.id;
  createEngine(); const running = engine.run('Fixture', { goal: true, resumeGoal: true }); running.catch(() => {});
  await until(() => engine.activeTurns.size > 0);
  const goalSet = calls().find(call => call.method === 'thread/goal/set' && call.params.status === 'active');
  assert.equal(session.coreSkillsProtocol, 6); assert.equal(session.goal.id, goalId);
  assert.equal(session.goal.nativeTokenOffset, 70); assert.equal(session.engineTokenOffset, 90);
  assert.equal(goalSet.params.tokenBudget, 30); assert.ok(goalSet.params.objective);
  assert.ok(calls().some(call => call.method === 'thread/start'));
  assert.equal(calls().some(call => call.method === 'thread/resume'), false);
  await engine.interrupt('user_pause'); await running;
  assert.equal(getRecord('session', session.id).goal.id, goalId);
});

test('native goal budgets subtract actual delegated usage once across same-thread resume and thread migration', async () => {
  const goal = { tokenBudget: 100, nativeTokenOffset: 20, nativeTokensUsed: 60, delegatedTokensUsed: 10 };
  const resumed = nativeGoalTokenBudget(goal, 30);
  assert.equal(resumed.remainingTokens, 10); assert.equal(resumed.nativeBudget, 50);
  assert.equal(resumed.nativeBudget - (goal.nativeTokensUsed - goal.nativeTokenOffset), resumed.remainingTokens);
  const migrated = nativeGoalTokenBudget({ ...goal, nativeTokenOffset: 60 }, 30);
  assert.equal(migrated.nativeBudget, 10); assert.equal(migrated.remainingTokens, 10);
  const worker = createSession(getProvider('codex'), session.cwd, 'fixture-worker');
  worker.usage = { tokens: 20, available: true }; saveSession(worker);
  putRecord('assignment', 'budget-assignment', { id: 'budget-assignment', parentSessionId: session.id, goalId: session.goal.id,
    workerSessionId: worker.id, selection: { provider: 'codex', model: 'fixture-worker' }, createdAt: session.goal.createdAt });
  Object.assign(session.goal, { tokenBudget: 100, nativeTokenOffset: 20, nativeTokensUsed: 70, delegatedTokensUsed: 1 });
  session.coreSkillsProtocol = 5; session.engineThreadId = 'old-thread'; saveSession(session);
  createEngine(); const running = engine.run('Fixture', { goal: true, resumeGoal: true }); running.catch(() => {});
  await until(() => engine.activeTurns.size > 0);
  const dispatch = calls().find(call => call.method === 'thread/goal/set' && call.params.status === 'active');
  assert.equal(dispatch.params.tokenBudget, 10, 'The new native thread receives remaining aggregate budget after live delegated usage.');
  await engine.interrupt('user_pause'); await running;
});

test('exhausted aggregate usage cannot start a replacement native goal after schema migration', async () => {
  Object.assign(session.goal, { tokenBudget: 100, nativeTokensUsed: 70, delegatedTokensUsed: 30 });
  session.coreSkillsProtocol = 5; session.engineThreadId = 'old-thread'; saveSession(session);
  createEngine(); await assert.rejects(engine.run('Fixture', { goal: true, resumeGoal: true }), { code: 'GOAL_TOKEN_BUDGET_EXHAUSTED' });
  assert.equal(calls().some(call => call.method === 'thread/goal/set' && call.params.status === 'active'), false);
  assert.equal(session.goal.nativeTokenOffset, 70); assert.notEqual(session.goal.status, 'complete');
});

test('Claude records reported tools, deduplicates compact boundaries and seals each complete streamed message', async () => {
  const wrapper = path.join(directory, 'claude-fixture');
  fs.writeFileSync(wrapper, `#!${process.execPath}\nawait import(${JSON.stringify(new URL('./fixtures/native-context-claude.mjs', import.meta.url).href)});\n`, { mode: 0o700 });
  Object.assign(process.env, { BZZY_CLAUDE_BIN: wrapper, BZZY_CLAUDE_HOME: path.join(directory, 'claude-auth') });
  session.provider = 'claude'; session.backend = 'claude'; saveSession(session);
  engine = new ClaudeEngine(getProvider('claude'), session, { toolHost: { context: { runId: 'context-run', goalMode: false } } },
    { event(type, data) { observed.push({ type, data }); appendEvent(session.id, type, data); }, newline() {} });
  await engine.run('Synthetic fixture.');
  const text = observed.filter(row => row.type === 'text'), seals = observed.filter(row => row.type === 'message.finalized');
  assert.deepEqual(text.map(row => row.data.text), ['Visible message-1.', 'Visible message-2.']);
  assert.deepEqual(seals.map(row => row.data.itemId), ['message-1', 'message-2']);
  for (let index = 0; index < text.length; index++) {
    assert.equal(text[index].data.threadRef, seals[index].data.threadRef);
    assert.equal(text[index].data.runId, 'context-run'); assert.ok(text[index].data.turnId);
  }
  assert.equal(session.nativeContext.epoch, 1); assert.equal(session.nativeContext.metrics.legacySignals, 1);
  assert.equal(session.nativeContext.refresh.state, 'pending');
  assert.deepEqual(session.nativeBackendReadiness.reportedTools, ['mcp__bzzy_goal__list_skills']);
});
