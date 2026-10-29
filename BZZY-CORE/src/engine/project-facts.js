import { database, getRecord, putRecord, now, transaction } from './database.js';
import { knowledgeAccess, allowedKnowledgeSessionIds } from './knowledge-index.js';
import { memoryFreshness, knowledgeVerificationBudget } from './memory.js';

const KIND = 'core.project.facts';
const fail = message => { throw Object.assign(new Error(message), { code: 'PROJECT_FACTS_SCOPE' }); };
const optionsFor = projectId => ({ projectId, enabled: true, revision: 0, ids: [], maxBytes: 2500, ...getRecord(KIND, projectId) });
function permitted(session) {
  const access = knowledgeAccess(session);
  if (access.disabled || access.restricted || session.parentSessionId || session.assignmentId) fail('Project fact curation belongs to this project owner context.');
  return { access, ids: allowedKnowledgeSessionIds(session, access) };
}

// Owner pins select existing records; this does not introduce another writable
// fact store, promote truth, or turn remembered scope into runtime permission.
export function configureProjectFacts(session, input, { expectedRevision, reviewed = false } = {}) {
  const { access, ids } = permitted(session);
  if (!reviewed || !input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['ids', 'enabled', 'maxBytes'].includes(key)) ||
    input.enabled !== undefined && typeof input.enabled !== 'boolean' || input.maxBytes !== undefined && (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 512 || input.maxBytes > 4096) ||
    input.ids !== undefined && (!Array.isArray(input.ids) || input.ids.length > 12 || new Set(input.ids).size !== input.ids.length || input.ids.some(id => typeof id !== 'string'))) fail('Review a bounded project fact selection before saving.');
  const operation = db => {
    permitted(session);
    const prior = optionsFor(access.project.id);
    if (prior.revision !== expectedRevision) throw Object.assign(new Error('Project fact selection changed. Reload its revision.'), { code: 'CONFLICT' });
    for (const id of input.ids || prior.ids) {
      const memory = getRecord('memory', id);
      if (!memory || memory.projectId !== access.project.id || !ids.includes(memory.sessionId) || getRecord('session-deletion', memory.sessionId)) fail('Pinned facts must reference existing authorized project knowledge.');
    }
    const value = { ...prior, ...input, revision: prior.revision + 1, updatedAt: now(), provenance: 'explicit-owner-selection' };
    putRecord(KIND, access.project.id, value, db); return projectFactsView(session);
  };
  return database().isTransaction ? operation(database()) : transaction(operation);
}

export function projectFactsView(session, { maxBytes, limit = 8 } = {}) {
  const access = knowledgeAccess(session);
  if (access.disabled || access.restricted || session.parentSessionId || session.assignmentId) return { enabled: false, items: [], reason: 'restricted-context' };
  const settings = optionsFor(access.project.id), cap = maxBytes ?? settings.maxBytes;
  if (!Number.isSafeInteger(cap) || cap < 512 || cap > 4096 || !Number.isSafeInteger(limit) || limit < 1 || limit > 12) fail('Use a bounded project fact view.');
  const result = { version: 1, projectId: access.project.id, revision: settings.revision, enabled: settings.enabled,
    maxBytes: cap, pinCount: settings.ids.length, items: [], omitted: [],
    authority: 'Historical project knowledge; current contracts, permissions and source validity remain authoritative. Unverified relationship coverage is not a current-fact guarantee.' };
  if (!settings.enabled) return result;
  const allowed = allowedKnowledgeSessionIds(session, access), budget = knowledgeVerificationBudget();
  const automatic = database().prepare(`SELECT id FROM records WHERE kind='memory' AND json_extract(data,'$.projectId')=?
    AND json_extract(data,'$.verification.source')='explicit-owner-review' AND json_extract(data,'$.truth')='confirmed'
    ORDER BY updated_at DESC LIMIT 16`).all(access.project.id).map(row => row.id);
  for (const id of [...new Set([...settings.ids, ...automatic])]) {
    const memory = getRecord('memory', id);
    if (!memory || memory.projectId !== access.project.id || !allowed.includes(memory.sessionId) || getRecord('session-deletion', memory.sessionId)) continue;
    const current = memoryFreshness(memory, access.project, session, { budget });
    if (current.stale || current.disputed) { result.omitted.push({ id, reason: current.disputed ? 'contradicted' : 'stale' }); continue; }
    const item = { id, revision: current.revision || 1, statement: current.statement, truth: current.truth,
      historical: true, freshnessStatus: current.freshnessStatus, relationshipCoverage: current.relationshipCoverage,
      pinned: settings.ids.includes(id), sourceId: current.sourceId || null, evidence: (current.evidence || []).slice(0, 8), provenance: current.provenance };
    if (result.items.length >= limit || Buffer.byteLength(JSON.stringify({ ...result, items: [...result.items, item] })) > cap - 96) {
      result.omitted.push({ id, reason: 'view-budget' }); continue;
    }
    result.items.push(item);
  }
  // Omission metadata is navigation too; keep it inside the same real byte cap.
  while (result.omitted.length && Buffer.byteLength(JSON.stringify(result)) > cap - 64) result.omitted.pop();
  result.bytesUsed = 0;
  result.bytesUsed = Buffer.byteLength(JSON.stringify(result));
  result.bytesUsed = Buffer.byteLength(JSON.stringify(result));
  return result;
}
