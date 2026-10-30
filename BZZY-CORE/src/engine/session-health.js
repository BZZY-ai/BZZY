import { database, getRecord } from './database.js';
import { routingStatus } from './workflow-routing.js';
import { sessionMemoryEligible, sessionMemoryStatus } from './session-memory.js';

function jobHealth(kind, sessionId) {
  return database().prepare(`SELECT json_extract(data,'$.state') AS state,
    json_extract(data,'$.scheduleReason') AS scheduleReason,
    json_extract(data,'$.reasonPaused') AS reasonPaused,count(*) AS count
    FROM records WHERE kind=? AND json_extract(data,'$.sessionId')=?
    GROUP BY state,scheduleReason,reasonPaused`).all(kind, sessionId).map(row => ({ ...row,
    reason: ['paused', 'cancelled'].includes(row.state)
      ? row.reasonPaused ?? row.scheduleReason : row.scheduleReason ?? row.reasonPaused }));
}
function backlogAge(kind, sessionId) {
  const value = database().prepare(`SELECT count(*) AS pending,min(json_extract(data,'$.createdAt')) AS oldestCreatedAt
    FROM records WHERE kind=? AND json_extract(data,'$.sessionId')=? AND json_extract(data,'$.state')
    IN ('queued','running','waiting_for_configuration','waiting_for_auth','retry_wait','paused')`).get(kind, sessionId);
  return { ...value, oldestAgeSeconds: value.oldestCreatedAt && Number.isFinite(Date.parse(value.oldestCreatedAt))
    ? Math.max(0, Math.floor((Date.now() - Date.parse(value.oldestCreatedAt)) / 1000)) : null };
}

// Read projection only: opening Metrics or exporting never schedules work.
export function sessionHealth(id) {
  const session = getRecord('session', typeof id === 'string' ? id : id?.id);
  if (!session || getRecord('session-deletion', session.id)) return { available: false };
  let memory = null;
  if (sessionMemoryEligible(session)) {
    try { memory = sessionMemoryStatus(session); } catch { memory = { unavailable: true }; }
  }
  const learning = jobHealth('core.learning.job', session.id);
  const compaction = jobHealth('core.session.compactor.job', session.id);
  const routing = routingStatus(session, { limit: 5 }), nativeTools = session.nativeBackendReadiness?.tools;
  const missingRoutingTools = routing.enforced && Array.isArray(nativeTools?.names)
    ? ['declare_work_unit', 'close_work_unit'].filter(name => !nativeTools.names.includes(name)) : [];
  return { version: 1, available: true, goalId: session.goal?.id || null, routing,
    native: { readiness: session.nativeBackendReadiness || null, contextBudget: session.nativeContextBudget || null,
      routingToolCoverage: routing.enforced && session.backend === 'codex' ? { known: Array.isArray(nativeTools?.names),
        missing: missingRoutingTools, basis: nativeTools?.source || 'unknown-native-thread',
        meaning: 'Recorded submitted/inherited tool schemas, not proof of model attention.' } : null,
      compaction: session.nativeContext?.metrics || null, refresh: session.nativeContext?.refresh || null, efficiency: session.contextEfficiency || null },
    memory, memoryDelivery: { details: database().prepare("SELECT data FROM records WHERE kind='core.task-state.detail-read' AND json_extract(data,'$.sessionId')=? LIMIT 32").all(session.id).map(row=>JSON.parse(row.data)), authority: 'Delivery/navigation receipts, not proof of attention or correct use.' }, maintenance: getRecord('core.history.maintenance', session.id), taskState: getRecord('core.task-state.read', session.id),
    episode: getRecord('core.episode.progress', session.id),
    learning: { jobs: learning, outcomes: database().prepare("SELECT json_extract(data,'$.failureKind') AS failureKind,json_extract(data,'$.result.noChange') AS noChange,json_extract(data,'$.state') AS state,count(*) AS count FROM records WHERE kind='core.learning.job' AND json_extract(data,'$.sessionId')=? GROUP BY failureKind,noChange,state").all(session.id), backlog: backlogAge('core.learning.job', session.id), policy: 'Closed work episodes, meaningful outcomes, skill feedback and corrections may queue bounded reviews. No-change is a valid result.' },
    retention: { jobs: compaction, backlog: backlogAge('core.session.compactor.job', session.id), control: getRecord('core.session.compactor.control', session.id) } };
}
