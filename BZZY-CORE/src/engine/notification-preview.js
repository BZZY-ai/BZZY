import { database, getRecord } from './database.js';
import { assertShareText, sharedSecrets } from './share-bundle-policy.js';
import { messageBodyToPlainText } from '../message-format.js';

export const GOAL_PREVIEW_CHARACTERS = 180;
export function notificationPreview(value, maximum = GOAL_PREVIEW_CHARACTERS, secrets = []) {
  if (typeof value !== 'string') return '';
  try { assertShareText(value, secrets); } catch { return ''; }
  if (/password|secret|token|credential|api[_ -]?key|authorization|cookie/i.test(value)) return '';
  const text = messageBodyToPlainText(value).replace(/(\*\*|__)(.*?)\1/gs, '$2')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim();
  const characters = [...text];
  return characters.length > maximum ? characters.slice(0, Math.max(0, maximum - 3)).join('').trimEnd() + '...' : text;
}

// Pin a safe preview when Core records the outcome. Delayed APNs dispatch must
// never substitute a later conversation or another goal's answer. No file reads
// or model work are needed to reconstruct the final streamed assistant reply.
export function goalReplyPreview(session, depth = 0) {
  if (!Number.isFinite(Date.parse(session.goal?.createdAt))) return '';
  try {
    const secrets = sharedSecrets();
    const result = session.modeResult?.goalId === session.goal.id ? session.modeResult : null;
    if (result?.conclusions?.length) return notificationPreview(result.conclusions.join(' '), GOAL_PREVIEW_CHARACTERS, secrets);
    if (depth === 0 && ['parallel', 'besties'].includes(session.mode)) {
      const group = getRecord(session.mode, session.id);
      if (group?.goalId === session.goal.id) {
        const replies = (group.peers || []).slice(0, 3).flatMap((peer, index) => {
          const child = getRecord('session', peer.sessionId);
          const reply = child?.parentSessionId === session.id ? goalReplyPreview(child, depth + 1) : '';
          return reply ? [`Agent ${index + 1}: ${reply}`] : [];
        });
        return notificationPreview(replies.join(' · '), GOAL_PREVIEW_CHARACTERS, secrets);
      }
    }
    const rows = database().prepare(`SELECT type,
      substr(json_extract(data,'$.text'),1,131073) AS text,
      json_extract(data,'$.itemId') AS item, json_extract(data,'$.turnId') AS turn,
      json_extract(data,'$.method') AS method
      FROM events WHERE session_id=? AND created_at>=? AND type IN ('text','tool','backend','message.user') ORDER BY seq DESC LIMIT 257`).all(session.id, session.goal.createdAt);
    const chunks = []; let identity, bytes = 0, boundary = false;
    for (const row of rows) {
      if (row.type !== 'text') {
        if (row.type === 'message.user' || chunks.length && (row.type === 'tool' || row.method === 'turn/started')) { boundary = true; break; }
        continue;
      }
      if (typeof row.text !== 'string' || !row.text) continue;
      if (!chunks.length && !row.text.trim()) continue;
      if (identity && (identity.item !== row.item || identity.turn !== row.turn)) { boundary = true; break; }
      identity ||= row; bytes += Buffer.byteLength(row.text);
      if (bytes > 128 * 1024) return '';
      chunks.unshift(row.text);
    }
    if (rows.length === 257 && !boundary) return '';
    return notificationPreview(chunks.join(''), GOAL_PREVIEW_CHARACTERS, secrets);
  } catch { return ''; } // Preview failures must never prevent saving an outcome.
}
