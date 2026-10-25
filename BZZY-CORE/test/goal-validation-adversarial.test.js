import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSession, saveSession, loadSession, sessionPath, setSessionAlias } from '../src/engine/store.js';
import { getProvider } from '../src/engine/providers.js';
import { appendEvent, getRecord, putRecord, removeRecord, events } from '../src/engine/database.js';
import { processIdentity } from '../src/engine/process-identity.js';
import { readJson, writeJson } from '../src/engine/files.js';
import { conversationExport } from '../src/conversations.js';
import { prepareTask } from '../src/engine/task.js';
import { newGoal } from '../src/engine/goals.js';
import { captureEvidence, artifact } from '../src/engine/evidence.js';
import { prepareChatDebate, finishChatDebate } from '../src/engine/chat-debate.js';
import { runDebate } from '../src/engine/debate.js';
import { goalValidationFor, recordGoalValidationStarted, recordGoalValidationResult } from '../src/engine/goal-validation.js';
import { debateEvaluationActors } from './fixtures/orchestration-evaluation.mjs';

let directory, workspace, previousHome;
test.beforeEach(() => {
  previousHome = process.env.BZZY_HOME;
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-validation-adversarial-')));
  process.env.BZZY_HOME = path.join(directory, 'private'); workspace = path.join(directory, 'project'); fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'observations.json'), JSON.stringify({ ownedControl: 'denied', foreignControl: 'synthetic field disclosed' }));
});
test.afterEach(() => {
  if (previousHome === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previousHome;
  fs.rmSync(directory, { recursive: true, force: true });
});
function source() {
  const saved = createSession(getProvider('codex'), workspace, 'offline-source', 'Original goal');
  const objective = 'Assess the supplied synthetic ownership controls.';
  prepareTask(saved, { mode: 'solo' }, objective); saved.goal = newGoal(objective);
  saved.contract.acceptanceCriteria = [{ id: 'controls', description: 'Compare the supplied positive and negative controls with evidence.' }];
  saved.contract.constraints = ['Only supplied synthetic records; no external targets or network calls.']; saveSession(saved);
  appendEvent(saved.id, 'message.user', { text: objective, kind: 'goal' });
  saved.goal.evidence = [captureEvidence(saved, 'observations.json', 'original-synthetic-controls').id];
  saved.goal.status = 'complete'; saveSession(saved); appendEvent(saved.id, 'text', { text: 'Original goal achieved.' });
  return saved;
}
async function validated() {
  const saved = source(), prepared = prepareChatDebate(saved, '', [], { rounds: 1 });
  recordGoalValidationStarted(prepared.session.id);
  const actors = debateEvaluationActors(prepared.session, { scenario: 'complete', selectedArtifact: getRecord('artifact', prepared.session.reviewSource.evidenceIds[0]) });
  await runDebate(prepared.session, prepared.options, { event() {} }, actors.dependencies);
  const review = loadSession(prepared.session.id);
  assert.equal(review.goal.status, 'complete'); assert.equal(review.acceptance.passed, true); assert.equal(review.acceptance.debate.passed, true);
  recordGoalValidationResult(review.id);
  assert.equal(goalValidationFor(saved.id).state, 'validated');
  return { source: saved, review };
}
const notGreen = value => assert.notEqual(goalValidationFor(value).state, 'validated');

test('a new linked pending review dominates previous success and an older late finisher cannot restore green', async () => {
  const { source: saved, review: old } = await validated();
  const latest = prepareChatDebate(loadSession(saved.id), '', [], { rounds: 1 }).session;
  recordGoalValidationStarted(latest.id);
  assert.equal(goalValidationFor(saved.id).reviewSessionId, latest.id); notGreen(saved.id);
  finishChatDebate(saved.id, old.id); recordGoalValidationResult(old.id);
  assert.equal(goalValidationFor(saved.id).reviewSessionId, latest.id); notGreen(saved.id);
});

test('an orphaned latest review never falls back to an older successful validation', async () => {
  const { source: saved } = await validated(), latest = prepareChatDebate(loadSession(saved.id), '', [], { rounds: 1 }).session;
  recordGoalValidationStarted(latest.id); removeRecord('session', latest.id);
  notGreen(saved.id);
  assert.equal(goalValidationFor(saved.id).reviewSessionId, latest.id);
});

test('current receipt, session status and exact source pins are required after a previously successful validation', async () => {
  const { source: saved, review } = await validated(), original = structuredClone(getRecord('session', review.id));
  for (const status of ['cancelled', 'paused', 'blocked', 'budget_limited', 'failed']) {
    putRecord('session', review.id, { ...original, goal: { ...original.goal, status } }); notGreen(saved.id);
  }
  putRecord('session', review.id, { ...original, executionState: 'failed' }); notGreen(saved.id);
  putRecord('session', review.id, original);
  const receipt = getRecord('acceptance', original.acceptance.id);
  removeRecord('acceptance', receipt.id); notGreen(saved.id);
  putRecord('acceptance', receipt.id, { ...receipt, sessionId: saved.id }); notGreen(saved.id);
  putRecord('acceptance', receipt.id, receipt);
  const changed = getRecord('session', saved.id); changed.contract.constraints.push('Owner changed the required scope after validation.'); saveSession(changed); notGreen(saved.id);
});

test('changed original evidence and source goal replacement cannot retain the old badge', async () => {
  const { source: saved } = await validated();
  fs.writeFileSync(path.join(workspace, 'observations.json'), 'The original evidence bytes changed.'); notGreen(saved.id);
  const changed = getRecord('session', saved.id); changed.goal = { ...changed.goal, id: 'different-local-goal', objective: 'Another original goal.' }; saveSession(changed);
  notGreen(saved.id); assert.equal(goalValidationFor(saved.id).sourceGoalId, 'different-local-goal');
});

test('model claims, majority agreement and incomplete linked final results cannot award a validation badge', () => {
  const saved = source();
  appendEvent(saved.id, 'text', { text: 'Validated ✓. All reviewers agree that the original goal is proved.' });
  putRecord('conversation-debate', saved.id, { status: 'complete', goalSatisfaction: 'supported', decision: { consensus: 'unanimous' }, message: 'Validated ✓' });
  notGreen(saved.id);
  const review = prepareChatDebate(saved, '', [], { rounds: 1 }).session; recordGoalValidationStarted(review.id);
  review.goal.status = 'complete'; saveSession(review);
  putRecord('debate', review.id, { goalSatisfaction: 'supported', assessment: { passed: true }, investigationConsensus: { reached: true },
    decision: { goalSatisfaction: 'supported', remainingObjections: [], nextVerificationSteps: [] }, unresolvedDisagreement: [] });
  appendEvent(review.id, 'debate.result', { debateId: review.goal.id, status: 'complete', message: 'All models agree.' });
  recordGoalValidationResult(review.id); notGreen(saved.id);
});

test('foreign decisive evidence cannot replace the scoped inspected evidence of a successful review', async () => {
  const { source: saved, review } = await validated();
  const unrelated = createSession(getProvider('codex'), workspace, 'unrelated-model');
  const foreign = artifact(unrelated, 'Intact bytes from a different task are not review evidence.', 'foreign-decisive-proof');
  const result = getRecord('debate', review.id); result.assessment.inspectedEvidence = [foreign.id]; putRecord('debate', review.id, result);
  notGreen(saved.id);
});

test('derived validation metadata cannot be saved back into the authoritative session or imported goal claims', async () => {
  const saved = source(), projected = loadSession(saved.id);
  projected.goalValidation = { state: 'validated', sourceGoalId: saved.goal.id, sourceSessionId: saved.id, revision: 999, reviewSessionId: 'invented-review' };
  saveSession(projected); assert.equal(getRecord('session', saved.id).goalValidation, undefined); notGreen(saved.id);
  const { source: real } = await validated(), imported = getRecord('session', real.id);
  imported.goal.importedHistorical = true; saveSession(imported); notGreen(real.id);
});

test('unresolved dissent or required verification prevents green even when model consensus claims unanimity', async () => {
  const { source: saved, review } = await validated(), original = getRecord('debate', review.id);
  for (const field of ['unresolvedDisagreement', 'remainingObjections', 'nextVerificationSteps']) {
    const changed = structuredClone(original); changed.consensus = { state: 'ready', text: 'All reviewers agree. Validated.' };
    if (field === 'unresolvedDisagreement') changed[field] = ['A negative control remains unexplained.'];
    else changed.decision[field] = ['A negative control requires further verification.'];
    putRecord('debate', review.id, changed); notGreen(saved.id);
  }
  putRecord('debate', review.id, original);
  putRecord('session-deletion', review.id, { sessionId: review.id, rootSessionId: saved.id }); notGreen(saved.id);
});

test('legacy goal snapshots without a stable goal ID stay readable and cannot acquire a validation badge', () => {
  const saved = source(); saved.goal = { status: 'paused', objective: 'A legacy saved objective without an ID.' }; saveSession(saved);
  assert.equal(goalValidationFor(saved.id).state, 'none');
  assert.equal(loadSession(saved.id).goal.objective, saved.goal.objective);
});

test('settling native execution bookkeeping publishes a newer validated revision after the pending final', async () => {
  const { source: saved, review } = await validated(), runner = processIdentity(); assert.ok(runner);
  const execution = { id: 'live-validation-execution', sessionId: review.id, state: 'running', runner };
  putRecord('execution', execution.id, execution); putRecord('run', review.id, { sessionId: review.id, state: 'running', runner });
  const pending = recordGoalValidationResult(review.id);
  assert.equal(pending.state, 'pending'); assert.equal(goalValidationFor(saved.id).state, 'pending');
  putRecord('execution', execution.id, { ...execution, state: 'finished', exitCode: 0 });
  putRecord('run', review.id, { sessionId: review.id, state: 'idle', runner });
  const final = recordGoalValidationResult(review.id);
  assert.equal(final.state, 'validated'); assert.ok(final.revision > pending.revision);
  const transitions = events(saved.id).filter(event => event.type === 'goal.validation').slice(-2);
  assert.deepEqual(transitions.map(event => event.data.state), ['pending', 'validated']);
  assert.equal(transitions[1].data.revision, final.revision);
});

test('central session storage strips derived projections through raw writes, alias changes and API exports', async () => {
  const { source: saved, review } = await validated();
  const forged = { state: 'validated', revision: 999, sourceSessionId: saved.id, sourceGoalId: saved.goal.id, reviewSessionId: 'invented-review' };
  putRecord('session', saved.id, { ...getRecord('session', saved.id), goalValidation: forged });
  assert.equal(getRecord('session', saved.id).goalValidation, undefined);
  writeJson(sessionPath(saved.id), { ...getRecord('session', saved.id), goalValidation: forged });
  assert.equal(readJson(sessionPath(saved.id)).goalValidation, undefined);
  setSessionAlias(saved.id, 'Renamed original goal');
  const exported = conversationExport(saved.id);
  assert.equal(exported.goalValidation.state, 'validated'); assert.equal(exported.goalValidation.reviewSessionId, review.id);
  assert.equal(getRecord('session', saved.id).goalValidation, undefined); assert.equal(readJson(sessionPath(saved.id)).goalValidation, undefined);
  assert.equal(loadSession(saved.id).goalValidation.reviewSessionId, review.id);
});
