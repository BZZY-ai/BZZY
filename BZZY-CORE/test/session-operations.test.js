import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSession, loadSession, saveSession } from '../src/engine/store.js';
import { BUILTINS, saveDefaultSelection, defaultSelection } from '../src/engine/providers.js';
import { appendEvent, events, getRecord, putRecord, listRecords } from '../src/engine/database.js';
import { claimInput } from '../src/engine/runtime.js';
import { prepareTask } from '../src/engine/task.js';
import { newGoal } from '../src/engine/goals.js';
import { enqueueGoalTurn, updateIdleGoal, setSessionModel, setSessionProvider, setSessionMode } from '../src/engine/session-operations.js';
import { createTaskSession, activateTaskGoal, createChatSession, newConversation, startConversationGoal, prepareResume, controlSavedGoal } from '../src/engine/host-commands.js';
import { CodexEngine } from '../src/engine/engines/codex.js';
import { recoverOrphanedVerification } from '../src/engine/recovery.js';

let directory, workspace, saved;
const keys = ['BZZY_HOME', 'BZZY_CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR'];
test.beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-ops-'));
  workspace = path.join(directory, 'workspace'); fs.mkdirSync(workspace);
  saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { BZZY_HOME: path.join(directory, 'private'), BZZY_CODEX_HOME: path.join(directory, 'codex'),
    CLAUDE_CONFIG_DIR: path.join(directory, 'claude'), CLAUDE_SECURESTORAGE_CONFIG_DIR: path.join(directory, 'claude-secure') });
});
test.afterEach(() => {
  for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  fs.rmSync(directory, { recursive: true, force: true });
});

function goalSession() {
  const session = createSession(BUILTINS.codex, workspace);
  prepareTask(session, {}, 'Inspect supplied evidence');
  session.goal = newGoal(session.contract.objective, 1000); saveSession(session);
  return session;
}

const delegateSelection = { supervisor: { provider: 'claude', model: 'fixture-brain', effort: 'high', capabilities: { supportsEffort: true } },
  executor: { provider: 'codex', model: 'fixture-hands', effort: 'low', capabilities: { supportedEfforts: ['low'] } } };
function switchMode(session, owner, mode, selection = delegateSelection, expectedUpdatedAt = loadSession(session.id).updatedAt) {
  return setSessionMode(session.id, owner, { mode, selection, expectedUpdatedAt });
}

test('paused solo/delegate switches preserve the same chat, goal, policies, history and usage, then restore the original solo choice', () => {
  const session = goalSession(), owner = randomUUID();
  Object.assign(session, { model: 'original-solo', selectedEffort: 'xhigh', modelCapabilities: { supportedEfforts: ['xhigh'] },
    alias: 'Keep this chat', engineThreadId: 'old-thread', usage: { tokens: 90 }, checkpoint: { phase: 'review' } });
  Object.assign(session.goal, { tokensUsed: 60, nativeTokensUsed: 40, delegatedTokensUsed: 20, evidence: ['original-evidence'] });
  saveSession(session); claimInput(session.id, owner); updateIdleGoal(session.id, owner, 'pause');
  const original = loadSession(session.id), contract = structuredClone(original.contract);
  appendEvent(session.id, 'message.user', { text: 'Keep all this context.' });
  const reply = appendEvent(session.id, 'text', { text: '[b]Original response[/b]' });
  const delegated = switchMode(session, owner, 'delegate');
  assert.equal(delegated.id, original.id); assert.equal(delegated.cwd, original.cwd); assert.equal(delegated.alias, original.alias);
  assert.equal(delegated.mode, 'delegate'); assert.equal(delegated.provider, 'claude'); assert.equal(delegated.selectedEffort, 'high');
  assert.deepEqual(delegated.executor, delegateSelection.executor);
  assert.equal(delegated.executionState, 'paused'); assert.equal(delegated.goal.id, original.goal.id); assert.equal(delegated.goal.status, 'paused');
  assert.equal(delegated.goal.tokensUsed, 60); assert.equal(delegated.goal.nativeTokenOffset, 40); assert.equal(delegated.engineTokenOffset, 90);
  assert.deepEqual(delegated.contract, contract); assert.deepEqual(delegated.policy, original.policy); assert.deepEqual(delegated.checkpoint, original.checkpoint);
  assert.deepEqual(delegated.goal.evidence, original.goal.evidence); assert.equal(delegated.engineThreadId, null);
  assert.equal(delegated.conversationHandoff.pending, true); assert.ok(delegated.conversationHandoff.throughSeq >= reply.seq);
  const solo = switchMode(session, owner, 'solo');
  assert.equal(solo.id, session.id); assert.equal(solo.mode, 'solo'); assert.equal(solo.provider, 'codex'); assert.equal(solo.model, 'original-solo');
  assert.equal(solo.selectedEffort, 'xhigh'); assert.deepEqual(solo.modelCapabilities, original.modelCapabilities);
  assert.equal(solo.executor, undefined); assert.equal(solo.goal.id, original.goal.id); assert.equal(solo.executionState, 'paused');
  assert.equal(solo.goal.tokensUsed, 60); assert.equal(solo.goal.tokenBudget, original.goal.tokenBudget);
  assert.equal(events(session.id).find(event => event.seq === reply.seq).data.text, '[b]Original response[/b]');
  assert.equal(events(session.id).filter(event => event.type === 'mode.changed').length, 2);
  assert.equal(listRecords('execution').length, 0); assert.equal(listRecords('session').length, 1); assert.equal(defaultSelection(), null);
});

test('mode switches always require a paused chat and reject queued work, live workers and child/Agent contexts', () => {
  const session = goalSession(), owner = randomUUID(); claimInput(session.id, owner);
  for (const state of ['idle', 'failed', 'cancelled']) {
    session.executionState = state; session.goal.status = 'paused'; saveSession(session);
    assert.throws(() => switchMode(session, owner, 'delegate'), /\/pause or \/goal pause/);
    assert.throws(() => switchMode(session, owner, 'solo'), /\/pause or \/goal pause/);
  }
  session.executionState = 'paused'; saveSession(session);
  putRecord('execution', 'busy', { id: 'busy', sessionId: session.id, state: 'queued' });
  assert.throws(() => switchMode(session, owner, 'delegate'), /still running/);
  putRecord('execution', 'busy', { id: 'busy', sessionId: session.id, state: 'finished' });
  putRecord('assignment', 'worker', { id: 'worker', parentSessionId: session.id, goalId: 'an-older-goal', currentRound: 1 });
  putRecord('round', 'worker:1', { state: 'starting' });
  assert.throws(() => switchMode(session, owner, 'solo'), /workers are still stopping/);
  putRecord('round', 'worker:1', { state: 'cancelled' });
  for (const marker of [{ purpose: 'agent' }, { parentSessionId: 'parent' }, { parallelSessionId: 'parent' }]) {
    const fresh = { ...session, ...marker }; saveSession(fresh);
    assert.throws(() => switchMode(fresh, owner, 'solo'), /root terminal chat/);
    saveSession(session);
  }
  assert.equal(loadSession(session.id).mode, 'solo');
});

test('/goal pause from the local idle chat confirms a pause without reopening a completed goal', async () => {
  for (const completed of [false, true]) {
    const session = goalSession();
    if (completed) { session.goal.status = 'complete'; session.acceptance = { passed: true }; saveSession(session); }
    await controlSavedGoal(session, 'pause', {}, { event() {} });
    const paused = loadSession(session.id); assert.equal(paused.executionState, 'paused');
    assert.equal(paused.goal.status, completed ? 'complete' : 'paused');
    claimInput(session.id, 'owner');
    assert.equal(switchMode(session, 'owner', 'delegate').executionState, 'paused');
    assert.equal(listRecords('execution').length, 0);
  }
});

test('paused solo/debate/delegate switches retain the original solo selection and use persisted Debate agents for explicit work', async () => {
  const session = goalSession(); session.model = 'solo-original'; session.selectedEffort = 'xhigh'; saveSession(session);
  claimInput(session.id, 'owner'); updateIdleGoal(session.id, 'owner', 'pause');
  const agents = [delegateSelection.supervisor, delegateSelection.executor, { provider: 'codex', model: 'third-agent', effort: 'default', capabilities: null }];
  assert.throws(() => switchMode(session, 'owner', 'debate', { agents: agents.slice(0, 1) }), /two or three/);
  const changed = switchMode(session, 'owner', 'debate', { agents });
  assert.equal(changed.mode, 'debate'); assert.deepEqual(changed.debateAgents, agents); assert.equal(changed.executor, undefined);
  assert.equal(changed.goal.id, session.goal.id); assert.equal(changed.goal.status, 'paused'); assert.equal(changed.executionState, 'paused');
  switchMode(session, 'owner', 'delegate');
  assert.equal(loadSession(session.id).debateAgents, undefined);
  const solo = switchMode(session, 'owner', 'solo');
  assert.equal(solo.model, 'solo-original'); assert.equal(solo.selectedEffort, 'xhigh'); assert.equal(solo.executionState, 'paused');
  switchMode(session, 'owner', 'debate', { agents });
  assert.equal(listRecords('execution').length, 0);
  const job = await enqueueGoalTurn(session.id, 'owner', { mode: 'delegate', debateAgents: [agents[0], agents[0]] }, {
    resume: true, requestId: randomUUID(),
  });
  assert.equal(getRecord('execution', job.executionId).options.mode, 'debate');
  assert.deepEqual(getRecord('execution', job.executionId).options.debateAgents, agents);
  assert.equal(loadSession(session.id).goal.id, session.goal.id);
});

test('mode mutation rechecks ownership, authorization, the selected revision and both agent choices atomically', () => {
  const session = goalSession(), owner = randomUUID();
  assert.throws(() => switchMode(session, owner, 'delegate'), /own input/);
  claimInput(session.id, owner); updateIdleGoal(session.id, owner, 'pause');
  const paused = loadSession(session.id), eventCount = events(session.id).length;
  assert.throws(() => switchMode(session, owner, 'delegate', delegateSelection, 'stale'), { code: 'CONFLICT' });
  assert.throws(() => switchMode(session, owner, 'delegate', { supervisor: delegateSelection.supervisor }), /both/);
  assert.throws(() => switchMode(session, owner, 'delegate', { ...delegateSelection, executor: { provider: 'missing-provider' } }), /Unknown provider/);
  assert.throws(() => switchMode(session, owner, 'delegate', { ...delegateSelection, executor: {} }), /installed provider/);
  assert.throws(() => setSessionMode(session.id, owner, { mode: 'delegate', selection: delegateSelection, expectedUpdatedAt: paused.updatedAt },
    { authorize() { throw new Error('Revoked'); } }), /Revoked/);
  assert.deepEqual(loadSession(session.id), paused); assert.equal(events(session.id).length, eventCount);
  claimInput(session.id, 'other-client', true);
  assert.throws(() => switchMode(session, owner, 'delegate'), /own input/);
  assert.deepEqual(loadSession(session.id), paused);
});

test('a chat launched as Delegate can return to its saved solo default without changing either default', () => {
  const preset = createSession(BUILTINS.codex, workspace, 'solo-default'); preset.selectedEffort = 'low';
  saveDefaultSelection(preset); const savedDefault = defaultSelection();
  const session = createSession(BUILTINS.claude, workspace, 'delegate-brain');
  Object.assign(session, { mode: 'delegate', executor: delegateSelection.executor, executionState: 'paused' }); saveSession(session);
  claimInput(session.id, 'owner');
  const solo = switchMode(session, 'owner', 'solo');
  assert.equal(solo.provider, savedDefault.provider); assert.equal(solo.model, savedDefault.model); assert.equal(solo.selectedEffort, savedDefault.effort);
  assert.deepEqual(defaultSelection(), savedDefault); assert.equal(solo.executionState, 'paused');
});

test('pausing a completed goal permits a mode switch without reopening verified completion', () => {
  const session = goalSession(); session.goal.status = 'complete'; session.acceptance = { passed: true }; saveSession(session);
  claimInput(session.id, 'owner'); const paused = updateIdleGoal(session.id, 'owner', 'pause');
  assert.equal(paused.goal.status, 'complete'); assert.equal(paused.executionState, 'paused');
  const changed = switchMode(session, 'owner', 'delegate');
  assert.equal(changed.goal.status, 'complete'); assert.deepEqual(changed.acceptance, { passed: true });
  assert.equal(listRecords('execution').length, 0);
});

test('an explicit new goal after switching uses the persisted mode/executor despite stale launch options', async () => {
  const session = goalSession(); claimInput(session.id, 'owner'); updateIdleGoal(session.id, 'owner', 'pause');
  switchMode(session, 'owner', 'delegate');
  const job = await enqueueGoalTurn(session.id, 'owner', { mode: 'solo', executor: 'deepseek', executorModel: 'stale-executor' }, {
    objective: 'New delegated objective', replaceGoalId: session.goal.id,
    request: async () => ({ capabilities: {}, execution: null }),
  });
  const fresh = loadSession(session.id);
  assert.equal(fresh.mode, 'delegate'); assert.deepEqual(fresh.executor, delegateSelection.executor);
  assert.equal(fresh.goal.objective, 'New delegated objective'); assert.equal(listRecords('execution').length, 1);
  putRecord('execution', job.executionId, { ...getRecord('execution', job.executionId), state: 'finished' });
  updateIdleGoal(session.id, 'owner', 'pause'); switchMode(session, 'owner', 'solo');
  await enqueueGoalTurn(session.id, 'owner', { mode: 'delegate', executor: 'deepseek' }, {
    objective: 'New solo objective', replaceGoalId: fresh.goal.id,
    request: async () => ({ capabilities: {}, execution: null }),
  });
  assert.equal(loadSession(session.id).mode, 'solo'); assert.equal(loadSession(session.id).executor, undefined);
});

test('Core model mutations reject missing and transferred input ownership', () => {
  const session = goalSession(), owner = randomUUID(), selection = { model: 'core-fixture-model', effort: 'default', capabilities: null };
  assert.throws(() => setSessionModel(session.id, owner, selection), /own input/);
  claimInput(session.id, owner);
  assert.equal(setSessionModel(session.id, owner, selection).model, selection.model);
  claimInput(session.id, randomUUID(), true);
  assert.throws(() => setSessionModel(session.id, owner, { ...selection, model: 'unauthorized' }), /own input/);
  assert.equal(loadSession(session.id).model, selection.model);
});

test('Core provider changes retain conversation handoff and goal token accounting', () => {
  const session = goalSession(), owner = randomUUID();
  session.engineThreadId = 'previous-provider-thread'; session.usage = { tokens: 90 };
  Object.assign(session.goal, { tokensUsed: 60, delegatedTokensUsed: 20, nativeTokensUsed: 40 }); saveSession(session);
  appendEvent(session.id, 'message.user', { text: 'Keep the current context.' });
  const reply = appendEvent(session.id, 'text', { text: 'The previous reply.' });
  claimInput(session.id, owner);
  const changed = setSessionProvider(session.id, owner, 'codex', 'deepseek', { model: 'fixture-model', effort: 'default', capabilities: null });
  assert.equal(changed.provider, 'deepseek'); assert.equal(changed.engineThreadId, null);
  assert.equal(changed.engineTokenOffset, 90); assert.equal(changed.goal.supervisorTokensUsed, 40);
  assert.equal(changed.goal.nativeTokenOffset, 40); assert.equal(changed.goal.tokensUsed, 60);
  assert.equal(changed.goal.nativeTokensUsed, undefined);
  assert.equal(changed.conversationHandoff.pending, true); assert.ok(changed.conversationHandoff.throughSeq >= reply.seq);
  assert.throws(() => setSessionProvider(session.id, owner, 'codex', 'claude', { model: null }), /provider changed/);
  assert.equal(events(session.id).filter(event => event.type === 'provider.changed').length, 1);
});

test('Core idle goal controls archive the goal and reject active executions', () => {
  const session = goalSession(), owner = randomUUID(); claimInput(session.id, owner);
  const paused = updateIdleGoal(session.id, owner, 'pause'); assert.equal(paused.goal.status, 'paused');
  putRecord('execution', 'active-fixture', { id: 'active-fixture', sessionId: session.id, state: 'queued' });
  assert.throws(() => updateIdleGoal(session.id, owner, 'clear'), /running/);
  putRecord('execution', 'active-fixture', { id: 'active-fixture', sessionId: session.id, state: 'finished' });
  assert.equal(updateIdleGoal(session.id, owner, 'clear').goal, null);
  assert.equal(getRecord('goal-history', session.goal.id).status, 'paused');
  assert.ok(getRecord('goal-history', session.goal.id).clearedAt);
});

test('resuming through Core queues one execution for a repeated request', async () => {
  const session = goalSession(), owner = randomUUID(), requestId = randomUUID();
  session.goal.status = 'paused'; saveSession(session); claimInput(session.id, owner);
  const first = await enqueueGoalTurn(session.id, owner, {}, { resume: true, requestId });
  const repeated = await enqueueGoalTurn(session.id, owner, {}, { resume: true, requestId });
  assert.equal(repeated.executionId, first.executionId);
  assert.equal(listRecords('execution', { sessionId: session.id }).length, 1);
  assert.equal(loadSession(session.id).goal.notificationEpoch, 1);
  assert.equal(getRecord('execution', first.executionId).resumeGoal, true);
});

for (const status of ['blocked', 'awaiting_review', 'budget_limited']) test(`/goal resume keeps a stalled ${status} goal and its saved checkpoint`, async () => {
  const session = goalSession(), owner = randomUUID(), requestId = randomUUID();
  Object.assign(session.goal, { status, reason: 'Previous attempt stalled', tokensUsed: 80, turns: 5,
    blockerStreak: 3, lastBlocker: 'Previous blocker', noActivityTurns: 3, evidence: ['saved-evidence'] });
  session.checkpoint = { phase: 'review', artifact: 'saved-result' };
  saveSession(session); claimInput(session.id, owner);
  const originalContract = structuredClone(session.contract), originalGoal = session.goal.id;
  const first = await enqueueGoalTurn(session.id, owner, {}, { resume: true, requestId });
  const repeated = await enqueueGoalTurn(session.id, owner, {}, { resume: true, requestId });
  const resumed = loadSession(session.id);
  assert.equal(first.executionId, repeated.executionId);
  assert.equal(resumed.goal.id, originalGoal); assert.equal(resumed.goal.objective, session.goal.objective);
  assert.deepEqual(resumed.goal.evidence, ['saved-evidence']); assert.deepEqual(resumed.checkpoint, session.checkpoint);
  assert.deepEqual(resumed.contract, originalContract); assert.equal(resumed.goal.tokensUsed, 80);
  assert.equal(resumed.goal.blockerStreak, 0); assert.equal(resumed.goal.noActivityTurns, 0);
  assert.equal(resumed.goal.lastBlocker, null); assert.equal(resumed.goal.reason, undefined);
  assert.equal(resumed.goal.notificationEpoch, 1); assert.equal(getRecord('execution', first.executionId).resumeGoal, true);
  assert.equal(listRecords('execution', { sessionId: session.id }).length, 1);
});

test('stalled goal resume preserves exhausted budgets until the user explicitly raises the total', async () => {
  const session = goalSession(), owner = randomUUID();
  Object.assign(session.goal, { status: 'budget_limited', tokensUsed: 1000 }); saveSession(session); claimInput(session.id, owner);
  await assert.rejects(enqueueGoalTurn(session.id, owner, {}, { resume: true }), /budget is exhausted/);
  assert.equal(listRecords('execution', { sessionId: session.id }).length, 0);
  const receipt = await enqueueGoalTurn(session.id, owner, { tokenBudget: 2000 }, { resume: true });
  assert.equal(loadSession(session.id).goal.id, session.goal.id); assert.equal(loadSession(session.id).goal.tokenBudget, 2000);
  assert.equal(getRecord('execution', receipt.executionId).resumeGoal, true);
});

test('the stalled resume shortcut is bound to the exact goal and rechecks stalled state inside admission', async () => {
  const session = goalSession(), owner = randomUUID();
  session.goal.status = 'blocked'; saveSession(session); claimInput(session.id, owner);
  await assert.rejects(enqueueGoalTurn(session.id, owner, {}, { resume: true, resumeGoalId: randomUUID() }), { code: 'CONFLICT' });
  session.goal.status = 'paused'; saveSession(session);
  await assert.rejects(enqueueGoalTurn(session.id, owner, {}, { resume: true, resumeGoalId: session.goal.id }), { code: 'CONFLICT' });
  assert.equal(listRecords('execution', { sessionId: session.id }).length, 0);
  session.goal.status = 'blocked'; saveSession(session);
  const requestId = randomUUID(), input = { resume: true, resumeGoalId: session.goal.id, requestId };
  const receipt = await enqueueGoalTurn(session.id, owner, {}, input);
  assert.equal((await enqueueGoalTurn(session.id, owner, {}, input)).executionId, receipt.executionId);
  assert.equal(loadSession(session.id).goal.id, session.goal.id);
});

test('new goals require exact replacement confirmation, reset evidence and deduplicate before stopping work', async () => {
  const session = goalSession(), owner = randomUUID(), requestId = randomUUID(); claimInput(session.id, owner);
  session.acceptance = { passed: true, criteria: ['old evidence'] }; saveSession(session);
  let reads = 0;
  const request = async () => { reads++; return { execution: null, capabilities: {} }; };
  await assert.rejects(enqueueGoalTurn(session.id, owner, {}, { objective: 'New objective', request }), { code: 'CONFIRMATION_REQUIRED' });
  assert.equal(reads, 0); assert.equal(loadSession(session.id).goal.id, session.goal.id);
  await assert.rejects(enqueueGoalTurn(session.id, owner, {}, { objective: 'New objective', replaceGoalId: randomUUID(), request }), { code: 'CONFIRMATION_REQUIRED' });
  const input = { objective: 'New objective', replaceGoalId: session.goal.id, requestId, request };
  const first = await enqueueGoalTurn(session.id, owner, {}, input);
  const repeated = await enqueueGoalTurn(session.id, owner, {}, input);
  assert.equal(first.executionId, repeated.executionId); assert.equal(reads, 1);
  const changed = loadSession(session.id);
  assert.equal(changed.goal.objective, 'New objective'); assert.equal(changed.contract.objective, 'New objective');
  assert.equal(changed.acceptance, null); assert.notEqual(changed.goal.id, session.goal.id);
  assert.equal(getRecord('goal-history', session.goal.id).supersededBy, changed.goal.id);
  assert.equal(getRecord('execution', first.executionId).goal, true);
  await assert.rejects(enqueueGoalTurn(session.id, owner, {}, { ...input, objective: 'Different objective' }), /Idempotency conflict/);
});

test('replacement rechecks permission after reads and requires cancel permission before stopping a run', async () => {
  const session = goalSession(), owner = randomUUID(); claimInput(session.id, owner);
  let cancelled = false;
  const input = { objective: 'Replacement', replaceGoalId: session.goal.id,
    request: async method => { if (method === 'POST') cancelled = true; return { execution: { state: 'running' } }; },
    authorize: permission => { if (permission === 'cancel') throw Object.assign(new Error('Cancel denied'), { status: 403 }); } };
  await assert.rejects(enqueueGoalTurn(session.id, owner, {}, input), /Cancel denied/);
  assert.equal(cancelled, false); assert.equal(loadSession(session.id).goal.id, session.goal.id);
  let valid = true;
  await assert.rejects(enqueueGoalTurn(session.id, owner, {}, { ...input,
    authorize: () => { if (!valid) throw new Error('Grant revoked'); },
    request: async () => { valid = false; return { execution: null, capabilities: {} }; },
  }), /Grant revoked/);
  assert.equal(listRecords('execution', { sessionId: session.id }).length, 0);
});

test('Codex ordinary and late native goal events cannot mutate a prior saved goal', () => {
  const session = goalSession(); session.goal.status = 'complete'; saveSession(session);
  const emitted = [], engine = new CodexEngine(BUILTINS.codex, session, {}, { event: (...event) => emitted.push(event) });
  const previous = structuredClone(session.goal), native = { goalId: 'old-native', status: 'complete', tokensUsed: 42 };
  engine.operation = { goal: false }; engine.goalArmed = true; engine.updateGoal(native);
  engine.operation = null; engine.updateGoal(native);
  assert.deepEqual(loadSession(session.id).goal, previous); assert.equal(emitted.length, 0);
  engine.operation = { goal: true }; engine.goalArmed = true; engine.updateGoal(native);
  assert.equal(loadSession(session.id).goal.status, 'verifying'); assert.equal(emitted.length, 1);
});

test('orphaned verification becomes reviewable without replay or reusing prior acceptance', () => {
  const session = goalSession(); session.goal.status = 'verifying'; session.executionState = 'verifying'; session.acceptance = { passed: true }; saveSession(session);
  putRecord('execution', 'queued', { id: 'queued', sessionId: session.id, state: 'queued' });
  assert.equal(recoverOrphanedVerification(session.id), false);
  putRecord('execution', 'queued', { id: 'queued', sessionId: session.id, state: 'finished' });
  assert.equal(recoverOrphanedVerification(session.id), true);
  assert.equal(loadSession(session.id).goal.status, 'awaiting_review'); assert.equal(loadSession(session.id).acceptance, null);
  assert.equal(loadSession(session.id).executionState, 'interrupted');
  assert.equal(recoverOrphanedVerification(session.id), false);
  assert.equal(listRecords('outbox').filter(item => item.event.type === 'goal.completed').length, 0);
  assert.equal(listRecords('outbox').filter(item => item.event.type === 'goal.stalled').length, 1);
});

test('task creation binds idempotency to the context and delays the goal until context finishes', () => {
  const options = { cwd: workspace, requestId: randomUUID() };
  const input = { goal: true, initialContext: 'Inspect these supplied project instructions first.', contextFileText: 'Respect the existing files.' };
  const first = createTaskSession(BUILTINS.codex, options, 'Assess the project', input);
  const repeated = createTaskSession(BUILTINS.codex, options, 'Assess the project', input);
  assert.equal(first.session.id, repeated.session.id); assert.equal(first.session.goal, null);
  assert.match(first.session.contract.context, /Respect the existing files/);
  assert.match(first.session.contract.context, /Inspect these supplied project instructions first/);
  assert.throws(() => createTaskSession(BUILTINS.codex, options, 'Assess the project', { ...input, contextFileText: 'Changed instructions.' }), /Idempotency conflict/);
  activateTaskGoal(first.session, options);
  assert.equal(loadSession(first.session.id).goal.objective, 'Assess the project');
  putRecord('execution', 'finished-fixture', { id: 'finished-fixture', sessionId: first.session.id, state: 'finished' });
  const plain = { cwd: workspace, requestId: randomUUID() };
  const original = createTaskSession(BUILTINS.codex, plain, 'Run once', { goal: false });
  putRecord('execution', 'other-fixture', { id: 'other-fixture', sessionId: original.session.id, state: 'finished' });
  assert.equal(createTaskSession(BUILTINS.codex, plain, 'Run once', { goal: false }).existingExecution, true);
});

test('new conversations copy selections while goals and transcripts stay in their original session', () => {
  const original = createChatSession(BUILTINS.codex, { cwd: workspace, model: 'fixture-brain', effort: 'high' });
  startConversationGoal(original, {}, 'First objective');
  const firstGoal = original.goal.id;
  appendEvent(original.id, 'text', { text: 'Private original conversation.' });
  startConversationGoal(original, {}, 'Second objective');
  assert.equal(getRecord('goal-history', firstGoal).supersededBy, original.goal.id);
  const fresh = newConversation(original, { cwd: workspace });
  assert.notEqual(fresh.id, original.id); assert.equal(fresh.model, original.model);
  assert.equal(fresh.selectedEffort, 'high'); assert.equal(fresh.goal, null);
  assert.equal(events(fresh.id).some(event => event.type === 'text'), false);
});

test('resuming saved work enforces the stored budget before starting a provider', () => {
  const session = goalSession(); session.goal.tokensUsed = 1000; saveSession(session);
  assert.throws(() => prepareResume(session, {}, true), /budget is exhausted/);
  const prepared = prepareResume(session, { tokenBudget: 2000 }, true);
  assert.equal(prepared.goal, true); assert.equal(prepared.session.goal.tokenBudget, 2000);
  assert.equal(listRecords('execution', { sessionId: session.id }).length, 0);
});
