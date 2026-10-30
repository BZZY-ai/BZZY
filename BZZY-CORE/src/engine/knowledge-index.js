import { database, getRecord, digest, now } from './database.js';
import { projectIdentityForSession, recordBelongsToProject, sessionBelongsToProject } from './project-identity.js';
import { agentExecutionScope } from './agent-execution.js';
import { cleanKnowledgeText, cleanKnowledgeValue } from './knowledge-text.js';
export { cleanKnowledgeText, cleanKnowledgeValue, assertKnowledgeText } from './knowledge-text.js';
import { advanceConversationSource, conversationRedactionContext, conversationBody, conversationVisible } from './conversation-source.js';

import { checkpointOutcome, outcomeText, publicCheckpointOutcome, outcomeSourceBytes, outcomeExpansionBytes } from './session-outcomes.js';

const ready = new WeakSet();
export const knowledgeTypes = ['memory', 'issue', 'chat', 'checkpoint', 'goal', 'resolution', 'artifact', 'attempt', 'outcome'];
const recordKinds = ['memory', 'issue', 'checkpoint', 'goal-history', 'artifact', 'core.episode.observation', 'core.checkpoint.scope'];
const indexedKind = kind => kind === 'core.checkpoint.scope' ? 'outcome' : kind === 'goal-history' ? 'goal' : kind === 'core.episode.observation' ? 'attempt' : kind;
const disabledRoles = new Set(['skill-writer', 'learning-review', 'knowledge-review']);
export function knowledgeAccess(session, { readOnly = false } = {}) {
  if (!session?.id || !session.cwd) throw new Error('A saved session is required for knowledge access.');
  const saved = getRecord('session', session.id);
  if (getRecord('session-deletion', session.id)) throw new Error('Deleted sessions cannot read project knowledge.');
  for (const key of ['cwd', 'parentSessionId', 'purpose', 'agentId', 'role', 'agentNamespace']) {
    if (saved && (saved[key] ?? null) !== (session[key] ?? null)) throw new Error('Knowledge session identity changed. Refresh the saved session.');
  }
  if (saved?.projectRoot && saved.projectRoot !== session.projectRoot) throw new Error('Knowledge project scope changed.');
  const agent = agentExecutionScope(session), project = projectIdentityForSession(session, { readOnly });
  if (agent && agent.projectRoot !== project.root) throw new Error('Persistent Agent knowledge must stay in its registered project.');
  const restricted = Boolean(agent || ['executor', 'reviewer'].includes(session.role));
  return { project, restricted, agent, disabled: disabledRoles.has(session.role),
    sessionIds: restricted ? [session.id] : null, profiles: !restricted && !disabledRoles.has(session.role) };
}

export function knowledgeDatabase() {
  const db = database();
  if (!ready.has(db) || !db.prepare("SELECT 1 FROM sqlite_master WHERE name='knowledge_memory_links'").get()) {
    const ownTransaction=!db.isTransaction;
    if(ownTransaction) db.exec('BEGIN IMMEDIATE');
    try {
    db.exec(`CREATE TABLE IF NOT EXISTS knowledge_documents (
      key TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT NOT NULL, kind TEXT NOT NULL,
      source_id TEXT NOT NULL, body TEXT NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS knowledge_project ON knowledge_documents(project_id,kind,updated_at DESC);
      CREATE INDEX IF NOT EXISTS knowledge_session ON knowledge_documents(project_id,session_id,kind);
      CREATE INDEX IF NOT EXISTS knowledge_update_cursor ON knowledge_documents(project_id,updated_at,key);
      CREATE INDEX IF NOT EXISTS knowledge_document_keyset ON knowledge_documents(project_id,key);
      CREATE TABLE IF NOT EXISTS knowledge_changes (
        kind TEXT NOT NULL, source_id TEXT NOT NULL, session_id TEXT, project_id TEXT,
        PRIMARY KEY(kind,source_id));
      CREATE INDEX IF NOT EXISTS knowledge_changes_session ON knowledge_changes(session_id,kind,source_id);
      CREATE TABLE IF NOT EXISTS knowledge_projection_cursor_v2 (
        project_id TEXT NOT NULL, scope_id TEXT NOT NULL, session_id TEXT NOT NULL, kind TEXT NOT NULL, source_id TEXT NOT NULL,
        complete INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(project_id,scope_id));
      CREATE TABLE IF NOT EXISTS knowledge_source_revision (session_id TEXT PRIMARY KEY,revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS knowledge_index_revision (session_id TEXT PRIMARY KEY,revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS knowledge_memory_links (source_id TEXT NOT NULL,target_id TEXT NOT NULL,relation TEXT NOT NULL,
        PRIMARY KEY(source_id,target_id,relation));
      CREATE TABLE IF NOT EXISTS knowledge_memory_coverage (session_id TEXT PRIMARY KEY,complete INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS knowledge_memory_links_target ON knowledge_memory_links(target_id,relation,source_id);
      CREATE INDEX IF NOT EXISTS knowledge_record_scope ON records(kind,json_extract(data,'$.sessionId'),id);
      CREATE INDEX IF NOT EXISTS knowledge_vector_keyset ON records(kind,json_extract(data,'$.projectId'),json_extract(data,'$.generation'),id);
      CREATE TABLE IF NOT EXISTS knowledge_embedding_dirty (document_key TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS knowledge_embedding_cursor (project_id TEXT NOT NULL, generation INTEGER NOT NULL,
        document_key TEXT NOT NULL DEFAULT '', complete INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(project_id,generation));
      CREATE INDEX IF NOT EXISTS knowledge_embedding_dirty_scope ON knowledge_embedding_dirty(project_id,session_id,document_key);
      CREATE TRIGGER IF NOT EXISTS knowledge_embedding_insert AFTER INSERT ON knowledge_documents BEGIN
        INSERT INTO knowledge_embedding_dirty VALUES(new.key,new.project_id,new.session_id)
        ON CONFLICT(document_key) DO UPDATE SET project_id=excluded.project_id,session_id=excluded.session_id; END;
      CREATE TRIGGER IF NOT EXISTS knowledge_embedding_update AFTER UPDATE ON knowledge_documents BEGIN
        INSERT INTO knowledge_embedding_dirty VALUES(new.key,new.project_id,new.session_id)
        ON CONFLICT(document_key) DO UPDATE SET project_id=excluded.project_id,session_id=excluded.session_id; END;
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(body,content='knowledge_documents',content_rowid='rowid');
      CREATE TRIGGER IF NOT EXISTS knowledge_insert AFTER INSERT ON knowledge_documents BEGIN
        INSERT INTO knowledge_fts(rowid,body) VALUES(new.rowid,new.body); END;
      CREATE TRIGGER IF NOT EXISTS knowledge_delete AFTER DELETE ON knowledge_documents BEGIN
        INSERT INTO knowledge_fts(knowledge_fts,rowid,body) VALUES('delete',old.rowid,old.body); END;
      CREATE TRIGGER IF NOT EXISTS knowledge_update AFTER UPDATE ON knowledge_documents BEGIN
        INSERT INTO knowledge_fts(knowledge_fts,rowid,body) VALUES('delete',old.rowid,old.body);
        INSERT INTO knowledge_fts(rowid,body) VALUES(new.rowid,new.body); END;`);
    for(const action of ['INSERT','UPDATE','DELETE']) {
      const row=action==='DELETE'?'old':'new';
      db.exec(`CREATE TRIGGER IF NOT EXISTS knowledge_revision_${action.toLowerCase()} AFTER ${action} ON knowledge_documents BEGIN
        INSERT INTO knowledge_index_revision VALUES(${row}.session_id,1) ON CONFLICT(session_id) DO UPDATE SET revision=revision+1;
        ${action==='UPDATE'?`INSERT INTO knowledge_index_revision SELECT old.session_id,1 WHERE old.session_id!=new.session_id
          ON CONFLICT(session_id) DO UPDATE SET revision=revision+1;`:''}
        ${action==='DELETE'?'DELETE FROM knowledge_embedding_dirty WHERE document_key=old.key;':''} END;`);
    }
    const types = recordKinds.map(kind => `'${kind}'`).join(',');
    for (const action of ['INSERT', 'UPDATE', 'DELETE']) {
      const row = action === 'DELETE' ? 'old' : 'new';
      db.exec(`DROP TRIGGER IF EXISTS knowledge_record_${action.toLowerCase()}`);
      db.exec(`CREATE TRIGGER IF NOT EXISTS knowledge_record_${action.toLowerCase()} AFTER ${action} ON records
        WHEN ${row}.kind IN (${types}) BEGIN
          INSERT INTO knowledge_changes(kind,source_id,session_id,project_id)
          VALUES (${row}.kind,${row}.id,json_extract(${row}.data,'$.sessionId'),json_extract(${row}.data,'$.projectId'))
          ON CONFLICT(kind,source_id) DO UPDATE SET session_id=excluded.session_id,project_id=excluded.project_id;
          INSERT INTO knowledge_source_revision VALUES(COALESCE(json_extract(${row}.data,'$.sessionId'),''),1)
          ON CONFLICT(session_id) DO UPDATE SET revision=revision+1;
          ${action === 'UPDATE' ? `INSERT INTO knowledge_source_revision
            SELECT COALESCE(json_extract(old.data,'$.sessionId'),''),1
            WHERE json_extract(old.data,'$.sessionId') IS NOT json_extract(new.data,'$.sessionId')
            ON CONFLICT(session_id) DO UPDATE SET revision=revision+1;` : ''}
          DELETE FROM knowledge_memory_links WHERE source_id=${row}.id AND ${row}.kind='memory';
          ${action !== 'DELETE' ? `INSERT INTO knowledge_memory_coverage SELECT json_extract(new.data,'$.sessionId'),0
            WHERE new.kind='memory' AND json_type(new.data,'$.sessionId')='text' ON CONFLICT DO NOTHING;` : ''}
          ${action !== 'DELETE' ? `INSERT INTO knowledge_memory_links
            SELECT new.id,json_extract(new.data,'$.supersedes'),'supersedes' WHERE new.kind='memory' AND json_type(new.data,'$.supersedes')='text'
            ON CONFLICT DO NOTHING;
            INSERT INTO knowledge_memory_links
            SELECT new.id,value,'contradicts' FROM json_each(CASE WHEN json_type(new.data,'$.contradictions')='array'
              THEN json_extract(new.data,'$.contradictions') ELSE '[]' END) WHERE new.kind='memory' AND type='text' LIMIT 32
            ON CONFLICT DO NOTHING;` : ''}
        END;`);
    }
    if(ownTransaction) db.exec('COMMIT');
    ready.add(db);
    } catch(error) { if(ownTransaction && db.isTransaction) db.exec('ROLLBACK'); throw error; }
  }
  return db;
}

// Polling reads a small per-session change counter rather than aggregating the
// source ledger. Before migration, callers receive a stable zero without DDL.
export function knowledgeSourceRevision(session) {
  const access = knowledgeAccess(session, { readOnly: true }), db = database();
  if (access.disabled || !db.prepare("SELECT 1 FROM sqlite_master WHERE name='knowledge_source_revision'").get()) return 0;
  const ids = allowedKnowledgeSessionIds(session, access, { readOnly: true });
  return db.prepare('SELECT coalesce(sum(revision),0) AS revision FROM knowledge_source_revision WHERE session_id IN (SELECT value FROM json_each(?))')
    .get(JSON.stringify(ids)).revision;
}

export function knowledgeIndexRevision(sessionIds) {
  const db=database();
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='knowledge_index_revision'").get()) return 0;
  return db.prepare('SELECT coalesce(sum(revision),0) AS revision FROM knowledge_index_revision WHERE session_id IN (SELECT value FROM json_each(?))')
    .get(JSON.stringify(sessionIds)).revision;
}

export function reverseMemorySources(sourceId,relation,{readOnly=false}={}) {
  if (!['supersedes','contradicts'].includes(relation) || typeof sourceId !== 'string') return [];
  const db=readOnly ? database() : knowledgeDatabase();
  if (readOnly && !db.prepare("SELECT 1 FROM sqlite_master WHERE name='knowledge_memory_links'").get()) return [];
  return db.prepare(`SELECT r.data FROM knowledge_memory_links l JOIN records r ON r.kind='memory' AND r.id=l.source_id
    WHERE l.target_id=? AND l.relation=? ORDER BY l.source_id LIMIT 32`).all(sourceId,relation).map(row=>JSON.parse(row.data));
}

// Initialize before a native write. An empty session is already complete:
// every subsequent source mutation is covered by the installed triggers.
export function initializeMemoryLinkCoverage(sessionId) {
  const db=knowledgeDatabase();
  if(db.prepare('SELECT 1 FROM knowledge_memory_coverage WHERE session_id=?').get(sessionId)) return;
  const existing=db.prepare("SELECT 1 FROM records WHERE kind='memory' AND json_extract(data,'$.sessionId')=? LIMIT 1").get(sessionId);
  db.prepare('INSERT INTO knowledge_memory_coverage VALUES(?,?) ON CONFLICT DO NOTHING').run(sessionId,Number(!existing));
}

export function memoryRelationshipCoverage(session,access,{readOnly=false}={}) {
  const db=readOnly?database():knowledgeDatabase(),ids=allowedKnowledgeSessionIds(session,access,{readOnly});
  const exists=db.prepare("SELECT 1 FROM sqlite_master WHERE name='knowledge_memory_coverage'").get();
  const pending=exists?db.prepare(`SELECT 1 FROM json_each(?) s LEFT JOIN knowledge_memory_coverage c ON c.session_id=s.value
    WHERE coalesce(c.complete,0)=0 AND EXISTS(SELECT 1 FROM records r WHERE r.kind='memory' AND json_extract(r.data,'$.sessionId')=s.value LIMIT 1) LIMIT 1`).get(JSON.stringify(ids))
    :db.prepare("SELECT 1 FROM records WHERE kind='memory' AND json_extract(data,'$.sessionId') IN(SELECT value FROM json_each(?)) LIMIT 1").get(JSON.stringify(ids));
  return pending?'backfill-pending':'complete';
}

// Explicit owner review may establish a complete relationship snapshot for one
// record before archive migration finishes. This is not used by polling or
// ordinary retrieval: both the number of records and hydrated bytes are capped.
// It reads canonical rows without advancing cursors or claiming project-wide
// completeness. An interrupted/bounded check never means "no relationships".
export function checkMemoryRelationships(session, record, access) {
  const db = database(), ids = allowedKnowledgeSessionIds(session, access, { readOnly: true });
  const maximumRecords = 256, maximumSourceBytes = 128 * 1024, maximumBytes = 2 * 1024 * 1024;
  const encodedIds = JSON.stringify(ids), seen = new Set(), sources = [];
  let bytes = 0, incomplete = false;
  const columns = 'r.id, length(CAST(r.data AS BLOB)) AS bytes';
  const consume = rows => {
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      if (seen.size >= maximumRecords || row.bytes > maximumSourceBytes || bytes + row.bytes > maximumBytes) { incomplete = true; break; }
      // Fetch text only after its metadata fits the remaining total budget.
      // Recheck length in SQL so a concurrent growth cannot bypass the cap.
      const value = db.prepare("SELECT data FROM records WHERE kind='memory' AND id=? AND length(CAST(data AS BLOB))<=?")
        .get(row.id, Math.min(maximumSourceBytes, maximumBytes - bytes));
      if (!value) { incomplete = true; break; }
      seen.add(row.id); bytes += Buffer.byteLength(value.data);
      let source; try { source = JSON.parse(value.data); } catch { incomplete = true; break; }
      if (source.id !== row.id || !ids.includes(source.sessionId) || getRecord('session-deletion', source.sessionId)
          || !recordBelongsToProject(source, access.project)) continue;
      sources.push(source);
    }
  };
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='knowledge_memory_links'").get()) {
    for (const relation of ['supersedes', 'contradicts']) {
      if (incomplete) break;
      consume(db.prepare(`SELECT ${columns} FROM knowledge_memory_links l
        JOIN records r ON r.kind='memory' AND r.id=l.source_id
        WHERE l.target_id=? AND l.relation=? AND json_extract(r.data,'$.sessionId') IN (SELECT value FROM json_each(?))
        ORDER BY l.source_id LIMIT ?`).all(record.id, relation, encodedIds, maximumRecords + 1));
    }
  }
  const hasCoverage = db.prepare("SELECT 1 FROM sqlite_master WHERE name='knowledge_memory_coverage'").get();
  const pending = db.prepare(`SELECT s.value AS id FROM json_each(?) s
    ${hasCoverage ? 'LEFT JOIN knowledge_memory_coverage c ON c.session_id=s.value' : ''}
    WHERE ${hasCoverage ? 'coalesce(c.complete,0)=0 AND' : ''}
      EXISTS(SELECT 1 FROM records r WHERE r.kind='memory' AND json_extract(r.data,'$.sessionId')=s.value)
    ORDER BY s.value LIMIT ?`).all(encodedIds, maximumRecords + 1);
  if (pending.length > maximumRecords) incomplete = true;
  for (const owner of pending) {
    if (incomplete) break;
    consume(db.prepare(`SELECT ${columns} FROM records r WHERE r.kind='memory'
      AND json_extract(r.data,'$.sessionId')=? ORDER BY r.updated_at DESC,r.id LIMIT ?`).all(owner.id, maximumRecords + 1));
  }
  const supersededBy = sources.find(source => source.supersedes === record.id)?.id || null;
  const contradictions = sources.filter(source => !source.invalidatedAt && Array.isArray(source.contradictions)
    && source.contradictions.includes(record.id)).map(source => source.id);
  return { complete: !incomplete, checkedRecords: seen.size, checkedBytes: bytes, supersededBy, contradictions };
}

// A typed source is always resolved from current authoritative records, never
// from a cached payload alone. Artifact retrieval exposes metadata, not files.
export function canonicalKnowledgeSource(access, hit, sessionIds, { maxSourceBytes, onOmitted } = {}) {
  if (access.disabled || !sessionIds.includes(hit.sessionId) || getRecord('session-deletion', hit.sessionId)) return null;
  const kind = hit.kind === 'outcome' ? 'core.checkpoint.scope' : hit.kind === 'goal' ? 'goal-history' : hit.kind === 'attempt' ? 'core.episode.observation' : hit.kind;
  if (!recordKinds.includes(kind)) return null;
  let record;
  if (maxSourceBytes !== undefined) {
    if (!Number.isSafeInteger(maxSourceBytes) || maxSourceBytes<1) throw new Error('Use a positive source hydration bound.');
    const row=database().prepare(`SELECT CASE WHEN length(CAST(data AS BLOB))<=? THEN data END AS data
      FROM records WHERE kind=? AND id=?`).get(maxSourceBytes,kind,hit.sourceId);
    if(row && row.data===null) { onOmitted?.('source-byte-limit'); return null; }
    record=row?.data ? JSON.parse(row.data) : null;
  } else record = getRecord(kind, hit.sourceId);
  if (!record || (kind === 'core.checkpoint.scope' ? `${record.sessionId}:${digest(record.scope)}` : record.id || record.sessionId) !== hit.sourceId || record.sessionId !== hit.sessionId) return null;
  const owner = getRecord('session', record.sessionId);
  if (!owner || !sessionBelongsToProject(owner, access.project, { readOnly: true })) return null;
  const material = !record.project && !record.projectRoot && ['goal-history', 'artifact', 'core.episode.observation'].includes(kind)
    ? { ...record, project: access.project.root, projectId: access.project.id } : record;
  if (!recordBelongsToProject(material, access.project)) return null;
  if (kind === 'core.checkpoint.scope') {
    if (record.schemaVersion !== 2 || record.provenance !== 'core-checkpoint' || record.scope?.kind !== 'goal') return null;
    return checkpointOutcome(record, hit.sourceId);
  }
  if (kind === 'core.episode.observation') {
    const reference = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value) && cleanKnowledgeText(value)===value ? value : null;
    const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null;
    const sourceSeq = Number.isSafeInteger(record.sourceSeq) && record.sourceSeq>0 ? record.sourceSeq : null;
    const event = sourceSeq && database().prepare("SELECT data FROM events WHERE session_id=? AND seq=? AND type='work.observed' AND length(CAST(data AS BLOB))<=262144").get(record.sessionId,sourceSeq);
    if (!event) return null;
    const { sourceSeq:_sourceSeq,throughSeq:_throughSeq,createdAt:_createdAt,importProvenance:_importProvenance,importedUntrusted:_importedUntrusted,...observed }=record;
    if (digest(JSON.parse(event.data)) !== digest(observed)) return null;
    const imported=Boolean(record.importProvenance || record.importedUntrusted);
    return { id:record.id,sessionId:record.sessionId,projectId:access.project.id,sourceSeq,eventSourceId:`${record.sessionId}:${sourceSeq}`,
      goalId:reference(record.goalId),runId:reference(record.runId),assignmentId:reference(record.assignmentId),
      assignmentRound:Number.isSafeInteger(record.assignmentRound)?record.assignmentRound:null,
      workUnitId:reference(record.workUnitId),workUnitRevision:Number.isSafeInteger(record.workUnitRevision)?record.workUnitRevision:null,
      dependencyFingerprint:hash(record.dependencyFingerprint),operationFingerprint:hash(record.operationFingerprint),
      attemptKind:cleanKnowledgeText(record.kind,80),name:cleanKnowledgeText(record.name,120),summary:cleanKnowledgeText(record.summary,2000),
      outcome:['succeeded','failed','interrupted','denied','unknown'].includes(record.outcome)?record.outcome:'unknown',
      exitCode:Number.isSafeInteger(record.exitCode)?record.exitCode:null,
      error:record.error ? { errorCode:cleanKnowledgeText(record.error.errorCode,100),errorClass:cleanKnowledgeText(record.error.errorClass,100),
        signatureHash:hash(record.error.signatureHash),normalizedMessage:cleanKnowledgeText(record.error.normalizedMessage,1000) } : null,
      historical:true,truth:'inconclusive',stale:imported,staleReasons:imported?['imported-history-requires-revalidation']:[],
      ...(imported?{importedUntrusted:true}:{}),
      metadataOnly:true,provenance:imported?'imported-attempt-metadata':'host-observed-attempt',createdAt:record.createdAt,
      authority:'Observed execution outcome only; not proof of a finding, root cause, current scope or completion.',
      sourceRevision:digest(record),sha256:digest(record) };
  }
  if (kind === 'artifact') return { id: record.id, sessionId: record.sessionId, projectId: access.project.id,
    label: cleanKnowledgeText(record.label || '', 1000), mediaType: cleanKnowledgeText(record.mediaType || '', 100),
    size: Number.isSafeInteger(record.size) && record.size >= 0 ? record.size : null,
    sha256: /^[a-f0-9]{64}$/.test(record.sha256 || '') ? record.sha256 : null,
    createdAt: record.createdAt, provenance: record.importProvenance || record.importedUntrusted ? 'imported-artifact-metadata' : 'artifact-metadata',
    truth: 'inconclusive', metadataOnly: true,
    ...(record.importProvenance || record.importedUntrusted ? { importedUntrusted:true,stale:true,staleReasons:['imported-history-requires-revalidation'] } : {}),
    historical: true, sourceRevision: digest(record) };
  return { ...material, sourceRevision: digest(record) };
}

export function knowledgeRecordText(kind, record) {
  const text = value => typeof value === 'string' ? value : '';
  if (kind === 'outcome') return outcomeText(record);
  if (kind === 'memory') return `${text(record.statement)}\n${text(record.rationale)}`;
  if (kind === 'issue') return `${text(record.title)}\n${text(record.details)}\n${text(record.resolution)}`;
  if (kind === 'artifact') return `${text(record.label)}\n${text(record.mediaType)}`;
  if (kind === 'attempt') return `${text(record.name)}\n${text(record.summary)}\n${text(record.error?.normalizedMessage)}\n${text(record.error?.errorCode)}`;
  if (kind === 'checkpoint') return JSON.stringify({ objective: record.objective, decisions: record.decisions,
    completedWork: record.completedWork, pendingActions: record.pendingActions, unresolvedQuestions: record.unresolvedQuestions,
    blockers: publicBlockers(record.blockers) });
  return `${text(record.objective) || text(record.goal?.objective) || text(record.contract?.objective)}\n${text(record.summary?.text)}`;
}

function publicBlockers(blockers) {
  return Array.isArray(blockers) ? blockers.slice(0,32).map(value => ({ id: value.id, key: value.key, kind: value.kind,
    description: value.description, state: value.state, revision: value.revision,
    dependencyFingerprint: value.dependencyFingerprint,
    ...(value.resolution ? { resolution: { statement: value.resolution.statement, observedChange: value.resolution.observedChange,
      recordedAt: value.resolution.recordedAt, authority: value.resolution.authority } } : {}) })) : [];
}

// Keyset bootstrap visits old records once. Thereafter coalesced change keys
// handle edits/deletes, including edits whose timestamp sorts behind a cursor.
// No conversation, revision ledger or project directory is scanned here.
export function refreshKnowledgeRecords(session, { limit = 64 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw new Error('Use a bounded knowledge projection batch.');
  const access = knowledgeAccess(session, { readOnly: true });
  if (access.disabled) return { indexed: 0, remaining: false, records: [], access, ids: [] };
  const ids = allowedKnowledgeSessionIds(session, access, { readOnly: true }), db = knowledgeDatabase();
  const scopeId = (access.restricted ? session.id : 'project') + ':outcomes-v1';
  const cursor = db.prepare('SELECT * FROM knowledge_projection_cursor_v2 WHERE project_id=? AND scope_id=?').get(access.project.id, scopeId);
  const orderedIds = [...ids].sort(), kinds = [...recordKinds].sort();
  let sessionIndex = cursor?.session_id ? orderedIds.findIndex(id => id >= cursor.session_id) : 0;
  if (sessionIndex < 0) sessionIndex = orderedIds.length;
  let kindIndex = cursor?.kind && orderedIds[sessionIndex] === cursor.session_id ? Math.max(0,kinds.indexOf(cursor.kind)) : 0;
  let after = cursor?.source_id || '', complete = Boolean(cursor?.complete), bootstrap = [];
  const advance = () => {
    if(kinds[kindIndex]==='memory' && orderedIds[sessionIndex]) db.prepare(`INSERT INTO knowledge_memory_coverage VALUES(?,1)
      ON CONFLICT(session_id) DO UPDATE SET complete=1 WHERE complete!=1`).run(orderedIds[sessionIndex]);
    after = ''; if (++kindIndex >= kinds.length) { kindIndex=0; sessionIndex++; }
  };
  // Each query seeks one exact session/kind index range. Empty source ranges
  // also have a fixed quantum; no project-wide ORDER BY or JSON scan is needed.
  for (let ranges=0; !complete && ranges<8; ranges++) {
    if (sessionIndex >= orderedIds.length) { complete=true; break; }
    bootstrap = db.prepare(`SELECT kind,id FROM records WHERE kind=? AND json_extract(data,'$.sessionId')=?
      AND id>? ORDER BY id LIMIT ?`).all(kinds[kindIndex],orderedIds[sessionIndex],after,Math.ceil(limit/2)+1);
    if (bootstrap.length) break;
    advance();
  }
  const changed = db.prepare(`SELECT kind,source_id AS id FROM knowledge_changes
    WHERE session_id IN (SELECT value FROM json_each(?)) ORDER BY kind,source_id LIMIT ?`)
    .all(JSON.stringify(ids), limit + 1);
  const selected = new Map();
  // Reserve at least half the allowance for historical bootstrap so sustained
  // foreground changes cannot permanently starve older source records.
  const page = bootstrap.slice(0, Math.max(1, Math.ceil(limit / 2)));
  for (const row of page) selected.set(`${row.kind}:${row.id}`, row);
  for (const row of changed) { if (selected.size >= limit) break; selected.set(`${row.kind}:${row.id}`, row); }
  let indexed = 0; const records = [];
  for (const row of selected.values()) {
    const live = getRecord(row.kind, row.id), kind = indexedKind(row.kind);
    const record = live && canonicalKnowledgeSource(access, { kind, sourceId: row.id, sessionId: live.sessionId }, ids);
    // Invalid and removed sources lose only their derived document. Source
    // records and immutable revisions are never edited by projection work.
    if (!record) db.prepare('DELETE FROM knowledge_documents WHERE project_id=? AND kind=? AND source_id=?').run(access.project.id, kind, row.id);
    else {
      const text = knowledgeRecordText(kind, record);
      const payload = kind === 'checkpoint' ? { id: record.id, sessionId: record.sessionId, projectId: access.project.id,
        revision: record.revision, scope: record.scope, provenance: 'checkpoint-history', sourceRevision: record.sourceRevision } : record;
      indexKnowledgeRecord(access.project, kind, row.id, record.sessionId, text, { ...payload, text: cleanKnowledgeText(text),
        truth: record.truth || 'inconclusive', historical: true,
        stale: Boolean(record.importProvenance || record.importedUntrusted),
        ...(record.importProvenance || record.importedUntrusted ? { staleReasons: ['imported-history-requires-revalidation'] } : {}) });
      indexed++; records.push({ ...record, _kind: kind });
    }
    // Restricted readers may not consume another session's pending mutation.
    if (!access.restricted || live?.sessionId === session.id || changed.some(value => value.id === row.id && value.kind === row.kind)) {
      db.prepare('DELETE FROM knowledge_changes WHERE kind=? AND source_id=? AND session_id IN (SELECT value FROM json_each(?))')
        .run(row.kind, row.id, JSON.stringify(ids));
    }
  }
  if (!cursor?.complete) {
    if (bootstrap.length > page.length) after=page.at(-1).id;
    else if (page.length) advance();
    complete ||= sessionIndex >= orderedIds.length;
    db.prepare(`INSERT INTO knowledge_projection_cursor_v2 VALUES(?,?,?,?,?,?) ON CONFLICT(project_id,scope_id)
      DO UPDATE SET session_id=excluded.session_id,kind=excluded.kind,source_id=excluded.source_id,complete=excluded.complete`)
      .run(access.project.id,scopeId,orderedIds[sessionIndex] || '',kinds[kindIndex],after,Number(complete));
  }
  const pendingChanges = Boolean(db.prepare('SELECT 1 FROM knowledge_changes WHERE session_id IN (SELECT value FROM json_each(?)) LIMIT 1').get(JSON.stringify(ids)));
  return { indexed, remaining: !complete || pendingChanges, records, access, ids };
}

export function indexKnowledgeRecord(project, kind, sourceId, sessionId, text, payload = {}) {
  if (!knowledgeTypes.includes(kind) || typeof sourceId !== 'string' || !sourceId.trim() || sourceId.length > 160
    || typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 160) return;
  // Reserve query terms from the goal even when many long conclusions precede
  // it in the human-facing outcome text. The brief still shows rejected leads first.
  const indexedText = kind === 'outcome' ? `Goal: ${cleanKnowledgeText(payload.objective, 500)}\nRecorded outcome: ${cleanKnowledgeText(payload.outcome, 40)}\n${text}` : text;
  const body = cleanKnowledgeText(kind === 'checkpoint' && payload.text === undefined ? knowledgeRecordText(kind,payload) : indexedText,
    kind === 'chat' && payload.sourceVersion === 2 ? 128 * 1024 : 6000);
  // Checkpoints can carry host-only dependency snapshots. The index needs its
  // public navigation text and pin, never the runtime-policy object graph.
  const projection = kind === 'checkpoint' ? { id: sourceId,sessionId,projectId:project.id,revision:payload.revision,
    createdAt:payload.createdAt,updatedAt:payload.updatedAt,sourceRevision:payload.sourceRevision || digest(payload),
    text:body,truth:'inconclusive',historical:true,provenance:'checkpoint-history' } : payload;
  const safePayload = cleanKnowledgeValue(JSON.parse(JSON.stringify(projection)));
  const storedKind=kind==='outcome'?'core.checkpoint.scope':kind==='goal'?'goal-history':kind==='attempt'?'core.episode.observation':kind;
  const authoritative=recordKinds.includes(storedKind) && getRecord(storedKind,sourceId);
  if(authoritative) safePayload.sourceRevision=digest(authoritative);
  for (const key of ['statement', 'rationale', 'text', 'title', 'details', 'resolution']) if (typeof safePayload[key] === 'string') safePayload[key] = cleanKnowledgeText(safePayload[key]);
  const key = `${project.id}:${kind}:${sourceId}`, db = knowledgeDatabase(), encoded = JSON.stringify(safePayload);
  if (kind === 'memory' && authoritative) {
    // Relationship repair is independent of document equality: old projections
    // can already have the same text while the new reverse index is empty.
    const links=[...(typeof authoritative.supersedes === 'string' ? [[authoritative.supersedes,'supersedes']] : []),
      ...(Array.isArray(authoritative.contradictions) ? authoritative.contradictions.filter(id=>typeof id==='string').slice(0,32).map(id=>[id,'contradicts']) : [])];
    db.prepare('DELETE FROM knowledge_memory_links WHERE source_id=?').run(sourceId);
    for (const [target,relation] of links) db.prepare('INSERT INTO knowledge_memory_links VALUES(?,?,?) ON CONFLICT DO NOTHING').run(sourceId,target,relation);
  }
  const previous = db.prepare('SELECT body,payload FROM knowledge_documents WHERE key=?').get(key);
  if (previous?.body === body && previous?.payload === encoded) return;
  db.prepare(`INSERT INTO knowledge_documents VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(key) DO UPDATE SET body=excluded.body,payload=excluded.payload,session_id=excluded.session_id,updated_at=excluded.updated_at`).run(
    key, project.id, sessionId, kind, sourceId, body, encoded, payload.updatedAt || payload.createdAt || now());
}

export function allowedKnowledgeSessionIds(session, access = knowledgeAccess(session), { readOnly = false } = {}) {
  if (access.disabled) return [];
  if (access.sessionIds) return access.sessionIds;
  // SQL narrows candidates to this engagement before paths/registry checks. A
  // declared ID alone is never sufficient for an imported or copied session.
  const db = database(), rows = db.prepare(`SELECT id,data FROM records WHERE kind='session' AND
    (json_extract(data,'$.projectId')=? OR COALESCE(json_extract(data,'$.projectRoot'),json_extract(data,'$.cwd')) IN (SELECT value FROM json_each(?))
     OR json_extract(data,'$.cwd') LIKE ? ESCAPE '\\') LIMIT 10000`).all(access.project.id, JSON.stringify(access.project.aliases), access.project.root.replace(/[\\%_]/g, '\\$&') + '/%');
  const ids = rows.filter(row => !getRecord('session-deletion', row.id)).map(row => JSON.parse(row.data))
    .filter(candidate => sessionBelongsToProject(candidate, access.project, { readOnly })).map(candidate => candidate.id);
  if (!ids.includes(session.id)) ids.push(session.id);
  return ids;
}

export function refreshKnowledgeHistory(session, access = knowledgeAccess(session), { limit = 2000, sessionOnly = false } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2000) throw new Error('Invalid history indexing page.');
  const ids = sessionOnly ? [session.id] : allowedKnowledgeSessionIds(session, access), db = knowledgeDatabase();
  if (!ids.length) return { indexed: 0, remaining: false };
  const ownerKey = `history:${access.project.id}:${sessionOnly ? `session:${session.id}` : access.restricted ? session.id : 'owner'}`;
  const previous = getRecord('core.knowledge.cursor', ownerKey), after = previous?.version === 2 ? previous.afterSessionId : null;
  const ordered = [...ids].sort();
  const start = after ? ordered.findIndex(id => id > after) : 0;
  const selected = [...ordered.slice(start < 0 ? 0 : start), ...ordered.slice(0, Math.max(0, start))].slice(0, 32);
  const deadline = Date.now() + 50;
  const frontBudget = { bytes: 2 * 1024 * 1024, parts: 8192, deadline };
  const tailBudget = { bytes: 512 * 1024, parts: 8192, deadline };
  let indexed = 0, remaining = ids.length > selected.length, scanned = 0, visited = 0, lastSessionId = null, latest = 0;
  for (const sessionId of selected) {
    // A scheduler pause must not reduce discovery to one perpetually deferred
    // session per tick. Admit eight bounded discovery units before clock yield;
    // the independent event, byte, part and 32-session page caps still apply.
    if (scanned >= limit || visited >= 8 && Date.now() >= deadline) { remaining = true; break; }
    visited++;
    lastSessionId = sessionId; // Deferred/legacy sources also yield their turn.
    const saved = getRecord('session', sessionId);
    if (!saved || getRecord('session-deletion', sessionId)) continue;
    const running = ['starting', 'running', 'waiting_for_input', 'verifying'].includes(saved.executionState);
    const sealed = running ? advanceConversationSource(saved) : null;
    if (sealed?.deferred) { remaining = true; continue; }
    const end = running ? sealed.sealedThroughSeq : db.prepare('SELECT coalesce(max(seq),0) AS seq FROM events WHERE session_id=?').get(sessionId).seq;
    const cursorKey = `history:v2:${access.project.id}:${sessionId}`, cursor = getRecord('core.knowledge.cursor', cursorKey)?.seq || 0;
    const budget = limit - scanned;
    const rows = db.prepare(`SELECT e.seq,e.type,e.created_at, json_extract(e.data,'$.kind') AS kind FROM events e WHERE e.session_id=? AND e.seq>? AND e.seq<=?
      AND ${conversationVisible} AND typeof(${conversationBody})='text' ORDER BY e.seq LIMIT ?`).all(sessionId, cursor, end, budget + 1);
    const page = rows.slice(0, budget), contexts = new Map(), seen = new Set();
    const tail = rows.length ? db.prepare(`SELECT e.seq,e.type,e.created_at,json_extract(e.data,'$.kind') AS kind FROM events e
      WHERE e.session_id=? AND e.seq<=? AND ${conversationVisible} AND typeof(${conversationBody})='text' ORDER BY e.seq DESC LIMIT 32`).all(sessionId, end) : [];
    const processRow = (row, workBudget) => {
      if (row.kind === 'documentation') return true;
      let context = contexts.get(row.seq);
      if (!context) {
        if (Date.now() >= workBudget.deadline) return false;
        context = conversationRedactionContext(sessionId, row, end, { budget: workBudget });
        if (context.deferred) return false;
        contexts.set(row.seq, context);
        for (const seq of context.offsets.keys()) contexts.set(seq, context);
      }
      if (seen.has(context.key)) return true;
      seen.add(context.key);
      const text = context.text, firstSeq = context.rows?.[0]?.seq || row.seq, lastSeq = context.rows?.at(-1)?.seq || row.seq;
      if (!text) return true;
      indexKnowledgeRecord(access.project, 'chat', `${sessionId}:${firstSeq}`, sessionId, text,
        { text: cleanKnowledgeText(text), truth: 'historical', createdAt: context.rows?.[0]?.created_at || row.created_at, eventType: row.type,
          role: row.type === 'message.user' || row.type === 'question.answered' ? 'user' : 'assistant',
          provenance: 'sealed-conversation-message', sourceVersion: 2, firstSeq, lastSeq, sealedThroughSeq: context.completionSeq || end,
          omitted: context.omitted, sha256: context.sourceHash || digest(text) });
      indexed++; return true;
    };
    // Prefix work owns the cursor and must keep progressing under contention.
    // Admit one fixed 32-row unit before cooperative clock checks, retaining
    // the aggregate byte/part limits. A scheduler pause must not let repeated
    // opportunistic tail reads spend every subsequent maintenance allowance.
    frontBudget.deadline = Date.now() + 35;
    let last = cursor, consumed = 0;
    for (const row of page) {
      const sliceDeadline = frontBudget.deadline;
      if (scanned + consumed < Math.min(32, limit)) frontBudget.deadline = Infinity;
      let processed;
      try { processed = processRow(row, frontBudget); } finally { frontBudget.deadline = sliceDeadline; }
      if (!processed) break;
      last = row.seq; consumed++;
    }
    // Latest complete messages have an independent small time/byte allowance.
    // Tail publication never advances the contiguous prefix cursor.
    tailBudget.deadline = Date.now() + 15;
    for (const row of tail) if (!processRow(row, tailBudget)) break;
    const deferred = consumed < page.length;
    if (!deferred && rows.length <= budget) last = end;
    putHistoryCursor(cursorKey, { version: 2, sessionId, seq: last, sealedThroughSeq: end, updatedAt: now() });
    latest = Math.max(latest, last); scanned += consumed;
    remaining ||= deferred || rows.length > budget || Boolean(sealed?.remaining);
    if (deferred) break;
  }
  // Legacy event-fragment documents can contain split credential fragments. V2
  // readers only use whole-message documents; old source events remain intact.
  putHistoryCursor(ownerKey, { version: 2, seq: Math.max(previous?.seq || 0, latest), afterSessionId: lastSessionId,
    source: 'per-session-sealed-cursors', remaining, updatedAt: now() });
  return { indexed, remaining, sourceVersion: 2 };
}
function putHistoryCursor(id, value) {
  knowledgeDatabase().prepare(`INSERT INTO records VALUES (?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET
    data=json_set(excluded.data,'$.seq',max(coalesce(json_extract(records.data,'$.seq'),0),coalesce(json_extract(excluded.data,'$.seq'),0))),updated_at=excluded.updated_at`)
    .run('core.knowledge.cursor', id, JSON.stringify(value), now());
}

export function searchKnowledgeIndex(access, sessionIds, { query = '', limit = 12, offset = 0, types = knowledgeTypes, includeStale = true, excludeChatSessionId, readOnly = false, count = true, identifiersOnly = false } = {}) {
  if (typeof query !== 'string' || query.length > 500 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50 || !Number.isSafeInteger(offset) || offset < 0
    || !Array.isArray(types) || types.some(type => !knowledgeTypes.includes(type)) || typeof identifiersOnly !== 'boolean') throw new Error('Invalid project knowledge search.');
  const db = readOnly ? database() : knowledgeDatabase();
  if (readOnly && !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='knowledge_documents'").get()) return { total: 0, items: [], nextOffset: null, indexingRequired: true };
  const tokens = [...new Set(query.match(/[\p{L}\p{N}_-]+/gu) || [])].slice(0, 24), match = tokens.map(token => '"' + token.replaceAll('"', '""') + '"*').join(' OR ');
  const base = `d.project_id=? AND (d.kind!='chat' OR json_extract(d.payload,'$.sourceVersion')=2) AND d.session_id IN (SELECT value FROM json_each(?)) AND d.kind IN (SELECT value FROM json_each(?))${includeStale ? '' : " AND COALESCE(json_extract(d.payload,'$.stale'),0)=0"}${excludeChatSessionId ? " AND NOT (d.kind='chat' AND d.session_id=?)" : ''}`;
  const args = [access.project.id, JSON.stringify(sessionIds), JSON.stringify(types), ...(excludeChatSessionId ? [excludeChatSessionId] : [])];
  const fields=identifiersOnly?'d.kind,d.source_id,d.session_id,d.project_id':'d.*';
  const excerpt=identifiersOnly?'':",snippet(knowledge_fts,0,'','',' … ',48) AS match_excerpt";
  const rows = match ? db.prepare(`SELECT ${fields},bm25(knowledge_fts) AS rank${excerpt} FROM knowledge_fts JOIN knowledge_documents d ON d.rowid=knowledge_fts.rowid WHERE ${base} AND knowledge_fts MATCH ? ORDER BY rank,d.updated_at DESC LIMIT ? OFFSET ?`).all(...args, match, limit + 1, offset)
    : db.prepare(`SELECT ${fields},0 AS rank FROM knowledge_documents d WHERE ${base} ORDER BY CASE d.kind WHEN 'memory' THEN 0 WHEN 'issue' THEN 1 ELSE 2 END,d.updated_at DESC LIMIT ? OFFSET ?`).all(...args, limit + 1, offset);
  const total = !count ? offset + rows.length : match ? db.prepare(`SELECT count(*) AS total FROM knowledge_fts JOIN knowledge_documents d ON d.rowid=knowledge_fts.rowid WHERE ${base} AND knowledge_fts MATCH ?`).get(...args, match).total
    : db.prepare(`SELECT count(*) AS total FROM knowledge_documents d WHERE ${base}`).get(...args).total;
  return { total, items: rows.slice(0, limit).map(row => ({ ...(identifiersOnly?{}:JSON.parse(row.payload)), kind: row.kind, sourceId: row.source_id, sessionId: row.session_id, projectId: row.project_id,
    ...(row.match_excerpt ? { excerpt: cleanKnowledgeText(row.match_excerpt, 3000) } : {}),
    score: -Number(row.rank), ...(identifiersOnly?{}:{whyMatched: tokens.length ? `Matched ${tokens.filter(token => row.body.toLowerCase().includes(token.toLowerCase())).join(', ')}` : 'Recent project knowledge'}) })), nextOffset: rows.length > limit ? offset + limit : null };
}

export function readKnowledgeSource(session, { sourceId, sha256, offset = 0, limit = 4096 } = {}) {
  const access = knowledgeAccess(session, { readOnly: true }), match = typeof sourceId === 'string' && /^([a-f0-9-]{36}):(\d+)$/.exec(sourceId);
  const outcomeId=typeof sourceId === 'string' && /^[a-f0-9-]{36}:[a-f0-9]{64}$/.test(sourceId);
  const attemptId=typeof sourceId === 'string' && /^[a-f0-9]{64}$/.test(sourceId);
  if (!match && !attemptId && !outcomeId || !/^[a-f0-9]{64}$/.test(sha256 || '') || !Number.isSafeInteger(offset) || offset < 0 || offset > (outcomeId ? outcomeExpansionBytes : 128 * 1024) ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 8192) throw new Error('Use a scoped source ID, its SHA-256 and bounded UTF-8 page.');
  if (attemptId || outcomeId) {
    const storedKind = outcomeId ? 'core.checkpoint.scope' : 'core.episode.observation';
    const row = database().prepare('SELECT CASE WHEN length(CAST(data AS BLOB))<=? THEN data END AS data FROM records WHERE kind=? AND id=?')
      .get(outcomeSourceBytes, storedKind, sourceId);
    if (row && !row.data) throw new Error('This source exceeds its bounded read allowance; original checkpoint history remains local.');
    const record = row?.data ? JSON.parse(row.data) : null, ids = allowedKnowledgeSessionIds(session, access, { readOnly: true });
    const live = record && canonicalKnowledgeSource(access, { kind: outcomeId ? 'outcome' : 'attempt', sourceId, sessionId: record.sessionId }, ids,
      { maxSourceBytes: outcomeSourceBytes });
    if (!live) throw new Error('Knowledge source is outside this authorized conversation scope or unavailable.');
    if ((live.sha256 || live.sourceRevision) !== sha256) throw Object.assign(new Error('Knowledge source changed. Search again before expanding it.'),{code:'KNOWLEDGE_SOURCE_CHANGED'});
    const bytes = Buffer.from(JSON.stringify(outcomeId ? publicCheckpointOutcome(live) : cleanKnowledgeValue(live), null, 2));
    if (bytes.length > (outcomeId ? outcomeExpansionBytes : 128 * 1024)) throw new Error('This source exceeds its bounded expansion allowance; original history remains local.');
    if (offset>bytes.length || offset<bytes.length && (bytes[offset]&0xc0)===0x80) throw new Error('Source offset must be a valid UTF-8 byte boundary.');
    let nextOffset=Math.min(bytes.length,offset+limit);
    while(nextOffset<bytes.length && nextOffset>offset && (bytes[nextOffset]&0xc0)===0x80) nextOffset--;
    if(nextOffset===offset && offset<bytes.length) throw new Error('Source page is too short for one UTF-8 character.');
    return {sourceId,sha256,sessionId:record.sessionId,offset,nextOffset,totalBytes:bytes.length,hasMore:nextOffset<bytes.length,text:bytes.subarray(offset,nextOffset).toString('utf8'),
      redacted:true,metadataOnly:true,provenance:live.provenance,authority:live.authority};
  }
  if (access.disabled || !allowedKnowledgeSessionIds(session, access, { readOnly: true }).includes(match[1]) || getRecord('session-deletion', match[1])) throw new Error('Knowledge source is outside this authorized conversation scope.');
  const seq = Number(match[2]), db = database();
  const row = db.prepare(`SELECT e.seq,e.type FROM events e WHERE e.session_id=? AND e.seq=? AND ${conversationVisible}
    AND typeof(${conversationBody})='text'`).get(match[1], seq);
  if (!row) throw new Error('This knowledge source is unavailable.');
  const end = db.prepare('SELECT coalesce(max(seq),0) AS seq FROM events WHERE session_id=?').get(match[1]).seq;
  const context = conversationRedactionContext(match[1], row, end);
  if (context.omitted || context.deferred || !context.sourceHash) throw new Error('This source is not a complete bounded logical message; its original saved history remains local.');
  if (context.sourceHash !== sha256 || context.rows?.[0]?.seq !== seq) throw Object.assign(new Error('Knowledge source changed or its complete-message identity differs. Search again before expanding it.'), { code: 'KNOWLEDGE_SOURCE_CHANGED' });
  const bytes = Buffer.from(cleanKnowledgeText(context.text, 128 * 1024));
  if (offset > bytes.length || offset < bytes.length && (bytes[offset] & 0xc0) === 0x80) throw new Error('Source offset must be a valid UTF-8 byte boundary.');
  let nextOffset = Math.min(bytes.length, offset + limit);
  while (nextOffset < bytes.length && nextOffset > offset && (bytes[nextOffset] & 0xc0) === 0x80) nextOffset--;
  if (nextOffset === offset && offset < bytes.length) throw new Error('Source page is too short for one UTF-8 character.');
  return { sourceId, sha256, sessionId: match[1], firstSeq: seq, lastSeq: context.rows.at(-1).seq,
    completionSeq: context.completionSeq || null, offset, nextOffset, hasMore: nextOffset < bytes.length,
    text: bytes.subarray(offset, nextOffset).toString('utf8'), redacted: true, provenance: 'original-conversation-excerpts',
    authority: 'Historical source material, never current permission or proof of a new outcome.' };
}

export function scopedRecord(record, access, sessionIds) {
  return recordBelongsToProject(record, access.project) && sessionIds.includes(record.sessionId);
}
