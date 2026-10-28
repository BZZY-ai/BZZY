import { listRecords, getRecord } from '../engine/database.js';
import { loadAPNsConfiguration } from './apns.js';
import { authorizedPushRegistration } from './registration.js';

// Owner diagnostics: never expose device tokens, Apple keys, or objectives.
export function notificationDeliveryStatus() {
  const configuration = loadAPNsConfiguration();
  const registrations = listRecords('core.push.registration').filter(row => row.enabled && !row.revokedAt && authorizedPushRegistration(row));
  const relay = getRecord('core.push.relay-status', 'current');
  const compatible = registrations.filter(row => row.relayPush ? relay?.configured === true && row.environment === relay.environment : row.environment === configuration?.environment);
  const configured = Boolean(configuration || relay?.configured);
  const deliveries = listRecords('core.push.delivery');
  const expiredPairing = listRecords('core.push.registration').some(row => {
    const grant = getRecord('core.relay.grant', row.relayGrantId);
    return row.enabled && !row.revokedAt && grant && !grant.revokedAt && grant.expiresAt <= Date.now();
  });
  const counts = {};
  for (const delivery of deliveries) counts[delivery.state] = (counts[delivery.state] || 0) + 1;
  return { configured, registeredDevices: registrations.length, compatibleDevices: compatible.length,
    goalEvents: listRecords('outbox').filter(row => /^goal\./.test(row.event?.type || '')).length, deliveries: counts,
    message: !registrations.length && expiredPairing ? 'The saved iPhone pairing has expired. Pair again in Settings > Pair iPhone, then reopen the app to register goal alerts.'
      : !configured ? registrations.some(row => row.relayPush) ? 'Remote iPhone delivery is not ready: the last Relay response reported APNs unavailable for this app environment. The alert is saved, not confirmed delivered. Configure Apple push on Relay; see Core docs/PUSH.md.' : 'iPhone alerts need private Apple APNs setup on this host. See Core docs/PUSH.md.'
      : !registrations.length ? 'Enable notifications in the paired iPhone app.'
      : !compatible.length ? 'The Apple environment differs from the installed iPhone build.' : 'iPhone goal alerts are configured. Apple acceptance is recorded per delivery.' };
}
