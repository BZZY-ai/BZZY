import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSession, saveSession } from '../src/engine/store.js';
import { getProvider } from '../src/engine/providers.js';
import { initializeProject } from '../src/engine/project.js';
import { database, digest, events, getRecord, transaction } from '../src/engine/database.js';
import { checkpoint, checkpointState } from '../src/engine/memory.js';
import { knowledgeDatabase, refreshKnowledgeRecords } from '../src/engine/knowledge-index.js';
import { searchProjectKnowledge } from '../src/engine/knowledge.js';

let root, previous, session;
test.beforeEach(() => {
  previous = process.env.BZZY_HOME;
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-checkpoint-index-')));
  process.env.BZZY_HOME = path.join(root, 'private');
  const cwd = path.join(root, 'project'); fs.mkdirSync(cwd);
  session = createSession(getProvider('codex'), cwd, 'offline-fixture'); initializeProject(session);
  session.goal = { id: randomUUID(), status: 'active', objective: 'Review the offline Orbit control.' };
  saveSession(session); knowledgeDatabase();
});
test.afterEach(() => {
  if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
  fs.rmSync(root, { recursive: true, force: true });
});

for (const kind of ['checkpoint', 'outcome']) test(`${kind} index failure cannot undo a saved checkpoint or duplicate its retry`, () => {
  database().exec(`CREATE TRIGGER fixture_index_failure BEFORE INSERT ON knowledge_documents
    WHEN new.kind='${kind}' BEGIN SELECT RAISE(FAIL, 'password=synthetic-private-error-detail'); END`);
  const input = { completedWork: ['Rejected Orbit lead; current evidence remains inconclusive.'], expectedRevision: 0, requestId: 'save-once' };
  const saved = checkpoint(session, input);
  assert.equal(saved.revision, 1); assert.equal(saved.indexing.state, 'deferred'); assert.equal(saved.indexing.component, kind);
  assert.doesNotMatch(JSON.stringify(saved), /synthetic-private-error-detail/);
  const { indexing, ...canonical } = saved;
  assert.deepEqual(checkpointState(session).current, canonical);
  assert.deepEqual(getRecord('core.checkpoint.request', `${session.id}:${digest(canonical.scope)}:save-once`).record, canonical);
  assert.deepEqual(checkpoint(session, input), saved);
  assert.equal(events(session.id, 0, 100).filter(event => event.type === 'checkpoint').length, 1);
  const changes = database().prepare('SELECT kind FROM knowledge_changes WHERE session_id=?').all(session.id);
  assert.ok(changes.some(row => row.kind === 'core.checkpoint.scope'));
  database().exec('DROP TRIGGER fixture_index_failure');
  for (let i = 0; i < 8; i++) if (!refreshKnowledgeRecords(session).remaining) break;
  const result = searchProjectKnowledge(session, { query: 'Rejected Orbit', types: ['outcome'] });
  assert.equal(result.items.length, 1);
  assert.deepEqual(checkpoint(session, input), canonical);
  assert.equal(events(session.id, 0, 100).filter(event => event.type === 'checkpoint').length, 1);
});

test('an unprojectable legacy goal still receives its durable scoped checkpoint', () => {
  // Older local metadata can contain a goal identifier that the source reader
  // deliberately refuses to expose. Saving its working state must still succeed.
  session.goal.id = 'legacy goal identifier'; saveSession(session);
  const saved = checkpoint(session, { pendingActions: ['Inspect the authorized offline control.'] });
  assert.equal(saved.indexing.state, 'deferred'); assert.equal(saved.indexing.component, 'outcome');
  const { indexing, ...canonical } = saved;
  assert.deepEqual(checkpointState(session).current, canonical);
  assert.equal(events(session.id, 0, 100).filter(event => event.type === 'checkpoint').length, 1);
});

test('failed canonical writes still fail atomically rather than claiming checkpoint success', () => {
  database().exec("CREATE TRIGGER fixture_durable_failure BEFORE INSERT ON records WHEN new.kind='checkpoint' BEGIN SELECT RAISE(ABORT, 'synthetic durable failure'); END");
  assert.throws(() => checkpoint(session, { pendingActions: ['Not saved.'], requestId: 'rejected-write' }), /synthetic durable failure/);
  assert.equal(checkpointState(session).current, null);
  assert.equal(events(session.id, 0, 100).filter(event => event.type === 'checkpoint').length, 0);
  assert.equal(database().prepare("SELECT count(*) AS n FROM records WHERE kind='core.checkpoint.request'").get().n, 0);
});

test('an older request retry cannot replace newer project and search projections', () => {
  const firstInput = { pendingActions: ['Original offline check.'], requestId: 'original' };
  const first = checkpoint(session, firstInput);
  const latest = checkpoint(session, { pendingActions: ['CURRENT_UNIQUE_LEAD remains unresolved.'], requestId: 'newer' });
  for (let i = 0; i < 8; i++) if (!refreshKnowledgeRecords(session).remaining) break;
  const before = searchProjectKnowledge(session, { query: 'CURRENT_UNIQUE_LEAD', types: ['checkpoint', 'outcome'] });
  assert.equal(before.items.length, 2);
  assert.deepEqual(checkpoint(session, firstInput), first);
  assert.deepEqual(checkpointState(session).current, latest);
  assert.equal(JSON.parse(fs.readFileSync(path.join(session.cwd, '.bzzy', 'checkpoints', `${session.id}.json`))).revision, latest.revision);
  const after = searchProjectKnowledge(session, { query: 'CURRENT_UNIQUE_LEAD', types: ['checkpoint', 'outcome'] });
  assert.deepEqual(after.items.map(item => item.sourceId).sort(), before.items.map(item => item.sourceId).sort());
  assert.equal(events(session.id, 0, 100).filter(event => event.type === 'checkpoint').length, 2);
});

test('derived failure inside a caller transaction rolls back only disposable index writes', () => {
  database().exec("CREATE TRIGGER fixture_index_failure BEFORE INSERT ON knowledge_documents WHEN new.kind='outcome' BEGIN SELECT RAISE(FAIL, 'synthetic index failure'); END");
  const saved = transaction(() => checkpoint(session, { completedWork: ['Durable recorded control.'], requestId: 'nested' }));
  assert.equal(saved.indexing.state, 'deferred');
  assert.equal(checkpointState(session).current.revision, 1);
  assert.equal(database().prepare('SELECT count(*) AS n FROM knowledge_documents WHERE session_id=?').get(session.id).n, 0);
  assert.equal(events(session.id, 0, 100).filter(event => event.type === 'checkpoint').length, 1);
  database().exec('DROP TRIGGER fixture_index_failure');
  assert.equal(searchProjectKnowledge(session, { query: 'Durable recorded control', types: ['outcome'] }).items.length, 1);
});

test('an unavailable project copy reports the saved Core checkpoint without exposing filesystem errors', () => {
  const target = path.join(session.cwd, '.bzzy', 'checkpoints');
  fs.rmSync(target, { recursive: true, force: true }); fs.writeFileSync(target, 'Synthetic obstruction.');
  const saved = checkpoint(session, { pendingActions: ['Saved despite an unavailable compatibility copy.'], requestId: 'copy-failure' });
  assert.equal(saved.indexing.state, 'deferred'); assert.equal(saved.indexing.component, 'project_copy');
  assert.doesNotMatch(JSON.stringify(saved.indexing), /EEXIST|ENOTDIR|bzzy-checkpoint-index-/);
  assert.equal(checkpointState(session).current.revision, 1);
  assert.equal(events(session.id, 0, 100).filter(event => event.type === 'checkpoint').length, 1);
});
