import { database, getRecord, putRecord, digest, now, transaction } from './database.js';
import { maskLearningText } from './learning.js';

// One source definition for derived history. Original events are never edited.
export function conversationSQL() { return { body: `CASE e.type WHEN 'question' THEN json_extract(e.data,'$.question') WHEN 'question.answered' THEN json_extract(e.data,'$.answer')
  WHEN 'debate.result' THEN json_extract(e.data,'$.message') ELSE json_extract(e.data,'$.text') END`,
  visible: `(e.type IN ('message.user','text','debate.result') OR e.type='question' AND json_extract(e.data,'$.kind')='input'
  OR e.type='question.answered' AND EXISTS (SELECT 1 FROM events q WHERE q.session_id=e.session_id AND q.type='question'
    AND json_extract(q.data,'$.kind')='input' AND json_extract(q.data,'$.id')=json_extract(e.data,'$.id')))` }; }
export const { body: conversationBody, visible: conversationVisible } = conversationSQL();
const SOURCE = 'core.conversation.source', busy = new Set(['starting', 'running', 'waiting_for_input', 'verifying']);
const identity = row => digest([row.runId || null, row.threadRef || null, row.turnId || null, row.itemId || null]);
const fields = `seq,type,created_at,json_extract(data,'$.runId') AS runId,json_extract(data,'$.threadRef') AS threadRef,
  json_extract(data,'$.turnId') AS turnId,json_extract(data,'$.itemId') AS itemId,json_extract(data,'$.kind') AS kind`;

// A bounded host cursor remembers unfinished messages across maintenance ticks.
// Item IDs alone are insufficient: native processes may reuse them after restart.
export function advanceConversationSource(session, { maxEvents = 512 } = {}) {
  if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > 2048) throw new Error('Invalid conversation source batch.');
  const operation = db => {
    if (getRecord('session-deletion', session.id) || !getRecord('session', session.id)) throw Object.assign(new Error('Conversation source is unavailable.'), { code: 'SESSION_DELETED' });
    const previous = getRecord(SOURCE, session.id) || { version: 1, sessionId: session.id, scanSeq: 0, sealedThroughSeq: 0, finalizedMessages: 0, pending: [] };
    const pendingKind = 'core.conversation.pending', pendingId = key => digest([session.id, key]);
    if (!previous.pendingInitialized) for (const item of previous.pending || []) putRecord(pendingKind, pendingId(item.key), { ...item, sessionId: session.id }, db);
    const rows = db.prepare(`SELECT ${fields} FROM events WHERE session_id=? AND seq>? ORDER BY seq LIMIT ?`).all(session.id, previous.scanSeq, maxEvents);
    let scanSeq = previous.scanSeq, finalizedMessages = previous.finalizedMessages;
    for (const row of rows) {
      if (row.type === 'text') {
        const key = identity(row), id = pendingId(key);
        if (!getRecord(pendingKind, id)) putRecord(pendingKind, id,
          { key, sessionId: session.id, firstSeq: row.seq, runId: row.runId || null, legacy: !row.itemId || !row.runId || !row.threadRef }, db);
      } else if (row.type === 'message.finalized') {
        db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(pendingKind, pendingId(identity(row))); finalizedMessages++;
      } else if (row.type === 'diagnostic.run.finished') {
        db.prepare(`DELETE FROM records WHERE kind=? AND json_extract(data,'$.sessionId')=? AND
          (? IS NULL OR json_extract(data,'$.runId') IS NULL OR json_extract(data,'$.runId')=?)`).run(pendingKind, session.id, row.runId, row.runId);
      } else if (['message.user', 'question', 'debate.result'].includes(row.type) && row.kind !== 'steering') {
        if (row.type !== 'question' || row.kind === 'input') db.prepare(`DELETE FROM records WHERE kind=? AND json_extract(data,'$.sessionId')=?
          AND json_extract(data,'$.legacy')=1`).run(pendingKind, session.id);
      }
      scanSeq = row.seq;
    }
    const pending = db.prepare(`SELECT data FROM records WHERE kind=? AND json_extract(data,'$.sessionId')=?
      ORDER BY json_extract(data,'$.firstSeq') LIMIT 32`).all(pendingKind, session.id).map(row => JSON.parse(row.data));
    const pendingMessages = db.prepare(`SELECT count(*) AS count FROM records WHERE kind=? AND json_extract(data,'$.sessionId')=?`).get(pendingKind, session.id).count;
    const firstPending = pending[0]?.firstSeq || scanSeq + 1;
    const sealedThroughSeq = Math.max(previous.sealedThroughSeq, Math.min(scanSeq, firstPending - 1));
    const value = { ...previous, scanSeq, sealedThroughSeq, finalizedMessages, pendingInitialized: true, pendingMessages, pending, updatedAt: now() };
    if (rows.length) putRecord(SOURCE, session.id, value, db);
    return { ...value, remaining: rows.length === maxEvents, deferred: busy.has(session.executionState) && !finalizedMessages };
  };
  return database().isTransaction ? operation(database()) : transaction(operation);
}

export function conversationSourceStatus(session) {
  const value = getRecord(SOURCE, session.id), latest = database().prepare('SELECT coalesce(max(seq),0) AS seq FROM events WHERE session_id=?').get(session.id).seq;
  const lag = database().prepare('SELECT count(*) AS count,min(created_at) AS oldestAt FROM events WHERE session_id=? AND seq>?').get(session.id, value?.sealedThroughSeq || 0);
  return { version: 1, scannedThroughSeq: value?.scanSeq || 0, sealedThroughSeq: value?.sealedThroughSeq || 0,
    latestSeq: latest, pendingMessages: value?.pendingMessages ?? value?.pending?.length ?? 0, finalizedMessages: value?.finalizedMessages || 0,
    lagEvents: lag.count, oldestPendingAt: lag.oldestAt || null, updatedAt: value?.updatedAt || null,
    reason: !value ? 'not_indexed' : value.pendingMessages || value.pending?.length ? 'awaiting_message_completion' : value.scanSeq < latest ? 'bounded_backfill' : null };
}

// Returns whole-message masking, with SQLite codepoint positions preserved.
// New native messages use trusted completion markers. Legacy messages retain
// conservative grouping across changed item IDs until a visible boundary.
export function conversationRedactionContext(sessionId, ref, throughSeq, { budget } = {}) {
  const db = database(); let start = ref.seq - 1, end = ref.seq + 1, filter = '', args = [];
  if (ref.type === 'text') {
    const row = db.prepare(`SELECT ${fields} FROM events WHERE session_id=? AND seq=?`).get(sessionId, ref.seq);
    const availableThrough = Math.max(throughSeq, getRecord(SOURCE, sessionId)?.scanSeq || 0);
    let seal = row?.itemId && db.prepare(`SELECT seq FROM events WHERE session_id=? AND type='message.finalized' AND seq>=? AND seq<=?
      AND json_extract(data,'$.itemId') IS ? AND json_extract(data,'$.runId') IS ? AND json_extract(data,'$.threadRef') IS ? AND json_extract(data,'$.turnId') IS ? ORDER BY seq LIMIT 1`)
      .get(sessionId, ref.seq, availableThrough, row.itemId, row.runId, row.threadRef, row.turnId);
    if (!seal && row?.runId && row?.threadRef) seal = db.prepare(`SELECT seq FROM events WHERE session_id=? AND type='diagnostic.run.finished'
      AND seq>=? AND seq<=? AND json_extract(data,'$.runId')=? ORDER BY seq LIMIT 1`).get(sessionId, ref.seq, availableThrough, row.runId);
    if (!seal && row?.runId && row?.threadRef) return { key: digest([sessionId, ref.seq, 'unsealed-native']), start: ref.seq - 1, end: ref.seq + 1, omitted: true, offsets: new Map(),
      text: '[Source omitted: this native logical message has no confirmed completion boundary.]' };
    if (seal) {
      start = db.prepare(`SELECT coalesce(max(seq),0) AS seq FROM events WHERE session_id=? AND type='message.finalized' AND seq<?
        AND json_extract(data,'$.itemId') IS ? AND json_extract(data,'$.runId') IS ? AND json_extract(data,'$.threadRef') IS ? AND json_extract(data,'$.turnId') IS ?`)
        .get(sessionId, ref.seq, row.itemId, row.runId, row.threadRef, row.turnId).seq;
      end = seal.seq;
      filter = ` AND e.type='text' AND json_extract(e.data,'$.itemId') IS ? AND json_extract(e.data,'$.runId') IS ? AND json_extract(e.data,'$.threadRef') IS ? AND json_extract(e.data,'$.turnId') IS ?`;
      args = [row.itemId, row.runId, row.threadRef, row.turnId];
    } else {
      const boundary = `(e.type='diagnostic.run.finished' OR e.type!='text' AND ${conversationVisible})`;
      start = db.prepare(`SELECT coalesce(max(e.seq),0) AS seq FROM events e WHERE e.session_id=? AND e.seq<? AND ${boundary}`).get(sessionId, ref.seq).seq;
      end = db.prepare(`SELECT coalesce(min(e.seq),?) AS seq FROM events e WHERE e.session_id=? AND e.seq>? AND e.seq<=? AND ${boundary}`)
        .get(throughSeq + 1, sessionId, ref.seq, throughSeq).seq;
    }
  }
  const where = `e.session_id=? AND e.seq>? AND e.seq<? AND ${conversationVisible} AND typeof(${conversationBody})='text'${filter}`;
  const bounds = db.prepare(`SELECT coalesce(sum(length(CAST(${conversationBody} AS BLOB))),0) AS bytes,count(*) AS parts FROM events e WHERE ${where}`)
    .get(sessionId, start, end, ...args);
  const key = digest([sessionId, start, end, args]), omitted = bounds.bytes > 128 * 1024 || bounds.parts > 4096;
  if (omitted) return { key, start, end, omitted, legacy: !filter, offsets: new Map(), text: '[Source omitted: this logical message exceeds the 128 KiB or 4096-delta privacy-redaction bound. Inspect the original saved history locally.]' };
  if (budget) {
    if (bounds.bytes > budget.bytes || bounds.parts > budget.parts || Date.now() >= budget.deadline) return { key, deferred: true };
    budget.bytes -= bounds.bytes; budget.parts -= bounds.parts;
  }
  const rows = db.prepare(`SELECT e.seq,e.created_at,${conversationBody} AS text FROM events e WHERE ${where} ORDER BY e.seq`).all(sessionId, start, end, ...args);
  let text = '', offset = 0; const offsets = new Map();
  for (const row of rows) { offsets.set(row.seq, offset); text += row.text; offset += [...row.text].length; }
  const masked = maskLearningText(text);
  let clean = '', masking = false;
  for (const character of masked.text) {
    if (character === masked.marker) { if (!masking) clean += '[redacted]'; masking = true; }
    else { clean += character; masking = false; }
  }
  return { key, start, end, omitted: false, completionSeq: filter ? end : null, offsets, rows, characters: [...masked.text], marker: masked.marker, sourceHash: digest(text), text: clean };
}
