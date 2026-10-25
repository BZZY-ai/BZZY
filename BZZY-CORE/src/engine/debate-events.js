import { appendEvent, database, transaction } from './database.js';
import { loadSession } from './store.js';
import { recordGoalValidationResult } from './goal-validation.js';

export const debateIdentity = session => session.goal?.id || session.id;
export const debateParticipants = (session, choices) => choices.map((choice, index) => ({ id: `${debateIdentity(session)}:participant:${index}`,
  index, label: index === 0 ? 'Main' : 'Reviewer ' + index,
  provider: choice.provider, model: choice.model || null }));

export function debateEventUI(session, ui, choices = session.debateAgents || []) {
  if (ui.debateEventSessionId === session.id) return ui;
  const wrapped = Object.create(ui);
  wrapped.debateEventSessionId = session.id;
  wrapped.event = (type, data = {}) => {
    if (type === 'summary') return ui.event(type, { ...data, debateId: debateIdentity(session) });
    if (!['debate.started', 'debate.phase', 'debate.message', 'debate.result'].includes(type)) return ui.event(type, data);
    const debateId = debateIdentity(session), participants = debateParticipants(session, choices);
    const participant = Number.isSafeInteger(data.participantIndex) ? participants[data.participantIndex] : null;
    const value = { ...data, debateId, sessionId: session.id,
      ...(type === 'debate.result' ? { elapsedSeconds: session.goal?.runtimeUsedSeconds || 0, usage: session.summary?.usage || data.usage } : {}),
      ...(participant ? { participantId: participant.id, provider: participant.provider, model: participant.model } : {}) };
    if (!ui.persistsEvents) appendEvent(session.id, type, value);
    ui.event(type, value);
    const sourceId = session.reviewSource?.sessionId;
    if (sourceId && sourceId === session.parentSessionId && loadSession(sourceId)) {
      const mirrored = { ...value, sourceSessionId: sourceId };
      if (type === 'debate.result') appendDebateResultOnce(sourceId, mirrored);
      else appendEvent(sourceId, type, mirrored);
      if (type === 'debate.result') {
        try { recordGoalValidationResult(session); } catch { /* A derived badge cannot change the durable review outcome. */ }
      }
    }
  };
  return wrapped;
}

export function hasDebateResult(sessionId, debateId) {
  return Boolean(database().prepare("SELECT 1 FROM events WHERE session_id=? AND type='debate.result' AND json_extract(data,'$.debateId')=? LIMIT 1").get(sessionId, debateId));
}

export function latestDebateResult(sessionId, debateId) {
  const row = database().prepare("SELECT data FROM events WHERE session_id=? AND type='debate.result' AND json_extract(data,'$.debateId')=? ORDER BY seq DESC LIMIT 1").get(sessionId, debateId);
  return row ? JSON.parse(row.data) : null;
}

export function appendDebateResultOnce(sessionId, value) {
  const append = db => hasDebateResult(sessionId, value.debateId) ? false : appendEvent(sessionId, 'debate.result', value, db);
  return database().isTransaction ? append(database()) : transaction(append);
}
