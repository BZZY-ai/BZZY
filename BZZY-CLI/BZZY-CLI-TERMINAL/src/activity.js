import { randomUUID } from 'node:crypto';
import { getRecord, putRecord, listRecords, appendEvent, now } from './database.js';
import { writeProjectRecord } from './project.js';

export function recordActivity(session, input, ui, { provenance = 'agent-reported', source = 'activity-tool', toolCallId = null } = {}) {
  if (typeof input.summary !== 'string' || !input.summary.trim() || input.summary.length > 500 || typeof input.details !== 'string' || input.details.length > 16000) throw new Error('Activity needs a short summary (up to 500 characters) and details (up to 16,000).');
  const id = input.id || randomUUID(), previous = getRecord('activity', id);
  if (!/^[a-f0-9-]{36}$/.test(id) || (previous && previous.sessionId !== session.id)) throw new Error('Invalid activity record.');
  if (!['planned', 'running', 'completed', 'blocked', 'inconclusive'].includes(input.status || 'running')) throw new Error('Invalid activity status.');
  const evidence = input.evidence || [];
  if (!Array.isArray(evidence) || evidence.some(ref => getRecord('artifact', ref)?.sessionId !== session.id)) throw new Error('Activity evidence must belong to this session.');
  const record = { id, sessionId: session.id, agent: session.agentNamespace || session.provider, summary: input.summary, details: input.details,
    category: input.category || 'assessment', target: input.target || null, status: input.status || 'running', evidence,
    observation: input.observation || '', inference: input.inference || '', nextCheck: input.nextCheck || '', issueId: input.issueId || null,
    provenance, source, toolCallId, executionActive: (input.status || 'running') === 'running', createdAt: previous?.createdAt || now(), updatedAt: now() };
  putRecord('activity', id, record);
  if (ui) ui.event('activity', record); else appendEvent(session.id, 'activity', record);
  writeProjectRecord(session, 'activities', id, record);
  if (session.parentSessionId) appendEvent(session.parentSessionId, 'activity', record);
  return record;
}

export function closeOpenActivities(session) {
  for (const previous of listRecords('activity').filter(a => a.sessionId === session.id && !a.closedAt && ['running', 'planned'].includes(a.status))) {
    const record = { ...previous, executionActive: false, closedAt: now(), updatedAt: now(), closureReason: 'execution_ended', executionOutcome: session.goal?.status || session.executionState };
    putRecord('activity', record.id, record); appendEvent(session.id, 'activity', record); writeProjectRecord(session, 'activities', record.id, record);
    if (session.parentSessionId) appendEvent(session.parentSessionId, 'activity', record);
  }
}
