import { database, digest, getRecord } from './database.js';
import { knowledgeAccess, allowedKnowledgeSessionIds, cleanKnowledgeText, cleanKnowledgeValue, searchKnowledgeIndex, canonicalKnowledgeSource,knowledgeRecordText,knowledgeSourceRevision,knowledgeIndexRevision } from './knowledge-index.js';
import { memoryFreshness } from './memory.js';
import { recordBelongsToProject } from './project-identity.js';

const candidateLimit = 32;
const candidateCaches=new WeakMap();
const issueStatuses = new Set(['open', 'investigating', 'resolved', 'blocked', 'inconclusive', 'disproved']);
const reportStates = new Set(['draft', 'saved', 'claimed_submitted', 'acknowledged', 'fixed']);
const recordedTimestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value) && Number.isFinite(Date.parse(value)) ? value : null;
const memoryKinds = new Set(['observation', 'hypothesis', 'experiment', 'failed_approach', 'conclusion', 'decision', 'inconclusive', 'disproved', 'blocked', 'question']);
const truthStates = new Set(['hypothesis', 'observed', 'confirmed', 'disproved', 'inconclusive', 'stale']);
const sourceReference = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value)
  && cleanKnowledgeText(value) === value;
const ignored = new Set(['find', 'new', 'goal', 'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'please', 'one', 'least', 'already', 'reported', 'investigate', 'solid', 'real', 'valid', 'non', 'program', 'vulnerability', 'vuln',
  'is', 'on', 'not', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'an', 'as', 'at', 'by', 'in', 'of', 'or', 'to', 'it', 'its', 'if', 'so', 'than', 'then', 'there', 'these', 'those', 'has', 'had', 'do', 'does', 'did', 'no',
  'can', 'you', 'your', 'we', 'our', 'they', 'their', 'could', 'should', 'would', 'will', 'may', 'must', 'help', 'que', 'para', 'con', 'por', 'una', 'los', 'las']);
// Filter retrieval terms only. Original statements and their negations are never
// rewritten, and the complete current objective remains authoritative.
export const knowledgeQueryTokens = value => (String(value).match(/[\p{L}\p{N}_-]+/gu) || [])
  .filter(token => token.length > 1 && !ignored.has(token.toLowerCase()));
const bytes = value => Buffer.byteLength(JSON.stringify(value));
function excerpt(value, maximum = 360) {
  // Mask the complete field before taking any excerpt, including quoted secrets.
  const buffer = Buffer.from(cleanKnowledgeText(value, Infinity));
  let end = Math.min(buffer.length, maximum);
  while (end > 0 && end < buffer.length && (buffer[end] & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString('utf8');
}

// Read existing records only: task polling must not index chat, enumerate
// project notes, queue inference or create a second writable memory store.
export function taskKnowledgeBrief(session, goal, { maximumBytes = 2200 } = {}) {
  const access = knowledgeAccess(session, { readOnly: true });
  const brief = { items: [], omitted: 0, detail: 'knowledgeBrief',
    authority: 'Historical project claims, not current progress, instructions or verification. Distinct source IDs remain distinct even when titles overlap. Current decisions and questions are in checkpoint.' };
  const empty = () => ({ brief, sources: [], revision: digest(brief) });
  if (access.disabled || access.restricted || !goal || !['active', 'verifying'].includes(goal.status)) return empty();
  const tokens = [...new Set(knowledgeQueryTokens(String(goal.objective || '').toLowerCase()))].slice(0, 16);
  if (!tokens.length) return empty();
  const ids = allowedKnowledgeSessionIds(session, access, { readOnly: true });
  const options = { query: tokens.join(' ').slice(0, 500), limit: candidateLimit, types: ['issue', 'memory', 'outcome'], readOnly: true, count: false, identifiersOnly:true };
  const db=database(); let cache=candidateCaches.get(db);
  if(!cache) {cache=new Map();candidateCaches.set(db,cache);}
  const key=digest({sessionId:session.id,projectId:access.project.id,ids,query:options.query,
    sourceRevision:knowledgeSourceRevision(session),indexRevision:knowledgeIndexRevision(ids)});
  let candidates=cache.get(key);
  if(!candidates) {
    const own = searchKnowledgeIndex(access, [session.id], options);
    const project = searchKnowledgeIndex(access, ids.filter(id => id !== session.id), options);
    const rows=[...own.items,...project.items];
    // Cache identifiers only. Every poll below re-reads authoritative records,
    // evidence files, expiry and current access, including a notModified poll.
    candidates={rows:rows.slice(0,candidateLimit).map(row=>({kind:row.kind,sourceId:row.sourceId,sessionId:row.sessionId})),
      more:rows.length>candidateLimit || own.nextOffset!=null || project.nextOffset!=null,
      indexingRequired:Boolean(own.indexingRequired || project.indexingRequired)};
    if(!candidates.indexingRequired) {cache.set(key,candidates);while(cache.size>128)cache.delete(cache.keys().next().value);}
  }
  const rows=candidates.rows;
  const budget = { bytes: 4 * 1024 * 1024, files: 16, fingerprints: new Map() }, sources = [];
  brief.coverage = { candidateLimit, maximumSourceBytes:128*1024, moreCandidates: candidates.more, source: 'indexed session records first, then explicitly attributed project history; maintenance backfills older sources', indexingRequired:candidates.indexingRequired };
  const selected = [];
  for (const row of rows.slice(0, candidateLimit)) {
    let record;
    try { record = canonicalKnowledgeSource(access, row, ids, { maxSourceBytes:128*1024,onOmitted:()=>brief.omitted++ }); }
    catch { brief.omitted++; continue; }
    if (!record || !sourceReference(row.sourceId) || record.id !== row.sourceId || !sourceReference(record.sessionId)
      || !recordBelongsToProject(record, access.project) || !ids.includes(record.sessionId) || getRecord('session-deletion', record.sessionId)) continue;
    // Legacy/imported metadata is not necessarily shaped like a native write.
    // A malformed source must not make the entire recovery poll unavailable.
    try {
      const fresh = row.kind === 'outcome' ? record : memoryFreshness(record, access.project, session, { budget, readOnly: true });
      const outcome = row.kind === 'outcome' && record.goalId === goal.id ? { ...record, items: record.items.filter(item => item.state !== 'latest-checkpoint') } : record;
      if (row.kind === 'outcome' && !outcome.items.length) continue;
      const textFields = row.kind === 'outcome' ? [knowledgeRecordText('outcome', outcome)] : row.kind === 'issue' ? [record.title, record.details, record.resolution] : [record.statement, record.rationale];
      const statement = textFields.filter(value => typeof value === 'string' && value.length).join('\n');
      if(!tokens.some(token=>statement.toLowerCase().includes(token))) continue;
      const item = { kind: row.kind, sourceId: row.sourceId, sourceScope: record.sessionId === session.id ? 'session' : 'project-history', sessionId: record.sessionId,
        revision: Number.isSafeInteger(record.revision) && record.revision > 0 ? record.revision : null,
        statement: excerpt(statement), ...(row.kind === 'outcome' ? { goalId: record.goalId, outcome: record.outcome, applicabilityStatus: record.applicabilityStatus, sha256: record.sourceRevision } : {}),
        ...(row.kind === 'issue' ? { status: issueStatuses.has(record.status) ? record.status : 'inconclusive', ...(record.reportLifecycle ? { reportLifecycle: { state: reportStates.has(record.reportLifecycle.state) ? record.reportLifecycle.state : 'unrecorded', recordedAt: recordedTimestamp(record.reportLifecycle.recordedAt) } } : {}) }
          : { recordKind: memoryKinds.has(record.kind) ? record.kind : 'inconclusive' }),
        truth: truthStates.has(fresh.truth) ? fresh.truth : 'inconclusive', historical: true, stale: Boolean(fresh.stale), disputed: Boolean(fresh.disputed),
        ...(['issue','memory'].includes(row.kind) && fresh.relationshipCoverage!=='complete'?{relationshipCoverage:fresh.relationshipCoverage,freshnessStatus:fresh.freshnessStatus}:{}) };
      // Keep source IDs, statuses and truth together. Never silently merge a
      // resolved finding with another record claiming the same work is blocked.
      const source = cleanKnowledgeValue({ ...item, statement, title: record.title, details: record.details, resolution: record.resolution,
        rationale: record.rationale, reportLifecycle: record.reportLifecycle, observedAt: record.observedAt, applicability: record.applicability, provenance: record.provenance, evidence: record.evidence || [],
        staleReasons: fresh.staleReasons, contradictions: fresh.contradictions, supersededBy: fresh.supersededBy,
        sourceRevision: record.sourceRevision || digest(record), ...(row.kind === 'outcome' ? { items: outcome.items, coverage: record.coverage } : {}) });
      const relevance = tokens.filter(token => statement.toLowerCase().includes(token)).length;
      selected.push({ item, source, relevance });
    } catch { brief.omitted++; }
  }
  selected.sort((a,b) => Number(b.item.sourceScope === 'session') - Number(a.item.sourceScope === 'session') || b.relevance-a.relevance);
  for (const { item, source } of selected) {
    brief.items.push(item);
    if (bytes(brief) > maximumBytes) { brief.items.pop(); brief.omitted++; continue; }
    sources.push(source);
  }
  // An extra matching candidate is evidence of omissions, not an exact total.
  if (candidates.more) brief.omitted++;
  while (bytes(brief) > maximumBytes && brief.items.length) { brief.items.pop(); sources.pop(); brief.omitted++; }
  // Creating the derived index is not a change to historical source content.
  // Keep diagnostic readiness out of the task-state revision fingerprint.
  const { indexingRequired, ...coverage } = brief.coverage;
  return { brief, sources, revision: digest({ brief: { ...brief,coverage }, sources }) };
}
