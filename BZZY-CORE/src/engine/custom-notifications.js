import { randomUUID } from 'node:crypto';
import { database, digest, getRecord, listRecords, now, putRecord, reserveRequest } from './database.js';
import { notificationPreview } from './notification-preview.js';
import { sharedSecrets } from './share-bundle-policy.js';
import { authorizedPushRegistration } from '../push/registration.js';
import { authorizedUpdateGrant } from './update-access.js';

export const customNotificationType = 'notification.custom';
const kind = 'core.notification.custom';
const fail = (message, code = 'INVALID_NOTIFICATION', status = 400) => Object.assign(new Error(message), { code, status });
export const customNotificationRecipient = registration => Boolean(registration?.enabled && !registration.revokedAt
  && authorizedPushRegistration(registration) && authorizedUpdateGrant(registration.relayGrantId));

export function queueCustomNotification(input, requestId) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'message')
      || typeof input.message !== 'string' || Buffer.byteLength(input.message) > 4096 || [...input.message.trim()].length > 180)
    throw fail('Use a nonempty notification message of at most 180 characters without credentials.');
  const message = notificationPreview(input.message, 180, sharedSecrets());
  if (!message) throw fail('Use a nonempty notification message of at most 180 characters without credentials.');
  return reserveRequest('custom-notification:submit', requestId, { message }, db => {
    const recipients = listRecords('core.push.registration').filter(customNotificationRecipient);
    if (!recipients.length) throw fail('Enable notifications on a fully approved paired iPhone first.', 'PUSH_REGISTRATION_REQUIRED', 409);
    const recent = database().prepare("SELECT count(*) AS n FROM records WHERE kind=? AND json_extract(data,'$.createdAt')>=?")
      .get(kind, new Date(Date.now() - 60000).toISOString()).n;
    if (recent >= 60) throw fail('Custom notifications are limited to 60 per minute.', 'NOTIFICATION_RATE_LIMIT', 429);
    const id = randomUUID(), createdAt = now(), event = { version: 1, id, type: customNotificationType, occurredAt: createdAt };
    putRecord(kind, id, { id, message, createdAt, recipientIds: recipients.map(item => item.id), eventFingerprint: digest(event) }, db);
    putRecord('outbox', id, { event, deliveries: {} }, db);
    return { id, state: 'queued', recipientCount: new Set(recipients.map(item => `${item.hostId}:${item.peerId}`)).size };
  });
}

export function currentCustomNotification(event) {
  if (event?.type !== customNotificationType || typeof event.id !== 'string') return null;
  const record = getRecord(kind, event.id);
  return record?.eventFingerprint === digest(event) ? record : null;
}
export function customNotificationAlert(event, secrets = []) {
  const record = currentCustomNotification(event), body = notificationPreview(record?.message, 180, secrets);
  return body ? { title: 'BZZY notification', body } : null;
}
