import { getRecord } from './database.js';
import { notificationPreview } from './notification-preview.js';
import { currentDebugExportOutcome } from './debug-export-jobs.js';

export function debugExportAlert(event, secrets = []) {
  const job = currentDebugExportOutcome(event);
  if (!job) return null;
  const session = getRecord('session', job.sessionId), alias = notificationPreview(session?.alias, 48, secrets);
  const label = job.state === 'completed' ? 'Full debug export ready' : 'Full debug export failed';
  const body = job.state === 'completed' ? `ZIP saved on your host. Job ${job.id}.` : `${job.error?.message || 'The export could not finish.'} [${job.error?.code || 'SESSION_DEBUG_FAILED'}]`;
  return { title: alias ? `${label} - ${alias}` : label,
    body: notificationPreview(body, 180, secrets) || 'Check the saved export job status on your host.' };
}
