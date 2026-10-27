import { performance } from 'node:perf_hooks';
import { database, getRecord, putRecord, digest, now, transaction } from './database.js';
import { knowledgeAccess, allowedKnowledgeSessionIds, knowledgeDatabase, cleanKnowledgeText } from './knowledge-index.js';

let localAdapter = null;
const fail = message => { throw Object.assign(new Error(message), { code: 'RETRIEVAL_CONFIGURATION' }); };
const pin = value => ({ model: value.model, modelVersion: value.modelVersion, dimensions: value.dimensions });
const equalPin = (a, b) => a && b && digest(pin(a)) === digest(pin(b));
const owner = session => {
  const access = knowledgeAccess(session);
  if (access.disabled || access.restricted || session.parentSessionId || session.assignmentId) fail('Retrieval configuration belongs to the project owner context.');
  return access;
};

// This is a trusted Core host capability, never an endpoint or tool supplied by
// a model. No backend is bundled, installed, downloaded or contacted here.
export function registerLocalEmbeddingAdapter(adapter) {
  if (adapter === null) { localAdapter = null; return; }
  if (!adapter || adapter.kind !== 'local-embedding' || adapter.local !== true || typeof adapter.embed !== 'function' ||
      Object.keys(adapter).some(key => !['kind', 'local', 'model', 'modelVersion', 'dimensions', 'embed'].includes(key)) ||
      ![adapter.model, adapter.modelVersion].every(value => typeof value === 'string' && /^[A-Za-z0-9_.:/-]{1,120}$/.test(value)) ||
      !Number.isSafeInteger(adapter.dimensions) || adapter.dimensions < 1 || adapter.dimensions > 4096) fail('Register an explicit local Core embedding capability with immutable model/version/dimension pins.');
  localAdapter = Object.freeze({ ...adapter });
}

export function retrievalSettings(session) {
  const access = knowledgeAccess(session), saved = getRecord('core.retrieval.settings', access.project.id);
  const settings = { projectId: access.project.id, revision: 0, generation: 0, localEmbeddingsEnabled: false, model: null, modelVersion: null, dimensions: null, ...saved };
  return { ...settings, available: Boolean(localAdapter && equalPin(localAdapter, settings)), fallback: 'scoped-fts' };
}

export function configureRetrieval(session, input, { expectedRevision, reviewed = false } = {}) {
  const access = owner(session);
  if (!reviewed || !input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'localEmbeddingsEnabled') ||
      typeof input.localEmbeddingsEnabled !== 'boolean' || input.localEmbeddingsEnabled && !localAdapter) fail('Explicitly review local retrieval settings; enabling requires a registered local capability.');
  return transaction(db => {
    owner(session);
    const prior = retrievalSettings(session);
    if (expectedRevision !== prior.revision) throw Object.assign(new Error('Retrieval settings changed. Reload their revision.'), { code: 'CONFLICT' });
    const value = { projectId: access.project.id, revision: prior.revision + 1, generation: prior.generation + 1,
      localEmbeddingsEnabled: input.localEmbeddingsEnabled, ...(localAdapter ? pin(localAdapter) : { model: null, modelVersion: null, dimensions: null }), updatedAt: now() };
    putRecord('core.retrieval.settings', access.project.id, value, db);
    db.prepare(`DELETE FROM records WHERE kind='core.retrieval.vector' AND json_extract(data,'$.projectId')=?`).run(access.project.id);
    return retrievalSettings(session);
  });
}

function vector(value, dimensions) {
  if (!Array.isArray(value) || value.length !== dimensions || value.some(item => typeof item !== 'number' || !Number.isFinite(item)) || !value.some(item => item !== 0)) fail('Local embedding returned an invalid vector.');
  const norm = Math.hypot(...value);
  if (!Number.isFinite(norm) || !norm) fail('Local embedding norm is invalid.');
  return value.map(item => item / norm);
}
function available(session) {
  const access = knowledgeAccess(session), settings = retrievalSettings(session);
  if (access.disabled || !settings.localEmbeddingsEnabled) return { access, settings, reason: 'disabled' };
  if (!localAdapter || !equalPin(localAdapter, settings)) return { access, settings, reason: 'local-capability-unavailable-or-changed' };
  return { access, settings, adapter: localAdapter };
}
const docHash = doc => digest([doc.body, doc.payload]);
function boundedText(value, maxBytes) {
  const bytes = Buffer.from(cleanKnowledgeText(value, value.length));
  let end = Math.min(bytes.length, maxBytes);
  while (end < bytes.length && end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}
async function embed(adapter, text, dimensions) {
  let timer;
  try {
    return vector(await Promise.race([Promise.resolve().then(() => adapter.embed(text)), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Local embedding time budget reached.')), 250);
    })]), dimensions);
  } finally { clearTimeout(timer); }
}

export async function refreshLocalEmbeddings(session, { limit = 8 } = {}) {
  owner(session);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 16) fail('Use a bounded local embedding maintenance batch.');
  const start = performance.now(), state = available(session);
  if (!state.adapter) return { indexed: 0, fallback: state.reason, latencyMs: performance.now() - start };
  const { access, settings, adapter } = state, ids = allowedKnowledgeSessionIds(session, access), db = knowledgeDatabase();
  // The recent document window and each maintenance batch have explicit caps.
  const rows = db.prepare(`SELECT d.* FROM knowledge_documents d WHERE d.project_id=? AND d.session_id IN (SELECT value FROM json_each(?))
    AND (d.kind!='chat' OR json_extract(d.payload,'$.sourceVersion')=2) ORDER BY d.updated_at DESC LIMIT 2000`).all(access.project.id, JSON.stringify(ids));
  let indexed = 0, inputBytes = 0;
  for (const doc of rows) {
    if (getRecord('session-deletion', doc.session_id)) continue;
    const id = digest([access.project.id, settings.generation, doc.key]), sourceHash = docHash(doc), prior = getRecord('core.retrieval.vector', id);
    if (prior?.sourceHash === sourceHash && equalPin(prior, settings)) continue;
    const text = boundedText(doc.body, 2000);
    let result;
    try { result = await embed(adapter, text, settings.dimensions); }
    catch { return { indexed, inputBytes, fallback: 'local-capability-failed', latencyMs: performance.now() - start }; }
    const current = available(session), live = db.prepare('SELECT * FROM knowledge_documents WHERE key=?').get(doc.key);
    if (current.adapter !== adapter || current.settings.generation !== settings.generation || !live || docHash(live) !== sourceHash ||
        !allowedKnowledgeSessionIds(session, current.access).includes(doc.session_id) || getRecord('session-deletion', doc.session_id)) return { indexed, inputBytes, fallback: 'generation-or-source-changed', latencyMs: performance.now() - start };
    putRecord('core.retrieval.vector', id, { id, projectId: access.project.id, sessionId: doc.session_id, documentKey: doc.key,
      sourceId: doc.source_id, sourceHash, generation: settings.generation, ...pin(settings), vector: result, createdAt: now() });
    indexed++; inputBytes += Buffer.byteLength(text);
    if (indexed >= limit) break;
  }
  return { indexed, inputBytes, local: true, generation: settings.generation, windowBounded: rows.length === 2000, latencyMs: performance.now() - start };
}

export async function localSemanticCandidates(session, query, { limit = 12, types, excludeChatSessionId } = {}) {
  const state = available(session), start = performance.now();
  if (typeof query !== 'string' || query.length > 500 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) fail('Use a bounded semantic query.');
  if (!state.adapter) return { items: [], fallback: state.reason, latencyMs: performance.now() - start };
  const { access, settings, adapter } = state, ids = allowedKnowledgeSessionIds(session, access), db = knowledgeDatabase();
  // Scope is applied in SQL before vector access, not after global similarity.
  const rows = db.prepare(`SELECT data FROM records WHERE kind='core.retrieval.vector' AND json_extract(data,'$.projectId')=?
    AND json_extract(data,'$.generation')=? AND json_extract(data,'$.sessionId') IN (SELECT value FROM json_each(?)) LIMIT 2000`)
    .all(access.project.id, settings.generation, JSON.stringify(ids));
  try {
    const queryVector = await embed(adapter, cleanKnowledgeText(query, 500), settings.dimensions), current = available(session);
    if (current.adapter !== adapter || current.settings.generation !== settings.generation) return { items: [], fallback: 'generation-changed', latencyMs: performance.now() - start };
    const stillAllowed = allowedKnowledgeSessionIds(session, current.access), items = [];
    for (const row of rows) {
      const record = JSON.parse(row.data);
      if (!stillAllowed.includes(record.sessionId) || getRecord('session-deletion', record.sessionId) || !equalPin(record, settings)) continue;
      const doc = db.prepare('SELECT * FROM knowledge_documents WHERE key=? AND project_id=? AND session_id=?').get(record.documentKey, access.project.id, record.sessionId);
      if (!doc || docHash(doc) !== record.sourceHash || types && !types.includes(doc.kind) || excludeChatSessionId === doc.session_id && doc.kind === 'chat') continue;
      const v = vector(record.vector, settings.dimensions), score = queryVector.reduce((sum, item, index) => sum + item * v[index], 0);
      if (score <= 0) continue;
      items.push({ ...JSON.parse(doc.payload), kind: doc.kind, sourceId: doc.source_id, sessionId: doc.session_id, projectId: doc.project_id,
        excerpt: cleanKnowledgeText(doc.body, 1500), score, whyMatched: 'Optional local semantic similarity; relevance and validity require source review.' });
    }
    return { items: items.sort((a, b) => b.score - a.score || a.sourceId.localeCompare(b.sourceId)).slice(0, limit), local: true, generation: settings.generation, latencyMs: performance.now() - start };
  } catch { return { items: [], fallback: 'local-capability-failed', latencyMs: performance.now() - start }; }
}

// Cases contain queries + held-out relevant source IDs, never answer text in
// the search input. This evaluator performs no model calls and saves no corpus.
export async function benchmarkRetrieval({ cases, search, expand, k = 8, latencyBudgetMs = 100, minRecall, minPrecision } = {}) {
  if (!Array.isArray(cases) || !cases.length || cases.length > 200 || typeof search !== 'function' || !Number.isSafeInteger(k) || k < 1 || k > 50 ||
      !Number.isFinite(latencyBudgetMs) || latencyBudgetMs <= 0 || cases.some(value => !value || typeof value.query !== 'string' || value.query.length > 500 ||
        !Array.isArray(value.relevantSourceIds) || !value.relevantSourceIds.length || value.relevantSourceIds.some(id => typeof id !== 'string') ||
        value.expectedExcerptTerms !== undefined && (!Array.isArray(value.expectedExcerptTerms) || !value.expectedExcerptTerms.length || value.expectedExcerptTerms.length > 16 || value.expectedExcerptTerms.some(term => typeof term !== 'string' || !term || term.length > 200))) ||
      expand !== undefined && typeof expand !== 'function' || [minRecall, minPrecision].some(value => value !== undefined && (!Number.isFinite(value) || value < 0 || value > 1))) fail('Use bounded held-out retrieval cases with relevant source IDs.');
  const grouped = cases.some(value => value.group !== undefined || value.split !== undefined);
  if (grouped) {
    if (cases.some(value => typeof value.group !== 'string' || !value.group || value.group.length > 120 || !['calibration', 'evaluation'].includes(value.split))) fail('Grouped cases require an explicit source group and calibration/evaluation split.');
    const calibrationGroups = new Set(cases.filter(value => value.split === 'calibration').map(value => value.group));
    const calibrationSources = new Set(cases.filter(value => value.split === 'calibration').flatMap(value => value.relevantSourceIds));
    if (cases.some(value => value.split === 'evaluation' && calibrationGroups.has(value.group))) fail('Calibration and held-out evaluation must have disjoint source groups.');
    if (cases.some(value => value.split === 'evaluation' && value.relevantSourceIds.some(id => calibrationSources.has(id)))) fail('Calibration and held-out evaluation must have disjoint source IDs.');
  }
  const evaluated = grouped ? cases.filter(value => value.split === 'evaluation') : cases;
  if (!evaluated.length) fail('Provide at least one held-out evaluation case.');
  let precision = 0, returnedPrecision = 0, recall = 0, reciprocalRank = 0, deliveredBytes = 0, staleHits = 0, scopeLeaks = 0, excerptCoverage = 0, expandedCoverage = 0, answerCases = 0, expansionBytes = 0;
  const latencies = [], rows = [];
  for (const sample of evaluated) {
    const start = performance.now(), response = await search({ query: sample.query, limit: k }), latencyMs = performance.now() - start;
    const items = (Array.isArray(response) ? response : response?.items || []).slice(0, k), relevant = new Set(sample.relevantSourceIds);
    const found = new Set(items.filter(item => relevant.has(item.sourceId)).map(item => item.sourceId)), rank = items.findIndex(item => relevant.has(item.sourceId));
    precision += found.size / k; returnedPrecision += found.size / Math.max(items.length, 1); recall += found.size / relevant.size; reciprocalRank += rank < 0 ? 0 : 1 / (rank + 1);
    const bytes = Buffer.byteLength(JSON.stringify(items)); deliveredBytes += bytes; latencies.push(latencyMs);
    staleHits += items.filter(item => item.stale || item.disputed).length;
    scopeLeaks += items.filter(item => sample.allowedSourceIds && !sample.allowedSourceIds.includes(item.sourceId)).length;
    let excerptAnswerCoverage = null, expandedAnswerCoverage = null;
    if (sample.expectedExcerptTerms?.length) {
      answerCases++;
      const excerpts = items.map(item => item.statement || item.excerpt || item.text || '').join('\n').toLowerCase();
      const coverage = value => sample.expectedExcerptTerms.filter(term => value.includes(term.toLowerCase())).length / sample.expectedExcerptTerms.length;
      excerptAnswerCoverage = coverage(excerpts); excerptCoverage += excerptAnswerCoverage;
      let expanded = excerpts;
      if (expand) for (const item of items.slice(0, 3)) {
        const response = await expand(item), text = cleanKnowledgeText(typeof response === 'string' ? response : response?.text || '', 8192);
        expansionBytes += Buffer.byteLength(text); expanded += '\n' + text.toLowerCase();
      }
      expandedAnswerCoverage = coverage(expanded); expandedCoverage += expandedAnswerCoverage;
    }
    rows.push({ id: typeof sample.id === 'string' ? sample.id.slice(0, 80) : String(rows.length + 1), returned: items.length, relevant: found.size, latencyMs, deliveredBytes: bytes, excerptAnswerCoverage, expandedAnswerCoverage });
  }
  latencies.sort((a, b) => a - b);
  const result = { version: 1, cases: evaluated.length, calibrationCases: cases.length - evaluated.length, sourceGroupsDisjoint: grouped ? true : null,
    k, precisionAtK: precision / evaluated.length, returnedPrecision: returnedPrecision / evaluated.length, recallAtK: recall / evaluated.length,
    meanReciprocalRank: reciprocalRank / evaluated.length, p95LatencyMs: latencies[Math.ceil(latencies.length * .95) - 1], latencyBudgetMs,
    meanDeliveredBytes: deliveredBytes / evaluated.length, estimatedPromptTokens: Math.ceil(deliveredBytes / evaluated.length / 4),
    answerCases, excerptAnswerCoverage: answerCases ? excerptCoverage / answerCases : null, expandedAnswerCoverage: answerCases ? expandedCoverage / answerCases : null,
    expansionBytes, staleHits, scopeLeaks, rows };
  const safetyPass = staleHits === 0 && scopeLeaks === 0;
  return { ...result, withinLatencyBudget: result.p95LatencyMs <= latencyBudgetMs, safetyPass,
    qualityPass: minRecall !== undefined && minPrecision !== undefined ? safetyPass && result.recallAtK >= minRecall && result.precisionAtK >= minPrecision : null };
}

export function retrievalQualityStatus(session) {
  const access = knowledgeAccess(session), ids = allowedKnowledgeSessionIds(session, access);
  const rows = database().prepare(`SELECT data FROM records WHERE kind='core.retrieval.metric' AND json_extract(data,'$.projectId')=?
    AND json_extract(data,'$.sessionId') IN (SELECT value FROM json_each(?)) ORDER BY updated_at DESC LIMIT 24`).all(access.project.id, JSON.stringify(ids));
  return { settings: retrievalSettings(session), samples: rows.map(row => JSON.parse(row.data)), evaluation: 'offline held-out source relevance; counters are not proof of learning' };
}

export function recordRetrievalMetric(session, metric) {
  const access = knowledgeAccess(session);
  if (access.disabled || !metric || !['fts', 'local-hybrid'].includes(metric.mode) || !Number.isFinite(metric.latencyMs) || metric.latencyMs < 0 ||
      !Number.isSafeInteger(metric.returned) || metric.returned < 0 || metric.returned > 50 || !Number.isSafeInteger(metric.deliveredBytes) || metric.deliveredBytes < 0 || metric.deliveredBytes > 1024 * 1024) return;
  const id = `${session.id}:${Date.now()}:${digest(metric).slice(0, 8)}`;
  putRecord('core.retrieval.metric', id, { id, sessionId: session.id, projectId: access.project.id, mode: metric.mode, latencyMs: metric.latencyMs,
    returned: metric.returned, deliveredBytes: metric.deliveredBytes, estimatedPromptTokens: Math.ceil(metric.deliveredBytes / 4), createdAt: now() });
  database().prepare(`DELETE FROM records WHERE kind='core.retrieval.metric' AND json_extract(data,'$.sessionId')=? AND id NOT IN
    (SELECT id FROM records WHERE kind='core.retrieval.metric' AND json_extract(data,'$.sessionId')=? ORDER BY updated_at DESC LIMIT 24)`).run(session.id, session.id);
}
