import { randomUUID } from 'node:crypto';
import { reserveRequest, listRecords, getRecord, putRecord, appendEvent, now } from './database.js';
import { loadSession, sessionDeleted } from './store.js';
import { identityAlive } from './recovery.js';
import { effectivePolicy } from './policy.js';
import { captureEnvironment, saveExecutionEnvironment, removeExecutionEnvironment } from './execution-environment.js';
import { terminalYolo } from './terminal-permissions.js';
import { preflightGoalWorkflow } from './workflows.js';
import { preflightGoalScope } from './program-scope.js';

// All input channels use the same atomic queue and one-execution-per-session rule.
export function enqueueExecution(sessionId, input, requestId, { authorize, prepare, channel } = {}) {
  if (!authorize) throw new Error('Execution needs an authorized input channel.');
  authorize();
  if (sessionDeleted(sessionId)) throw Object.assign(new Error('This chat was deleted.'), { code: 'SESSION_DELETED', status: 404 });
  if (['scopeAdmission', 'scopeBinding', 'programScope', 'workflowAdmission', 'workflowSelection', 'workflowBinding', 'goalWorkflow'].some(key => Object.hasOwn(input, key) || Object.hasOwn(input.options || {}, key))) {
    throw Object.assign(new Error('Workflow admission belongs to Core. Select a saved workflow instead of supplying host receipts or bindings.'), { code: 'INVALID_WORKFLOW', status: 400 });
  }
  const environment = captureEnvironment(input.environment);
  let environmentId;
  try { return reserveRequest(`execute:${sessionId}`, requestId, { prompt: input.prompt, options: input.options, goal: input.goal, resumeGoal: input.resumeGoal, replaceGoalId: input.replaceGoalId, ...(input.resumeGoalId === undefined ? {} : { resumeGoalId: input.resumeGoalId }), environment }, db => {
    authorize();
    const session = loadSession(sessionId);
    if (session.modelSelectionRequired) throw new Error('Select a model before sending a message.');
    if (listRecords('execution', { sessionId, states: ['queued', 'launching', 'running'], limit: 1 }).length > 0) throw Object.assign(new Error('Session is already executing.'), { code: 'CONFLICT' });
    if (identityAlive(getRecord('run', sessionId)?.runner) && ['running', 'waiting_for_input', 'verifying'].includes(session.executionState)) throw Object.assign(new Error('The session already has a live runner.'), { code: 'CONFLICT' });
    if (typeof input.prompt !== 'string') throw new Error('Execution needs a prompt.');
    prepare?.(session, db);
    effectivePolicy(session, input.options || {});
    const options = { ...input.options, mode: session.mode || input.options?.mode || 'solo',
      ...(session.mode === 'delegate' && session.executor ? { executor: session.executor.provider, executorModel: session.executor.model } : {}),
      ...(session.mode === 'debate' && session.debateAgents ? { debateAgents: session.debateAgents } : {}),
      ...(session.mode === 'parallel' && session.parallelAgents ? { parallelAgents: session.parallelAgents } : {}),
      ...(session.mode === 'besties' && session.besties ? { besties: session.besties } : {}),
      yolo: terminalYolo(sessionId) ?? input.options?.yolo ?? false };
    effectivePolicy(session, options);
    if (input.goal && !session.goal) throw new Error('This session has no goal contract. Create its goal through the CLI first.');
    const workflowAdmission = input.goal || input.resumeGoal ? preflightGoalWorkflow(session, { resumeGoal: Boolean(input.resumeGoal) }) : null;
    const scopeAdmission = preflightGoalScope(session, { allowNewBinding: Boolean(input.goal && !input.resumeGoal), policy: effectivePolicy(session, options), strictPolicy: session.strictPolicy, yolo: options.yolo });
    if ((input.goal || input.resumeGoal) && session.goal?.importedHistorical) {
      delete session.goal.importedHistorical;
      session.goal.status = 'active';
      session.goal.reason = 'revalidating_import';
      session.acceptance = null;
      putRecord('session', session.id, session, db);
    }
    const job = { id: randomUUID(), sessionId, prompt: input.prompt, options, goal: Boolean(input.goal), resumeGoal: Boolean(input.resumeGoal), state: 'queued', createdAt: now(),
      ...(workflowAdmission ? { workflowAdmission } : {}), ...(scopeAdmission ? { scopeAdmission } : {}), ...(channel ? { channel } : {}) };
    environmentId = job.id; saveExecutionEnvironment(job.id, environment);
    putRecord('execution', job.id, job, db);
    appendEvent(sessionId, 'message.user', { text: input.prompt, kind: input.goal ? 'goal' : 'chat', executionId: job.id, ...(channel ? { channel } : {}) }, db);
    appendEvent(sessionId, 'execution.queued', { id: job.id }, db);
    return { executionId: job.id, sessionId };
  }); } catch (error) { if (environmentId) removeExecutionEnvironment(environmentId); throw error; }
}
