import { listRecords } from '../engine/database.js';
import { loadAPNsConfiguration } from './apns.js';
import { authorizedPushRegistration } from './registration.js';

// Owner diagnostics: never expose device tokens, Apple keys, or objectives.
export function notificationDeliveryStatus() {
  const configuration = loadAPNsConfiguration();
  const registrations = listRecords('core.push.registration').filter(row => row.enabled && !row.revokedAt && authorizedPushRegistration(row));
  const compatible = registrations.filter(row => row.environment === configuration?.environment);
  const deliveries = listRecords('core.push.delivery');
  const counts = {};
  for (const delivery of deliveries) counts[delivery.state] = (counts[delivery.state] || 0) + 1;
  return { configured: Boolean(configuration), registeredDevices: registrations.length, compatibleDevices: compatible.length,
    goalEvents: listRecords('outbox').filter(row => /^goal\./.test(row.event?.type || '')).length, deliveries: counts,
    message: !configuration ? 'iPhone alerts need private Apple APNs setup on this host. See Core docs/PUSH.md.'
      : !registrations.length ? 'Enable notifications in the paired iPhone app.'
      : !compatible.length ? 'The Apple environment differs from the installed iPhone build.' : 'iPhone goal alerts are configured. Apple acceptance is recorded per delivery.' };
}
