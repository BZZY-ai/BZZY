import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSession, saveSession } from '../src/engine/store.js';
import { getProvider } from '../src/engine/providers.js';
import { initializeProject } from '../src/engine/project.js';
import { checkpoint } from '../src/engine/memory.js';
import { database, digest, getRecord, putRecord } from '../src/engine/database.js';
import { checkpointOutcome, sessionOutcomePage, outcomeExpansionBytes } from '../src/engine/session-outcomes.js';
import { readKnowledgeSource } from '../src/engine/knowledge-index.js';
import { searchProjectKnowledge } from '../src/engine/knowledge.js';

let directory, previous, session;
test.beforeEach(() => {
  previous = process.env.BZZY_HOME;
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-outcome-bounds-')));
  process.env.BZZY_HOME = path.join(directory, 'private');
  const cwd = path.join(directory, 'project'); fs.mkdirSync(cwd);
  session = createSession(getProvider('codex'), cwd, 'offline-fixture'); initializeProject(session);
  session.goal = { id: randomUUID(), objective: 'Review fictional Orbit SQLi evidence.', status: 'active' };
  session.contract = { constraints: ['Use recorded offline fixtures only.'] }; saveSession(session);
});
test.afterEach(() => {
  if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
  fs.rmSync(directory, { recursive: true, force: true });
});
const sourceId = record => `${record.sessionId}:${digest(record.scope)}`;

test('bounded outcome expansion above 128 KiB has reachable exact pages and retains all projected items', () => {
  const decisions = prefix => Array.from({ length: 7 }, (_, i) => ({ observations:
    Array.from({ length: 4 }, (_, j) => `${prefix} ${i} ${j}: ${'x'.repeat(1880)}`) }));
  checkpoint(session, { decisions: decisions('First') });
  checkpoint(session, { decisions: decisions('Second') });
  const record = checkpoint(session, { decisions: decisions('Third') }), id = sourceId(record);
  assert.ok(Buffer.byteLength(JSON.stringify(record)) < 131072);
  const outcome = checkpointOutcome(record, id);
  assert.equal(outcome.items.length, 21);
  assert.equal(new Set(outcome.sourcePins.map(pin => pin.id)).size, 2);
  const changes = database().prepare('SELECT total_changes() AS n').get().n;
  let offset = 0, text = '', totalBytes;
  for (let pages = 0; pages < 256; pages++) {
    const page = readKnowledgeSource(session, { sourceId: id, sha256: outcome.sourceRevision, offset, limit: 8192 });
    text += page.text; totalBytes = page.totalBytes;
    if (!page.hasMore) break;
    assert.ok(page.nextOffset > offset); offset = page.nextOffset;
  }
  assert.ok(offset > 131072);
  assert.ok(totalBytes <= outcomeExpansionBytes);
  assert.equal(Buffer.byteLength(text), totalBytes);
  const full = JSON.parse(text);
  assert.equal(full.items.length, 21);
  assert.equal(full.coverage.omittedExpansionItems, 0);
  assert.equal(full.provenance, 'host-projected-checkpoint-outcome');
  assert.equal(database().prepare('SELECT total_changes() AS n').get().n, changes);
});

test('outcome pages mask legacy private text and allowlist legacy goal status', () => {
  const record = checkpoint(session, { completedWork: ['Recorded fixture.'] }), id = sourceId(record);
  const secret = 'synthetic-legacy-private-binding';
  putRecord('core.checkpoint.scope', id, { ...record, items: [{ id: 'legacy', field: 'completedWork', value: `password=${secret}` }] });
  putRecord('goal-history', record.goalId, { id: record.goalId, sessionId: session.id, status: `password=${secret}`, reason: `password=${secret}` });
  session.goal = { id: randomUUID(), objective: 'Continue Orbit.', status: 'active' }; saveSession(session);
  const page = sessionOutcomePage(session);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].outcome, 'incomplete');
  assert.doesNotMatch(JSON.stringify(page), new RegExp(secret));
  assert.match(JSON.stringify(page), /redacted/);
  assert.equal(page.items[0].requiresRevalidation, true);
});

test('scope, source identity, project and malformed archives cannot cross outcome boundaries', () => {
  const record = checkpoint(session, { completedWork: ['A bounded original.'] }), id = sourceId(record);
  putRecord('core.checkpoint.scope', id + '-wrong-key', record);
  const otherScope = { ...record.scope, goalId: randomUUID() };
  putRecord('core.checkpoint.scope', `${session.id}:${digest(otherScope)}`, { ...record, scope: otherScope });
  const foreignScope = { ...record.scope, goalId: randomUUID() };
  putRecord('core.checkpoint.scope', `${session.id}:${digest(foreignScope)}`, { ...record, scope: foreignScope,
    goalId: foreignScope.goalId, projectId: randomUUID(), project: '/foreign-project' });
  const malformed = { ...record, items: [null, 7, { field: 'decisions' }], itemArchive: [null, 'invalid',
    { field: 'completedWork', id: 'old', checkpointRevision: 888, itemRevision: 1 }] };
  putRecord('core.checkpoint.scope', id, malformed);
  const page = sessionOutcomePage(session);
  assert.equal(page.omittedInvalid, 3);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].items.length, 0);
  assert.ok(page.items[0].coverage.skippedItems >= 3);
  assert.ok(page.items[0].coverage.skippedSources > 0);
  assert.deepEqual(sessionOutcomePage({ ...session, projectRoot: '/foreign-project' }), { items: [], restricted: true });
  assert.throws(() => readKnowledgeSource(session, { sourceId: `${session.id}:${digest(otherScope)}`, sha256: 'a'.repeat(64) }), /outside/);
});

test('oversized canonical outcome inputs are skipped before hydration and pages advance', () => {
  const record = checkpoint(session, { completedWork: ['Recorded fixture.'] }), id = sourceId(record);
  const outcome = checkpointOutcome(record, id);
  putRecord('core.checkpoint.scope', id, { ...record, legacyPadding: 'x'.repeat(140000) });
  const page = sessionOutcomePage(session, { limit: 1 });
  assert.equal(page.omittedOversize, 1); assert.deepEqual(page.items, []);
  assert.throws(() => readKnowledgeSource(session, { sourceId: id, sha256: outcome.sourceRevision }), /bounded read allowance/);
});

test('bounded archive coverage reports aged-out pointers without scanning original history', () => {
  let record;
  for (let i = 0; i < 110; i++) record = checkpoint(session, { completedWork: [`Recorded attempt ${i}.`] });
  assert.equal(record.itemArchive.length, 100);
  assert.equal(record.omittedArchivePointers, 9);
  const outcome = checkpointOutcome(record, sourceId(record));
  assert.equal(outcome.coverage.archivedItemsInspected, 32);
  assert.equal(outcome.coverage.omittedArchivePointers, 77);
  assert.ok(outcome.coverage.skippedSources > 0, 'At most sixteen distinct revision sources are read.');
  assert.match(outcome.coverage.archiveCoverage, /older original checkpoint revisions/);
  assert.ok(getRecord('core.checkpoint.revision', `${session.id}:1`));
});

test('outcome objective remains searchable beyond long item text without replacing rejection-first display', () => {
  checkpoint(session, { decisions: Array.from({ length: 5 }, (_, i) => `Recorded decision ${i}: ${'x'.repeat(1800)}`) });
  const found = searchProjectKnowledge(session, { query: 'Orbit SQLi', types: ['outcome'] });
  assert.equal(found.items.length, 1);
  assert.equal(found.items[0].goalId, session.goal.id);
});
