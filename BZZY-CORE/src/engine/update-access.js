import { getRecord, listRecords, digest } from './database.js';
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
// Root group admission does not grant direct access to worker sessions. Core
// remains the coordinator; the existing device token keeps includeChildren:false.
export function authorizedOwnPhoneTerminalInput(access, session) {
  if (!session || session.parentSessionId || session.purpose && session.purpose !== 'terminal') return false;
  const binding = [...listRecords('core.relay.grant'), ...listRecords('core.relay.context')].find(row =>
    row.coreGrantId === access.id && row.sessionId === session.id && !row.revokedAt && row.expiresAt > Date.now());
  const parent = binding && authorizedUpdateGrant(binding.relayGrantId || binding.id);
  return Boolean(parent && binding.kind !== 'agent' && binding.peerId === parent.peerId && binding.hostId === parent.hostId &&
    binding.relayUrl === parent.relayUrl && binding.expiresAt <= parent.expiresAt);
}
export const updateDeviceKey = row => digest({ host: row.hostId, peer: row.peerId, grant: row.id });
export function updateDevicePreferences(row) {
  return getRecord('core.update.device', updateDeviceKey(row)) || { notificationsEnabled: true, remoteUpdatesEnabled: false };
}
