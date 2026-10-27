import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { listRecords, getRecord, putRecord, appendEvent, reserveRequest, now } from './database.js';
import { loadSession, sessionPath, sessionDeleted, lockOwner } from './store.js';
import { identityAlive } from './process-identity.js';

const reject = (message, code, status = 409) => { throw Object.assign(new Error(message), { code, status }); };
const derivedRuntimeKinds = ['native-compaction', 'core.conversation.source', 'core.conversation.pending',
  'core.history.maintenance', 'core.task-state.read', 'core.checkpoint.scope', 'core.episode.progress', 'core.retrieval.vector', 'core.retrieval.metric'];
const retainedReceiptKinds = ['core.checkpoint.request', 'core.workflow.work-unit', 'core.workflow.consultation'];
const nativeRuntimeFields = ['nativeContext', 'nativeContextBudget', 'nativeBackendReadiness', 'contextEfficiency',
  'coreSkillsProtocol', 'sessionMemoryRefresh', 'sessionMemorySeen'];
export const terminalCatalogRevision = () => getRecord('terminal-catalog', 'current')?.revision || 'initial';

function assertInactive(session) {
  const active = listRecords('execution', { sessionId: session.id, states: ['queued', 'launching', 'running'], limit: 1 }).length;
  const run = getRecord('run', session.id);
  if (active || identityAlive(run?.runner) || identityAlive(run?.launcher) || identityAlive(session.backendProcess)
      || identityAlive(lockOwner(`${sessionPath(session.id)}.lock`))) {
    reject('Stop or pause this chat’s work before deleting it.', 'SESSION_BUSY');
  }
}

// Local-owner operation. Preserve evidence/execution/request audits, while a
// durable tombstone removes the conversation from user access and stops stale
// snapshots or compatibility exports from recreating it. Never touch the cwd.
export function deleteTerminalConversation(sessionId, { requestId } = {}) {
  if (typeof sessionId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(sessionId)) {
    reject('Choose a saved terminal chat.', 'INVALID_REQUEST', 400);
  }
  const result = reserveRequest('core:conversation:delete', requestId, { sessionId }, db => {
    const previous = getRecord('session-deletion', sessionId);
    if (previous) {
      if (previous.rootSessionId !== sessionId) reject('Only terminal chats can be deleted here.', 'FORBIDDEN', 403);
      return previous.receipt;
    }
    const root = loadSession(sessionId);
    if (!root) reject('This chat is unavailable.', 'SESSION_DELETED', 404);
    if (root.parentSessionId || root.canvasParentId || root.purpose && root.purpose !== 'terminal'
        || listRecords('core.agent').some(agent => agent.sessionId === sessionId)) {
      reject('Only terminal chats can be deleted here.', 'FORBIDDEN', 403);
    }
    const all = [...new Map([[root.id, root], ...listRecords('session').map(item => [item.id, item])]).values()], ids = new Set([sessionId]);
    const children = new Map(), pending = [sessionId];
    for (const item of all) {
      const canvas = item.canvasParentId && getRecord('terminal.canvas', item.canvasParentId);
      // Canvas ownership affects deletion only. It never broadens a phone or
      // observer grant's ordinary parent/child authorization scope.
      const canvasParent = canvas && [...canvas.nodes, ...(canvas.archivedNodes || [])].some(node => node.sessionId === item.id) ? canvas.id : null;
      const parent = item.parentSessionId || canvasParent;
      if (!parent) continue;
      const siblings = children.get(parent) || []; siblings.push(item.id); children.set(parent, siblings);
    }
    for (let index = 0; index < pending.length; index++) {
      for (const id of children.get(pending[index]) || []) if (!ids.has(id)) { ids.add(id); pending.push(id); }
    }
    const targets = all.filter(item => ids.has(item.id) && !sessionDeleted(item.id));
    for (const item of targets) assertInactive(item);
    const deletedAt = now(), receipt = { state: 'deleted', sessionId, deletedSessionIds: [...ids], deletedAt };
    const anchors = listRecords('core.relay.grant').filter(row => ids.has(row.sessionId) && !row.revokedAt
      && (row.sessionAccess === true || row.agentAccess === true));
    const anchorGrantIds = new Set(anchors.map(row => row.coreGrantId));
    for (const item of targets) {
      const event = appendEvent(item.id, 'session.deleted', { deletedAt, rootSessionId: sessionId }, db);
      putRecord('session-deletion', item.id, { sessionId: item.id, rootSessionId: sessionId, deletedAt, event,
        ...(item.id === sessionId ? { receipt } : {}) }, db);
      const inactive = { ...item, deletedAt, updatedAt: deletedAt };
      for (const field of nativeRuntimeFields) delete inactive[field];
      putRecord('session', item.id, inactive, db);
      db.prepare("DELETE FROM records WHERE kind='input-owner' AND id=?").run(item.id);
    }
    // Sequence cursors, pending streams and native dedup state cannot survive
    // deletion as runnable caches. Original events/checkpoint revisions remain.
    db.prepare(`DELETE FROM records WHERE kind IN (SELECT value FROM json_each(?)) AND
      (id IN (SELECT value FROM json_each(?)) OR json_extract(data,'$.sessionId') IN (SELECT value FROM json_each(?)))`)
      .run(JSON.stringify(derivedRuntimeKinds), JSON.stringify([...ids]), JSON.stringify([...ids]));
    // Retain request and routing provenance without an active execution view.
    for (const row of db.prepare(`SELECT kind,id,data FROM records WHERE kind IN (SELECT value FROM json_each(?)) AND
      json_extract(data,'$.sessionId') IN (SELECT value FROM json_each(?))`).all(JSON.stringify(retainedReceiptKinds), JSON.stringify([...ids]))) {
      putRecord(row.kind, row.id, { ...JSON.parse(row.data), deletedAt, executionDisabled: true }, db);
    }
    // A phone's base transport grant can anchor its catalog to a now-deleted
    // terminal. Keep that pairing; the gateway supplies only its deletion shell.
    for (const row of db.prepare("SELECT id,data FROM records WHERE kind='access-token'").all()) {
      const access = JSON.parse(row.data);
      if (ids.has(access.sessionId) && !anchorGrantIds.has(access.id)) putRecord('access-token', row.id, { ...access, revokedAt: access.revokedAt || deletedAt }, db);
    }
    for (const row of listRecords('core.relay.context')) if (ids.has(row.sessionId)) {
      putRecord('core.relay.context', row.resource, { ...row, revokedAt: row.revokedAt || deletedAt }, db);
    }
    for (const row of listRecords('core.relay.grant')) if (ids.has(row.sessionId) && !anchors.some(anchor => anchor.id === row.id)) {
      putRecord('core.relay.grant', row.id, { ...row, revokedAt: row.revokedAt || deletedAt }, db);
      if (!getRecord('core.relay.revocation', row.id)) putRecord('core.relay.revocation', row.id,
        { id: row.id, hostId: row.hostId, relayUrl: row.relayUrl, state: 'pending', attempts: 0, nextAttemptAt: 0 }, db);
    }
    putRecord('terminal-catalog', 'current', { revision: randomUUID(), updatedAt: deletedAt }, db);
    return receipt;
  });
  // SQLite denial is already durable even if an old compatibility file could
  // not be removed. Loading, migration and late writes all honor the tombstone.
  for (const id of result.deletedSessionIds) { try { fs.rmSync(sessionPath(id), { force: true }); } catch { /* Never undo a durable deletion. */ } }
  return result;
}
