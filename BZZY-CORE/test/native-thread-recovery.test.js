import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexEngine, codexDynamicTools, synchronizeCodexTools } from '../src/engine/engines/codex.js';
import { prepareNativeReadiness, acknowledgeNativeReadiness } from '../src/engine/native-context.js';
import { createSession, saveSession } from '../src/engine/store.js';
import { getProvider } from '../src/engine/providers.js';
import { newGoal } from '../src/engine/goals.js';
import { normalizeContract } from '../src/engine/contracts.js';
import { initializeProject } from '../src/engine/project.js';
import { appendEvent, getRecord, putRecord } from '../src/engine/database.js';

const environment = ['BZZY_HOME', 'BZZY_CODEX_HOME', 'BZZY_CODEX_BIN', 'BZZY_TEST_LOG', 'BZZY_TEST_SCENARIO', 'BZZY_ENV_ALLOW'];
const missing = (code = -32600, id = 'old-native-thread') => ({ code, message: `thread not found: ${id}` });
let root, previous, session, engine, runId;
test.beforeEach(() => {
  previous = Object.fromEntries(environment.map(key => [key, process.env[key]]));
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-missing-native-thread-')));
  Object.assign(process.env, { BZZY_HOME: path.join(root, 'private'), BZZY_CODEX_HOME: path.join(root, 'fixture-auth'),
    BZZY_CODEX_BIN: fileURLToPath(new URL('./fixtures/missing-thread-codex.mjs', import.meta.url)),
    BZZY_TEST_LOG: path.join(root, 'rpc.jsonl'), BZZY_TEST_SCENARIO: '{}', BZZY_ENV_ALLOW: 'BZZY_TEST_LOG,BZZY_TEST_SCENARIO' });
  const cwd = path.join(root, 'project'); fs.mkdirSync(cwd);
  session = createSession(getProvider('codex'), cwd, 'offline-native-recovery-fixture'); initializeProject(session);
  session.goal = newGoal('ORIGINAL CURRENT GOAL: inspect only local synthetic fixtures and preserve uncertainty.', 100);
  session.contract = normalizeContract({ context: 'COMPLETE CURRENT WORKFLOW: inspect only the permitted local fixture. '.repeat(70),
    constraints: ['Do not contact any target or acquire accounts.'], scope: { allowedTargets: ['https://owned.example.invalid'], excludedTargets: ['https://excluded.example.invalid'],
      allowedActions: ['offline fixtures'], excludedActions: ['production changes'] }, policy: { mode: 'read-only', network: 'disabled', writablePaths: [] } }, session.goal.objective);
  session.policy = session.contract.policy; session.executionState = 'running'; session.engineHome = process.env.BZZY_CODEX_HOME;
  Object.assign(session.goal, { nativeGoalId: 'old-native-goal', nativeTokensUsed: 70, nativeTokenOffset: 20, delegatedTokensUsed: 20, tokensUsed: 90 });
  session.usage = { tokens: 90, available: true }; session.engineTokenOffset = 20; saveSession(session);
  runId = randomUUID(); putRecord('run', session.id, { id: runId, sessionId: session.id, goalId: session.goal.id, goalMode: true, state: 'running' });
  appendEvent(session.id, 'message.user', { text: 'SAVED VISIBLE USER CONTEXT: retain the existing goal and permitted scope.' });
  appendEvent(session.id, 'text', { text: 'SAVED VISIBLE ASSISTANT CONTEXT: local fixture prerequisites are recorded.' });
  appendEvent(session.id, 'message.finalized', {});
});
test.afterEach(async () => {
  await engine?.close(); engine = null;
  for (const key of environment) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
  fs.rmSync(root, { recursive: true, force: true });
});
function calls(method) {
  const values = fs.existsSync(process.env.BZZY_TEST_LOG) ? fs.readFileSync(process.env.BZZY_TEST_LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  return method ? values.filter(value => value.method === method) : values;
}
function createEngine(scenario, { goalMode = true } = {}) {
  process.env.BZZY_TEST_SCENARIO = JSON.stringify(scenario);
  const options = { goalMode, policy: session.policy, toolHost: { context: { runId, goalMode }, call() { throw new Error('Fixture does not invoke tools.'); } } };
  session.engineThreadId = null; synchronizeCodexTools(session, options);
  session.engineThreadId = 'old-native-thread';
  prepareNativeReadiness(session, { backend: 'codex', tools: codexDynamicTools(session, options), instructions: 'Previously admitted fixture instructions.' });
  acknowledgeNativeReadiness(session, { threadId: session.engineThreadId }); saveSession(session);
  if (!goalMode) putRecord('run', session.id, { id: runId, sessionId: session.id, goalId: null, goalMode: false, state: 'running' });
  engine = new CodexEngine(getProvider('codex'), session, options, { event(type, data) { appendEvent(session.id, type, data); }, newline() {} });
  return engine;
}
function preparedGoal() {
  const request = calls('thread/goal/set').find(value => value.params.status === 'active');
  assert.ok(request, 'The current goal was installed exactly once.');
  const objective = request.params.objective || '';
  const file = /Read the complete goal objective at (.*?) before continuing\./.exec(objective)?.[1];
  return { request, text: file ? fs.readFileSync(file, 'utf8') : objective };
}
async function until(check) {
  const deadline = Date.now() + 5000;
  while (!check()) { if (Date.now() > deadline) throw new Error('Missing-thread fixture did not reach its expected phase.'); await delay(5); }
}

for (const code of [-32600, -32001]) for (const form of ['thread not found: old-native-thread', 'no rollout found for thread id old-native-thread']) test(`definite resume absence ${code} (${form}) starts one replacement thread and preserves the existing Core goal/budget/scope`, async () => {
  const id = session.id, goalId = session.goal.id, contract = structuredClone(session.contract), policy = structuredClone(session.policy);
  createEngine({ resumeError: { code, message: form } }); await engine.run('resume', { goal: true, resumeGoal: true });
  assert.equal(calls('thread/resume').length, 1); assert.equal(calls('thread/start').length, 1);
  assert.equal(calls('thread/goal/get').filter(call => call.params.threadId === 'old-native-thread').length, 1, 'A read-only miss is probed by exactly one actual resume before replacement.');
  const { request, text } = preparedGoal(); assert.equal(request.params.threadId, 'replacement-native-thread'); assert.equal(request.params.tokenBudget, 10);
  assert.equal(calls('thread/goal/set').filter(value => value.params.status === 'active').length, 1);
  assert.match(text, /ORIGINAL CURRENT GOAL/); assert.match(text, /SAVED VISIBLE USER CONTEXT/); assert.match(text, /SAVED VISIBLE ASSISTANT CONTEXT/);
  const start = calls('thread/start')[0];
  const durable = JSON.parse(start.params.developerInstructions.split('DURABLE TASK CONTEXT:\n').at(-1));
  assert.deepEqual(durable.contract, contract); assert.equal(start.params.sandbox, 'read-only');
  assert.ok(start.params.dynamicTools.some(tool => tool.name === 'get_task_state'));
  assert.equal(session.id, id); assert.equal(session.goal.id, goalId); assert.deepEqual(session.contract, contract); assert.deepEqual(session.policy, policy);
  assert.equal(session.goal.nativeTokenOffset, 70); assert.equal(session.goal.nativeTokensUsed, 72); assert.equal(session.goal.tokensUsed, 92);
  assert.equal(session.engineTokenOffset, 90); assert.equal(session.usage.tokens, 90); assert.equal(session.engineThreadId, 'replacement-native-thread');
  assert.equal(getRecord('session', id).goal.id, goalId); assert.equal(getRecord('session', id).goal.nativeTokenOffset, 70);
  assert.notEqual(session.goal.status, 'complete'); assert.equal(session.conversationHandoff.pending, false);
});

test('a thread absent from in-memory lookup loads from persisted rollout and never starts a replacement', async () => {
  createEngine({}); await engine.open();
  const methods = calls().map(call => call.method);
  assert.ok(methods.indexOf('thread/goal/get') < methods.indexOf('thread/resume'));
  assert.equal(calls('thread/goal/get').length, 2, 'The successfully loaded rollout is queried again without fabricating a fresh thread.');
  assert.equal(calls('thread/start').length, 0); assert.equal(session.engineThreadId, 'old-native-thread');
  assert.equal(session.goal.nativeTokenOffset, 20); assert.equal(session.engineTokenOffset, 20);
});

test('an already available persisted thread retains the existing goal lookup and resume sequence', async () => {
  createEngine({ initiallyLoaded: true }); await engine.open();
  const methods = calls().map(call => call.method);
  assert.ok(methods.indexOf('thread/goal/get') < methods.indexOf('thread/resume')); assert.equal(calls('thread/goal/get').length, 1);
  assert.equal(calls('thread/start').length, 0); assert.equal(session.engineThreadId, 'old-native-thread');
});

test('an already active native goal is paused before its existing thread is resumed', async () => {
  createEngine({ initiallyLoaded: true, existingGoalActive: true }); await engine.open();
  const methods = calls().filter(call => call.method).map(call => call.method);
  assert.ok(methods.indexOf('thread/goal/get') < methods.indexOf('thread/goal/set'));
  assert.ok(methods.indexOf('thread/goal/set') < methods.indexOf('thread/resume'));
  assert.equal(calls('thread/goal/set').length, 1); assert.equal(calls('thread/goal/set')[0].params.status, 'paused');
  assert.equal(calls('thread/start').length, 0); assert.equal(session.engineThreadId, 'old-native-thread');
});

test('an existing thread with no native goal reinstalls the original mission without losing previously consumed budget', async () => {
  const goalId = session.goal.id, contract = structuredClone(session.contract);
  createEngine({ nativeGoalMissing: true }); await engine.run('resume', { goal: true, resumeGoal: true });
  assert.equal(calls('thread/start').length, 0); assert.equal(session.engineThreadId, 'old-native-thread');
  const { request, text } = preparedGoal(); assert.match(text, /ORIGINAL CURRENT GOAL/); assert.match(text, /SAVED VISIBLE USER CONTEXT/);
  assert.equal(request.params.tokenBudget, 10); assert.equal(session.goal.nativeTokenOffset, 70); assert.equal(session.goal.nativeTokensUsed, 72);
  assert.equal(session.goal.tokensUsed, 92); assert.equal(session.goal.id, goalId); assert.deepEqual(session.contract, contract);
  assert.equal(session.engineTokenOffset, 20, 'The same native thread keeps its existing chat usage counter.');
});

for (const [name, error] of [
  ['authentication', { code: -32001, message: 'Fixture authentication expired.' }],
  ['generic RPC', { code: -32600, message: 'Fixture request validation failed.' }],
  ['unsupported method', { code: -32601, message: 'Method not found.' }],
  ['different thread ID', missing(-32600, 'another-native-thread')],
  ['ambiguous proxy wording', { code: -32600, message: 'Proxy says thread not found: old-native-thread; authentication may have failed.' }],
  ['transport closure', 'transport'],
]) test(`${name} while resuming never implies missing-thread authority or dispatches a new goal`, async () => {
  createEngine({ resumeError: error }); await assert.rejects(engine.run('resume', { goal: true, resumeGoal: true }), actual =>
    error === 'transport' ? /Backend exited/.test(actual.message) : actual.rpcCode === error.code && actual.message === error.message);
  assert.equal(calls('thread/resume').length, 1, 'The rejection must come from the requested resume, not an earlier unloaded lookup.');
  assert.equal(calls('thread/start').length, 0); assert.equal(calls('thread/goal/set').filter(value => value.params.status === 'active').length, 0);
  assert.equal(session.engineThreadId, 'old-native-thread'); assert.equal(session.goal.nativeTokenOffset, 20); assert.equal(session.engineTokenOffset, 20);
});

test('goal/get failure after accepted resume is not evidence that the accepted thread is missing', async () => {
  createEngine({ getError: missing(-32600) }); await assert.rejects(engine.run('resume', { goal: true, resumeGoal: true }));
  assert.equal(calls('thread/resume').length, 1); assert.equal(calls('thread/start').length, 0);
  assert.equal(calls('thread/goal/set').filter(value => value.params.status === 'active').length, 0);
});

test('a missing-thread error from mutating native goal dispatch is never automatically replayed', async () => {
  createEngine({ initiallyLoaded: true, activeGoalError: missing(-32600) }); await assert.rejects(engine.run('resume', { goal: true, resumeGoal: true }));
  assert.equal(calls('thread/start').length, 0); assert.equal(calls('thread/resume').length, 1);
  assert.equal(calls('thread/goal/set').filter(value => value.params.status === 'active').length, 1);
  assert.equal(session.engineThreadId, 'old-native-thread'); assert.equal(session.goal.nativeTokenOffset, 20);
});

test('a missing-thread error from mutating ordinary turn dispatch is never automatically replayed', async () => {
  createEngine({ initiallyLoaded: true, turnError: missing(-32001) }, { goalMode: false }); await assert.rejects(engine.run('Current ordinary request.'));
  assert.equal(calls('thread/start').length, 0); assert.equal(calls('thread/resume').length, 1); assert.equal(calls('turn/start').length, 1);
  assert.equal(session.engineThreadId, 'old-native-thread'); assert.equal(session.goal.nativeTokenOffset, 20);
});

test('an exhausted aggregate goal cannot spend a renewed allowance after definite thread loss', async () => {
  session.goal.tokenBudget = 90; saveSession(session);
  createEngine({ resumeError: missing() });
  await assert.rejects(engine.run('resume', { goal: true, resumeGoal: true }), { code: 'GOAL_TOKEN_BUDGET_EXHAUSTED' });
  assert.equal(calls('thread/start').length, 1); assert.equal(calls('thread/goal/set').filter(call => call.params.status === 'active').length, 0);
  assert.equal(session.goal.nativeTokenOffset, 70); assert.notEqual(session.goal.status, 'complete');
});

test('a failed replacement thread/start is not recursively retried', async () => {
  createEngine({ resumeError: missing(), startError: missing(-32001, 'replacement-native-thread') });
  await assert.rejects(engine.run('resume', { goal: true, resumeGoal: true }));
  assert.equal(calls('thread/resume').length, 1); assert.equal(calls('thread/start').length, 1);
  assert.equal(calls('thread/goal/set').filter(call => call.params.status === 'active').length, 0);
});

test('owner pause and clear still target a successfully recreated native goal, and absence afterward never manufactures one', async () => {
  createEngine({ resumeError: missing() }); await engine.run('resume', { goal: true, resumeGoal: true });
  const active = calls('thread/goal/set').filter(call => call.params.status === 'active').length;
  await engine.setGoalStatus('paused');
  assert.equal(calls('thread/goal/set').filter(call => call.params.status === 'paused').length, 1);
  await engine.setGoalStatus('clear'); assert.equal(calls('thread/goal/clear').length, 1);
  const absent = await engine.setGoalStatus('paused'); assert.equal(absent.nativeGoalAbsent, true);
  assert.equal(calls('thread/goal/set').filter(call => call.params.status === 'paused').length, 1);
  assert.equal(calls('thread/goal/set').filter(call => call.params.status === 'active').length, active);
});

for (const nativeTokensUsed of [undefined, 60]) test(`legacy supervisor consumption remains spent after native thread loss (native counter ${nativeTokensUsed ?? 'absent'})`, async () => {
  session.goal.supervisorTokensUsed = 70;
  if (nativeTokensUsed === undefined) delete session.goal.nativeTokensUsed; else session.goal.nativeTokensUsed = nativeTokensUsed;
  saveSession(session);
  createEngine({ resumeError: missing() }); await engine.run('resume', { goal: true, resumeGoal: true });
  assert.equal(preparedGoal().request.params.tokenBudget, 10); assert.equal(session.goal.nativeTokenOffset, 70);
  assert.equal(session.goal.nativeTokensUsed, 72); assert.equal(session.goal.tokensUsed, 92);
});

test('a rejected pause request is never treated as permission to replace its native thread', async () => {
  createEngine({ initiallyLoaded: true, existingGoalActive: true, pauseError: missing() });
  await assert.rejects(engine.run('resume', { goal: true, resumeGoal: true }));
  assert.equal(calls('thread/goal/set').filter(call => call.params.status === 'paused').length, 1);
  assert.equal(calls('thread/resume').length, 0); assert.equal(calls('thread/start').length, 0);
});

test('an owner interruption while resume metadata is pending rejects a late missing response without replacement', async () => {
  createEngine({ resumeError: missing(), resumeDelayMs: 100 });
  const running = engine.run('resume', { goal: true, resumeGoal: true }); running.catch(() => {});
  await until(() => calls('thread/resume').length === 1); await engine.interrupt('user_pause'); await assert.rejects(running);
  assert.equal(engine.interrupted, true); assert.equal(calls('thread/start').length, 0);
  assert.equal(calls('thread/goal/set').filter(call => call.params.status === 'active').length, 0);
  assert.equal(session.engineThreadId, 'old-native-thread'); assert.equal(session.goal.nativeTokenOffset, 20);
});

test('even an already completed unexpected startup turn prevents automatic replacement after resume rejection', async () => {
  createEngine({ resumeError: missing(), startupTurnBeforeResumeError: true });
  await assert.rejects(engine.run('resume', { goal: true, resumeGoal: true }));
  assert.equal(engine.startedTurns, 1); assert.equal(engine.activeTurns.size, 0);
  assert.equal(calls('thread/start').length, 0); assert.equal(calls('thread/goal/set').filter(call => call.params.status === 'active').length, 0);
});

for (const resumeReplyKind of ['null', 'missing', 'false']) test(`malformed successful resume result ${resumeReplyKind} never authorizes native thread replacement`, async () => {
  createEngine({ resumeReplyKind }); await assert.rejects(engine.run('resume', { goal: true, resumeGoal: true }));
  assert.equal(calls('thread/resume').length, 1); assert.equal(calls('thread/start').length, 0);
  assert.equal(calls('thread/goal/set').filter(call => call.params.status === 'active').length, 0);
  assert.equal(session.engineThreadId, 'old-native-thread'); assert.equal(session.goal.nativeTokenOffset, 20);
});
