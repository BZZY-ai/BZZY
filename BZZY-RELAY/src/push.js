import { randomUUID } from 'node:crypto';
import { APNsClient, PushError, deviceToken } from './apns.js';
import { fail, hash, opaque, record } from './protocol.js';

// Separate from encrypted application routing. Only bounded, sanitized alert
// text and opaque navigation hints are accepted, never commands or credentials.
function alertPayload(value, hostId, grant) {
  record(value, ['aps', 'bzzy']); record(value.aps, ['alert', 'sound', 'category', 'thread-id']);
  record(value.aps.alert, ['title', 'body']);
  for (const [key, max] of [['title', 100], ['body', 180]]) {
    const text = value.aps.alert[key];
    if (typeof text !== 'string' || [...text].length > max || /[\x00-\x1f\x7f]/u.test(text)) fail('INVALID_PUSH');
  }
  const libraryCreation = /^(Skill|Agent) created( - .+)?$/.test(value.aps.alert.title);
  const debugExport = /^Full debug export (ready|failed)( - .+)?$/.test(value.aps.alert.title);
  const backgroundJob = /^(Completed|Failed) .+$/.test(value.aps.alert.title);
  if ((!libraryCreation && !debugExport && !backgroundJob && !/^(Goal (achieved|stalled|paused|cancelled)|Input needed)( - .+)?$|^BZZY update available$/.test(value.aps.alert.title)) ||
    value.aps.sound !== 'default' || value.aps.category !== 'BZZY_UPDATE') fail('INVALID_PUSH');
  opaque(value.aps['thread-id']);
  const hint = value.bzzy;
  record(hint, ['v', 'eventId', 'hostId', 'destination', 'resource', 'sessionId', 'agentId']);
  if (hint.v !== 1 || hint.hostId !== hostId || !['terminal', 'agents', 'updates'].includes(hint.destination)) fail('INVALID_PUSH');
  opaque(hint.eventId);
  if (debugExport && (hint.destination !== 'terminal' || hint.agentId !== undefined)) fail('INVALID_PUSH');
  if (backgroundJob && (hint.destination !== 'terminal' || hint.resource !== undefined || hint.sessionId !== undefined || hint.agentId !== undefined ||
      !/^Job [a-f0-9-]{36} (completed|failed|timed out|interrupted)\. Check status on your host\.$/i.test(value.aps.alert.body))) fail('INVALID_PUSH');
  if (hint.destination === 'updates') {
    if (libraryCreation || hint.resource !== undefined || hint.sessionId !== undefined || hint.agentId !== undefined) fail('INVALID_PUSH');
  } else if (!((libraryCreation || backgroundJob) && hint.resource === undefined && hint.sessionId === undefined && hint.agentId === undefined)) {
    opaque(hint.resource);
    if (typeof hint.sessionId !== 'string' || !/^[a-f0-9-]{36}$/i.test(hint.sessionId)) fail('INVALID_PUSH');
    if (hint.agentId !== undefined && (hint.destination !== 'agents' || !/^[a-f0-9-]{36}$/i.test(hint.agentId))) fail('INVALID_PUSH');
  }
  if (Buffer.byteLength(JSON.stringify(value)) > 2048) fail('INVALID_PUSH');
  return value;
}

export class RelayPushService {
  #timer; #busy = false; #clients = new Map(); #abort = new AbortController();
  constructor({ store, configurationLoader = () => null, clientFactory = options => new APNsClient(options), clock = Date.now } = {}) {
    Object.assign(this, { store, configurationLoader, clientFactory, clock });
    store.db.exec(`CREATE TABLE IF NOT EXISTS push_devices (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS push_queue (id TEXT PRIMARY KEY, data TEXT NOT NULL);`);
  }
  get(table, id) { const row = this.store.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id); return row ? JSON.parse(row.data) : null; }
  put(table, id, row) { this.store.db.prepare(`INSERT INTO ${table} VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`).run(id, JSON.stringify(row)); }
  configuration(environment) { const cfg = this.configurationLoader(); return cfg?.environment === environment ? cfg : null; }
  register(deviceId, params) {
    record(params, ['deviceToken', 'environment', 'enabled', 'grantIds']);
    const device = this.store.device(deviceId);
    if (!device || device.revokedAt || !this.store.grantsFor(deviceId).some(g => g.recipientId === deviceId && g.spec.kind === 'PAIR')) fail('GRANT_UNAVAILABLE');
    if (typeof params.enabled !== 'boolean') fail('INVALID_PUSH');
    if (!params.enabled) {
      this.put('push_devices', deviceId, { enabled: false });
      return { registered: false, providerConfigured: false };
    }
    if (!['sandbox', 'production'].includes(params.environment)) fail('INVALID_PUSH');
    if (!Array.isArray(params.grantIds) || params.grantIds.length > 256 || new Set(params.grantIds).size !== params.grantIds.length) fail('INVALID_PUSH');
    const allowedGrants = {};
    for (const id of params.grantIds) {
      opaque(id);
      let grant; try { grant = this.store.activeGrant(id, deviceId); } catch { continue; }
      if (grant.recipientId === deviceId && grant.spec.kind === 'PAIR') allowedGrants[id] = this.clock();
    }
    let token; try { token = deviceToken(params.deviceToken); } catch { fail('INVALID_PUSH'); }
    const previous = this.get('push_devices', deviceId);
    const sameBinding = previous?.enabled && previous.token === token && previous.environment === params.environment;
    for (const id of Object.keys(allowedGrants)) if (sameBinding && previous.grants?.[id] !== undefined) allowedGrants[id] = previous.grants[id];
    // Never let a second Relay identity redirect another phone's token.
    if (this.store.db.prepare("SELECT id FROM push_devices WHERE id!=? AND json_extract(data,'$.token')=? AND json_extract(data,'$.enabled')=1").get(deviceId, token)) fail('PUSH_UNAVAILABLE');
    this.put('push_devices', deviceId, { token, environment: params.environment, enabled: true, grants: allowedGrants,
      enabledSince: sameBinding ? previous.enabledSince : this.clock(),
      registeredAt: this.clock() });
    return { registered: true, providerConfigured: Boolean(this.configuration(params.environment)) };
  }
  enqueue(hostId, params) {
    record(params, ['grantId', 'id', 'environment', 'payload', 'occurredAt']);
    this.store.host(hostId);
    const grant = this.store.activeGrant(params.grantId, hostId);
    if (grant.hostId !== hostId || grant.spec.kind !== 'PAIR' || grant.spec.mode !== 'pair' || !grant.spec.actions.includes('observe')) fail('GRANT_UNAVAILABLE');
    opaque(params.id);
    if (!['sandbox', 'production'].includes(params.environment) || !Number.isSafeInteger(params.occurredAt) || params.occurredAt < this.clock() - 86400_000 || params.occurredAt > this.clock() + 5000) fail('INVALID_PUSH');
    const payload = alertPayload(params.payload, hostId, grant);
    const id = hash(`${hostId}:${grant.recipientId}:${params.id}`), requestDigest = hash(JSON.stringify(params));
    const existing = this.get('push_queue', id);
    if (existing) {
      if (existing.requestDigest !== requestDigest) fail('PUSH_CONFLICT');
      return this.status(existing);
    }
    const binding = this.get('push_devices', grant.recipientId);
    if (!binding?.enabled || binding.environment !== params.environment || binding.grants?.[grant.id] === undefined || params.occurredAt < binding.grants[grant.id]) fail('PUSH_REGISTRATION_REQUIRED');
    if (this.store.db.prepare('SELECT COUNT(*) AS count FROM push_queue').get().count >= 4096 ||
      this.store.db.prepare("SELECT COUNT(*) AS count FROM push_queue WHERE json_extract(data,'$.hostId')=? AND json_extract(data,'$.state') IN ('queued','retry','connecting','dispatching')").get(hostId).count >= 256) fail('PUSH_CAPACITY');
    const row = { id, requestDigest, hostId, peerId: grant.recipientId, grantId: grant.id, environment: params.environment,
      tokenDigest: hash(binding.token), occurredAt: params.occurredAt, payload, state: 'queued', attempts: 0, apnsId: randomUUID(), expiresAt: Math.min(grant.expiresAt, params.occurredAt + 86400_000) };
    this.put('push_queue', id, row);
    return this.status(row);
  }
  status(row) { return { state: row.state === 'connecting' ? 'queued' : row.state, providerConfigured: Boolean(this.configuration(row.environment)), ...(row.code ? { code: row.code } : {}) }; }
  start() {
    this.#timer ||= setInterval(() => { void this.tick().catch(() => {}); }, 1000);
    this.#timer.unref(); return this;
  }
  async tick() {
    if (this.#busy || this.#abort.signal.aborted) return;
    this.#busy = true;
    try {
      this.store.db.prepare("DELETE FROM push_queue WHERE json_extract(data,'$.expiresAt')<?").run(this.clock());
      const configuredEnvironment = this.configurationLoader()?.environment ?? null;
      // Readiness comes before age: one host's backed-off or unconfigured
      // environment cannot hide another host's due alert behind LIMIT 256.
      // The whole table remains bounded by the existing 4096-row capacity.
      const rows = this.store.db.prepare(`SELECT data FROM push_queue
        WHERE json_extract(data,'$.state') IN ('queued','retry','connecting','dispatching')
        ORDER BY CASE
          WHEN json_extract(data,'$.state')!='dispatching'
            AND COALESCE(json_extract(data,'$.nextAttemptAt'),0)<=?
            AND json_extract(data,'$.environment')=? THEN 0
          WHEN json_extract(data,'$.state')='dispatching' THEN 1
          ELSE 2 END, json_extract(data,'$.occurredAt') LIMIT 256`).all(this.clock(), configuredEnvironment);
      let count = 0;
      for (const item of rows) {
        if (count >= 8 || this.#abort.signal.aborted) break;
        let row = JSON.parse(item.data);
        const finish = (state, code) => {
          const { payload: ignored, code: oldCode, ...metadata } = row;
          this.put('push_queue', row.id, { ...metadata, state, ...(code ? { code } : {}) });
        };
        let grant;
        try { grant = this.store.activeGrant(row.grantId, row.hostId); } catch { finish('failed', 'FORBIDDEN'); continue; }
        const binding = this.get('push_devices', row.peerId);
        if (grant.hostId !== row.hostId || grant.recipientId !== row.peerId || !binding?.enabled || binding.environment !== row.environment || hash(binding.token) !== row.tokenDigest || binding.grants?.[grant.id] === undefined || row.occurredAt < binding.grants[grant.id]) {
          finish('failed', 'FORBIDDEN'); continue;
        }
        if (row.state === 'dispatching') { finish('uncertain', 'APNS_UNAVAILABLE'); continue; }
        if (row.nextAttemptAt > this.clock()) continue;
        const cfg = this.configuration(row.environment);
        if (!cfg) continue;
        let client = this.#clients.get(cfg.fingerprint);
        if (!client) { for (const old of this.#clients.values()) old.close(); this.#clients.clear(); client = this.clientFactory({ configuration: cfg }); this.#clients.set(cfg.fingerprint, client); }
        // A restart while merely connecting can retry: APNsClient cannot post
        // until the durable beforeDispatch fence below has completed.
        row = { ...row, state: 'connecting', attempts: row.attempts + 1 };
        this.put('push_queue', row.id, row); count++;
        try {
          await client.send({ token: binding.token, payload: row.payload, id: row.apnsId, collapseID: row.id, signal: this.#abort.signal,
            beforeDispatch: () => {
              // Connection setup can yield to revocation, token rotation or
              // expiry. Recheck the exact same immutable binding before POST.
              let currentGrant;
              try { currentGrant = this.store.activeGrant(row.grantId, row.hostId); } catch { throw new PushError('FORBIDDEN', { permanent: true }); }
              const current = this.get('push_devices', row.peerId);
              if (this.#abort.signal.aborted) throw new PushError('APNS_UNAVAILABLE');
              if (row.expiresAt <= this.clock() || currentGrant.hostId !== row.hostId || currentGrant.recipientId !== row.peerId ||
                  !current?.enabled || current.environment !== row.environment || hash(current.token) !== row.tokenDigest ||
                  current.grants?.[currentGrant.id] === undefined || row.occurredAt < current.grants[currentGrant.id]) {
                throw new PushError('FORBIDDEN', { permanent: true });
              }
              row = { ...row, state: 'dispatching' };
              this.put('push_queue', row.id, row);
            } });
          finish('sent');
        } catch (error) {
          const code = ['APNS_TOKEN_INVALID', 'APNS_REJECTED', 'APNS_UNAVAILABLE', 'APNS_PAYLOAD_INVALID', 'APNS_RESPONSE_INVALID', 'FORBIDDEN'].includes(error?.code) ? error.code : 'APNS_UNAVAILABLE';
          if (error?.uncertain || error?.permanent) finish(error?.uncertain ? 'uncertain' : 'failed', code);
          // Known pre-dispatch outages and explicit temporary Apple rejections
          // retain the same request until the existing grant/event expiry.
          // The queue and five-minute backoff bound storage and retry rate.
          else this.put('push_queue', row.id, { ...row, state: 'retry', code, nextAttemptAt: this.clock() + Math.min(300_000, 1000 * 2 ** Math.min(row.attempts, 9)) });
          const current = this.get('push_devices', row.peerId);
          if (error?.invalidated && current?.token === binding.token && (!error.timestamp || current.registeredAt <= error.timestamp)) this.put('push_devices', row.peerId, { enabled: false });
        }
      }
    } finally { this.#busy = false; }
  }
  async close() { clearInterval(this.#timer); this.#abort.abort(); for (const client of this.#clients.values()) client.close(); while (this.#busy) await new Promise(resolve => setTimeout(resolve, 10)); }
}
