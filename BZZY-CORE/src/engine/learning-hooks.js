import { appendEvent, database, digest, getRecord, putRecord, now } from './database.js';
import { queueLearningReview, learningSettings } from './learning.js';

const eligible = session => session && !session.parentSessionId && !['executor', 'reviewer', 'skill-writer', 'learning-review'].includes(session.role);

function queue(session, reason, sourceId, scope = {}) {
  if (!eligible(session) || !sourceId) return null;
  try {
    return queueLearningReview(session, { reason, sourceId, ...scope, requestId: digest({ sessionId: session.id, reason, sourceId, ...scope }) });
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

export function learningForTurn(session, prompt, { goal = false, stopped = false, runId } = {}) {
  if (!eligible(session) || stopped) return null;
  if (goal && session.goal?.status === 'complete' && session.acceptance?.passed) return queue(session, 'verified_goal', session.goal.id, { runId, goalMode: true });
  if (goal && ['failed', 'budget_limited'].includes(session.goal?.status)) return queue(session, 'goal_finished', `${session.goal.id}:${session.goal.status}`, { runId, goalMode: true });
  if (!goal && /\b(?:remember (?:this|that)\b|correction:|that(?:'s| is) (?:wrong|incorrect)\b|actually[, ]|recuerda (?:esto|que)\b|correcci[oó]n:|eso (?:est[aá]|es) (?:mal|incorrecto)\b)/i.test(prompt)) {
    const source = database().prepare("SELECT seq FROM events WHERE session_id=? AND type='message.user' ORDER BY seq DESC LIMIT 1").get(session.id);
    return source ? queue(session, 'user_correction', `${session.id}:${source.seq}`, { runId, goalMode: false }) : null;
  }
  return null;
}

// Host observations create review opportunities, not asserted lessons. The
// reviewer can return no change; a temporal retry is never promoted to proof.
export function learningForEpisode(session, episode, { runId, goalMode } = {}) {
  if (!eligible(session) || !episode || episode.sessionId !== session.id) return null;
  runId ??= episode.runId || null;
  goalMode ??= Boolean(episode.goalId);
  if (goalMode && episode.goalId !== session.goal?.id || !goalMode && episode.goalId) return null;
  const settings = learningSettings();
  if (!settings.enabled) return null;
  const count = episode.counts?.attempts ?? episode.attempts?.length ?? 0;
  const solved = (episode.transitions || []).some(item => item.relation === 'candidate-fix' && item.authority === 'temporal-sequence-only');
  const distinct = new Set((episode.attempts || []).map(item => item.operationFingerprint || item.id)).size;
  const meaningful = distinct >= Math.min(3, settings.complexTurnAttempts) || episode.counts?.failed > 0 || episode.counts?.workerReviews > 0;
  const reason = solved ? 'solved_problem' : count >= settings.complexTurnAttempts && meaningful ? 'complex_turn' : null;
  if (!reason) return null;
  const key = digest([session.id, episode.goalId || null, runId, reason]);
  const previous = getRecord('core.learning.trigger', key);
  const eventCutoff = episode.throughSeq || 0;
  if (previous?.throughSeq >= eventCutoff || previous && Date.now() - Date.parse(previous.queuedAt) < settings.minReviewIntervalSeconds * 1000) return null;
  const sourceId = episode.id || `episode:${episode.sourceHash || digest([runId, eventCutoff])}`;
  const job = queue(session, reason, sourceId, { runId, goalMode });
  if (job) putRecord('core.learning.trigger', key, { sessionId: session.id, goalId: episode.goalId || null, runId,
    reason, throughSeq: eventCutoff, jobId: job.id, queuedAt: now() });
  return job;
}

export function learningForWorkerOutcome(session, review, assignment) {
  if (!eligible(session) || !review || !assignment || assignment.parentSessionId !== session.id ||
      assignment.goalId && assignment.goalId !== session.goal?.id || !Array.isArray(review.inspectedEvidence) || !review.inspectedEvidence.length) return null;
  if (!['accepted', 'inconclusive', 'abandoned'].includes(review.outcome)) return null;
  return queue(session, 'worker_outcome', review.id || `${assignment.id}:review:${review.round || assignment.revision || 1}`,
    { runId: assignment.chatRunId || undefined, goalMode: Boolean(assignment.goalId) });
}

export function queueLearningReviewForFeedback(session, feedback) {
  return feedback?.id ? queue(session, 'skill_feedback', feedback.id,
    { runId: feedback.runId || undefined, goalMode: feedback.goalId ? true : false }) : null;
}
