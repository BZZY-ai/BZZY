import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSession, saveSession } from '../src/engine/store.js';
import { getProvider } from '../src/engine/providers.js';
import { projectIdentityForSession } from '../src/engine/project-identity.js';
import { newGoal } from '../src/engine/goals.js';
import { database, appendEvent, getRecord, putRecord, listRecords, digest } from '../src/engine/database.js';
import { createSkill, importSkill, inspectSkill, readSkill, setSkillEnabled, deleteSkill, publishLearnedSkill,
  inspectSkillCandidate, readSkillCandidate, acceptSkillCandidate, activeSkillVersionPins, stageSkillCandidate } from '../src/engine/skills.js';
import { skillEvolutionSettings, configureSkillEvolution } from '../src/engine/skill-evolution-policy.js';
import { submitSkillFeedback, captureSkillOutcomes } from '../src/engine/skill-feedback.js';
import { snapshotLearningSkills, stageLearningSkillUpdates } from '../src/engine/skill-updates.js';
import { inspectSkillEvolution, suggestSkillCuration, curateSkill } from '../src/engine/skill-curation.js';
import { ToolHost } from '../src/engine/tools.js';
import { sessionMetrics } from '../src/engine/session-metrics.js';
import { queueLearningReview } from '../src/engine/learning.js';
import { registerLearningFixtures, evaluateLearningCandidate, inspectLearningEvaluation } from '../src/engine/learning-evaluation.js';

let root, previous, session;
test.beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-skill-evolution-')));
  previous = process.env.BZZY_HOME; process.env.BZZY_HOME = path.join(root, 'private');
  const cwd = path.join(root, 'project'); fs.mkdirSync(cwd);
  session = createSession(getProvider('codex'), cwd, 'offline-fixture-model'); session.projectRoot = cwd;
  projectIdentityForSession(session, { create: true }); saveSession(session);
});
test.afterEach(() => {
  if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
  fs.rmSync(root, { recursive: true, force: true });
});
function method(name = 'safe-review') {
  const value = createSkill({ name, description: 'Review controlled observations with decisive baselines.',
    instructions: 'Compare positive and negative controls. Require verified ownership and repeatable evidence. Keep missing proof inconclusive.' }, { session });
  return setSkillEnabled(value.id, true, value.revision, { session });
}
function liveHost() {
  const context = { runId: randomUUID(), goalMode: false };
  session.executionState = 'running'; saveSession(session);
  putRecord('run', session.id, { id: context.runId, sessionId: session.id, state: 'running', goalMode: false });
  return { context, host: new ToolHost(session, { event() {} }, context) };
}
async function sourcePacket(skill) {
  const { host, context } = liveHost();
  await host.call('read_skill', { name: skill.id });
  const event = appendEvent(session.id, 'message.user', { text: 'Capture the controlled procedure correction.' });
  const job = queueLearningReview(session, { reason: 'explicit', sourceId: event.id, runId: context.runId, goalMode: false });
  putRecord('core.learning.job', job.id, { ...getRecord('core.learning.job', job.id), state: 'running' });
  const packet = getRecord('core.learning.packet', job.packetId);
  assert.equal(packet.skills.length, 1);
  const base = packet.skills[0];
  const update = { skillId: skill.id, baseVersion: base.version, baseRevision: base.revision,
    rationale: 'Explain the missing control without changing permissions.', sourceIds: [base.sourceId],
    ops: [{ op: 'append_section', heading: 'Missing observation', text: 'Record unavailable proof as inconclusive and identify the missing control.' }] };
  return { context, packet, job, update, options: { jobId: job.id, packet } };
}
const definition = (name, instructions = 'Compare ownership and authorized versus unauthorized baselines. Keep missing proof inconclusive.') => ({ name, description: 'Controlled authorization procedure.', instructions });
const publication = (value, requestId) => publishLearnedSkill(value, { session, requestId,
  provenance: { kind: 'learning', jobId: randomUUID(), sourceSessionId: session.id } });
function automatic() { configureSkillEvolution({ newSkills: 'auto' }, { expectedRevision: 0, reviewed: true }); }
function fixtures(sourceGroup = 'held-out') { return { name: 'Approved offline controls', cases: [
  { id: 'positive', observations: 'Controlled unrelated account repeatedly read a verified private owned resource.', expected: 'real', sourceGroup: `${sourceGroup}:positive` },
  { id: 'negative', observations: 'Controlled role tests withheld the private resource; scanner matched only a public login form.', expected: 'false_positive', sourceGroup: `${sourceGroup}:negative` },
  { id: 'unknown', observations: 'Authentication was unavailable, so no ownership comparison was possible.', expected: 'inconclusive', sourceGroup: `${sourceGroup}:unknown` },
] }; }
const verdictOutput = definition => ({ tokens: 20, text: JSON.stringify({ results: definition.cases.map(item => ({ id: item.id, verdict: item.expected })) }) });
async function evaluated(candidateId, definition = fixtures()) {
  const staged = getRecord('core.skill.candidate', candidateId);
  const sourceJob = staged?.provenance?.jobId && getRecord('core.learning.job', staged.provenance.jobId);
  // sourcePacket simulates the publication phase of a running review. Its
  // staged candidate now exists; finish that synthetic generation operation
  // before asking the separate evaluator to acquire maintenance capacity.
  if (sourceJob?.state === 'running') putRecord('core.learning.job', sourceJob.id, { ...sourceJob, state: 'completed' });
  session.executionState = 'idle'; saveSession(session);
  const candidate = inspectSkillCandidate(candidateId, { session });
  const dataset = registerLearningFixtures(definition, { session, reviewed: true });
  const result = await evaluateLearningCandidate(candidateId, { session, datasetId: dataset.id, expectedRevision: candidate.revision,
    runReview: async () => verdictOutput(definition) });
  assert.equal(result.state, 'completed'); return inspectSkillCandidate(candidateId, { session });
}
function accept(candidate) { return acceptSkillCandidate(candidate.id, { expectedRevision: candidate.revision,
  expectedSkillRevision: candidate.baseRevision, expectedEvaluationId: candidate.evaluation.id, reviewed: true }, { session }); }

test('new learning defaults to staged review, exact duplicates coalesce and explicit auto never reenables owner OFF', () => {
  assert.equal(skillEvolutionSettings().newSkills, 'stage');
  const a = publication(definition('controlled-a'), 'a'), b = publication(definition('controlled-b'), 'b');
  assert.equal(a.state, 'staged'); assert.equal(b.state, 'staged-reused'); assert.equal(a.candidateId, b.candidateId);
  assert.equal(listRecords('core.skill').length, 0); assert.equal(listRecords('core.skill.candidate').length, 1);
  configureSkillEvolution({ newSkills: 'auto' }, { expectedRevision: 0, reviewed: true });
  const reused = publication(definition('controlled-c'), 'c'); assert.equal(reused.candidateId, a.candidateId);
  const actual = publication(definition('different-method', 'Require a single-use local fixture with an independently owned account.'), 'different');
  assert.equal(actual.state, 'published');
  const enabled = inspectSkill(actual.skillId, { session }); setSkillEnabled(enabled.id, false, enabled.revision, { session });
  const duplicate = publication(definition('another-name', 'Require a single-use local fixture with an independently owned account.'), 'duplicate');
  assert.equal(duplicate.state, 'reused'); assert.equal(duplicate.skillId, actual.skillId); assert.equal(inspectSkill(actual.skillId, { session }).enabled, false);
  assert.throws(() => configureSkillEvolution({ newSkills: 'off' }, { expectedRevision: 0, reviewed: true }), /changed/);
  configureSkillEvolution({ newSkills: 'off' }, { expectedRevision: 1, reviewed: true });
  assert.equal(publication(definition('disabled-creation'), 'off').state, 'off');
});

test('near-identical methods with different prerequisites remain distinct and receive advisory suggestions only', () => {
  automatic();
  const common = 'Compare positive negative authenticated anonymous controls ownership reproducibility latency content authentication authorization resources evidence response status session isolation request identifiers handling retries cache boundaries.';
  const a = publication(definition('tenant-a', common + ' Prerequisite: tenant-owner role.'), 'tenant-a');
  const b = publication(definition('tenant-b', common + ' Prerequisite: delegated-admin role.'), 'tenant-b');
  assert.notEqual(a.skillId, b.skillId); assert.equal(listRecords('core.skill').length, 2);
  const before = listRecords('core.skill').map(digest);
  const suggestions = suggestSkillCuration({ session }); assert.equal(suggestions.automaticChanges, 0); assert.ok(suggestions.suggestions.length);
  assert.deepEqual(listRecords('core.skill').map(digest), before);
});

test('feedback requires full exact-version current-run loads, scoped evidence and cannot administer resources', async () => {
  const skill = method(), { host, context } = liveHost();
  await host.call('read_skill', { name: skill.id, limit: 32 });
  const use = listRecords('core.usage')[0];
  const input = { usageId: use.id, requestId: 'feedback-1', kind: 'missing_step', rationale: 'The prerequisite needs a negative control.' };
  assert.throws(() => submitSkillFeedback(session, input, context), /complete skill/);
  await host.call('read_skill', { name: skill.id });
  const feedback = submitSkillFeedback(session, input, context);
  assert.equal(feedback.state, 'proposed'); assert.deepEqual(submitSkillFeedback(session, input, context), feedback);
  assert.throws(() => submitSkillFeedback(session, { ...input, rationale: 'Changed replay.' }, context), /conflicts/);
  assert.throws(() => submitSkillFeedback(session, { ...input, requestId: 'admin', enabled: false }, context), /Invalid/);
  assert.throws(() => submitSkillFeedback(session, { ...input, requestId: 'foreign', evidence: [randomUUID()] }, context), /outside/);
  assert.throws(() => submitSkillFeedback(session, { ...input, requestId: 'secret', proposedText: 'password=private-fixture-secret' }, context), /credentials/);
  setSkillEnabled(skill.id, false, skill.revision, { session });
  assert.throws(() => submitSkillFeedback(session, { ...input, requestId: 'disabled' }, context), /disabled/);
  assert.equal(listRecords('core.skill.feedback').length, 1);
});

test('outcome associations are append-only and do not change usage receipts or metric counts', async () => {
  const skill = method(), { host, context } = liveHost(); await host.call('read_skill', { name: skill.id });
  const use = listRecords('core.usage')[0], before = digest(use);
  assert.equal(captureSkillOutcomes(session, context.runId).deferred, true);
  putRecord('run', session.id, { id: context.runId, sessionId: session.id, state: 'completed', goalMode: false });
  assert.equal(captureSkillOutcomes(session, context.runId).recorded, 1);
  assert.equal(captureSkillOutcomes(session, context.runId).recorded, 0);
  assert.equal(digest(getRecord('core.usage', use.id)), before); assert.equal(sessionMetrics(session.id).session.skillInvocations, 1);
  assert.equal(listRecords('core.skill.outcome').length, 1);
  assert.match(listRecords('core.skill.outcome')[0].attribution, /unverified/);
  assert.equal(inspectSkillEvolution(skill.id, { session }).outcomes.length, 1);
});

test('automatic updates stage exact text, preserve scripts/assets, retry idempotently and never change active version', async () => {
  const source = path.join(root, 'package'); fs.mkdirSync(path.join(source, 'scripts'), { recursive: true });
  const policy = fs.readFileSync(new URL('../assets/generation-security.txt', import.meta.url), 'utf8');
  fs.writeFileSync(path.join(source, 'SKILL.md'), `---\nname: packaged-method\ndescription: Offline fixture method.\n---\nKeep missing proof inconclusive.\n\n${policy}`);
  fs.writeFileSync(path.join(source, 'scripts', 'check.js'), 'export const onlyFixture = true;');
  const imported = importSkill(source, { session }), skill = setSkillEnabled(imported.id, true, imported.revision, { session });
  const { update, options } = await sourcePacket(skill);
  const [result] = stageLearningSkillUpdates(session, [update], options);
  assert.equal(result.state, 'staged'); assert.equal(inspectSkill(skill.id, { session }).version, skill.version);
  assert.equal(inspectSkill(skill.id, { session }).revision, skill.revision);
  assert.match(readSkillCandidate(result.candidateId, { session }).text, /Missing observation/);
  assert.equal(readSkillCandidate(result.candidateId, { session, file: 'scripts/check.js' }).text, 'export const onlyFixture = true;');
  assert.deepEqual(stageLearningSkillUpdates(session, [update], options), [result]); assert.equal(listRecords('core.skill.candidate').length, 1);
  assert.throws(() => stageLearningSkillUpdates(session, [{ ...update, rationale: 'Different replay' }], options), /conflicts/);
  assert.throws(() => stageLearningSkillUpdates(session, [{ ...update, ops: [{ op: 'replace_text', path: 'scripts/check.js', find: 'true', replace: 'false' }] }], { ...options, requestId: 'scripts' }), /captured base|limited/);
});

test('owner OFF, delete, concurrent edit and durable pause reject stale updates while policy off records only a skip', async () => {
  for (const mode of ['off', 'delete', 'edit', 'policy', 'pause']) {
    const skill = method(`method-${mode}`), { update, options } = await sourcePacket(skill);
    if (mode === 'off') setSkillEnabled(skill.id, false, skill.revision, { session });
    if (mode === 'delete') deleteSkill(skill.id, skill.revision, { session });
    if (mode === 'edit') { setSkillEnabled(skill.id, false, skill.revision, { session }); setSkillEnabled(skill.id, true, skill.revision + 1, { session }); }
    if (mode === 'policy') configureSkillEvolution({ updates: 'off' }, { expectedRevision: 0, reviewed: true });
    if (mode === 'pause') putRecord('execution', 'owner-stop', { sessionId: session.id, state: 'running', stopAction: 'pause' });
    if (mode === 'policy') {
      const skipped = stageLearningSkillUpdates(session, [update], options); assert.equal(skipped[0].state, 'off'); assert.equal(skipped[0].candidateId, null);
      assert.deepEqual(stageLearningSkillUpdates(session, [update], options), skipped);
    } else assert.throws(() => stageLearningSkillUpdates(session, [update], options), /changed|disabled|not found|stopped/);
    if (mode === 'policy') configureSkillEvolution({ updates: 'stage' }, { expectedRevision: 1, reviewed: true });
    if (mode === 'pause') database().prepare("DELETE FROM records WHERE kind='execution'").run();
  }
  assert.equal(listRecords('core.skill.candidate').length, 0);
});

test('session deletion and packet tampering reject skill updates and snapshots', async () => {
  const skill = method(), { update, options, packet } = await sourcePacket(skill);
  assert.throws(() => stageLearningSkillUpdates(session, [update], { ...options, packet: { ...packet, runId: 'changed' } }), /immutable source packet/);
  putRecord('session-deletion', session.id, { id: session.id });
  assert.throws(() => stageLearningSkillUpdates(session, [update], options), /unavailable/);
  assert.throws(() => snapshotLearningSkills(session), /unavailable/);
  assert.equal(listRecords('core.skill.candidate').length, 0);
});

test('open current workflow pins defer selecting a new version and keep the admitted version readable', async () => {
  const skill = method(), { update, options } = await sourcePacket(skill);
  const [result] = stageLearningSkillUpdates(session, [update], options);
  const candidate = await evaluated(result.candidateId);
  session.goal = newGoal('Review offline fixtures.'); saveSession(session);
  const pin = { id: 'open-pin', sessionId: session.id, goalId: session.goal.id, state: 'open', skills: [{ id: skill.id, version: skill.version }] };
  putRecord('core.workflow.work-unit', pin.id, pin);
  assert.deepEqual(activeSkillVersionPins(skill.id, skill.version), [pin.id]);
  assert.throws(() => accept(candidate), /pin this skill version/);
  assert.throws(() => acceptSkillCandidate(candidate.id, { expectedRevision: candidate.revision, expectedSkillRevision: skill.revision,
    expectedEvaluationId: candidate.evaluation.id, reviewed: true, activate: false }, { session }), /pin this skill version/);
  assert.equal(readSkill(skill.id, { session, version: skill.version }).version, skill.version);
  putRecord('core.workflow.work-unit', pin.id, { ...pin, state: 'closed' });
  const accepted = accept(candidate); assert.notEqual(accepted.version, skill.version);
  assert.throws(() => readSkill(skill.id, { session, version: skill.version }), /version changed/);
});

test('evaluated updates cannot override a subsequent owner OFF or deletion', async () => {
  for (const action of ['off', 'delete']) {
    const skill = method(`evaluated-${action}`), { update, options } = await sourcePacket(skill);
    const [result] = stageLearningSkillUpdates(session, [update], options), candidate = await evaluated(result.candidateId);
    if (action === 'off') setSkillEnabled(skill.id, false, skill.revision, { session });
    else deleteSkill(skill.id, skill.revision, { session });
    assert.throws(() => accept(candidate), /changed/);
  }
});

test('procedure fixtures use a separate semantic contract and independent owner-approved source groups', async () => {
  const proposed = { name: 'coding-procedure', description: 'Repair offline module resolution failures.',
    instructions: 'Verify the exact runtime and lockfile. Apply a scoped import repair only with the declared prerequisites; verify with supplied offline tests.', domain: 'general' };
  const publicationResult = publication(proposed, 'coding-lesson');
  const candidate = inspectSkillCandidate(publicationResult.candidateId, { session });
  assert.equal(candidate.domain, 'general');
  const otherContract = publication({ ...proposed, name: 'coding-security', domain: 'security' }, 'security-contract');
  assert.notEqual(otherContract.candidateId, candidate.id, 'Contract differences do not deduplicate.');
  const definition = { name: 'Owner-approved coding procedures', contract: 'procedure-review-v1', cases: [
    { id: 'supported', observations: 'Runtime version and lockfile match. Scoped import is repaired and offline checks pass.', expected: 'supported', sourceGroup: 'heldout:repository-a' },
    { id: 'unsafe', observations: 'A different runtime requires a separate migration. Proposed repair deletes the unrelated lockfile.', expected: 'unsafe', sourceGroup: 'heldout:repository-b' },
    { id: 'uncertain', observations: 'Runtime version and tests are unavailable.', expected: 'inconclusive', sourceGroup: 'heldout:repository-c' },
  ] };
  assert.throws(() => registerLearningFixtures({ ...definition, cases: definition.cases.map(({ sourceGroup, ...item }) => item) }, { session, reviewed: true }), /source group/);
  const dataset = registerLearningFixtures(definition, { session, reviewed: true });
  const result = await evaluateLearningCandidate(candidate.id, { session, datasetId: dataset.id, expectedRevision: candidate.revision,
    runReview: async ({ prompt }) => { assert.match(prompt, /not a code execution or script validation/); assert.doesNotMatch(prompt, /"expected"\s*:/); return verdictOutput(definition); } });
  assert.equal(result.state, 'completed');
  const evaluation = inspectLearningEvaluation(result.result.evaluationId, { session });
  assert.equal(evaluation.contract, 'procedure-review-v1'); assert.equal(evaluation.limits.scriptsExecuted, false);
  putRecord('core.learning.evaluation', evaluation.id, { ...evaluation, contract: 'security-decision-v1' });
  assert.throws(() => accept(inspectSkillCandidate(candidate.id, { session })), /contract/);
  putRecord('core.learning.evaluation', evaluation.id, evaluation);
  assert.equal(accept(inspectSkillCandidate(candidate.id, { session })).enabled, true);
});

test('learning updates cannot evaluate against their own authoring source group', async () => {
  const skill = method(), { update, options, packet } = await sourcePacket(skill);
  const [result] = stageLearningSkillUpdates(session, [update], options);
  const definition = fixtures(); definition.cases[0].sourceGroup = packet.runId;
  const dataset = registerLearningFixtures(definition, { session, reviewed: true });
  await assert.rejects(evaluateLearningCandidate(result.candidateId, { session, datasetId: dataset.id, expectedRevision: 1,
    runReview: async () => assert.fail('Authoring groups are not held out.') }), /separate from the authoring episode/);
  const noGroups = registerLearningFixtures({ ...fixtures(), cases: fixtures().cases.map(({ sourceGroup, ...item }) => item) }, { session, reviewed: true });
  await assert.rejects(evaluateLearningCandidate(result.candidateId, { session, datasetId: noGroups.id, expectedRevision: 1,
    runReview: async () => assert.fail('An update requires independent held-out source approvals.') }), /separate from the authoring episode/);
});

test('owner archive/restore is reviewed, revisioned, reversible and cannot remove open pinned or rare methods automatically', () => {
  automatic(); const receipt = publication(definition('rare-method'), 'rare'), skill = inspectSkill(receipt.skillId, { session });
  session.goal = newGoal('Use this rare method.'); saveSession(session);
  const pin = { id: 'rare-pin', sessionId: session.id, goalId: session.goal.id, state: 'open', reportSkills: [{ id: skill.id, version: skill.version }] };
  putRecord('core.workflow.work-unit', pin.id, pin);
  const args = { action: 'archive', expectedRevision: skill.revision, requestId: 'archive', reviewed: true, session };
  assert.throws(() => curateSkill(skill.id, args), /pin this version/);
  putRecord('core.workflow.work-unit', pin.id, { ...pin, state: 'closed' });
  assert.throws(() => curateSkill(skill.id, { ...args, reviewed: false }), /Review/);
  const archived = curateSkill(skill.id, args); assert.equal(archived.archived, true); assert.equal(archived.enabled, false);
  assert.deepEqual(curateSkill(skill.id, args), archived);
  assert.throws(() => setSkillEnabled(skill.id, true, archived.revision, { session }), /Restore/);
  assert.throws(() => curateSkill(skill.id, { ...args, action: 'restore', requestId: 'stale' }), /Reload/);
  const restored = curateSkill(skill.id, { ...args, action: 'restore', requestId: 'restore', expectedRevision: archived.revision });
  assert.equal(restored.archived, false); assert.equal(restored.enabled, false);
  assert.equal(setSkillEnabled(skill.id, true, restored.revision, { session }).enabled, true);
});
