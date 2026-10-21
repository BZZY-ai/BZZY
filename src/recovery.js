import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { getRecord, listRecords, putRecord, appendEvent, now } from './database.js';
import { loadSession, saveSession } from './store.js';
import { inspectWorkspace } from './evidence.js';
import { recall } from './memory.js';
import { projectContext } from './project.js';
import { closeOpenActivities } from './activity.js';
import { assignmentContextPage, compactAssignmentRound } from './assignment-views.js';
import { peerCollaborationState } from './peer-collaboration.js';

export function processIdentity(pid = process.pid, platform = process.platform) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    process.kill(pid, 0);
    if (platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (fields[0] === 'Z') return null;
      return { pid, boot: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), start: fields[19], ppid: Number(fields[1]), pgid: Number(fields[2]) };
    }
    if (platform === 'darwin') {
      const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'stat=', '-o', 'ppid=', '-o', 'pgid='],
        { encoding: 'utf8', timeout: 1000, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } });
      const match = result.status === 0 && /^(.*?)\s+(\S+)\s+(\d+)\s+(\d+)\s*$/.exec(result.stdout.trim());
      if (!match || !match[1] || match[2].includes('Z')) return null;
      return { pid, platform: 'darwin', start: match[1], ppid: Number(match[3]), pgid: Number(match[4]) };
    }
    return { pid, start: 'platform-unverified' };
  } catch { return null; }
}
export function identityAlive(identity) {
  if (!identity) return false;
  const current = processIdentity(identity.pid, identity.platform || process.platform);
  if (identity.start === 'platform-unverified') return Boolean(current); // Legacy records: liveness only, never authority to signal a group.
  return Boolean(current && current.start === identity.start && current.boot === identity.boot);
}
export function signalProcess(identity, signal, { group = false } = {}) {
  if (!identity || identity.start === 'platform-unverified' || !identityAlive(identity)) return false;
  if (group && identity.pgid != null && identity.pgid !== identity.pid) return false;
  try { process.kill(group ? -identity.pid : identity.pid, signal); return true; }
  catch (error) { if (error.code !== 'ESRCH') throw error; return false; }
}
export function reconcileSession(id) {
  const session = loadSession(id);
  if (!session) throw new Error('Unknown session.');
  const run = getRecord('run', id);
  if (run && ['starting', 'running', 'waiting_for_input'].includes(run.state) && identityAlive(run.runner)) return { sessionId: id, state: run.state, live: true };
  let orphanCleanup = null;
  if (identityAlive(session.backendProcess)) {
    if (session.backendProcess.start === 'platform-unverified') return { sessionId: id, live: false, state: 'cleanup_required', reason: 'Backend identity cannot be safely verified for group cleanup on this platform.' };
    const identity = session.backendProcess;
    const signal = value => { if (identityAlive(identity)) { try { process.kill(-identity.pid, value); } catch (error) { if (error.code !== 'ESRCH') throw error; } } };
    signal('SIGTERM');
    const deadline = Date.now() + 1500;
    while (identityAlive(identity) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    if (identityAlive(identity)) signal('SIGKILL');
    const forcedDeadline = Date.now() + 1000;
    while (identityAlive(identity) && Date.now() < forcedDeadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    if (identityAlive(identity)) return { sessionId: id, live: false, state: 'cleanup_required', reason: 'The verified old backend is still alive; no replacement was launched.' };
    orphanCleanup = { identity, stopped: true }; session.backendProcess = null;
  }
  const uncertain = listRecords('operation').filter(o => o.sessionId === id && ['planned', 'dispatched'].includes(o.state));
  for (const op of uncertain) putRecord('operation', op.id, { ...op, state: 'uncertain', recoveryAt: now() });
  const questions = listRecords('question').filter(q => q.sessionId === id && q.state === 'pending');
  for (const q of questions) putRecord('question', q.id, { ...q, state: 'expired', reason: 'Runner ended; an answer cannot safely be replayed to a new turn.' });
  const snapshot = session.startSnapshotId && getRecord('snapshot', session.startSnapshotId);
  let changes = [], inspectionError;
  if (snapshot) { try { changes = inspectWorkspace(snapshot, session.cwd); } catch (error) { inspectionError = error.message; } }
  const record = { sessionId: id, live: false, state: 'reconciled', orphanCleanup, uncertainOperations: uncertain.map(o => o.id), expiredQuestions: questions.map(q => q.id), workspaceChanges: changes, inspectionError, createdAt: now(), automaticallyReplayed: false };
  if (run && ['starting', 'running', 'waiting_for_input'].includes(run.state)) {
    putRecord('run', id, { ...run, state: 'interrupted', finishedAt: now() });
    session.executionState = 'interrupted';
    if (['active', 'verifying'].includes(session.goal?.status)) { session.goal.status = 'paused'; session.goal.reason = 'recovery_required'; }
    delete session.deferTerminalNotification;
    saveSession(session);
    closeOpenActivities(session);
  }
  putRecord('recovery', id, record); appendEvent(id, 'recovery', record); return record;
}
export function contextFor(session) {
  if (session.role === 'reviewer') return JSON.stringify({ role: 'reviewer', contract: session.contract, checkpoint: getRecord('checkpoint', session.id), previousReport: getRecord('worker-report', session.id), fixedSnapshot: true });
  if (session.role === 'executor') return JSON.stringify({ role: 'executor', contract: session.contract, checkpoint: getRecord('checkpoint', session.id), recovery: getRecord('recovery', session.id),
    assignmentId: session.assignmentId, previousReport: compactAssignmentRound({ report: getRecord('worker-report', session.id) })?.report,
    selectedEvidence: (session.allowedArtifactIds || []).slice(0, 32).map(id => {
      const item = getRecord('artifact', id);
      return item ? { id, label: item.label?.slice(0, 160), size: item.size, sha256: item.sha256 } : { id, unavailable: true };
    }), contextBoundary: 'This bounded assignment has its own context. Parent conversation and project ledgers are not automatically included. Read selected evidence with read_artifact; ask the supervisor for missing context.' });
  if (session.bestiesSessionId) return JSON.stringify({ role: 'bestie', contract: session.contract, checkpoint: getRecord('checkpoint', session.id), recovery: getRecord('recovery', session.id),
    previousAcceptance: session.acceptance || null, projectRoot: session.projectRoot || session.cwd, agentNamespace: session.agentNamespace,
    relevantMemory: recall(session.projectRoot || session.cwd, session.goal?.objective || session.contract?.objective || '', 8),
    collaboration: peerCollaborationState(session), contextBoundary: 'You and your fellow peers pursue the same full goal. Read peer_inbox for new messages, share decisive evidence through peer_message, and inspect evidence before peer_review. A peer claim or agreement alone is not proof.' });
  // Keep live/recent assignments discoverable over long goals without replaying
  // every report and historical artifact manifest in each model prompt.
  const history = assignmentContextPage(session, { limit: 12, prioritizeOpen: true, includeMoreIds: true });
  return JSON.stringify({ role: session.role || 'supervisor', mode: session.mode || 'solo', executor: session.executor || null, besties: session.besties || null, contract: session.contract, checkpoint: getRecord('checkpoint', session.id), recovery: getRecord('recovery', session.id),
    importedContext: session.importedContext || null,
    relevantMemory: recall(session.projectRoot || session.cwd, session.goal?.objective || session.contract?.objective || '', 8),
    projectContext: projectContext(session.projectRoot || session.cwd), peers: session.peers || [], agentNamespace: session.agentNamespace || null,
    previousAcceptance: session.acceptance || null, pendingInput: session.pendingInput || [],
    assignments: history.items,
    assignmentHistory: { total: history.total, open: history.open, included: history.items.length, omitted: history.total - history.items.length,
      moreIds: history.moreIds,
      lookup: 'Use assignment_status with an assignment ID. Full report and evidence remain durable artifacts, opened with read_artifact.' } });
}
