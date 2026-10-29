import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSession, saveSession } from '../src/engine/store.js';
import { getProvider } from '../src/engine/providers.js';
import { projectIdentityForSession } from '../src/engine/project-identity.js';
import { database, getRecord, putRecord, listRecords, appendEvent, digest } from '../src/engine/database.js';
import { createSkill, setSkillEnabled, inspectSkill, inspectSkillCandidate } from '../src/engine/skills.js';
import { queueLearningReview, processLearningReviews } from '../src/engine/learning.js';
import { registerLearningFixtures, revokeLearningFixtures } from '../src/engine/learning-evaluation.js';
import { stageLearningSkillUpdates } from '../src/engine/skill-updates.js';
import { configureSkillEvolution, skillEvolutionSettings } from '../src/engine/skill-evolution-policy.js';
import { processSkillEvolution } from '../src/engine/skill-evolution-runner.js';
import { assertHeldOutSources } from '../src/engine/learning-fixture-contract.js';
import { ToolHost } from '../src/engine/tools.js';
import { newGoal } from '../src/engine/goals.js';

let directory, prior, session, skill, receipt, semantic, continuation, semanticCases, continuationCases;
test.beforeEach(async () => {
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-auto-evolution-')));
  prior = process.env.BZZY_HOME; process.env.BZZY_HOME = path.join(directory, 'private');
  const cwd = path.join(directory, 'project'); fs.mkdirSync(cwd);
  session = createSession(getProvider('codex'), cwd, 'offline-fixture'); session.projectRoot = cwd;
  projectIdentityForSession(session, { create: true }); saveSession(session);
  const created = createSkill({ name: 'controlled-method', description: 'Continue only with decisive controls.',
    instructions: 'Compare authorized positive and negative observations. Preserve uncertainty when evidence is missing.' }, { session });
  skill = setSkillEnabled(created.id, true, created.revision, { session });
  const context = { runId: randomUUID(), goalMode: false };
  session.executionState = 'running'; saveSession(session);
  putRecord('run', session.id, { id: context.runId, sessionId: session.id, state: 'running', goalMode: false });
  await new ToolHost(session, { event() {} }, context).call('read_skill', { name: skill.id });
  const event = appendEvent(session.id, 'message.user', { text: 'A fictional training case requires checking the original observation.' });
  const job = queueLearningReview(session, { reason: 'explicit', sourceId: event.id, runId: context.runId, goalMode: false });
  putRecord('core.learning.job', job.id, { ...getRecord('core.learning.job', job.id), state: 'running' });
  const packet = getRecord('core.learning.packet', job.packetId), base = packet.skills[0];
  [receipt] = stageLearningSkillUpdates(session, [{ skillId: skill.id, baseVersion: skill.version, baseRevision: skill.revision,
    rationale: 'Preserve the original observation.', sourceIds: [base.sourceId],
    ops: [{ op: 'append_section', heading: 'Original observation', text: 'Read the original observation before selecting the next authorized action.' }] }], { jobId: job.id, packet });
  putRecord('core.learning.job', job.id, { ...getRecord('core.learning.job', job.id), state: 'completed' });
  session.executionState = 'idle'; saveSession(session);
  putRecord('run', session.id, { id: context.runId, sessionId: session.id, state: 'completed', goalMode: false });
  semanticCases = ['real', 'false_positive', 'inconclusive'].map((expected, index) => ({ id: `s${index}`, sourceGroup: `heldout-s${index}`,
    observations: `Independent safety observation ${index}.`, expected }));
  continuationCases = ['completed', 'blocked', 'inconclusive'].map((expected, index) => ({ id: `c${index}`, sourceGroup: `heldout-c${index}`,
    observations: `Independent continuation ${index}.`, expected,
    world: { start: 'start', states: [{ id: 'start', observation: 'An original observation is available.', actions: [{ id: `inspect${index}`, next: 'end', description: 'Inspect the original observation.' }] },
      { id: 'end', observation: 'Stop at the observed outcome.', actions: [] }] },
    acceptance: { endState: 'end', requiredActions: [`inspect${index}`], forbiddenActions: [] } }));
  semantic = registerLearningFixtures({ name: 'Reviewed safety', cases: semanticCases }, { session, reviewed: true });
  continuation = registerLearningFixtures({ name: 'Reviewed continuation', contract: 'continuation-trace-v1', cases: continuationCases }, { session, reviewed: true });
});
test.afterEach(() => {
  if (prior === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = prior;
  fs.rmSync(directory, { recursive: true, force: true });
});
const enable = () => configureSkillEvolution({ updates: 'auto', updateEvaluation: { semanticDatasetId: semantic.id,
  continuationDatasetId: continuation.id } }, { expectedRevision: skillEvolutionSettings().revision, reviewed: true });

test('revoked automatic policy or fixtures cannot dispatch a second paid comparison arm', async () => {
  enable(); processSkillEvolution(); let calls = 0;
  const [result] = await processLearningReviews({ runReview: async () => {
    calls++;
    configureSkillEvolution({ updates: 'off' }, { expectedRevision: skillEvolutionSettings().revision, reviewed: true });
    return { tokens: 20, text: JSON.stringify({ results: semanticCases.map(item => ({ id: item.id, verdict: item.expected })) }) };
  } });
  assert.equal(calls, 1); assert.equal(result.state, 'paused');
  assert.equal(inspectSkill(skill.id, { session }).version, skill.version);
});

test('fixture revocation between comparison arms prevents further inference', async () => {
  enable(); processSkillEvolution(); let calls = 0;
  const [result] = await processLearningReviews({ runReview: async () => {
    calls++; revokeLearningFixtures(semantic.id, { session, expectedRevision: semantic.revision });
    return { tokens: 20, text: JSON.stringify({ results: semanticCases.map(item => ({ id: item.id, verdict: item.expected })) }) };
  } });
  assert.equal(calls, 1); assert.notEqual(result.state, 'completed');
  assert.equal(inspectSkill(skill.id, { session }).version, skill.version);
});
async function dispatch(phase, { improve = true } = {}) {
  let calls = 0;
  const result = await processLearningReviews({ runReview: async () => {
    const candidate = ++calls === 1;
    return { tokens: 20, text: JSON.stringify({ results: (phase === 'semantic' ? semanticCases : continuationCases).map((item, index) => ({ id: item.id,
      ...(phase === 'semantic' ? { verdict: item.expected } : { actions: candidate || !improve ? [`inspect${index}`] : [] }) })) }) };
  } });
  assert.equal(result.length, 1); assert.equal(result[0].state, 'completed'); assert.equal(calls, 2); return result[0];
}
async function ready(options) {
  enable(); assert.equal(processSkillEvolution()[0].state, 'semantic-queued');
  await dispatch('semantic'); assert.equal(processSkillEvolution()[0].state, 'continuation-queued');
  await dispatch('continuation', options); return processSkillEvolution()[0];
}

test('automatic updates require a reviewed exact fixture pair; default stays staged', () => {
  assert.deepEqual(processSkillEvolution(), []);
  assert.throws(() => configureSkillEvolution({ updates: 'auto' }, { expectedRevision: 0, reviewed: true }), /fixtures/);
  assert.throws(() => configureSkillEvolution({ updates: 'auto', updateEvaluation: { semanticDatasetId: continuation.id, continuationDatasetId: semantic.id } },
    { expectedRevision: 0, reviewed: true }), /contracts/);
  const policy = enable(); assert.equal(policy.newSkills, 'stage'); assert.equal(policy.updateEvaluation.semantic.hash, semantic.hash);
  revokeLearningFixtures(continuation.id, { session, expectedRevision: continuation.revision });
  assert.equal(processSkillEvolution()[0].state, 'review-needed');
  assert.doesNotThrow(() => configureSkillEvolution({ updates: 'off' }, { expectedRevision: policy.revision, reviewed: true }), 'Revocation must not prevent opting out.');
});

test('one phase per pump reuses existing jobs and accepts only independently improved exact updates', async () => {
  const state = await ready(); assert.equal(state.state, 'activation-ready');
  const candidate = inspectSkillCandidate(receipt.candidateId, { session });
  assert.ok(candidate.evaluation); assert.ok(candidate.behaviorEvaluation);
  assert.equal(inspectSkill(skill.id, { session }).version, skill.version);
  const result = processSkillEvolution(); assert.equal(result[0].state, 'activated');
  const active = inspectSkill(skill.id, { session }); assert.equal(active.version, candidate.version);
  assert.equal(active.review.automaticUpdate.policyRevision, 1);
  assert.equal(active.review.automaticUpdate.sourcePacketHash, digest(getRecord('core.learning.packet', receipt.packetId)));
  assert.deepEqual(processSkillEvolution(), []);
  assert.equal(listRecords('core.learning.job').filter(job => job.reason === 'evaluation').length, 2);
  assert.equal(listRecords('core.skill').length, 1);
});

test('equal behavior, current workflow pins and owner OFF retain staged review', async () => {
  assert.equal((await ready({ improve: false })).reason, 'behavioral-improvement-not-demonstrated');
  assert.equal(inspectSkill(skill.id, { session }).version, skill.version);
});

test('active version pins stop automatic selection after passing evaluation', async () => {
  assert.equal((await ready()).state, 'activation-ready');
  session.goal = newGoal('Use the admitted procedure.'); saveSession(session);
  putRecord('core.workflow.work-unit', 'pinned-method', { id: 'pinned-method', sessionId: session.id,
    goalId: session.goal.id, state: 'open', skills: [{ id: skill.id, version: skill.version }] });
  assert.equal(processSkillEvolution()[0].reason, 'active-version-pins');
  assert.equal(inspectSkill(skill.id, { session }).version, skill.version);
});

test('disabling an active base never reenables it through an evaluated automatic update', async () => {
  await ready(); setSkillEnabled(skill.id, false, skill.revision, { session });
  assert.equal(processSkillEvolution()[0].reason, 'active-base-changed');
  assert.equal(inspectSkill(skill.id, { session }).enabled, false);
});

test('a changed evolution policy rejects already queued automatic evaluation before model dispatch', async () => {
  enable(); processSkillEvolution();
  configureSkillEvolution({ updates: 'off' }, { expectedRevision: 1, reviewed: true });
  const result = await processLearningReviews({ runReview: async () => assert.fail('A stale auto policy cannot dispatch.') });
  assert.equal(result[0].state, 'paused'); assert.equal(result[0].error, 'LEARNING_SCOPE'); assert.deepEqual(processSkillEvolution(), []);
});

test('uncertain evaluations require review and are never queued again', () => {
  enable(); const queued = processSkillEvolution()[0], job = getRecord('core.learning.job', queued.semanticJobId);
  putRecord('core.learning.job', job.id, { ...job, state: 'paused', reasonPaused: 'uncertain_outcome', reviewStarted: true, dispatchedAt: new Date().toISOString() });
  assert.equal(processSkillEvolution()[0].reason, 'evaluation-requires-review');
  assert.deepEqual(processSkillEvolution(), []);
  assert.equal(listRecords('core.learning.job').filter(item => item.reason === 'evaluation').length, 1);
  configureSkillEvolution({ updates: 'stage' }, { expectedRevision: 1, reviewed: true });
  enable();
  assert.equal(processSkillEvolution()[0].reason, 'prior-evaluation-requires-review', 'A policy revision cannot authorize replaying an uncertain request.');
  assert.equal(listRecords('core.learning.job').filter(item => item.reason === 'evaluation').length, 1);
});

test('unchanged pending polls do not write receipts or queue duplicate reviews', () => {
  enable(); processSkillEvolution();
  const before = database().prepare('SELECT total_changes() AS count').get().count;
  for (let index = 0; index < 10; index++) assert.deepEqual(processSkillEvolution(), []);
  assert.equal(database().prepare('SELECT total_changes() AS count').get().count, before);
  assert.equal(listRecords('core.learning.job').filter(item => item.reason === 'evaluation').length, 1);
});

test('saved evaluation requests recover a missing phase receipt without replay after candidate binding', async () => {
  enable(); const queued = processSkillEvolution()[0]; await dispatch('semantic');
  putRecord('core.skill.update', receipt.id, receipt);
  const recovered = processSkillEvolution()[0];
  assert.equal(recovered.state, 'semantic-queued'); assert.equal(recovered.semanticJobId, queued.semanticJobId);
  assert.equal(processSkillEvolution()[0].state, 'continuation-queued');
  assert.equal(listRecords('core.learning.job').filter(item => item.reason === 'evaluation').length, 2);
});

test('automatic update approval cannot create a new skill or publish globally', () => {
  enable(); const candidate = getRecord('core.skill.candidate', receipt.candidateId);
  putRecord('core.skill.candidate', candidate.id, { ...candidate, scope: 'global' });
  assert.equal(processSkillEvolution()[0].reason, 'source-candidate-mismatch');
  assert.equal(listRecords('core.learning.job').filter(item => item.reason === 'evaluation').length, 0);
  assert.equal(listRecords('core.skill').length, 1);
});

test('held-out checks include session provenance and packet sources; unknown provenance cannot demonstrate independence', () => {
  const plain = { version: 'fictional', provenance: { sourceSessionId: 'training-session' } };
  const data = { sourceGroups: ['training-session:42'], cases: [{ sourceGroup: 'training-session:42' }] };
  assert.throws(() => assertHeldOutSources(plain, data), /separate from the authoring episode/);
  const external = { sourceGroups: ['heldout-independent'], cases: [{ sourceGroup: 'heldout-independent' }] };
  assert.equal(assertHeldOutSources({}, external).status, 'unknown');
  assert.equal(assertHeldOutSources(plain, external).status, 'independent');
  const learned = getRecord('core.skill.candidate', receipt.candidateId), packet = getRecord('core.learning.packet', receipt.packetId);
  const changed = { ...learned, update: { ...learned.update, sourceGroups: [], sourceIds: [] } };
  assert.throws(() => assertHeldOutSources(changed, { sourceGroups: [packet.runId], cases: [{ sourceGroup: packet.runId }] }), /separate from the authoring episode/);
});
