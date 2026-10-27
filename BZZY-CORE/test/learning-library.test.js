import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSession, saveSession } from '../src/engine/store.js';
import { getProvider } from '../src/engine/providers.js';
import { projectIdentityForSession } from '../src/engine/project-identity.js';
import { appendEvent, events, getRecord, listRecords, putRecord, transaction } from '../src/engine/database.js';
import { queueLearningReview, runLearningJob, recoverLearningJobs, controlLearningJob, inspectLearningJob, learningUsage } from '../src/engine/learning.js';
import { createSkill, deleteSkill, inspectSkill, listSkills, publishLearnedSkill, readSkill, setSkillEnabled, skillHistory } from '../src/engine/skills.js';
import { taskTools } from '../src/engine/tools.js';
import { configureSkillEvolution } from '../src/engine/skill-evolution-policy.js';

let directory, previousHome, source;
test.beforeEach(() => {
  previousHome = process.env.BZZY_HOME;
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-learning-library-')));
  process.env.BZZY_HOME = path.join(directory, 'private');
  const project = path.join(directory, 'project'); fs.mkdirSync(project);
  source = createSession(getProvider('codex'), project, 'offline-learning-model'); source.projectRoot = project;
  projectIdentityForSession(source, { create: true }); saveSession(source);
  // These compatibility cases explicitly exercise the retained automatic mode.
  // The staged default and its dedup lifecycle have separate evolution tests.
  configureSkillEvolution({ newSkills: 'auto' }, { expectedRevision: 0, reviewed: true });
});
test.afterEach(() => {
  if (previousHome === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previousHome;
  fs.rmSync(directory, { recursive: true, force: true });
});

const definition = (name = 'compare-recorded-controls') => ({ name, description: 'Compare recorded observations before reaching a conclusion.',
  instructions: 'Check prerequisites and permitted scope. Compare the recorded positive and negative controls. Keep missing decisive evidence inconclusive. Stop when the needed control is unavailable.' });
function publicationOptions(session = source, jobId = randomUUID()) {
  return { session, requestId: `${jobId}:skill:0`, provenance: { kind: 'learning', jobId, sourceSessionId: session.id } };
}
async function review(name = 'compare-recorded-controls', edit = value => value) {
  const event = appendEvent(source.id, 'message.user', { text: 'Use recorded controls and preserve uncertainty when decisive evidence is missing.' });
  const job = queueLearningReview(source, { reason: 'user_correction', sourceId: event.id });
  const output = edit({ lessons: [], skills: [{ ...definition(name), sourceIds: [event.id] }], profiles: [] });
  return runLearningJob(job.id, { runReview: async () => ({ tokens: 100, text: JSON.stringify(output) }) });
}
async function resumeCached(completed) {
  const current = getRecord('core.learning.job', completed.id);
  putRecord('core.learning.job', current.id, { ...current, state: 'running', runner: null });
  assert.deepEqual(recoverLearningJobs(), [current.id]);
  const paused = inspectLearningJob(current.id); controlLearningJob(current.id, 'resume', { expectedRevision: paused.revision });
  return runLearningJob(current.id, { runReview: async () => assert.fail('A cached learning result must not call the model again.') });
}

test('explicit automatic opt-in publishes an enabled project Library method with security policy', async () => {
  const completed = await review();
  assert.equal(completed.state, 'completed'); assert.equal(completed.result.skillIds.length, 1);
  assert.deepEqual(completed.result.candidateIds, []); assert.equal(listRecords('core.skill.candidate').length, 0);
  const skill = inspectSkill(completed.result.skillIds[0], { session: source });
  assert.equal(skill.scope, 'project'); assert.equal(skill.enabled, true); assert.equal(skill.provenance.kind, 'learning');
  assert.equal(skill.provenance.jobId, completed.id); assert.equal(skill.provenance.sourceSessionId, source.id);
  assert.equal(Object.hasOwn(skill.provenance, 'sourceEventIds'), false, 'public metadata does not expose the private source inventory');
  assert.equal(listSkills({ session: source, enabledOnly: true }).total, 1);
  const body = readSkill(skill.id, { session: source }).text;
  assert.match(body, /Check prerequisites and permitted scope/); assert.match(body, /Never hardcode/);
  assert.doesNotMatch(body, new RegExp(source.id));
  assert.deepEqual(skill.files.map(file => file.path), ['SKILL.md']);
  assert.ok(skillHistory(skill.id, { session: source }).entries.some(item => item.action === 'learning-enable'));
  assert.ok(taskTools(source).some(tool => tool.name === 'read_skill'));
  assert.ok(taskTools(source).every(tool => !['publish_learned_skill', 'delete_skill'].includes(tool.name)), 'models cannot administer the Library');
  assert.equal(listRecords('execution').length, 0, 'publication starts no assessment or worker');
  const notices = listRecords('outbox').filter(item => item.event.type === 'library.skill_created');
  assert.equal(notices.length, 1); assert.equal(notices[0].event.definitionId, skill.id);
  assert.equal(notices[0].event.sessionId, source.id); assert.equal(notices[0].event.description, skill.description);
});

test('learned methods are project-scoped and never overwrite or shadow existing owner methods', async () => {
  const global = createSkill(definition(), { scope: 'global' });
  const completed = await review(), publication = completed.result.skillPublications[0];
  assert.match(publication.name, /^compare-recorded-controls-learned-[a-f0-9]{10}$/);
  assert.deepEqual(inspectSkill(global.id, { scope: 'global' }), global);
  const local = createSkill(definition('local-owner-method'), { session: source });
  const second = await review('local-owner-method');
  assert.notEqual(second.result.skillPublications[0].name, local.name);
  assert.deepEqual(inspectSkill(local.id, { session: source }), local);
  const otherProject = path.join(directory, 'other-project'); fs.mkdirSync(otherProject);
  const other = createSession(getProvider('codex'), otherProject, 'offline');
  projectIdentityForSession(other, { create: true }); saveSession(other);
  assert.equal(listSkills({ session: other, enabledOnly: true }).total, 0);
  assert.throws(() => readSkill(publication.skillId, { session: other }), /not found/);
  assert.throws(() => deleteSkill(publication.skillId, inspectSkill(publication.skillId, { session: source }).revision, { session: other }), /not found/);
});

test('cached learning publication is idempotent and never reverses a later owner Disable', async () => {
  const completed = await review(), id = completed.result.skillIds[0], before = inspectSkill(id, { session: source });
  const disabled = setSkillEnabled(id, false, before.revision, { session: source });
  const historyCount = skillHistory(id, { session: source }).entries.length;
  const resumed = await resumeCached(completed);
  assert.equal(resumed.state, 'completed'); assert.deepEqual(resumed.result.skillIds, completed.result.skillIds);
  assert.deepEqual(inspectSkill(id, { session: source }), disabled);
  assert.equal(skillHistory(id, { session: source }).entries.length, historyCount);
  assert.equal(listRecords('core.learning.skill-publication').length, 1);
  assert.equal(events(source.id, 0, 1000).filter(event => event.type === 'learning.skill-published').length, 1);
  assert.equal(listRecords('outbox').filter(item => item.event.type === 'library.skill_created').length, 1);
  assert.equal(learningUsage().tokensUsed, 100);
});

test('Delete retains auditable history and tombstones the receipt so recovery cannot resurrect the skill', async () => {
  const completed = await review(), id = completed.result.skillIds[0], before = inspectSkill(id, { session: source });
  const deleted = deleteSkill(id, before.revision, { session: source });
  assert.equal(deleted.deleted, true); assert.equal(deleted.revision, before.revision + 1);
  assert.equal(listSkills({ session: source }).total, 0); assert.throws(() => readSkill(id, { session: source }), /not found/);
  assert.equal(getRecord('core.skill.deleted', id).version, before.version);
  assert.ok(listRecords('core.skill.history').some(item => item.skillId === id && item.action === 'delete'));
  assert.ok(listRecords('core.skill.version').some(item => item.id === id && item.version === before.version));
  assert.equal(inspectLearningJob(completed.id).result.skillPublications[0].state, 'deleted');
  const resumed = await resumeCached(completed);
  assert.equal(resumed.state, 'completed'); assert.deepEqual(resumed.result.skillIds, []);
  assert.equal(resumed.result.skillPublications[0].state, 'deleted'); assert.equal(listSkills({ session: source }).total, 0);
  const replacement = createSkill(definition(), { session: source });
  assert.ok(replacement.revision > deleted.revision, 'recreation cannot reuse the deleted generation’s CAS revision');
  assert.throws(() => deleteSkill(id, before.revision, { session: source }), /changed/);
  await resumeCached(completed);
  assert.deepEqual(inspectSkill(id, { session: source }), replacement, 'recovery cannot replace a new owner-authored method either');
});

test('publication and enablement roll back together and reject conflicting replay inputs', () => {
  const options = publicationOptions();
  assert.throws(() => transaction(() => { publishLearnedSkill(definition(), options); throw new Error('Synthetic interrupted transaction.'); }), /Synthetic/);
  assert.equal(listSkills({ session: source }).total, 0); assert.equal(listRecords('core.learning.skill-publication').length, 0);
  assert.equal(events(source.id, 0, 1000).filter(event => event.type === 'learning.skill-published').length, 0);
  assert.equal(listRecords('outbox').filter(item => item.event.type === 'library.skill_created').length, 0);
  const saved = publishLearnedSkill(definition(), options);
  assert.equal(inspectSkill(saved.skillId, { session: source }).enabled, true);
  assert.deepEqual(publishLearnedSkill(definition(), options), saved);
  assert.throws(() => publishLearnedSkill({ ...definition(), instructions: 'A different unchecked workflow.' }, options), /conflicts/);
  assert.equal(listSkills({ session: source }).total, 1);
});

test('foreign source references, credentials and invalid publication identity cannot create Library entries', async () => {
  const failed = await review('unsafe-output', output => { output.skills[0].instructions += ' password=synthetic-private-binding'; return output; });
  assert.equal(failed.state, 'failed'); assert.equal(listSkills({ session: source }).total, 0);
  const foreign = await review('foreign-source', output => { output.skills[0].sourceIds = [randomUUID()]; return output; });
  assert.equal(foreign.state, 'failed'); assert.equal(listSkills({ session: source }).total, 0);
  assert.throws(() => publishLearnedSkill(definition(), { ...publicationOptions(), provenance: { kind: 'owner' } }), /provenance/);
  assert.equal(listRecords('core.learning.skill-publication').length, 0);
});
