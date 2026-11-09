import fs from 'node:fs';
import path from 'node:path';
import { home } from './files.js';
import { listRecords, getRecord } from './database.js';
import { sessionDeleted } from './store.js';

// Reclaims the on-disk workspace copies Core makes for isolation — the per-run
// `snapshots/` baselines and the per-worker `workers/`/`besties/`/`parallel/`
// copies — once nothing can still read them. Without this they accumulate for
// the life of the install: a delegate goal writes one full snapshot per
// assignment and one full worker copy per round, and nothing ever removed them,
// so a few hunts saturated a 440 GB disk. Copies are scratch, never evidence —
// a worker's diff is preserved as an artifact and the snapshot manifest lives in
// the database, so deleting the file tree loses nothing auditable.
//
// Safety is by construction. A copy is reclaimed only when every code path that
// could read it is closed: a worker dir only after its assignment reached a
// terminal closure (inconclusive/abandoned, or accepted *and* applied) with no
// running round, because followup/review/apply all require `closure==='open'`
// and re-apply short-circuits once `appliedAt` is set; a snapshot only when no
// open assignment, protected session baseline or active group still references
// it. Anything owned by a live or not-yet-finished session is kept, and nothing
// modified within the recency guard is touched, so an in-flight copy is never
// pulled out from under a running worker.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RECENCY_GUARD_MS = 30 * 60 * 1000;
// A goal in one of these states is finished and will not resume to touch its
// copies. Every other state (including the resumable blocked/native_blocked and
// any in-flight status) keeps the session's copies.
const DONE_GOAL_STATES = new Set(['completed', 'verified', 'failed', 'abandoned', 'cancelled']);
const yieldToIO = () => new Promise(resolve => setImmediate(resolve));

function storeDir(store, id) {
  if (!UUID.test(id)) return null;
  const base = path.join(home(), store), dir = path.join(base, id);
  return path.dirname(dir) === base ? dir : null;
}
function recentlyTouched(dir) {
  try { return Date.now() - fs.statSync(dir).mtimeMs < RECENCY_GUARD_MS; }
  catch { return false; }
}
function removeTree(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); return true; }
  catch { return false; }
}
function assignmentRoundRunning(job) {
  const round = job && getRecord('round', `${job.id}:${job.currentRound}`);
  return ['starting', 'running'].includes(round?.state);
}
function assignmentCopyTerminal(job) {
  // The worker copy is no longer readable once the assignment is closed and
  // either never applied or already applied.
  return ['inconclusive', 'abandoned'].includes(job.closure) || (job.closure === 'accepted' && Boolean(job.appliedAt));
}
function sessionFinished(sessionId) {
  if (!sessionId) return false;
  if (sessionDeleted(sessionId)) return true;
  const session = getRecord('session', sessionId);
  return Boolean(session && DONE_GOAL_STATES.has(session.goal?.state));
}

// Remove one assignment's worker copy. Callers at a known-safe close/apply point
// pass enforceRecencyGuard:false; the background sweep keeps the guard on.
export function reclaimAssignmentWorker(id, { enforceRecencyGuard = true } = {}) {
  const dir = storeDir('workers', id);
  if (!dir) return false;
  const job = getRecord('assignment', id);
  if (job) {
    if (assignmentRoundRunning(job)) return false;
    if (!assignmentCopyTerminal(job) && !sessionFinished(job.parentSessionId)) return false;
  }
  // No record ⇒ orphaned copy from a crashed launch ⇒ reclaimable.
  if (enforceRecencyGuard && recentlyTouched(dir)) return false;
  return removeTree(dir);
}

// Remove a snapshot's file tree (and its sidecar). The database record, which
// holds the manifest used for diffing, is intentionally kept.
function reclaimSnapshotFiles(id) {
  const dir = storeDir('snapshots', id);
  if (!dir) return false;
  if (recentlyTouched(dir)) return false;
  const removed = removeTree(dir);
  try { fs.rmSync(dir + '.json', { force: true }); } catch { /* sidecar best-effort */ }
  return removed;
}

// Snapshot ids that an active holder may still read: open or accepted-pending
// assignments (which can still spawn or re-copy a worker, review or apply), the
// run-start baseline of any session that has not finished, and any group still
// owned by an unfinished session.
function retainedSnapshotIds() {
  const retained = new Set();
  for (const job of listRecords('assignment')) {
    if (!job.snapshotId) continue;
    if (job.closure === 'open' || (job.closure === 'accepted' && !job.appliedAt)) retained.add(job.snapshotId);
    else if (!sessionFinished(job.parentSessionId)) retained.add(job.snapshotId);
  }
  for (const session of listRecords('session')) {
    if (session.startSnapshotId && !sessionFinished(session.id)) retained.add(session.startSnapshotId);
  }
  for (const kind of ['besties', 'parallel']) {
    for (const group of listRecords(kind)) if (group.snapshotId && !sessionFinished(group.sessionId || group.id)) retained.add(group.snapshotId);
  }
  return retained;
}

function listStore(store) {
  try { return fs.readdirSync(path.join(home(), store), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name); }
  catch { return []; }
}

// Idempotent, conservative sweep. Reclaims orphaned and finished copies within a
// wall-clock budget, yielding between deletions so it never blocks the event
// loop. Returns counts for observability. Safe to run at boot and on a timer.
export async function reclaimWorkspaceStorage({ budgetMs = 5000, maxDirs = 200 } = {}) {
  const deadline = Date.now() + budgetMs, summary = { workers: 0, snapshots: 0, groups: 0, scanned: 0 };
  const over = () => Date.now() > deadline || summary.workers + summary.snapshots + summary.groups >= maxDirs;

  for (const id of listStore('workers')) {
    if (over()) return summary;
    summary.scanned++;
    if (reclaimAssignmentWorker(id)) summary.workers++;
    await yieldToIO();
  }
  const retained = retainedSnapshotIds();
  for (const name of listStore('snapshots')) {
    if (over()) return summary;
    const id = name.replace(/\.json$/, '');
    summary.scanned++;
    if (retained.has(id)) continue;
    const record = getRecord('snapshot', id);
    // Reclaim an orphan (no record) or a snapshot whose owning session finished.
    if (!record || sessionFinished(record.sessionId)) { if (reclaimSnapshotFiles(id)) summary.snapshots++; }
    await yieldToIO();
  }
  // Group copy trees (besties/parallel) are keyed by their owning session.
  for (const store of ['besties', 'parallel']) {
    for (const id of listStore(store)) {
      if (over()) return summary;
      summary.scanned++;
      const dir = storeDir(store, id);
      if (dir && sessionFinished(id) && !recentlyTouched(dir) && removeTree(dir)) summary.groups++;
      await yieldToIO();
    }
  }
  return summary;
}

// Session deletion hook: a deleted session's copies can never be read again.
export function reclaimDeletedSessionStorage(sessionIds) {
  const ids = new Set(sessionIds);
  for (const job of listRecords('assignment')) {
    if (ids.has(job.parentSessionId)) { const dir = storeDir('workers', job.id); if (dir) removeTree(dir); }
  }
  for (const snapshot of listRecords('snapshot')) {
    if (ids.has(snapshot.sessionId)) { const dir = storeDir('snapshots', snapshot.id); if (dir) { removeTree(dir); try { fs.rmSync(dir + '.json', { force: true }); } catch { /* best-effort */ } } }
  }
  for (const store of ['besties', 'parallel']) {
    for (const id of ids) { const dir = storeDir(store, id); if (dir) removeTree(dir); }
  }
}

// Pacing for the background sweep: due soon after boot, then backs off while
// there is nothing to reclaim so it does not rescan the stores every tick.
let nextSweepAt = 0;
const SWEEP_IDLE_MS = 6 * 60 * 60 * 1000, SWEEP_ACTIVE_MS = 60 * 1000;
export function storageSweepDue() { return Date.now() >= nextSweepAt; }
export function scheduleStorageSweep(worked) { nextSweepAt = Date.now() + (worked ? SWEEP_ACTIVE_MS : SWEEP_IDLE_MS); }
