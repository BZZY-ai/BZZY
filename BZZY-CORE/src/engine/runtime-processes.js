import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { root } from './process.js';
import { listRecords, getRecord, putRecord, removeRecord, appendEvent, now, transaction, digest } from './database.js';
import { loadSession, saveSession } from './store.js';
import { processIdentity, identityAlive, signalProcess } from './recovery.js';
import { closeOpenActivities } from './activity.js';
import { diagnosticError } from './diagnostic-error.js';
import { removeExecutionEnvironment } from './execution-environment.js';
import { setTimeout as delay } from 'node:timers/promises';

const active = job => ['queued', 'launching', 'running'].includes(job.state);
export function reserveExecutionLaunch(id, logPath, { engineDirectory = root, engineBuild } = {}) {
  // A coordinator in another process may cancel a queued job after the
  // scheduler selects its batch. Claim the current record under the same write
  // lock used by cancellation, so a stale candidate cannot revive stopped work.
  return transaction(db => {
    const job = getRecord('execution', id);
    if (job?.state !== 'queued' || job.stopAction) return null;
    const reserved = { ...job, state: 'launching', launchedAt: now(), logPath, engineDirectory, engineBuild };
    putRecord('execution', id, reserved, db);
    return reserved;
  });
}
export function recordExecutionProcess(id, metadata) {
  // Process identification can take long enough for another process to stop or
  // finish the execution. Attach metadata to its current state, never a snapshot
  // taken before identifying the spawned process.
  const fields = Object.fromEntries(['runner', 'runnerExitedAt', 'runnerExitCode', 'runnerExitSignal', 'runnerMissingAt']
    .filter(key => Object.hasOwn(metadata, key)).map(key => [key, metadata[key]]));
  return transaction(db => {
    const job = getRecord('execution', id);
    if (!job) return null;
    return putRecord('execution', id, { ...job, ...fields }, db);
  });
}
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
  return result.status === 0 && result.stdout.includes(path.join(job.engineDirectory || root, 'bin', 'bzzy-engine.js')) && result.stdout.includes(`internal-execution ${job.id}`) ? current : null;
}
export function requestExecutionStop(sessionId, controlId, action) {
  for (const job of listRecords('execution', { states: ['queued', 'launching', 'running'] }).filter(job => descendant(job.sessionId, sessionId))) {
    const runner = verifiedRunner(job);
    const backend = backendIdentity(loadSession(job.sessionId), runner);
    const stopping = transaction(db => {
      const current = getRecord('execution', job.id);
      if (!current || !active(current)) return null;
      return putRecord('execution', job.id, { ...current, runner: runner || current.runner, stopAction: action, stopControlId: controlId,
        stopRequestedAt: current.stopRequestedAt || now(), stopDeadline: current.stopDeadline || Date.now() + 1500,
        stopBackend: backend || current.stopBackend || null }, db);
    });
    if (!stopping) continue;
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
  for (const control of listRecords('control', { sessionId: job.sessionId, states: ['queued', 'dispatched'] }).filter(control => ['pause', 'cancel'].includes(control.action) && (!control.executionId || control.executionId === job.id))) {
    putRecord('control', control.id, { ...control, state: 'observed', result: { executionEnded: true, executionId: job.id } });
    appendEvent(job.sessionId, 'control.observed', { id: control.id, action: control.action, executionEnded: true });
  }
}
function finish(job, { stopped = false, forced = false, error } = {}) {
  const current = getRecord('execution', job.id);
  if (!current || !active(current)) return;
  removeExecutionEnvironment(job.id);
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
    for (const question of listRecords('question', { sessionId: session.id, state: 'pending' })) putRecord('question', question.id, { ...question, state: 'expired', reason: 'Execution stopped.' });
    for (const operation of listRecords('operation').filter(item => item.sessionId === session.id && ['planned', 'dispatched'].includes(item.state))) putRecord('operation', operation.id, { ...operation, state: 'uncertain', recoveryAt: now() });
    // The runner normally releases this in its finally block. A forced exit
    // cannot execute that cleanup; terminal supervision owns the outcome now.
    delete session.deferTerminalNotification;
    saveSession(session); closeOpenActivities(session);
  }
  putRecord('run', job.sessionId, { ...getRecord('run', job.sessionId), state: session?.executionState || 'failed', finishedAt: now() });
  if (error) appendEvent(job.sessionId, 'error', { message: error });
  if (stopped) {
    const control = getRecord('control', job.stopControlId);
    if (control) putRecord('control', control.id, { ...control, state: 'observed', result: { stopped: true, forced } });
    appendEvent(job.sessionId, 'info', { message: job.stopAction === 'cancel' ? 'Current execution cancelled.' : 'Current response stopped. You can send another message.' });
  }
  transaction(db => {
    putRecord('execution', job.id, { ...current, state: 'stopped', exitCode, error: error || null, forced, finishedAt: now() }, db);
    appendEvent(job.sessionId, 'execution.finished', { id: job.id, exitCode, error: error || null, forced }, db);
  });
}

export function superviseExecutions() {
  for (const stored of listRecords('execution', { states: ['queued', 'launching', 'running'] })) {
    let job = getRecord('execution', stored.id);
    if (!job || !active(job)) continue;
    if (!job.stopAction) {
      const control = listRecords('control', { sessionId: job.sessionId, states: ['queued', 'dispatched'] }).find(control => ['pause', 'cancel'].includes(control.action) && (control.executionId ? control.executionId === job.id : control.createdAt >= job.createdAt));
      if (control) { requestExecutionStop(job.sessionId, control.id, control.action); job = getRecord('execution', job.id); }
    }
    if (job.state === 'queued' && !job.stopAction) continue;
    if (job.runner?.start === 'platform-unverified') {
      const runner = verifiedRunner(job);
      if (!runner) {
        finish(job, { stopped: Boolean(job.stopAction), error: job.stopAction ? undefined : 'The saved runner PID no longer belongs to this execution. The stale execution was released without signalling the unrelated process.' });
        continue;
      }
      job = recordExecutionProcess(job.id, { runner });
      if (!job || !active(job)) continue;
    }
    const runnerAlive = identityAlive(job.runner);
    if (runnerAlive && !job.stopAction) {
      if (job.runnerMissingAt) recordExecutionProcess(job.id, { runnerMissingAt: null });
      continue;
    }
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
    // A scheduler tick can observe death before Node dispatches the child exit
    // callback. Give it a bounded opportunity to save the actual exit status.
    if (job.runner && !job.runnerExitedAt) {
      if (!job.runnerMissingAt) { recordExecutionProcess(job.id, { runnerMissingAt: Date.now() }); continue; }
      if (Date.now() - job.runnerMissingAt < 250) continue;
    }
    if (backend) { signalProcess(backend, 'SIGKILL', { group: true }); if (identityAlive(backend)) continue; }
    const detail = logDetail(job);
    finish(job, { error: `The execution runner exited before reporting completion${job.runnerExitSignal ? ` (${job.runnerExitSignal})` : job.runnerExitCode != null ? ` (exit ${job.runnerExitCode})` : ''}.${detail ? ` ${detail}` : ''}${job.logPath ? ` Log: ${job.logPath}` : ''}` });
  }
}

// Trusted operator stop pauses every managed job, including nested workers.
// Callers must first stop accepting/launching work. Never report success while
// a verified runner/backend is still alive, or signal an unverifiable PID.
export async function pauseRuntimeExecutions({ timeoutMs = 8000 } = {}) {
  const deadline = Date.now() + timeoutMs, controls = new Map(), assignmentStops = new Map(), targets = new Map(), unverifiable = new Map();
  const remember = identity => {
    if (!identity || !identityAlive(identity)) return;
    const key = digest(identity);
    if (identity.start === 'platform-unverified') unverifiable.set(key, identity);
    else targets.set(key, identity);
    // The supervisor may settle a job before a legacy PID can be verified.
    // Keep its private identity receipt across retries/crashes so a later stop
    // cannot forget the remaining process and incorrectly report success.
    if (!getRecord('runtime-stop-target', key)) putRecord('runtime-stop-target', key, { id: key, identity, discoveredAt: now() });
  };
  for (const receipt of listRecords('runtime-stop-target')) {
    if (identityAlive(receipt.identity)) remember(receipt.identity);
    else removeRecord('runtime-stop-target', receipt.id);
  }
  while (true) {
    // Document calls are daemon-owned rather than managed execution jobs.
    // Include their verified backend identities in the operator stop barrier.
    for (const session of listRecords('session').filter(item => item.role === 'learning-review' && item.purpose === 'document')) {
      const identity = session.backendProcess;
      remember(identity);
      if (identity?.start !== 'platform-unverified') signalProcess(identity, 'SIGTERM', { group: true });
    }
    for (const round of listRecords('round').filter(item => ['starting', 'running'].includes(item.state))) {
      const key = `${round.assignmentId}:${round.number}`;
      if (!assignmentStops.has(key)) {
        assignmentStops.set(key, { assignmentId: round.assignmentId, number: round.number });
        transaction(db => {
          const current = getRecord('round', key);
          if (!current || !['starting', 'running'].includes(current.state)) return;
          putRecord('round', key, { ...current, operatorStopRequestedAt: now() }, db);
          putRecord('assignment-control', round.assignmentId, { action: 'cancel', round: round.number, reason: 'host_operator_stop', createdAt: now() }, db);
        });
      }
    }
    for (const [key, item] of assignmentStops) {
      const round = getRecord('round', key), assignment = getRecord('assignment', item.assignmentId);
      const session = assignment?.workerSessionId && loadSession(assignment.workerSessionId);
      const identities = [round?.runner, round?.launcher, session?.backendProcess];
      identities.forEach(remember);
      // New records use verified process identities. Unverifiable legacy PIDs
      // are retained as blockers rather than receiving an unsafe signal.
      if (round && ['starting', 'running'].includes(round.state)) {
        for (const identity of [round.runner, round.launcher]) if (identity?.start !== 'platform-unverified') signalProcess(identity, 'SIGTERM');
      }
      if (identities.every(identity => !identityAlive(identity))) {
        transaction(db => {
          const current = getRecord('round', key);
          if (current?.operatorStopRequestedAt && ['starting', 'running', 'cancelled', 'failed'].includes(current.state)) {
            putRecord('round', key, { ...current, state: 'interrupted', reason: 'host_operator_stop', finishedAt: now() }, db);
            if (assignment) appendEvent(assignment.parentSessionId, 'assignment.interrupted', { id: item.assignmentId, round: item.number, reason: 'host_operator_stop' }, db);
          }
        });
        if (session && ['running', 'waiting_for_input', 'verifying', 'cancelled', 'failed'].includes(session.executionState)) {
          saveSession({ ...session, executionState: 'paused', backendProcess: null, stopReason: 'host_operator_stop' });
          closeOpenActivities(session);
        }
      }
    }
    for (const job of listRecords('execution', { states: ['queued', 'launching', 'running'] })) {
      const runner = verifiedRunner(job), session = loadSession(job.sessionId), backend = backendIdentity(session, runner);
      remember(runner || job.runner); remember(backend || session?.backendProcess); remember(job.stopBackend);
      if (!controls.has(job.id)) {
        const id = randomUUID();
        const control = { id, sessionId: job.sessionId, executionId: job.id, action: 'pause', state: 'queued', createdAt: now(), source: 'host-operator' };
        transaction(db => { putRecord('control', id, control, db); appendEvent(job.sessionId, 'control.queued', control, db); });
        controls.set(job.id, id);
        requestExecutionStop(job.sessionId, id, job.stopAction === 'cancel' ? 'cancel' : 'pause');
      }
      remember(getRecord('execution', job.id)?.stopBackend);
    }
    superviseExecutions();
    const pending = listRecords('execution', { states: ['queued', 'launching', 'running'] });
    const rounds = listRecords('round').filter(item => ['starting', 'running'].includes(item.state));
    const living = [...targets.values()].filter(identityAlive), unknown = [...unverifiable.values()].filter(identityAlive);
    if (!pending.length && !rounds.length && !living.length && !unknown.length) break;
    if (Date.now() >= deadline) throw Object.assign(new Error('Core work could not be verified stopped. The runtime remains paused for an explicit retry.'), { code: 'STOP_INCOMPLETE', status: 409 });
    // A runner can settle its durable row immediately before its process exits.
    // Retain the verified identities until their OS exit is observed as well.
    if (Date.now() >= deadline - timeoutMs + 1500) for (const identity of living) {
      signalProcess(identity, 'SIGKILL', { group: true }); signalProcess(identity, 'SIGKILL');
    }
    await delay(50);
  }
  for (const receipt of listRecords('runtime-stop-target')) if (!identityAlive(receipt.identity)) removeRecord('runtime-stop-target', receipt.id);
  for (const session of listRecords('session').filter(item => ['active', 'verifying'].includes(item.goal?.status))) {
    saveSession({ ...session, goal: { ...session.goal, status: 'paused', reason: 'host_operator_stop' } });
  }
  return { pausedExecutions: controls.size + assignmentStops.size };
}
