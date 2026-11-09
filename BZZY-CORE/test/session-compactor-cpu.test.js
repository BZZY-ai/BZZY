import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CoreAssistant } from '../src/assistant.js';
import { database, putRecord, getRecord, now } from '../src/engine/database.js';
import { createSession, saveSession, loadSession } from '../src/engine/store.js';
import { getProvider } from '../src/engine/providers.js';
import { pendingSessionMemoryNodes } from '../src/engine/session-memory.js';
import { processSessionCompactions, sessionMaintenanceDue, wakeMaintenance } from '../src/engine/session-compactor.js';

// Regression coverage for the background session-memory maintenance CPU bug:
// the pending-node lookup must use the partial index with no temporary sort,
// preserve its scoped/global/generation/fallback/ordering/pagination semantics
// while validating each source once, and the pump must pace itself when idle.

const META = 'core.session.memory', NODE = 'core.session.memory.node', VERSION = 5;
let root, previous, cwd, nodeSeq;
const variables = ['BZZY_HOME', 'DEEPSEEK_API_KEY'];

test.beforeEach(() => {
  previous = Object.fromEntries(variables.map(key => [key, process.env[key]]));
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-compactor-cpu-')));
  process.env.BZZY_HOME = path.join(root, 'private');
  process.env.DEEPSEEK_API_KEY = 'synthetic-compactor-fixture-value';
  new CoreAssistant().configure({ source: 'core', provider: 'deepseek', model: getProvider('deepseek').model, effort: 'low' }, { requestId: randomUUID(), expectedRevision: 0 });
  cwd = path.join(root, 'project'); fs.mkdirSync(cwd);
  nodeSeq = 0;
  wakeMaintenance();
});
test.afterEach(() => {
  for (const key of variables) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
  fs.rmSync(root, { recursive: true, force: true });
});

const makeSource = ({ generation = 'g1', sourceVersion = VERSION, eligible = true, deleted = false } = {}) => {
  const session = createSession(getProvider('codex'), cwd, 'main-chat-model', `fixture-${nodeSeq++}`);
  if (!eligible) { session.parentSessionId = randomUUID(); saveSession(session); }
  if (deleted) putRecord('session-deletion', session.id, { sessionId: session.id, deletedAt: now() });
  putRecord(META, session.id, { sessionId: session.id, generation, sourceVersion });
  return session;
};
const addNode = (sessionId, { generation = 'g1', state = 'pending', createdAt = now(), fallback = null, id } = {}) => {
  const nid = id || `${nodeSeq++}`.padStart(64, '0');
  putRecord(NODE, nid, { id: nid, sessionId, generation, state, createdAt, fallback });
  return nid;
};
// Mirrors the shipped scoped SQL (session-memory.js) for a query-plan assertion.
const scopedPlan = sessionId => database().prepare(`EXPLAIN QUERY PLAN
  SELECT n.data FROM records n JOIN records m ON m.kind='${META}' AND m.id=json_extract(n.data,'$.sessionId')
  WHERE n.kind='${NODE}' AND json_extract(n.data,'$.sessionId')=? AND json_extract(m.data,'$.sourceVersion')=${VERSION}
  AND json_extract(n.data,'$.state')='pending' AND json_extract(n.data,'$.generation')=json_extract(m.data,'$.generation')
  AND (?=0 OR json_extract(n.data,'$.fallback') IS NULL)
  ORDER BY json_extract(n.data,'$.createdAt'),n.id LIMIT ? OFFSET ?`).all(sessionId, 0, 100, 0).map(row => row.detail).join('\n');

test('the migration installs the partial pending-node index on a fresh database', () => {
  database();
  const index = database().prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='records_memory_pending_lookup_v1'").get();
  assert.ok(index, 'records_memory_pending_lookup_v1 must exist after initialization');
  assert.equal(database().prepare("SELECT value FROM metadata WHERE key='schema_version'").get().value, '2');
});

test('the scoped pending-node query uses the partial index with no temporary sort', () => {
  const session = makeSource();
  for (let i = 0; i < 40; i++) addNode(session.id, { createdAt: new Date(Date.now() + i).toISOString() });
  for (let i = 0; i < 3; i++) makeSource(); // other sessions so the planner has a real choice
  const plan = scopedPlan(session.id);
  assert.match(plan, /records_memory_pending_lookup_v1/, `expected the partial index in:\n${plan}`);
  assert.doesNotMatch(plan, /USE TEMP B-TREE/, `expected no temporary ordering in:\n${plan}`);
});

test('a hand-applied index of the same name is superseded by the canonical definition', () => {
  // A live owner database had a differently-shaped index applied by hand at this
  // name. A fresh init must converge on the committed session-leading definition.
  const sql = database().prepare("SELECT sql FROM sqlite_master WHERE name='records_memory_pending_lookup_v1'").get().sql;
  assert.match(sql, /json_extract\(data,'\$\.sessionId'\)/);
  // Session is the first key column: it appears before createdAt in the definition.
  assert.ok(sql.indexOf("'$.sessionId'") < sql.indexOf("'$.createdAt'"), 'sessionId must lead the index key');
});

test('scoped lookup returns only its own pending, current-generation nodes', () => {
  const a = makeSource(), b = makeSource();
  const a1 = addNode(a.id, { createdAt: '2026-01-01T00:00:00.000Z' });
  const a2 = addNode(a.id, { createdAt: '2026-01-02T00:00:00.000Z' });
  addNode(a.id, { state: 'ready' });                    // not pending
  addNode(a.id, { generation: 'old' });                 // stale generation
  addNode(b.id);                                         // other session
  const ids = pendingSessionMemoryNodes({ sessionId: a.id }).map(n => n.id);
  assert.deepEqual(ids, [a1, a2], 'only a\'s pending current-generation nodes, ordered by createdAt');
});

test('ordering breaks ties by id and pagination is stable', () => {
  const s = makeSource();
  const tied = 'identical-created-at';
  const ids = ['00000000', '11111111', '22222222'].map(p => addNode(s.id, { createdAt: tied, id: p.padEnd(64, p[0]) }));
  const all = pendingSessionMemoryNodes({ sessionId: s.id }).map(n => n.id);
  assert.deepEqual(all, [...ids].sort(), 'tied createdAt falls back to id order');
  const first = pendingSessionMemoryNodes({ sessionId: s.id, limit: 2, offset: 0 }).map(n => n.id);
  const second = pendingSessionMemoryNodes({ sessionId: s.id, limit: 2, offset: 2 }).map(n => n.id);
  assert.deepEqual([...first, ...second], all, 'pages concatenate to the full ordered set with no overlap or gap');
});

test('withoutFallback excludes nodes that already have a fallback', () => {
  const s = makeSource();
  const plain = addNode(s.id, { createdAt: '2026-01-01T00:00:00.000Z' });
  const withFb = addNode(s.id, { createdAt: '2026-01-02T00:00:00.000Z', fallback: 'already extracted' });
  assert.deepEqual(pendingSessionMemoryNodes({ sessionId: s.id }).map(n => n.id), [plain, withFb]);
  assert.deepEqual(pendingSessionMemoryNodes({ sessionId: s.id, withoutFallback: true }).map(n => n.id), [plain]);
});

test('a stale source version excludes a session from both lookups', () => {
  const current = makeSource({ generation: 'g1' });
  const stale = makeSource({ generation: 'g1', sourceVersion: 4 });
  const kept = addNode(current.id);
  addNode(stale.id);
  assert.deepEqual(pendingSessionMemoryNodes({ sessionId: stale.id }), [], 'scoped lookup on a stale-version source is empty');
  assert.deepEqual(pendingSessionMemoryNodes({}).map(n => n.id), [kept], 'global discovery skips the stale-version source');
});

test('global discovery validates each source once and drops deleted or ineligible sources', () => {
  const ok = makeSource(), gone = makeSource({ deleted: true }), child = makeSource({ eligible: false });
  const keep1 = addNode(ok.id, { createdAt: '2026-01-01T00:00:00.000Z' });
  const keep2 = addNode(ok.id, { createdAt: '2026-01-02T00:00:00.000Z' });
  addNode(gone.id);
  addNode(child.id);
  assert.deepEqual(pendingSessionMemoryNodes({}).map(n => n.id), [keep1, keep2], 'only the live, eligible source survives');
});

test('scoped results equal the global results filtered to that session', () => {
  const a = makeSource(), b = makeSource();
  for (let i = 0; i < 5; i++) { addNode(a.id, { createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() }); addNode(b.id); }
  const scoped = pendingSessionMemoryNodes({ sessionId: a.id }).map(n => n.id);
  const global = pendingSessionMemoryNodes({}).filter(n => n.sessionId === a.id).map(n => n.id);
  assert.deepEqual(scoped, global, 'the two SQL paths agree on selection and order');
});

test('maintenance paces itself: idle after a caught-up pump, immediate again after new work', async () => {
  assert.equal(sessionMaintenanceDue(), true, 'due by default at startup');
  await processSessionCompactions({ runModel: () => assert.fail('nothing to summarize on an empty database') });
  assert.equal(sessionMaintenanceDue(), false, 'a caught-up pump backs off and is not immediately due again');
  wakeMaintenance();
  assert.equal(sessionMaintenanceDue(), true, 'new work wakes maintenance without waiting out the backoff');
});
