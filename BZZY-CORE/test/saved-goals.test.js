import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { database, getRecord, putRecord, transaction } from '../src/engine/database.js';
import { listSavedGoals, getSavedGoal } from '../src/engine/saved-goals.js';

let directory, workspace, previousHome;
test.beforeEach(() => {
  previousHome = process.env.BZZY_HOME;
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-saved-goals-'));
  workspace = path.join(directory, 'workspace'); fs.mkdirSync(workspace);
  process.env.BZZY_HOME = path.join(directory, 'private');
});
test.afterEach(() => {
  if (previousHome === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previousHome;
  fs.rmSync(directory, { recursive: true, force: true });
});

function seed(objective, { sessionId = randomUUID(), goalId = randomUUID(), createdAt = '2026-10-01T12:00:00.000Z', session = {}, goal = {} } = {}) {
  const saved = { id: sessionId, cwd: workspace, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    executionState: 'idle', goal: { id: goalId, objective, createdAt, status: 'complete', ...goal }, ...session };
  putRecord('session', sessionId, saved);
  return { session: saved, id: `${sessionId}:${goalId}`, goal: saved.goal };
}
function archive(saved) {
  putRecord('goal-history', saved.goal.id, { sessionId: saved.session.id, ...saved.goal, clearedAt: '2026-11-01T00:00:00.000Z' });
  putRecord('session', saved.session.id, { ...saved.session, goal: null });
}
function snapshot(db = database()) {
  return { records: db.prepare('SELECT * FROM records ORDER BY kind,id').all(),
    events: db.prepare('SELECT * FROM events ORDER BY seq').all(), requests: db.prepare('SELECT * FROM requests ORDER BY scope,id').all(),
    changes: db.prepare('SELECT total_changes() AS count').get().count };
}

test('listing and resolving goals are read-only, bounded projections with no execution or recall writes', () => {
  const db = database(), empty = snapshot(db);
  assert.deepEqual(listSavedGoals(), { goals: [], total: 0, nextOffset: null });
  assert.deepEqual(snapshot(db), empty);
  const saved = seed('Inspect the local fixture'), before = snapshot(db);
  const first = listSavedGoals();
  assert.equal(first.total, 1); assert.equal(first.goals[0].id, saved.id);
  assert.equal(first.goals[0].alias, null, 'Unnamed root terminal goals are reusable');
  assert.deepEqual(getSavedGoal(saved.id, { revision: first.goals[0].revision }), first.goals[0]);
  assert.deepEqual(listSavedGoals(), first);
  assert.deepEqual(snapshot(db), before);
  transaction(() => {
    assert.deepEqual(listSavedGoals(), first, 'A caller-owned transaction does not cause a nested BEGIN');
    assert.deepEqual(getSavedGoal(saved.id), first.goals[0]);
  });
  assert.deepEqual(snapshot(db), before);
});

test('recent ordering uses goal creation, full exact trimmed text deduplicates, and multiline text stays intact', () => {
  const objective = 'Review HTTP responses\n\nPreserve headers,  spacing and Ω.';
  seed(`\u00a0\ufeff${objective}\n `, { createdAt: '2026-10-01T12:00:00.000Z' });
  const newest = seed(objective, { createdAt: '2026-10-02T12:00:00.000Z', session: { alias: 'HTTP review' } });
  const chronologicalLast = seed('Check one more response', { createdAt: '2026-10-02T11:30:00.000-01:00' });
  const oldest = seed('Older goal', { createdAt: '2026-09-01T00:00:00.000Z' });
  putRecord('session', oldest.session.id, { ...oldest.session, updatedAt: '2099-01-01T00:00:00.000Z' });
  const result = listSavedGoals();
  assert.equal(result.total, 3);
  assert.deepEqual(result.goals.map(goal => goal.id), [chronologicalLast.id, newest.id, oldest.id]);
  assert.equal(result.goals[1].objective, objective); assert.equal(result.goals[1].alias, 'HTTP review');
  seed(objective.toLowerCase()); seed(objective.replace('  spacing', ' spacing'));
  assert.equal(listSavedGoals().total, 5, 'Case and internal whitespace differences are separate objectives');
});

test('replacement and clear paths retain saved objectives without reviving original outcome or execution authority', async () => {
  const { createSession } = await import('../src/engine/store.js');
  const { BUILTINS } = await import('../src/engine/providers.js');
  const { startConversationGoal, controlSavedGoal } = await import('../src/engine/host-commands.js');
  const session = createSession(BUILTINS.codex, workspace);
  startConversationGoal(session, {}, 'First accepted objective');
  const first = getSavedGoal(`${session.id}:${session.goal.id}`);
  session.goal.evidence = ['private-old-evidence']; session.goal.status = 'complete';
  startConversationGoal(session, {}, 'Second accepted objective');
  const secondID = `${session.id}:${session.goal.id}`;
  assert.deepEqual(getSavedGoal(first.id, { revision: first.revision }).objective, first.objective);
  await controlSavedGoal(session, 'clear', {}, { event() {} });
  const rows = listSavedGoals().goals;
  assert.equal(rows.length, 2);
  assert.ok(rows.some(row => row.id === first.id)); assert.ok(rows.some(row => row.id === secondID));
  assert.equal(getRecord('session', session.id).goal, null);
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), ['alias', 'createdAt', 'cwd', 'goalId', 'id', 'objective', 'revision', 'sessionId', 'status']);
    assert.equal(row.evidence, undefined); assert.equal(row.contract, undefined); assert.equal(row.policy, undefined);
    assert.equal(row.workflow, undefined); assert.equal(row.tokenBudget, undefined);
  }
  assert.equal(database().prepare("SELECT count(*) AS count FROM records WHERE kind='execution'").get().count, 0);
});

test('history excludes deleted, worker, Agent, nonterminal and imported contexts, including retained audit rows', () => {
  const kept = seed('Keep this root goal');
  const exclusions = [
    { parentSessionId: randomUUID() }, { parallelSessionId: randomUUID() }, { canvasParentId: randomUUID() },
    { assignmentId: randomUUID() }, { role: 'reviewer' }, { purpose: 'agent' }, { purpose: 'document-draft' },
    { importedUntrusted: true }, { deletedAt: '2026-10-03T00:00:00.000Z' },
  ];
  for (const [index, session] of exclusions.entries()) {
    const saved = seed(`Exclude source ${index}`, { session }); archive(saved);
    assert.throws(() => getSavedGoal(saved.id), { code: 'SAVED_GOAL_UNAVAILABLE' });
  }
  const tombstoned = seed('Deleted source'); archive(tombstoned);
  putRecord('session-deletion', tombstoned.session.id, { sessionId: tombstoned.session.id });
  const registeredAgent = seed('Agent missing its legacy purpose'); archive(registeredAgent);
  putRecord('core.agent', randomUUID(), { sessionId: registeredAgent.session.id });
  putRecord('goal-history', randomUUID(), { id: randomUUID(), sessionId: randomUUID(), objective: 'Dangling history', createdAt: kept.goal.createdAt });
  assert.deepEqual(listSavedGoals().goals.map(row => row.id), [kept.id]);
  assert.throws(() => getSavedGoal(tombstoned.id), { code: 'SAVED_GOAL_UNAVAILABLE' });
  assert.throws(() => getSavedGoal(registeredAgent.id), { code: 'SAVED_GOAL_UNAVAILABLE' });
});

test('selection rechecks exact source and content revisions without substituting another duplicate', () => {
  const original = seed('Reusable objective', { session: { alias: 'Original source' } });
  const shown = getSavedGoal(original.id);
  const newer = seed('Reusable objective', { createdAt: '2026-11-01T00:00:00.000Z' });
  assert.equal(listSavedGoals().goals[0].id, newer.id);
  assert.deepEqual(getSavedGoal(shown.id, { revision: shown.revision }), shown, 'A newer duplicate does not replace the chosen source');
  putRecord('session', original.session.id, { ...original.session, goal: { ...original.goal, status: 'paused', tokensUsed: 200 } });
  assert.equal(getSavedGoal(shown.id, { revision: shown.revision }).status, 'paused', 'Outcome changes do not alter reusable text');
  putRecord('session', original.session.id, { ...original.session, goal: { ...original.goal, objective: 'Changed objective' } });
  assert.throws(() => getSavedGoal(shown.id, { revision: shown.revision }), { code: 'CONFLICT' });
  putRecord('session', original.session.id, { ...original.session, alias: 'Renamed source' });
  assert.throws(() => getSavedGoal(shown.id, { revision: shown.revision }), { code: 'CONFLICT' });
  putRecord('session-deletion', original.session.id, { sessionId: original.session.id });
  assert.throws(() => getSavedGoal(shown.id, { revision: shown.revision }), { code: 'SAVED_GOAL_UNAVAILABLE' });
  assert.equal(listSavedGoals().goals[0].id, newer.id);
});

test('paging has stable tie ordering, exact totals, safe bounds and no silent objective truncation', () => {
  const ids = [];
  for (let index = 0; index < 137; index++) ids.push(seed(`Goal ${index}`).id);
  ids.sort();
  const first = listSavedGoals(); assert.equal(first.goals.length, 20); assert.equal(first.total, 137); assert.equal(first.nextOffset, 20);
  const all = []; let offset = 0;
  do {
    const page = listSavedGoals({ offset, limit: 17 }); all.push(...page.goals.map(row => row.id)); offset = page.nextOffset;
  } while (offset !== null);
  assert.deepEqual(all, ids); assert.equal(new Set(all).size, 137);
  assert.equal(listSavedGoals({ limit: 100 }).goals.length, 100);
  assert.deepEqual(listSavedGoals({ offset: 1000 }), { goals: [], total: 137, nextOffset: null });
  for (const options of [null, [], { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: '20' }, { offset: -1 },
    { offset: Number.MAX_SAFE_INTEGER + 1 }, { offset: Infinity }, { offset: '0' }, { query: 'unbounded option' }]) {
    assert.throws(() => listSavedGoals(options), { code: 'INVALID_REQUEST' });
  }
  const long = 'Preserve the full task\n' + 'Ω '.repeat(9000), saved = seed(long, { createdAt: '2026-12-01T00:00:00.000Z' });
  assert.equal(listSavedGoals().goals[0].objective, long.trim());
  assert.equal(getSavedGoal(saved.id).objective, long.trim());
});

test('malformed source records are unavailable and current source changes cannot fall back to stale archive text', () => {
  const saved = seed('Current objective');
  putRecord('goal-history', saved.goal.id, { sessionId: saved.session.id, ...saved.goal, objective: 'Stale text for same identity' });
  assert.equal(getSavedGoal(saved.id).objective, 'Current objective'); assert.equal(listSavedGoals().total, 1);
  putRecord('session', saved.session.id, { ...saved.session, goal: { ...saved.goal, objective: '' } });
  assert.throws(() => getSavedGoal(saved.id), { code: 'SAVED_GOAL_UNAVAILABLE' });
  seed('No timestamp', { goal: { createdAt: undefined } }); seed('Bad timestamp', { createdAt: 'not-a-date' });
  seed('No objective', { goal: { objective: null } }); seed('Blank objective', { goal: { objective: ' \n\t\u00a0' } });
  seed('Malformed identity', { goalId: '0000000--0000-0000-0000-000000000000' });
  assert.equal(listSavedGoals().total, 0);
  for (const value of [null, '', 'not-an-id', `${randomUUID()}:../private`, 'x'.repeat(1000)]) assert.throws(() => getSavedGoal(value), { code: 'INVALID_REQUEST' });
  for (const options of [null, [], { revision: 'stale' }, { unexpected: true }]) assert.throws(() => getSavedGoal(saved.id, options), { code: 'INVALID_REQUEST' });
});

test('saved objectives survive a fresh process without migration, model work or another save operation', () => {
  const saved = seed('Inspect the source again\nKeep this exact second line.'); archive(saved);
  const expected = getSavedGoal(saved.id), before = snapshot();
  const moduleURL = new URL('../src/engine/saved-goals.js', import.meta.url).href;
  const script = `import {listSavedGoals,getSavedGoal} from ${JSON.stringify(moduleURL)};
    const page=listSavedGoals(); console.log(JSON.stringify({page,selected:getSavedGoal(page.goals[0].id,{revision:page.goals[0].revision})}));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: workspace, env: { ...process.env }, encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.deepEqual(result.page, { goals: [expected], total: 1, nextOffset: null });
  assert.deepEqual(result.selected, expected); assert.deepEqual(snapshot(), before);
});
