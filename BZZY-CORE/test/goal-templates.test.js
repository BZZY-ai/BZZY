import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSession, saveSession } from '../src/engine/store.js';
import { newGoal } from '../src/engine/goals.js';
import { database, listRecords, putRecord } from '../src/engine/database.js';
import { saveGoalTemplate, listGoalTemplates, getSavedGoalTemplate, hasGoalTemplateObjective, deleteGoalTemplate } from '../src/engine/goal-templates.js';
import { listLibraryExportChoices } from '../src/engine/definition-bundle.js';

let directory, previous;
test.beforeEach(() => {
  previous = process.env.BZZY_HOME;
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-manual-goals-')));
  process.env.BZZY_HOME = path.join(directory, 'private');
});
test.afterEach(() => {
  if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
  fs.rmSync(directory, { recursive: true, force: true });
});
const state = () => ({ records: database().prepare('SELECT * FROM records ORDER BY kind,id').all(), events: database().prepare('SELECT * FROM events ORDER BY seq').all() });

test('execution and replacement history never populate the saved-goal Library or export choices', () => {
  const session = createSession({ id: 'codex', backend: 'codex' }, directory, 'offline-model');
  for (const status of ['active', 'paused', 'stalled', 'complete']) {
    session.goal = { ...newGoal('An executed objective'), status }; saveSession(session);
    putRecord('goal-history', session.goal.id, { sessionId: session.id, goal: session.goal });
  }
  const before = state();
  assert.deepEqual(listGoalTemplates(), { goals: [], total: 0, nextOffset: null });
  assert.equal(listLibraryExportChoices({ cwd: directory, kinds: ['goal'] }).entries.length, 0);
  assert.equal(hasGoalTemplateObjective(session.goal.objective), false);
  assert.deepEqual(state(), before);
  const saved = saveGoalTemplate({ objective: session.goal.objective });
  assert.deepEqual(saveGoalTemplate({ objective: '  An executed objective  ' }), saved);
  assert.equal(listGoalTemplates().total, 1); assert.equal(listRecords('execution').length, 0);
  assert.equal(hasGoalTemplateObjective(session.goal.objective), true);
});

test('manual templates paginate deterministically and reread full objectives without session authority or mutations', () => {
  for (let index = 0; index < 23; index++) {
    const objective = `Saved objective ${index}\nFull requirement Ω.`;
    const record = saveGoalTemplate({ objective });
    putRecord('core.goal.template', record.id, { ...record, createdAt: new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString() });
  }
  const before = state(), first = listGoalTemplates(), last = listGoalTemplates({ offset: first.nextOffset });
  assert.equal(first.total, 23); assert.equal(first.goals.length, 20); assert.equal(first.nextOffset, 20);
  assert.equal(last.goals.length, 3); assert.equal(last.nextOffset, null);
  assert.equal(first.goals[0].objective, 'Saved objective 22\nFull requirement Ω.');
  assert.equal(last.goals.at(-1).objective, 'Saved objective 0\nFull requirement Ω.');
  for (const goal of [...first.goals, ...last.goals]) {
    assert.equal(goal.source, 'template'); assert.equal(goal.sessionId, null); assert.equal(goal.status, null);
    assert.deepEqual(getSavedGoalTemplate(goal.id, { revision: goal.revision }), goal);
  }
  assert.deepEqual(state(), before); assert.equal(listRecords('session').length, 0);
});

test('invalid pages, changed revisions and damaged templates fail closed', () => {
  for (const input of [null, [], { sessionId: 'unexpected' }, { offset: -1 }, { limit: 101 }, { limit: 0 }]) assert.throws(() => listGoalTemplates(input));
  const record = saveGoalTemplate({ objective: 'Saved control' }), entry = listGoalTemplates().goals[0];
  assert.throws(() => getSavedGoalTemplate(entry.id, { revision: '0'.repeat(64) }), { code: 'CONFLICT' });
  assert.throws(() => getSavedGoalTemplate('not-a-current-template'));
  putRecord('core.goal.template', record.id, { ...record, objective: 'Unreviewed modification' });
  assert.throws(() => getSavedGoalTemplate(entry.id), { code: 'CONFLICT' });
  assert.throws(() => listGoalTemplates(), { code: 'CONFLICT' });
});

test('removing a saved goal preserves executions and history; explicit restoration invalidates old picker revisions', () => {
  const session = createSession({ id: 'codex', backend: 'codex' }, directory, 'offline-model');
  session.goal = { ...newGoal('Keep the completed goal and its history'), status: 'complete', evidence: ['retained-evidence'] }; saveSession(session);
  const template = saveGoalTemplate({ objective: session.goal.objective }), entry = listGoalTemplates().goals[0];
  const executions = listRecords('session'), beforeEvents = state().events;
  assert.throws(() => deleteGoalTemplate(entry.id), { code: 'INVALID_REQUEST' });
  deleteGoalTemplate(entry.id, { revision: entry.revision });
  assert.equal(listGoalTemplates().total, 0); assert.equal(hasGoalTemplateObjective(entry.objective), false);
  assert.throws(() => getSavedGoalTemplate(entry.id), { code: 'SAVED_GOAL_UNAVAILABLE' });
  assert.deepEqual(listRecords('session'), executions); assert.deepEqual(state().events, beforeEvents);
  assert.equal(listRecords('execution').length, 0); assert.equal(listRecords('core.goal.template.removal').length, 1);
  const restored = saveGoalTemplate({ objective: entry.objective }); assert.equal(restored.id, template.id); assert.equal(restored.revision, 3);
  const current = listGoalTemplates().goals[0]; assert.notEqual(current.revision, entry.revision);
  assert.throws(() => deleteGoalTemplate(entry.id, { revision: entry.revision }), { code: 'CONFLICT' });
  assert.deepEqual(saveGoalTemplate({ objective: entry.objective }), restored); assert.equal(listGoalTemplates().total, 1);
});

test('damaged removed templates cannot silently overwrite their history during restoration', () => {
  const record = saveGoalTemplate({ objective: 'Retain the immutable objective' }), entry = listGoalTemplates().goals[0];
  deleteGoalTemplate(entry.id, { revision: entry.revision });
  putRecord('core.goal.template', record.id, { ...record, revision: 2, deletedAt: new Date().toISOString(), objective: 'Tampered objective' });
  assert.throws(() => saveGoalTemplate({ objective: record.objective }), { code: 'CONFLICT' });
});
