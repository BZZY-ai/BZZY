import { randomUUID } from 'node:crypto';
import { activateCLIHost } from '@bzzy/core/engine/host-service.js';
import { ensureRuntime, runtimeRequest } from '@bzzy/core/engine/runtime.js';

export async function customNotificationCLI(options) {
  try {
    await activateCLIHost();
    const info = await ensureRuntime();
    const result = await runtimeRequest(info, 'POST', '/v1/notifications', { message: options.customNotification }, options.requestId || randomUUID());
    process.stdout.write(options.json ? JSON.stringify(result) + '\n'
      : `Notification queued · ${result.id}\nDelivery status: bzzy notifications status\n`);
    return 0;
  } catch (error) {
    const code = ['INVALID_NOTIFICATION', 'PUSH_REGISTRATION_REQUIRED', 'NOTIFICATION_RATE_LIMIT', 'CONFLICT', 'CORE_STOPPED'].includes(error.code) ? error.code : 'NOTIFICATION_FAILED';
    const message = code === 'PUSH_REGISTRATION_REQUIRED' ? 'Enable notifications on a fully approved paired iPhone first.'
      : code === 'INVALID_NOTIFICATION' ? 'Use a nonempty notification message of at most 180 characters without credentials.'
      : code === 'NOTIFICATION_RATE_LIMIT' ? 'Custom notifications are limited to 60 per minute.'
      : code === 'CONFLICT' ? 'This request ID belongs to a different notification.'
      : 'Core could not queue the notification. Check Core and notification status.';
    process.stderr.write(options.json ? JSON.stringify({ error: message, code }) + '\n' : message + '\n');
    return 1;
  }
}
