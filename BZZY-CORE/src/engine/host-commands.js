import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config, getProvider, defaultSelection } from './providers.js';
import { createSession, saveSession, loadSession, lockSession, lockFile, setSessionAlias, readJson, findSession, normalizeSessionAlias, home } from './store.js';
import { newGoal } from './goals.js';
import { CodexEngine } from './engines/codex.js';
import { claudeEnvironment } from './engines/claude.js';
import { inherited } from './process.js';
import { subscriptionEnvironment } from './auth.js';
import { prepareTask } from './task.js';
import { reconcileSession, identityAlive } from './recovery.js';
import { getRecord, putRecord, listRecords, digest, appendEvent, reserveRequest } from './database.js';
import { remember } from './memory.js';
import { initializeProject } from './project.js';
import { ensureRuntime, runtimeRequest } from './runtime.js';
import { applyDelegationSelection } from './delegation-setup.js';
import { applyBestiesSelection } from './besties-setup.js';
import { applyParallelSelection } from './parallel-setup.js';
import { applyDebateSelection } from './debate-setup.js';
import { projectIdentityForSession } from './project-identity.js';
import { getWorkflow, selectWorkflow, workflowSelection } from './workflows.js';

// Trusted local host operations. UI adapters collect input and display results;
// the engine owns durable state, execution setup, recovery and provider calls.
export function selectedProvider(options) { return getProvider(options.provider || config().defaultProvider || 'codex'); }

export function authenticateSubscription(provider, options) {
  if (provider.backend === 'claude') return inherited('claude', ['auth', 'login'], claudeEnvironment());
  return inherited('codex', ['login', ...(options.device ? ['--device-auth'] : [])], subscriptionEnvironment('codex'));
}

export function applyLaunchDefault(options) {
  const saved = defaultSelection(options.provider);
  if (!saved) return;
  if (!options.provider) options.provider = saved.provider;
  const sameModel = options.model == null;
  if (sameModel) options.model = saved.model;
  if (options.effort == null && sameModel && saved.effort !== 'default') options.effort = saved.effort;
  options.launchDefault = { ...saved, capabilities: sameModel ? saved.capabilities : null, effort: sameModel ? options.effort || saved.effort : options.effort || 'default' };
}

function applyLaunchSelection(session, options) {
  const saved = options.launchDefault;
  if (session.selectedEffort == null) session.selectedEffort = options.effort || (saved && saved.provider === session.provider && saved.model === session.model ? saved.effort : undefined);
  if (!session.modelCapabilities && saved?.provider === session.provider && saved.model === session.model) session.modelCapabilities = saved.capabilities;
  return session;
}

function applySelections(session, options) {
  applyDelegationSelection(session, options.delegationSelection);
  applyBestiesSelection(session, options.bestiesSelection);
  applyParallelSelection(session, options.parallelAgents);
  applyDebateSelection(session, options.debateAgents);
  return applyLaunchSelection(session, options);
}

function launchWorkflow(reference, cwd) {
  return reference === undefined ? undefined : reference === 'none' ? null : getWorkflow(reference, { cwd });
}
function bindLaunchWorkflow(session, workflow) {
  if (workflow === undefined) return;
  const current = workflowSelection(session.id);
  if (workflow && current.available && current.selected?.id === workflow.id || !workflow && !current.selected) return current;
  return selectWorkflow(session.id, workflow?.name || null, { expectedRevision: current.revision,
    ...(workflow ? { scope: workflow.scope, expectedWorkflowRevision: workflow.revision } : {}) });
}
export function applyLaunchWorkflow(session, reference) {
  return bindLaunchWorkflow(session, launchWorkflow(reference, session.cwd));
}

export function createChatSession(provider, options) {
  const workflow = launchWorkflow(options.workflow, options.cwd);
  const session = createSession(provider, options.cwd, options.model, options.alias);
  const project = projectIdentityForSession(session);
  session.projectRoot = project.root; session.projectId = project.id;
  applySelections(session, options);
  if (options.modelSelectionRequired) { session.modelSelectionRequired = true; session.model = null; }
  saveSession(session);
  bindLaunchWorkflow(session, workflow);
  return session;
}

// Owner CLI attachment may create an idle named terminal, never replay work.
// Serialize the resolve/create gap across CLI processes using the existing
// identity-checked private lock. Existing ID/alias/prefix resolution wins.
export async function openOrCreateChatSession(reference, options) {
  const alias = normalizeSessionAlias(reference), sourceHome = home(), supplied = { ...options };
  const lookup = () => {
    try { return findSession(alias); }
    catch (error) { if (error.code !== 'SESSION_NOT_FOUND') throw error; return null; }
  };
  const busy = 'Named session creation is busy. Try attaching again.';
  const file = path.join(sourceHome, 'sessions', 'attach-' + digest(alias) + '.lock'), deadline = Date.now() + 5000;
  let unlock;
  while (!unlock) {
    if (home() !== sourceHome) throw new Error('The private Core host changed while opening this session. Retry attachment.');
    try { unlock = lockFile(file, busy); }
    catch (error) {
      if (error.code !== 'BZZY_LOCKED' || Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
  }
  try {
    if (home() !== sourceHome) throw new Error('The private Core host changed while opening this session. Retry attachment.');
    const current = lookup();
    if (current) { applyLaunchWorkflow(current, supplied.workflow); return { session: current, created: false }; }
    const selection = { ...supplied, alias };
    applyLaunchDefault(selection);
    if (!config().defaultProvider && !selection.provider && !selection.model) selection.modelSelectionRequired = true;
    return { session: createChatSession(selectedProvider(selection), selection), created: true };
  } finally { unlock(); }
}

export function newConversation(previous, options) {
  const session = createSession(getProvider(previous.provider), options.cwd, previous.model);
  const project = projectIdentityForSession(session);
  session.projectRoot = project.root; session.projectId = project.id;
  Object.assign(session, { selectedEffort: previous.selectedEffort, modelCapabilities: previous.modelCapabilities, modelSelectionRequired: previous.modelSelectionRequired, mode: previous.mode,
    executor: previous.executor, besties: previous.besties, parallelAgents: previous.parallelAgents, debateAgents: previous.debateAgents });
  saveSession(session); return session;
}

export function startConversationGoal(session, options, objective) {
  const previousGoal = session.goal;
  prepareTask(session, options, objective); session.goal = newGoal(session.contract.objective, options.tokenBudget); saveSession(session);
  session.acceptance = null; session.summary = null; session.failure = null; session.stopReason = null;
  if (previousGoal) putRecord('goal-history', previousGoal.id, { sessionId: session.id, ...previousGoal,
    supersededAt: new Date().toISOString(), supersededBy: session.goal.id });
  saveSession(session); return session;
}

export function prepareConversationTurn(session, options, input) {
  if (!session.contract) prepareTask(session, { ...options, mode: session.mode || options.mode || 'solo' }, input);
  return session;
}

export async function controlSavedGoal(session, action, options, events) {
  if (!['pause', 'cancel', 'clear'].includes(action)) throw new Error('Unknown goal operation.');
  const run = getRecord('run', session.id);
  if (run && identityAlive(run.runner) && ['running', 'waiting_for_input', 'verifying'].includes(session.executionState)) {
    if (action === 'clear') throw new Error('Pause or cancel the running goal before clearing it.');
    const info = await ensureRuntime(), owner = randomUUID();
    const endpoint = `/sessions/${session.id}`;
    await runtimeRequest(info, 'POST', endpoint + '/claim', { owner, takeover: true });
    try { await runtimeRequest(info, 'POST', endpoint + '/control', { owner, action: action === 'cancel' ? 'cancel' : 'pause' }, options.requestId || randomUUID()); }
    finally { await runtimeRequest(info, 'POST', endpoint + '/release', { owner }).catch(() => {}); }
    return { requested: true, session };
  }
  const unlock = lockSession(session);
  try {
    if (session.backend === 'codex' && session.engineThreadId && !(action === 'pause' && session.goal.status === 'complete')) {
      const engine = new CodexEngine(getProvider(session.provider), session, options, events);
      try { await engine.setGoalStatus(action === 'clear' ? 'clear' : 'paused'); }
      finally { await engine.close(); }
    }
    if (action === 'clear') { putRecord('goal-history', session.goal.id, { sessionId: session.id, ...session.goal, clearedAt: new Date().toISOString() }); session.goal = null; }
    else {
      if (!(action === 'pause' && session.goal.status === 'complete')) { session.goal.status = action === 'cancel' ? 'cancelled' : 'paused'; session.goal.reason = 'user_' + action; }
      session.executionState = action === 'cancel' ? 'cancelled' : 'paused';
    }
    saveSession(session); return { requested: false, session };
  } finally { unlock(); }
}

export function prepareResume(session, options, requireGoal = false) {
  if (options.workflow !== undefined) throw new Error('Resumed goals keep their saved workflow. Use --attach with --workflow for future goals, or start a new goal.');
  if (options.alias != null) Object.assign(session, setSessionAlias(session.id, options.alias));
  if (options.provider && options.provider !== session.provider) throw new Error('A session keeps its provider. Start a new session to switch backends.');
  if (requireGoal && !session.goal) throw new Error('This session has no goal.');
  if (requireGoal && session.goal.status === 'complete') throw new Error('This goal is already complete. Start a new goal to request more work.');
  const recovery = reconcileSession(session.id); Object.assign(session, loadSession(session.id));
  if (recovery.live) return { session, recovery, goal: Boolean(session.goal && session.goal.status !== 'complete') };
  if (recovery.state === 'cleanup_required') throw new Error(recovery.reason);
  if (options.model) session.model = options.model;
  const goal = Boolean(session.goal && session.goal.status !== 'complete');
  if (goal) {
    session.goal.notificationEpoch = (session.goal.notificationEpoch || 0) + 1;
    session.goal.noActivityTurns = 0; session.goal.blockerStreak = 0; session.goal.lastBlocker = null;
    delete session.goal.reason;
    if (options.tokenBudget) session.goal.tokenBudget = options.tokenBudget;
    if (session.goal.tokenBudget != null && session.goal.tokensUsed >= session.goal.tokenBudget) throw new Error('Goal budget is exhausted. Resume with a larger total --token-budget.');
  }
  return { session, recovery, goal };
}

export function recordProjectMemory(provider, options, filename) {
  const session = createSession(provider, options.cwd, options.model);
  prepareTask(session, options, 'Record project knowledge'); initializeProject(session);
  return remember(session, readJson(path.resolve(options.cwd, filename)));
}

export function createTaskSession(provider, options, prompt, { goal, initialContext = '', contextFileText } = {}) {
  // Preserve the existing request namespace and digest so a CLI retry after an
  // upgrade resolves to its original session rather than creating another run.
  const taskOptions = { ...options, initialContext, contextFileText };
  const creationInput = { provider: provider.id, model: options.model || null, cwd: options.cwd, alias: options.alias || null, prompt, initialContext: initialContext || null,
    ...(options.workflow === undefined ? {} : { workflow: options.workflow }),
    ...(contextFileText == null ? {} : { contextFileDigest: digest(contextFileText) }), goal, mode: options.mode || 'solo',
    contractDigest: options.contract ? digest(fs.readFileSync(path.resolve(options.contract))) : null,
    authorization: { yolo: options.yolo, readOnly: options.readOnly || false, tokenBudget: options.tokenBudget || null, runtime: options.runtimeSeconds || null, executor: options.delegationSelection?.executor || options.executor || null,
      supervisorEffort: options.delegationSelection?.supervisor.effort || options.effort || null, executorModel: options.executorModel || null, agents: options.agents || null, parallelAgents: options.parallelAgents || null, debateAgents: options.debateAgents || null, besties: options.besties || null, participants: options.participants || null } };
  let session;
  if (options.requestId) {
    const reserved = reserveRequest('cli-create', options.requestId, creationInput, db => {
      const workflow = launchWorkflow(options.workflow, options.cwd);
      const initial = { version: 1, id: randomUUID(), provider: provider.id, backend: provider.backend, cwd: options.cwd, model: options.model || provider.model || null,
        ...(options.alias == null ? {} : { alias: options.alias }),
        engineThreadId: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), turns: 0, goal: null, executionState: 'idle' };
      applySelections(initial, options);
      if (workflow !== undefined) { putRecord('session', initial.id, initial, db); bindLaunchWorkflow(initial, workflow); }
      prepareTask(initial, taskOptions, prompt, { persist: false });
      if (goal && !initialContext) initial.goal = newGoal(initial.contract.objective, options.tokenBudget || initial.contract.limits.tokenBudget);
      putRecord('session', initial.id, initial, db); appendEvent(initial.id, 'session.created', { sessionId: initial.id }, db); return { sessionId: initial.id };
    });
    session = loadSession(reserved.sessionId);
    if (!initialContext && listRecords('execution').some(job => job.sessionId === session.id)) return { session, existingExecution: true };
  } else {
    const workflow = launchWorkflow(options.workflow, options.cwd);
    session = createSession(provider, options.cwd, options.model, options.alias);
    bindLaunchWorkflow(session, workflow);
    applySelections(session, options); prepareTask(session, taskOptions, prompt);
    if (goal && !initialContext) session.goal = newGoal(session.contract.objective, options.tokenBudget || session.contract.limits.tokenBudget);
  }
  saveSession(session); return { session, existingExecution: false };
}

export function activateTaskGoal(session, options) {
  Object.assign(session, loadSession(session.id));
  if (!session.goal) session.goal = newGoal(session.contract.objective, options.tokenBudget || session.contract.limits.tokenBudget);
  else if (session.goal.objective !== session.contract.objective.trim()) throw new Error('The saved goal does not match --goal. Use a new --request-id.');
  saveSession(session); return session;
}
