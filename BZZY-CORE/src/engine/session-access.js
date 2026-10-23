import { randomBytes, randomUUID } from 'node:crypto';
import { putRecord, listRecords, appendEvent, digest, now, transaction } from './database.js';
import { loadSession } from './store.js';

export const sessionPermissions = ['observe', 'claim', 'takeover', 'execute', 'answer', 'pause', 'cancel', 'steer'];
export const activeAccess = access => Boolean(access && !access.revokedAt && Number.isFinite(access.expiresAt) && access.expiresAt > Date.now());
export function accessAllows(access, sessionId) {
  if (!access?.sessionId) return false;
  let id = sessionId;
  for (let depth = 0; id && depth < 20; depth++) {
    if (id === access.sessionId) return true;
    if (access.includeChildren === false) return false;
    id = loadSession(id)?.parentSessionId;
  }
  return false;
}
export function publicAccess(access) {
  return { id: access.id, sessionId: access.sessionId, recipient: access.recipient || null, permissions: access.permissions,
    includeChildren: access.includeChildren !== false, expiresAt: access.expiresAt, createdAt: access.createdAt, revokedAt: access.revokedAt || null };
}
export function migrateSessionAccess() {
  // Keep existing observer capabilities valid, while making every legacy grant
  // discoverable and revocable without recovering its plaintext token.
  transaction(db => {
    for (const row of db.prepare("SELECT id,data FROM records WHERE kind='access-token' AND json_extract(data,'$.id') IS NULL").all()) {
      putRecord('access-token', row.id, { ...JSON.parse(row.data), id: randomUUID() }, db);
    }
  });
}
export function createSessionAccess({ sessionId, permissions = ['observe'], recipient, expiresInSeconds = 86400, includeChildren = true }) {
  if (typeof sessionId !== 'string' || !/^[a-f0-9-]{36}$/.test(sessionId) || !loadSession(sessionId)) throw new Error('Session token needs an existing session ID.');
  if (!Array.isArray(permissions) || !permissions.length || new Set(permissions).size !== permissions.length || permissions.some(p => !sessionPermissions.includes(p)) || !permissions.includes('observe')) throw new Error('Choose explicit session permissions including observe.');
  if (permissions.some(p => p !== 'observe' && p !== 'claim') && !permissions.includes('claim')) throw new Error('Session control requires the claim permission.');
  if (!Number.isSafeInteger(expiresInSeconds) || expiresInSeconds < 60 || expiresInSeconds > 30 * 86400) throw new Error('Token lifetime must be 60–2592000 seconds.');
  if (typeof includeChildren !== 'boolean') throw new Error('includeChildren must be a boolean.');
  if (recipient !== undefined && (typeof recipient !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(recipient))) throw new Error('Use an opaque recipient ID of 1–80 letters, digits, _ or -.');
  if (permissions.length > 1 && !recipient) throw new Error('A control grant needs an explicit recipient ID.');
  const token = randomBytes(32).toString('base64url'), access = { id: randomUUID(), sessionId, recipient, permissions, includeChildren, expiresAt: Date.now() + expiresInSeconds * 1000, createdAt: now() };
  transaction(db => { putRecord('access-token', digest(token), access, db); appendEvent(sessionId, 'access.granted', publicAccess(access), db); });
  return { token, ...publicAccess(access) };
}
export function revokeSessionAccess(id) {
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('Use the grant ID returned when the token was created.');
  return transaction(db => {
    const row = db.prepare("SELECT id,data FROM records WHERE kind='access-token' AND json_extract(data,'$.id')=?").get(id);
    if (!row) throw Object.assign(new Error('Unknown session grant.'), { status: 404 });
    const access = JSON.parse(row.data);
    if (!access.revokedAt) { access.revokedAt = now(); putRecord('access-token', row.id, access, db); appendEvent(access.sessionId, 'access.revoked', publicAccess(access), db); }
    return publicAccess(access);
  });
}
export function accessPrincipalActive(principal) {
  return !principal?.startsWith('grant:') || listRecords('access-token').some(access => `grant:${access.id}` === principal && activeAccess(access));
}
