import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { database, getRecord, putRecord, listRecords, appendEvent, events, reserveRequest, transaction, now, digest } from './database.js';
import { processIdentity, identityAlive, signalProcess } from './process-identity.js';
import { toolEnvironment } from './execution-environment.js';
import { assertShareText, sharedSecrets } from './share-bundle-policy.js';
import { notificationPreview } from './notification-preview.js';

export const backgroundJobKind = 'core.background.job';
export const backgroundNotificationTypes = new Set(['job.completed', 'job.failed', 'job.timed_out', 'job.interrupted']);
export const backgroundStates = ['queued', 'launching', 'running', 'cancelling', 'completed', 'failed', 'cancelled', 'timed_out', 'interrupted'];
export const backgroundActive = job => ['queued', 'launching', 'running', 'cancelling'].includes(job?.state);
const fail = (message, code = 'INVALID_JOB', status = 400) => Object.assign(new Error(message), { code, status });
const uuid = value => typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value);
const jobEvent = ({ sessionId, ...event }) => ({ ...event, jobId: sessionId });

export function publicBackgroundJob(job) {
  if (!job) return null;
  const { specification, runner, process: child, launcher, eventFingerprint, ...publicFields } = job;
  return publicFields;
}
export function backgroundJob(id) {
  if (!uuid(id)) throw fail('Choose an existing background job ID.', 'JOB_NOT_FOUND', 404);
  const job = getRecord(backgroundJobKind, id);
  if (!job) throw fail('Unknown background job.', 'JOB_NOT_FOUND', 404);
  return publicBackgroundJob(job);
}
function normalize(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['script', 'args', 'cwd', 'timeoutSeconds', 'notify'].includes(key)))
    throw fail('A job accepts script, args, cwd, timeoutSeconds and notify.');
  const { script, args = [], cwd, timeoutSeconds = 0, notify = false } = input;
  if (typeof notify !== 'boolean') throw fail('notify must be a boolean.');
  if (typeof script !== 'string' || !script.trim() || script.includes('\0') || script.length > 4096 || typeof cwd !== 'string' || !path.isAbsolute(cwd) || cwd.includes('\0'))
    throw fail('Supply a script path and absolute working directory.');
  if (!Array.isArray(args) || args.length > 1024 || args.some(value => typeof value !== 'string' || value.includes('\0')) || Buffer.byteLength(JSON.stringify(args)) > 128 * 1024)
    throw fail('Job args must be literal strings, at most 1024 arguments / 128 KiB.');
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 0 || timeoutSeconds > 604800) throw fail('timeoutSeconds must be 0–604800 (0 means no timeout).');
  const specification = { script: path.resolve(cwd, script), args, cwd: path.resolve(cwd), timeoutSeconds, notify };
  // Arguments are private execution data, never alert/event previews. Obvious
  // credentials are rejected rather than written into a durable command line.
  try {
    const secrets = sharedSecrets();
    for (const text of [script, cwd, ...args]) {
      assertShareText(text, secrets);
      if (/(?:^|\s)--?(?:api[-_]?key|(?:access[-_]|auth[-_]|refresh[-_])?token|password|passwd|secret|cookie)(?:[=\s]|$)|\b(?:authorization|password|api[_-]?key|access[_-]?token|secret)\s*[:=]/i.test(text)) throw new Error();
    }
  } catch { throw fail('Credentials must use an authorized private binding, never script arguments.'); }
  return specification;
}
export function submitBackgroundJob(input, requestId) {
  if (!['linux', 'darwin'].includes(process.platform)) throw fail('Background process supervision requires Linux or macOS.', 'JOB_PLATFORM');
  const specification = normalize(input);
  const receipt = reserveRequest('background:submit', requestId, specification, db => {
    if (listRecords(backgroundJobKind, { states: ['queued', 'launching', 'running', 'cancelling'], limit: 129 }).length >= 128)
      throw fail('Background job queue is full.', 'JOB_CAPACITY', 429);
    let stat;
    try {
      if (!fs.statSync(specification.cwd).isDirectory()) throw new Error();
      stat = fs.statSync(specification.script);
      if (!stat.isFile()) throw new Error();
      fs.accessSync(specification.script, fs.constants.R_OK);
    } catch { throw fail('The script must be a readable regular file and cwd an existing directory.'); }
    let command;
    try { fs.accessSync(specification.script, fs.constants.X_OK); command = [specification.script]; }
    catch {
      const extension = path.extname(specification.script).toLowerCase();
      command = extension === '.py' ? ['python3', '-u', specification.script]
        : ['.js', '.mjs', '.cjs'].includes(extension) ? [process.execPath, specification.script]
        : extension === '.sh' ? ['/bin/sh', specification.script] : null;
    }
    if (!command) throw fail('Make the script executable, or use a .py, .js, .mjs, .cjs or .sh file.');
    const id = randomUUID(), createdAt = now();
    const event = appendEvent(id, 'job.queued', { state: 'queued' }, db);
    const job = { version: 1, id, state: 'queued', script: specification.script, cwd: specification.cwd, timeoutSeconds: specification.timeoutSeconds, notify: specification.notify,
      notificationName: notificationPreview(path.basename(specification.script), 64, sharedSecrets()) || 'script',
      sequence: event.seq, createdAt, updatedAt: createdAt, logBytes: 0, logsTruncated: false };
    putRecord('core.background.specification', id, { ...specification, command, file: { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs } }, db);
    putRecord(backgroundJobKind, id, job, db);
    return { id };
  });
  return backgroundJob(receipt.id);
}
export function listBackgroundJobs({ before = Number.MAX_SAFE_INTEGER, limit = 100, state } = {}) {
  if (!Number.isSafeInteger(before) || before < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500 || state !== undefined && !backgroundStates.includes(state)) throw fail('Invalid job page or state filter.');
  const rows = database().prepare(`SELECT data FROM records WHERE kind=? AND json_extract(data,'$.sequence')<?${state ? " AND json_extract(data,'$.state')=?" : ''} ORDER BY json_extract(data,'$.sequence') DESC LIMIT ?`)
    .all(backgroundJobKind, before, ...(state ? [state] : []), limit);
  const items = rows.map(row => publicBackgroundJob(JSON.parse(row.data)));
  return { items, nextCursor: items.at(-1)?.sequence || before, hasMore: items.length === limit };
}
export function backgroundJobEvents(id, after = 0, limit = 200, { logs = false } = {}) {
  backgroundJob(id);
  if (!logs) return events(id, after, limit).map(jobEvent);
  events(id, after, 1); // Shared strict cursor validation.
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw fail('Invalid log page limit.');
  return database().prepare("SELECT * FROM events WHERE session_id=? AND seq>? AND type='job.log' ORDER BY seq LIMIT ?").all(id, after, limit)
    .map(row => ({ version: 1, id: `${id}:${row.seq}`, jobId: id, seq: row.seq, type: row.type, data: JSON.parse(row.data), createdAt: row.created_at }));
}
export function finishBackgroundJob(id, state, outcome = {}, connection) {
  if (!['completed', 'failed', 'cancelled', 'timed_out', 'interrupted'].includes(state)) throw fail('Invalid job outcome.');
  const finish = db => {
    const job = getRecord(backgroundJobKind, id);
    if (!backgroundActive(job)) return job;
    const finalState = job.stopReason === 'JOB_CANCELLED' ? 'cancelled' : job.stopReason === 'JOB_TIMEOUT' ? 'timed_out'
      : ['CORE_STOPPED', 'JOB_INTERRUPTED'].includes(job.stopReason) ? 'interrupted' : job.stopReason ? 'failed' : state;
    const occurredAt = now(), event = { version: 1, id: digest({ backgroundJob: id }), type: `job.${finalState}`, jobId: id, occurredAt };
    const result = { exitCode: Number.isInteger(outcome.exitCode) ? outcome.exitCode : null,
      signal: /^SIG[A-Z0-9]+$/.test(outcome.signal || '') ? outcome.signal : null,
      code: ['JOB_EXIT', 'JOB_START_FAILED', 'JOB_SCRIPT_CHANGED', 'JOB_TIMEOUT', 'JOB_CANCELLED', 'CORE_STOPPED', 'JOB_INTERRUPTED', 'JOB_LOG_FAILURE'].includes(job.stopReason || outcome.code) ? job.stopReason || outcome.code : null };
    const saved = { ...job, state: finalState, outcome: result, completedAt: occurredAt, updatedAt: occurredAt, eventFingerprint: digest(event) };
    putRecord(backgroundJobKind, id, saved, db);
    appendEvent(id, event.type, { state: finalState, outcome: result }, db);
    if (job.notify && backgroundNotificationTypes.has(event.type)) putRecord('outbox', event.id, { event, deliveries: {} }, db);
    return saved;
  };
  return connection ? finish(connection) : transaction(finish);
}
export function currentBackgroundOutcome(event) {
  if (!backgroundNotificationTypes.has(event?.type) || !uuid(event.jobId)) return null;
  const job = getRecord(backgroundJobKind, event.jobId);
  return job?.notify && job?.eventFingerprint === digest(event) && event.type === `job.${job.state}` ? publicBackgroundJob(job) : null;
}
export function cancelBackgroundJob(id, requestId, reason = 'JOB_CANCELLED') {
  if (!['JOB_CANCELLED', 'CORE_STOPPED'].includes(reason)) throw fail('Invalid job cancellation reason.');
  backgroundJob(id);
  reserveRequest(`background:cancel:${id}`, requestId, { reason }, db => {
    const job = getRecord(backgroundJobKind, id);
    if (!backgroundActive(job) || job.stopReason) return { id };
    putRecord(backgroundJobKind, id, { ...job, stopReason: reason, state: 'cancelling', stopRequestedAt: now(), updatedAt: now() }, db);
    appendEvent(id, 'job.cancelling', { state: 'cancelling', reason }, db);
    if (job.state === 'queued') finishBackgroundJob(id, reason === 'JOB_CANCELLED' ? 'cancelled' : 'interrupted', { code: reason }, db);
    return { id };
  });
  return backgroundJob(id);
}

// A launch is durably claimed before spawning. Recovery never turns a launching
// or running job back into queued: uncertain side effects cannot be replayed.
export function pumpBackgroundJobs({ launch = true } = {}) {
  const jobs = listRecords(backgroundJobKind, { states: ['queued', 'launching', 'running', 'cancelling'] }).sort((a, b) => a.sequence - b.sequence);
  let count = jobs.filter(job => job.state !== 'queued').length;
  for (const job of jobs) {
    if (job.state === 'queued') {
      if (!launch || count >= 8) continue;
      const reserved = transaction(db => {
        const current = getRecord(backgroundJobKind, job.id);
        if (current?.state !== 'queued') return null;
        return putRecord(backgroundJobKind, job.id, { ...current, state: 'launching', launcher: processIdentity(), launchedAt: now(), updatedAt: now() }, db);
      });
      if (!reserved) continue;
      count++;
      const child = spawn(process.execPath, [fileURLToPath(new URL('./background-job-worker.js', import.meta.url)), job.id], {
        detached: true, env: toolEnvironment(), stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      const timer = setTimeout(() => { if (child.connected) child.disconnect(); }, 15_000); timer.unref();
      child.on('message', message => {
        if (message?.type !== 'ready' || message.id !== job.id || !child.connected) return;
        const current = getRecord(backgroundJobKind, job.id);
        // The worker has published its identity, but cannot execute before this
        // Core authorization. A lost startup handshake is never replayed.
        child.send({ type: current?.state === 'launching' && !current.stopReason ? 'go' : 'stop' }, () => { clearTimeout(timer); if (child.connected) child.disconnect(); });
      });
      child.once('error', () => { clearTimeout(timer); finishBackgroundJob(job.id, 'failed', { code: 'JOB_START_FAILED' }); });
      child.once('exit', () => { clearTimeout(timer); }); child.unref(); child.channel?.unref();
      continue;
    }
    if (job.runner && identityAlive(job.runner)) continue;
    if (job.state === 'launching' && identityAlive(job.launcher) && Date.now() - Date.parse(job.launchedAt) < 20_000) continue;
    if (job.process) signalProcess(job.process, 'SIGKILL', { group: true });
    finishBackgroundJob(job.id, job.stopReason === 'JOB_CANCELLED' ? 'cancelled' : 'interrupted', { code: job.stopReason || 'JOB_INTERRUPTED' });
  }
}
export async function stopBackgroundJobs() {
  for (const job of listRecords(backgroundJobKind, { states: ['queued', 'launching', 'running', 'cancelling'] })) cancelBackgroundJob(job.id, `core-stop:${job.id}`, 'CORE_STOPPED');
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    pumpBackgroundJobs({ launch: false });
    if (!listRecords(backgroundJobKind, { states: ['queued', 'launching', 'running', 'cancelling'], limit: 1 }).length) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  for (const job of listRecords(backgroundJobKind, { states: ['queued', 'launching', 'running', 'cancelling'] })) {
    if (job.process) signalProcess(job.process, 'SIGKILL', { group: true });
    if (job.runner) signalProcess(job.runner, 'SIGKILL', { group: true });
  }
  await new Promise(resolve => setTimeout(resolve, 100)); pumpBackgroundJobs({ launch: false });
  if (listRecords(backgroundJobKind, { states: ['queued', 'launching', 'running', 'cancelling'], limit: 1 }).length)
    throw fail('Core could not verify that every background job stopped.', 'JOB_STOP_INCOMPLETE', 409);
}
