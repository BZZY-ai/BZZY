import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { home, privateDir } from './files.js';

let connection, location;
export const now = () => new Date().toISOString();
export const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonical(value)).digest('hex');
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function database() {
  const file = path.join(home(), 'bzzy.sqlite');
  if (connection && location === file && fs.existsSync(file)) return connection;
  connection?.close(); privateDir(home());
  connection = new DatabaseSync(file); location = file; fs.chmodSync(file, 0o600);
  connection.exec(`PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(kind,id));
    CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS session_events ON events(session_id,seq);
    CREATE INDEX IF NOT EXISTS session_event_types ON events(session_id,type,seq);
    CREATE INDEX IF NOT EXISTS records_state ON records(kind,json_extract(data,'$.state'),updated_at DESC,id);
    CREATE INDEX IF NOT EXISTS records_session_state ON records(kind,json_extract(data,'$.sessionId'),json_extract(data,'$.state'),updated_at DESC,id);
    CREATE INDEX IF NOT EXISTS records_session ON records(kind,json_extract(data,'$.sessionId'),updated_at DESC,id);
    CREATE INDEX IF NOT EXISTS records_parent ON records(kind,json_extract(data,'$.parentSessionId'),updated_at DESC,id);
    CREATE INDEX IF NOT EXISTS records_document_source ON records(kind,json_extract(data,'$.documentSourceSessionId'),updated_at DESC,id);
    CREATE INDEX IF NOT EXISTS records_origin_session ON records(kind,json_extract(data,'$.originSessionId'),updated_at DESC,id);
    CREATE INDEX IF NOT EXISTS records_cwd ON records(kind,json_extract(data,'$.cwd'),updated_at DESC,id);
    CREATE INDEX IF NOT EXISTS outbox_time ON records(json_extract(data,'$.event.occurredAt')) WHERE kind='outbox';
    CREATE TABLE IF NOT EXISTS requests (scope TEXT NOT NULL, id TEXT NOT NULL, digest TEXT NOT NULL, response TEXT, state TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(scope,id));
    INSERT OR IGNORE INTO metadata VALUES ('schema_version','1');`);
  for (const suffix of ['-wal', '-shm']) if (fs.existsSync(file + suffix)) fs.chmodSync(file + suffix, 0o600);
  return connection;
}
export function transaction(operation, { readOnly = false } = {}) {
  const db = database(); db.exec(readOnly ? 'BEGIN' : 'BEGIN IMMEDIATE');
  try { const result = operation(db); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
export function getRecord(kind, id) {
  const row = database().prepare('SELECT data FROM records WHERE kind=? AND id=?').get(kind, id);
  return row ? JSON.parse(row.data) : null;
}
export function putRecord(kind, id, data, db = database()) {
  if (kind === 'session' && data && Object.hasOwn(data, 'goalValidation')) {
    const { goalValidation: _projection, ...persisted } = data; data = persisted;
  }
  db.prepare('INSERT INTO records VALUES (?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at').run(kind, id, JSON.stringify(data), now());
  return data;
}
export function listRecords(kind, { sessionId, sessionIds, parentSessionId, cwd, state, states, limit } = {}) {
  const clauses = ['kind=?'], values = [kind];
  for (const [key, value] of Object.entries({ sessionId, parentSessionId, cwd, state })) {
    if (value !== undefined) { clauses.push(`json_extract(data,'$.${key}')=?`); values.push(value); }
  }
  for (const [key, entries] of [['sessionId', sessionIds], ['state', states]]) {
    if (entries !== undefined) {
      if (!Array.isArray(entries)) throw new Error(`Invalid ${key} filter.`);
      clauses.push(`json_extract(data,'$.${key}') IN (SELECT value FROM json_each(?))`); values.push(JSON.stringify(entries));
    }
  }
  let sql = `SELECT data FROM records WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC,id`;
  if (limit !== undefined) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid record limit.');
    sql += ' LIMIT ?'; values.push(limit);
  }
  return database().prepare(sql).all(...values).map(row => JSON.parse(row.data));
}
export function removeRecord(kind, id) { database().prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind, id); }
export function appendEvent(sessionId, type, data = {}, db = database()) {
  const createdAt = now();
  const result = db.prepare('INSERT INTO events(session_id,type,data,created_at) VALUES (?,?,?,?)').run(sessionId, type, JSON.stringify(data), createdAt);
  const seq = Number(result.lastInsertRowid);
  return { version: 1, id: `${sessionId}:${seq}`, seq, sessionId, type, data, createdAt };
}
export function events(sessionId, after = 0, limit = 200) {
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid event cursor or limit.');
  return database().prepare('SELECT * FROM events WHERE session_id=? AND seq>? ORDER BY seq LIMIT ?').all(sessionId, after, limit)
    .map(row => ({ version: 1, id: `${row.session_id}:${row.seq}`, seq: row.seq, sessionId: row.session_id, type: row.type, data: JSON.parse(row.data), createdAt: row.created_at }));
}
// Backward pages use the same indexed immutable event log. The cursor is
// exclusive and envelopes are returned chronologically for client projection.
export function eventsBefore(sessionId, before = Number.MAX_SAFE_INTEGER, limit = 200) {
  if (!Number.isSafeInteger(before) || before < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid historical event cursor or limit.');
  return database().prepare('SELECT * FROM events WHERE session_id=? AND seq<? ORDER BY seq DESC LIMIT ?').all(sessionId, before, limit).reverse()
    .map(row => ({ version: 1, id: `${row.session_id}:${row.seq}`, seq: row.seq, sessionId: row.session_id, type: row.type, data: JSON.parse(row.data), createdAt: row.created_at }));
}
export function reserveRequest(scope, id, input, operation) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(id)) throw new Error('Supply a request ID of 1–128 letters, digits, _, ., : or -.');
  return transaction(db => {
    const hash = digest(input);
    const previous = db.prepare('SELECT * FROM requests WHERE scope=? AND id=?').get(scope, id);
    if (previous) {
      if (previous.digest !== hash) throw Object.assign(new Error('Idempotency conflict: request ID was already used for different input.'), { code: 'CONFLICT' });
      if (!previous.response) throw Object.assign(new Error('The earlier request has an uncertain result. Inspect its saved state before retrying.'), { code: 'UNCERTAIN' });
      return JSON.parse(previous.response);
    }
    db.prepare('INSERT INTO requests VALUES (?,?,?,?,?,?)').run(scope, id, hash, null, 'reserved', now());
    const response = operation(db);
    db.prepare('UPDATE requests SET response=?,state=? WHERE scope=? AND id=?').run(JSON.stringify(response), 'recorded', scope, id);
    return response;
  });
}
