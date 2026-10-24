import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { database, digest, getRecord, putRecord, appendEvent, now, transaction } from './database.js';
import { inside, fileInfo } from './evidence.js';
import { writeProjectRecord, projectRecords, agentRecords } from './project.js';
import { assertPublicWorkspacePath } from './private-paths.js';
import { recordBelongsToProject } from './project-identity.js';
import { knowledgeAccess, allowedKnowledgeSessionIds, assertKnowledgeText, indexKnowledgeRecord, searchKnowledgeIndex, scopedRecord } from './knowledge-index.js';

const kinds = ['observation', 'hypothesis', 'experiment', 'failed_approach', 'conclusion', 'decision', 'inconclusive', 'disproved', 'blocked', 'question'];
export const memoryTruthStates = ['hypothesis', 'observed', 'confirmed', 'disproved', 'inconclusive', 'stale'];
const atomic = operation => database().isTransaction ? operation(database()) : transaction(operation);
const list = (value, maximum = 32) => { if (!Array.isArray(value) || value.length > maximum || value.some(item => typeof item !== 'string' || !item)) throw new Error('Knowledge references must be a bounded list of strings.'); return [...new Set(value)]; };
const text = (value, maximum, optional = false) => optional && (value == null || value === '') ? '' : assertKnowledgeText(value, maximum);
export const knowledgeVerificationBudget = () => ({ bytes: 64 * 1024 * 1024, files: 128, fingerprints: new Map() });
function currentFileInfo(file, budget) {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('Evidence must remain a regular unlinked file.');
  const signature = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`, old = budget?.fingerprints.get(file);
  if (old?.signature === signature) return old.value;
  if (budget && (budget.files-- <= 0 || (budget.bytes -= info.size) < 0)) throw new Error('Knowledge verification budget reached.');
  const value = fileInfo(file);
  budget?.fingerprints.set(file, { signature, value }); return value;
}

function inputInfo(root, relative, budget) {
  assertPublicWorkspacePath(relative);
  const file = inside(root, relative), stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Memory inputs must be regular, unlinked project files.');
  return currentFileInfo(file, budget);
}
function validEvidence(session, ids, access) {
  const allowed = allowedKnowledgeSessionIds(session, access);
  return list(ids || []).map(id => {
    const item = getRecord('artifact', id);
    if (!item || !(allowed.includes(item.sessionId) || access.restricted && (session.allowedArtifactIds || []).includes(id))) throw new Error('Memory evidence must reference this session’s recorded artifacts or explicitly authorized project evidence.');
    return id;
  });
}
function freshCondition(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['expiresAt', 'environment', 'version', 'conditions'].includes(key))) throw new Error('Invalid knowledge freshness conditions.');
  const result = {};
  if (input.expiresAt != null) {
    if (typeof input.expiresAt !== 'string' || !Number.isFinite(Date.parse(input.expiresAt))) throw new Error('Knowledge expiry must be an ISO timestamp.');
    result.expiresAt = new Date(input.expiresAt).toISOString();
  }
  for (const key of ['environment', 'version']) if (input[key] != null) result[key] = text(input[key], 300);
  if (input.conditions != null) result.conditions = list(input.conditions, 12).map(value => text(value, 500));
  return result;
}
function verificationFor(session, input, evidence) {
  if (!input.verificationId) return null;
  const receipt = getRecord('acceptance', input.verificationId);
  const requirement = receipt?.requirements?.find(item => item.id === input.requirementId);
  if (!receipt?.passed || receipt.importProvenance || receipt.importedUntrusted || receipt.sessionId !== session.id
    || !requirement?.passed || requirement.stale || requirement.assessment?.importProvenance || requirement.assessment?.importedUntrusted || requirement.assessment?.status !== 'supported'
    || !receipt.checks?.length || receipt.checks.some(check => !check.passed) || !evidence.length
    || evidence.some(id => !requirement.assessment.evidence?.includes(id))) throw new Error('Confirmed knowledge requires matching accepted evidence and successful declared verification checks.');
  for (const id of evidence) {
    const item = getRecord('artifact', id);
    try { if (!item || item.importProvenance || item.importedUntrusted || fileInfo(item.path).sha256 !== item.sha256 || item.source && fileInfo(inside(item.sourceWorkspace, item.source)).sha256 !== item.sourceSha256) throw new Error('changed'); }
    catch { throw new Error('Confirmed knowledge requires current unchanged evidence.'); }
  }
  return { source: 'core-acceptance', id: receipt.id, requirementId: requirement.id, level: receipt.level, recordedAt: now() };
}
function sourceReference(session, sourceId, access) {
  if (sourceId == null) return null;
  if (typeof sourceId !== 'string' || sourceId.length > 160) throw new Error('Invalid knowledge source reference.');
  const match = /^([a-f0-9-]{36}):(\d+)$/.exec(sourceId), allowed = allowedKnowledgeSessionIds(session, access);
  const event = match && database().prepare('SELECT session_id FROM events WHERE seq=? AND session_id=?').get(Number(match[2]), match[1]);
  if (!event || !allowed.includes(event.session_id)) throw new Error('Knowledge source must be an authorized conversation event.');
  return sourceId;
}

export function remember(session, input, { learningJobId, sourceIds = [] } = {}) {
  const access = knowledgeAccess(session);
  if (access.disabled || !kinds.includes(input.kind)) throw new Error(`Memory needs a statement and kind: ${kinds.join(', ')}.`);
  const statement = text(input.statement, 6000), rationale = text(input.rationale, 4000, true), revisitWhen = text(input.revisitWhen, 1000, true);
  const evidence = validEvidence(session, input.evidence, access);
  if (['observation', 'disproved'].includes(input.kind) && !evidence.length) throw new Error('Observations and disprovals need recorded evidence.');
  const requestedTruth = input.truth || ({ observation: 'observed', hypothesis: 'hypothesis', disproved: 'disproved' }[input.kind] || 'inconclusive');
  if (!memoryTruthStates.includes(requestedTruth)) throw new Error('Invalid memory truth state.');
  const verification = verificationFor(session, input, evidence);
  if (requestedTruth === 'confirmed' && !verification) throw new Error('A model assertion cannot confirm knowledge without a Core verification receipt or explicit owner review.');
  const truth = requestedTruth === 'disproved' && !verification ? 'inconclusive' : requestedTruth;
  const inputs = list(input.inputs || []).map(relative => {
    const absolute = inside(session.cwd, relative), normalized = path.relative(access.project.root, absolute);
    if (normalized.startsWith('..' + path.sep) || path.isAbsolute(normalized)) throw new Error('Memory inputs must remain in this engagement. Record worker output as selected evidence instead.');
    return { path: normalized, ...inputInfo(session.cwd, relative) };
  });
  const freshness = freshCondition(input.freshness), contradictions = list(input.contradictions || []), sourceId = sourceReference(session, input.sourceId, access);
  const allowed = allowedKnowledgeSessionIds(session, access);
  for (const id of [...contradictions, ...(input.supersedes ? [input.supersedes] : [])]) {
    const previous = getRecord('memory', id);
    if (!previous || !scopedRecord(previous, access, allowed)) throw new Error('Related knowledge must belong to the same authorized engagement.');
  }
  if (input.requestId != null && (typeof input.requestId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(input.requestId))) throw new Error('Use a bounded knowledge request ID.');
  const request = input.requestId && `${session.id}:${input.requestId}`, hash = digest(input);
  let provenance = 'agent-recorded';
  if (learningJobId) {
    const job = getRecord('core.learning.job', learningJobId);
    if (!job || job.state !== 'running' || job.sessionId !== session.id || job.projectId !== access.project.id || (job.agentNamespace ?? null) !== (session.agentNamespace ?? null)
      || !Array.isArray(sourceIds) || sourceIds.some(id => !job.sourceRefs?.some(ref => ref.id === id))) throw new Error('Learning provenance does not match the active authorized review.');
    provenance = { kind: 'learning', jobId: learningJobId, sourceSessionId: session.id, sourceIds: sourceIds.slice(0, 32) };
  }
  const record = atomic(db => {
    const existing = request && getRecord('core.memory.request', request);
    if (existing) { if (existing.digest !== hash) throw new Error('Knowledge request ID was reused with different content.'); return existing.record; }
    if (learningJobId && getRecord('core.learning.job', learningJobId)?.state !== 'running') throw new Error('Learning review is no longer active.');
    if (input.supersedes) {
      const old = getRecord('memory', input.supersedes);
      if ((old.revision || 1) !== input.expectedRevision) throw new Error('Knowledge changed. Review its revision before superseding it.');
    }
    const saved = { id: randomUUID(), project: access.project.root, projectId: access.project.id, agent: session.agentNamespace, sessionId: session.id,
      kind: input.kind, statement, rationale, evidence, inputs, freshness, revisitWhen, truth, claimedTruth: requestedTruth,
      verification, contradictions, supersedes: input.supersedes || null, revision: 1, sourceId, createdAt: now(),
      provenance, invalidatedAt: null, scope: 'project' };
    putRecord('memory', saved.id, saved, db);
    putRecord('core.memory.revision', `${saved.id}:1`, saved, db);
    if (request) putRecord('core.memory.request', request, { digest: hash, record: saved }, db);
    appendEvent(session.id, 'memory', { id: saved.id, kind: saved.kind, statement: saved.statement, truth, projectId: saved.projectId }, db);
    return saved;
  });
  writeProjectRecord(session, 'memory', record.id, record);
  indexKnowledgeRecord(access.project, 'memory', record.id, session.id, `${record.statement}\n${record.rationale}`, record);
  return record;
}

export function memoryFreshness(record, project, session = {}, { budget } = {}) {
  const semanticKind = record.recordKind || record.kind;
  let budgetExceeded = false;
  const staleInputs = (record.inputs || []).filter(input => { try { return inputInfo(project.root, input.path, budget).sha256 !== input.sha256; } catch (error) { budgetExceeded ||= /budget/.test(error.message); return true; } }).map(input => input.path);
  const reasons = [];
  if (record.invalidatedAt || record.truth === 'stale') reasons.push('explicitly-invalidated');
  if (record.importProvenance || record.importedUntrusted) reasons.push('imported-history-requires-revalidation');
  if (staleInputs.length) reasons.push('recorded-input-changed');
  if (record.freshness?.expiresAt && Date.parse(record.freshness.expiresAt) <= Date.now()) reasons.push('expired');
  if (record.freshness?.environment && record.freshness.environment !== session.environmentFingerprint) reasons.push('environment-unconfirmed-or-changed');
  if (record.freshness?.version && record.freshness.version !== session.projectVersion) reasons.push('version-unconfirmed-or-changed');
  const access = session?.id && session?.cwd ? knowledgeAccess(session) : null;
  const visible = item => item && typeof item.sessionId === 'string' && item.sessionId.trim() && recordBelongsToProject(item, project) && !getRecord('session-deletion', item.sessionId)
    && (!access?.restricted || item.sessionId === session.id);
  const sourceId = typeof record.id === 'string' && record.id.trim() ? record.id : null;
  const newer = sourceId ? database().prepare(`SELECT data FROM records WHERE kind='memory' AND json_extract(data,'$.supersedes')=? LIMIT 32`).all(sourceId)
    .map(row => JSON.parse(row.data)).find(visible) : null;
  if (newer) reasons.push('superseded');
  const reverse = sourceId ? database().prepare(`SELECT data FROM records WHERE kind='memory' AND EXISTS
    (SELECT 1 FROM json_each(json_extract(records.data,'$.contradictions')) WHERE value=?) LIMIT 32`).all(sourceId)
    .map(row => JSON.parse(row.data)).filter(item => visible(item) && !item.invalidatedAt) : [];
  const contradictions = [...new Set([...(record.contradictions || []).filter(id => typeof id === 'string' && visible(getRecord('memory', id))), ...reverse.map(item => item.id)])];
  for (const id of record.evidence || []) {
    const evidence = getRecord('artifact', id);
    try {
      if (!evidence || currentFileInfo(evidence.path, budget).sha256 !== evidence.sha256 || evidence.source && currentFileInfo(inside(evidence.sourceWorkspace, evidence.source), budget).sha256 !== evidence.sourceSha256) reasons.push('evidence-unavailable-or-changed');
    } catch (error) { budgetExceeded ||= /budget/.test(error.message); reasons.push('evidence-unavailable-or-changed'); }
  }
  if (budgetExceeded) reasons.push('verification-budget-reached');
  return { ...record, truth: reasons.length ? 'stale' : record.truth || (semanticKind === 'observation' ? 'observed' : semanticKind === 'hypothesis' ? 'hypothesis' : 'inconclusive'),
    stale: reasons.length > 0, staleInputs, staleReasons: [...new Set(reasons)], supersededBy: newer?.id || null,
    contradictions, disputed: contradictions.length > 0 };
}

export function projectMemories(project, { session, access, sessionIds, evaluateFreshness = true } = {}) {
  const db = database(), locations = JSON.stringify(project.aliases);
  const rows = db.prepare(`SELECT data FROM records WHERE kind='memory' AND (json_extract(data,'$.projectId')=? OR json_extract(data,'$.project') IN (SELECT value FROM json_each(?))) LIMIT 10000`).all(project.id, locations);
  const merged = new Map(rows.map(row => JSON.parse(row.data)).filter(record => recordBelongsToProject(record, project)).map(record => [record.id, record]));
  for (const entry of [...projectRecords(project.root, 'memory'), ...agentRecords(project.root, 'memory')]) {
    if (!merged.has(entry.id) && recordBelongsToProject(entry, project)) merged.set(entry.id, { ...entry, truth: 'inconclusive', verification: null, provenance: 'project-file' });
  }
  const budget = knowledgeVerificationBudget();
  // Anonymous legacy projections stay on disk, but cannot establish a source
  // principal for model retrieval or become authority through a derived index.
  return [...merged.values()].filter(record => typeof record.id === 'string' && record.id.trim() && typeof record.sessionId === 'string'
    && record.sessionId.trim() && record.sessionId.length <= 160 && !getRecord('session-deletion', record.sessionId) && (!access?.restricted || sessionIds?.includes(record.sessionId)))
    .map(record => evaluateFreshness ? memoryFreshness(record, project, session, { budget }) : record);
}

// Legacy trusted-host signature remains usable. Model tools supply the immutable
// session so executor/Agent reads never gain the owner's engagement-wide history.
export function recall(projectRoot, query = '', limit = 12, { session } = {}) {
  const context = session || { id: 'owner-project-recall', cwd: projectRoot }, access = knowledgeAccess(context);
  const records = projectMemories(access.project, { session: context, access, sessionIds: access.sessionIds, evaluateFreshness: false });
  const ids = allowedKnowledgeSessionIds(context, access);
  if (!access.restricted) for (const record of records) if (!ids.includes(record.sessionId)) ids.push(record.sessionId);
  for (const record of records) indexKnowledgeRecord(access.project, 'memory', record.id, record.sessionId, `${record.statement}\n${record.rationale}`, record);
  const budget = knowledgeVerificationBudget();
  return searchKnowledgeIndex(access, ids, { query, limit: Math.min(50, limit), types: ['memory'] }).items
    .map(hit => { const source = records.find(record => record.id === hit.sourceId); return source ? { ...memoryFreshness(source, access.project, context, { budget }), score: hit.score, whyMatched: hit.whyMatched } : null; }).filter(Boolean);
}

export function invalidateMemory(id, reason, { session, expectedRevision } = {}) {
  const item = getRecord('memory', id);
  if (!item || !reason?.trim()) throw new Error('Supply an existing memory ID and invalidation reason.');
  const rationale = text(reason, 2000);
  if (session) {
    const access = knowledgeAccess(session);
    if (!scopedRecord(item, access, allowedKnowledgeSessionIds(session, access))) throw new Error('Knowledge belongs to another engagement.');
  }
  const changed = atomic(db => {
    const current = getRecord('memory', id);
    if (expectedRevision != null && (current.revision || 1) !== expectedRevision) throw new Error('Knowledge changed. Refresh its revision.');
    const record = { ...current, invalidatedAt: now(), invalidationReason: rationale, revision: (current.revision || 1) + 1, truth: 'stale' };
    putRecord('core.memory.revision', `${id}:${current.revision || 1}`, current, db);
    putRecord('memory', id, record, db); putRecord('core.memory.revision', `${id}:${record.revision}`, record, db); return record;
  });
  const root = session?.projectRoot || getRecord('core.project.identity', item.projectId)?.root || item.project;
  writeProjectRecord({ ...(session || {}), cwd: session?.cwd || root, projectRoot: root, agentNamespace: item.agent }, 'memory', id, changed); return changed;
}

export function reviewMemory(session, id, { truth, expectedRevision, rationale, explicit = false } = {}) {
  const access = knowledgeAccess(session), current = getRecord('memory', id);
  if (!explicit || access.restricted || !['confirmed', 'disproved', 'inconclusive'].includes(truth)) throw new Error('Explicit local-owner review is required for this knowledge decision.');
  if (!current || !scopedRecord(current, access, allowedKnowledgeSessionIds(session, access))) throw new Error('Knowledge belongs to another engagement.');
  if (['confirmed', 'disproved'].includes(truth) && (!current.evidence?.length || memoryFreshness(current, access.project, session).stale)) throw new Error('Review requires current recorded evidence and matching validity conditions.');
  const reason = text(rationale, 2000);
  const record = atomic(db => {
    const shown = getRecord('memory', id);
    if ((shown.revision || 1) !== expectedRevision) throw new Error('Knowledge changed. Review its current revision.');
    const updated = { ...shown, truth, revision: (shown.revision || 1) + 1, verification: { source: 'explicit-owner-review', rationale: reason, recordedAt: now() } };
    putRecord('core.memory.revision', `${id}:${shown.revision || 1}`, shown, db);
    putRecord('memory', id, updated, db); putRecord('core.memory.revision', `${id}:${updated.revision}`, updated, db);
    appendEvent(session.id, 'memory.reviewed', { id, truth, revision: updated.revision }, db); return updated;
  });
  writeProjectRecord({ ...session, agentNamespace: current.agent }, 'memory', id, record); return record;
}

export function memoryHistory(session, id, { offset = 0, limit = 20 } = {}) {
  const access = knowledgeAccess(session), record = getRecord('memory', id);
  if (!record || !scopedRecord(record, access, allowedKnowledgeSessionIds(session, access))) throw new Error('Knowledge belongs to another engagement.');
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('Invalid knowledge history page.');
  const rows = database().prepare(`SELECT data FROM records WHERE kind='core.memory.revision' AND json_extract(data,'$.id')=?
    ORDER BY json_extract(data,'$.revision') DESC LIMIT ? OFFSET ?`).all(id, limit + 1, offset);
  return { items: rows.slice(0, limit).map(row => JSON.parse(row.data)), nextOffset: rows.length > limit ? offset + limit : null };
}

export function rollbackMemory(session, id, { fromRevision, expectedRevision, explicit = false } = {}) {
  const access = knowledgeAccess(session), current = getRecord('memory', id);
  if (!explicit || access.restricted || !Number.isSafeInteger(fromRevision) || fromRevision < 1) throw new Error('Explicit owner review is required to restore knowledge.');
  if (!current || !scopedRecord(current, access, allowedKnowledgeSessionIds(session, access))) throw new Error('Knowledge belongs to another engagement.');
  const prior = getRecord('core.memory.revision', `${id}:${fromRevision}`);
  if (!prior) throw new Error('Knowledge revision is unavailable.');
  const result = atomic(db => {
    const live = getRecord('memory', id);
    if ((live.revision || 1) !== expectedRevision) throw new Error('Knowledge changed. Refresh its revision.');
    const updated = { ...prior, revision: expectedRevision + 1, truth: 'inconclusive', verification: null,
      restoredFromRevision: fromRevision, restoredAt: now(), invalidatedAt: null, invalidationReason: undefined, provenance: 'explicit-owner-restoration' };
    putRecord('core.memory.revision', `${id}:${live.revision || 1}`, live, db);
    putRecord('memory', id, updated, db); putRecord('core.memory.revision', `${id}:${updated.revision}`, updated, db);
    appendEvent(session.id, 'memory.restored', { id, revision: updated.revision, fromRevision }, db); return updated;
  });
  writeProjectRecord({ ...session, agentNamespace: current.agent }, 'memory', id, result); return result;
}

export function checkpoint(session, input) {
  const access = knowledgeAccess(session), previous = getRecord('checkpoint', session.id) || {};
  const record = { ...previous, project: access.project.root, projectId: access.project.id, sessionId: session.id, objective: session.goal?.objective || session.contract?.objective,
    constraints: [...new Set([...(session.contract?.constraints || []), ...(previous.constraints || []), ...(input.constraints || [])])], revision: (previous.revision || 0) + 1, updatedAt: now() };
  if (input.decisions != null) {
    if (!Array.isArray(input.decisions) || input.decisions.length > 50) throw new Error('Checkpoint decisions must be a bounded list.');
    const normalize = (value, depth = 0) => {
      if (typeof value === 'string') return text(value, 2000);
      if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value;
      if (depth >= 4 || !value || typeof value !== 'object') throw new Error('Checkpoint decision metadata must be bounded JSON.');
      if (Array.isArray(value)) {
        if (value.length > 32) throw new Error('Checkpoint decision metadata must be bounded JSON.');
        return value.map(item => normalize(item, depth + 1));
      }
      if (Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length > 16) throw new Error('Checkpoint decisions must use bounded plain objects.');
      return Object.fromEntries(Object.entries(value).map(([key, item]) => {
        if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(key) || /^(?:backendHomes|backendProcess|engineHome|credentials|accountBindings|ownerToken|privateKey|reasoning|analysis|chainOfThought)$/i.test(key)) throw new Error('Checkpoint decisions cannot contain private bindings or reasoning.');
        return [key, key === 'evidence' ? validEvidence(session, item, access) : normalize(item, depth + 1)];
      }));
    };
    record.decisions = input.decisions.map(value => {
      if (typeof value !== 'string' && (!value || Array.isArray(value) || typeof value !== 'object')) throw new Error('Checkpoint decisions need a string or decision object.');
      const decision = normalize(value); assertKnowledgeText(JSON.stringify(decision), 8192); return decision;
    });
    if (Buffer.byteLength(JSON.stringify(record.decisions)) > 64 * 1024) throw new Error('Checkpoint decisions exceed the 64 KiB limit.');
  }
  for (const key of ['completedWork', 'pendingActions', 'unresolvedQuestions', 'evidence']) {
    if (input[key] != null) record[key] = list(input[key], key === 'evidence' ? 32 : 50).map(value => key === 'evidence' ? value : text(value, 2000));
  }
  if (record.evidence) validEvidence(session, record.evidence, access);
  atomic(db => { putRecord('checkpoint', session.id, record, db); putRecord('core.checkpoint.revision', `${session.id}:${record.revision}`, record, db); appendEvent(session.id, 'checkpoint', record, db); });
  writeProjectRecord(session, 'checkpoints', session.id, record);
  indexKnowledgeRecord(access.project, 'checkpoint', session.id, session.id, JSON.stringify({ objective: record.objective, decisions: record.decisions, pendingActions: record.pendingActions, unresolvedQuestions: record.unresolvedQuestions }), record);
  return record;
}
