import { randomUUID } from 'node:crypto';
import { getWorkerBudgetSettings } from './worker-budget.js';
import { ensureRuntime, runtimeRequest, requireOwner } from './runtime.js';
import { delay } from './delegation.js';
import { loadSession, sessionPath, writeJson, recordSessionLifecycle } from './store.js';
import { prepareTask } from './task.js';
import { newGoal, needsGoalReplacement } from './goals.js';
import { getProvider, selectionFromSession, defaultSelection, modeDefault } from './providers.js';
import { assertModelIdle, assertSessionIdle } from './models.js';
import { reserveRequest, database, transaction, getRecord, putRecord, listRecords, appendEvent, now } from './database.js';
import { conversationCursor } from './conversation.js';
import { enqueueExecution } from './execution-queue.js';
import { normalizeContract } from './contracts.js';
import { budgetUsage, delegationUsage } from './delegation-usage.js';
import { reconcileSession } from './recovery.js';
import { isStalledGoal } from './goal-state.js';

const executionActive = execution => execution && ['queued', 'launching', 'running'].includes(execution.state);

// Host-side operations shared by terminal and other trusted Core adapters.
// Remote clients must enter through an authenticated Core gateway; input
// ownership is checked again inside each mutating transaction.
export function executionRecord(id) {
  return getRecord('execution', id);
}

export async function enqueueGoalTurn(sessionId, owner, options = {}, { resume = false, objective, requestId = randomUUID(), info, authorize, request, replaceGoalId, resumeGoalId, resumeGoalStatus, channel, environment } = {}) {
  const permit = (permission = 'execute') => { requireOwner(sessionId, owner); authorize?.(permission); };
  const confirmReplacement = fresh => {
    if (!resume && needsGoalReplacement(fresh.goal) && replaceGoalId !== fresh.goal.id) {
      throw Object.assign(new Error('Replace current goal? Confirm the current goal before starting another.'), { code: 'CONFIRMATION_REQUIRED', status: 409 });
    }
    if (!resume && replaceGoalId && fresh.goal?.id !== replaceGoalId) {
      throw Object.assign(new Error('The current goal changed. Review it before replacing it.'), { code: 'CONFLICT', status: 409 });
    }
  };
  permit();
  const prompt = resume ? 'Continue the saved goal from its verified checkpoint and assignment history.' : objective;
  // A duplicate request must reach the queue's digest check before cancellation
  // or recovery: it may be the very execution currently being observed.
  const accepted = database().prepare('SELECT response FROM requests WHERE scope=? AND id=?').get(`execute:${sessionId}`, requestId);
  if (accepted?.response) return enqueueExecution(sessionId, { prompt, options, goal: true, resumeGoal: resume, replaceGoalId, resumeGoalId, environment }, requestId, { authorize: permit });
  confirmReplacement(loadSession(sessionId));
  if (!resume) {
    if (!objective?.trim()) throw new Error('Supply an objective to start persistent work.');
    const runtime = request ? null : info || await ensureRuntime();
    const api = request || ((method, action = '', body, id) => runtimeRequest(runtime, method, `/sessions/${sessionId}${action ? '/' + action : ''}`, body ? { ...body, owner } : body, id));
    const busy = snapshot => {
      if (executionActive(snapshot.execution)) return true;
      if (!snapshot.capabilities.chatTabs) return false;
      const children = new Set(snapshot.children.map(child => child.id));
      return listRecords('execution').some(job => children.has(job.sessionId) && executionActive(job));
    };
    let snapshot = await api('GET');
    permit(); confirmReplacement(loadSession(sessionId));
    if (busy(snapshot)) {
      permit('cancel');
      await api('POST', 'control', { action: 'cancel' }, randomUUID());
      const deadline = Date.now() + 15000;
      do {
        if (Date.now() >= deadline) throw new Error('The previous run is still stopping. Retry once it stops.');
        await delay(50); snapshot = await api('GET'); permit(); confirmReplacement(loadSession(sessionId));
      } while (busy(snapshot));
    }
  }
  if (resume) {
    permit();
    const recovery = reconcileSession(sessionId);
    if (recovery.state === 'cleanup_required') throw new Error(recovery.reason);
    if (recovery.live) throw new Error('This goal is already running. Watch its current execution instead of starting another.');
  }
  return enqueueExecution(sessionId, { prompt, options, goal: true, resumeGoal: resume, replaceGoalId, resumeGoalId, environment }, requestId, {
    authorize: permit,
    channel,
    prepare: (fresh, db) => {
      confirmReplacement(fresh);
      if (resume) {
        if (!fresh.goal || fresh.goal.status === 'complete') throw new Error('There is no unfinished goal to resume.');
        if (resumeGoalId !== undefined && (fresh.goal.id !== resumeGoalId || (resumeGoalStatus === 'paused' ? fresh.goal.status !== 'paused' : !isStalledGoal(fresh.goal)))) throw Object.assign(new Error('The stalled goal changed. Refresh before resuming.'), { code: 'CONFLICT', status: 409 });
        if (options.tokenBudget) fresh.goal.tokenBudget = options.tokenBudget;
        if (fresh.goal.tokenBudget != null && Math.max(fresh.goal.tokensUsed || 0, budgetUsage(fresh)) >= fresh.goal.tokenBudget) throw new Error('Goal budget is exhausted. Increase the total token budget before resuming.');
        Object.assign(fresh.goal, { notificationEpoch: (fresh.goal.notificationEpoch || 0) + 1, noActivityTurns: 0, blockerStreak: 0, lastBlocker: null });
        delete fresh.goal.reason;
      } else {
        if (!objective?.trim()) throw new Error('Supply an objective to start persistent work.');
        const previousGoal = fresh.goal;
        const boundary = fresh.contract, strict = fresh.strictPolicy;
        prepareTask(fresh, { ...options, mode: fresh.mode || options.mode || 'solo',
          ...(fresh.mode === 'delegate' && fresh.executor ? { executor: fresh.executor.provider, executorModel: fresh.executor.model } : {}),
          ...(fresh.mode === 'debate' && fresh.debateAgents ? { debateAgents: fresh.debateAgents } : {}) }, objective, { persist: false });
        if (boundary && !options.contract) {
          fresh.contract = normalizeContract({ ...fresh.contract, constraints: [...new Set([...boundary.constraints, ...fresh.contract.constraints])],
            scope: { ...fresh.contract.scope, ...boundary.scope }, policy: options.readOnly ? { ...boundary.policy, mode: 'read-only', writablePaths: [] } : boundary.policy,
            limits: { ...boundary.limits, ...fresh.contract.limits } }, objective);
          fresh.policy = fresh.contract.policy; fresh.strictPolicy ||= strict;
        }
        fresh.goal = newGoal(objective, options.tokenBudget || fresh.contract.limits.tokenBudget, { workerBudgetPolicy: getWorkerBudgetSettings() });
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
    const previous = structuredClone(fresh);
    if (action === 'clear') { putRecord('goal-history', fresh.goal.id, { sessionId: fresh.id, ...fresh.goal, clearedAt: now() }, db); fresh.goal = null; }
    else {
      if (!(action === 'pause' && fresh.goal.status === 'complete')) { fresh.goal.status = action === 'cancel' ? 'cancelled' : 'paused'; fresh.goal.reason = 'user_' + action; }
      fresh.executionState = action === 'cancel' ? 'cancelled' : 'paused';
    }
    fresh.updatedAt = now(); putRecord('session', fresh.id, fresh, db);
    recordSessionLifecycle(fresh, previous, db); return fresh;
  });
  writeJson(sessionPath(changed.id), changed); return changed;
}

function editSession(sessionId, owner, apply, authorize, existingDb, validate = assertModelIdle) {
  const operation = db => {
    requireOwner(sessionId, owner); authorize?.();
    const current = loadSession(sessionId); validate(current);
    apply(current, db); current.updatedAt = now();
    putRecord('session', sessionId, current, db);
    return current;
  };
  const session = existingDb ? operation(existingDb) : transaction(operation);
  writeJson(sessionPath(sessionId), session);
  return session;
}

export function setSessionModel(sessionId, owner, selected, { authorize, db } = {}) {
  return editSession(sessionId, owner, (session, db) => {
    const previous = session.model;
    Object.assign(session, { modelSelectionRequired: false, model: selected.model, resolvedModel: null, modelCapabilities: selected.capabilities, modelContextMetadata: null, selectedEffort: selected.effort, reasoningEffort: null });
    appendEvent(session.id, 'model.changed', { provider: session.provider, previousModel: previous, model: session.model, effort: session.selectedEffort, appliesTo: 'next_turn' }, db);
  }, authorize, db);
}

function applyProviderSelection(session, provider, selected, db, { preservePause = false } = {}) {
    const previous = { provider: session.provider, model: session.model, threadId: session.engineThreadId };
    Object.assign(session, {
      modelSelectionRequired: false, provider: provider.id, backend: provider.backend, model: selected.model, modelCapabilities: selected.capabilities, selectedEffort: selected.effort,
      modelContextMetadata: null,
      engineThreadId: null, engineSessionId: provider.backend === 'claude' ? randomUUID() : null, engineHome: null,
      resolvedModel: null, reasoningEffort: null, failure: null, executionState: preservePause ? 'paused' : 'idle',
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
}

export function setSessionProvider(sessionId, owner, expectedProvider, providerId, selected, { authorize, db } = {}) {
  const provider = getProvider(providerId);
  return editSession(sessionId, owner, (session, db) => {
    if (session.provider !== expectedProvider) throw new Error('The provider changed while selection was open. Choose it again.');
    applyProviderSelection(session, provider, selected, db);
  }, authorize, db);
}

export function assertSessionModeSwitch(session) {
  if (!session || session.purpose === 'agent' || session.parentSessionId || session.parallelSessionId || !['solo', 'delegate', 'debate', 'parallel', 'besties'].includes(session.mode || 'solo')) {
    throw new Error('Switch modes in a root terminal chat, not an Agent or worker.');
  }
  assertSessionIdle(session);
  if (session.executionState !== 'paused') throw Object.assign(new Error('Pause this chat with /pause or /goal pause before switching modes.'), { code: 'CONFLICT', status: 409 });
  const children = listRecords('session', { parentSessionId: session.id });
  for (const child of children) assertSessionIdle(child);
  if (listRecords('assignment', { parentSessionId: session.id }).some(job => ['starting', 'running'].includes(getRecord('round', `${job.id}:${job.currentRound}`)?.state))) {
    throw Object.assign(new Error('Delegate workers are still stopping. Wait for the pause to finish before switching modes.'), { code: 'CONFLICT', status: 409 });
  }
}

const modeSelection = selected => {
  if (typeof selected?.provider !== 'string') throw new Error('Choose an installed provider for each agent.');
  return selectionFromSession({ provider: selected.provider, model: selected.model,
    selectedEffort: selected.effort, modelCapabilities: selected.capabilities });
};

// Trusted local terminal operation. Changing mode never queues work, replaces a
// goal, changes its policy, or transfers private account bindings.
export function setSessionMode(sessionId, owner, input, { authorize, db } = {}) {
  if (!['solo', 'delegate', 'debate', 'parallel', 'besties'].includes(input?.mode)) throw new Error('Choose a supported terminal mode.');
  return editSession(sessionId, owner, (session, db) => {
    assertSessionModeSwitch(session);
    if (typeof input.expectedUpdatedAt !== 'string' || input.expectedUpdatedAt !== session.updatedAt) {
      throw Object.assign(new Error('The chat changed while choosing its mode. Try the switch again.'), { code: 'CONFLICT', status: 409 });
    }
    const previous = session.mode || 'solo';
    if (input.mode === 'solo' && previous === 'solo') return;
    if (previous === 'solo') session.soloSelection = { ...selectionFromSession(session), modelSelectionRequired: session.modelSelectionRequired === true };
    const spent = session.goal ? Math.max(session.goal.tokensUsed || 0, budgetUsage(session)) : 0;
    const delegated = session.goal ? Math.max(delegationUsage(session).delegatedTokens, session.goal.delegatedTokensUsed || 0) : 0;
    for (const field of ['executor', 'debateAgents', 'parallelAgents', 'besties']) delete session[field];
    let selected;
    if (input.mode === 'delegate') {
      if (!input.selection?.supervisor || !input.selection?.executor) throw new Error('Choose both the Delegate supervisor and executor.');
      selected = modeSelection(input.selection.supervisor);
      const executor = modeSelection(input.selection.executor);
      session.executor = executor;
      delete session.debateAgents;
    } else if (['debate', 'parallel', 'besties'].includes(input.mode)) {
      if (!Array.isArray(input.selection?.agents) || input.selection.agents.length < 2 || input.selection.agents.length > 3) throw new Error('Choose two or three agents.');
      const agents = input.selection.agents.map(modeSelection);
      if (input.mode === 'besties' && session.contract?.limits.concurrency != null && session.contract.limits.concurrency < agents.length) throw new Error('This goal limits concurrent peers. Choose a smaller Besties preset.');
      session[{ debate: 'debateAgents', parallel: 'parallelAgents', besties: 'besties' }[input.mode]] = agents;
      selected = agents[0];
      delete session.executor;
    } else {
      selected = session.soloSelection || defaultSelection() || selectionFromSession(session);
      selected = { ...modeSelection(selected), modelSelectionRequired: selected.modelSelectionRequired === true };
      delete session.executor;
      delete session.debateAgents;
    }
    // A fresh backend thread receives the durable conversation, so old mode
    // instructions/tools cannot survive the switch, even with the same model.
    applyProviderSelection(session, getProvider(selected.provider), selected, db, { preservePause: true });
    session.modelSelectionRequired = selected.modelSelectionRequired === true;
    session.mode = input.mode; session.modeRevision = (session.modeRevision || 0) + 1;
    if (session.goal) {
      session.goal.tokensUsed = spent; session.goal.supervisorTokensUsed = Math.max(0, spent - delegated);
      session.goal.nativeTokenOffset = session.goal.supervisorTokensUsed;
      session.goal.supervisorUsageBase = session.usage?.tokens || 0;
    }
    appendEvent(session.id, 'mode.changed', { previousMode: previous, mode: session.mode, provider: session.provider,
      model: session.model, effort: session.selectedEffort, ...(session.executor ? { executor: session.executor } : {}),
      ...(session.debateAgents ? { agents: session.debateAgents } : {}), appliesTo: 'next_turn', paused: true }, db);
  }, authorize, db, assertSessionModeSwitch);
}

// Shared authenticated input operation; a model edit starts no execution and
// preserves the saved goal, evidence, history and budget.
export function configureSessionSelection(sessionId, owner, input, requestId, { authorize } = {}) {
  const { selection, expectedUpdatedAt } = input;
  return reserveRequest(`selection:${sessionId}`, requestId, input, db => {
    authorize?.();
    const current = loadSession(sessionId);
    if (current?.updatedAt !== expectedUpdatedAt) throw Object.assign(new Error('Session changed. Reload before editing.'), { code: 'CONFLICT', status: 409 });
    try { assertModelIdle(current); } catch { throw Object.assign(new Error('Pause the current response before editing.'), { code: 'CONFLICT', status: 409 }); }
    const options = { authorize, db };
    const saved = selection.provider === current.provider
      ? setSessionModel(sessionId, owner, selection, options)
      : setSessionProvider(sessionId, owner, current.provider, selection.provider, selection, options);
    return { sessionId, provider: saved.provider, model: saved.model, effort: saved.selectedEffort };
  });
}

// Mode changes consume the selected mode's private-host preset, never client
// supplied execution options. Admission shares the ordinary input journal.
export function configureSessionMode(sessionId, owner, input, requestId, { authorize } = {}) {
  return reserveRequest(`mode:${sessionId}`, requestId, input, db => {
    authorize?.();
    const current = loadSession(sessionId); assertSessionModeSwitch(current);
    const mode = input.mode;
    if (!['solo', 'delegate', 'debate', 'parallel', 'besties'].includes(mode)) throw Object.assign(new Error('Choose a terminal mode.'), { code: 'INVALID_REQUEST', status: 400 });
    const agents = mode === 'solo' ? null : modeDefault(mode);
    if (mode !== 'solo' && !agents) throw Object.assign(new Error('Save this mode’s defaults in Settings before switching.'), { code: 'DEFAULT_REQUIRED', status: 409 });
    const selection = mode === 'delegate' ? { supervisor: agents[0], executor: agents[1] } : { agents };
    const saved = setSessionMode(sessionId, owner, { mode, selection, expectedUpdatedAt: input.expectedUpdatedAt }, { authorize, db });
    return { sessionId, mode: saved.mode };
  });
}
