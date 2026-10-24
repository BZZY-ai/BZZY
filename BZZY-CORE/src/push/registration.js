import { getRecord, putRecord, listRecords, digest, now } from '../engine/database.js';
import { activeAccess } from '../engine/session-access.js';
import { loadSession, sessionDeleted } from '../engine/store.js';
import { terminalSession } from '../relay/terminal-catalog.js';
import { object, fail } from '../validation.js';
import { loadAPNsConfiguration, deviceToken } from './apns.js';
import { CoreAgents } from '../agents.js';

const alive = row => row && !row.revokedAt && row.expiresAt > Date.now();
const currentAccess = row => {
  const access = getRecord('access-token', digest(row.token));
  return activeAccess(access) && access.id === row.coreGrantId && access.sessionId === row.sessionId && access.includeChildren === false && access.permissions?.includes('observe');
};
function agentSession(sessionId, expectedAgentId) {
  const session = loadSession(sessionId);
  if (session?.purpose !== 'agent' || typeof session.agentId !== 'string' || expectedAgentId && session.agentId !== expectedAgentId) return false;
  try { const agent = new CoreAgents().get(session.agentId); return !agent.archived && agent.sessionId === sessionId; }
  catch { return false; }
}

export function authorizedPushRegistration(registration, eventSessionId) {
  if (eventSessionId && sessionDeleted(eventSessionId)) return false;
  if (!['session', 'terminals', 'authorized'].includes(registration.scope)) return false;
  const parent = getRecord('core.relay.grant', registration.relayGrantId), pin = parent && getRecord('core.relay.pin', parent.peerId);
  if (!alive(parent) || !pin || pin.revokedAt || parent.peerId !== registration.peerId || parent.hostId !== registration.hostId ||
    parent.relayUrl !== registration.relayUrl || pin.hostId !== parent.hostId || digest(pin.certificate) !== parent.peerDigest || !currentAccess(parent)) return false;
  if (registration.scope === 'terminals') return parent.resource === registration.resource && parent.sessionId === registration.sessionId &&
    parent.sessionAccess === true && (!eventSessionId || terminalSession(loadSession(eventSessionId)));
  if (registration.scope === 'authorized') {
    if (parent.resource !== registration.resource || parent.sessionId !== registration.sessionId || parent.sessionAccess !== true && parent.agentAccess !== true) return false;
    if (!eventSessionId || eventSessionId === parent.sessionId) return true;
    return parent.sessionAccess === true && terminalSession(loadSession(eventSessionId)) || parent.agentAccess === true && agentSession(eventSessionId);
  }
  let selected = parent;
  if (registration.resource !== parent.resource) {
    selected = getRecord('core.relay.context', registration.resource);
    if (!alive(selected) || selected.relayGrantId !== parent.id || selected.peerId !== parent.peerId ||
      selected.hostId !== parent.hostId || selected.relayUrl !== parent.relayUrl || selected.peerDigest !== parent.peerDigest ||
      selected.expiresAt > parent.expiresAt || !currentAccess(selected)) return false;
    if (selected.kind === 'agent') {
      if (parent.agentAccess !== true || !agentSession(selected.sessionId, selected.agentId)) return false;
    } else if (parent.sessionAccess !== true || !terminalSession(loadSession(selected.sessionId))) return false;
  }
  return selected.sessionId === registration.sessionId && (!eventSessionId || eventSessionId === registration.sessionId);
}

const idFor = row => digest({ host: row.hostId, peer: row.peerId, grant: row.id, resource: row.resource });
const publicState = row => {
  const configuration = loadAPNsConfiguration();
  return { registered: Boolean(row && !row.revokedAt), enabled: Boolean(row && !row.revokedAt && row.enabled),
    providerConfigured: Boolean(configuration && configuration.environment === row?.environment), scope: row?.scope || 'session' };
};

export function registerDeviceNotifications(row, params) {
  object(params, ['deviceToken', 'environment', 'enabled', 'scope'], 'Notification registration');
  if (typeof params.enabled !== 'boolean' || !['sandbox', 'production'].includes(params.environment) ||
    params.scope !== undefined && !['session', 'terminals', 'authorized'].includes(params.scope)) fail('INVALID_REQUEST', 'Use a valid notification registration.');
  let token;
  try { token = deviceToken(params.deviceToken); } catch { fail('INVALID_REQUEST', 'Use a valid notification registration.'); }
  const id = idFor(row), tokenDigest = digest(token), scope = params.scope || 'session';
  const existing = getRecord('core.push.registration', id);
  const preserveWindow = existing && !existing.revokedAt && existing.enabled && params.enabled && existing.tokenDigest === tokenDigest &&
    existing.scope === scope && existing.environment === params.environment;
  const registration = { id, hostId: row.hostId, peerId: row.peerId, relayGrantId: row.id, relayUrl: row.relayUrl,
    resource: row.resource, sessionId: row.sessionId, scope, deviceToken: token, tokenDigest, environment: params.environment,
    enabled: params.enabled, registeredAt: Date.now(), enabledSince: preserveWindow ? existing.enabledSince : Date.now(), updatedAt: now() };
  if (!authorizedPushRegistration(registration)) fail('FORBIDDEN', 'Notification registration is outside this grant.', 403);
  const registrations = listRecords('core.push.registration');
  if (registrations.some(item => !item.revokedAt && item.hostId === row.hostId && item.tokenDigest === tokenDigest && item.peerId !== row.peerId && authorizedPushRegistration(item))) fail('FORBIDDEN', 'This push registration is unavailable.', 403);
  if (!getRecord('core.push.registration', id) && registrations.filter(item => !item.revokedAt && authorizedPushRegistration(item)).length >= 256) fail('CAPACITY', 'Notification registration capacity reached.');
  putRecord('core.push.registration', id, registration);
  return publicState(registration);
}
export function updateDeviceNotifications(row, params) {
  object(params, ['enabled'], 'Notification preference');
  if (typeof params.enabled !== 'boolean') fail('INVALID_REQUEST', 'Use a boolean notification preference.');
  const saved = getRecord('core.push.registration', idFor(row));
  if (!saved || saved.revokedAt || !authorizedPushRegistration(saved)) fail('FORBIDDEN', 'Notification registration is unavailable.', 403);
  const updated = { ...saved, enabled: params.enabled, ...(params.enabled && !saved.enabled ? { enabledSince: Date.now() } : {}), updatedAt: now() };
  putRecord('core.push.registration', saved.id, updated); return publicState(updated);
}
export function revokeDeviceNotifications(row, params) {
  object(params, [], 'Notification removal');
  const saved = getRecord('core.push.registration', idFor(row));
  if (saved) {
    const { deviceToken: ignored, ...metadata } = saved;
    putRecord('core.push.registration', saved.id, { ...metadata, enabled: false, revokedAt: now(), updatedAt: now() });
  }
  return { revoked: true };
}
