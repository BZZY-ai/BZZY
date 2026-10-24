import { database, getRecord, digest, now } from './database.js';
import { projectIdentityForSession, recordBelongsToProject, sessionBelongsToProject } from './project-identity.js';
import { agentExecutionScope } from './agent-execution.js';
import { sharedSecrets, assertShareText } from './share-bundle-policy.js';

const ready = new WeakSet();
export const knowledgeTypes = ['memory', 'issue', 'chat', 'checkpoint', 'goal'];
const disabledRoles = new Set(['skill-writer', 'learning-review', 'knowledge-review']);
const secretAssignment = /\b(password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|cookie|authorization)["']?\s*[:=]\s*["']?[^\s"'<>]+/gi;

export function cleanKnowledgeText(value, maximum = 6000) {
  if (typeof value !== 'string') return '';
  let text = value.replace(/<(?:think|analysis|reasoning)\b[^>]*>[\s\S]*?(?:<\/(?:think|analysis|reasoning)>|$)/gi, '')
    .replace(/\u0000/g, '').replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '<redacted authentication>')
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, '$1<redacted authentication>@')
    .replace(secretAssignment, '$1=<redacted>')
    .replace(/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z ]+ )?PRIVATE KEY-----|$)/g, '<redacted private key>')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, '<redacted credential>');
  for (const secret of sharedSecrets()) text = text.split(secret).join('<redacted credential>');
  return text.slice(0, maximum);
}
export function cleanKnowledgeValue(value) {
  if (typeof value === 'string') return cleanKnowledgeText(value);
  if (Array.isArray(value)) return value.slice(0, 100).map(cleanKnowledgeValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/^(?:backendHomes|backendProcess|engineHome|credentials|accountBindings|ownerToken|privateKey|reasoning|analysis|chainOfThought)$/i.test(key))
    .map(([key, item]) => [key, cleanKnowledgeValue(item)]));
  return value;
}

export function assertKnowledgeText(value, maximum = 12000) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw new Error('Knowledge text must be bounded plain text.');
  assertShareText(value, sharedSecrets());
  if (/\b(?:password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|cookie|authorization)["']?\s*[:=]\s*["']?(?!<)[^\s"'<>]+/i.test(value)
    || /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/i.test(value)
    || /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+(?::[^\s/@]*)?@/i.test(value)
    || /<(?:think|analysis|reasoning)\b/i.test(value)) throw new Error('Knowledge cannot contain authentication bindings or private reasoning.');
  return value.trim();
}

export function knowledgeAccess(session) {
  if (!session?.id || !session.cwd) throw new Error('A saved session is required for knowledge access.');
  const saved = getRecord('session', session.id);
  if (getRecord('session-deletion', session.id)) throw new Error('Deleted sessions cannot read project knowledge.');
  for (const key of ['cwd', 'parentSessionId', 'purpose', 'agentId', 'role', 'agentNamespace']) {
    if (saved && (saved[key] ?? null) !== (session[key] ?? null)) throw new Error('Knowledge session identity changed. Refresh the saved session.');
  }
  if (saved?.projectRoot && saved.projectRoot !== session.projectRoot) throw new Error('Knowledge project scope changed.');
  const agent = agentExecutionScope(session), project = projectIdentityForSession(session);
  if (agent && agent.projectRoot !== project.root) throw new Error('Persistent Agent knowledge must stay in its registered project.');
  const restricted = Boolean(agent || ['executor', 'reviewer'].includes(session.role));
  return { project, restricted, agent, disabled: disabledRoles.has(session.role),
    sessionIds: restricted ? [session.id] : null, profiles: !restricted && !disabledRoles.has(session.role) };
}

export function knowledgeDatabase() {
  const db = database();
  if (!ready.has(db)) {
    db.exec(`CREATE TABLE IF NOT EXISTS knowledge_documents (
      key TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT NOT NULL, kind TEXT NOT NULL,
      source_id TEXT NOT NULL, body TEXT NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS knowledge_project ON knowledge_documents(project_id,kind,updated_at DESC);
      CREATE INDEX IF NOT EXISTS knowledge_session ON knowledge_documents(project_id,session_id,kind);
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(body,content='knowledge_documents',content_rowid='rowid');
      CREATE TRIGGER IF NOT EXISTS knowledge_insert AFTER INSERT ON knowledge_documents BEGIN
        INSERT INTO knowledge_fts(rowid,body) VALUES(new.rowid,new.body); END;
      CREATE TRIGGER IF NOT EXISTS knowledge_delete AFTER DELETE ON knowledge_documents BEGIN
        INSERT INTO knowledge_fts(knowledge_fts,rowid,body) VALUES('delete',old.rowid,old.body); END;
      CREATE TRIGGER IF NOT EXISTS knowledge_update AFTER UPDATE ON knowledge_documents BEGIN
        INSERT INTO knowledge_fts(knowledge_fts,rowid,body) VALUES('delete',old.rowid,old.body);
        INSERT INTO knowledge_fts(rowid,body) VALUES(new.rowid,new.body); END;`);
    ready.add(db);
  }
  return db;
}

export function indexKnowledgeRecord(project, kind, sourceId, sessionId, text, payload = {}) {
  if (!knowledgeTypes.includes(kind) || typeof sourceId !== 'string' || !sourceId.trim() || sourceId.length > 160
    || typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 160) return;
  const body = cleanKnowledgeText(text), safePayload = cleanKnowledgeValue(JSON.parse(JSON.stringify(payload)));
  for (const key of ['statement', 'rationale', 'text', 'title', 'details', 'resolution']) if (typeof safePayload[key] === 'string') safePayload[key] = cleanKnowledgeText(safePayload[key]);
  const key = `${project.id}:${kind}:${sourceId}`, db = knowledgeDatabase(), encoded = JSON.stringify(safePayload);
  const previous = db.prepare('SELECT body,payload FROM knowledge_documents WHERE key=?').get(key);
  if (previous?.body === body && previous?.payload === encoded) return;
  db.prepare(`INSERT INTO knowledge_documents VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(key) DO UPDATE SET body=excluded.body,payload=excluded.payload,updated_at=excluded.updated_at`).run(
    key, project.id, sessionId, kind, sourceId, body, encoded, payload.updatedAt || payload.createdAt || now());
}

export function allowedKnowledgeSessionIds(session, access = knowledgeAccess(session)) {
  if (access.disabled) return [];
  if (access.sessionIds) return access.sessionIds;
  // SQL narrows candidates to this engagement before paths/registry checks. A
  // declared ID alone is never sufficient for an imported or copied session.
  const db = database(), rows = db.prepare(`SELECT id,data FROM records WHERE kind='session' AND
    (json_extract(data,'$.projectId')=? OR COALESCE(json_extract(data,'$.projectRoot'),json_extract(data,'$.cwd')) IN (SELECT value FROM json_each(?))
     OR json_extract(data,'$.cwd') LIKE ? ESCAPE '\\') LIMIT 10000`).all(access.project.id, JSON.stringify(access.project.aliases), access.project.root.replace(/[\\%_]/g, '\\$&') + '/%');
  const ids = rows.filter(row => !getRecord('session-deletion', row.id)).map(row => JSON.parse(row.data))
    .filter(candidate => sessionBelongsToProject(candidate, access.project)).map(candidate => candidate.id);
  if (!ids.includes(session.id)) ids.push(session.id);
  return ids;
}

export function refreshKnowledgeHistory(session, access = knowledgeAccess(session), { limit = 2000 } = {}) {
  const ids = allowedKnowledgeSessionIds(session, access), db = knowledgeDatabase();
  if (!ids.length) return { indexed: 0, remaining: false };
  const cursorKey = `history:${access.project.id}:${access.restricted ? session.id : 'owner'}`;
  const cursor = getRecord('core.knowledge.cursor', cursorKey)?.seq || 0;
  const rows = db.prepare(`SELECT seq,session_id,type,data,created_at FROM events WHERE seq>? AND session_id IN
    (SELECT value FROM json_each(?)) AND type IN ('message.user','text','debate.result') ORDER BY seq LIMIT ?`).all(cursor, JSON.stringify(ids), limit + 1);
  const page = rows.slice(0, limit), tail = rows.length > limit ? db.prepare(`SELECT seq,session_id,type,data,created_at FROM events WHERE session_id IN
    (SELECT value FROM json_each(?)) AND type IN ('message.user','text','debate.result') ORDER BY seq DESC LIMIT 128`).all(JSON.stringify(ids)) : [];
  const candidates = [...new Map([...page, ...tail].map(row => [row.seq, row])).values()];
  let last = page.at(-1)?.seq || cursor, indexed = 0;
  for (const row of candidates) {
    const data = JSON.parse(row.data), text = data.text || (row.type === 'debate.result' ? data.message : '');
    if (!text || data.kind === 'documentation') continue;
    indexKnowledgeRecord(access.project, 'chat', `${row.session_id}:${row.seq}`, row.session_id, text,
      { text: cleanKnowledgeText(text), truth: 'historical', createdAt: row.created_at, eventType: row.type,
        role: row.type === 'message.user' ? 'user' : 'assistant', provenance: 'visible-conversation-event', sha256: digest(text) });
    indexed++;
  }
  if (last !== cursor) db.prepare(`INSERT INTO records VALUES (?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at`).run(
    'core.knowledge.cursor', cursorKey, JSON.stringify({ seq: last, updatedAt: now() }), now());
  return { indexed, remaining: rows.length > limit };
}

export function searchKnowledgeIndex(access, sessionIds, { query = '', limit = 12, offset = 0, types = knowledgeTypes, includeStale = true, excludeChatSessionId } = {}) {
  if (typeof query !== 'string' || query.length > 500 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50 || !Number.isSafeInteger(offset) || offset < 0
    || !Array.isArray(types) || types.some(type => !knowledgeTypes.includes(type))) throw new Error('Invalid project knowledge search.');
  const db = knowledgeDatabase(), tokens = [...new Set(query.match(/[\p{L}\p{N}_-]+/gu) || [])].slice(0, 24), match = tokens.map(token => '"' + token.replaceAll('"', '""') + '"*').join(' OR ');
  const base = `d.project_id=? AND d.session_id IN (SELECT value FROM json_each(?)) AND d.kind IN (SELECT value FROM json_each(?))${includeStale ? '' : " AND COALESCE(json_extract(d.payload,'$.stale'),0)=0"}${excludeChatSessionId ? " AND NOT (d.kind='chat' AND d.session_id=?)" : ''}`;
  const args = [access.project.id, JSON.stringify(sessionIds), JSON.stringify(types), ...(excludeChatSessionId ? [excludeChatSessionId] : [])];
  const rows = match ? db.prepare(`SELECT d.*,bm25(knowledge_fts) AS rank FROM knowledge_fts JOIN knowledge_documents d ON d.rowid=knowledge_fts.rowid WHERE ${base} AND knowledge_fts MATCH ? ORDER BY rank,d.updated_at DESC LIMIT ? OFFSET ?`).all(...args, match, limit + 1, offset)
    : db.prepare(`SELECT d.*,0 AS rank FROM knowledge_documents d WHERE ${base} ORDER BY CASE d.kind WHEN 'memory' THEN 0 WHEN 'issue' THEN 1 ELSE 2 END,d.updated_at DESC LIMIT ? OFFSET ?`).all(...args, limit + 1, offset);
  const total = match ? db.prepare(`SELECT count(*) AS total FROM knowledge_fts JOIN knowledge_documents d ON d.rowid=knowledge_fts.rowid WHERE ${base} AND knowledge_fts MATCH ?`).get(...args, match).total
    : db.prepare(`SELECT count(*) AS total FROM knowledge_documents d WHERE ${base}`).get(...args).total;
  return { total, items: rows.slice(0, limit).map(row => ({ ...JSON.parse(row.payload), kind: row.kind, sourceId: row.source_id, sessionId: row.session_id, projectId: row.project_id,
    score: -Number(row.rank), whyMatched: tokens.length ? `Matched ${tokens.filter(token => row.body.toLowerCase().includes(token.toLowerCase())).join(', ')}` : 'Recent project knowledge' })), nextOffset: rows.length > limit ? offset + limit : null };
}

export function scopedRecord(record, access, sessionIds) {
  return recordBelongsToProject(record, access.project) && sessionIds.includes(record.sessionId);
}
