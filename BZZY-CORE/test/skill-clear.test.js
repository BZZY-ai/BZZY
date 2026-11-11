import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSession } from '../src/engine/store.js';
import { getProvider } from '../src/engine/providers.js';
import { getRecord, putRecord, listRecords } from '../src/engine/database.js';
import { resolveProjectIdentity } from '../src/engine/project-identity.js';
import { createSkill, inspectSkill, listSkills, setSkillEnabled, previewSkillClear, clearSkills } from '../src/engine/skills.js';

let directory, previous, a, b;
test.beforeEach(() => {
  previous = process.env.BZZY_HOME;
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-skill-clear-')));
  process.env.BZZY_HOME = path.join(directory, 'private');
  for (const name of ['a', 'b']) fs.mkdirSync(path.join(directory, name));
  a = resolveProjectIdentity(path.join(directory, 'a'), { create: true });
  b = resolveProjectIdentity(path.join(directory, 'b'), { create: true });
});
test.afterEach(() => {
  if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
  fs.rmSync(directory, { recursive: true, force: true });
});
const skill = (name, options = { scope: 'global' }) => createSkill({ name, description: `Fixture ${name}.`, instructions: `Follow ${name}.` }, options);
function library() {
  const enabled = skill('global-enabled'); setSkillEnabled(enabled.id, true, enabled.revision, { scope: 'global' });
  skill('global-disabled'); skill('shared-name');
  const local = { projectRoot: a.root, scope: 'project' };
  skill('project-only', local); skill('shared-name', local);
  skill('other-project', { projectRoot: b.root, scope: 'project' });
}

test('clear review counts every project and global entry, including a shadowed global, and leaves other projects alone', () => {
  library();
  const review = previewSkillClear({ projectRoot: a.root });
  assert.equal(review.total, 5); assert.equal(review.project, 2); assert.equal(review.global, 3);
  assert.equal(listSkills({ projectRoot: a.root }).total, 4, 'the library list hides the global shared-name behind the project copy');
  assert.ok(review.skills.some(item => item.scope === 'global' && item.name === 'shared-name'));
  assert.equal(review.skills.some(item => item.name === 'other-project'), false);
  assert.equal(listSkills().total, 6, 'a review changes nothing');

  const session = createSession(getProvider('codex'), a.root, 'fixture-model');
  assert.equal(previewSkillClear({ session }).fingerprint, review.fingerprint);
  assert.equal(previewSkillClear({ scope: 'global', include: 'global' }).total, 3);
  assert.equal(previewSkillClear({ projectRoot: a.root, include: 'project' }).total, 2);
  assert.equal(previewSkillClear({}).total, 3, 'without a project, only global skills are in scope');
  assert.throws(() => previewSkillClear({ include: 'project' }), /project directory/);
});

test('confirmed clear deletes exactly the reviewed entries atomically, keeps history and stops learning recreation', () => {
  library();
  const shared = inspectSkill('shared-name', { scope: 'global' });
  putRecord('core.learning.skill-publication', 'fixture-receipt', { id: 'fixture-receipt', skillId: shared.id, state: 'published' });
  const review = previewSkillClear({ projectRoot: a.root });
  assert.throws(() => clearSkills(review, { projectRoot: a.root }), /Review the skills/);
  assert.throws(() => clearSkills({ ...review, fingerprint: undefined }, { projectRoot: a.root, reviewed: true }), /Review the skills/);
  assert.equal(listSkills().total, 6);

  const result = clearSkills(review, { projectRoot: a.root, reviewed: true });
  assert.equal(result.deleted, 5); assert.equal(result.project, 2); assert.equal(result.global, 3);
  assert.equal(listSkills({ projectRoot: a.root }).total, 0);
  assert.equal(listSkills({ projectRoot: b.root, scope: 'project' }).total, 1);
  for (const item of review.skills) {
    assert.equal(getRecord('core.skill.deleted', item.id).revision, item.revision + 1);
    assert.ok(listRecords('core.skill.history').some(entry => entry.skillId === item.id && entry.action === 'delete'));
  }
  assert.equal(getRecord('core.learning.skill-publication', 'fixture-receipt').state, 'deleted');
  assert.throws(() => clearSkills(review, { projectRoot: a.root, reviewed: true }), /changed/, 'a used review cannot run twice');
  // A recreated name continues after its deletion receipt instead of reusing an old revision.
  assert.equal(skill('global-enabled').revision, review.skills.find(item => item.name === 'global-enabled').revision + 2);
});

test('any change after the review cancels the whole clear', () => {
  library();
  const toggled = previewSkillClear({ projectRoot: a.root }), current = inspectSkill('global-disabled', { scope: 'global' });
  setSkillEnabled(current.id, true, current.revision, { scope: 'global' });
  assert.throws(() => clearSkills(toggled, { projectRoot: a.root, reviewed: true }), /changed/);
  assert.equal(listSkills().total, 6);

  const added = previewSkillClear({ projectRoot: a.root }); skill('arrived-later');
  assert.throws(() => clearSkills(added, { projectRoot: a.root, reviewed: true }), /changed/);
  assert.equal(listSkills().total, 7);

  const moved = previewSkillClear({ projectRoot: a.root });
  assert.throws(() => clearSkills(moved, { projectRoot: b.root, reviewed: true }), /changed/, 'another project cannot reuse this review');
  assert.equal(listSkills().total, 7);
});
