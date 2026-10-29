import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSession, saveSession } from '../src/engine/store.js';
import { BUILTINS } from '../src/engine/providers.js';
import { initializeProject } from '../src/engine/project.js';
import { artifact } from '../src/engine/evidence.js';
import { database, getRecord, putRecord, transaction } from '../src/engine/database.js';
import { knowledgeDatabase, knowledgeAccess, indexKnowledgeRecord, refreshKnowledgeRecords,
  memoryRelationshipCoverage, checkMemoryRelationships } from '../src/engine/knowledge-index.js';
import { memoryFreshness, reviewMemory } from '../src/engine/memory.js';
import { searchProjectKnowledge } from '../src/engine/knowledge.js';
import { configureProjectFacts, projectFactsView } from '../src/engine/project-facts.js';
import { taskKnowledgeBrief } from '../src/engine/task-knowledge-brief.js';
import { resolutionView } from '../src/engine/resolutions.js';

let root, priorHome, session, sibling, evidence;
function saved(cwd) {
  const value = createSession(BUILTINS.codex, cwd, 'offline-fixture');
  initializeProject(value); saveSession(value); return value;
}
function note(owner, id = randomUUID(), patch = {}) {
  return { id, sessionId: owner.id, projectId: owner.projectId, project: owner.cwd,
    kind: 'hypothesis', truth: 'hypothesis', statement: 'MIGRATION_NOTE historical observation',
    evidence: [evidence.id], inputs: [], revision: 1, createdAt: '2026-01-01T00:00:00Z', ...patch };
}
function seedLegacy(count = 100) {
  const current = note(session, '00000000-0000-4000-8000-000000000001'),
    superseded = note(session, '00000000-0000-4000-8000-000000000002'),
    disputed = note(session, '00000000-0000-4000-8000-000000000003'),
    replacement = note(sibling, 'ffffffff-ffff-4fff-8fff-ffffffffffff', {
      statement: 'A later independent source', supersedes: superseded.id, contradictions: [disputed.id] });
  transaction(() => {
    for (const value of [current, superseded, disputed, replacement]) putRecord('memory', value.id, value);
    for (let index = 0; index < count; index++) {
      for (const owner of [session, sibling]) {
        const value = note(owner, randomUUID(), { statement: 'Unrelated historical source', evidence: [] });
        putRecord('memory', value.id, value);
      }
    }
  });
  knowledgeDatabase();
  const access = knowledgeAccess(session, { readOnly: true });
  for (const value of [current, superseded, disputed]) indexKnowledgeRecord(access.project, 'memory', value.id, value.sessionId, value.statement, value);
  return { current, superseded, disputed, replacement, access };
}
test.beforeEach(() => {
  priorHome = process.env.BZZY_HOME;
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-relationship-coverage-')));
  process.env.BZZY_HOME = path.join(root, 'private');
  const cwd = path.join(root, 'project'); fs.mkdirSync(cwd);
  session = saved(cwd); sibling = saved(cwd);
  evidence = artifact(session, 'Fictional current local control.', 'offline control');
});
test.afterEach(() => {
  if (priorHome === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = priorHome;
  fs.rmSync(root, { recursive: true, force: true });
});

test('legacy migration preserves historical discovery and pins without claiming complete freshness', () => {
  const { current, access } = seedLegacy();
  const issue = { id: randomUUID(), sessionId: session.id, projectId: session.projectId, project: session.cwd,
    title: 'MIGRATION_NOTE prior issue', status: 'open', truth: 'inconclusive', evidence: [], revision: 1 };
  putRecord('issue', issue.id, issue); indexKnowledgeRecord(access.project, 'issue', issue.id, session.id, issue.title, issue);
  for (const value of [current, issue]) {
    const fresh = memoryFreshness(value, access.project, session, { readOnly: true });
    assert.equal(fresh.relationshipCoverage, 'backfill-pending'); assert.equal(fresh.stale, false);
    assert.equal(fresh.freshnessStatus, 'unverified'); assert.equal(fresh.truth, value.truth);
    assert.deepEqual(fresh.staleReasons, []);
  }
  const results = searchProjectKnowledge(session, { query: 'MIGRATION_NOTE', types: ['memory', 'issue'] });
  for (const id of [current.id, issue.id]) {
    const hit = results.items.find(item => item.sourceId === id);
    assert.ok(hit); assert.equal(hit.stale, false); assert.equal(hit.freshnessStatus, 'unverified');
  }
  const facts = configureProjectFacts(session, { ids: [current.id] }, { expectedRevision: 0, reviewed: true });
  assert.equal(facts.items[0].id, current.id); assert.equal(facts.items[0].historical, true);
  assert.equal(facts.items[0].freshnessStatus, 'unverified');
  const changes = database().prepare('SELECT total_changes() AS n').get().n;
  const brief = taskKnowledgeBrief(session, { id: 'migration-goal', status: 'active', objective: 'MIGRATION_NOTE' });
  assert.ok(brief.brief.items.length); assert.ok(brief.brief.items.every(item => item.freshnessStatus === 'unverified' && !item.stale));
  assert.equal(database().prepare('SELECT total_changes() AS n').get().n, changes);
  assert.ok(Buffer.byteLength(JSON.stringify(brief.brief)) <= 2200);
});

test('owner review checks late canonical relationships without requiring project-wide backfill', () => {
  const { current, superseded, disputed, replacement, access } = seedLegacy();
  const before = database().prepare('SELECT total_changes() AS n').get().n;
  const checked = checkMemoryRelationships(session, superseded, access);
  assert.equal(checked.complete, true); assert.equal(checked.supersededBy, replacement.id);
  assert.deepEqual(checkMemoryRelationships(session, disputed, access).contradictions, [replacement.id]);
  assert.equal(database().prepare('SELECT total_changes() AS n').get().n, before);
  assert.equal(memoryRelationshipCoverage(session, access, { readOnly: true }), 'backfill-pending');
  const reviewed = reviewMemory(session, current.id, { truth: 'confirmed', expectedRevision: 1, rationale: 'Reviewed the original control.', explicit: true });
  assert.equal(reviewed.truth, 'confirmed'); assert.equal(reviewed.revision, 2);
  assert.throws(() => reviewMemory(session, superseded.id, { truth: 'disproved', expectedRevision: 1,
    rationale: 'This older source must not be approved as current.', explicit: true }), { code: 'MEMORY_SUPERSEDED' });
  assert.equal(getRecord('memory', superseded.id).revision, 1);
  assert.equal(memoryRelationshipCoverage(session, access, { readOnly: true }), 'backfill-pending');
  const projected = projectFactsView(session).items.find(item => item.id === current.id);
  assert.ok(projected); assert.equal(projected.truth, 'confirmed'); assert.equal(projected.freshnessStatus, 'unverified');
  // Owner adjudication remains available for checked contradictory history.
  assert.equal(reviewMemory(session, disputed.id, { truth: 'disproved', expectedRevision: 1,
    rationale: 'Owner reviewed both conflicting observations.', explicit: true }).truth, 'disproved');
  let page; do { page = refreshKnowledgeRecords(session, { limit: 64 }); } while (page.remaining);
  const old = memoryFreshness(superseded, access.project, session, { readOnly: true });
  assert.equal(old.freshnessStatus, 'stale'); assert.equal(old.supersededBy, replacement.id);
  const conflict = memoryFreshness(getRecord('memory', disputed.id), access.project, session, { readOnly: true });
  assert.equal(conflict.disputed, true); assert.deepEqual(conflict.contradictions, [replacement.id]);
  assert.equal(projectFactsView(session).items.some(item => item.id === disputed.id), false);
});

test('exhausted relationship review reports incomplete checks and never changes factual truth', () => {
  const { current, access } = seedLegacy(140);
  assert.equal(checkMemoryRelationships(session, current, access).complete, false);
  assert.throws(() => reviewMemory(session, current.id, { truth: 'confirmed', expectedRevision: 1,
    rationale: 'A bounded review cannot assume unseen relationships are absent.', explicit: true }), error =>
    error.code === 'MEMORY_RELATIONSHIPS_INCOMPLETE' && /recorded evidence has not been marked stale/.test(error.message));
  assert.equal(getRecord('memory', current.id).truth, 'hypothesis'); assert.equal(getRecord('memory', current.id).revision, 1);
  const unchanged = memoryFreshness(current, access.project, session, { readOnly: true });
  assert.equal(unchanged.stale, false); assert.equal(unchanged.freshnessStatus, 'unverified');
});

test('pending coverage never masks actual invalidation, expiry, changed evidence or imported history', () => {
  const { current, access } = seedLegacy();
  const cases = [
    [{ invalidatedAt: '2026-01-01T00:00:00Z' }, 'explicitly-invalidated'],
    [{ freshness: { expiresAt: '2000-01-01T00:00:00Z' } }, 'expired'],
    [{ importedUntrusted: true }, 'imported-history-requires-revalidation'],
  ];
  for (const [patch, reason] of cases) {
    const fresh = memoryFreshness({ ...current, ...patch }, access.project, session, { readOnly: true });
    assert.equal(fresh.stale, true); assert.equal(fresh.freshnessStatus, 'stale'); assert.ok(fresh.staleReasons.includes(reason));
  }
  fs.writeFileSync(evidence.path, 'Changed control');
  assert.throws(() => reviewMemory(session, current.id, { truth: 'confirmed', expectedRevision: 1,
    rationale: 'The control changed.', explicit: true }), /current recorded evidence/);
  assert.ok(memoryFreshness(current, access.project, session, { readOnly: true }).staleReasons.includes('evidence-unavailable-or-changed'));
});

test('resolution projections retain parent relationship uncertainty in ordinary search', () => {
  const { current } = seedLegacy();
  const value = { id: randomUUID(), memoryId: current.id, sessionId: session.id, projectId: session.projectId,
    signature: { normalizedMessage: 'MIGRATION_RESOLUTION', version: 'fixture-v1' },
    symptom: 'MIGRATION_RESOLUTION observed failure', rootCause: 'An unverified historical hypothesis.', fixSteps: ['Inspect the original control.'],
    evidenceIds: [], sourceIds: [], createdAt: '2026-01-01T00:00:00Z' };
  putRecord('core.resolution', value.id, value);
  const direct = resolutionView(session, value.id);
  assert.equal(direct.stale, false); assert.equal(direct.relationshipCoverage, 'backfill-pending');
  assert.equal(direct.freshnessStatus, 'unverified'); assert.equal(direct.causeVerified, false);
  const hit = searchProjectKnowledge(session, { query: 'MIGRATION_RESOLUTION', types: ['resolution'] }).items[0];
  assert.equal(hit.sourceId, value.id); assert.equal(hit.relationshipCoverage, 'backfill-pending');
  assert.equal(hit.freshnessStatus, 'unverified'); assert.equal(hit.causeVerified, false);
});

test('owner relationship checking rejects oversized hydration and excludes foreign/deleted sources', () => {
  const { current, access } = seedLegacy(2);
  const foreignRoot = path.join(root, 'foreign'); fs.mkdirSync(foreignRoot);
  const foreign = saved(foreignRoot), removed = saved(session.cwd);
  for (const owner of [foreign, removed]) {
    const claim = note(owner, randomUUID(), { supersedes: current.id, contradictions: [current.id] });
    putRecord('memory', claim.id, claim);
  }
  putRecord('session-deletion', removed.id, { sessionId: removed.id, deletedAt: '2026-01-01T00:00:00Z' });
  const checked = checkMemoryRelationships(session, current, access);
  assert.equal(checked.complete, true); assert.equal(checked.supersededBy, null); assert.deepEqual(checked.contradictions, []);
  const oversized = note(sibling, randomUUID(), { statement: 'x'.repeat(129 * 1024) });
  putRecord('memory', oversized.id, oversized);
  assert.equal(checkMemoryRelationships(session, current, access).complete, false);
  assert.throws(() => reviewMemory(session, current.id, { truth: 'confirmed', expectedRevision: 1,
    rationale: 'Unbounded legacy input requires explicit further inspection.', explicit: true }), { code: 'MEMORY_RELATIONSHIPS_INCOMPLETE' });
  assert.equal(getRecord('memory', current.id).revision, 1);
});

test('owner relationship review enforces the total byte budget before hydrating source rows', t => {
  const { current, access } = seedLegacy(0), db = database();
  transaction(() => {
    for (let index = 0; index < 32; index++) {
      const value = note(sibling, randomUUID(), { statement: 'x'.repeat(110 * 1024), evidence: [] });
      putRecord('memory', value.id, value);
    }
  });
  const prepare = db.prepare.bind(db); let hydratedBytes = 0, hydratedRows = 0;
  t.mock.method(db, 'prepare', sql => {
    const statement = prepare(sql);
    return new Proxy(statement, { get(target, field) {
      const value = Reflect.get(target, field);
      if (typeof value !== 'function') return value;
      return (...args) => {
        const result = value.apply(target, args);
        if (['get', 'all'].includes(field) && /'memory'/.test(sql)) {
          for (const row of Array.isArray(result) ? result : [result]) if (typeof row?.data === 'string') {
            hydratedBytes += Buffer.byteLength(row.data); hydratedRows++;
          }
        }
        return result;
      };
    } });
  });
  const result = checkMemoryRelationships(session, current, access);
  assert.equal(result.complete, false);
  assert.ok(hydratedRows > 0 && hydratedRows < 32);
  assert.equal(result.checkedBytes, hydratedBytes);
  assert.ok(hydratedBytes <= 2 * 1024 * 1024, `Hydrated ${hydratedBytes} bytes before returning incomplete.`);
});

test('owner relationship review reports incomplete when pending session enumeration reaches its bound', () => {
  const { current, access } = seedLegacy(0);
  transaction(() => {
    for (let index = 0; index < 257; index++) {
      const owner = { ...session, id: randomUUID() };
      putRecord('session', owner.id, owner);
      const value = note(owner); putRecord('memory', value.id, value);
    }
  });
  const result = checkMemoryRelationships(session, current, access);
  assert.equal(result.complete, false); assert.equal(result.checkedBytes, 0);
  assert.equal(getRecord('memory', current.id).revision, 1);
});
