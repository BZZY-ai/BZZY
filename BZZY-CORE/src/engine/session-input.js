import { database, digest, getRecord, putRecord, listRecords, appendEvent, now } from './database.js';
import { loadSession, sessionDeleted } from './store.js';
import { claimInput, effectiveInputOwner, requireOwner } from './runtime.js';
import { enqueueExecution } from './execution-queue.js';
import { enqueueGoalTurn } from './session-operations.js';
import { needsGoalReplacement, parseGoalCommand } from './goals.js';
import { setTerminalYolo } from './terminal-permissions.js';
import { authorizedUpdateGrant } from './update-access.js';
import { isStalledGoal } from './goal-state.js';

const queues = new Map();
const reject = (message, code = 'INVALID_REQUEST', status = 400) => { throw Object.assign(new Error(message), { code, status }); };

// All interactive clients submit here. Only this Core process coordinates the
// actor handoff and admission; execution and event streaming remain independent.
export function submitSessionInput(sessionId, input, requestId, context) {
  if (!context?.authorize || !context.request) throw new Error('Input needs an authenticated Core context.');
  if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(requestId)) reject('Supply a stable input request ID.');
  const allowed = ['operation', 'owner', 'prompt', 'objective', 'options', 'environment', 'goal', 'resumeGoal', 'replaceGoalId', 'resumeGoalId', 'preparedGoalId', 'questionId', 'answer', 'action', 'text', 'enabled', 'clientRequestId'];
  if (!input || Object.keys(input).some(key => !allowed.includes(key))) reject('Unknown input field.');
  if (!['execute', 'goal', 'answer', 'control', 'permissions'].includes(input.operation)) reject('Unknown input operation.');
  if (typeof input.owner !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.owner)) reject('Invalid input actor.');
  if (input.clientRequestId !== undefined && (typeof input.clientRequestId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(input.clientRequestId))) reject('Invalid client request identity.');
  for (const flag of ['goal', 'resumeGoal', 'enabled']) if (input[flag] !== undefined && typeof input[flag] !== 'boolean') reject('Input flags must be boolean.');
  if (input.options != null && (typeof input.options !== 'object' || Array.isArray(input.options))) reject('Input options must be an object.');
  if (input.operation === 'permissions' && typeof input.enabled !== 'boolean') reject('Choose an explicit permission mode.');
  if (input.operation === 'answer' && (typeof input.answer !== 'string' || Buffer.byteLength(input.answer) > 16 * 1024)) reject('Answers must be bounded text.');
  const queued = queues.get(sessionId);
  if ((queued?.count || 0) >= 16) reject('This session has too many pending inputs.', 'CAPACITY', 429);
  const entry = queued || { count: 0, tail: Promise.resolve() };
  entry.count++;
  const result = entry.tail.then(() => dispatch(sessionId, input, requestId, context));
  entry.tail = result.then(() => {}, () => {});
  queues.set(sessionId, entry);
  void entry.tail.then(() => { if (!--entry.count) queues.delete(sessionId); });
  return result;
}

async function dispatch(sessionId, input, requestId, { authorize, principal = 'owner', request, channel }) {
  if (sessionDeleted(sessionId)) reject('This chat was deleted.', 'SESSION_DELETED', 404);
  const permission = input.operation === 'answer' ? 'answer' : input.operation === 'control' ? input.action : 'execute';
  if (!['execute', 'answer', 'pause', 'cancel', 'steer'].includes(permission)) reject('Unknown input permission.');
  authorize(permission);
  if (input.operation === 'permissions') {
    authorize('answer');
    if (principal !== 'owner') {
      const binding = [...listRecords('core.relay.grant'), ...listRecords('core.relay.context')]
        .find(row => row.sessionId === sessionId && `grant:${row.coreGrantId}` === principal && !row.revokedAt && row.expiresAt > Date.now());
      if (!binding || !authorizedUpdateGrant(binding.relayGrantId || binding.id)) reject('Terminal permission changes need the fully approved own phone.', 'FORBIDDEN', 403);
    }
  }
  const key = digest({ sessionId, principal, requestId }), fingerprint = digest(input), executionRequestId = `input.${key}`;
  const existing = getRecord('input-intent', key);
  const kind = ['execute', 'goal'].includes(input.operation) ? 'execute' : input.operation;
  if (existing) {
    if (existing.fingerprint !== fingerprint) reject('This input ID belongs to different content.', 'CONFLICT', 409);
    if (existing.state === 'accepted') return existing.result;
    const recorded = database().prepare('SELECT response FROM requests WHERE scope=? AND id=?').get(`${kind}:${sessionId}`, executionRequestId);
    if (recorded?.response) {
      const result = JSON.parse(recorded.response);
      putRecord('input-intent', key, { ...existing, state: 'accepted', result, reconciledAt: now() });
      return result;
    }
    reject('Inspect the original input receipt; an incomplete input is never replayed automatically.', existing.state === 'rejected' ? existing.code : 'UNCERTAIN', 409);
  }
  let objective = input.objective, resume = input.resumeGoal === true;
  const command = input.operation === 'execute' && typeof input.prompt === 'string' ? parseGoalCommand(input.prompt) : null;
  const isGoal = input.operation === 'goal' || Boolean(command);
  if (command) {
    if (command.action && command.action !== 'resume') reject('Use goal controls or supply an objective.');
    objective = command.objective; resume = command.action === 'resume';
  }
  if (input.resumeGoalId !== undefined) {
    if (!isGoal || !resume || typeof input.resumeGoalId !== 'string' || !/^[a-f0-9-]{36}$/.test(input.resumeGoalId)) reject('A stalled resume needs its saved goal identity.');
    const goal = loadSession(sessionId)?.goal;
    if (goal?.id !== input.resumeGoalId || !isStalledGoal(goal)) reject('The stalled goal changed. Refresh before resuming.', 'CONFLICT', 409);
  }
  if (isGoal && !resume) {
    if (typeof objective !== 'string' || !objective.trim() || Buffer.byteLength(objective) > 16 * 1024) reject('Supply a bounded goal objective.');
    const goal = loadSession(sessionId)?.goal;
    if (needsGoalReplacement(goal) && input.replaceGoalId !== goal.id) reject('Confirm replacement of the current goal.', 'CONFIRMATION_REQUIRED', 409);
    if (input.replaceGoalId && input.replaceGoalId !== goal?.id) reject('The current goal changed.', 'CONFLICT', 409);
  }
  if (input.operation === 'execute' && !isGoal && (typeof input.prompt !== 'string' || !input.prompt.trim() || Buffer.byteLength(input.prompt) > 16 * 1024)) reject('Supply bounded input text.');
  if (!isGoal && input.goal && (!input.preparedGoalId || loadSession(sessionId)?.goal?.id !== input.preparedGoalId)) reject('The prepared goal changed.', 'CONFLICT', 409);
  putRecord('input-intent', key, { id: key, sessionId, principal, requestId, fingerprint, state: 'dispatching', createdAt: now() });
  try {
    authorize('claim');
    const lease = effectiveInputOwner(sessionId);
    const transfer = lease && (lease.owner !== input.owner || (lease.principal || 'owner') !== principal);
    if (transfer) authorize('takeover');
    claimInput(sessionId, input.owner, Boolean(transfer), principal);
    const permit = (permission = 'execute') => { authorize(permission); requireOwner(sessionId, input.owner, principal); };
    let result;
    const inputChannel = channel || { kind: 'core-input', actor: digest(principal), requestId: input.clientRequestId || requestId };
    const relayCommand = requestId.startsWith('relay.') ? getRecord('core.relay.command', requestId.slice(6)) : null;
    if (relayCommand?.op === 'task.submit' && relayCommand.sessionId === sessionId) inputChannel.taskId = relayCommand.id;
    if (isGoal) result = await enqueueGoalTurn(sessionId, input.owner, input.options || {}, {
      objective, resume, requestId: executionRequestId, replaceGoalId: input.replaceGoalId, resumeGoalId: input.resumeGoalId, authorize: permit, request, channel: inputChannel, environment: input.environment,
    });
    else if (input.operation === 'execute') {
      result = enqueueExecution(sessionId, { prompt: input.prompt, options: input.options || {}, environment: input.environment,
        goal: input.goal === true, resumeGoal: resume }, executionRequestId, { authorize: permit, channel: inputChannel });
    } else if (input.operation === 'permissions') {
      result = setTerminalYolo(sessionId, { enabled: input.enabled, questionId: input.questionId }, executionRequestId, { authorize: permit });
    } else {
      permit(permission);
      result = await request('POST', input.operation, input.operation === 'answer'
        ? { questionId: input.questionId, answer: input.answer }
        : { action: input.action, text: input.text }, executionRequestId);
    }
    putRecord('input-intent', key, { ...getRecord('input-intent', key), state: 'accepted', result, acceptedAt: now() });
    appendEvent(sessionId, 'input.accepted', { actor: inputChannel.actor, requestId: inputChannel.requestId,
      ...(inputChannel.taskId ? { taskId: inputChannel.taskId } : {}), result });
    return result;
  } catch (error) {
    const deterministic = error.status >= 400 && error.status < 500 || ['CONFLICT', 'CONFIRMATION_REQUIRED'].includes(error.code);
    putRecord('input-intent', key, { ...getRecord('input-intent', key), state: deterministic ? 'rejected' : 'uncertain', code: error.code || 'INVALID_REQUEST', updatedAt: now() });
    throw error;
  }
}
