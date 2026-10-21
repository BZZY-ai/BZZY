import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { root } from './process.js';
import { listRecords, getRecord, putRecord, appendEvent, now } from './database.js';
import { loadSession, saveSession } from './store.js';
import { processIdentity, identityAlive, signalProcess } from './recovery.js';
import { closeOpenActivities } from './activity.js';
import { diagnosticError } from './diagnostic-error.js';

const active = job => ['queued', 'launching', 'running'].includes(job.state);
function descendant(sessionId, rootId) {
  for (let id = sessionId, depth = 0; id && depth < 20; depth++) {
    if (id === rootId) return true;
    id = loadSession(id)?.parentSessionId;
  }
  return false;
}
function backendIdentity(session, runner) {
  const saved = session?.backendProcess;
  if (!saved || !identityAlive(saved)) return null;
  if (saved.start !== 'platform-unverified') return saved;
  // Upgrade a legacy macOS record only while its verified parent still owns it.
  if (!runner) return null;
  const current = processIdentity(saved.pid);
  return current?.ppid === runner?.pid && runner.start !== 'platform-unverified' && identityAlive(runner) ? current : null;
}
function verifiedRunner(job) {
  if (job.runner?.start !== 'platform-unverified') return job.runner;
  const current = processIdentity(job.runner.pid);
  if (!current) return null;
  const result = spawnSync('/bin/ps', ['-ww', '-p', String(current.pid), '-o', 'command='], { encoding: 'utf8', timeout: 1000 });
  return result.status === 0 && result.stdout.includes(path.join(root, 'bin', 'bzzy.js')) && result.stdout.includes(`internal-execution ${job.id}`) ? current : null;
}
export function requestExecutionStop(sessionId, controlId, action) {
  for (const job of listRecords('execution').filter(job => active(job) && descendant(job.sessionId, sessionId))) {
    const runner = verifiedRunner(job);
    const backend = backendIdentity(loadSession(job.sessionId), runner);
    const stopping = { ...job, runner: runner || job.runner, stopAction: action, stopControlId: controlId, stopRequestedAt: job.stopRequestedAt || now(),
      stopDeadline: job.stopDeadline || Date.now() + 1500, stopBackend: backend || job.stopBackend || null };
    putRecord('execution', job.id, stopping);
    // The supervisor delivers the signal; the runner need not poll its queue.
    if (runner) signalProcess(runner, 'SIGTERM');
  }
}
function logDetail(job) {
  if (!job.logPath) return '';
  let fd;
  try {
    fd = fs.openSync(job.logPath, 'r');
    const size = fs.fstatSync(fd).size, bytes = Buffer.alloc(Math.min(size, 4000));
    fs.readSync(fd, bytes, 0, bytes.length, Math.max(0, size - bytes.length));
    return diagnosticError(bytes.toString('utf8').trim());
  } catch { return ''; }
  finally { if (fd != null) fs.closeSync(fd); }
}
export function settleExecutionControls(job) {
  for (const control of listRecords('control').filter(control => control.sessionId === job.sessionId && ['queued', 'dispatched'].includes(control.state)
    && ['pause', 'cancel'].includes(control.action) && (!control.executionId || control.executionId === job.id))) {
    putRecord('control', control.id, { ...control, state: 'observed', result: { executionEnded: true, executionId: job.id } });
    appendEvent(job.sessionId, 'control.observed', { id: control.id, action: control.action, executionEnded: true });
  }
}
function finish(job, { stopped = false, forced = false, error } = {}) {
  const current = getRecord('execution', job.id);
  if (!current || !active(current)) return;
  settleExecutionControls(current);
  const session = loadSession(job.sessionId), exitCode = stopped ? 130 : 1;
  if (session) {
    session.backendProcess = null;
    session.executionState = stopped ? job.stopAction === 'cancel' ? 'cancelled' : 'paused' : 'failed';
    session.stopReason = stopped ? job.stopAction === 'cancel' ? 'cancelled' : 'user_pause' : null;
    session.failure = stopped ? null : { category: 'runner_failure', message: error, retryable: false };
    if (job.goal && session.goal && !['complete', 'cancelled'].includes(session.goal.status)) {
      session.goal.status = stopped ? job.stopAction === 'cancel' ? 'cancelled' : 'paused' : 'blocked';
      session.goal.reason = session.stopReason || error;
    }
    for (const question of listRecords('question').filter(item => item.sessionId === session.id && item.state === 'pending')) putRecord('question', question.id, { ...question, state: 'expired', reason: 'Execution stopped.' });
    for (const operation of listRecords('operation').filter(item => item.sessionId === session.id && ['planned', 'dispatched'].includes(item.state))) putRecord('operation', operation.id, { ...operation, state: 'uncertain', recoveryAt: now() });
    saveSession(session); closeOpenActivities(session);
  }
  putRecord('run', job.sessionId, { ...getRecord('run', job.sessionId), state: session?.executionState || 'failed', finishedAt: now() });
  putRecord('execution', job.id, { ...current, state: 'stopped', exitCode, error: error || null, forced, finishedAt: now() });
  if (error) appendEvent(job.sessionId, 'error', { message: error });
  if (stopped) {
    const control = getRecord('control', job.stopControlId);
    if (control) putRecord('control', control.id, { ...control, state: 'observed', result: { stopped: true, forced } });
    appendEvent(job.sessionId, 'info', { message: job.stopAction === 'cancel' ? 'Current execution cancelled.' : 'Current response stopped. You can send another message.' });
  }
  appendEvent(job.sessionId, 'execution.finished', { id: job.id, exitCode, error: error || null, forced });
}

export function superviseExecutions() {
  for (const stored of listRecords('execution').filter(active)) {
    let job = getRecord('execution', stored.id);
    if (!job || !active(job)) continue;
    if (!job.stopAction) {
      const control = listRecords('control').find(control => control.sessionId === job.sessionId && ['queued', 'dispatched'].includes(control.state)
        && ['pause', 'cancel'].includes(control.action) && (control.executionId ? control.executionId === job.id : control.createdAt >= job.createdAt));
      if (control) { requestExecutionStop(job.sessionId, control.id, control.action); job = getRecord('execution', job.id); }
    }
    if (job.state === 'queued' && !job.stopAction) continue;
    if (job.runner?.start === 'platform-unverified') {
      const runner = verifiedRunner(job);
      if (!runner) {
        finish(job, { stopped: Boolean(job.stopAction), error: job.stopAction ? undefined : 'The saved runner PID no longer belongs to this execution. The stale execution was released without signalling the unrelated process.' });
        continue;
      }
      job = { ...job, runner }; putRecord('execution', job.id, job);
    }
    const runnerAlive = identityAlive(job.runner);
    const backend = job.stopBackend || backendIdentity(loadSession(job.sessionId), job.runner);
    if (job.stopAction) {
      if (Date.now() >= job.stopDeadline) {
        if (backend) signalProcess(backend, 'SIGKILL', { group: true });
        if (job.runner) { signalProcess(job.runner, 'SIGKILL', { group: true }); signalProcess(job.runner, 'SIGKILL'); }
      }
      if (!identityAlive(job.runner) && !identityAlive(backend)) finish(job, { stopped: true, forced: Date.now() >= job.stopDeadline });
      continue;
    }
    if (runnerAlive) continue;
    // Launch reservations briefly lack a PID while spawn hands it back.
    if (!job.runner && !job.runnerExitedAt && Date.now() - Date.parse(job.launchedAt || job.createdAt) < 5000) continue;
    if (backend) { signalProcess(backend, 'SIGKILL', { group: true }); if (identityAlive(backend)) continue; }
    const detail = logDetail(job);
    finish(job, { error: `The execution runner exited before reporting completion${job.runnerExitSignal ? ` (${job.runnerExitSignal})` : job.runnerExitCode != null ? ` (exit ${job.runnerExitCode})` : ''}.${detail ? ` ${detail}` : ''}${job.logPath ? ` Log: ${job.logPath}` : ''}` });
  }
}
