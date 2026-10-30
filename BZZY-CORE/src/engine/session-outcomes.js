import { sessionBelongsToProject, recordBelongsToProject, projectIdentityForSession } from './project-identity.js';
import { database, digest, getRecord } from './database.js';
import { cleanKnowledgeText, cleanKnowledgeValue } from './knowledge-text.js';

export const outcomeSourceBytes = 128 * 1024;
export const outcomeExpansionBytes = 1024 * 1024;
const fields = ['decisions', 'completedWork', 'pendingActions', 'unresolvedQuestions'];
const goalStates = new Set(['active', 'verifying', 'paused', 'complete', 'blocked', 'failed', 'cancelled', 'budget_limited', 'usage_limited', 'awaiting_review']);
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const reference = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value) && cleanKnowledgeText(value) === value;
function validSource(record, sourceId, project) {
  return plain(record) && record.schemaVersion === 2 && record.provenance === 'core-checkpoint'
    && reference(record.sessionId) && reference(record.goalId)
    && Number.isSafeInteger(record.revision) && record.revision > 0
    && plain(record.scope) && record.scope.version === 1 && record.scope.kind === 'goal'
    && record.scope.sessionId === record.sessionId && record.scope.goalId === record.goalId
    && !record.scope.assignmentId && !record.scope.assignmentRound && !record.scope.chatId && !record.scope.chatRunId
    && sourceId === `${record.sessionId}:${digest(record.scope)}` && recordBelongsToProject(record, project);
}

// A rebuildable view of canonical checkpoint sources, never a second writable
// findings store. In particular, archiving an item does not retract its claim.
export function checkpointOutcome(record, sourceId) {
  try { return projectCheckpointOutcome(record, sourceId); }
  catch { return null; } // Malformed historical metadata must not break recovery polling.
}
function projectCheckpointOutcome(record, sourceId) {
  if (!plain(record) || typeof record.sessionId !== 'string') return null;
  const owner = getRecord('session', record.sessionId);
  if (!owner || getRecord('session-deletion', owner.id)) return null;
  let project;
  try { project = projectIdentityForSession(owner, { readOnly: true }); } catch { return null; }
  if (!sessionBelongsToProject(owner, project, { readOnly: true }) || !validSource(record, sourceId, project)) return null;
  const currentGoal = owner.goal?.id === record.goalId, goal = currentGoal ? owner.goal : getRecord('goal-history', record.goalId);
  const scopedGoal = goal && (currentGoal || goal.sessionId === record.sessionId) ? goal : null;
  const items = [], seen = new Set(), pins = [];
  let skippedItems = 0;
  const add = (item, revision, state) => {
    if (item?.field === 'constraints') return;
    if (!plain(item) || !fields.includes(item.field) || item.value == null || typeof item.value !== 'string' && !plain(item.value)) { skippedItems++; return; }
    const key = digest([item.field, item.value]);
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ id: item.id || key, field: item.field, text: item.value, disposition: item.disposition,
      subject: item.subject, applicability: item.applicability, state, checkpointRevision: revision });
  };
  const current = Array.isArray(record.items) ? record.items.slice(0, 250) : fields
    .flatMap(field => (Array.isArray(record[field]) ? record[field].slice(0, 50) : []).map(value => ({ field, value })));
  for (const item of current) add(item, record.revision, 'latest-checkpoint');
  const archive = Array.isArray(record.itemArchive) ? record.itemArchive : [];
  const pointers = archive.slice(-100).filter(item => plain(item) && ['decisions', 'completedWork'].includes(item.field)).slice(-32).reverse();
  const revisions = new Map(); let remainingBytes = 256 * 1024, skippedSources = 0;
  for (const pointer of pointers) {
    if (!Number.isSafeInteger(pointer.checkpointRevision) || pointer.checkpointRevision < 1) { skippedSources++; continue; }
    const key = `${record.sessionId}:${pointer.checkpointRevision}`;
    if (!revisions.has(key)) {
      const row = revisions.size < 16 && remainingBytes > 0 && database().prepare("SELECT data FROM records WHERE kind='core.checkpoint.revision' AND id=? AND length(CAST(data AS BLOB))<=?").get(key, Math.min(131072, remainingBytes));
      if (row) remainingBytes -= Buffer.byteLength(row.data); else skippedSources++;
      revisions.set(key, row && JSON.parse(row.data));
    }
    const prior = revisions.get(key);
    if (!prior || !validSource(prior, sourceId, project) || prior.revision !== pointer.checkpointRevision || prior.sessionId !== record.sessionId || prior.goalId !== record.goalId || digest(prior.scope) !== digest(record.scope)) { skippedSources++; continue; }
    const item = (Array.isArray(prior.items) ? prior.items.slice(0, 250) : []).find(item => plain(item) && item.id === pointer.id && item.field === pointer.field && item.revision === pointer.itemRevision)
      || (Array.isArray(prior[pointer.field]) ? prior[pointer.field].slice(0, 50) : []).map(value => ({ field: pointer.field, value, id: digest([record.scope, pointer.field, value]) })).find(item => item.id === pointer.id);
    if (item) { add(item, prior.revision, pointer.state); pins.push({ id: key, sha256: digest(prior) }); }
    else skippedItems++;
  }
  const currentScopeFingerprint = digest({ scope: owner.contract?.scope || null, constraints: owner.contract?.constraints || [], policy: owner.policy || null });
  const applicabilityStatus = !record.applicabilityContext?.scopeFingerprint ? 'unrecorded'
    : record.applicabilityContext.scopeFingerprint === currentScopeFingerprint ? 'same-recorded-scope' : 'changed';
  return { id: sourceId, sessionId: record.sessionId, projectId: record.projectId, project: record.project,
    goalId: record.goalId, objective: record.objective, revision: record.revision, scope: record.scope,
    outcome: goalStates.has(scopedGoal?.status) ? scopedGoal.status : 'incomplete', reason: typeof scopedGoal?.reason === 'string' ? cleanKnowledgeText(scopedGoal.reason) : null,
    recordedAt: record.updatedAt, items, evidence: Array.isArray(record.evidence) ? record.evidence.slice(0, 32) : [], sourcePins: pins,
    applicabilityStatus, requiresRevalidation: true,
    coverage: { archivedItemsInspected: pointers.length, skippedSources, skippedItems, maximumArchiveBytes: 262144, maximumArchiveSources: 16,
      omittedCurrentItems: Array.isArray(record.items) ? Math.max(0, record.items.length - current.length) : fields.reduce((count, field) => count + Math.max(0, (record[field]?.length || 0) - 50), 0),
      omittedArchivePointers: (Number.isSafeInteger(record.omittedArchivePointers) ? record.omittedArchivePointers : 0) + Math.max(0, archive.length - pointers.length),
      archiveCoverage: 'Bounded recent pointers only; older original checkpoint revisions remain in local history.' },
    sourceRevision: digest([record, scopedGoal?.status, scopedGoal?.reason, pins, applicabilityStatus]),
    historical: true, truth: 'inconclusive', stale: Boolean(record.importedUntrusted || record.importProvenance), provenance: 'host-projected-checkpoint-outcome',
    authority: 'Attributed checkpoint claims, not verified findings or current progress. Archived claims may require revalidation; superseded items are history, not current conclusions.' };
}

// Redact at every delivery, including old records written before a secret was
// configured. Preserve all projected items rather than the generic 100-array
// preview; any final serialization omission remains explicit and hash-pinned.
export function publicCheckpointOutcome(record) {
  const result = cleanKnowledgeValue({ ...record, items: undefined });
  result.items = record.items.map(cleanKnowledgeValue);
  result.coverage = { ...result.coverage, maximumExpansionBytes: outcomeExpansionBytes, omittedExpansionItems: 0 };
  while (Buffer.byteLength(JSON.stringify(result, null, 2)) > outcomeExpansionBytes && result.items.length) {
    result.items.pop(); result.coverage.omittedExpansionItems++;
  }
  return result;
}

export function outcomeText(record) {
  // Ranking affects navigation only. Text and negations stay intact; an old
  // explicitly superseded statement cannot outrank its replacement.
  const priority = item => ['superseded','resolved'].includes(item.state) ? -1
    : ['rejected','blocked','needs_recheck'].includes(item.disposition) || /\b(?:rejected|ruled out|blocked|retired)\b/i.test(String(item.text)) ? 2 : 0;
  const items = [...(record.items || [])].sort((a,b)=>priority(b)-priority(a));
  return [...items.map(item => `[${item.field}; ${item.state}${item.disposition ? '; ' + item.disposition : ''}] ${typeof item.text === 'string' ? item.text : JSON.stringify(item.text)}${item.subject ? ' Subject: ' + item.subject : ''}${item.applicability ? ' Applies when: ' + item.applicability : ''}`),
    `Goal: ${record.objective || ''}\nRecorded outcome: ${record.outcome || 'incomplete'}${record.reason ? '; ' + record.reason : ''}`].join('\n');
}

export function sessionOutcomePage(session, { offset = 0, limit = 12 } = {}) {
  const owner = getRecord('session', session.id);
  if (!owner || ['cwd', 'projectRoot', 'role', 'agentId', 'agentNamespace', 'parentSessionId', 'purpose'].some(key => (owner[key] ?? null) !== (session[key] ?? null))
    || owner.parentSessionId || owner.role || owner.agentId || getRecord('session-deletion', owner.id)) return { items: [], restricted: true };
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 32) throw new Error('Use a bounded outcome page.');
  const project = projectIdentityForSession(owner, { readOnly: true });
  if (!sessionBelongsToProject(owner, project, { readOnly: true })) return { items: [] };
  const rows = database().prepare("SELECT id,CASE WHEN length(CAST(data AS BLOB))<=131072 THEN data END AS data FROM records WHERE kind='core.checkpoint.scope' AND json_extract(data,'$.sessionId')=? AND json_extract(data,'$.scope.kind')='goal' ORDER BY updated_at DESC,id LIMIT ? OFFSET ?")
    .all(owner.id,limit+1,offset);
  const items = []; let omittedInvalid = 0;
  for (const row of rows.slice(0, limit)) if (row.data) {
    try {
      const record = JSON.parse(row.data);
      const outcome = validSource(record, row.id, project) && checkpointOutcome(record, row.id);
      if (outcome) items.push(publicCheckpointOutcome(outcome)); else omittedInvalid++;
    } catch { omittedInvalid++; }
  }
  return { items, omittedInvalid,
    omittedOversize: rows.slice(0,limit).filter(row=>!row.data).length, nextOffset: rows.length>limit ? offset+limit : null,
    authority: 'Historical attributed outcomes. Existing scope and present evidence govern continuation.' };
}
