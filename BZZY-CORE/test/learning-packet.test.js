import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSession, saveSession } from '../src/engine/store.js';
import { getProvider, addProvider } from '../src/engine/providers.js';
import { projectIdentityForSession } from '../src/engine/project-identity.js';
import { appendEvent, getRecord, putRecord, listRecords, digest } from '../src/engine/database.js';
import { checkpoint } from '../src/engine/memory.js';
import { recordWorkObservation, captureEpisode } from '../src/engine/episode.js';
import { learningForEpisode, learningForWorkerOutcome } from '../src/engine/learning-hooks.js';
import { createSkill, setSkillEnabled, inspectSkill } from '../src/engine/skills.js';
import { ToolHost } from '../src/engine/tools.js';
import { configureSkillEvolution } from '../src/engine/skill-evolution-policy.js';
import { configureBackgroundModel } from '../src/engine/background-model.js';
import { queueLearningReview, learningMaterial, configureLearning, runLearningJob, processLearningReviews,
  deferLearningForSession, pauseLearningForSession, inspectLearningJob, learningUsage } from '../src/engine/learning.js';

let root, prior, session;
function source(name = 'project') {
  const cwd = path.join(root, name); fs.mkdirSync(cwd);
  const value = createSession(getProvider('codex'), cwd, 'pinned-source-model'); value.projectRoot = cwd;
  projectIdentityForSession(value, { create: true }); saveSession(value); return value;
}
function queue(value = session, options = {}) {
  const event = appendEvent(value.id, 'message.user', { text: 'Repair the fixture and verify its result.' });
  return queueLearningReview(value, { reason: 'explicit', sourceId: event.id, ...options });
}
const noChange = async () => ({ text: '{"lessons":[],"skills":[]}', tokens: 100 });
function run(value = session, goalMode = false) {
  const runId = randomUUID(); value.executionState = 'running'; saveSession(value);
  putRecord('run', value.id, { id: runId, sessionId: value.id, state: 'running', goalMode, goalId: goalMode ? value.goal?.id : null }); return runId;
}
function observation(runId, itemId, { failed = false, output = '', command = 'node fixture.js' } = {}) {
  return recordWorkObservation(session, { runId, itemId, command, name: 'exec_command', kind: 'command_execution',
    output, failed, exitCode: failed ? 1 : 0, status: 'completed' });
}
test.beforeEach(() => {
  prior = process.env.BZZY_HOME; root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-learning-packet-')));
  process.env.BZZY_HOME = path.join(root, 'private'); session = source();
});
test.afterEach(() => { if (prior === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = prior; fs.rmSync(root, { recursive: true, force: true }); });

test('queue pins the original goal, cutoff and mutable record revisions through later goals and writes', async () => {
  session.goal = { id: randomUUID(), objective: 'ORIGINAL OBJECTIVE', status: 'active' }; saveSession(session);
  const saved = checkpoint(session, { completedWork: ['ORIGINAL CHECKPOINT'], decisions: ['Preserve decisive evidence.'] });
  const originalGoal = session.goal.id, job = queue();
  session.goal = { id: randomUUID(), objective: 'LATER OBJECTIVE', status: 'active' }; session.model = 'later-model'; saveSession(session);
  checkpoint(session, { completedWork: ['LATER CHECKPOINT'], expectedRevision: 0 });
  appendEvent(session.id, 'message.user', { text: 'LATER CONVERSATION' });
  const context = learningMaterial(job), text = JSON.stringify(context.material);
  assert.match(text, /ORIGINAL OBJECTIVE/); assert.match(text, /ORIGINAL CHECKPOINT/);
  assert.doesNotMatch(text, /LATER OBJECTIVE|LATER CHECKPOINT|LATER CONVERSATION/);
  assert.equal(context.packet.goalId, originalGoal); assert.ok(context.packet.recordPins.some(pin => pin.id === session.id && pin.revision === saved.revision));
  const result = await runLearningJob(job.id, { runReview: async ({ session: review }) => {
    assert.equal(review.model, 'pinned-source-model'); return noChange();
  } });
  assert.equal(result.state, 'completed'); assert.equal(result.result.packetId, job.packetId);
});

test('ordinary chat packets keep null goal scope even when a saved goal remains', () => {
  session.goal = { id: randomUUID(), objective: 'HISTORICAL GOAL', status: 'complete' }; saveSession(session);
  checkpoint(session, { completedWork: ['HISTORICAL CHECKPOINT'] });
  const job = queue(session, { goalMode: false, runId: randomUUID() });
  assert.equal(job.goalId, null); assert.doesNotMatch(JSON.stringify(learningMaterial(job).material), /HISTORICAL GOAL|HISTORICAL CHECKPOINT/);
});

test('a dispatched packet and its model are immutable while new automatic work obtains a separate job', async () => {
  const initial = appendEvent(session.id, 'message.user', { text: 'Initial correction.' });
  const first = queueLearningReview(session, { reason: 'recorded_lesson', sourceId: initial.id });
  let start, release;
  const began = new Promise(resolve => { start = resolve; }), hold = new Promise(resolve => { release = resolve; });
  const running = runLearningJob(first.id, { runReview: async ({ session: pinned }) => { assert.equal(pinned.model, 'pinned-source-model'); start(); return hold; } });
  await began;
  session.model = 'new-live-model'; saveSession(session);
  const next = queueLearningReview(session, { reason: 'recorded_lesson', sourceId: appendEvent(session.id, 'message.user', { text: 'A later correction.' }).id });
  assert.notEqual(next.id, first.id); assert.equal(inspectLearningJob(first.id).packetId, first.packetId);
  release(await noChange()); assert.equal((await running).state, 'completed');
  assert.equal(next.selection.model, 'new-live-model');
});

test('custom learning selection is pinned independently of later learning settings and source switches', async () => {
  configureLearning({ modelRoute: { source: 'custom', provider: 'codex', model: 'cheap-offline-model' } }, { expectedRevision: 0 });
  const job = queue();
  configureLearning({ modelRoute: { source: 'source' } }, { expectedRevision: 1 });
  session.provider = 'claude'; session.model = 'later-claude-model'; saveSession(session);
  const result = await runLearningJob(job.id, { runReview: async ({ session: pinned }) => {
    assert.equal(pinned.provider, 'codex'); assert.equal(pinned.model, 'cheap-offline-model'); return noChange();
  } });
  assert.equal(result.state, 'completed'); assert.deepEqual(result.reviewSelection, job.selection);
  assert.doesNotMatch(JSON.stringify(getRecord('core.learning.packet', job.packetId)), /backendHomes|credential|auth\.json/);
});

test('packet tampering is rejected before dispatch and does not reserve usage', async () => {
  const job = queue(), packet = getRecord('core.learning.packet', job.packetId);
  putRecord('core.learning.packet', packet.id, { ...packet, throughSeq: packet.throughSeq + 1 });
  await assert.rejects(runLearningJob(job.id, { runReview: () => assert.fail('Tampered material must never be dispatched.') }), { code: 'LEARNING_SCOPE' });
  assert.equal(learningUsage().reservedTokens, 0); assert.equal(listRecords('core.learning.reservation').length, 0);
});

test('legacy queued jobs stop with explicit migration uncertainty instead of reading current records', async () => {
  const job = queue(); delete job.packetId; job.version = 1; putRecord('core.learning.job', job.id, job);
  assert.deepEqual(await processLearningReviews({ runReview: () => assert.fail('Legacy jobs cannot silently retarget.') }), []);
  const stopped = inspectLearningJob(job.id); assert.equal(stopped.state, 'paused'); assert.equal(stopped.reasonPaused, 'snapshot_required');
  assert.match(stopped.migration.uncertainty, /No immutable historical/); assert.equal(learningUsage().reservedTokens, 0);
});

test('foreground work defers queued reviews and owner pauses remain durable', async () => {
  const job = queue(); session.executionState = 'running'; saveSession(session); deferLearningForSession(session.id);
  assert.equal(inspectLearningJob(job.id).state, 'queued');
  assert.deepEqual(await processLearningReviews({ runReview: () => assert.fail('Busy source must defer.') }), []);
  session.executionState = 'idle'; saveSession(session);
  assert.equal((await processLearningReviews({ runReview: noChange }))[0].state, 'completed');
  const stopped = queue(); pauseLearningForSession(session.id, 'owner_pause'); deferLearningForSession(session.id);
  assert.deepEqual(await processLearningReviews({ runReview: () => assert.fail('Polling cannot resume an owner pause.') }), []);
  assert.equal(inspectLearningJob(stopped.id).reasonPaused, 'owner_pause');
});

test('an idle source runs while another source works and host capacity still bounds dispatch', async () => {
  const other = source('other'); other.executionState = 'running'; saveSession(other);
  putRecord('execution', 'other-work', { id: 'other-work', sessionId: other.id, state: 'running' });
  const job = queue();
  assert.equal((await processLearningReviews({ runReview: noChange }))[0].id, job.id);
  const deferred = queue(); configureLearning({ maxForegroundExecutions: 1 }, { expectedRevision: 0 });
  assert.deepEqual(await processLearningReviews({ runReview: () => assert.fail('Capacity must reserve foreground work.') }), []);
  assert.equal(inspectLearningJob(deferred.id).scheduleReason, 'host_capacity');
});

test('bounded rotating discovery reaches an eligible review behind over one hundred busy jobs', async () => {
  const busy = source('busy'); const template = queue(busy); busy.executionState = 'running'; saveSession(busy);
  // Stable artificial IDs make the deferred page deterministic without changing
  // the valid source packets or asking any backend to run.
  for (let i = 0; i < 132; i++) {
    const id = `a-${String(i).padStart(3, '0')}`; putRecord('core.learning.job', id, { ...template, id });
  }
  const original = getRecord('core.learning.job', template.id); putRecord('core.learning.job', template.id, { ...original, state: 'cancelled' });
  const eligible = queue(); putRecord('core.learning.job', 'z-eligible', { ...eligible, id: 'z-eligible' });
  putRecord('core.learning.job', eligible.id, { ...eligible, state: 'cancelled' });
  let completed = [];
  for (let i = 0; i < 3 && !completed.length; i++) completed.push(...await processLearningReviews({ runReview: noChange }));
  assert.equal(completed.length, 1); assert.equal(completed[0].id, 'z-eligible'); assert.equal(completed[0].state, 'completed');
});

test('closed failures, changes and retries survive conversation pressure with explicit coverage and whole-output privacy', () => {
  const runId = run(); observation(runId, 'failed', { failed: true, output: 'TypeError ERR_FIXTURE: missing value\napi_key=sk-packetPrivateTail123456789' });
  recordWorkObservation(session, { runId, itemId: 'patch', name: 'apply_patch', kind: 'file_change', status: 'completed',
    changes: [{ path: 'src/fixture.js', diff: '- missing\n+ guarded' }] });
  observation(runId, 'success', { output: 'PASS fixture' });
  for (let i = 0; i < 50; i++) appendEvent(session.id, 'text', { text: `Later harmless conversation ${i}. ${'x'.repeat(1900)}` });
  const job = queue(session, { runId, goalMode: false }), { packet, material } = learningMaterial(job);
  const serialized = JSON.stringify(material);
  assert.match(serialized, /ERR_FIXTURE/); assert.match(serialized, /PASS fixture/); assert.match(serialized, /guarded/);
  assert.doesNotMatch(serialized, /packetPrivateTail/); assert.ok(packet.signatures.length); assert.ok(packet.episode.transitions.length);
  assert.equal(packet.coverage.truncated, true); assert.ok(packet.coverage.omittedItems || packet.coverage.omittedCharacters); assert.ok(Buffer.byteLength(serialized) <= 17000);
});

test('host episode hooks capture ordinary solved work, rate limit repetition, and ignore compaction-only growth', () => {
  const runId = run(); observation(runId, 'failure', { failed: true, output: 'ERR_FIXTURE missing value' }); observation(runId, 'fix', { output: 'PASS' });
  const episode = captureEpisode(session, { runId, goalId: null });
  const job = learningForEpisode(session, episode, { runId, goalMode: false });
  assert.equal(job.reason, 'solved_problem'); assert.equal(job.goalId, null);
  assert.equal(learningForEpisode(session, episode, { runId, goalMode: false }), null);
  appendEvent(session.id, 'compaction', { summary: 'Context compacted.' });
  assert.equal(learningForEpisode(session, captureEpisode(session, { runId, goalId: null }), { runId, goalMode: false }), null);
  assert.equal(listRecords('core.learning.job').length, 1);
});

test('complex ordinary turns and inspected worker outcomes are eligible without a completed goal', () => {
  configureLearning({ complexTurnAttempts: 2 }, { expectedRevision: 0 });
  session.goal = { id: randomUUID(), objective: 'OLD GOAL', status: 'complete' }; saveSession(session);
  const runId = run(); observation(runId, 'a', { command: 'node first.js', output: 'First result' }); observation(runId, 'b', { command: 'node second.js', output: 'Second result' });
  const episode = captureEpisode(session, { runId, goalId: null });
  assert.equal(learningForEpisode(session, episode, { runId, goalMode: false }).reason, 'complex_turn');
  const assignment = { id: randomUUID(), parentSessionId: session.id, goalId: null, chatRunId: runId };
  const review = { id: randomUUID(), round: 1, outcome: 'accepted', inspectedEvidence: ['fixture-artifact'] };
  const worker = learningForWorkerOutcome(session, review, assignment);
  assert.ok(worker); assert.equal(worker.goalId, null); assert.equal(worker.triggerCount, 2);
  assert.equal(learningForWorkerOutcome(session, { ...review, inspectedEvidence: [] }, assignment), null);
});

test('empty proposals complete as no change without creating memory, skills or resolutions', async () => {
  const result = await runLearningJob(queue().id, { runReview: noChange });
  assert.equal(result.state, 'completed'); assert.equal(result.result.noChange, true);
  assert.deepEqual(result.result.resolutionIds, []); assert.deepEqual(result.result.skillUpdateIds, []);
  assert.equal(listRecords('memory').length, 0); assert.equal(listRecords('core.resolution').length, 0); assert.equal(listRecords('core.skill.update').length, 0);
});

test('feedback rationale and exact loaded skill bases reach review and updates return candidate IDs', async () => {
  const created = createSkill({ name: 'fixture-procedure', description: 'Repair controlled fixture failures.',
    instructions: 'Compare a failing fixture with a controlled repeat. Keep unverified causes as hypotheses.' }, { session });
  const skill = setSkillEnabled(created.id, true, created.revision, { session });
  const runId = run(), host = new ToolHost(session, { event() {} }, { runId, goalMode: false });
  const loaded = await host.call('read_skill', { name: skill.id });
  const usage = listRecords('core.usage')[0]; assert.ok(loaded.text); assert.ok(usage);
  const feedback = await host.call('skill_feedback', { usageId: usage.id, requestId: 'missing-check', kind: 'missing_step',
    rationale: 'The procedure omits a negative control.', proposedText: 'Repeat the negative control before drawing a conclusion.' });
  const job = listRecords('core.learning.job')[0], packet = learningMaterial(job).packet;
  assert.equal(job.reason, 'skill_feedback'); assert.ok(packet.material.some(item => item.sourceId === feedback.id && item.rationale.includes('negative control')));
  assert.ok(packet.recordPins.some(pin => pin.kind === 'core.skill.feedback' && pin.id === feedback.id));
  const base = packet.skills[0]; assert.equal(base.skillId, skill.id);
  session.executionState = 'idle'; saveSession(session);
  const result = await runLearningJob(job.id, { runReview: async ({ prompt }) => {
    assert.match(prompt, /procedure omits a negative control/);
    return { tokens: 100, text: JSON.stringify({ lessons: [], skills: [], skillUpdates: [{ skillId: base.skillId, baseVersion: base.version,
      baseRevision: base.revision, rationale: 'Add the missing negative control.', sourceIds: [base.sourceId, feedback.id],
      ops: [{ op: 'append_section', heading: 'Negative control', text: 'Repeat the negative control before drawing a conclusion.' }] }] }) };
  } });
  assert.equal(result.state, 'completed'); assert.equal(result.result.skillUpdateIds.length, 1); assert.equal(result.result.candidateIds.length, 1);
  const update = getRecord('core.skill.update', result.result.skillUpdateIds[0]);
  assert.equal(update.candidateId, result.result.candidateIds[0]); assert.notEqual(update.id, update.candidateId);
  assert.equal(inspectSkill(skill.id, { session }).version, skill.version);
  configureSkillEvolution({ updates: 'off' }, { expectedRevision: 0, reviewed: true });
  const offJob = queue(session, { runId, goalMode: false });
  const off = await runLearningJob(offJob.id, { runReview: async () => ({ tokens: 100, text: JSON.stringify({ lessons: [], skills: [], skillUpdates: [{
    skillId: base.skillId, baseVersion: base.version, baseRevision: base.revision, rationale: 'Optional control improvement.', sourceIds: [base.sourceId],
    ops: [{ op: 'append_section', heading: 'Optional control', text: 'Record the negative control result.' }] }] }) }) });
  assert.equal(off.state, 'completed'); assert.equal(off.result.noChange, true); assert.equal(off.result.updateCounts.off, 1);
  assert.deepEqual(off.result.candidateIds, []); assert.equal(listRecords('core.skill.candidate').length, 1);
});

test('resolution proposals publish only a host-pinned error signature and remain hypotheses', async () => {
  const runId = run(); observation(runId, 'failed', { failed: true, output: 'TypeError ERR_MISSING_FIXTURE: required fixture missing' });
  observation(runId, 'repaired', { output: 'PASS fixture' });
  const job = queue(session, { runId, goalMode: false }), packet = learningMaterial(job).packet;
  const signature = packet.signatures[0], sourceId = packet.sourceRefs.find(item => item.type === 'episode').id;
  session.executionState = 'idle'; saveSession(session);
  const result = await runLearningJob(job.id, { runReview: async () => ({ tokens: 100, text: JSON.stringify({ lessons: [], skills: [],
    resolutions: [{ signatureHash: signature.signatureHash, symptom: 'The controlled fixture was missing.', rootCause: 'Fixture setup may have omitted a required value.',
      fixSteps: ['Initialize the fixture value.', 'Repeat the controlled test and inspect its result.'], sourceIds: [sourceId], evidenceIds: [] }] }) }) });
  assert.equal(result.state, 'completed'); assert.equal(result.result.resolutionIds.length, 1);
  const resolution = getRecord('core.resolution', result.result.resolutionIds[0]), memory = getRecord('memory', resolution.memoryId);
  assert.equal(memory.truth, 'hypothesis'); assert.equal(resolution.signature.signatureHash, signature.signatureHash);
});

test('new learned procedures stage by default and report actual candidate IDs', async () => {
  const job = queue(), sourceId = job.sourceId;
  const result = await runLearningJob(job.id, { runReview: async () => ({ tokens: 100, text: JSON.stringify({ lessons: [], skills: [{
    name: 'controlled-fixture-repair', description: 'Repair a deterministic fixture error with positive and negative controls.',
    instructions: 'Record a failing controlled fixture. Repair its missing prerequisite. Run both positive and negative controls. Keep inferred root causes uncertain.', sourceIds: [sourceId] }] }) }) });
  assert.equal(result.state, 'completed'); assert.equal(result.result.candidateIds.length, 1); assert.equal(result.result.skillIds.length, 0);
  assert.ok(getRecord('core.skill.candidate', result.result.candidateIds[0])); assert.equal(listRecords('core.skill').length, 0);
});

test('preempting a dispatched review preserves uncertain-spend pause and never silently retries it', async () => {
  const job = queue(); let begin, release;
  const began = new Promise(resolve => { begin = resolve; }), held = new Promise(resolve => { release = resolve; });
  const running = runLearningJob(job.id, { runReview: async () => { begin(); return held; } });
  await began; session.executionState = 'running'; saveSession(session); deferLearningForSession(session.id); release(await noChange());
  const result = await running;
  assert.equal(result.state, 'paused'); assert.equal(result.reasonPaused, 'uncertain_foreground_preemption');
  assert.equal(learningUsage().reservedTokens, 0); assert.equal(learningUsage().tokensUsed, job.budget.tokenBudget);
  session.executionState = 'idle'; saveSession(session);
  assert.deepEqual(await processLearningReviews({ runReview: () => assert.fail('Unknown paid work needs an owner decision.') }), []);
});

test('policy-off new skill proposals are visible and complete honestly as no change', async () => {
  configureSkillEvolution({ newSkills: 'off' }, { expectedRevision: 0, reviewed: true });
  const job = queue();
  const result = await runLearningJob(job.id, { runReview: async () => ({ tokens: 100, text: JSON.stringify({ lessons: [], skills: [{
    name: 'proposed-fixture-repair', domain: 'general', description: 'A controlled coding fixture procedure.',
    instructions: 'Observe the failure. Identify a missing prerequisite. Repeat both control cases. Preserve uncertainty.', sourceIds: [job.sourceId] }] }) }) });
  assert.equal(result.state, 'completed'); assert.equal(result.result.noChange, true); assert.equal(result.result.skillCounts.off, 1);
  assert.equal(result.result.skillCounts.published, 0); assert.deepEqual(result.result.candidateIds, []); assert.equal(listRecords('core.skill').length, 0);
});

test('an explicit source stop request pauses reviews even when foreground learning was opted in', async () => {
  configureLearning({ duringForeground: true }, { expectedRevision: 0 });
  const job = queue(); session.executionState = 'running'; saveSession(session);
  putRecord('execution', 'stopping', { id: 'stopping', sessionId: session.id, state: 'running', stopAction: 'pause' });
  assert.deepEqual(await processLearningReviews({ runReview: () => assert.fail('Stop requests always take priority.') }), []);
  assert.equal(inspectLearningJob(job.id).state, 'paused'); assert.equal(inspectLearningJob(job.id).reasonPaused, 'source_paused');
});

test('whole-message masking covers escaped quotes, multiline bindings and unterminated credentials', () => {
  const id = { runId: 'mask-run', threadRef: 'mask-thread', turnId: 'mask-turn', itemId: 'mask-item' };
  appendEvent(session.id, 'text', { ...id, text: 'password="fixture\\"ESCAPED_PRIVATE_TAIL"\nsecret=\'first line\n' });
  appendEvent(session.id, 'text', { ...id, text: "MULTILINE_PRIVATE_TAIL'\napi_key=\"UNTERMINATED_PRIVATE_TAIL" });
  appendEvent(session.id, 'message.finalized', id);
  const trailing = { ...id, itemId: 'trailing-slash' };
  appendEvent(session.id, 'text', { ...trailing, text: 'password="TRAILING_BACKSLASH_PRIVATE\\' });
  appendEvent(session.id, 'message.finalized', trailing);
  const packet = learningMaterial(queue()).packet, serialized = JSON.stringify(packet);
  assert.doesNotMatch(serialized, /ESCAPED_PRIVATE_TAIL|MULTILINE_PRIVATE_TAIL|UNTERMINATED_PRIVATE_TAIL|TRAILING_BACKSLASH_PRIVATE/);
  assert.match(serialized, /redacted/);
});

test('a provider endpoint change cannot redirect a queued packet to a different destination', async () => {
  addProvider('review-fixture', { baseUrl: 'https://first.invalid/v1', envKey: 'FIXTURE_REVIEW_KEY', model: 'fixture-model' });
  configureLearning({ modelRoute: { source: 'custom', provider: 'review-fixture', model: 'fixture-model' } }, { expectedRevision: 0 });
  const job = queue();
  addProvider('review-fixture', { baseUrl: 'https://changed.invalid/v1', envKey: 'FIXTURE_REVIEW_KEY', model: 'fixture-model' });
  const result = await runLearningJob(job.id, { runReview: () => assert.fail('Provider changes need a fresh pinned review.') });
  assert.equal(result.state, 'paused'); assert.equal(result.error, 'LEARNING_SCOPE'); assert.equal(learningUsage().tokensUsed, 0);
});

test('a pinned model context that cannot hold the packet fails before model dispatch', async () => {
  session.modelCapabilities = { contextWindow: 256 }; saveSession(session);
  const job = queue(); session.modelCapabilities = { contextWindow: 1000000 }; saveSession(session);
  const result = await runLearningJob(job.id, { runReview: () => assert.fail('Later larger model context cannot override a historical pin.') });
  assert.equal(result.state, 'budget_limited'); assert.equal(learningUsage().tokensUsed, 0); assert.equal(result.reviewStarted, false);
});

test('background reviewer route pins its own settings revisions across later model changes', async () => {
  configureBackgroundModel({ source: 'custom', provider: 'codex', model: 'original-background-model' }, { expectedRevision: 0 });
  configureLearning({ modelRoute: { source: 'background' } }, { expectedRevision: 0 });
  const job = queue();
  configureBackgroundModel({ source: 'custom', provider: 'codex', model: 'later-background-model' }, { expectedRevision: 1 });
  const result = await runLearningJob(job.id, { runReview: async ({ session: pinned }) => { assert.equal(pinned.model, 'original-background-model'); return noChange(); } });
  assert.equal(result.state, 'completed'); assert.equal(job.backgroundModelRevision, 1);
  assert.equal(learningMaterial(job).packet.backgroundModelRevision, 1);
});

test('an unconfigured background route never falls back or captures a later model into its old packet', async () => {
  configureLearning({ modelRoute: { source: 'background' } }, { expectedRevision: 0 });
  const initial = queueLearningReview(session, { reason: 'recorded_lesson', sourceId: appendEvent(session.id, 'message.user', { text: 'Original trigger.' }).id });
  assert.equal(initial.selection, null);
  assert.deepEqual(await processLearningReviews({ runReview: () => assert.fail('Missing route must not use the source model.') }), []);
  assert.equal(inspectLearningJob(initial.id).scheduleReason, 'model_configuration');
  configureBackgroundModel({ source: 'custom', provider: 'codex', model: 'now-configured-background' }, { expectedRevision: 0 });
  const fresh = queueLearningReview(session, { reason: 'recorded_lesson', sourceId: appendEvent(session.id, 'message.user', { text: 'Fresh trigger after configuration.' }).id });
  assert.notEqual(fresh.id, initial.id); assert.equal(inspectLearningJob(initial.id).selection, null);
  const result = await runLearningJob(fresh.id, { runReview: async ({ session: pinned }) => { assert.equal(pinned.model, 'now-configured-background'); return noChange(); } });
  assert.equal(result.state, 'completed');
});

test('minimum-sized packets budget their wrappers and retain a failure, change and successful retry', () => {
  configureLearning({ packetMaxBytes: 4000 }, { expectedRevision: 0 });
  session.goal = { id: randomUUID(), objective: 'Long objective. '.repeat(1000), status: 'active' }; saveSession(session);
  const runId = run(session, true);
  observation(runId, 'failure', { failed: true, output: 'ERR_FIXTURE missing value' });
  recordWorkObservation(session, { runId, itemId: 'patch', kind: 'file_change', name: 'apply_patch', status: 'completed', changes: [{ path: 'fixture.js', diff: '-missing\n+guarded' }] });
  observation(runId, 'retry', { output: 'PASS fixture' });
  const packet = learningMaterial(queue(session, { runId, goalMode: true })).packet;
  assert.ok(packet.episode); assert.equal(packet.episode.transitions.length, 1);
  assert.ok(packet.episode.attempts.some(attempt => attempt.changedFiles?.length));
  assert.ok(Buffer.byteLength(JSON.stringify(packet.material)) <= 4100);
  assert.equal(packet.coverage.truncated, true);
});
