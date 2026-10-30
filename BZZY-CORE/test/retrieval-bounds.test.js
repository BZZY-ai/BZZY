import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSession, saveSession } from '../src/engine/store.js';
import { BUILTINS } from '../src/engine/providers.js';
import { getRecord, putRecord } from '../src/engine/database.js';
import { initializeProject, issue } from '../src/engine/project.js';
import { remember } from '../src/engine/memory.js';
import { searchProjectKnowledge, searchProjectKnowledgeHybrid, knowledgeContextFor, knowledgeSearchMaxBytes } from '../src/engine/knowledge.js';
import { taskKnowledgeBrief } from '../src/engine/task-knowledge-brief.js';
import { registerLocalEmbeddingAdapter, configureRetrieval, refreshLocalEmbeddings } from '../src/engine/retrieval-quality.js';
import { ToolHost } from '../src/engine/tools.js';

let root, previousHome, session;
const bytes = value => Buffer.byteLength(JSON.stringify(value));
function saved(cwd, extra = {}) {
  const value = { ...createSession(BUILTINS.codex, cwd, 'offline-fixture'), ...extra };
  initializeProject(value); saveSession(value); return value;
}
test.beforeEach(() => {
  previousHome = process.env.BZZY_HOME;
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-search-bounds-')));
  process.env.BZZY_HOME = path.join(root, 'private');
  const cwd = path.join(root, 'project'); fs.mkdirSync(cwd); session = saved(cwd);
  registerLocalEmbeddingAdapter(null);
});
test.afterEach(() => {
  registerLocalEmbeddingAdapter(null);
  if (previousHome === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previousHome;
  fs.rmSync(root, { recursive: true, force: true });
});
function assertWellFormed(value) {
  if (typeof value === 'string') assert.equal(value.isWellFormed(), true);
  else if (value && typeof value === 'object') for (const child of Object.values(value)) assertWellFormed(child);
}
const details = () => 'Recorded offline observation Ω🙂 with exact uncertainty. '.repeat(100);

test('50 long Unicode search hits page under 16 KiB without skipped or duplicated candidates', () => {
  const expected = new Set(Array.from({ length: 50 }, (_, i) => issue(session, { title: `SQLi bounded fixture ${i}`, details: details() }).id));
  let offset = 0, pages = 0; const found = [];
  do {
    const page = searchProjectKnowledge(session, { query: 'SQLi', types: ['issue'], limit: 50, offset });
    assert.ok(bytes(page) <= page.pageBudget.payloadMaximumBytes); assertWellFormed(page);
    assert.equal(page.total, 50); assert.ok(page.items.length > 0);
    assert.ok(page.items.every(item => item.truth === 'inconclusive' && item.stale === false));
    found.push(...page.items.map(item => item.sourceId)); pages++;
    if (page.nextOffset !== null) { assert.equal(page.pageBudget.byteLimited, true); assert.ok(page.nextOffset > offset); }
    offset = page.nextOffset;
  } while (offset !== null && pages <= 51);
  assert.equal(offset, null); assert.ok(pages > 1);
  assert.equal(found.length, 50); assert.deepEqual(new Set(found), expected);
});

test('the real worker tool result includes its soft-budget notice under 16 KiB and preserves every nextOffset', async () => {
  const assignmentId = randomUUID(), maximum = Number.MAX_SAFE_INTEGER;
  const worker = saved(session.cwd, { role: 'executor', parentSessionId: session.id, assignmentId, assignmentRound: 1,
    usage: { tokens: maximum, available: true, accountingComplete: true, lastRequestInputTokens: maximum }, elapsedSeconds: maximum });
  putRecord('assignment', assignmentId, { id: assignmentId, parentSessionId: session.id, workerSessionId: worker.id, currentRound: 1, closure: 'open',
    contract: { limits: { tokenBudget: maximum, runtimeSeconds: maximum } },
    workerBudget: { mode: 'adaptive', revision: maximum, initialTokenBudget: maximum, reportReserveTokens: maximum,
      hardTokenLimit: maximum, hardRuntimeLimitSeconds: maximum } });
  putRecord('round', `${assignmentId}:1`, { assignmentId, number: 1, state: 'running' });
  const expected = new Set(Array.from({ length: 50 }, (_, i) => issue(worker, { title: `SQLi worker bounded fixture ${i}`, details: details() }).id));
  const host = new ToolHost(worker, { event() {} });
  let offset = 0, pages = 0; const found = [];
  do {
    const page = await host.call('search_knowledge', { query: 'SQLi', types: ['issue'], limit: 50, offset });
    const { budgetNotice, ...payload } = page;
    assert.equal(budgetNotice.assignmentId, assignmentId); assert.equal(budgetNotice.budget.softReached, true);
    assert.equal(budgetNotice.budget.tokensUsed, maximum);
    assert.ok(bytes({ budgetNotice }) < page.pageBudget.reservedEnvelopeBytes);
    assert.ok(bytes(payload) <= page.pageBudget.payloadMaximumBytes);
    assert.ok(bytes(page) <= knowledgeSearchMaxBytes); assertWellFormed(page);
    assert.equal(page.scope, 'session'); assert.equal(page.total, 50); assert.ok(page.items.length > 0);
    found.push(...page.items.map(item => item.sourceId)); pages++;
    if (page.nextOffset !== null) assert.ok(page.nextOffset > offset);
    offset = page.nextOffset;
  } while (offset !== null && pages <= 51);
  assert.equal(offset, null); assert.ok(pages > 1);
  assert.equal(found.length, 50); assert.deepEqual(new Set(found), expected);
});

test('an oversized legacy result retains uncertainty and identity, discloses clipping and advances', () => {
  const contrary = remember(session, { kind: 'hypothesis', statement: 'An opposite recorded observation.' });
  const item = issue(session, { title: 'SQLi oversized old claim', details: details() });
  const old = { ...getRecord('issue', item.id), truth: 'confirmed', invalidatedAt: '2026-01-01T00:00:00Z', contradictions: [contrary.id],
    reportLifecycle: { state: 'claimed_submitted', note: `password="synthetic-private-binding" ${'Ω🙂'.repeat(30000)}` } };
  putRecord('issue', item.id, old);
  const page = searchProjectKnowledge(session, { query: 'SQLi', types: ['issue'], includeStale: true, limit: 50 });
  assert.equal(page.items.length, 1); assert.equal(page.nextOffset, null); assert.ok(bytes(page) <= knowledgeSearchMaxBytes);
  const hit = page.items[0];
  assert.equal(hit.sourceId, item.id); assert.equal(hit.truth, 'stale'); assert.equal(hit.stale, true); assert.equal(hit.disputed, true);
  assert.ok(hit.staleReasons.includes('explicitly-invalidated')); assert.deepEqual(hit.contradictions, [contrary.id]);
  assert.equal(hit.contradictionCount, 1); assert.equal(hit.preview.truncated, true); assert.equal(page.pageBudget.truncatedItems, 1);
  assert.equal(hit.reportLifecycle.state, 'claimed_submitted'); assert.equal(hit.reportLifecycle.detailsOmitted, true);
  assert.equal(hit.sourceRead, undefined, 'Do not advertise a source API unsupported for issue records.');
  assert.match(hit.authority, /not.*verified/); assert.doesNotMatch(JSON.stringify(page), /synthetic-private-binding/); assertWellFormed(page);
  assert.deepEqual(getRecord('issue', item.id), old, 'Display bounds cannot change original claims.');
  assert.deepEqual(searchProjectKnowledge(session, { query: 'SQLi', types: ['issue'] }).items, []);
});

test('automatic query filtering excludes common-word-only matches and preserves original negation', () => {
  const irrelevant = issue(session, { title: 'XSS old finding', details: 'It is on the old panel and is not a new claim.' });
  const conclusion = issue(session, { title: 'SQLi reviewed control', details: 'SQLi is NOT confirmed. Do not retry without a changed control.' });
  session.goal = { id: randomUUID(), status: 'active', objective: 'Find new SQLi that is not already reported on this program.' }; saveSession(session);
  const selected = taskKnowledgeBrief(session, session.goal);
  assert.deepEqual(selected.brief.items.map(item => item.sourceId), [conclusion.id]);
  assert.match(selected.brief.items[0].statement, /NOT confirmed\. Do not retry/);
  const startup = knowledgeContextFor(session, session.goal.objective);
  assert.ok(startup.items.some(item => item.sourceId === conclusion.id));
  assert.ok(startup.items.every(item => item.sourceId !== irrelevant.id));
  assert.equal(taskKnowledgeBrief(session, { ...session.goal, objective: 'is on not the and for' }).brief.items.length, 0);
});

test('bounded searches and hybrid fallbacks preserve worker and project isolation', async () => {
  for (let i = 0; i < 6; i++) issue(session, { title: `SQLi owner only ${i}`, details: details() });
  const foreignPath = path.join(root, 'foreign'); fs.mkdirSync(foreignPath);
  const foreign = saved(foreignPath), worker = saved(session.cwd, { role: 'executor', parentSessionId: session.id });
  assert.deepEqual(searchProjectKnowledge(foreign, { query: 'SQLi' }).items, []);
  assert.deepEqual((await searchProjectKnowledgeHybrid(worker, { query: 'SQLi' })).items, []);
  const local = issue(worker, { title: 'SQLi worker observation', details: 'A bounded worker-local claim.' });
  assert.deepEqual(searchProjectKnowledge(worker, { query: 'SQLi', types: ['issue'] }).items.map(item => item.sourceId), [local.id]);
  const first = await searchProjectKnowledgeHybrid(session, { query: 'SQLi', types: ['issue'], limit: 50 });
  assert.equal(first.retrieval.mode, 'fts'); assert.equal(first.retrieval.fallback, 'response-byte-budget');
  assert.ok(bytes(first) <= knowledgeSearchMaxBytes); assert.ok(first.nextOffset > 0);
  const next = await searchProjectKnowledgeHybrid(session, { query: 'SQLi', types: ['issue'], limit: 50, offset: first.nextOffset });
  assert.ok(bytes(next) <= knowledgeSearchMaxBytes);
  assert.ok(next.items.every(item => !first.items.some(prior => prior.sourceId === item.sourceId)));
});

async function enableEmbedding(embed) {
  registerLocalEmbeddingAdapter({ kind: 'local-embedding', local: true, model: 'fixture-local', modelVersion: 'v1', dimensions: 2, embed });
  configureRetrieval(session, { localEmbeddingsEnabled: true }, { expectedRevision: 0, reviewed: true });
  searchProjectKnowledge(session, { query: '' });
  while ((await refreshLocalEmbeddings(session)).remaining) { /* Bounded synthetic source set. */ }
}

test('semantic-only results stay byte-bounded and disclose their bounded selection', async () => {
  for (let i = 0; i < 12; i++) remember(session, { kind: 'hypothesis', statement: `Invoice control ${i}. ${'Ω🙂 preserved historical statement. '.repeat(120)}`, rationale: 'Recorded offline uncertainty Ω🙂. '.repeat(90) });
  await enableEmbedding(async () => [1, 0]);
  const found = await searchProjectKnowledgeHybrid(session, { query: 'billing', types: ['memory'], limit: 12 });
  assert.equal(found.retrieval.mode, 'local-hybrid'); assert.ok(found.items.length > 0);
  assert.ok(found.retrieval.omittedCandidates > 0); assert.equal(found.pageBudget.byteLimited, true);
  assert.ok(bytes(found) <= found.pageBudget.payloadMaximumBytes); assertWellFormed(found);
  assert.equal(found.nextOffset, null); assert.match(found.retrieval.pagination, /lexical.*only/);
});

test('hybrid reranking cannot discard a lexical row without a continuation cursor', async () => {
  const expected = [remember(session, { kind: 'hypothesis', statement: 'Billing lexical row one.' }), remember(session, { kind: 'hypothesis', statement: 'Billing lexical row two.' })];
  remember(session, { kind: 'hypothesis', statement: 'Invoice semantic row one.' }); remember(session, { kind: 'hypothesis', statement: 'Invoice semantic row two.' });
  await enableEmbedding(async text => /invoice|^billing$/i.test(text) ? [1, 0] : [0, 1]);
  const found = await searchProjectKnowledgeHybrid(session, { query: 'billing', types: ['memory'], limit: 2 });
  assert.equal(found.retrieval.mode, 'fts'); assert.equal(found.retrieval.fallback, 'lexical-page-preserved');
  assert.deepEqual(new Set(found.items.map(item => item.sourceId)), new Set(expected.map(item => item.id)));
  assert.equal(found.nextOffset, null); assert.ok(bytes(found) <= knowledgeSearchMaxBytes);
});
