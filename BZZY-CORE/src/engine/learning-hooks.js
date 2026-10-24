import { appendEvent, database, digest } from './database.js';
import { queueLearningReview } from './learning.js';

const eligible = session => session && !session.parentSessionId && !['executor', 'reviewer', 'skill-writer', 'learning-review'].includes(session.role);

function queue(session, reason, sourceId) {
  if (!eligible(session) || !sourceId) return null;
  try {
    return queueLearningReview(session, { reason, sourceId, requestId: digest({ sessionId: session.id, reason, sourceId }) });
  } catch {
    // Assessment persistence must not fail because an optional review cannot be
    // queued. Report a bounded status without leaking private backend errors.
    appendEvent(session.id, 'learning.notice', { status: 'unavailable', message: 'The lesson review could not be queued. Existing investigation records are retained.' });
    return null;
  }
}

export function learningForKnowledge(session, record, kind) {
  if (!record || !eligible(session)) return null;
  if (kind === 'issue' && ['resolved', 'disproved', 'inconclusive'].includes(record.status)) {
    return queue(session, 'finding_outcome', `${record.id}:${record.revision || record.updatedAt || '1'}`);
  }
  if (kind === 'memory' && (['confirmed', 'disproved'].includes(record.truth) || ['failed_approach', 'inconclusive'].includes(record.kind))) {
    return queue(session, 'recorded_lesson', `${record.id}:${record.revision || '1'}`);
  }
  return null;
}

export function learningForTurn(session, prompt, { goal = false, stopped = false } = {}) {
  if (!eligible(session) || stopped) return null;
  if (goal && session.goal?.status === 'complete' && session.acceptance?.passed) return queue(session, 'verified_goal', session.goal.id);
  if (!goal && /\b(?:remember (?:this|that)\b|correction:|that(?:'s| is) (?:wrong|incorrect)\b|actually[, ]|recuerda (?:esto|que)\b|correcci[oó]n:|eso (?:est[aá]|es) (?:mal|incorrecto)\b)/i.test(prompt)) {
    const source = database().prepare("SELECT seq FROM events WHERE session_id=? AND type='message.user' ORDER BY seq DESC LIMIT 1").get(session.id);
    return source ? queue(session, 'user_correction', `${session.id}:${source.seq}`) : null;
  }
  return null;
}
