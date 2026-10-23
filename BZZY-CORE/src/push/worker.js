import { randomUUID } from 'node:crypto';
import { home } from '../engine/files.js';
import { getRecord, putRecord, listRecords, digest, now } from '../engine/database.js';
import { loadRelayIdentity } from '../relay/identity.js';
import { authorizedPushRegistration } from './registration.js';
import { APNsClient, loadAPNsConfiguration } from './apns.js';

const types = new Set(['goal.completed', 'goal.stalled', 'goal.waiting_for_input']);
const message = type => type === 'goal.completed' ? 'A goal completed. Open BZZY for details.'
  : type === 'goal.waiting_for_input' ? 'A goal needs your input. Open BZZY for details.' : 'A goal needs attention. Open BZZY for details.';
const title = type => type === 'goal.completed' ? 'Goal complete' : type === 'goal.waiting_for_input' ? 'Input needed' : 'Goal needs attention';

// Reuses durable goal outbox records written by the existing engine. This worker
// belongs to the same Core daemon and continues after the phone socket closes.
export class CorePushWorker {
  #home = home(); #timer; #busy = false; #client; #configuration; #abort = new AbortController();
  constructor({ configurationLoader = loadAPNsConfiguration, clientFactory = options => new APNsClient(options),
    hostID = () => { try { return loadRelayIdentity().certificate.id; } catch { return null; } }, clock = Date.now } = {}) {
    this.configurationLoader = configurationLoader; this.clientFactory = clientFactory; this.hostID = hostID; this.clock = clock;
  }
  start() {
    if (!this.#timer) { this.#timer = setInterval(() => { void this.tick().catch(() => {}); }, 1000); this.#timer.unref(); }
    void this.tick().catch(() => {}); return this;
  }
  async tick() {
    if (this.#busy || this.#abort.signal.aborted || home() !== this.#home) return;
    this.#busy = true;
    try {
      const configuration = this.configurationLoader();
      if (!configuration) return;
      if (!this.#client || this.#configuration !== configuration.fingerprint) {
        this.#client?.close(); this.#client = this.clientFactory({ configuration }); this.#configuration = configuration.fingerprint;
      }
      const hostId = this.hostID();
      if (!hostId) return;
      const registrations = listRecords('core.push.registration').filter(row => row.hostId === hostId && row.enabled && !row.revokedAt && row.environment === configuration.environment);
      let sent = 0;
      for (const record of listRecords('outbox', { limit: 1000 })) {
        const event = record.event, occurred = Date.parse(event?.occurredAt);
        if (!event || typeof event.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(event.id) ||
          typeof event.sessionId !== 'string' || !/^[a-f0-9-]{36}$/i.test(event.sessionId) ||
          !types.has(event.type) || !Number.isFinite(occurred) || occurred < this.clock() - 24 * 3600_000) continue;
        for (const registration of registrations) {
          if (sent >= 8 || this.#abort.signal.aborted) return;
          if (occurred < registration.enabledSince || !authorizedPushRegistration(registration, event.sessionId)) continue;
          const id = digest({ hostId, peer: registration.peerId, token: registration.tokenDigest, event: event.id });
          let delivery = getRecord('core.push.delivery', id);
          if (delivery && (['sent', 'failed', 'uncertain'].includes(delivery.state) || delivery.nextAttemptAt > this.clock())) continue;
          if (delivery?.state === 'dispatching') {
            // A crash after APNs acceptance has an uncertain outcome. Preserve
            // that fact; never blindly repeat a potentially delivered alert.
            putRecord('core.push.delivery', id, { ...delivery, state: 'uncertain', updatedAt: now() }); continue;
          }
          delivery = { ...delivery, id, registrationId: registration.id, eventId: event.id, sessionId: event.sessionId,
            state: 'dispatching', attempts: (delivery?.attempts || 0) + 1, apnsId: delivery?.apnsId || randomUUID(), updatedAt: now() };
          putRecord('core.push.delivery', id, delivery); sent++;
          try {
            const current = getRecord('core.push.registration', registration.id);
            if (!current?.enabled || current.tokenDigest !== registration.tokenDigest || !authorizedPushRegistration(current, event.sessionId)) {
              putRecord('core.push.delivery', id, { ...delivery, state: 'failed', code: 'FORBIDDEN', updatedAt: now() }); continue;
            }
            const session = getRecord('session', event.sessionId), isAgent = session?.purpose === 'agent';
            const receipt = await this.#client.send({ token: current.deviceToken, id: delivery.apnsId, collapseID: id, signal: this.#abort.signal,
              payload: { aps: { alert: { title: title(event.type), body: message(event.type) }, sound: 'default', category: 'BZZY_UPDATE',
                  'thread-id': digest({ hostId, resource: current.resource, sessionId: event.sessionId }) },
                bzzy: { v: 1, eventId: id, destination: isAgent ? 'agents' : 'terminal', resource: current.resource, sessionId: event.sessionId,
                  ...(isAgent ? { agentId: session.agentId } : {}) } } });
            putRecord('core.push.delivery', id, { ...delivery, state: 'sent', receipt: { accepted: receipt.accepted === true, apnsId: receipt.apnsId }, updatedAt: now() });
          } catch (error) {
            const fixed = ['APNS_TOKEN_INVALID', 'APNS_REJECTED', 'APNS_UNAVAILABLE', 'APNS_PAYLOAD_INVALID', 'APNS_RESPONSE_INVALID'].includes(error?.code) ? error.code : 'APNS_UNAVAILABLE';
            putRecord('core.push.delivery', id, { ...delivery, state: error?.uncertain ? 'uncertain' : error?.permanent || delivery.attempts >= 8 ? 'failed' : 'retry', code: fixed,
              nextAttemptAt: this.clock() + Math.min(300_000, 1000 * 2 ** Math.min(delivery.attempts, 8)), updatedAt: now() });
            if (error?.invalidated) {
              const current = getRecord('core.push.registration', registration.id);
              if (current?.tokenDigest === registration.tokenDigest && (!error.timestamp || current.registeredAt <= error.timestamp)) {
                const { deviceToken: ignored, ...metadata } = current;
                putRecord('core.push.registration', current.id, { ...metadata, enabled: false, revokedAt: now(), updatedAt: now() });
              }
            }
          }
        }
      }
    } finally { this.#busy = false; }
  }
  close() { clearInterval(this.#timer); this.#timer = null; this.#abort.abort(); this.#client?.close(); }
}
