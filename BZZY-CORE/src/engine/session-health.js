import { database, getRecord } from './database.js';
import { routingStatus } from './workflow-routing.js';
import { sessionMemoryEligible, sessionMemoryStatus } from './session-memory.js';

// Read projection only: opening Metrics or exporting never schedules work.
export function sessionHealth(id) {
  const session = getRecord('session', typeof id === 'string' ? id : id?.id);
  if (!session || getRecord('session-deletion', session.id)) return { available: false };
  let memory = null;
  if (sessionMemoryEligible(session)) {
    try { memory = sessionMemoryStatus(session); } catch { memory = { unavailable: true }; }
  }
  const learning = database().prepare(`SELECT json_extract(data,'$.state') AS state,
    coalesce(json_extract(data,'$.scheduleReason'),json_extract(data,'$.reasonPaused')) AS reason,count(*) AS count
    FROM records WHERE kind='core.learning.job' AND json_extract(data,'$.sessionId')=? GROUP BY state,reason`).all(session.id);
  const compaction = database().prepare(`SELECT json_extract(data,'$.state') AS state,
    coalesce(json_extract(data,'$.scheduleReason'),json_extract(data,'$.reasonPaused')) AS reason,count(*) AS count
    FROM records WHERE kind='core.session.compactor.job' AND json_extract(data,'$.sessionId')=? GROUP BY state,reason`).all(session.id);
  return { version: 1, available: true, goalId: session.goal?.id || null, routing: routingStatus(session, { limit: 5 }),
    native: { readiness: session.nativeBackendReadiness || null, contextBudget: session.nativeContextBudget || null,
      compaction: session.nativeContext?.metrics || null, refresh: session.nativeContext?.refresh || null, efficiency: session.contextEfficiency || null },
    memory, maintenance: getRecord('core.history.maintenance', session.id), taskState: getRecord('core.task-state.read', session.id),
    learning: { jobs: learning, policy: 'Meaningful outcomes and corrections may queue reviews; absent output does not prove learning is disabled.' },
    retention: { jobs: compaction, control: getRecord('core.session.compactor.control', session.id) } };
}
