import { getRecord, listRecords, putRecord, revokeSessionAccess, appendEvent, now } from '../engine.js';
import { opaque, fail } from '../validation.js';
import { loadRelayIdentity } from './identity.js';

// Host-only administrative entry point. Local denial is durable before any
// network attempt; the running gateway drains the idempotent Relay revocation.
export function revokeLocalRelayGrant(id, { hostId = loadRelayIdentity().certificate.id, relayUrl } = {}) {
  opaque(id);
  const row = getRecord('core.relay.grant', id);
  if (!row || row.hostId !== hostId || relayUrl && row.relayUrl !== relayUrl) fail('FORBIDDEN', 'Unknown local gateway grant.', 403);
  putRecord('core.relay.grant', id, { ...row, revokedAt: row.revokedAt || now() });
  revokeSessionAccess(row.coreGrantId);
  for (const child of listRecords('core.relay.context').filter(item => item.relayGrantId === id && item.hostId === hostId && item.relayUrl === row.relayUrl)) {
    putRecord('core.relay.context', child.resource, { ...child, revokedAt: child.revokedAt || now() });
    revokeSessionAccess(child.coreGrantId);
  }
  for (const registration of listRecords('core.push.registration').filter(item => item.relayGrantId === id && item.hostId === hostId && item.relayUrl === row.relayUrl)) {
    const { deviceToken: ignored, ...metadata } = registration;
    putRecord('core.push.registration', registration.id, { ...metadata, enabled: false, revokedAt: registration.revokedAt || now(), updatedAt: now() });
  }
  const previous = getRecord('core.relay.revocation', id);
  if (!previous) putRecord('core.relay.revocation', id, { id, hostId, relayUrl: row.relayUrl, state: 'pending', attempts: 0, nextAttemptAt: 0 });
  appendEvent(row.sessionId, 'relay.authorization', { decision: 'revoked', provenance: 'host-policy' });
  return { revoked: true, relayRevocation: previous?.state === 'complete' ? 'complete' : 'pending' };
}
