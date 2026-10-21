import { randomUUID } from 'node:crypto';
import { reserveRequest, listRecords, getRecord, putRecord, appendEvent, now } from './database.js';
import { loadSession } from './store.js';
import { identityAlive } from './recovery.js';
import { effectivePolicy } from './policy.js';
import { captureEnvironment, saveExecutionEnvironment, removeExecutionEnvironment } from './execution-environment.js';

// All input channels use the same atomic queue and one-execution-per-session rule.
export function enqueueExecution(sessionId, input, requestId, { authorize, prepare, channel } = {}) {
  if (!authorize) throw new Error('Execution needs an authorized input channel.');
  authorize();
  const environment = captureEnvironment(input.environment);
  let environmentId;
  try { return reserveRequest(`execute:${sessionId}`, requestId, { prompt: input.prompt, options: input.options, goal: input.goal, resumeGoal: input.resumeGoal, environment }, db => {
    authorize();
    const session = loadSession(sessionId);
    if (listRecords('execution', { sessionId, states: ['queued', 'launching', 'running'], limit: 1 }).length > 0) throw Object.assign(new Error('Session is already executing.'), { code: 'CONFLICT' });
    if (identityAlive(getRecord('run', sessionId)?.runner) && ['running', 'waiting_for_input', 'verifying'].includes(session.executionState)) throw Object.assign(new Error('The session already has a live runner.'), { code: 'CONFLICT' });
    if (typeof input.prompt !== 'string') throw new Error('Execution needs a prompt.');
    prepare?.(session, db);
    effectivePolicy(session, input.options || {});
    if (input.goal && !session.goal) throw new Error('This session has no goal contract. Create its goal through the CLI first.');
    const job = { id: randomUUID(), sessionId, prompt: input.prompt, options: input.options || {}, goal: Boolean(input.goal), resumeGoal: Boolean(input.resumeGoal), state: 'queued', createdAt: now(), ...(channel ? { channel } : {}) };
    environmentId = job.id; saveExecutionEnvironment(job.id, environment);
    putRecord('execution', job.id, job, db);
    appendEvent(sessionId, 'message.user', { text: input.prompt, kind: input.goal ? 'goal' : 'chat', executionId: job.id, ...(channel ? { channel } : {}) }, db);
    appendEvent(sessionId, 'execution.queued', { id: job.id }, db);
    return { executionId: job.id, sessionId };
  }); } catch (error) { if (environmentId) removeExecutionEnvironment(environmentId); throw error; }
}
