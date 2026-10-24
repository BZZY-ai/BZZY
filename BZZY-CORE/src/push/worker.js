import { authorizedUpdateGrant, updateDevicePreferences } from '../engine/update-access.js';
import { randomUUID } from 'node:crypto';
import { home } from '../engine/files.js';
import { database, getRecord, putRecord, listRecords, digest, now } from '../engine/database.js';
import { loadRelayIdentity } from '../relay/identity.js';
import { authorizedPushRegistration } from './registration.js';
import { sharedSecrets } from '../engine/share-bundle-policy.js';
import { notificationPreview } from '../engine/notification-preview.js';
import { APNsClient, loadAPNsConfiguration } from './apns.js';

const types = new Set(['goal.completed', 'goal.stalled', 'goal.waiting_for_input', 'system.update_available']);
export function goalAlert(event, session, secrets = []) {
  const safe = (value, maximum = 180) => notificationPreview(value, maximum, secrets);
  const state = event.type === 'goal.completed' ? 'Goal achieved' : event.type === 'goal.waiting_for_input' ? 'Input needed' : 'Goal stalled';
  const alias = safe(session?.alias, 48);
  if (event.type === 'goal.waiting_for_input') return { title: alias ? `${state} - ${alias}` : state, body: 'Open BZZY to review the request.' };
  const preview = event.replyPreview || (event.type === 'goal.stalled' ? event.reason : null);
  return { title: alias ? `${state} - ${alias}` : state,
    body: safe(preview) || (Object.hasOwn(event, 'replyPreview') ? '' : safe(event.objective)) || 'Open BZZY for details.' };
}

// Reuses durable goal outbox records written by the existing engine. This worker
// belongs to the same Core daemon and continues after the phone socket closes.
export class CorePushWorker {
  #home = home(); #timer; #busy = false; #client; #configuration; #cursor = ''; #abort = new AbortController();
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
      if (!configuration && this.#client) { this.#client.close(); this.#client = null; this.#configuration = null; }
      if (configuration && (!this.#client || this.#configuration !== configuration.fingerprint)) {
        this.#client?.close(); this.#client = this.clientFactory({ configuration }); this.#configuration = configuration.fingerprint;
      }
      const hostId = this.hostID();
      if (!hostId) return;
      const registrations = listRecords('core.push.registration').filter(row => row.hostId === hostId && row.enabled && !row.revokedAt);
      let sent = 0;
      let records = database().prepare("SELECT id,data FROM records WHERE kind='outbox' AND id>? ORDER BY id LIMIT 200").all(this.#cursor);
      if (!records.length) { this.#cursor = ''; records = database().prepare("SELECT id,data FROM records WHERE kind='outbox' ORDER BY id LIMIT 200").all(); }
      const secrets = sharedSecrets();
      for (const row of records) {
        this.#cursor = row.id;
        const record = JSON.parse(row.data);
        const event = record.event, isUpdate = event?.type === 'system.update_available', occurred = Date.parse(event?.occurredAt);
        if (!event || typeof event.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(event.id) ||
          (!isUpdate && (typeof event.sessionId !== 'string' || !/^[a-f0-9-]{36}$/i.test(event.sessionId))) ||
          !types.has(event.type) || !Number.isFinite(occurred) || occurred < this.clock() - 24 * 3600_000) continue;
        if (isUpdate) {
          const update = getRecord('core.update.status', 'default');
          if (update?.phase !== 'ready' || update.available !== true || update.blocked || update.target !== event.target) continue;
        }
        for (const registration of registrations) {
          if (sent >= 8 || this.#abort.signal.aborted) return;
          if (occurred < registration.enabledSince || !authorizedPushRegistration(registration, isUpdate ? undefined : event.sessionId)) continue;
          if (isUpdate && (!authorizedUpdateGrant(registration.relayGrantId) || updateDevicePreferences(authorizedUpdateGrant(registration.relayGrantId)).notificationsEnabled === false)) continue;
          const id = digest({ hostId, peer: registration.peerId, token: registration.tokenDigest, event: event.id });
          let delivery = getRecord('core.push.delivery', id);
          if (!configuration || registration.environment !== configuration.environment) {
            if (!delivery || delivery.state === 'waiting_for_configuration' && delivery.code !== (!configuration ? 'APNS_SETUP_REQUIRED' : 'APNS_ENVIRONMENT_MISMATCH')) putRecord('core.push.delivery', id, { id, registrationId: registration.id, eventId: event.id, sessionId: event.sessionId || null, state: 'waiting_for_configuration', attempts: 0, code: !configuration ? 'APNS_SETUP_REQUIRED' : 'APNS_ENVIRONMENT_MISMATCH', updatedAt: now() });
            continue;
          }
          if (delivery && (['sent', 'failed', 'uncertain'].includes(delivery.state) || delivery.nextAttemptAt > this.clock())) continue;
          if (delivery?.state === 'dispatching') {
            // A crash after APNs acceptance has an uncertain outcome. Preserve
            // that fact; never blindly repeat a potentially delivered alert.
            putRecord('core.push.delivery', id, { ...delivery, state: 'uncertain', updatedAt: now() }); continue;
          }
          delivery = { ...delivery, id, registrationId: registration.id, eventId: event.id, sessionId: event.sessionId || null,
            state: 'dispatching', attempts: (delivery?.attempts || 0) + 1, apnsId: delivery?.apnsId || randomUUID(), updatedAt: now() };
          putRecord('core.push.delivery', id, delivery); sent++;
          try {
            const current = getRecord('core.push.registration', registration.id);
            if (!current?.enabled || current.hostId !== hostId || current.tokenDigest !== registration.tokenDigest || !authorizedPushRegistration(current, isUpdate ? undefined : event.sessionId) || isUpdate && (!authorizedUpdateGrant(current.relayGrantId) || updateDevicePreferences(authorizedUpdateGrant(current.relayGrantId)).notificationsEnabled === false)) {
              putRecord('core.push.delivery', id, { ...delivery, state: 'failed', code: 'FORBIDDEN', updatedAt: now() }); continue;
            }
            const session = isUpdate ? null : getRecord('session', event.sessionId), isAgent = session?.purpose === 'agent';
            // Older iOS parsers reject unknown metadata. Opt-in belongs to the
            // device binding; pre-capability registrations retain their shape.
            const hostHint = current.hostHints === true ? { hostId: current.hostId } : {};
            const receipt = await this.#client.send({ token: current.deviceToken, id: delivery.apnsId, collapseID: id, signal: this.#abort.signal,
              payload: { aps: { alert: isUpdate ? { title: 'BZZY update available', body: 'Update CLI and Core from Settings on your iPhone.' } : goalAlert(event, session, secrets), sound: 'default', category: 'BZZY_UPDATE',
                  'thread-id': digest({ hostId, resource: current.resource, sessionId: event.sessionId }) },
                // This public routing hint comes from the reauthorized private
                // binding, never from a model reply or the queued event. Clients
                // still authenticate the selected Core before opening details.
                bzzy: isUpdate ? { v: 1, eventId: id, ...hostHint, destination: 'updates' } : { v: 1, eventId: id, ...hostHint, destination: isAgent ? 'agents' : 'terminal', resource: current.resource, sessionId: event.sessionId,
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
