import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { home, privateDir, readJson, writeJson } from './files.js';
import { getRecord, putRecord, listRecords, appendEvent, transaction } from './database.js';
import { processIdentity, identityAlive } from './process-identity.js';
import { goalEvent } from './lifecycle.js';
import { destinationSnapshot } from './notification-registry.js';
import { goalValidationFor } from './goal-validation.js';
export { home, privateDir, readJson, writeJson } from './files.js';

export function normalizeSessionAlias(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80 || /[\x00-\x1f\x7f-\x9f]/u.test(value)) {
    throw new Error('Use a session alias of 1–80 characters without control characters.');
  }
  return value.trim();
}

export function sessionPath(id) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid session ID.');
  return path.join(home(), 'sessions', `${id}.json`);
}

export function saveSession(session) {
  session.updatedAt = new Date().toISOString();
  let durable;
  transaction(db => {
    if (sessionDeleted(session.id)) throw Object.assign(new Error('This chat was deleted.'), { code: 'SESSION_DELETED', status: 404 });
    const previous = getRecord('session', session.id);
    // A running agent may save an older snapshot after the user renames its chat.
    if (previous && Object.hasOwn(previous, 'alias')) session.alias = previous.alias;
    if (['running', 'verifying', 'waiting_for_input'].includes(session.executionState)) {
      const pending = listRecords('question', { sessionId: session.id, state: 'pending', limit: 1 }).length > 0;
      if (pending) session.executionState = 'waiting_for_input';
      else if (session.executionState === 'waiting_for_input') session.executionState = previous?.executionState === 'waiting_for_input' ? 'running' : previous?.executionState || 'running';
    }
    durable = Object.fromEntries(Object.keys(session).filter(key => key !== 'goalValidation').map(key => [key, session[key]]));
    putRecord('session', session.id, durable, db);
    recordSessionLifecycle(durable, previous, db);
  });
  // Compatibility export. SQLite is authoritative; a stale export is recoverable.
  writeJson(sessionPath(session.id), durable);
}

// Called inside the same transaction as a saved lifecycle transition.
export function recordSessionLifecycle(session, previous, db) {
  if (session.alias?.trim() && !session.parentSessionId && (!session.purpose || session.purpose === 'terminal') &&
    (!previous || previous.executionState !== session.executionState || previous.goal?.status !== session.goal?.status || previous.goal?.reason !== session.goal?.reason)) {
    putRecord('terminal-catalog', 'current', { revision: randomUUID(), updatedAt: session.updatedAt }, db);
  }
  const before = previous?.goal;
  if (session.goal?.status !== before?.status || session.executionState !== previous?.executionState || !previous) {
    appendEvent(session.id, 'lifecycle', { status: session.goal?.status || null, executionState: session.executionState || 'idle', reason: session.goal?.reason || null }, db);
  }
  const event = goalEvent(session);
  if (event && !session.deferTerminalNotification) {
    const key = `${event.sessionId}-${event.goalId}-${event.epoch}-${event.type}`;
    if (!getRecord('goal-event', key)) {
      putRecord('goal-event', key, event, db);
      appendEvent(session.id, event.type, event, db);
      if (!session.suppressNotifications) putRecord('outbox', key, { event, deliveries: destinationSnapshot(readJson(path.join(home(), 'config.json'), {})) }, db);
    }
  }
}

export const sessionDeleted = id => typeof id === 'string' && Boolean(getRecord('session-deletion', id));
export function loadSession(id) {
  if (sessionDeleted(id)) return null;
  const session = getRecord('session', id) || readJson(sessionPath(id), null);
  if (!session) return null;
  delete session.goalValidation;
  const validation = goalValidationFor(session);
  if (validation.state !== 'none') session.goalValidation = validation;
  return session;
}

export function createSession(provider, cwd, model, alias) {
  const session = {
    version: 1, id: randomUUID(), provider: provider.id,
    backend: provider.backend, cwd: fs.realpathSync(cwd), model: model || provider.model || null,
    engineThreadId: null, createdAt: new Date().toISOString(), turns: 0, goal: null, executionState: 'idle',
    ...(alias == null ? {} : { alias: normalizeSessionAlias(alias) }),
  };
  saveSession(session);
  return session;
}

export function sessions(cwd) {
  const dir = path.join(home(), 'sessions');
  if (fs.existsSync(dir)) for (const file of fs.readdirSync(dir).filter(file => /^[a-f0-9-]{36}\.json$/.test(file))) {
    const id = file.slice(0, -5);
    if (!sessionDeleted(id) && !getRecord('session', id)) putRecord('session', id, readJson(path.join(dir, file)));
  }
  return listRecords('session').filter(s => !sessionDeleted(s.id) && (!cwd || s.cwd === cwd)).sort((a, b) => (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || ''));
}

export function setSessionAlias(id, value, authorize) {
  const alias = normalizeSessionAlias(value);
  const session = transaction(db => {
    authorize?.();
    const current = loadSession(id);
    if (!current) throw new Error('No matching session. Run bzzy sessions.');
    const previousAlias = current.alias || null;
    current.alias = alias; current.updatedAt = new Date().toISOString();
    putRecord('session', id, current, db);
    appendEvent(id, 'session.alias', { alias, previousAlias }, db);
    return current;
  });
  writeJson(sessionPath(id), session);
  return session;
}

export function findSession(id, cwd) {
  const all = sessions(id ? undefined : cwd);
  let matches = all.slice(0, 1);
  if (id) {
    matches = all.filter(s => s.id === id);
    if (!matches.length) matches = all.filter(s => s.alias === id);
    if (!matches.length) matches = all.filter(s => s.id.startsWith(id));
  }
  if (matches.length !== 1) throw Object.assign(new Error(matches.length ? 'Session name or prefix is ambiguous. Use the session ID.' : 'No matching session. Run bzzy sessions.'),
    { code: matches.length ? 'SESSION_AMBIGUOUS' : 'SESSION_NOT_FOUND' });
  return matches[0];
}

export function lockSession(session) {
  return lockFile(`${sessionPath(session.id)}.lock`, 'This session is already running in another bzzy process.');
}

export function lockOwner(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    try { return JSON.parse(text).identity; } catch { return { pid: Number(text.split(':')[0]), start: 'platform-unverified' }; }
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export function lockFile(file, busyMessage = 'This resource is already in use.') {
  privateDir(path.dirname(file));
  const identity = processIdentity();
  if (!identity) throw new Error(`Cannot establish process identity for lock: ${file}`);
  const owner = JSON.stringify({ identity, nonce: randomUUID() });
  const temporary = `${file}.${randomUUID()}.tmp`;
  // Publish a complete lock atomically: contenders never observe an empty new lock.
  fs.writeFileSync(temporary, owner, { mode: 0o600, flag: 'wx' });
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        fs.linkSync(temporary, file);
        return () => {
          try { if (fs.readFileSync(file, 'utf8') === owner) fs.unlinkSync(file); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
        };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let stat, contents;
        try { stat = fs.statSync(file); contents = fs.readFileSync(file, 'utf8'); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        let identity;
        try { identity = JSON.parse(contents).identity; } catch { identity = { pid: Number(contents.split(':')[0]), start: 'platform-unverified' }; }
        let alive = identityAlive(identity);
        if (!alive && Number.isSafeInteger(identity?.pid) && identity.pid > 0) {
          // EPERM means a live process belonging to another user, not a stale lock.
          try { process.kill(identity.pid, 0); }
          catch (error) { if (error.code === 'EPERM') alive = true; }
        }
        const malformed = !Number.isSafeInteger(identity?.pid) || identity.pid < 1 || !identity.start;
        if (!alive && (!malformed || Date.now() - stat.mtimeMs > 5000)) {
          try {
            const latest = fs.statSync(file);
            if (latest.ino === stat.ino && latest.dev === stat.dev && fs.readFileSync(file, 'utf8') === contents) fs.unlinkSync(file);
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
          continue;
        }
        throw Object.assign(new Error(`${busyMessage} Lock: ${file}`), { code: 'BZZY_LOCKED' });
      }
    }
    throw new Error(`Could not acquire lock: ${file}`);
  } finally { fs.rmSync(temporary, { force: true }); }
}
