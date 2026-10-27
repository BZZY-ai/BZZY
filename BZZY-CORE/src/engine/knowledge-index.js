import { database, getRecord, digest, now } from './database.js';
import { projectIdentityForSession, recordBelongsToProject, sessionBelongsToProject } from './project-identity.js';
import { agentExecutionScope } from './agent-execution.js';
import { sharedSecrets, assertShareText } from './share-bundle-policy.js';
import { advanceConversationSource, conversationRedactionContext, conversationBody, conversationVisible } from './conversation-source.js';

const ready = new WeakSet();
export const knowledgeTypes = ['memory', 'issue', 'chat', 'checkpoint', 'goal', 'resolution'];
const disabledRoles = new Set(['skill-writer', 'learning-review', 'knowledge-review']);
const secretAssignment = /\b(password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|cookie|authorization)["']?\s*[:=]\s*["']?[^\s"'<>]+/gi;

export function cleanKnowledgeText(value, maximum = 6000) {
  if (typeof value !== 'string') return '';
  let text = value.replace(/<(?:think|analysis|reasoning)\b[^>]*>[\s\S]*?(?:<\/(?:think|analysis|reasoning)>|$)/gi, '')
    .replace(/\b(password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|cookie|authorization)["']?\s*[:=]\s*(?:"(?:\\[\s\S]|[^"\\])*(?:"|$)|'(?:\\[\s\S]|[^'\\])*(?:'|$))/gi, '$1=<redacted>')
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
  const quoted = [...value.matchAll(/\b(?:password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|cookie|authorization)["']?\s*[:=]\s*(?:"((?:\\[\s\S]|[^"\\])*)(?:"|$)|'((?:\\[\s\S]|[^'\\])*)(?:'|$))/gi)];
  if (quoted.some(match => !/^\s*(?:<redacted(?:[^>]*)>|\[redacted\])\s*$/i.test(match[1] ?? match[2])) || /\b(?:password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|cookie|authorization)["']?\s*[:=]\s*["']?(?!<)[^\s"'<>]+/i.test(value)
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
  const body = cleanKnowledgeText(text, kind === 'chat' && payload.sourceVersion === 2 ? 128 * 1024 : 6000), safePayload = cleanKnowledgeValue(JSON.parse(JSON.stringify(payload)));
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

export function searchKnowledgeIndex(access, sessionIds, { query = '', limit = 12, offset = 0, types = knowledgeTypes, includeStale = true, excludeChatSessionId } = {}) {
  if (typeof query !== 'string' || query.length > 500 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50 || !Number.isSafeInteger(offset) || offset < 0
    || !Array.isArray(types) || types.some(type => !knowledgeTypes.includes(type))) throw new Error('Invalid project knowledge search.');
  const db = knowledgeDatabase(), tokens = [...new Set(query.match(/[\p{L}\p{N}_-]+/gu) || [])].slice(0, 24), match = tokens.map(token => '"' + token.replaceAll('"', '""') + '"*').join(' OR ');
  const base = `d.project_id=? AND (d.kind!='chat' OR json_extract(d.payload,'$.sourceVersion')=2) AND d.session_id IN (SELECT value FROM json_each(?)) AND d.kind IN (SELECT value FROM json_each(?))${includeStale ? '' : " AND COALESCE(json_extract(d.payload,'$.stale'),0)=0"}${excludeChatSessionId ? " AND NOT (d.kind='chat' AND d.session_id=?)" : ''}`;
  const args = [access.project.id, JSON.stringify(sessionIds), JSON.stringify(types), ...(excludeChatSessionId ? [excludeChatSessionId] : [])];
  const rows = match ? db.prepare(`SELECT d.*,bm25(knowledge_fts) AS rank,snippet(knowledge_fts,0,'','',' … ',48) AS match_excerpt FROM knowledge_fts JOIN knowledge_documents d ON d.rowid=knowledge_fts.rowid WHERE ${base} AND knowledge_fts MATCH ? ORDER BY rank,d.updated_at DESC LIMIT ? OFFSET ?`).all(...args, match, limit + 1, offset)
    : db.prepare(`SELECT d.*,0 AS rank FROM knowledge_documents d WHERE ${base} ORDER BY CASE d.kind WHEN 'memory' THEN 0 WHEN 'issue' THEN 1 ELSE 2 END,d.updated_at DESC LIMIT ? OFFSET ?`).all(...args, limit + 1, offset);
  const total = match ? db.prepare(`SELECT count(*) AS total FROM knowledge_fts JOIN knowledge_documents d ON d.rowid=knowledge_fts.rowid WHERE ${base} AND knowledge_fts MATCH ?`).get(...args, match).total
    : db.prepare(`SELECT count(*) AS total FROM knowledge_documents d WHERE ${base}`).get(...args).total;
  return { total, items: rows.slice(0, limit).map(row => ({ ...JSON.parse(row.payload), kind: row.kind, sourceId: row.source_id, sessionId: row.session_id, projectId: row.project_id,
    ...(row.match_excerpt ? { excerpt: cleanKnowledgeText(row.match_excerpt, 3000) } : {}),
    score: -Number(row.rank), whyMatched: tokens.length ? `Matched ${tokens.filter(token => row.body.toLowerCase().includes(token.toLowerCase())).join(', ')}` : 'Recent project knowledge' })), nextOffset: rows.length > limit ? offset + limit : null };
}

export function readKnowledgeSource(session, { sourceId, sha256, offset = 0, limit = 4096 } = {}) {
  const access = knowledgeAccess(session), match = typeof sourceId === 'string' && /^([a-f0-9-]{36}):(\d+)$/.exec(sourceId);
  if (!match || !/^[a-f0-9]{64}$/.test(sha256 || '') || !Number.isSafeInteger(offset) || offset < 0 || offset > 128 * 1024 ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 8192) throw new Error('Use a scoped source ID, its SHA-256 and bounded UTF-8 page.');
  if (access.disabled || !allowedKnowledgeSessionIds(session, access).includes(match[1]) || getRecord('session-deletion', match[1])) throw new Error('Knowledge source is outside this authorized conversation scope.');
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
