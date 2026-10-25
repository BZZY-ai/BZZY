import { createHash, randomBytes } from 'node:crypto';

export const VERSION = 1;
export const LIMITS = Object.freeze({
  frameBytes: 64 * 1024, bufferedBytes: 256 * 1024, globalBufferedBytes: 8 * 1024 * 1024,
  connections: 64, connectionsPerIp: 32, ipBuckets: 256, attemptsPerMinute: 120,
  requestsPerMinute: 240, authTimeoutMs: 10000, heartbeatMs: 15000,
  transferRequestsPerMinute: 4096, maxPortableGrantTtlSeconds: 3600,
  pendingDeliveries: 1024, deliveryTimeoutMs: 15000, invitations: 512, grants: 512,
  devices: 256, inviteTtlSeconds: 600, maxInviteTtlSeconds: 3600, clockSkewMs: 5000,
  maxGrantTtlSeconds: 30 * 86400, replayEntries: 4096, messageTtlMs: 60000
});
export class RelayError extends Error {
  constructor(code) { super(code); this.code = code; }
}
export const fail = code => { throw new RelayError(code); };
export const random = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const hash = value => createHash('sha256').update(value).digest('base64url');
export function opaque(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value)) fail('INVALID_ID');
  return value;
}
export function b64(value, bytes) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) fail('INVALID_ENCODING');
  const result = Buffer.from(value, 'base64url');
  if (result.toString('base64url') !== value || (bytes !== undefined && result.length !== bytes)) fail('INVALID_ENCODING');
  return result;
}
export function integer(value, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail('INVALID_LIMIT');
  return value;
}
export function record(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) fail('INVALID_MESSAGE');
  return value;
}
export function relayUrl(value, allowInsecureLocal = false) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/v1/socket') fail('INVALID_RELAY_URL');
  if (url.protocol !== 'wss:' && !(allowInsecureLocal && url.protocol === 'ws:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))) fail('TLS_REQUIRED');
  return url.href;
}
export function inviteSpec(input, limits = LIMITS) {
  record(input, ['kind', 'mode', 'resource', 'actions', 'ttlSeconds', 'grantTtlSeconds']);
  const { kind, resource, mode = kind === 'PAIR' ? 'pair' : 'portable', actions = mode === 'portable' ? ['import'] : ['observe'],
    ttlSeconds = limits.inviteTtlSeconds, grantTtlSeconds = mode === 'portable' ? 300 : 86400 } = input;
  if (!['PAIR', 'AGENT', 'TERMINAL', 'LIBRARY'].includes(kind) || (kind === 'PAIR' ? mode !== 'pair' : kind === 'LIBRARY' ? mode !== 'portable' : !['portable', 'live'].includes(mode))) fail('INVALID_PURPOSE');
  opaque(resource);
  const allowed = mode === 'portable' ? ['import'] : ['observe', 'claim', 'takeover', 'execute', 'answer', 'pause', 'cancel', 'steer'];
  if (!Array.isArray(actions) || !actions.length || actions.length > allowed.length || new Set(actions).size !== actions.length || actions.some(a => !allowed.includes(a)) || !actions.includes(mode === 'portable' ? 'import' : 'observe')) fail('INVALID_ACTIONS');
  if (actions.some(a => ['takeover', 'execute', 'answer', 'pause', 'cancel', 'steer'].includes(a)) && !actions.includes('claim')) fail('INVALID_ACTIONS');
  integer(ttlSeconds, 1, limits.maxInviteTtlSeconds);
  integer(grantTtlSeconds, 1, mode === 'portable' ? limits.maxPortableGrantTtlSeconds : limits.maxGrantTtlSeconds);
  return { kind, mode, resource, actions, ttlSeconds, grantTtlSeconds };
}
export function importCode(value) {
  if (typeof value !== 'string' || !/^BZZY-(PAIR|AGENT|TERMINAL|LIBRARY)-[A-Za-z0-9_-]{43}$/.test(value)) fail('INVALID_CODE');
  b64(value.split('-').slice(2).join('-'), 32);
  return value;
}

// Fixed windows; refuse new buckets at capacity instead of growing without limit.
export class RateLimiter {
  constructor({ maxKeys, limit, windowMs = 60000, now = Date.now }) { Object.assign(this, { maxKeys, limit, windowMs, now }); this.buckets = new Map(); }
  take(key) {
    const now = this.now();
    for (const [id, row] of this.buckets) if (row.until <= now) this.buckets.delete(id);
    let row = this.buckets.get(key);
    if (!row) {
      if (this.buckets.size >= this.maxKeys) return false;
      this.buckets.set(key, row = { count: 0, until: now + this.windowMs });
    }
    return ++row.count <= this.limit;
  }
}
