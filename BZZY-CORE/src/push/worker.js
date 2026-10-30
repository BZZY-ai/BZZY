import { authorizedUpdateGrant, updateDevicePreferences } from '../engine/update-access.js';
import { randomUUID } from 'node:crypto';
import { home } from '../engine/files.js';
import { database, getRecord, putRecord, listRecords, digest, now } from '../engine/database.js';
import { loadRelayIdentity } from '../relay/identity.js';
import { authorizedPushRegistration } from './registration.js';
import { sharedSecrets } from '../engine/share-bundle-policy.js';
import { notificationPreview } from '../engine/notification-preview.js';
import { libraryNotificationTypes, currentLibraryCreation, libraryCreationAlert } from '../engine/library-notifications.js';
import { debugExportNotificationTypes, currentDebugExportOutcome, reconcileDebugExportJobs } from '../engine/debug-export-jobs.js';
import { debugExportAlert } from '../engine/debug-export-notifications.js';
import { backgroundNotificationTypes, currentBackgroundOutcome } from '../engine/background-jobs.js';
import { customNotificationType, customNotificationRecipient, currentCustomNotification, customNotificationAlert } from '../engine/custom-notifications.js';
import { APNsClient, loadAPNsConfiguration } from './apns.js';

const types = new Set(['goal.completed', 'goal.stalled', 'goal.paused', 'goal.cancelled', 'goal.waiting_for_input', 'system.update_available', customNotificationType, ...libraryNotificationTypes, ...debugExportNotificationTypes, ...backgroundNotificationTypes]);
export function goalAlert(event, session, secrets = []) {
  const safe = (value, maximum = 180) => notificationPreview(value, maximum, secrets);
  const state = { 'goal.completed': 'Goal achieved', 'goal.waiting_for_input': 'Input needed', 'goal.paused': 'Goal paused', 'goal.cancelled': 'Goal cancelled' }[event.type] || 'Goal stalled';
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
    hostID = () => { try { return loadRelayIdentity().certificate.id; } catch { return null; } }, clock = Date.now, relaySend } = {}) {
    this.configurationLoader = configurationLoader; this.clientFactory = clientFactory; this.hostID = hostID; this.clock = clock;
    this.relaySend = relaySend;
  }
  start() {
    if (!this.#timer) { this.#timer = setInterval(() => { void this.tick().catch(() => {}); }, 1000); this.#timer.unref(); }
    void this.tick().catch(() => {}); return this;
  }
  async flush() {
    const deadline = Date.now() + 3000;
    while (this.#busy && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    if (this.#busy) return;
    let timer;
    try { await Promise.race([this.tick(), new Promise(resolve => { timer = setTimeout(resolve, Math.max(1, deadline - Date.now())); })]); }
    finally { clearTimeout(timer); }
  }
  async tick() {
    if (this.#busy || this.#abort.signal.aborted || home() !== this.#home) return;
    this.#busy = true;
    try {
      reconcileDebugExportJobs({ force: false });
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
      const rotatedCursor = records.at(-1)?.id || '';
      // New outcomes must not wait behind a large historical outbox. The
      // independent rotating page still recovers older queued work fairly.
      const recent = database().prepare("SELECT id,data FROM records WHERE kind='outbox' AND json_extract(data,'$.event.occurredAt')>=? ORDER BY json_extract(data,'$.event.occurredAt') DESC LIMIT 200")
        .all(new Date(this.clock() - 60_000).toISOString());
      records = [...new Map([...recent, ...records].map(row => [row.id, row])).values()];
      this.#cursor = rotatedCursor;
      const secrets = sharedSecrets();
      for (const row of records) {
        const record = JSON.parse(row.data);
        const event = record.event, isUpdate = event?.type === 'system.update_available', isLibrary = libraryNotificationTypes.has(event?.type), isDebug = debugExportNotificationTypes.has(event?.type), isJob = backgroundNotificationTypes.has(event?.type), isCustom = event?.type === customNotificationType,
          hostWide = isUpdate || isLibrary || isJob || isCustom, occurred = Date.parse(event?.occurredAt);
        if (!event || typeof event.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(event.id) ||
          (!hostWide && (typeof event.sessionId !== 'string' || !/^[a-f0-9-]{36}$/i.test(event.sessionId))) ||
          !types.has(event.type) || !Number.isFinite(occurred) || occurred < this.clock() - 24 * 3600_000) continue;
        if (isLibrary && !currentLibraryCreation(event)) continue;
        if (isDebug && !currentDebugExportOutcome(event)) continue;
        if (isJob && !currentBackgroundOutcome(event)) continue;
        const custom = isCustom ? currentCustomNotification(event) : null, customAlert = isCustom ? customNotificationAlert(event, secrets) : null;
        if (isCustom && (!custom || !customAlert)) continue;
        if (isUpdate) {
          const update = getRecord('core.update.status', 'default');
          if (update?.phase !== 'ready' || update.available !== true || update.blocked || update.target !== event.target) continue;
        }
        for (const registration of registrations) {
          if (sent >= 8 || this.#abort.signal.aborted) return;
          if (occurred < registration.enabledSince || !authorizedPushRegistration(registration, hostWide ? undefined : event.sessionId)) continue;
          if (isLibrary && !authorizedUpdateGrant(registration.relayGrantId)) continue;
          if (isDebug && !authorizedUpdateGrant(registration.relayGrantId)) continue;
          if (isJob && !authorizedUpdateGrant(registration.relayGrantId)) continue;
          if (isCustom && (!custom.recipientIds.includes(registration.id) || !customNotificationRecipient(registration))) continue;
          if (isUpdate && (!authorizedUpdateGrant(registration.relayGrantId) || updateDevicePreferences(authorizedUpdateGrant(registration.relayGrantId)).notificationsEnabled === false)) continue;
          const id = digest({ hostId, peer: registration.peerId, token: registration.tokenDigest, event: event.id });
          let delivery = getRecord('core.push.delivery', id);
          const viaRelay = delivery?.route === 'relay' || registration.relayPush === true;
          if (!viaRelay && (!configuration || registration.environment !== configuration.environment)) {
            if (!delivery || delivery.state === 'waiting_for_configuration' && delivery.code !== (!configuration ? 'APNS_SETUP_REQUIRED' : 'APNS_ENVIRONMENT_MISMATCH')) putRecord('core.push.delivery', id, { id, registrationId: registration.id, eventId: event.id, sessionId: event.sessionId || null, state: 'waiting_for_configuration', attempts: 0, code: !configuration ? 'APNS_SETUP_REQUIRED' : 'APNS_ENVIRONMENT_MISMATCH', updatedAt: now() });
            continue;
          }
          if (delivery?.route === 'relay' && delivery.registrationId !== registration.id) continue;
          if (delivery && (['sent', 'failed', 'uncertain'].includes(delivery.state) || delivery.nextAttemptAt > this.clock())) continue;
          if (delivery?.state === 'dispatching') {
            // A crash after APNs acceptance has an uncertain outcome. Preserve
            // that fact; never blindly repeat a potentially delivered alert.
            putRecord('core.push.delivery', id, { ...delivery, state: 'uncertain', updatedAt: now() }); continue;
          }
          delivery = { ...delivery, id, registrationId: registration.id, eventId: event.id, sessionId: event.sessionId || null,
            route: viaRelay ? 'relay' : 'direct', state: viaRelay ? 'relay_queued' : 'dispatching', attempts: (delivery?.attempts || 0) + 1, apnsId: delivery?.apnsId || randomUUID(), updatedAt: now() };
          putRecord('core.push.delivery', id, delivery); sent++;
          try {
            const current = getRecord('core.push.registration', registration.id);
            if (!current?.enabled || current.hostId !== hostId || current.tokenDigest !== registration.tokenDigest || !authorizedPushRegistration(current, hostWide ? undefined : event.sessionId) ||
                isLibrary && (!authorizedUpdateGrant(current.relayGrantId) || !currentLibraryCreation(event)) ||
                isDebug && (!authorizedUpdateGrant(current.relayGrantId) || !currentDebugExportOutcome(event)) ||
                isJob && (!authorizedUpdateGrant(current.relayGrantId) || !currentBackgroundOutcome(event)) ||
                isCustom && (!custom.recipientIds.includes(current.id) || !customNotificationRecipient(current) || !currentCustomNotification(event)) ||
                isUpdate && (!authorizedUpdateGrant(current.relayGrantId) || updateDevicePreferences(authorizedUpdateGrant(current.relayGrantId)).notificationsEnabled === false)) {
              putRecord('core.push.delivery', id, { ...delivery, state: 'failed', code: 'FORBIDDEN', updatedAt: now() }); continue;
            }
            const session = !isUpdate && event.sessionId ? getRecord('session', event.sessionId) : null, isAgent = session?.purpose === 'agent';
            const libraryRoute = isLibrary ? { v: 1, eventId: id, destination: event.definitionKind === 'agent' ? 'agents' : 'terminal',
              ...(session && authorizedPushRegistration(current, session.id) ? { resource: current.resource, sessionId: session.id,
                ...(isAgent && event.definitionKind === 'agent' ? { agentId: session.agentId } : {}) } : {}) } : null;
            // Older iOS parsers reject unknown metadata. Opt-in belongs to the
            // device binding; pre-capability registrations retain their shape.
            const hostHint = current.hostHints === true || viaRelay ? { hostId: current.hostId } : {};
            const payload = delivery.payload || { aps: { alert: isUpdate ? { title: 'BZZY update available', body: 'Update CLI and Core from Settings on your iPhone.' }
                  : isCustom ? customAlert : isLibrary ? libraryCreationAlert(event, secrets) : isDebug ? debugExportAlert(event, secrets)
                  : isJob ? { title: `${event.type === 'job.completed' ? 'Completed' : 'Failed'} ${notificationPreview(currentBackgroundOutcome(event)?.notificationName, 64, secrets) || 'script'}`, body: `Job ${event.jobId} ${event.type.slice(4).replace('_', ' ')}. Check status on your host.` }
                  : goalAlert(event, session, secrets), sound: 'default', category: 'BZZY_UPDATE',
                  'thread-id': digest({ hostId, resource: current.resource, sessionId: event.sessionId, ...(isLibrary ? { library: event.definitionKind } : {}), ...(isJob ? { jobId: event.jobId } : {}), ...(isCustom ? { notificationId: event.id } : {}) }) },
                // This public routing hint comes from the reauthorized private
                // binding, never from a model reply or the queued event. Clients
                // still authenticate the selected Core before opening details.
                bzzy: isUpdate ? { v: 1, eventId: id, ...hostHint, destination: 'updates' } : isJob || isCustom ? { v: 1, eventId: id, ...hostHint, destination: 'terminal' } : isLibrary ? { ...libraryRoute, ...hostHint } : { v: 1, eventId: id, ...hostHint, destination: isAgent ? 'agents' : 'terminal', resource: current.resource, sessionId: event.sessionId,
                  ...(isAgent ? { agentId: session.agentId } : {}) } };
            if (viaRelay) {
              // Persist the exact request before transport. Repeating this ID
              // queries the Relay receipt; it cannot enqueue a second alert.
              delivery = { ...delivery, payload }; putRecord('core.push.delivery', id, delivery);
              const receipt = await this.relaySend?.(current, { id, payload, occurredAt: occurred });
              if (!receipt || !['queued', 'retry', 'dispatching', 'sent', 'failed', 'uncertain'].includes(receipt.state)) throw new Error('Relay push unavailable.');
              putRecord('core.push.relay-status', 'current', { configured: receipt.providerConfigured === true, environment: current.environment, updatedAt: now() });
              const { payload: ignored, ...metadata } = delivery;
              putRecord('core.push.delivery', id, { ...(['sent', 'failed', 'uncertain'].includes(receipt.state) ? metadata : delivery),
                state: ['sent', 'failed', 'uncertain'].includes(receipt.state) ? receipt.state : 'relay_queued',
                ...(receipt.code ? { code: receipt.code } : {}), nextAttemptAt: this.clock() + 2000, updatedAt: now() });
              continue;
            }
            const receipt = await this.#client.send({ token: current.deviceToken, id: delivery.apnsId, collapseID: id, signal: this.#abort.signal, payload });
            putRecord('core.push.delivery', id, { ...delivery, state: 'sent', receipt: { accepted: receipt.accepted === true, apnsId: receipt.apnsId }, updatedAt: now() });
          } catch (error) {
            if (viaRelay) {
              const permanent = ['GRANT_UNAVAILABLE', 'FORBIDDEN', 'PUSH_CONFLICT', 'INVALID_PUSH'].includes(error?.code);
              putRecord('core.push.delivery', id, { ...delivery, state: permanent ? 'failed' : 'relay_queued',
                code: permanent ? 'FORBIDDEN' : error?.code === 'PUSH_REGISTRATION_REQUIRED' ? 'PUSH_REGISTRATION_REQUIRED' : 'RELAY_PUSH_UNAVAILABLE',
                nextAttemptAt: this.clock() + Math.min(30_000, 1000 * 2 ** Math.min(delivery.attempts, 5)), updatedAt: now() });
              continue;
            }
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
