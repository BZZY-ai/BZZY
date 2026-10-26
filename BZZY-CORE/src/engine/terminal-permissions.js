import { reserveRequest, transaction, getRecord, putRecord, listRecords, appendEvent, now } from './database.js';
import { loadSession, sessionPath, writeJson } from './store.js';
import { effectivePolicy } from './policy.js';
import { normalizePolicy } from './contracts.js';
import { randomUUID } from 'node:crypto';
import { identityAlive } from './process-identity.js';

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
function changeTerminalYolo(sessionId, { enabled, questionId }, requestId, { authorize } = {}, attached = false) {
  if (!authorize) throw new Error('Permission changes require an authorized owner.');
  authorize();
  if (typeof enabled !== 'boolean' || questionId !== undefined && (typeof questionId !== 'string' || !/^[a-f0-9-]{36}$/.test(questionId))) throw new Error('Choose a boolean YOLO mode and an optional pending approval ID.');
  if (questionId && !enabled) throw Object.assign(new Error('Only enabling YOLO can approve a pending request.'), { code: 'INVALID_REQUEST' });
  return reserveRequest(`permissions:${sessionId}`, requestId, { enabled, questionId, ...(attached ? { source: 'cli-attach-yolo' } : {}) }, db => {
    authorize(); let session = loadSession(sessionId);
    if (!session || session.purpose && session.purpose !== 'terminal' || session.agentId) throw Object.assign(new Error('YOLO is available only for ordinary terminals.'), { code: 'FORBIDDEN' });
    if (attached && (session.parentSessionId || session.parallelSessionId || session.canvasParentId || session.assignmentId || session.role || session.reviewSource))
      throw Object.assign(new Error('Attach with --yolo to the parent terminal. Isolated workers and reviews retain their own policies.'), { code: 'FORBIDDEN' });
    const related = [session], ids = new Set([sessionId]);
    for (let index = 0; !attached && index < related.length; index++) for (const child of listRecords('session', { parentSessionId: related[index].id })) {
      if (!ids.has(child.id)) {
        if (related.length >= 256) throw Object.assign(new Error('This terminal tree exceeds the permission review limit.'), { code: 'CAPACITY' });
        ids.add(child.id); related.push(child);
      }
    }
    if (session.parentSessionId) {
      for (let parent = loadSession(session.parentSessionId), depth = 0; parent && depth < 64; parent = parent.parentSessionId && loadSession(parent.parentSessionId), depth++)
        if (parent.purpose === 'agent' || parent.agentId) throw Object.assign(new Error('YOLO is unavailable for isolated Agents.'), { code: 'FORBIDDEN' });
    }
    // Reattachment must not fail just because an already-YOLO terminal is live,
    // or because historical/current reviewers have narrower permissions.
    if (attached && terminalYolo(sessionId) === true) return { yolo: true };
    const active = listRecords('execution', { sessionIds: attached ? [sessionId] : [...ids], states: ['queued', 'launching', 'running'], limit: 1 }).length > 0
      || attached && ['running', 'waiting_for_input', 'verifying'].includes(session.executionState) && identityAlive(getRecord('run', sessionId)?.runner);
    if (attached && active) throw Object.assign(new Error('Pause the current non-YOLO run before enabling --yolo on attachment. Already-YOLO runs can be reattached without pausing.'), { code: 'CONFLICT' });
    let policyUpgraded = false;
    if (attached && (session.policy?.mode === 'read-only' || session.contract?.policy?.mode === 'read-only')) {
      if (session.mode === 'debate') throw Object.assign(new Error('Read-only validation contexts cannot be widened. Attach to their source terminal.'), { code: 'FORBIDDEN' });
      const previousPolicy = session.policy || null, previousContractPolicy = session.contract?.policy || null;
      const original = normalizePolicy(previousContractPolicy || previousPolicy || {});
      const policy = { ...original, mode: 'workspace-write', writablePaths: original.mode === 'read-only' ? ['.'] : original.writablePaths,
        network: previousPolicy?.network === 'disabled' ? 'disabled' : original.network };
      session = { ...session, policy, ...(session.contract ? { contract: { ...session.contract, policy } } : {}), updatedAt: now() };
      const id = randomUUID();
      putRecord('terminal-policy-change', id, { id, sessionId, goalId: session.goal?.id || null, source: 'cli-attach-yolo',
        previousPolicy, previousContractPolicy, policy, occurredAt: now() }, db);
      putRecord('session', sessionId, session, db);
      appendEvent(sessionId, 'permissions.policy-updated', { id, source: 'cli-attach-yolo', mode: policy.mode }, db);
      policyUpgraded = true;
    }
    if (enabled) for (const current of attached ? [session] : related) {
      if (current.policy?.mode === 'read-only') throw Object.assign(new Error('YOLO cannot widen enforced read-only access.'), { code: 'FORBIDDEN' });
      try { effectivePolicy(current, { yolo: true }); }
      catch { throw Object.assign(new Error('YOLO cannot widen enforced read-only access.'), { code: 'FORBIDDEN' }); }
    }
    const question = questionId && getRecord('question', questionId);
    if (questionId && (!question || !ids.has(question.sessionId) || question.kind !== 'approval' || question.state !== 'pending' || question.expiresAt && question.expiresAt <= Date.now()))
      throw Object.assign(new Error('This approval is no longer pending. Refresh the chat.'), { code: 'CONFLICT' });
    if (active && (!enabled || !question)) throw Object.assign(new Error('Pause the current run before changing YOLO, or enable it on a pending approval.'), { code: 'CONFLICT' });
    putRecord('terminal-permissions', sessionId, { sessionId, yolo: enabled, updatedAt: now() }, db);
    if (enabled && question) {
      putRecord('question', question.id, { ...question, state: 'answered', answer: 'yes', answeredAt: now(), answeredBy: 'host-yolo' }, db);
      appendEvent(question.sessionId, 'question.answered', { id: question.id, answer: 'yes', source: 'host-yolo' }, db);
    }
    appendEvent(sessionId, 'permissions.changed', { yolo: enabled, ...(attached ? { source: 'cli-attach-yolo' } : {}), ...(question ? { approvedQuestionId: question.id } : {}) }, db);
    return { yolo: enabled, ...(policyUpgraded ? { policyUpgraded: true } : {}), ...(question ? { approvedQuestionId: question.id } : {}) };
  });
}

export function setTerminalYolo(sessionId, input, requestId, authorization) {
  return changeTerminalYolo(sessionId, input, requestId, authorization);
}

// Explicit owner CLI flag, not a model tool or a remotely supplied option. This
// can authorize writes in an idle parent workspace without changing its children,
// scope, network restrictions, goal text, evidence or pinned workflow.
export function enableAttachedTerminalYolo(sessionId, requestId, authorization) {
  const result = changeTerminalYolo(sessionId, { enabled: true }, requestId, authorization, true);
  if (result.policyUpgraded) writeJson(sessionPath(sessionId), getRecord('session', sessionId));
  return result;
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
