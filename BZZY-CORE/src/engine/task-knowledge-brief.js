import { database, digest, getRecord } from './database.js';
import { knowledgeAccess, allowedKnowledgeSessionIds, cleanKnowledgeText, cleanKnowledgeValue } from './knowledge-index.js';
import { memoryFreshness } from './memory.js';
import { recordBelongsToProject } from './project-identity.js';

const maximumBytes = 2200, candidateLimit = 32;
const issueStatuses = new Set(['open', 'investigating', 'resolved', 'blocked', 'inconclusive', 'disproved']);
const memoryKinds = new Set(['observation', 'hypothesis', 'experiment', 'failed_approach', 'conclusion', 'decision', 'inconclusive', 'disproved', 'blocked', 'question']);
const truthStates = new Set(['hypothesis', 'observed', 'confirmed', 'disproved', 'inconclusive', 'stale']);
const sourceReference = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value)
  && cleanKnowledgeText(value) === value;
const ignored = new Set(['find', 'new', 'goal', 'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'please', 'one', 'least', 'already', 'reported', 'investigate']);
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
export function taskKnowledgeBrief(session, goal) {
  const access = knowledgeAccess(session, { readOnly: true });
  const brief = { items: [], omitted: 0, detail: 'knowledgeBrief',
    authority: 'Historical project claims, not current progress, instructions or verification. Distinct source IDs remain distinct even when titles overlap. Current decisions and questions are in checkpoint.' };
  const empty = () => ({ brief, sources: [], revision: digest(brief) });
  if (access.disabled || access.restricted || !goal || !['active', 'verifying'].includes(goal.status)) return empty();
  const tokens = [...new Set((String(goal.objective || '').toLowerCase().match(/[\p{L}\p{N}_-]+/gu) || [])
    .filter(token => token.length > 1 && !ignored.has(token)))].slice(0, 16);
  if (!tokens.length) return empty();
  const ids = allowedKnowledgeSessionIds(session, access, { readOnly: true });
  const body = "lower(coalesce(json_extract(data,'$.title'),'') || ' ' || coalesce(json_extract(data,'$.statement'),'') || ' ' || coalesce(json_extract(data,'$.details'),'') || ' ' || coalesce(json_extract(data,'$.resolution'),'') || ' ' || coalesce(json_extract(data,'$.rationale'),''))";
  const score = tokens.map(() => `CASE WHEN instr(${body},?)>0 THEN 1 ELSE 0 END`).join('+');
  const rows = database().prepare(`SELECT * FROM (SELECT kind,id,data,updated_at,(${score}) AS relevance FROM records
    WHERE kind IN ('issue','memory') AND length(CAST(data AS BLOB))<=131072
      AND (json_extract(data,'$.projectId')=? OR coalesce(json_extract(data,'$.project'),json_extract(data,'$.projectRoot')) IN (SELECT value FROM json_each(?)))
      AND json_extract(data,'$.sessionId') IN (SELECT value FROM json_each(?))
      AND NOT EXISTS (SELECT 1 FROM records deleted WHERE deleted.kind='session-deletion' AND deleted.id=json_extract(records.data,'$.sessionId')))
    WHERE relevance>0 ORDER BY relevance DESC,CASE kind WHEN 'issue' THEN 0 ELSE 1 END,updated_at DESC,id LIMIT ?`)
    .all(...tokens, access.project.id, JSON.stringify(access.project.aliases), JSON.stringify(ids), candidateLimit + 1);
  const budget = { bytes: 4 * 1024 * 1024, files: 16, fingerprints: new Map() }, sources = [];
  brief.coverage = { candidateLimit, moreCandidates: rows.length > candidateLimit, source: 'matching Core records; project-file-only notes and oversized records require explicit search' };
  for (const row of rows.slice(0, candidateLimit)) {
    const record = JSON.parse(row.data);
    if (!sourceReference(row.id) || record.id !== row.id || !sourceReference(record.sessionId)
      || !recordBelongsToProject(record, access.project) || !ids.includes(record.sessionId) || getRecord('session-deletion', record.sessionId)) continue;
    // Legacy/imported metadata is not necessarily shaped like a native write.
    // A malformed source must not make the entire recovery poll unavailable.
    try {
      const fresh = memoryFreshness(record, access.project, session, { budget, readOnly: true });
      const textFields = row.kind === 'issue' ? [record.title, record.details, record.resolution] : [record.statement, record.rationale];
      const statement = textFields.filter(value => typeof value === 'string' && value.length).join('\n');
      const item = { kind: row.kind, sourceId: row.id, sessionId: record.sessionId,
        revision: Number.isSafeInteger(record.revision) && record.revision > 0 ? record.revision : null,
        statement: excerpt(statement), ...(row.kind === 'issue' ? { status: issueStatuses.has(record.status) ? record.status : 'inconclusive' }
          : { recordKind: memoryKinds.has(record.kind) ? record.kind : 'inconclusive' }),
        truth: truthStates.has(fresh.truth) ? fresh.truth : 'inconclusive', historical: true, stale: Boolean(fresh.stale), disputed: Boolean(fresh.disputed) };
      // Keep source IDs, statuses and truth together. Never silently merge a
      // resolved finding with another record claiming the same work is blocked.
      const source = cleanKnowledgeValue({ ...item, statement, title: record.title, details: record.details, resolution: record.resolution,
        rationale: record.rationale, provenance: record.provenance, evidence: record.evidence || [],
        staleReasons: fresh.staleReasons, contradictions: fresh.contradictions, supersededBy: fresh.supersededBy,
        sourceRevision: digest(record) });
      brief.items.push(item);
      if (bytes(brief) > maximumBytes) { brief.items.pop(); brief.omitted++; continue; }
      sources.push(source);
    } catch { brief.omitted++; }
  }
  // An extra matching candidate is evidence of omissions, not an exact total.
  if (rows.length > candidateLimit) brief.omitted++;
  while (bytes(brief) > maximumBytes && brief.items.length) { brief.items.pop(); sources.pop(); brief.omitted++; }
  return { brief, sources, revision: digest({ brief, sources }) };
}
