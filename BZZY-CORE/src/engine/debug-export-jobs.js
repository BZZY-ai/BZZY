import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { home, privateDir, lockFile, findSession } from './store.js';
import { database, getRecord, putRecord, transaction, now, digest } from './database.js';
import { processIdentity, identityAlive } from './process-identity.js';
import { debugExportDiagnostic, debugExportFailure } from './debug-export-errors.js';

export const debugExportJobKind = 'core.debug.export';
export const debugExportNotificationTypes = new Set(['debug.export.completed', 'debug.export.failed']);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const active = job => ['queued', 'running'].includes(job?.state);
const phases = new Set(['session', 'destination', 'staging', 'overview', 'history', 'workspace', 'resources', 'manifest', 'packaging', 'complete']);
const counters = ['elapsedMs', 'records', 'events', 'files', 'bytes', 'exclusions', 'packagedFiles', 'packagedBytes', 'inspectedBytes'];
const jobsRoot = () => path.join(home(), 'debug-exports', 'jobs');
let lastReconciled = 0, lastHome;

export function finishDebugExportJob(id, { result, error } = {}) {
  return transaction(db => {
    const job = getRecord(debugExportJobKind, id);
    if (!active(job)) return job;
    const completed = Boolean(result), occurredAt = now();
    const outcome = completed ? { result } : { error: debugExportDiagnostic(error || debugExportFailure('SESSION_DEBUG_INTERRUPTED')) };
    const event = { version: 1, id: digest({ debugExport: id }), type: completed ? 'debug.export.completed' : 'debug.export.failed',
      jobId: id, sessionId: job.sessionId, occurredAt };
    const saved = { ...job, state: completed ? 'completed' : 'failed', ...outcome, completedAt: occurredAt, updatedAt: occurredAt,
      eventFingerprint: digest(event) };
    putRecord(debugExportJobKind, id, saved, db);
    putRecord('outbox', event.id, { event, deliveries: {} }, db);
    return saved;
  });
}

export function currentDebugExportOutcome(event) {
  if (!debugExportNotificationTypes.has(event?.type) || !uuid(event.jobId)) return null;
  const job = getRecord(debugExportJobKind, event.jobId), session = job && getRecord('session', job.sessionId);
  return job && session && !session.parentSessionId && (!session.purpose || session.purpose === 'terminal')
    && !getRecord('session-deletion', session.id) && job.eventFingerprint === digest(event) && job.sessionId === event.sessionId
    && event.type === (job.state === 'completed' ? 'debug.export.completed' : job.state === 'failed' ? 'debug.export.failed' : null) ? job : null;
}

export function reconcileDebugExportJobs({ force = true } = {}) {
  if (!force && lastHome === home() && Date.now() - lastReconciled < 5000) return;
  lastHome = home(); lastReconciled = Date.now();
  const rows = database().prepare("SELECT data FROM records WHERE kind=? AND json_extract(data,'$.state') IN ('queued','running') ORDER BY updated_at LIMIT 100")
    .all(debugExportJobKind);
  for (const { data } of rows) {
    const job = JSON.parse(data);
    // The launcher and the child publish identity independently. Do not mistake
    // that short startup window for a dead export, or replay work after a crash.
    if (job.state === 'queued' && Date.now() - Date.parse(job.createdAt) < 15_000) continue;
    if (job.identity && identityAlive(job.identity)) continue;
    finishDebugExportJob(job.id, { error: debugExportFailure('SESSION_DEBUG_INTERRUPTED') });
  }
}

export function debugExportJob(id) {
  if (!uuid(id)) throw Object.assign(new Error('Choose an existing full-debug export job ID.'), { code: 'SESSION_DEBUG_JOB_NOT_FOUND' });
  const job = getRecord(debugExportJobKind, id);
  if (!job) throw Object.assign(new Error('No matching full-debug export job.'), { code: 'SESSION_DEBUG_JOB_NOT_FOUND' });
  reconcileDebugExportJobs();
  return getRecord(debugExportJobKind, id);
}

export async function startDebugExportJob(selector, { cwd, output, captureMode = 'complete' } = {}) {
  // Resolve before creating directories, starting a process or changing Core's
  // lifecycle. Unknown/ambiguous names cannot create a chat or resume a goal.
  if (typeof selector !== 'string' || !selector.trim()) throw new Error('Use bzzy --full-debug-export SESSION [FILE.zip].');
  const session = findSession(selector);
  if (session.parentSessionId || session.purpose && session.purpose !== 'terminal' || getRecord('session-deletion', session.id))
    throw debugExportFailure('SESSION_DEBUG_SESSION');
  if (!['complete', 'bounded'].includes(captureMode)) throw debugExportFailure('SESSION_DEBUG_CAPTURE_MODE');
  if (output !== undefined && (typeof output !== 'string' || !/\.zip$/i.test(output))) throw debugExportFailure('SESSION_DEBUG_OUTPUT');
  let destination;
  try {
    destination = fs.realpathSync(cwd || session.cwd);
    if (!fs.statSync(destination).isDirectory()) throw debugExportFailure('SESSION_DEBUG_MISSING');
    fs.accessSync(destination, fs.constants.W_OK);
    if (output !== undefined) {
      const parent = path.dirname(path.resolve(destination, output)); fs.accessSync(parent, fs.constants.W_OK);
    }
    privateDir(path.dirname(jobsRoot()));
    if (fs.lstatSync(path.dirname(jobsRoot())).isSymbolicLink()) throw debugExportFailure('SESSION_DEBUG_STAGING');
    privateDir(jobsRoot());
    if (fs.lstatSync(jobsRoot()).isSymbolicLink()) throw debugExportFailure('SESSION_DEBUG_STAGING');
  } catch (error) {
    throw debugExportFailure(debugExportDiagnostic(error).code);
  }
  const unlock = lockFile(path.join(jobsRoot(), 'launch.lock'), 'Another full-debug export is starting.');
  let job, child;
  try {
    reconcileDebugExportJobs();
    const existing = database().prepare("SELECT data FROM records WHERE kind=? AND json_extract(data,'$.state') IN ('queued','running') ORDER BY updated_at LIMIT 1").get(debugExportJobKind);
    if (existing) {
      const saved = JSON.parse(existing.data);
      if (saved.sessionId === session.id && saved.cwd === destination && saved.output === output && saved.captureMode === captureMode)
        return { ...saved, existing: true };
      throw Object.assign(new Error(`A full-debug export is already running. Use bzzy debug status ${saved.id}.`), { code: 'SESSION_DEBUG_BUSY' });
    }
    if (output !== undefined) {
      try { fs.lstatSync(path.resolve(destination, output)); throw debugExportFailure('SESSION_DEBUG_EXISTS'); }
      catch (error) { if (error.code !== 'ENOENT') throw debugExportFailure(debugExportDiagnostic(error).code); }
    }
    const id = randomUUID(), createdAt = now();
    job = { version: 1, id, sessionId: session.id, state: 'queued', cwd: destination, ...(output === undefined ? {} : { output }),
      captureMode, createdAt, updatedAt: createdAt };
    putRecord(debugExportJobKind, id, job);
    child = spawn(process.execPath, [fileURLToPath(new URL('./debug-export-job-worker.js', import.meta.url)), id], {
      cwd: destination, env: { ...process.env, BZZY_HOME: home() }, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    await new Promise((resolve, reject) => {
      let timer;
      const finish = error => {
        clearTimeout(timer); child.removeListener('message', ready); child.removeListener('exit', exited);
        if (error) reject(error); else resolve();
      };
      const ready = value => { if (value?.type === 'ready' && value.jobId === id) finish(); };
      const exited = () => finish(debugExportFailure('SESSION_DEBUG_START'));
      child.once('error', () => finish(debugExportFailure('SESSION_DEBUG_START')));
      child.on('message', ready); child.once('exit', exited);
      child.once('spawn', () => {
        const identity = processIdentity(child.pid);
        transaction(db => { const latest = getRecord(debugExportJobKind, id);
          if (latest?.state === 'queued') putRecord(debugExportJobKind, id, { ...latest, identity }, db); });
      });
      timer = setTimeout(() => finish(), 5000);
    });
    return getRecord(debugExportJobKind, id);
  } catch (error) {
    if (job) finishDebugExportJob(job.id, { error: error.code?.startsWith('SESSION_DEBUG_') ? error : debugExportFailure('SESSION_DEBUG_START') });
    throw error;
  } finally {
    if (child?.connected) child.disconnect();
    child?.unref(); unlock();
  }
}

export async function runDebugExportJob(id, ready = () => {}) {
  if (!uuid(id)) throw debugExportFailure('SESSION_DEBUG_START');
  let unlock;
  try { unlock = lockFile(path.join(jobsRoot(), `${id}.lock`), 'This export job is already running.'); }
  catch (error) { if (error.code === 'BZZY_LOCKED') return getRecord(debugExportJobKind, id); throw error; }
  try {
    const job = getRecord(debugExportJobKind, id);
    if (job?.state !== 'queued') return job;
    const identity = processIdentity();
    if (!identity) throw debugExportFailure('SESSION_DEBUG_START');
    putRecord(debugExportJobKind, id, { ...job, state: 'running', identity, startedAt: now(), updatedAt: now() });
    ready();
    let lastWritten = 0, lastProgress = '';
    const onProgress = value => {
      if (!value || !phases.has(value.phase)) return;
      const progress = { phase: value.phase, ...Object.fromEntries(counters.filter(key => Number.isSafeInteger(value[key]) && value[key] >= 0).map(key => [key, value[key]])) };
      const signature = JSON.stringify(progress), clock = Date.now(), current = getRecord(debugExportJobKind, id);
      if (signature === lastProgress || !active(current) || clock - lastWritten < 2000 && current.progress?.phase === progress.phase) return;
      putRecord(debugExportJobKind, id, { ...current, progress, updatedAt: now() }); lastWritten = clock; lastProgress = signature;
    };
    const { exportFullSessionDebugInWorker } = await import('./session-full-debug.js');
    const result = await exportFullSessionDebugInWorker(job.sessionId, { cwd: job.cwd, output: job.output, captureMode: job.captureMode, onProgress });
    return finishDebugExportJob(id, { result });
  } catch (error) {
    return finishDebugExportJob(id, { error });
  } finally { unlock(); }
}
