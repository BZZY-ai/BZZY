import { randomUUID } from 'node:crypto';
import { findSession, loadSession } from './store.js';
import { getRecord, listRecords, reserveRequest, digest } from './database.js';
import { identityAlive } from './process-identity.js';
import { isStalledGoal } from './goal-state.js';
import { terminalSession } from '../relay/terminal-catalog.js';
import { ensureRuntime, runtimeRequest } from './runtime.js';

const fail = (message, code = 'GOAL_CONTROL_INVALID') => Object.assign(new Error(message), { code });
function selected(reference) {
  const session = findSession(reference);
  if (!terminalSession(session)) throw fail('Choose an existing owner terminal session.');
  return session;
}
function statusFor(session) {
  const goal = session.goal, run = getRecord('run', session.id), execution = listRecords('execution', { sessionId: session.id, limit: 1 })[0];
  const identity = run?.runner || execution?.runner, runnerAlive = identity ? identityAlive(identity) : null;
  const live = run?.goalId === goal?.id && run?.goalMode !== false && runnerAlive === true
    && ['running', 'waiting_for_input', 'verifying'].includes(session.executionState);
  const uncertainActive = ['active', 'verifying'].includes(goal?.status)
    && (Boolean(identity) || ['running', 'waiting_for_input', 'verifying'].includes(session.executionState) || goal?.status === 'verifying');
  const status = !goal ? 'no_goal' : goal.importedHistorical ? 'historical' : goal.status === 'complete' ? 'achieved' : isStalledGoal(goal) ? 'stalled'
    : ['paused', 'cancelled', 'failed'].includes(goal.status) ? goal.status
    : execution?.goal && ['queued', 'launching'].includes(execution.state) ? 'queued'
    : live ? session.executionState === 'waiting_for_input' ? 'waiting_for_input' : session.executionState === 'verifying' ? 'verifying' : 'running'
    : session.executionState === 'failed' ? 'failed' : uncertainActive ? 'unknown' : 'idle';
  return { sessionId: session.id, alias: session.alias || null, goalId: goal?.id || null, status,
    rawStatus: goal?.status || null, reason: goal?.reason || null, executionState: session.executionState || 'idle', runnerAlive,
    observedAt: new Date().toISOString(), ...(status === 'unknown' ? { notice: 'No live execution of this saved goal was observed. Inspect recovery before continuing uncertain work.' } : {}) };
}

// Owner-local lookup only: never creates a session, starts Core or reconciles work.
export function savedGoalStatus(reference) { return statusFor(selected(reference)); }

// The engine owns the pinned intent and canonical input admission. A CLI retry
// uses exactly the original goal/actor/input, even after that goal has progressed.
export async function controlNamedGoal(reference, action, { requestId = randomUUID(), tokenBudget } = {}) {
  if (!['continue', 'pause'].includes(action)) throw fail('Choose continue or pause.');
  if (tokenBudget !== undefined && (action !== 'continue' || !Number.isSafeInteger(tokenBudget) || tokenBudget < 1)) throw fail('Use a positive total token budget only with continue.');
  const session = selected(reference);
  const plan = reserveRequest('cli:named-goal-control', requestId, { sessionId: session.id, action, tokenBudget: tokenBudget ?? null }, () => {
    const current = loadSession(session.id), goal = current.goal;
    if (!goal) throw fail('This session has no goal.');
    if (action === 'continue' && goal.status !== 'paused' && !isStalledGoal(goal)) {
      throw fail(goal.status === 'complete' ? 'This goal is already achieved. Start a new goal to request more work.'
        : 'Continue requires a paused or stalled goal. An active or cancelled goal is not restarted.');
    }
    const owner = `goal-${randomUUID()}`;
    return { sessionId: current.id, goalId: goal.id,
      input: action === 'continue' ? { operation: 'goal', owner, resumeGoal: true, resumeGoalId: goal.id,
        ...(goal.status === 'paused' ? { resumeGoalStatus: 'paused' } : {}), options: tokenBudget == null ? {} : { tokenBudget } }
        : { operation: 'control', owner, action: 'pause' } };
  });
  const latest = loadSession(plan.sessionId);
  if (latest?.goal?.id !== plan.goalId) throw fail('The session now has a different goal. Use a new request ID after reviewing it.', 'CONFLICT');
  // This is an explicit owner command, unlike status polling. Starting Core
  // preserves all unrelated paused work; only the pinned input is submitted.
  await (await import('./host-service.js')).activateCLIHost();
  const info = await ensureRuntime();
  let result;
  try { result = await runtimeRequest(info, 'POST', `/v1/sessions/${plan.sessionId}/input`, plan.input, `cli.goal.${digest(requestId)}`); }
  finally { await runtimeRequest(info, 'POST', `/v1/sessions/${plan.sessionId}/release`, { owner: plan.input.owner }).catch(() => {}); }
  let status;
  try { status = statusFor(loadSession(plan.sessionId)); }
  catch { status = { sessionId: plan.sessionId, goalId: plan.goalId, status: 'unknown',
    notice: 'Input accepted. Refresh status before taking further action.' }; }
  return { ...status, action, accepted: true, acceptedGoalId: plan.goalId,
    ...(result.executionId ? { executionId: result.executionId } : {}), ...(result.controlId ? { controlId: result.controlId } : {}) };
}
