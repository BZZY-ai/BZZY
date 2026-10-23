import { randomUUID } from 'node:crypto';
import { ensureRuntime, runtimeRequest, requireOwner } from './runtime.js';
import { delay } from './delegation.js';
import { loadSession, sessionPath, writeJson } from './store.js';
import { prepareTask } from './task.js';
import { newGoal } from './goals.js';
import { getProvider } from './providers.js';
import { assertModelIdle, assertSessionIdle } from './models.js';
import { transaction, getRecord, putRecord, listRecords, appendEvent, now } from './database.js';
import { conversationCursor } from './conversation.js';
import { enqueueExecution } from './execution-queue.js';
import { normalizeContract } from './contracts.js';
import { budgetUsage } from './delegation-usage.js';
import { reconcileSession } from './recovery.js';

const executionActive = execution => execution && ['queued', 'launching', 'running'].includes(execution.state);

// Host-side operations shared by terminal and other trusted Core adapters.
// Remote clients must enter through an authenticated Core gateway; input
// ownership is checked again inside each mutating transaction.
export function executionRecord(id) {
  return getRecord('execution', id);
}

export async function enqueueGoalTurn(sessionId, owner, options, { resume = false, objective, requestId = randomUUID(), info } = {}) {
  if (!resume) {
    if (!objective?.trim()) throw new Error('Supply an objective to start persistent work.');
    const runtime = info || await ensureRuntime();
    const api = (method, action = '', body, id) => runtimeRequest(runtime, method, `/sessions/${sessionId}${action ? '/' + action : ''}`, body ? { ...body, owner } : body, id);
    const busy = snapshot => {
      if (executionActive(snapshot.execution)) return true;
      if (!snapshot.capabilities.chatTabs) return false;
      const children = new Set(snapshot.children.map(child => child.id));
      return listRecords('execution').some(job => children.has(job.sessionId) && executionActive(job));
    };
    let snapshot = await api('GET');
    if (busy(snapshot)) {
      await api('POST', 'control', { action: 'cancel' }, randomUUID());
      const deadline = Date.now() + 15000;
      do {
        if (Date.now() >= deadline) throw new Error('The previous run is still stopping. Retry once it stops.');
        await delay(50); snapshot = await api('GET');
      } while (busy(snapshot));
    }
  }
  if (resume) {
    requireOwner(sessionId, owner);
    const recovery = reconcileSession(sessionId);
    if (recovery.state === 'cleanup_required') throw new Error(recovery.reason);
    if (recovery.live) throw new Error('This goal is already running. Watch its current execution instead of starting another.');
  }
  const prompt = resume ? 'Continue the saved goal from its verified checkpoint and assignment history.' : objective;
  return enqueueExecution(sessionId, { prompt, options, goal: true, resumeGoal: resume }, requestId, {
    authorize: () => requireOwner(sessionId, owner),
    prepare: (fresh, db) => {
      if (resume) {
        if (!fresh.goal || fresh.goal.status === 'complete') throw new Error('There is no unfinished goal to resume.');
        if (options.tokenBudget) fresh.goal.tokenBudget = options.tokenBudget;
        if (fresh.goal.tokenBudget != null && budgetUsage(fresh) >= fresh.goal.tokenBudget) throw new Error('Goal budget is exhausted. Increase the total token budget before resuming.');
        Object.assign(fresh.goal, { notificationEpoch: (fresh.goal.notificationEpoch || 0) + 1, noActivityTurns: 0, blockerStreak: 0, lastBlocker: null });
        delete fresh.goal.reason;
      } else {
        if (!objective?.trim()) throw new Error('Supply an objective to start persistent work.');
        const previousGoal = fresh.goal;
        const boundary = fresh.contract, strict = fresh.strictPolicy;
        prepareTask(fresh, options, objective, { persist: false });
        if (boundary && !options.contract) {
          fresh.contract = normalizeContract({ ...fresh.contract, constraints: [...new Set([...boundary.constraints, ...fresh.contract.constraints])],
            scope: { ...fresh.contract.scope, ...boundary.scope }, policy: options.readOnly ? { ...boundary.policy, mode: 'read-only', writablePaths: [] } : boundary.policy,
            limits: { ...boundary.limits, ...fresh.contract.limits } }, objective);
          fresh.policy = fresh.contract.policy; fresh.strictPolicy ||= strict;
        }
        fresh.goal = newGoal(objective, options.tokenBudget || fresh.contract.limits.tokenBudget);
        fresh.acceptance = null; fresh.summary = null; fresh.failure = null; fresh.stopReason = null;
        if (previousGoal) putRecord('goal-history', previousGoal.id, { sessionId: fresh.id, ...previousGoal,
          supersededAt: now(), supersededBy: fresh.goal.id }, db);
      }
      fresh.updatedAt = now(); putRecord('session', fresh.id, fresh, db);
    },
  });
}

export function updateIdleGoal(sessionId, owner, action) {
  if (!['pause', 'cancel', 'clear'].includes(action)) throw new Error('Unknown goal operation.');
  const changed = transaction(db => {
    requireOwner(sessionId, owner); const fresh = loadSession(sessionId); assertSessionIdle(fresh);
    if (!fresh.goal) throw new Error('This session has no goal.');
    if (action === 'clear') { putRecord('goal-history', fresh.goal.id, { sessionId: fresh.id, ...fresh.goal, clearedAt: now() }, db); fresh.goal = null; }
    else fresh.goal.status = action === 'cancel' ? 'cancelled' : 'paused';
    fresh.updatedAt = now(); putRecord('session', fresh.id, fresh, db);
    appendEvent(fresh.id, 'lifecycle', { status: fresh.goal?.status || null, executionState: fresh.executionState, reason: 'user_' + action }, db); return fresh;
  });
  writeJson(sessionPath(changed.id), changed); return changed;
}

function editSession(sessionId, owner, apply, authorize) {
  const session = transaction(db => {
    requireOwner(sessionId, owner); authorize?.();
    const current = loadSession(sessionId); assertModelIdle(current);
    apply(current, db); current.updatedAt = now();
    putRecord('session', sessionId, current, db);
    return current;
  });
  writeJson(sessionPath(sessionId), session);
  return session;
}

export function setSessionModel(sessionId, owner, selected, { authorize } = {}) {
  return editSession(sessionId, owner, (session, db) => {
    const previous = session.model;
    Object.assign(session, { model: selected.model, resolvedModel: null, modelCapabilities: selected.capabilities, selectedEffort: selected.effort, reasoningEffort: null });
    appendEvent(session.id, 'model.changed', { provider: session.provider, previousModel: previous, model: session.model, effort: session.selectedEffort, appliesTo: 'next_turn' }, db);
  }, authorize);
}

export function setSessionProvider(sessionId, owner, expectedProvider, providerId, selected, { authorize } = {}) {
  const provider = getProvider(providerId);
  return editSession(sessionId, owner, (session, db) => {
    if (session.provider !== expectedProvider) throw new Error('The provider changed while selection was open. Choose it again.');
    const previous = { provider: session.provider, model: session.model, threadId: session.engineThreadId };
    Object.assign(session, {
      provider: provider.id, backend: provider.backend, model: selected.model, modelCapabilities: selected.capabilities, selectedEffort: selected.effort,
      engineThreadId: null, engineSessionId: provider.backend === 'claude' ? randomUUID() : null, engineHome: null,
      resolvedModel: null, reasoningEffort: null, failure: null, executionState: 'idle',
      engineTokenOffset: session.usage?.tokens || 0,
      conversationHandoff: { throughSeq: conversationCursor(session.id, db), pending: true },
    });
    if (session.goal) {
      const ownTokens = session.goal.nativeTokensUsed ?? session.goal.supervisorTokensUsed ?? Math.max(0, (session.goal.tokensUsed || 0) - (session.goal.delegatedTokensUsed || 0));
      session.goal.supervisorTokensUsed = ownTokens; session.goal.nativeTokenOffset = ownTokens;
      delete session.goal.nativeTokensUsed; delete session.goal.nativeGoalId; delete session.goal.nativeStatus;
    }
    appendEvent(session.id, 'provider.changed', { previousProvider: previous.provider, previousModel: previous.model, previousThreadId: previous.threadId,
      provider: session.provider, model: session.model, effort: session.selectedEffort, conversationThrough: session.conversationHandoff.throughSeq, appliesTo: 'next_turn' }, db);
  }, authorize);
}
