import { guardedInterval } from './interval.js';
import { CodexEngine } from './engines/codex.js';
import { ClaudeEngine } from './engines/claude.js';
import { applyReport } from './goals.js';
import { lockSession, saveSession, loadSession } from './store.js';
import { NotificationHub } from './notifications.js';
import { ToolHost } from './tools.js';
import { getRecord, putRecord, listRecords, appendEvent, now } from './database.js';
import { initializeProject, writeProjectRecord } from './project.js';
import { effectivePolicy, requireSandbox } from './policy.js';
import { assessCompletion } from './verification.js';
import { artifact, snapshotWorkspace, artifactsFor } from './evidence.js';
import { checkpoint } from './memory.js';
import { processIdentity } from './recovery.js';
import { cancelAssignment, waitAssignment } from './delegation.js';
import { TrafficRecorder } from './traffic.js';
import { closeOpenActivities } from './activity.js';
import { ActivityReporter } from './live-activity.js';
import { activeAssignmentsFor, delegationUsage } from './delegation-usage.js';
import { duration } from './format-duration.js';
import { delegationTokenLines } from './delegation-format.js';
import { agentExecutionScope } from './agent-execution.js';
import { learningForTurn } from './learning-hooks.js';
import { pauseLearningForSession } from './learning.js';

export function classifyFailure(error) {
  const message = String(error.message || error);
  const category = /auth|unauthorized|invalid.*key|not.logged.in|401/i.test(message) ? 'authentication'
    : /rate.?limit|429|quota|usage.limit/i.test(message) ? 'rate_limit'
    : /input.*required|approval required|permission.*denied/i.test(message) ? 'missing_input'
    : /timeout|timed.out/i.test(message) ? 'timeout' : error.code === 'UNSUPPORTED_POLICY' ? 'unsupported_policy'
    : /tool|command|spawn|ENOENT/i.test(message) ? 'tool_failure' : 'backend_failure';
  return { category, message, retryable: ['rate_limit', 'timeout'].includes(category), requiresInput: ['authentication', 'missing_input'].includes(category) };
}
export function usageSummary(session) {
  return delegationUsage(session);
}
export function printGoalSummary(session, ui) {
  if (!session.goal || ['active', 'verifying'].includes(session.goal.status)) return;
  const usage = session.summary?.usage || usageSummary(session);
  const seconds = session.goal.runtimeUsedSeconds || 0, elapsed = duration(seconds);
  const result = session.goal.status === 'complete' ? 'GOAL ACHIEVED' : session.goal.status === 'cancelled' ? 'GOAL CANCELLED' : session.goal.status === 'paused' && session.goal.reason !== 'turn_limit' ? 'GOAL PAUSED' : 'GOAL STALLED';
  const delegated = session.mode === 'delegate';
  const breakdown = delegated ? '\n' + delegationTokenLines(session, usage).join('\n')
    : usage.agents.length ? '\n' + usage.agents.map(a => `  ${a.agent || a.provider}${a.model ? ':' + a.model : ''}: ${a.tokens == null ? 'usage unavailable' : a.tokens.toLocaleString() + ' tokens'}${a.elapsedSeconds != null ? ' · ' + duration(a.elapsedSeconds) : ''}`).join('\n') : '';
  ui.event('summary', { status: session.goal.status, reason: session.goal.reason || null, elapsedSeconds: seconds, usage, sessionId: session.id,
    message: `${result} · ${elapsed}${delegated ? '' : ` · ${usage.complete ? '' : 'at least '}${usage.totalTokens.toLocaleString()} tokens${usage.complete ? '' : ' (some usage unavailable)'}`}${breakdown}\nSession: ${session.id}${session.goal.reason ? `\nReason: ${session.goal.reason}` : ''}` });
}
export async function runSession(provider, session, options, ui, prompt, { goal = false, resumeGoal = false } = {}) {
  if (session.modelSelectionRequired) throw new Error('Select a model before sending a message.');
  pauseLearningForSession(session.id, 'foreground_work');
  const agentScope = agentExecutionScope(session);
  if (agentScope) {
    if (session.contract?.verification?.length || session.contract?.artifacts?.length) throw Object.assign(new Error('Persistent Agent acceptance commands and file assertions need an authorized isolated integration; no host command was started.'), { code: 'UNSUPPORTED_POLICY' });
    session.projectRoot = agentScope.projectRoot;
    options = { ...options, agentScope, yolo: false, scopedAutonomy: false, captureNetwork: false };
  } else options = { ...options, agentScope: null };
  const policy = effectivePolicy(session, options);
  const unlock = lockSession(session), started = Date.now(), indicator = ui.executionIndicator?.(options.pet !== false && !ui.persistsEvents) || { start() {}, stop() {} }, abort = new AbortController();
  let engine, host, traffic, stopping, killTimer, fullText = '', heartbeat, controls, processing = false, failedThisTurn = false;
  options = { ...options, goalMode: goal, policy, strictPolicy: Boolean(options.strictPolicy || options.readOnly || session.strictPolicy) }; session.policy = policy; session.captureNetwork = Boolean(options.captureNetwork);
  const run = { sessionId: session.id, state: 'running', runner: processIdentity(), startedAt: now(), heartbeatAt: now() };
  const stop = (reason = 'interrupted') => {
    if (stopping) { engine?.close().catch(() => {}); return; }
    stopping = reason; abort.abort(); ui.cancelled = true; indicator.stop();
    engine?.interrupt(reason).catch(error => { try { ui.event('error', { message: error.message }); } catch { /* stop must work even when persistence fails */ } });
    killTimer = setTimeout(() => engine?.close().catch(() => {}), 3000); killTimer.unref();
  };
  const interrupt = () => {
    const job = listRecords('execution', { sessionId: session.id, states: ['launching', 'running'] }).find(job => job.stopAction);
    stop(job?.stopAction === 'cancel' ? 'cancelled' : job?.stopAction === 'pause' ? 'user_pause' : 'interrupted');
  };
  const recorded = { interactive: ui.interactive, json: ui.json, newline: ui.newline.bind(ui), ask: ui.ask.bind(ui), approve: ui.approve.bind(ui),
    event(type, data = {}) { if (type === 'text') fullText += data.text || ''; if (!ui.persistsEvents) appendEvent(session.id, type, data); ui.event(type, data); } };
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt); ui.beforeOutput = () => indicator.stop();
  try {
    if (!agentScope && (options.strictPolicy || goal && session.mode === 'delegate')) requireSandbox(goal && session.mode === 'delegate' ? 'Delegate workers' : 'Enforced task policies');
    initializeProject(session);
    if (session.contract) writeProjectRecord(session, 'contracts', session.goal?.id || session.id, session.contract);
    if (goal && !session.startSnapshotId && !['executor', 'reviewer'].includes(session.role)) session.startSnapshotId = snapshotWorkspace(session, 'run-start').id;
    session.executionState = 'running'; if (goal) { session.goal.status = 'active'; session.deferTerminalNotification = true; }
    if (goal && session.goal.supervisorUsageBase == null) session.goal.supervisorUsageBase = Math.max(0, (session.usage?.tokens || 0) - (session.goal.nativeTokensUsed ?? session.goal.supervisorTokensUsed ?? 0));
    putRecord('run', session.id, run); saveSession(session);
    options.activityReporter = new ActivityReporter(session, recorded, goal ? session.goal.objective : prompt);
    host = await new ToolHost(session, recorded, { goalMode: goal, agentScope }).open(); options.toolHost = host; host.activityReporter = options.activityReporter;
    if (options.captureNetwork) { traffic = await new TrafficRecorder(session, provider, recorded).open(); options.networkEnv = traffic.env; }
    if (options.yolo) recorded.event('info', { message: provider.backend === 'codex' ? 'YOLO · approvals off · Codex sandbox disabled' : 'YOLO · Claude permission checks bypassed' });
    const limit = options.runtimeSeconds || session.contract?.limits.runtimeSeconds;
    const remainingMs = limit == null ? null : Math.max(0, limit - (session.goal?.runtimeUsedSeconds || 0)) * 1000;
    let deadline; if (remainingMs != null) deadline = setTimeout(() => stop('runtime_limit'), remainingMs);
    heartbeat = guardedInterval(() => { const record = getRecord('run', session.id); if (record) putRecord('run', session.id, { ...record, heartbeatAt: now() }); }, 2000, { label: 'Run heartbeat', onError: (_error, failures) => { if (failures >= 3) stop('persistence_failure'); } });
    let lastUsageKey, lastUsageAt = 0;
    controls = guardedInterval(async () => {
      if (processing) return; processing = true;
      try {
        const cancellation = session.assignmentId && getRecord('assignment-control', session.assignmentId);
        if (cancellation?.action === 'cancel' && (cancellation.round == null || cancellation.round === session.assignmentRound)) stop('cancelled');
        if (goal && session.mode === 'delegate') {
          const usage = delegationUsage(session), key = JSON.stringify([usage.supervisorTokens, usage.delegatedTokens, usage.complete]);
          if (key !== lastUsageKey && Date.now() - lastUsageAt >= 2000) {
            lastUsageKey = key; lastUsageAt = Date.now();
            session.delegationUsage = usage; session.goal.delegatedTokensUsed = usage.delegatedTokens;
            session.goal.tokensUsed = usage.totalTokens; saveSession(session);
            recorded.event('delegation.usage', usage);
          }
          if (session.goal.tokenBudget != null && usage.totalTokens >= session.goal.tokenBudget) stop('token_limit');
        } else if (!goal && options.tokenBudget != null && (session.usage?.tokens || 0) >= options.tokenBudget) stop('token_limit');
        for (const control of listRecords('control', { sessionId: session.id, state: 'queued' })) {
          putRecord('control', control.id, { ...control, state: 'dispatched' });
          try {
            let result;
            if (['pause', 'cancel'].includes(control.action)) { stop(control.action === 'cancel' ? 'cancelled' : 'user_pause'); result = { requested: true }; }
            else if (control.action === 'steer') { if (!engine?.steer) throw new Error('This backend cannot steer an active turn. Send a chat message after it finishes.'); result = await engine.steer(control.text); }
            else throw new Error('Unsupported execution control.');
            putRecord('control', control.id, { ...control, state: 'observed', result });
            recorded.event('control.observed', { id: control.id, action: control.action, result });
          } catch (error) { putRecord('control', control.id, { ...control, state: 'failed', error: error.message }); recorded.event('control.failed', { id: control.id, action: control.action, message: error.message }); }
        }
      } finally { processing = false; }
    }, 100, { label: 'Run controls', onError: (_error, failures) => { if (failures >= 3) stop('persistence_failure'); } });
    let attempts = 0;
    try {
      do {
        const Engine = provider.backend === 'claude' ? ClaudeEngine : CodexEngine;
        engine = new Engine(provider, session, options, recorded);
        if (provider.backend === 'codex') { indicator.start(); await engine.run(prompt, { goal, resumeGoal: resumeGoal || attempts > 0 }); if (engine.interrupted) stopping ||= engine.stopReason || session.goal?.reason || 'interrupted'; }
        else {
          let turns = 0;
          do {
            if (stopping) break;
            if (goal) { session.goal.turns++; saveSession(session); }
            indicator.start(); const result = await engine.run(prompt, { goal }); indicator.stop(); turns++;
            if (result.interrupted || engine.interrupted) stopping ||= engine.stopReason || 'interrupted';
            if (goal) session.goal.supervisorTokensUsed = (session.goal.supervisorTokensUsed || 0) + Math.max(0, result.tokens || 0);
            if (goal && stopping) session.goal.tokensUsed += Math.max(0, result.tokens || 0);
            else if (goal) {
              applyReport(session, result.report, result.activity, result.tokens);
              if (session.goal.status === 'active' && options.maxTurns && turns >= options.maxTurns) { session.goal.status = 'paused'; session.goal.reason = 'turn_limit'; saveSession(session); }
              recorded.event('goal', { status: session.goal.status, tokensUsed: session.goal.tokensUsed });
              checkpoint(session, { pendingActions: ['Continue verification against the full task objective.'] });
            }
          } while (goal && session.goal.status === 'active' && !stopping);
        }
        await engine.close(); engine = null;
        if (fullText) { artifact(session, fullText, 'agent-output'); fullText = ''; }
        if (!goal || stopping || session.goal.status !== 'verifying') break;
        session.executionState = 'verifying'; saveSession(session);
        session.acceptance = await assessCompletion(session, { signal: abort.signal });
        if (session.acceptance.passed) {
          session.goal.status = 'complete'; session.goal.reason = null;
          session.goal.evidence = [...new Set([...(session.goal.evidence || []), ...session.acceptance.artifacts.filter(a => a.passed).map(a => a.evidence), ...session.acceptance.checks.filter(c => c.passed).map(c => c.evidence)])]; break;
        }
        attempts++; checkpoint(session, { pendingActions: ['Repair failed acceptance criteria; inspect previousAcceptance using get_task_state.'] });
        if (attempts > (session.contract?.limits.maxRetries ?? 2)) { session.goal.status = 'awaiting_review'; session.goal.reason = 'Acceptance checks remain unsatisfied after bounded follow-ups.'; break; }
        session.goal.status = 'active'; session.executionState = 'running'; saveSession(session);
        recorded.event('info', { message: session.acceptance.delegation?.passed === false ? session.acceptance.delegation.reason : 'Completion assessment found unmet requirements. Continuing with saved verification feedback.' });
      } while (!stopping);
    } finally { clearTimeout(deadline); }
    if (stopping) {
      session.executionState = stopping === 'cancelled' ? 'cancelled' : 'paused';
      if (goal && session.goal.status !== 'complete') { session.goal.status = stopping === 'cancelled' ? 'cancelled' : ['runtime_limit', 'token_limit'].includes(stopping) ? 'budget_limited' : 'paused'; session.goal.reason = stopping; }
    } else session.executionState = 'idle';
    return stopping ? ['interrupted', 'user_pause', 'cancelled'].includes(stopping) ? 130 : 2 : goal && session.goal.status !== 'complete' ? 2 : 0;
  } catch (error) {
    failedThisTurn = true;
    const failure = classifyFailure(error); session.failure = failure; session.executionState = stopping === 'cancelled' ? 'cancelled' : stopping ? 'paused' : 'failed';
    const budgetLimited = ['runtime_limit', 'token_limit'].includes(stopping);
    if (goal && !['complete', 'cancelled'].includes(session.goal.status)) {
      session.goal.status = stopping === 'cancelled' ? 'cancelled' : stopping ? budgetLimited ? 'budget_limited' : 'paused' : failure.category === 'rate_limit' ? 'usage_limited' : 'blocked';
      session.goal.reason = stopping || failure.message;
    }
    if (stopping) return budgetLimited ? 2 : 130;
    throw error;
  } finally {
    clearInterval(heartbeat); clearInterval(controls); clearTimeout(killTimer); indicator.stop(); process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); ui.beforeOutput = null;
    try {
      const cleanups = await Promise.allSettled([engine?.close(), host?.close(), traffic?.close()]);
      for (const cleanup of cleanups) if (cleanup.status === 'rejected') recorded.event('error', { message: `Cleanup failed: ${cleanup.reason.message}` });
      const activeAssignments = activeAssignmentsFor(session);
      for (const job of activeAssignments) cancelAssignment(session.id, job.id, stopping || 'Parent execution ended before assignment review.');
      await Promise.all(activeAssignments.map(job => waitAssignment(session.id, job.id, 5)));
    }
    finally {
      try {
      if (fullText) artifact(session, fullText, 'agent-output');
      const elapsed = (Date.now() - started) / 1000;
      session.elapsedSeconds = (session.elapsedSeconds || 0) + elapsed; session.stopReason = stopping || null;
      if (goal) session.goal.runtimeUsedSeconds = (session.goal.runtimeUsedSeconds || 0) + elapsed;
      session.summary = { usage: usageSummary(session), elapsedSeconds: elapsed, finishedAt: now() };
      if (session.mode === 'delegate') { session.delegationUsage = session.summary.usage; recorded.event('delegation.usage', session.summary.usage); }
      if (goal) { session.goal.delegatedTokensUsed = session.summary.usage.delegatedTokens; session.goal.tokensUsed = session.summary.usage.totalTokens; }
      if (goal) session.goal.evidence = [...new Set([...(session.goal.evidence || []), ...artifactsFor(session.id).filter(a => a.label === 'agent-output').map(a => a.id)])];
      delete session.deferTerminalNotification;
      saveSession(session); putRecord('run', session.id, { ...getRecord('run', session.id), state: session.executionState, finishedAt: now() });
      closeOpenActivities(session);
      writeProjectRecord(session, 'goals', session.goal?.id || session.id, { sessionId: session.id, goal: session.goal, summary: session.summary, acceptance: session.acceptance || null });
      learningForTurn(session, prompt, { goal, stopped: Boolean(stopping || failedThisTurn) });
      if (goal) {
        printGoalSummary(session, recorded);
        try { await new NotificationHub({ ui: recorded }).publish(session); } catch (error) { recorded.event('error', { message: `Goal notification failed: ${error.message}` }); }
      }
      } finally { unlock(); }
    }
  }
}
