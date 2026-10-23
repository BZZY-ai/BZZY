import { reserveRequest, transaction, getRecord, putRecord, listRecords, appendEvent, now } from './database.js';
import { loadSession } from './store.js';
import { effectivePolicy } from './policy.js';

export function terminalYolo(sessionId) {
  if (typeof sessionId !== 'string' || !/^[a-f0-9-]{36}$/.test(sessionId)) return null;
  const seen = new Set();
  for (let session = loadSession(sessionId); session && seen.size < 64 && !seen.has(session.id); session = session.parentSessionId && loadSession(session.parentSessionId)) {
    seen.add(session.id);
    if (session.purpose === 'agent' || session.agentId || session.contract?.policy?.mode === 'read-only' || session.policy?.mode === 'read-only') return false;
    const saved = getRecord('terminal-permissions', session.id);
    if (saved) return saved.yolo === true;
  }
  return null;
}

// Trusted host adapter only. Relay additionally requires the fully approved
// own-phone grant. This record is deliberately absent from portable exports.
export function setTerminalYolo(sessionId, { enabled, questionId }, requestId, { authorize } = {}) {
  if (!authorize) throw new Error('Permission changes require an authorized owner.');
  authorize();
  if (typeof enabled !== 'boolean' || questionId !== undefined && (typeof questionId !== 'string' || !/^[a-f0-9-]{36}$/.test(questionId))) throw new Error('Choose a boolean YOLO mode and an optional pending approval ID.');
  if (questionId && !enabled) throw Object.assign(new Error('Only enabling YOLO can approve a pending request.'), { code: 'INVALID_REQUEST' });
  return reserveRequest(`permissions:${sessionId}`, requestId, { enabled, questionId }, db => {
    authorize(); const session = loadSession(sessionId);
    if (!session || session.purpose && session.purpose !== 'terminal' || session.agentId) throw Object.assign(new Error('YOLO is available only for ordinary terminals.'), { code: 'FORBIDDEN' });
    const related = [session], ids = new Set([sessionId]);
    for (let index = 0; index < related.length; index++) for (const child of listRecords('session', { parentSessionId: related[index].id })) {
      if (!ids.has(child.id)) {
        if (related.length >= 256) throw Object.assign(new Error('This terminal tree exceeds the permission review limit.'), { code: 'CAPACITY' });
        ids.add(child.id); related.push(child);
      }
    }
    if (session.parentSessionId) {
      for (let parent = loadSession(session.parentSessionId), depth = 0; parent && depth < 64; parent = parent.parentSessionId && loadSession(parent.parentSessionId), depth++)
        if (parent.purpose === 'agent' || parent.agentId) throw Object.assign(new Error('YOLO is unavailable for isolated Agents.'), { code: 'FORBIDDEN' });
    }
    if (enabled) for (const current of related) {
      if (current.policy?.mode === 'read-only') throw Object.assign(new Error('YOLO cannot widen enforced read-only access.'), { code: 'FORBIDDEN' });
      try { effectivePolicy(current, { yolo: true }); }
      catch { throw Object.assign(new Error('YOLO cannot widen enforced read-only access.'), { code: 'FORBIDDEN' }); }
    }
    const active = listRecords('execution', { sessionIds: [...ids], states: ['queued', 'launching', 'running'], limit: 1 }).length > 0;
    const question = questionId && getRecord('question', questionId);
    if (questionId && (!question || !ids.has(question.sessionId) || question.kind !== 'approval' || question.state !== 'pending' || question.expiresAt && question.expiresAt <= Date.now()))
      throw Object.assign(new Error('This approval is no longer pending. Refresh the chat.'), { code: 'CONFLICT' });
    if (active && (!enabled || !question)) throw Object.assign(new Error('Pause the current run before changing YOLO, or enable it on a pending approval.'), { code: 'CONFLICT' });
    putRecord('terminal-permissions', sessionId, { sessionId, yolo: enabled, updatedAt: now() }, db);
    if (enabled && question) {
      putRecord('question', question.id, { ...question, state: 'answered', answer: 'yes', answeredAt: now(), answeredBy: 'host-yolo' }, db);
      appendEvent(question.sessionId, 'question.answered', { id: question.id, answer: 'yes', source: 'host-yolo' }, db);
    }
    appendEvent(sessionId, 'permissions.changed', { yolo: enabled, ...(question ? { approvedQuestionId: question.id } : {}) }, db);
    return { yolo: enabled, ...(question ? { approvedQuestionId: question.id } : {}) };
  });
}

export function approvePendingWithYolo(questionId, sessionId) {
  return transaction(db => {
    const question = getRecord('question', questionId);
    if (!question || question.sessionId !== sessionId || question.kind !== 'approval' || question.state !== 'pending'
      || question.expiresAt && question.expiresAt <= Date.now() || terminalYolo(sessionId) !== true) return false;
    putRecord('question', question.id, { ...question, state: 'answered', answer: 'yes', answeredAt: now(), answeredBy: 'host-yolo' }, db);
    appendEvent(sessionId, 'question.answered', { id: question.id, answer: 'yes', source: 'host-yolo' }, db);
    return true;
  });
}
