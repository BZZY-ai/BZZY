import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSession, saveSession } from '../src/engine/store.js';
import { BUILTINS } from '../src/engine/providers.js';
import { initializeProject } from '../src/engine/project.js';
import { appendEvent, database, getRecord, putRecord, digest } from '../src/engine/database.js';
import { readKnowledgeSource, knowledgeAccess, refreshKnowledgeHistory, searchKnowledgeIndex } from '../src/engine/knowledge-index.js';
import { searchProjectKnowledge, searchProjectKnowledgeHybrid, knowledgeContextFor, enrichKnowledgeQuery } from '../src/engine/knowledge.js';
import { normalizeErrorSignature } from '../src/engine/error-signature.js';
import { recordResolution, lookupResolutions, resolutionView, publishLearningResolutions } from '../src/engine/resolutions.js';
import { projectFactsView, configureProjectFacts } from '../src/engine/project-facts.js';
import { remember, reviewMemory } from '../src/engine/memory.js';
import { artifact } from '../src/engine/evidence.js';
import { registerLocalEmbeddingAdapter, configureRetrieval, refreshLocalEmbeddings, localSemanticCandidates,
  retrievalSettings, retrievalQualityStatus, benchmarkRetrieval } from '../src/engine/retrieval-quality.js';

let root, previousHome, alpha, beta, session;
function create(root, options = {}) {
  const value = { ...createSession(BUILTINS.codex, root), ...options }; initializeProject(value); saveSession(value); return value;
}
test.beforeEach(() => {
  previousHome = process.env.BZZY_HOME;
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-retrieval-')));
  process.env.BZZY_HOME = path.join(root, 'private');
  alpha = path.join(root, 'alpha'); beta = path.join(root, 'beta'); fs.mkdirSync(alpha); fs.mkdirSync(beta);
  session = create(alpha); registerLocalEmbeddingAdapter(null);
});
test.afterEach(() => {
  registerLocalEmbeddingAdapter(null);
  if (previousHome == null) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previousHome;
  fs.rmSync(root, { recursive: true, force: true });
});
function source(target = session, text = 'Observed HTTP 403 after dependency update.') {
  return appendEvent(target.id, 'message.user', { text });
}
const signature = (version = '24.0.0', text = 'node.js HTTP 403 failed at /tmp/run-123/client.js') =>
  normalizeErrorSignature(text, { tool: 'shell', platform: 'darwin', version });
function resolution(input = {}, requestId = 'resolution-1') {
  const event = source();
  return recordResolution(session, { signature: signature(), symptom: 'Dependency request fails with HTTP 403.',
    rootCause: 'An obsolete lockfile is a candidate cause.', fixSteps: ['Review the lockfile against the declared registry configuration.'],
    sourceIds: [event.id], evidenceIds: [artifact(session, 'fixture control', 'source control').id], ...input }, { requestId });
}

test('a near-end match in a 100 KB source is delivered with hash-pinned UTF-8 expansion', () => {
  const reader = create(alpha), event = source(session, `${'ordinary text '.repeat(7600)}\nUNIQUE_LATE_FAILURE Ω🙂\npassword="fixture-private\nvalue"`);
  const result = searchProjectKnowledge(reader, { query: 'UNIQUE_LATE_FAILURE', types: ['chat'] });
  assert.equal(result.items.length, 1); const hit = result.items[0];
  assert.equal(hit.sourceId, event.id); assert.match(hit.statement, /UNIQUE_LATE_FAILURE/); assert.equal(hit.sha256.length, 64);
  const first = readKnowledgeSource(reader, { sourceId: hit.sourceId, sha256: hit.sha256, limit: 8192 });
  assert.equal(first.offset, 0); assert.equal(first.hasMore, true);
  let offset = 0, full = '';
  do { const page = readKnowledgeSource(reader, { sourceId: hit.sourceId, sha256: hit.sha256, offset, limit: 8192 }); full += page.text; offset = page.nextOffset; if (!page.hasMore) break; } while (offset < 131072);
  assert.match(full, /UNIQUE_LATE_FAILURE Ω🙂/); assert.doesNotMatch(full, /fixture-private|value"/);
  assert.throws(() => readKnowledgeSource(reader, { sourceId: hit.sourceId, sha256: '0'.repeat(64) }), /changed/);
  const worker = create(alpha, { role: 'executor', parentSessionId: reader.id }), foreign = create(beta);
  for (const target of [worker, foreign]) assert.throws(() => readKnowledgeSource(target, { sourceId: hit.sourceId, sha256: hit.sha256 }), /scope/);
  putRecord('session-deletion', session.id, { sessionId: session.id });
  assert.throws(() => readKnowledgeSource(reader, { sourceId: hit.sourceId, sha256: hit.sha256 }), /scope/);
});

test('source expansion uses byte boundaries and rejects modified complete messages', () => {
  const reader = create(alpha), event = source(session, 'Ω🙂 exact source');
  const hit = searchProjectKnowledge(reader, { query: 'exact', types: ['chat'] }).items[0];
  assert.equal(readKnowledgeSource(reader, { sourceId: hit.sourceId, sha256: hit.sha256, limit: 2 }).text, 'Ω');
  assert.throws(() => readKnowledgeSource(reader, { sourceId: hit.sourceId, sha256: hit.sha256, offset: 1 }), /UTF-8/);
  assert.throws(() => readKnowledgeSource(reader, { sourceId: hit.sourceId, sha256: hit.sha256, limit: 1 }), /too short/);
  database().prepare('UPDATE events SET data=? WHERE session_id=? AND seq=?').run(JSON.stringify({ text: 'changed source' }), session.id, Number(event.id.split(':')[1]));
  assert.throws(() => readKnowledgeSource(reader, { sourceId: hit.sourceId, sha256: hit.sha256 }), /changed/);
});

test('signatures preserve semantic error codes and versions while removing private variable data', () => {
  assert.notEqual(signature().signatureHash, signature('25.0.0').signatureHash);
  assert.notEqual(signature().signatureHash, signature('24.0.0', 'node.js HTTP 401 failed at /tmp/run-123/client.js').signatureHash);
  assert.equal(normalizeErrorSignature('SQLSTATE[23505] postgres duplicate').errorCode, '23505');
  assert.equal(normalizeErrorSignature('SQLSTATE 08006 postgres connection').errorCode, '08006');
  const one = normalizeErrorSignature('ENOENT /tmp/random-a.js request-id=aabbcc password="fixture-secret\nsecondline"', { tool: 'shell' });
  const two = normalizeErrorSignature('ENOENT /tmp/random-b.js request-id=ddeeff password="other\ncredential"', { tool: 'shell' });
  assert.equal(one.signatureHash, two.signatureHash); assert.doesNotMatch(JSON.stringify(one), /fixture-secret|secondline|random-a|aabbcc/);
  assert.throws(() => remember(session, { kind: 'hypothesis', statement: 'password="\nfixture-private-value"' }), /authentication|credential|private/);
  assert.doesNotMatch(JSON.stringify(normalizeErrorSignature('HTTP 403 password="fixture\\"private-tail"')), /fixture|private-tail/);
});

test('typed resolutions are scoped, idempotent, version-aware and never promote sequence into cause', () => {
  const value = resolution(), reader = create(alpha), foreign = create(beta);
  assert.equal(value.truth, 'hypothesis'); assert.equal(value.causeVerified, false);
  assert.equal(value.unknownInputCoverage, true); assert.equal(value.applicability.currentProjectValidated, false);
  const match = lookupResolutions(reader, { signature: signature() }).items;
  assert.equal(match[0].id, value.id); assert.equal(match[0].match, 'exact-signature');
  assert.deepEqual(lookupResolutions(reader, { signature: signature('25.0.0') }).items, []);
  assert.deepEqual(lookupResolutions(foreign, { signature: signature() }).items, []);
  const worker = create(alpha, { role: 'executor', parentSessionId: reader.id });
  assert.deepEqual(lookupResolutions(worker, { signature: signature() }).items, []);
  reviewMemory(session, value.memoryId, { truth: 'confirmed', expectedRevision: 1, rationale: 'Owner reviewed the procedure.', explicit: true });
  const reviewed = resolutionView(reader, value.id); assert.equal(reviewed.procedureTruth, 'confirmed'); assert.equal(reviewed.causeVerified, false);
  const initial = getRecord('memory', value.memoryId); assert.equal(initial.provenance, 'agent-recorded');
  assert.throws(() => recordResolution(foreign, { signature: signature(), symptom: 'wrong scope', fixSteps: ['review'], sourceIds: value.sourceIds }, { requestId: 'foreign' }), /engagement/);
});

test('changed inputs, expired facts and contradictions suppress remembered procedures', () => {
  fs.writeFileSync(path.join(alpha, 'package-lock.json'), 'version one');
  const value = resolution({ inputs: ['package-lock.json'] });
  assert.equal(value.unknownInputCoverage, false); assert.equal(value.applicability.coverage, 'recorded-inputs-only');
  assert.equal(lookupResolutions(session, { signature: signature() }).items.length, 1);
  fs.writeFileSync(path.join(alpha, 'package-lock.json'), 'version two');
  assert.deepEqual(lookupResolutions(session, { signature: signature() }).items, []);
  assert.ok(lookupResolutions(session, { signature: signature(), includeStale: true }).items[0].staleReasons.includes('recorded-input-changed'));
  const expired = resolution({ freshness: { expiresAt: '2000-01-01T00:00:00Z' } }, 'expired');
  assert.equal(resolutionView(session, expired.id).stale, true);
  const contradicted = resolution({}, 'contradicted');
  remember(session, { kind: 'hypothesis', statement: 'Current evidence contradicts this earlier procedure.', contradictions: [contradicted.memoryId] });
  assert.equal(lookupResolutions(session, { signature: signature() }).items.some(item => item.id === contradicted.id), false);
});

test('learning resolution publication uses a sealed packet and retains an explicitly null goal', () => {
  session.goal = { id: 'old-goal', status: 'active' }; saveSession(session);
  const event = source(), hostSignature = signature(), packet = { version: 2, id: 'packet-id', sessionId: session.id, projectId: session.projectId,
    throughSeq: Number(event.id.split(':')[1]), signatures: [hostSignature], sourceRefs: [{ id: event.id }] };
  const job = { id: 'job-id', state: 'running', packetId: packet.id, sessionId: session.id, projectId: session.projectId, throughSeq: packet.throughSeq,
    goalId: null, sourceRefs: packet.sourceRefs };
  putRecord('core.learning.job', job.id, job); putRecord('core.learning.packet', packet.id, packet);
  const proposal = { signatureHash: hostSignature.signatureHash, symptom: 'Observed registry failure.', rootCause: 'Cause remains uncertain.', fixSteps: ['Review current registry configuration.'], sourceIds: [event.id] };
  assert.throws(() => publishLearningResolutions(session, [proposal], { jobId: job.id, packet: { ...packet, throughSeq: 999 } }), /packet/);
  const first = publishLearningResolutions(session, [proposal], { jobId: job.id, packet })[0]; assert.equal(first.goalId, null);
  assert.equal(first.unknownInputCoverage, true); assert.equal(first.applicability.currentProjectValidated, false);
  putRecord('core.learning.job', job.id, { ...job, state: 'completed' });
  assert.equal(publishLearningResolutions(session, [proposal], { jobId: job.id, packet })[0].id, first.id);
  assert.throws(() => publishLearningResolutions(session, [{ ...proposal, truth: 'confirmed' }], { jobId: job.id, packet }), /only propose/);
});

test('project facts are a budgeted current projection with explicit owner pins and CAS', () => {
  const learned = remember(session, { kind: 'hypothesis', statement: 'An unreviewed model suggestion must not automatically enter every prompt.' });
  assert.equal(projectFactsView(session).items.length, 0);
  const reviewed = remember(session, { kind: 'hypothesis', statement: 'Owner prefers reproducible local fixtures for project verification.', evidence: [artifact(session, 'reviewed fixture', 'source control').id] });
  reviewMemory(session, reviewed.id, { truth: 'confirmed', expectedRevision: 1, rationale: 'Owner confirmed this project preference.', explicit: true });
  assert.equal(projectFactsView(session).items[0].id, reviewed.id);
  assert.equal(knowledgeContextFor(session, 'unrelated request').facts.items[0].id, reviewed.id);
  let view = configureProjectFacts(session, { ids: [learned.id], maxBytes: 2500 }, { expectedRevision: 0, reviewed: true });
  assert.equal(view.items.find(item => item.id === learned.id).truth, 'hypothesis'); assert.equal(view.pinCount, 1);
  assert.throws(() => configureProjectFacts(session, { enabled: false }, { expectedRevision: 0, reviewed: true }), /changed/);
  assert.ok(Buffer.byteLength(JSON.stringify(projectFactsView(session, { maxBytes: 512 }))) <= 512);
  remember(session, { kind: 'hypothesis', statement: 'This remembered preference is disputed.', contradictions: [reviewed.id] });
  assert.equal(projectFactsView(session).items.some(item => item.id === reviewed.id), false);
  const worker = create(alpha, { role: 'executor', parentSessionId: session.id });
  assert.equal(projectFactsView(worker).enabled, false);
  assert.throws(() => configureProjectFacts(worker, { ids: [] }, { expectedRevision: 0, reviewed: true }), /owner/);
});

test('retrieval enrichment combines request, current goal and typed failures without reviving old goals', () => {
  session.goal = { id: 'goal-a', status: 'active', objective: 'Investigate ownership invoice authorization controls.' }; saveSession(session);
  assert.match(enrichKnowledgeQuery(session, 'please help investigate registry', { activeSignatures: [signature()] }), /403 node.*registry.*ownership/);
  putRecord('run', session.id, { goalMode: false });
  assert.doesNotMatch(enrichKnowledgeQuery(session, 'registry'), /invoice|authorization/);
  assert.ok(Buffer.byteLength(JSON.stringify(knowledgeContextFor(session, 'registry', { activeSignatures: [signature()] }))) <= 12000);
});

const adapter = (embed = async text => /invoice|billing/i.test(text) ? [1, 0] : [0, 1], overrides = {}) =>
  ({ kind: 'local-embedding', local: true, model: 'fixture-local', modelVersion: 'v1', dimensions: 2, embed, ...overrides });
test('optional local embeddings are disabled by default, pinned, scoped and use an offline FTS fallback', async () => {
  const invoice = remember(session, { kind: 'hypothesis', statement: 'Inspect invoice ownership controls.' });
  assert.equal(retrievalSettings(session).localEmbeddingsEnabled, false);
  assert.equal((await searchProjectKnowledgeHybrid(session, { query: 'invoice' })).retrieval.mode, 'fts');
  assert.throws(() => configureRetrieval(session, { localEmbeddingsEnabled: true }, { expectedRevision: 0, reviewed: true }), /capability/);
  assert.throws(() => registerLocalEmbeddingAdapter({ ...adapter(), endpoint: 'https://example.invalid' }), /local Core/);
  registerLocalEmbeddingAdapter(adapter());
  configureRetrieval(session, { localEmbeddingsEnabled: true }, { expectedRevision: 0, reviewed: true });
  searchProjectKnowledge(session, { query: '' }); assert.equal((await refreshLocalEmbeddings(session)).indexed, 1);
  const found = await searchProjectKnowledgeHybrid(session, { query: 'billing' });
  assert.equal(found.retrieval.mode, 'local-hybrid'); assert.equal(found.items[0].sourceId, invoice.id);
  const other = create(beta); assert.deepEqual((await localSemanticCandidates(other, 'billing')).items, []);
  const worker = create(alpha, { role: 'executor', parentSessionId: session.id }); assert.deepEqual((await localSemanticCandidates(worker, 'billing')).items, []);
  registerLocalEmbeddingAdapter(adapter(undefined, { modelVersion: 'v2' }));
  assert.equal((await searchProjectKnowledgeHybrid(session, { query: 'invoice' })).retrieval.mode, 'fts');
  registerLocalEmbeddingAdapter(adapter(async () => [1]));
  assert.equal((await searchProjectKnowledgeHybrid(session, { query: 'invoice' })).retrieval.mode, 'fts');
  assert.equal(retrievalQualityStatus(session).samples.length > 0, true);
});

test('deleted sources, changed payloads and generation changes invalidate derived vectors', async () => {
  const other = create(alpha), memory = remember(other, { kind: 'hypothesis', statement: 'Invoice lookup uses the original owner controls.' });
  registerLocalEmbeddingAdapter(adapter()); configureRetrieval(session, { localEmbeddingsEnabled: true }, { expectedRevision: 0, reviewed: true });
  searchProjectKnowledge(session, { query: 'invoice' }); await refreshLocalEmbeddings(session);
  assert.equal((await localSemanticCandidates(session, 'billing')).items.length, 1);
  putRecord('memory', memory.id, { ...memory, statement: 'Changed source procedure.' }); searchProjectKnowledge(session, { query: 'invoice' });
  assert.deepEqual((await localSemanticCandidates(session, 'billing')).items, []);
  await refreshLocalEmbeddings(session); putRecord('session-deletion', other.id, { sessionId: other.id });
  assert.deepEqual((await localSemanticCandidates(session, 'billing')).items, []);
  const changed = configureRetrieval(session, { localEmbeddingsEnabled: false }, { expectedRevision: 1, reviewed: true });
  assert.equal(changed.generation, 2); assert.equal(database().prepare("SELECT count(*) AS n FROM records WHERE kind='core.retrieval.vector'").get().n, 0);
});

test('offline held-out benchmark measures delivered quality, scope, staleness and cost without exposing answers to search', async () => {
  const cases = [{ id: 'heldout-http', query: 'HTTP 403', relevantSourceIds: ['correct'], allowedSourceIds: ['correct', 'near'] },
    { id: 'heldout-registry', query: 'registry lockfile', relevantSourceIds: ['correct'], allowedSourceIds: ['correct'] }];
  let calls = 0;
  const result = await benchmarkRetrieval({ cases, k: 2, search: async input => {
    assert.deepEqual(Object.keys(input), ['query', 'limit']); calls++;
    return { items: [{ sourceId: 'correct', statement: 'Matching held-out source.' }] };
  } });
  assert.equal(calls, 2); assert.equal(result.precisionAtK, .5); assert.equal(result.returnedPrecision, 1); assert.equal(result.recallAtK, 1); assert.equal(result.meanReciprocalRank, 1);
  assert.equal(result.safetyPass, true); assert.equal(result.qualityPass, null); assert.ok(result.meanDeliveredBytes > 0); assert.ok(result.p95LatencyMs >= 0);
  const bad = await benchmarkRetrieval({ cases: cases.slice(0, 1), search: async () => ({ items: [{ sourceId: 'foreign', stale: true }] }) });
  assert.equal(bad.scopeLeaks, 1); assert.equal(bad.staleHits, 1); assert.equal(bad.safetyPass, false);
});

test('held-out groups cannot overlap calibration and answer containment measures excerpts plus bounded expansion', async () => {
  const sample = { query: 'registry', relevantSourceIds: ['one'], group: 'source-a', split: 'evaluation', expectedExcerptTerms: ['HTTP 403', 'lockfile'] };
  await assert.rejects(benchmarkRetrieval({ cases: [sample, { ...sample, split: 'calibration' }], search: async () => [] }), /disjoint/);
  const seen = [];
  const result = await benchmarkRetrieval({ cases: [sample, { ...sample, relevantSourceIds: ['two'], group: 'calibration-b', split: 'calibration' }], k: 1,
    search: async input => { seen.push(input); return { items: [{ sourceId: 'one', statement: 'HTTP 403 observed.' }] }; },
    expand: async item => { assert.equal(item.sourceId, 'one'); return { text: 'Review the lockfile.' }; }, minRecall: 1, minPrecision: 1 });
  assert.equal(seen.length, 1); assert.equal(seen[0].expectedExcerptTerms, undefined);
  assert.equal(result.excerptAnswerCoverage, .5); assert.equal(result.expandedAnswerCoverage, 1); assert.equal(result.qualityPass, true);
  assert.equal(result.calibrationCases, 1); assert.equal(result.sourceGroupsDisjoint, true);
});

test('clock contention cannot reduce deferred-session discovery below its bounded fair quantum', () => {
  const sources = [session]; session.executionState = 'running'; saveSession(session);
  for (let index = 0; index < 33; index++) sources.push(create(alpha, { executionState: 'running' }));
  sources.sort((a, b) => a.id.localeCompare(b.id)); const target = sources.at(-1);
  for (const item of sources.slice(0, -1)) appendEvent(item.id, 'text', { text: 'Unfinished legacy source.' });
  appendEvent(target.id, 'text', { text: 'FAIR_QUANTUM_TARGET', runId: 'r', threadRef: 't', itemId: 'i' });
  appendEvent(target.id, 'message.finalized', { runId: 'r', threadRef: 't', itemId: 'i' });
  const original = Date.now; let clock = original();
  Date.now = () => (clock += 1000);
  try { for (let tick = 0; tick < 5; tick++) refreshKnowledgeHistory(session, knowledgeAccess(session), { limit: 64 }); }
  finally { Date.now = original; }
  assert.ok(searchKnowledgeIndex(knowledgeAccess(session), sources.map(item => item.id), { query: 'FAIR_QUANTUM_TARGET', types: ['chat'] }).items.length);
});
