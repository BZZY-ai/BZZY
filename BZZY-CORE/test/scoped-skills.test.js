import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSession } from '../src/engine/store.js';
import { getProvider } from '../src/engine/providers.js';
import { digest, getRecord, putRecord, listRecords } from '../src/engine/database.js';
import { resolveProjectIdentity } from '../src/engine/project-identity.js';
import { syncCodexSkills } from '../src/engine/skill-sync.js';
import { createSkill, importSkill, inspectSkill, listSkills, readSkill, setSkillEnabled, skillHistory, rollbackSkill,
  stageSkillCandidate, listSkillCandidates, inspectSkillCandidate, readSkillCandidate, evaluateSkillCandidate,
  acceptSkillCandidate, rejectSkillCandidate, promoteSkill } from '../src/engine/skills.js';

let directory, previous, a, b, sessionA, sessionB;
test.beforeEach(() => {
  previous = process.env.BZZY_HOME;
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-scoped-skills-')));
  process.env.BZZY_HOME = path.join(directory, 'private');
  for (const name of ['a', 'b']) fs.mkdirSync(path.join(directory, name));
  a = resolveProjectIdentity(path.join(directory, 'a'), { create: true });
  b = resolveProjectIdentity(path.join(directory, 'b'), { create: true });
  sessionA = createSession(getProvider('codex'), a.root, 'selected-model-a');
  sessionB = createSession(getProvider('claude'), b.root, 'selected-model-b');
});
test.afterEach(() => {
  if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
  fs.rmSync(directory, { recursive: true, force: true });
});
const definition = (name, instructions = 'Compare the baseline with a positive and negative control. Preserve actual evidence and state uncertainty.') => ({ name, description: 'Validate a claim with evidence and controlled comparisons.', instructions });
function enabled(name, instructions, options = {}) {
  const created = createSkill(definition(name, instructions), options);
  return setSkillEnabled(created.id, true, created.revision, options);
}
function packageAt(folder, name, text = 'Follow the project workflow and inspect the original references.') {
  fs.mkdirSync(path.join(folder, 'references'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'SKILL.md'), `---\nname: ${name}\ndescription: Project workflow.\n---\n${text}\n`);
  fs.writeFileSync(path.join(folder, 'references', 'run-records.jsonl'), JSON.stringify({ client: 'SYNTHETIC_PRIVATE_CASE_A', target: 'https://private.fixture.invalid/resource' }));
  return folder;
}
function verification(candidate, { authority = 'host-fixture', categories = ['real', 'false_positive', 'inconclusive'], projectId = candidate.projectId || null } = {}) {
  const fixtureId = 'fixture-' + candidate.id, id = 'evaluation-' + candidate.id + '-' + authority + '-' + categories.length;
  const cases = categories.map(category => ({ id: category, expected: category, observations: `Synthetic ${category} test observations.` }));
  const fixture = { id: fixtureId, revision: 1, version: 1, projectId, name: 'Synthetic security validation', cases,
    hash: digest(cases), reviewed: true, approvedAt: new Date().toISOString(), revokedAt: null };
  putRecord('core.learning.fixtures', fixture.id, fixture);
  const evaluation = { id, projectId: candidate.projectId || null, candidateId: candidate.id, candidateVersion: candidate.version, candidateRevision: candidate.revision, fixtureId, fixtureHash: fixture.hash,
    fixtureRevision: fixture.revision, evaluatorVersion: 'bzzy-semantic-fixture-v1', authority, status: 'passed',
    cases: cases.map(item => ({ id: item.id, category: item.expected, expected: item.expected, actual: item.expected, passed: true })), completedAt: new Date().toISOString() };
  putRecord('core.learning.evaluation', id, evaluation);
  return evaluation;
}
function accept(candidate, evaluation, options = {}) {
  return acceptSkillCandidate(candidate.id, { expectedRevision: candidate.revision, expectedSkillRevision: candidate.baseRevision,
    expectedEvaluationId: evaluation.id, reviewed: true, activate: true }, options);
}

test('project names shadow globals locally; guessed IDs and model-provided selectors cannot cross engagements', () => {
  enabled('common-check', 'Generic global procedure.');
  const local = enabled('common-check', 'SYNTHETIC_PRIVATE_CASE_A method.', { projectRoot: a.root });
  const hidden = enabled('only-project-a', 'Only this engagement can read this workflow.', { projectRoot: a.root });
  assert.deepEqual(listSkills({ session: sessionA, enabledOnly: true }).skills.map(skill => skill.id), [local.id, hidden.id]);
  assert.deepEqual(listSkills({ session: sessionB, enabledOnly: true }).skills.map(skill => skill.name), ['common-check']);
  assert.match(readSkill('common-check', { session: sessionA }).text, /PRIVATE_CASE_A/);
  assert.match(readSkill('common-check', { session: sessionB }).text, /Generic global/);
  assert.throws(() => readSkill(local.id, { session: sessionB, projectId: a.id, scope: 'all' }), /not found/);
  assert.throws(() => readSkill('only-project-a', { session: sessionB, projectRoot: a.root }), /not found/);
  assert.equal(listSkills({ session: sessionB, scope: 'all', projectId: a.id }).total, 1);
  assert.equal(inspectSkill(local.id, { projectRoot: a.root }).scope, 'project');
  assert.equal(listSkills().total, 3);
});

test('assignment roles need explicit host-owned grants for project skills and cannot hide the usable global recipe', () => {
  enabled('common-check', 'Generic global procedure.');
  const local = enabled('common-check', 'Private project procedure.', { projectRoot: a.root });
  const child = { ...sessionA, role: 'executor' };
  assert.equal(listSkills({ session: child, enabledOnly: true }).skills[0].scope, 'global');
  assert.match(readSkill('common-check', { session: child }).text, /Generic global/);
  assert.throws(() => readSkill(local.id, { session: child, allowedSkillIds: [local.id] }), /not found/);
  child.allowedSkillIds = [local.id];
  assert.equal(listSkills({ session: child, enabledOnly: true }).skills[0].id, local.id);
  assert.match(readSkill(local.id, { session: child }).text, /Private project/);
});

test('project evidence bundles auto-scope in .bzzy and cannot be imported as a global method', () => {
  const source = packageAt(path.join(a.root, '.bzzy', 'skills', 'private-workflow'), 'private-workflow');
  assert.throws(() => importSkill(source, { scope: 'global' }), /project scope/);
  const imported = importSkill(source);
  assert.equal(imported.scope, 'project'); assert.equal(imported.projectId, a.id);
  assert.throws(() => readSkill(imported.id, { session: sessionB, enabledOnly: false }), /not found/);
  assert.equal(listSkills({ session: sessionB }).total, 0);
});

test('legacy managed project sync narrows access, retains its reviewed enable decision and archives the original', () => {
  const source = path.join(a.root, '.agents', 'skills', 'old-project-check'); fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'SKILL.md'), '---\nname: old-project-check\ndescription: Legacy project check.\n---\nSYNTHETIC_PRIVATE_CASE_A procedure.');
  const original = importSkill(source), on = setSkillEnabled(original.id, true, original.revision);
  const legacy = getRecord('core.skill', on.id); delete legacy.id; delete legacy.scope; delete legacy.provenance;
  putRecord('core.skill', original.name, legacy);
  putRecord('core.skill.codex-sync', original.name, { sourceId: digest(fs.realpathSync(source)), version: original.version });
  assert.equal(listSkills({ session: sessionB, enabledOnly: true }).total, 0);
  assert.throws(() => readSkill(original.name, { session: sessionB }), /scope review/);
  const options = { cwd: a.root, userHome: path.join(directory, 'empty-home'), codexHome: null, bzzyCodexHome: null, adminRoot: path.join(directory, 'empty-admin') };
  const result = syncCodexSkills(options); assert.equal(result.scoped, 1); assert.equal(result.unchanged, 1);
  const scoped = inspectSkill(original.name, { projectRoot: a.root }); assert.equal(scoped.enabled, true);
  assert.equal(getRecord('core.skill', original.name), null);
  assert.equal(listRecords('core.skill.archived').length, 1);
  assert.equal(listSkills({ session: sessionB, enabledOnly: true }).total, 0);
  assert.match(readSkill(scoped.id, { session: sessionA }).text, /PRIVATE_CASE_A/);
  assert.equal(syncCodexSkills(options).scoped, 0);
});

test('learning candidates are idempotent, scoped and inactive while the approved head keeps working', () => {
  const active = enabled('learned-check', 'Original approved workflow.', { projectRoot: a.root });
  const proposed = definition('learned-check', 'A revised workflow with a reproducible control and explicit stop conditions.');
  const candidate = stageSkillCandidate(proposed, { projectRoot: a.root, requestId: 'review-job:0', provenance: { kind: 'learning', jobId: 'review-job' } });
  assert.equal(stageSkillCandidate(proposed, { projectRoot: a.root, requestId: 'review-job:0' }).id, candidate.id);
  assert.equal(candidate.baseRevision, active.revision); assert.equal(candidate.state, 'pending');
  assert.match(readSkill(active.id, { session: sessionA }).text, /Original approved/);
  assert.equal(inspectSkill(active.id).enabled, true);
  assert.equal(listSkillCandidates({ session: sessionB }).total, 0);
  assert.throws(() => readSkillCandidate(candidate.id, { session: sessionB }), /not found/);
  assert.throws(() => stageSkillCandidate(definition('learned-check', 'Different same-request content.'), { projectRoot: a.root, requestId: 'review-job:0' }), /conflicts/);
  assert.equal(listRecords('execution').length, 0);
});

test('owner attestation or model-authored expected/actual pairs cannot activate a learning candidate', () => {
  let candidate = stageSkillCandidate(definition('candidate-check'), { projectRoot: a.root });
  assert.throws(() => evaluateSkillCandidate(candidate.id, { expectedRevision: 1, cases: [{ expected: 'real', actual: 'real' }] }), /Evaluation/);
  const attestation = verification(candidate, { authority: 'owner-attested' });
  candidate = evaluateSkillCandidate(candidate.id, { expectedRevision: candidate.revision, evaluationId: attestation.id });
  assert.throws(() => accept(candidate, attestation), /host-executed/);
  assert.equal(listSkills({ enabledOnly: true }).total, 0);
});

test('security acceptance pins complete representative coverage, fixture revision, candidate revision and current head', () => {
  let candidate = stageSkillCandidate(definition('candidate-check'), { projectRoot: a.root });
  const incomplete = verification(candidate, { categories: ['real', 'false_positive'] });
  candidate = evaluateSkillCandidate(candidate.id, { expectedRevision: candidate.revision, evaluationId: incomplete.id });
  assert.throws(() => accept(candidate, incomplete), /inconclusive fixture coverage/);
  const evaluation = verification(candidate);
  candidate = evaluateSkillCandidate(candidate.id, { expectedRevision: candidate.revision, evaluationId: evaluation.id });
  const fixture = getRecord('core.learning.fixtures', evaluation.fixtureId); fixture.revokedAt = new Date().toISOString(); putRecord('core.learning.fixtures', fixture.id, fixture);
  assert.throws(() => accept(candidate, evaluation), /revoked/);
  fixture.revokedAt = null; putRecord('core.learning.fixtures', fixture.id, fixture);
  assert.throws(() => acceptSkillCandidate(candidate.id, { expectedRevision: candidate.revision - 1, expectedSkillRevision: 0, expectedEvaluationId: evaluation.id, reviewed: true }), /changed/);
  const approved = accept(candidate, evaluation, { projectRoot: a.root });
  assert.equal(approved.enabled, true); assert.equal(approved.scope, 'project');
  assert.equal(inspectSkillCandidate(candidate.id).state, 'accepted');
  assert.throws(() => readSkill(approved.id, { session: sessionB }), /not found/);
});

test('evaluations cannot be rebound to another project or changed after review', () => {
  let candidate = stageSkillCandidate(definition('candidate-check'), { projectRoot: a.root });
  const wrongScope = verification(candidate, { projectId: b.id });
  assert.throws(() => evaluateSkillCandidate(candidate.id, { expectedRevision: candidate.revision, evaluationId: wrongScope.id }), /another project/);
  const evaluation = verification(candidate);
  candidate = evaluateSkillCandidate(candidate.id, { expectedRevision: candidate.revision, evaluationId: evaluation.id });
  assert.throws(() => evaluateSkillCandidate(candidate.id, { expectedRevision: candidate.revision, evaluationId: evaluation.id }), /earlier candidate revision/);
  putRecord('core.learning.evaluation', evaluation.id, { ...evaluation, status: 'failed' });
  assert.throws(() => accept(candidate, evaluation), /host-executed/);
  assert.equal(listSkills().total, 0);
});

test('immutable history permits explicit rollback without replay and catches externally changed payloads', () => {
  const original = enabled('versioned-check', 'Original approved workflow.', { projectRoot: a.root });
  const changed = createSkill(definition('versioned-check', 'Updated reviewed workflow.'), { projectRoot: a.root, expectedRevision: original.revision });
  assert.equal(changed.enabled, false);
  const restored = rollbackSkill(changed.id, original.version, changed.revision, { projectRoot: a.root });
  assert.equal(restored.version, original.version); assert.equal(restored.enabled, false);
  assert.match(readSkill(restored.id, { enabledOnly: false }).text, /Original approved/);
  assert.ok(skillHistory(restored.id).entries.some(entry => entry.action === 'rollback'));
  const file = path.join(process.env.BZZY_HOME, 'skills', '_projects', digest(a.id), restored.name, original.version, 'SKILL.md');
  fs.writeFileSync(file, 'Externally changed workflow.');
  assert.throws(() => rollbackSkill(restored.id, original.version, restored.revision), /content changed/);
  assert.equal(listRecords('execution').length, 0);
});

test('global promotion authors a separate generic candidate without copying private project references', () => {
  const source = importSkill(packageAt(path.join(directory, 'source'), 'project-check'), { projectRoot: a.root });
  const sourceBefore = readSkill(source.id, { file: 'references/run-records.jsonl', enabledOnly: false }).text;
  assert.throws(() => promoteSkill(source.id, { ...definition('global-check', 'Read https://private.fixture.invalid/resource'), expectedRevision: source.revision, reviewed: true }, { projectRoot: a.root }), /parameterized/);
  for (const endpoint of ['api.client.example', 'client.internal', '2001:db8::1234']) {
    assert.throws(() => promoteSkill(source.id, { ...definition('global-check', `Compare the baseline on ${endpoint}.`), expectedRevision: source.revision, reviewed: true }, { projectRoot: a.root }), /parameterized/);
  }
  let candidate = promoteSkill(source.id, { ...definition('global-check'), expectedRevision: source.revision, reviewed: true }, { projectRoot: a.root });
  assert.equal(candidate.scope, 'global'); assert.deepEqual(candidate.files.map(file => file.path), ['SKILL.md']);
  assert.doesNotMatch(readSkillCandidate(candidate.id).text, /PRIVATE_CASE_A|private\.fixture|run-records/);
  const evaluation = verification(candidate, { projectId: null });
  candidate = evaluateSkillCandidate(candidate.id, { expectedRevision: candidate.revision, evaluationId: evaluation.id });
  const global = accept(candidate, evaluation);
  assert.match(readSkill(global.id, { session: sessionB }).text, /controlled comparisons/);
  assert.equal(readSkill(source.id, { file: 'references/run-records.jsonl', enabledOnly: false }).text, sourceBefore);
  assert.equal(listRecords('execution').length, 0);
});

test('rejecting a pending revision keeps the active method and blocks stale owner decisions', () => {
  const active = enabled('active-check', 'Approved original method.', { projectRoot: a.root });
  const candidate = stageSkillCandidate(definition('active-check'), { projectRoot: a.root });
  const rejected = rejectSkillCandidate(candidate.id, candidate.revision, { projectRoot: a.root });
  assert.equal(rejected.state, 'rejected');
  assert.throws(() => rejectSkillCandidate(candidate.id, candidate.revision, { projectRoot: a.root }), /changed/);
  assert.match(readSkill(active.id, { session: sessionA }).text, /Approved original/);
});
