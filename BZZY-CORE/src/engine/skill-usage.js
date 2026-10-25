import { getRecord, putRecord, appendEvent, transaction, digest, now } from './database.js';
import { resolveSessionMetricsScope } from './session-metrics.js';

const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);

// Only a live model tool host supplies this context. Browsing the library or
// remembering a skill name is not an invocation, even with a saved goal present.
export function modelSkillUsageContext(session, context = {}) {
  if (!uuid(session?.id) || !uuid(context.runId) || typeof context.goalMode !== 'boolean') return null;
  const run = getRecord('run', session.id), saved = getRecord('session', session.id);
  if (!saved || run?.id !== context.runId || run.state !== 'running' ||
      typeof run.goalMode === 'boolean' && run.goalMode !== context.goalMode) return null;
  const goalId = context.goalMode ? session.goal?.id : null;
  if (context.goalMode && (!uuid(goalId) || saved.goal?.id !== goalId)) return null;
  return { sessionId: session.id, runId: run.id, goalId, goalMode: context.goalMode };
}

export function recordModelSkillUse(session, skill, context) {
  if (!context || context.sessionId !== session.id || skill.file !== 'SKILL.md' || !skill.text) return null;
  const id = digest([session.id, context.runId, skill.id, skill.version]);
  return transaction(db => {
    const previous = getRecord('core.usage', id);
    if (previous) return previous;
    const scope = resolveSessionMetricsScope(session.id, { goalId: context.goalId, goalMode: context.goalMode });
    const record = { id, version: 1, kind: 'skill', sessionId: session.id, runId: context.runId, goalId: context.goalId,
      skillId: skill.id, name: skill.name, skillVersion: skill.version, scope: skill.scope, projectId: skill.projectId || null,
      ...scope, createdAt: now() };
    putRecord('core.usage', id, record, db);
    appendEvent(session.id, 'core.usage', record, db);
    // The root chat observes actual worker loads without inventing a second
    // invocation. Both streams carry the exact same authoritative receipt.
    if (uuid(scope.rootSessionId) && scope.rootSessionId !== session.id && ['goal', 'chat'].includes(scope.attribution) &&
        getRecord('session', scope.rootSessionId) && !getRecord('session-deletion', scope.rootSessionId)) {
      appendEvent(scope.rootSessionId, 'core.usage', record, db);
    }
    return record;
  });
}
