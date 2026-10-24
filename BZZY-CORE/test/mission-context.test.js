import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSession, saveSession } from '../src/engine/store.js';
import { BUILTINS } from '../src/engine/providers.js';
import { prepareTask } from '../src/engine/task.js';
import { newGoal } from '../src/engine/goals.js';
import { artifact } from '../src/engine/evidence.js';
import { appendEvent, getRecord, putRecord } from '../src/engine/database.js';
import { createMissionContext, missionContextCurrent, missionSourceRevision, missionResultRevision } from '../src/engine/mission-context.js';
import { prepareChatDebate } from '../src/engine/chat-debate.js';
import { assessCompletion, assessRequirement } from '../src/engine/verification.js';
import { randomUUID } from 'node:crypto';

let directory, previousHome, source;
test.beforeEach(() => {
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-mission-'))); previousHome = process.env.BZZY_HOME;
  process.env.BZZY_HOME = path.join(directory, 'private'); source = createSession(BUILTINS.codex, directory);
  prepareTask(source, { mode: 'delegate' }, 'Find a real High vulnerability with controlled impact evidence.');
  source.goal = newGoal(source.contract.objective); saveSession(source);
});
test.afterEach(() => { if (previousHome === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previousHome; fs.rmSync(directory, { recursive: true, force: true }); });

test('automatic mission preserves complete user instructions and pins new directives without treating token counters as changes', () => {
  const instructions = 'Use controlled comparisons and preserve negative results.\n'.repeat(2000);
  source.contract.context = instructions; saveSession(source);
  const record = createMissionContext(source); assert.equal(record.brief.instructions, instructions); assert.equal(missionContextCurrent(source, record), true);
  source.goal.tokensUsed += 100; source.goal.status = 'paused'; saveSession(source); assert.equal(missionContextCurrent(source, record), true);
  appendEvent(source.id, 'message.user', { text: 'Use only the supplied offline observations; the scope has narrowed.' });
  assert.equal(missionContextCurrent(source, record), false); assert.notEqual(missionSourceRevision(source), record.sourceRevision);
  assert.match(createMissionContext(source).brief.directives.at(-1).text, /scope has narrowed/);
});

test('independent brief excludes prior opinions and unrelated ledgers while retaining exact scope', () => {
  source.contract.scope = { allowedTargets: ['https://offline.example.test'], excludedActions: ['Modify accounts'] }; saveSession(source);
  putRecord('checkpoint', source.id, { sessionId: source.id, objective: source.goal.objective, updatedAt: new Date(Date.now() + 100).toISOString(), decisions: [{ decision: 'OTHER_MODEL_OPINION' }], unresolvedQuestions: ['Check the control.'] });
  const shared = createMissionContext(source); assert.equal(shared.brief.decisions.length, 1);
  const independent = createMissionContext(source, { independent: true }); assert.deepEqual(independent.brief.decisions, []);
  assert.equal(independent.brief.scope.allowedTargets[0], 'https://offline.example.test'); assert.doesNotMatch(JSON.stringify(independent), /OTHER_MODEL_OPINION/);
});

test('nested credential bindings are redacted before persistent mission publication', () => {
  source.contract.scope = { password: 'short-private', apiKey: 'another-private', metadata: { accessToken: 'nested-private' } };
  source.contract.context = 'password="quoted-private" and use the approved account gateway.'; saveSession(source);
  const record = createMissionContext(source); assert.equal(record.redacted, true);
  assert.doesNotMatch(JSON.stringify(getRecord('core.mission.context', record.id)), /short-private|another-private|nested-private|quoted-private/);
  assert.match(record.brief.instructions, /account gateway/);
});

test('missing or altered evidence and foreign artifact IDs cannot enter a mission', () => {
  const evidence = artifact(source, 'Controlled negative and positive observations.', 'controls');
  const record = createMissionContext(source, { evidenceIds: [evidence.id] }); assert.equal(missionContextCurrent(source, record), true);
  fs.writeFileSync(evidence.path, 'changed bytes'); assert.equal(missionContextCurrent(source, record), false);
  assert.throws(() => createMissionContext(source, { evidenceIds: [evidence.id] }), /altered|stale/);
  const other = path.join(directory, 'other'); fs.mkdirSync(other);
  const foreign = artifact(createSession(BUILTINS.codex, other), 'Other engagement', 'private');
  assert.throws(() => createMissionContext(source, { evidenceIds: [foreign.id] }), /outside/);
});

test('oversized mandatory context fails explicitly rather than publishing a truncated mission', () => {
  source.contract.context = 'x'.repeat(2 * 1024 * 1024); saveSession(source);
  assert.throws(() => createMissionContext(source), /not truncated/);
});

test('post-goal review selects that achieved result even after the owner has a later casual conversation', () => {
  appendEvent(source.id, 'message.user', { text: source.goal.objective, kind: 'goal' });
  appendEvent(source.id, 'text', { text: 'ACHIEVED_CLAIM_WITH_CONTROLLED_IMPACT' });
  const proof = artifact(source, 'Controlled impact evidence', 'decisive-proof'); source.goal.evidence = [proof.id];
  source.goal.status = 'complete'; saveSession(source);
  const revision = missionResultRevision(source);
  appendEvent(source.id, 'message.user', { text: 'PRIVATE_POST_GOAL_NOTE. What is your name?', kind: 'chat' });
  appendEvent(source.id, 'text', { text: 'LATER_CASUAL_REPLY' });
  source.summary = { finishedAt: new Date().toISOString(), usage: { totalTokens: 999 } }; saveSession(source);
  assert.equal(missionResultRevision(source), revision);
  const review = prepareChatDebate(source, '', ['claude']);
  const selected = JSON.parse(fs.readFileSync(getRecord('artifact', review.options.artifact).path, 'utf8'));
  assert.equal(selected.originalGoal.objective, source.goal.objective);
  assert.equal(selected.achievedClaim, 'ACHIEVED_CLAIM_WITH_CONTROLLED_IMPACT');
  assert.doesNotMatch(selected.achievedClaim, /LATER_CASUAL_REPLY/);
  assert.equal(selected.evidence.length, 1);
  const originalMission = getRecord('core.mission.context', review.session.reviewSource.missionContextId);
  assert.doesNotMatch(JSON.stringify(originalMission.brief), /PRIVATE_POST_GOAL_NOTE/);
});

test('an imported achieved goal cannot authorize verification commands or targets through a linked review', () => {
  source.goal.status = 'complete'; source.goal.importedHistorical = true;
  source.contract.verification = [{ id: 'unreviewed', argv: ['/bin/sh', '-c', 'exit 99'] }]; saveSession(source);
  assert.throws(() => prepareChatDebate(source, '', ['claude']), /imported history.*reviewed scope/);
});

test('declining missing worker context needs explicit parent proof while still permitting an evidence-backed takeover', async () => {
  const id = randomUUID();
  putRecord('assignment', id, { id, parentSessionId: source.id, goalId: source.goal.id, role: 'executor', closure: 'abandoned' });
  putRecord('assignment-context', id, { id, sessionId: source.id, sourceGoalId: source.goal.id, state: 'declined' });
  const unresolved = await assessCompletion(source); assert.equal(unresolved.passed, false); assert.match(unresolved.delegation.reason, /Declining/);
  const evidence = artifact(source, 'An independent controlled observation establishes the required impact.', 'brain-takeover-proof');
  assessRequirement(source, { id: 'objective', status: 'supported', rationale: 'The supervisor independently obtained the required controlled proof after declining the unavailable worker path.', evidence: [evidence.id] });
  const completed = await assessCompletion(source); assert.equal(completed.passed, true);
});
