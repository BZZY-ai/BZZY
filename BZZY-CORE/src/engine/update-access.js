import { getRecord, digest } from './database.js';
import { activeAccess, sessionPermissions } from './session-access.js';
import { fail } from '../validation.js';

// Host-wide installation controls are restricted to the approved own-phone
// base grant. Session/friend/Agent contexts cannot acquire host administration.
export function authorizedUpdateGrant(id) {
  const row = getRecord('core.relay.grant', id), pin = row && getRecord('core.relay.pin', row.peerId);
  const access = row?.token && getRecord('access-token', digest(row.token));
  return row && !row.relayGrantId && !row.revokedAt && row.expiresAt > Date.now()
    && row.sessionAccess === true && row.agentAccess === true && row.shareAccess === true
    && sessionPermissions.every(permission => row.permissions?.includes(permission))
    && pin && !pin.revokedAt && pin.hostId === row.hostId && digest(pin.certificate) === row.peerDigest
    && activeAccess(access) && access.id === row.coreGrantId && access.sessionId === row.sessionId
    && access.includeChildren === false && sessionPermissions.every(permission => access.permissions?.includes(permission)) ? row : null;
}
export function requireUpdateGrant(row) {
  const current = row && authorizedUpdateGrant(row.id);
  if (!current || row.relayGrantId || current.resource !== row.resource || current.peerId !== row.peerId || current.hostId !== row.hostId) fail('FORBIDDEN', 'Host updates require the fully approved own-phone pairing.', 403);
  return current;
}
export const updateDeviceKey = row => digest({ host: row.hostId, peer: row.peerId, grant: row.id });
export function updateDevicePreferences(row) {
  return getRecord('core.update.device', updateDeviceKey(row)) || { notificationsEnabled: true, remoteUpdatesEnabled: false };
}
