import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { importSkill, inspectSkill, setSkillEnabled, readSkill, previewSkillGlobalMove, moveSkillToGlobal } from '../src/engine/skills.js';
import { getRecord, listRecords, digest } from '../src/engine/database.js';

let root, previous, project, other, folder;
test.beforeEach(() => {
  previous = process.env.BZZY_HOME; root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-skill-move-')));
  process.env.BZZY_HOME = path.join(root, 'private'); project = path.join(root, 'project'); other = path.join(root, 'other');
  fs.mkdirSync(project); fs.mkdirSync(other); folder = path.join(root, 'codex-source');
  for (const name of ['scripts', 'references', 'assets']) fs.mkdirSync(path.join(folder, name), { recursive: true });
  fs.writeFileSync(path.join(folder, 'SKILL.md'), '---\nname: portable-check\ndescription: Compare controlled responses.\n---\nInspect the supplied response, compare controls, and preserve uncertainty.\n');
  fs.writeFileSync(path.join(folder, 'scripts', 'check.py'), 'print("controlled fixture; not executed")\n');
  fs.writeFileSync(path.join(folder, 'references', 'method.md'), 'Use a positive and a negative control.\n');
  fs.writeFileSync(path.join(folder, 'assets', 'sample.bin'), Buffer.from([0, 255, 14, 88]));
});
test.afterEach(() => { if (previous == null) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous; fs.rmSync(root, { recursive: true, force: true }); });
const install = () => importSkill(folder, { projectRoot: project, scope: 'project' });
const review = skill => previewSkillGlobalMove(skill.id, { projectRoot: project });
const move = draft => moveSkillToGlobal(draft, { projectRoot: project, reviewed: true });

test('reviewed move preserves the exact portable package and archives only the project registry entry', () => {
  const imported = install(), skill = setSkillEnabled(imported.id, true, imported.revision, { projectRoot: project });
  const original = getRecord('core.skill', skill.id), localPackage = path.join(process.env.BZZY_HOME, 'skills', '_projects', digest(skill.projectId), skill.name, skill.version);
  const draft = review(skill); assert.equal(draft.files.length, 4); assert.equal(draft.sourceVersion, skill.version); assert.equal(draft.sourceEnabled, true);
  assert.equal(getRecord('core.skill', skill.name), null); assert.deepEqual(getRecord('core.skill', skill.id), original);
  const moved = move(draft); assert.equal(moved.scope, 'global'); assert.equal(moved.enabled, false); assert.equal(moved.version, skill.version);
  assert.equal(getRecord('core.skill', skill.id), null); assert.equal(inspectSkill(skill.name, { scope: 'global' }).id, skill.name);
  assert.equal(fs.existsSync(localPackage), true); assert.equal(fs.existsSync(folder), true);
  for (const file of moved.files) assert.deepEqual(fs.readFileSync(path.join(process.env.BZZY_HOME, 'skills', moved.name, moved.version, file.path)), fs.readFileSync(path.join(folder, file.path)));
  assert.match(readSkill(moved.id, { scope: 'global', enabledOnly: false, file: 'scripts/check.py' }).text, /not executed/);
  assert.throws(() => readSkill(moved.id, { scope: 'global' }), /disabled/);
  assert.equal(listRecords('core.skill.archived').filter(item => item.id === skill.id && item.reason === 'global-scope-move' && item.movedTo === moved.id).length, 1);
  assert.ok(listRecords('core.skill.history').some(item => item.skillId === skill.id && item.action === 'enable'));
  assert.ok(listRecords('core.skill.history').some(item => item.skillId === moved.id && item.action === 'move-from-project'));
});

test('global name conflicts and stale source/destination revisions never overwrite either entry', () => {
  let skill = install(), draft = review(skill);
  skill = setSkillEnabled(skill.id, true, skill.revision, { projectRoot: project });
  assert.throws(() => move(draft), /changed|review/); assert.equal(getRecord('core.skill', skill.name), null);
  draft = review(skill); const existing = importSkill(folder, { scope: 'global' });
  assert.throws(() => move(draft), /already has|overwrites/); assert.deepEqual(inspectSkill(existing.name, { scope: 'global' }), existing);
  assert.equal(inspectSkill(skill.id, { projectRoot: project }).enabled, true); assert.equal(listRecords('core.skill.archived').length, 0);
});

test('moves reject unreviewed/tampered plans, foreign project IDs and host changes', () => {
  const skill = install(), draft = review(skill);
  assert.throws(() => moveSkillToGlobal(draft, { projectRoot: project }), /Review/);
  for (const changed of [{ ...draft, destinationId: '../escape' }, { ...draft, sourceRevision: 999 }, { ...draft, files: [] }]) assert.throws(() => move(changed), /changed|review/);
  assert.throws(() => previewSkillGlobalMove(skill.id, { projectRoot: other }), /not found/);
  assert.throws(() => previewSkillGlobalMove(skill.id, { projectId: skill.projectId }), /project directory/);
  for (const id of ['../escape', 'project:../../foreign:portable-check', 'global:portable-check']) assert.throws(() => previewSkillGlobalMove(id, { projectRoot: project }));
  const originalHome = process.env.BZZY_HOME; process.env.BZZY_HOME = path.join(root, 'different-private');
  assert.throws(() => move(draft)); process.env.BZZY_HOME = originalHome;
  assert.equal(inspectSkill(skill.id, { projectRoot: project }).version, skill.version); assert.equal(getRecord('core.skill', skill.name), null);
});

test('a replaced source version or preexisting destination payload cannot be overwritten by a reviewed move', () => {
  const initial = install(), draft = review(initial);
  fs.appendFileSync(path.join(folder, 'SKILL.md'), '\nAn owner added a new control.\n');
  const changed = importSkill(folder, { projectRoot: project, scope: 'project', expectedRevision: initial.revision });
  assert.notEqual(changed.version, initial.version); assert.throws(() => move(draft), /changed|review/);
  const destination = path.join(process.env.BZZY_HOME, 'skills', changed.name, changed.version);
  fs.mkdirSync(destination, { recursive: true }); fs.writeFileSync(path.join(destination, 'owner-kept.txt'), 'Never overwrite this package.');
  assert.throws(() => review(changed), /storage already exists/);
  assert.equal(fs.readFileSync(path.join(destination, 'owner-kept.txt'), 'utf8'), 'Never overwrite this package.');
  assert.equal(inspectSkill(changed.id, { projectRoot: project }).version, changed.version); assert.equal(getRecord('core.skill', changed.name), null);
});

test('private project packages and newly introduced credentials cannot enter global scope', () => {
  for (const relative of ['project-scope.json', 'references/run-records.jsonl', 'References/Evidence.json', 'assets/source-goal.json']) {
    const file = path.join(folder, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '{}');
    const current = (() => { try { return inspectSkill('portable-check', { projectRoot: project, scope: 'project' }); } catch { return null; } })();
    const skill = importSkill(folder, { projectRoot: project, scope: 'project', expectedRevision: current?.revision || 0 });
    assert.throws(() => review(skill), /private project|generic global promotion/); fs.unlinkSync(file);
  }
  const current = inspectSkill('portable-check', { projectRoot: project, scope: 'project' });
  const safe = importSkill(folder, { projectRoot: project, scope: 'project', expectedRevision: current.revision }), draft = review(safe);
  const installed = path.join(process.env.BZZY_HOME, 'skills', '_projects', digest(safe.projectId), safe.name, safe.version, 'scripts', 'check.py');
  fs.writeFileSync(installed, 'API_KEY="sk-syntheticMoveCredential123456789"');
  assert.throws(() => move(draft), /credential|changed/); assert.equal(getRecord('core.skill', safe.name), null);
});
