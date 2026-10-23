import { fail, object, opaque } from '../validation.js';

export const PROTOCOL = 'bzzy-core';
export const VERSION = 1;
export const LIMITS = Object.freeze({ payloadBytes: 28 * 1024, promptBytes: 16 * 1024, pageLimit: 50,
  grants: 128, pendingPairings: 32, subscriptions: 16, subscriptionsPerPeer: 4,
  requests: 16, requestsPerPeer: 4, requestsPerMinute: 60, metricsPerMinute: 30, acknowledgmentsPerMinute: 240, ackTimeoutMs: 30000 });

const fields = Object.freeze({
  'updates.status': [], 'updates.check': [], 'updates.configure': ['monitoringEnabled', 'notificationsEnabled', 'remoteUpdatesEnabled'], 'updates.install': ['target'],
  'session.get': [], 'session.usage': [], 'host.metrics': [],
  'notifications.register': ['deviceToken', 'environment', 'enabled', 'scope'],
  'notifications.update': ['enabled'], 'notifications.revoke': [],
  'sessions.list': ['after', 'limit'], 'sessions.open': ['sessionId'],
  'agents.status': [], 'agents.providers': [], 'agents.models': ['provider', 'after', 'limit'], 'agents.list': ['after', 'limit'],
  'agents.get': ['agentId'], 'agents.create': ['name', 'instructions', 'provider', 'model', 'effort'],
  'agents.update': ['agentId', 'expectedRevision', 'name', 'instructions', 'provider', 'model', 'effort'],
  'agents.archive': ['agentId', 'expectedRevision'], 'agents.open': ['agentId'],
  'agents.import': ['code', 'expectedSenderFingerprint', 'provider', 'model', 'effort', 'name'],
  'agents.import.status': ['importId'], 'agents.import.cancel': ['importId'],
  'share.create': [], 'share.status': ['shareId'], 'share.approve': ['shareId', 'claimId', 'confirmedFingerprint'], 'share.revoke': ['shareId'],
  'assistant.status': [], 'task.submit': ['owner', 'instruction'], 'task.get': ['taskId'],
  'events.list': ['after', 'limit'], 'events.subscribe': ['consumerId'],
  'events.ack': ['subscriptionId', 'seq'], 'events.unsubscribe': ['subscriptionId'],
  'input.claim': ['owner', 'takeover'], 'input.release': ['owner'],
  'execution.execute': ['owner', 'prompt', 'goal', 'resumeGoal'],
  'question.answer': ['owner', 'questionId', 'answer'],
  'control.request': ['owner', 'action', 'text'], 'command.status': ['requestId'],
});
export const COMMANDS = new Set(['updates.configure', 'updates.install', 'execution.execute', 'task.submit', 'question.answer', 'control.request', 'sessions.open', 'share.create', 'share.approve', 'share.revoke',
  'agents.create', 'agents.update', 'agents.archive', 'agents.open', 'agents.import', 'agents.import.cancel']);
export const OPERATIONS = Object.freeze(Object.keys(fields));

export function boundedInteger(value, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail('INVALID_REQUEST', 'Invalid integer bound.');
  return value;
}

export function validateRequest(value) {
  if (Buffer.byteLength(JSON.stringify(value) ?? '') > LIMITS.payloadBytes) fail('REQUEST_TOO_LARGE', 'Request exceeds the Core payload limit.');
  object(value, ['v', 'protocol', 'type', 'id', 'resource', 'op', 'params'], 'Core request');
  if (value.v !== VERSION || value.protocol !== PROTOCOL || value.type !== 'request') fail('PROTOCOL_UNSUPPORTED', 'Unsupported Core protocol.');
  opaque(value.id); opaque(value.resource);
  if (!Object.hasOwn(fields, value.op)) fail('OPERATION_DENIED', 'This operation is not exposed by the gateway.', 403);
  object(value.params, fields[value.op], 'Operation parameters');
  return value;
}

export function permissionFor(request) {
  if (['updates.install', 'updates.configure'].includes(request.op)) return 'execute';
  if (request.op === 'input.claim') return request.params.takeover === true ? 'takeover' : 'claim';
  if (request.op === 'input.release') return 'claim';
  if (['execution.execute', 'task.submit'].includes(request.op)) return 'execute';
  if (request.op === 'question.answer') return 'answer';
  if (request.op === 'control.request') {
    if (!['pause', 'cancel', 'steer'].includes(request.params.action)) fail('INVALID_REQUEST', 'Unknown control action.');
    return request.params.action;
  }
  return 'observe';
}

export function response(id, result) { return { v: VERSION, protocol: PROTOCOL, type: 'response', id, ok: true, result }; }
export function errorResponse(id, code) { return { v: VERSION, protocol: PROTOCOL, type: 'response', id, ok: false, error: { code } }; }

const secretField = /^(?:token|deviceToken|accessToken|refreshToken|ownerToken|apiKey|signingSecret|boxSecret|password|authorization|cookie|set-cookie|credentials|environment|backendHomes|engineThreadId|backendProcess)$/i;
export function sanitize(value, secrets = [], depth = 0) {
  if (depth > 40) fail('RESULT_TOO_LARGE', 'Result nesting exceeds the transport limit.');
  if (typeof value === 'string') {
    let result = value;
    for (const secret of secrets) if (typeof secret === 'string' && secret.length >= 8) result = result.replaceAll(secret, '[redacted]');
    return result.replace(/\bBearer\s+[^\s"<>]+|\bsk-[A-Za-z0-9_-]{12,}/gi, '[redacted]');
  }
  if (Array.isArray(value)) return value.map(item => sanitize(item, secrets, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, secretField.test(key) || /(?:API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|AUTH_TOKEN|SECRET|PASSWORD)$/.test(key) ? '[redacted]' : sanitize(child, secrets, depth + 1)]));
  return value;
}

export function boundedPayload(value) {
  if (Buffer.byteLength(JSON.stringify(value)) > LIMITS.payloadBytes) fail('RESULT_TOO_LARGE', 'Result needs a smaller page or a future chunked transfer.');
  return value;
}
