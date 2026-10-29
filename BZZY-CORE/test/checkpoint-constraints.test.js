import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSession, saveSession } from '../src/engine/store.js';
import { BUILTINS } from '../src/engine/providers.js';
import { initializeProject } from '../src/engine/project.js';
import { checkpoint } from '../src/engine/memory.js';
import { getRecord, putRecord, digest } from '../src/engine/database.js';

let home, prior, session;
test.beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-constraints-repair-')));
  prior = process.env.BZZY_HOME; process.env.BZZY_HOME = path.join(home, 'private');
  const cwd = path.join(home, 'project'); fs.mkdirSync(cwd);
  session = createSession(BUILTINS.codex, cwd); initializeProject(session);
  session.goal = { id: randomUUID(), status: 'active', objective: 'Review a fictional offline fixture.' };
  session.contract = { objective: session.goal.objective, constraints: ['Use offline fixtures only.'] }; saveSession(session);
});
test.afterEach(() => {
  if (prior === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = prior;
  fs.rmSync(home, { recursive: true, force: true });
});

test('working constraints replace instead of accumulating across a long goal, with original revisions retained', () => {
  const first = checkpoint(session, { constraints: ['Current working condition 0.'] });
  let current;
  for (let index = 1; index < 75; index++) current = checkpoint(session, { constraints: [`Current working condition ${index}.`], pendingActions: ['Continue the authorized fixture.'] });
  assert.deepEqual(current.constraints, ['Use offline fixtures only.', 'Current working condition 74.']);
  assert.deepEqual(current.workingConstraints, ['Current working condition 74.']);
  assert.deepEqual(getRecord('core.checkpoint.revision', `${session.id}:${first.revision}`), first);
  assert.ok(current.itemArchive.some(item => item.archivedAtRevision === current.revision));
  const unchanged = checkpoint(session, { decisions: ['Keep investigating.'] });
  assert.deepEqual(unchanged.constraints, current.constraints);
  const cleared = checkpoint(session, { constraints: [] });
  assert.deepEqual(cleared.constraints, session.contract.constraints); assert.deepEqual(cleared.workingConstraints, []);
  const owned = cleared.items.find(item => item.contractOwned);
  assert.throws(() => checkpoint(session, { itemOperations: [{ op: 'archive', field: 'constraints', id: owned.id, expectedItemRevision: owned.revision }] }), /Contract-owned/);
});

test('exact repeated declarations count explicit writes, not inheritance, retries or confidence', () => {
  const first = checkpoint(session, { constraints: ['Retest the saved fixture.'], requestId: 'first' });
  assert.equal(first.constraintView.find(item => item.text === 'Retest the saved fixture.').count, 1);
  const repeated = checkpoint(session, { constraints: ['Retest the saved fixture.'], requestId: 'second' });
  assert.equal(repeated.constraintView.find(item => item.text === 'Retest the saved fixture.').count, 2);
  assert.deepEqual(checkpoint(session, { constraints: ['Retest the saved fixture.'], requestId: 'second' }), repeated);
  const other = checkpoint(session, { pendingActions: ['Read the fixture.'] });
  assert.equal(other.constraintView.find(item => item.text === 'Retest the saved fixture.').count, 2);
  assert.equal(other.constraintView.find(item => item.text === 'Use offline fixtures only.').count, 1);
  assert.equal(checkpoint(session, { constraints: ['  Retest the saved fixture.  '] }).constraintView.find(item => item.text === 'Retest the saved fixture.').count, 3);
  assert.deepEqual(checkpoint(session, { constraints: ['Only /Admin', 'Only /admin', 'Do not test A', 'Do test A'] }).workingConstraints,
    ['Only /Admin', 'Only /admin', 'Do not test A', 'Do test A']);
});

test('legacy excess cannot prevent unrelated checkpoint saves and contract items do not consume the working allowance', () => {
  const first = checkpoint(session, { constraints: ['Before upgrade.'] });
  const legacy = { ...first, constraints: [...session.contract.constraints, ...Array.from({ length: 70 }, (_, index) => `Legacy working condition ${index}.`)] };
  delete legacy.items; delete legacy.workingConstraints;
  putRecord('checkpoint', session.id, legacy); putRecord('core.checkpoint.scope', `${session.id}:${digest(legacy.scope)}`, legacy);
  assert.equal(checkpoint(session, { pendingActions: ['Progress still saves.'] }).workingConstraints.length, 70);
  assert.equal(checkpoint(session, { constraints: ['Replacement list.'] }).workingConstraints.length, 1);
  session.contract.constraints = Array.from({ length: 60 }, (_, index) => `Mandatory contract constraint ${index}.`); saveSession(session);
  const current = checkpoint(session, { constraints: ['One working condition.'] });
  assert.equal(current.constraints.length, 61); assert.equal(current.workingConstraints.length, 1);
});
