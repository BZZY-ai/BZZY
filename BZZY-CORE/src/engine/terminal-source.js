import { database, listRecords } from './database.js';
import { loadSession, sessionDeleted } from './store.js';
import { createSourceObserver } from './source-preview.js';

// Owner-local compatibility projection for terminals attaching to older runners.
// Read native command/edit input, never stdout, inferred paths or reasoning.
// Nothing is executed, persisted, or presented as historical file bytes.
export function createTerminalSourceProjection(sessionId, emit) {
  const observers = new Map(), cursors = new Map(), restoredCommandCursors = new Map();
  const eligible = session => session && !session.agentId && !session.importedUntrusted && !sessionDeleted(session.id);
  function scoped(id) {
    const session = loadSession(id);
    if (!eligible(session)) return null;
    let ancestor = session;
    for (let depth = 0; depth < 16 && eligible(ancestor); depth++) {
      if (ancestor.id === sessionId) return session;
      if (!ancestor.parentSessionId) break;
      ancestor = loadSession(ancestor.parentSessionId);
    }
    return null;
  }
  function observer(session) {
    if (!observers.has(session.id)) {
      if (observers.size >= 32) observers.delete(observers.keys().next().value);
      const entry = {};
      entry.project = createSourceObserver(session, (type, data) => {
        if (type === 'command.observed') return;
        if (entry.restored) entry.restored.push({ type, seq: entry.seq, data: { ...data,
          observedAt: entry.observedAt || data.observedAt,
          phase: data.sourceKind === 'command' ? 'recorded' : 'observed',
          provenance: data.sourceKind === 'command' ? data.provenance : 'current-file-from-recorded-edit-or-launch' } });
        else emit(type, data);
      });
      entry.commands = createSourceObserver(session, (type, data) => {
        if (entry.restoredCommands) entry.restoredCommands.push({ type, seq: entry.seq, data });
        else emit(type, data);
      }, { commandsOnly: true });
      observers.set(session.id, entry);
    }
    return observers.get(session.id);
  }
  function recent(id, restored = false, after = 0) {
    const session = scoped(id), result = [];
    if (!session) return result;
    const rows = database().prepare(`SELECT seq,data,created_at FROM events WHERE session_id=? AND type='backend' AND seq>?
      AND json_extract(data,'$.method') IN ('item/started','item/completed','tool.started','tool.completed')
      AND length(data)<=1048576 ORDER BY seq DESC LIMIT 48`).all(id, Math.max(cursors.get(id) || 0, after)).reverse();
    const entry = observer(session); entry.restored = restored ? result : null; entry.restoredCommands = restored ? result : null;
    try { for (const row of rows) { entry.seq = row.seq; entry.observedAt = row.created_at; const data = { ...JSON.parse(row.data), occurredAt: row.created_at }; entry.commands(data); entry.project(data); } }
    finally { entry.restored = null; entry.restoredCommands = null; }
    if (rows.length) cursors.set(id, rows.at(-1).seq);
    return result;
  }
  return {
    restore() {
      const root = scoped(sessionId);
      if (!root) return;
      const ids = [root.id], rows = [];
      // Bound both ancestry and event work for very large saved chats.
      for (let i = 0; i < ids.length && ids.length < 17; i++) {
        for (const child of listRecords('session', { parentSessionId: ids[i], limit: 16 })) {
          if (ids.length >= 17) break;
          if (eligible(child) && !ids.includes(child.id)) ids.push(child.id);
        }
      }
      for (const id of ids) {
        // Exact captured bytes take priority; only fill newer native activity.
        const last = database().prepare("SELECT seq FROM events WHERE session_id=? AND type IN ('source.changed','source.delta') ORDER BY seq DESC LIMIT 1").get(id);
        rows.push(...recent(id, true, last?.seq || 0));
        // Older runners did not persist command observations. Recover only
        // their real native input; this path does not read or rewrite files.
        if (!database().prepare("SELECT 1 FROM events WHERE session_id=? AND type='command.observed' LIMIT 1").get(id)) {
          const entry = observer(scoped(id)); entry.restoredCommands = rows;
          try {
          const native = database().prepare(`SELECT seq,data,created_at FROM events WHERE session_id=? AND type='backend' AND seq>?
            AND json_extract(data,'$.method') IN ('item/started','item/completed','tool.started','tool.completed')
            AND length(data)<=1048576 ORDER BY seq DESC LIMIT 48`).all(id, restoredCommandCursors.get(id) || 0).reverse();
          for (const row of native) {
            entry.seq = row.seq; entry.commands({ ...JSON.parse(row.data), occurredAt: row.created_at });
          }
          if (native.length) restoredCommandCursors.set(id, native.at(-1).seq);
          } finally { entry.restoredCommands = null; }
        }
      }
      const seen = new Set();
      for (const row of rows.sort((a, b) => a.seq - b.seq)) {
        const key = row.type === 'command.observed' ? `${row.data.actorSessionId}:${row.seq}` : null;
        if (key && seen.has(key)) continue;
        if (key) seen.add(key);
        emit(row.type, row.data);
      }
    },
    event(type, data) {
      if (type === 'backend') {
        if (!['item/started', 'item/completed', 'tool.started', 'tool.completed'].includes(data.method)) return;
        const session = scoped(data.actorSessionId || sessionId);
        if (session) { const entry = observer(session); entry.commands(data); entry.project(data); }
      } else if (type === 'worker.tool' && typeof data.workerSessionId === 'string') recent(data.workerSessionId);
    },
  };
}
