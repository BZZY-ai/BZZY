import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSession, saveSession, loadSession } from '../src/store.js';
import { BUILTINS } from '../src/providers.js';
import { prepareTask } from '../src/task.js';
import { agentInstructions, reasoningEffort } from '../src/instructions.js';
import { appendEvent, getRecord, putRecord } from '../src/database.js';
import { latestReply, prepareChatDebate, finishChatDebate } from '../src/chat-debate.js';

let directory, originalHome;
test.beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-chat-'));
  originalHome = process.env.BZZY_HOME; process.env.BZZY_HOME = path.join(directory, 'private');
});
test.afterEach(() => {
  if (originalHome == null) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = originalHome;
  fs.rmSync(directory, { recursive: true, force: true });
});

test('ordinary chat avoids the goal audit while explicit goals retain durable context and native effort', () => {
  const session = createSession(BUILTINS.codex, directory);
  prepareTask(session, {}, 'hi');
  putRecord('checkpoint', session.id, { completedWork: ['A large previous investigation'], pendingActions: ['Do not pursue this from a greeting'] });
  const chat = agentInstructions(session);
  assert.match(chat, /Present yourself as bzzy/);
  assert.match(chat, /Do not create files just to answer small talk/);
  assert.doesNotMatch(chat, /A large previous investigation/);
  session.mode = 'delegate';
  assert.doesNotMatch(agentInstructions(session), /YOU ARE THE SUPERVISOR/);
  assert.equal(reasoningEffort(session), 'medium');
  const goal = agentInstructions(session, { goalMode: true });
  assert.match(goal, /A large previous investigation/);
  assert.match(goal, /assess explicit acceptance criteria/);
  assert.equal(reasoningEffort(session, { goalMode: true }), undefined);
  assert.equal(reasoningEffort(session, { goalMode: true, effort: 'high' }), 'high');
  session.role = 'executor';
  assert.equal(reasoningEffort(session), undefined);
});

test('besties instructions require visible evidence exchange and mutual review only during goal work', () => {
  const session = createSession(BUILTINS.codex, directory);
  prepareTask(session, { mode: 'besties', besties: [{ provider: 'codex' }, { provider: 'claude' }] }, 'Verify the supplied challenge');
  assert.doesNotMatch(agentInstructions(session), /TWO EQUAL COLLABORATORS/);
  session.role = 'bestie'; session.bestiesSessionId = session.id;
  const instructions = agentInstructions(session, { goalMode: true });
  assert.match(instructions, /TWO EQUAL COLLABORATORS/);
  assert.match(instructions, /Read peer_inbox/);
  assert.match(instructions, /mutually support current evidence/);
  assert.match(instructions, /Do not expose private chain-of-thought/);
});

test('debating a chat freezes the final reply without replacing the original thread or permissions', () => {
  const source = createSession(BUILTINS.codex, directory);
  prepareTask(source, { readOnly: true }, 'Inspect supplied code');
  source.engineThreadId = 'original-native-thread';
  source.contract.constraints = ['Keep the original source intact'];
  source.contract.scope = { allowedTargets: ['https://approved.example'], excludedActions: ['Modify accounts'] };
  source.contract.limits.runtimeSeconds = 60;
  saveSession(source);
  appendEvent(source.id, 'message.user', { text: 'Is the ownership check correct?' });
  appendEvent(source.id, 'text', { text: 'Looking at the supplied code.\n', itemId: 'commentary' });
  appendEvent(source.id, 'text', { text: 'The ownership claim is unverified.', itemId: 'final' });
  appendEvent(source.id, 'backend', { method: 'item/completed', params: { item: { type: 'agentMessage', phase: 'final', text: 'The ownership claim is unverified.' } } });
  const debate = prepareChatDebate(source, 'Validate the evidence', ['claude'], { runtimeSeconds: 90 });
  assert.notEqual(debate.session.id, source.id);
  assert.equal(loadSession(source.id).engineThreadId, 'original-native-thread');
  assert.equal(loadSession(source.id).goal, null);
  assert.equal(debate.session.parentSessionId, source.id);
  assert.equal(debate.session.goal.objective, 'Validate the evidence');
  assert.equal(debate.options.rounds, 5);
  assert.equal(debate.session.policy.mode, 'read-only');
  assert.deepEqual(debate.session.contract.scope, source.contract.scope);
  assert.ok(debate.session.contract.constraints.includes('Keep the original source intact'));
  assert.equal(debate.session.contract.limits.runtimeSeconds, 60);
  const selected = getRecord('artifact', debate.options.artifact);
  assert.match(fs.readFileSync(selected.path, 'utf8'), /ASSISTANT REPLY\nThe ownership claim is unverified/);
  assert.doesNotMatch(fs.readFileSync(selected.path, 'utf8'), /Looking at/);
  assert.equal(latestReply(source.id).text, 'The ownership claim is unverified.');
  const decision = { acceptedConclusions: [], rejectedClaims: [], corrections: [], remainingObjections: ['Needs independent evidence'], nextVerificationSteps: [] };
  putRecord('debate', debate.session.id, { decision, unresolvedDisagreement: decision.remainingObjections });
  debate.session.goal.status = 'awaiting_review'; saveSession(debate.session);
  finishChatDebate(source.id, debate.session.id);
  assert.match(agentInstructions(source), /Needs independent evidence/);
  assert.equal(loadSession(source.id).engineThreadId, 'original-native-thread');
});

test('a new unanswered message cannot accidentally debate an older reply', () => {
  const source = createSession(BUILTINS.codex, directory);
  appendEvent(source.id, 'message.user', { text: 'First question' });
  appendEvent(source.id, 'text', { text: 'First answer' });
  appendEvent(source.id, 'message.user', { text: 'New question, still waiting' });
  assert.throws(() => latestReply(source.id), /no assistant reply/i);
});
