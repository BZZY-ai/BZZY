import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSession, loadSession, saveSession } from '../src/engine/store.js';
import { BUILTINS } from '../src/engine/providers.js';
import { appendEvent, events, getRecord, putRecord, listRecords } from '../src/engine/database.js';
import { claimInput } from '../src/engine/runtime.js';
import { prepareTask } from '../src/engine/task.js';
import { newGoal } from '../src/engine/goals.js';
import { enqueueGoalTurn, updateIdleGoal, setSessionModel, setSessionProvider } from '../src/engine/session-operations.js';
import { createTaskSession, activateTaskGoal, createChatSession, newConversation, startConversationGoal, prepareResume } from '../src/engine/host-commands.js';

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
