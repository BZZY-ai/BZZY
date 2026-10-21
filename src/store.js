import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { home, privateDir, readJson, writeJson } from './files.js';
import { getRecord, putRecord, listRecords, appendEvent, transaction } from './database.js';
import { goalEvent } from './lifecycle.js';
import { destinationSnapshot } from './notification-registry.js';
export { home, privateDir, readJson, writeJson } from './files.js';

export function sessionPath(id) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid session ID.');
  return path.join(home(), 'sessions', `${id}.json`);
}

export function saveSession(session) {
  session.updatedAt = new Date().toISOString();
  transaction(db => {
    const previous = getRecord('session', session.id);
    putRecord('session', session.id, session, db);
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
  });
  // Compatibility export. SQLite is authoritative; a stale export is recoverable.
  writeJson(sessionPath(session.id), session);
}

export function loadSession(id) { return getRecord('session', id) || readJson(sessionPath(id), null); }

export function createSession(provider, cwd, model) {
  const session = {
    version: 1, id: randomUUID(), provider: provider.id,
    backend: provider.backend, cwd: fs.realpathSync(cwd), model: model || provider.model || null,
    engineThreadId: null, createdAt: new Date().toISOString(), turns: 0, goal: null, executionState: 'idle',
  };
  saveSession(session);
  return session;
}

export function sessions(cwd) {
  const dir = path.join(home(), 'sessions');
  if (fs.existsSync(dir)) for (const file of fs.readdirSync(dir).filter(file => /^[a-f0-9-]{36}\.json$/.test(file))) {
    const id = file.slice(0, -5);
    if (!getRecord('session', id)) putRecord('session', id, readJson(path.join(dir, file)));
  }
  return listRecords('session').filter(s => !cwd || s.cwd === cwd).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function findSession(id, cwd) {
  const all = sessions(id ? undefined : cwd);
  const matches = id ? all.filter(s => s.id.startsWith(id)) : all.slice(0, 1);
  if (matches.length !== 1) throw new Error(matches.length ? 'Session prefix is ambiguous.' : 'No matching session. Run bzzy sessions.');
  return matches[0];
}

export function lockSession(session) {
  return lockFile(`${sessionPath(session.id)}.lock`, 'This session is already running in another bzzy process.');
}

export function lockFile(file, busyMessage = 'This resource is already in use.') {
  privateDir(path.dirname(file));
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      const owner = `${process.pid}:${randomUUID()}`;
      fs.writeFileSync(fd, owner);
      fs.closeSync(fd);
      return () => {
        try { if (fs.readFileSync(file, 'utf8') === owner) fs.unlinkSync(file); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = fs.readFileSync(file, 'utf8');
      const pid = Number(owner.split(':')[0]);
      if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid session lock. Inspect it before removing it.');
      try { process.kill(pid, 0); }
      catch (err) {
        if (err.code === 'ESRCH') { fs.rmSync(file, { force: true }); continue; }
        throw err;
      }
      const busy = new Error(busyMessage);
      busy.code = 'BZZY_LOCKED';
      throw busy;
    }
  }
  throw new Error('Could not acquire session lock.');
}
