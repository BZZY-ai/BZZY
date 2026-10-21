import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { getProvider } from './providers.js';
import { createSession, saveSession, loadSession } from './store.js';
import { getRecord, putRecord, listRecords, removeRecord, reserveRequest, appendEvent, now, transaction, database, digest } from './database.js';
import { normalizeContract } from './contracts.js';
import { childPolicy } from './policy.js';
import { snapshotWorkspace, inspectWorkspace, inside, captureEvidence, artifactsFor, artifact, fileInfo } from './evidence.js';
import { home, privateDir, writeJson } from './files.js';
import { root, runtimeEnv } from './process.js';
import { identityAlive, processIdentity, reconcileSession } from './recovery.js';
import { assignmentCounts, activeAssignmentsFor, budgetUsage, currentAssignmentUsage } from './delegation-usage.js';
import { compactAssignmentRound } from './assignment-views.js';

export const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
export function agentChoice(value, model) {
  const [provider, ...parts] = (value || 'codex').split(':');
  getProvider(provider); return { provider, model: model || parts.join(':') || null };
}
export function assignmentStatus(id) {
  // Read the assignment and its report from one SQLite snapshot. Separate reads
  // could observe a finished round alongside an older, empty latestReport.
  const row = database().prepare(`SELECT a.data AS job, r.data AS round FROM records a
    LEFT JOIN records r ON r.kind='round' AND r.id=a.id || ':' || json_extract(a.data,'$.currentRound')
    WHERE a.kind='assignment' AND a.id=?`).get(id);
  if (!row) throw new Error('Unknown assignment.');
  const job = JSON.parse(row.job); let round = row.round ? JSON.parse(row.round) : null;
  if (round && (round.state === 'running' && !identityAlive(round.runner) || round.state === 'starting' && (round.launcher ? !identityAlive(round.launcher) : Date.now() - Date.parse(round.createdAt) > 30000))) {
    transaction(db => {
      const latest = getRecord('round', `${id}:${job.currentRound}`);
      if (latest?.state !== round.state || latest.token !== round.token) return;
      putRecord('round', `${id}:${job.currentRound}`, { ...latest, state: 'interrupted', finishedAt: now(), reason: 'Runner disappeared; inspect partial evidence before a follow-up.' }, db);
    });
    return assignmentStatus(id);
  }
  return { ...job, round };
}
function checkLimits(parent) {
  const { total, active } = assignmentCounts(parent);
  if (active >= (parent.contract?.limits.concurrency || 1)) throw new Error('Assignment concurrency limit reached. Wait for or cancel the active assignment.');
  if (parent.contract?.limits.maxAssignments != null && total >= parent.contract.limits.maxAssignments) throw new Error('Assignment count limit reached.');
}
export function startAssignment(parent, input, { executor, snapshot, role = 'executor', allowDebate = false, sharedEvidence = [] } = {}) {
  if (parent.mode !== 'delegate' && !allowDebate) throw new Error('Delegation was not enabled for this task.');
  const selection = executor || parent.executor;
  if (!selection) throw new Error('Choose an executor provider/model.');
  const provider = getProvider(selection.provider);
  const policy = childPolicy(parent.policy || parent.contract.policy, input.policy);
  const contract = normalizeContract({ ...input, policy, scope: parent.contract?.scope || {}, constraints: [...new Set([...(parent.contract?.constraints || []), ...(input.constraints || [])])],
    limits: { runtimeSeconds: Math.min(input.limits?.runtimeSeconds || 1200, parent.contract?.limits.assignmentSeconds || 1200),
      maxRetries: 0, ...(input.limits?.tokenBudget ? { tokenBudget: input.limits.tokenBudget } : {}) } }, input.objective);
  if (!input.context?.trim() || !input.acceptanceCriteria?.length) throw new Error('An assignment needs context and acceptanceCriteria in addition to its objective.');
  for (const job of activeAssignmentsFor(parent)) assignmentStatus(job.id);
  const id = randomUUID(), requestId = input.requestId || randomUUID();
  const result = reserveRequest(`assignment:${parent.id}:${parent.goal?.id || 'chat'}`, requestId, { input, selection, role, snapshot: snapshot?.id }, db => {
    checkLimits(parent);
    const remaining = parent.goal?.tokenBudget == null ? null : parent.goal.tokenBudget - budgetUsage(parent);
    if (remaining != null && remaining <= 0) throw new Error('Parent usage budget is exhausted.');
    if (remaining != null) contract.limits.tokenBudget = Math.min(contract.limits.tokenBudget || remaining, remaining);
    const job = { id, parentSessionId: parent.id, goalId: parent.goal?.id || null, selection, contract, role, closure: 'open', currentRound: 1, createdAt: now(), snapshotId: snapshot?.id || null, workspace: null, sharedEvidence, captureNetwork: Boolean(parent.captureNetwork) };
    putRecord('assignment', id, job, db);
    putRecord('round', `${id}:1`, { assignmentId: id, number: 1, state: 'starting', requestId, createdAt: now(), feedback: null }, db);
    appendEvent(parent.id, 'assignment.created', job, db); return { id, round: 1 };
  });
  launchAssignment(result.id, result.round); return assignmentStatus(result.id);
}
function launchAssignment(id, number) {
  const child = spawn(process.execPath, [path.join(root, 'bin/bzzy.js'), 'internal-assignment', id, String(number)], { env: runtimeEnv(), detached: true, stdio: 'ignore' });
  transaction(db => {
    const pending = getRecord('round', `${id}:${number}`);
    if (pending?.state === 'starting') putRecord('round', `${id}:${number}`, { ...pending, launcher: processIdentity(child.pid), dispatchedAt: now() }, db);
  });
  child.unref(); child.on('error', error => {
    const round = getRecord('round', `${id}:${number}`);
    if (round?.state === 'starting') putRecord('round', `${id}:${number}`, { ...round, state: 'failed', reason: error.message });
  });
}
export function followupAssignment(parent, id, input, { sharedEvidence } = {}) {
  const job = assignmentStatus(id);
  if (job.parentSessionId !== parent.id || job.goalId != null && job.goalId !== parent.goal?.id) throw new Error('Assignment belongs to another objective.');
  if (!input.feedback?.trim() || !input.objective?.trim()) throw new Error('Follow-up needs supervisor feedback and a focused objective.');
  const maxRounds = (parent.contract?.limits.maxRetries ?? 2) + 1;
  const result = reserveRequest(`followup:${id}`, input.requestId || randomUUID(), input, db => {
    const latest = getRecord('assignment', id);
    if (latest.currentRound !== job.currentRound || latest.closure !== 'open' || ['starting', 'running'].includes(getRecord('round', `${id}:${latest.currentRound}`)?.state)) throw new Error('Assignment is not ready for a follow-up.');
    if (job.currentRound >= maxRounds) throw new Error('Assignment follow-up limit reached; take over directly or record the unresolved result.');
    if (parent.goal?.tokenBudget != null && budgetUsage(parent) >= parent.goal.tokenBudget) throw new Error('Parent usage budget is exhausted.');
    if (job.contract.limits.tokenBudget != null && (currentAssignmentUsage(job).tokens || 0) >= job.contract.limits.tokenBudget) throw new Error('Assignment usage budget is exhausted.');
    const previousControl = getRecord('assignment-control', id);
    if (previousControl?.action === 'cancel' && (previousControl.round == null || previousControl.round <= latest.currentRound)) db.prepare("DELETE FROM records WHERE kind='assignment-control' AND id=?").run(id);
    const number = latest.currentRound + 1;
    putRecord('round', `${id}:${number}`, { assignmentId: id, number, state: 'starting', createdAt: now(), feedback: input.feedback, objective: input.objective }, db);
    putRecord('assignment', id, { ...latest, currentRound: number, sharedEvidence: sharedEvidence || latest.sharedEvidence || [] }, db);
    appendEvent(parent.id, 'assignment.followup', { id, round: number, objective: input.objective, provider: job.selection.provider, model: job.selection.model }, db);
    return { id, round: number };
  });
  launchAssignment(id, result.round); return result;
}
export async function waitAssignment(parentId, id, timeoutSeconds = 30, number) {
  const deadline = Date.now() + Math.min(30, Math.max(0, timeoutSeconds)) * 1000;
  while (true) {
    const job = assignmentStatus(id);
    if (job.parentSessionId !== parentId) throw new Error('Assignment belongs to another task.');
    const round = number ? getRecord('round', `${id}:${number}`) : job.round;
    if (!round) throw new Error('Unknown assignment round.');
    if (!['starting', 'running'].includes(round.state) || Date.now() >= deadline) return { id, round, closure: job.closure, terminal: !['starting', 'running'].includes(round.state) };
    await delay(100);
  }
}
export function reviewAssignment(parent, id, input) {
  const job = assignmentStatus(id);
  if (job.parentSessionId !== parent.id || ['starting', 'running'].includes(job.round.state) || job.closure !== 'open') throw new Error('Assignment cannot be closed while active or already closed.');
  if (!['accepted', 'inconclusive', 'abandoned'].includes(input.outcome) || !input.rationale?.trim()) throw new Error('Review needs outcome accepted, inconclusive or abandoned, and a rationale.');
  const inspected = listRecords('artifact-read').filter(r => r.sessionId === parent.id && r.assignmentId === id).map(r => r.artifactId);
  if (input.outcome === 'accepted' && (!input.evidence?.length || input.evidence.some(ref => !inspected.includes(ref)))) throw new Error('Accepting an assignment requires evidence IDs the supervisor actually opened with read_artifact.');
  let patch;
  if (input.outcome === 'accepted') {
    if (job.goalId != null && job.goalId !== parent.goal?.id) throw new Error('Assignment belongs to another objective.');
    if (job.latestReport?.round !== job.currentRound || !Array.isArray(job.latestReport.changes)) throw new Error('Accepting an assignment requires the current round’s recorded report and patch.');
    const snapshot = getRecord('snapshot', job.snapshotId);
    const changes = inspectWorkspace(snapshot, job.workspace);
    if (digest(changes) !== digest(job.latestReport.changes)) throw new Error('Worker workspace changed after its report. Request a focused follow-up before accepting it.');
    const modes = Object.fromEntries(changes.filter(change => change.after).map(change => [change.path, fs.statSync(inside(job.workspace, change.path)).mode & 0o777]));
    patch = { snapshotId: snapshot.id, changes, sha256: digest(changes), modes };
  }
  const review = { id: randomUUID(), assignmentId: id, round: job.currentRound, ...input, reviewedAt: now(), inspectedEvidence: inspected, patch };
  transaction(db => {
    const latest = getRecord('assignment', id), latestRound = getRecord('round', `${id}:${latest.currentRound}`);
    if (latest.currentRound !== job.currentRound || latest.closure !== 'open' || ['starting', 'running'].includes(latestRound?.state)) throw new Error('Assignment changed during review. Inspect its current round again.');
    putRecord('review', review.id, review, db); putRecord('assignment', id, { ...latest, closure: input.outcome, review }, db); appendEvent(parent.id, 'assignment.reviewed', review, db);
  });
  return review;
}
export function cancelAssignment(parentId, id, reason = 'Cancelled by supervisor') {
  const job = assignmentStatus(id);
  if (job.parentSessionId !== parentId) throw new Error('Assignment belongs to another task.');
  if (!['starting', 'running'].includes(job.round.state)) return job.round;
  putRecord('assignment-control', id, { action: 'cancel', round: job.currentRound, reason, createdAt: now() }); return { id, round: job.currentRound, cancellationRequested: true };
}
export function applyAssignment(parent, id) {
  const job = assignmentStatus(id);
  if (job.parentSessionId !== parent.id || job.closure !== 'accepted' || parent.policy.mode === 'read-only' || job.goalId != null && job.goalId !== parent.goal?.id) throw new Error('Only an accepted assignment for this objective can be applied to a writable parent task.');
  const patch = job.review?.patch;
  if (!patch || patch.sha256 !== digest(patch.changes)) throw new Error('This assignment has no immutable reviewed patch. Request a new reviewed assignment before applying it.');
  const base = getRecord('snapshot', patch.snapshotId), changes = inspectWorkspace(base, job.workspace);
  if (digest(changes) !== patch.sha256) throw new Error('Worker workspace changed after supervisor review. Unreviewed changes were not applied.');
  if (changes.some(change => change.after && (fs.statSync(inside(job.workspace, change.path)).mode & 0o777) !== patch.modes?.[change.path])) throw new Error('Worker file permissions changed after supervisor review.');
  const application = getRecord('assignment-apply', id) || { id, patchSha256: patch.sha256, paths: {} };
  if (application.patchSha256 !== patch.sha256) throw new Error('The reviewed patch differs from an earlier application.');
  const conflicts = [];
  for (const change of changes) {
    const target = inside(parent.cwd, change.path, { exists: false });
    const current = fs.existsSync(target) ? fileInfo(target).sha256 : null;
    if (current !== (change.before?.sha256 || null) && !((job.appliedAt || application.paths[change.path]) && current === (change.after?.sha256 || null))) conflicts.push(change.path);
    if (!parent.policy.writablePaths.some(p => p === '.' || change.path === p || change.path.startsWith(p + '/'))) throw new Error('Worker change exceeds parent writable paths.');
  }
  if (conflicts.length) throw new Error(`Workspace changed since assignment; resolve conflicts first: ${conflicts.join(', ')}`);
  if (job.appliedAt) return { id, applied: changes.map(c => c.path), alreadyApplied: true };
  // All conflicts are checked before the first write. Journal each applied path for crash reconciliation.
  for (const change of changes) {
    const target = inside(parent.cwd, change.path, { exists: false });
    const current = fs.existsSync(target) ? fileInfo(target).sha256 : null;
    if (application.paths[change.path] && current === (change.after?.sha256 || null)) continue;
    if (current !== (change.before?.sha256 || null)) throw new Error(`Workspace changed during patch application: ${change.path}`);
    appendEvent(parent.id, 'assignment.applying', { id, path: change.path, before: change.before, after: change.after });
    application.paths[change.path] = { state: 'planned' }; putRecord('assignment-apply', id, application);
    if (change.after) {
      privateDir(path.dirname(target)); const content = fs.readFileSync(inside(job.workspace, change.path));
      if (digest(content) !== change.after.sha256) throw new Error('Worker content changed during patch application.');
      const temporary = `${target}.bzzy-${randomUUID()}.tmp`;
      try { fs.writeFileSync(temporary, content, { mode: patch.modes[change.path], flag: 'wx' }); fs.renameSync(temporary, target); }
      finally { fs.rmSync(temporary, { force: true }); }
    }
    else fs.unlinkSync(target);
    application.paths[change.path] = { state: 'applied' }; putRecord('assignment-apply', id, application);
    appendEvent(parent.id, 'assignment.applied', { id, path: change.path });
  }
  putRecord('assignment', id, { ...getRecord('assignment', id), appliedAt: now() });
  return { id, applied: changes.map(c => c.path) };
}
export async function runAssignment(id, number) {
  let job, round, childSession;
  const token = randomUUID();
  const acquired = transaction(db => {
    job = getRecord('assignment', id); round = getRecord('round', `${id}:${number}`);
    if (!job || !round || round.state !== 'starting' || job.currentRound !== number) return false;
    putRecord('round', `${id}:${number}`, { ...round, state: 'running', runner: processIdentity(), token, startedAt: now() }, db);
    appendEvent(job.parentSessionId, 'assignment.started', { id, round: number, provider: job.selection.provider, model: job.selection.model }, db); return true;
  });
  if (!acquired) return 0;
  try {
    const cancellation = getRecord('assignment-control', id);
    if (cancellation?.action === 'cancel' && (cancellation.round == null || cancellation.round === number)) { putRecord('round', `${id}:${number}`, { ...getRecord('round', `${id}:${number}`), state: 'cancelled', finishedAt: now() }); return 0; }
    const parent = loadSession(job.parentSessionId);
    if (job.goalId != null && job.goalId !== parent.goal?.id) throw new Error('The parent objective changed; this assignment was not executed.');
    if (job.workerSessionId) {
      const recovered = reconcileSession(job.workerSessionId);
      if (recovered.live || recovered.state === 'cleanup_required') throw new Error('The earlier worker is still alive. Resolve its verified process before starting a follow-up.');
    }
    let snapshot = job.snapshotId && getRecord('snapshot', job.snapshotId);
    if (!job.workspace) {
      snapshot ||= snapshotWorkspace(parent, `assignment:${id}`);
      job.snapshotId = snapshot.id;
      // A worker edits its own copy; review snapshots remain fixed.
      const work = path.join(home(), 'workers', id); privateDir(path.dirname(work));
      fs.cpSync(snapshot.directory, work, { recursive: true, dereference: false });
      job.workspace = work; putRecord('assignment', id, job);
    }
    const provider = getProvider(job.selection.provider);
    childSession = job.workerSessionId ? loadSession(job.workerSessionId) : createSession(provider, job.workspace, job.selection.model);
    Object.assign(childSession, { role: job.role, parentSessionId: job.parentSessionId, assignmentId: id, assignmentRound: number, suppressNotifications: true,
      contract: job.contract, policy: job.contract.policy, backendHomes: parent.backendHomes, projectRoot: parent.projectRoot || parent.cwd, mode: 'solo', allowedArtifactIds: job.sharedEvidence || [],
      ...(job.selection.effort != null ? { selectedEffort: job.selection.effort } : {}),
      ...(job.selection.capabilities != null ? { modelCapabilities: job.selection.capabilities } : {}) });
    saveSession(childSession); job.workerSessionId = childSession.id; putRecord('assignment', id, job);
    removeRecord('worker-report', childSession.id);
    const prompt = `You are the ${job.role} for a bounded assignment. The supervisor owns the parent objective, strategy and final judgment.
Use tools to perform substantial work within this contract. Preserve evidence with record_evidence and return finish_assignment.
Do not launch other agents, widen scope or claim the parent goal is complete. Clearly separate observations, inferences and uncertainty.
The workspace is an isolated copy; the supervisor reviews and applies changes. A failure or blocker returns control to the supervisor.
CONTRACT:\n${JSON.stringify(job.contract)}\nFOLLOW-UP:\n${JSON.stringify({ objective: round.objective, feedback: round.feedback, previousReport: job.latestReport ? compactAssignmentRound(job.latestReport) : null })}`;
    const { RunnerUI } = await import('./runtime-ui.js');
    const { runSession } = await import('./controller.js');
    const code = await runSession(provider, childSession, { cwd: childSession.cwd, pet: false, strictPolicy: true, policy: job.contract.policy,
      runtimeSeconds: job.contract.limits.runtimeSeconds, tokenBudget: job.contract.limits.tokenBudget, scopedAutonomy: true, captureNetwork: job.captureNetwork }, new RunnerUI(childSession.id, { unattended: true, parentSessionId: parent.id }), prompt);
    const report = getRecord('worker-report', childSession.id);
    const outputs = artifactsFor(childSession.id);
    const changes = inspectWorkspace(snapshot, job.workspace);
    const patch = artifact(childSession, JSON.stringify(changes, null, 2), 'workspace-changes', 'application/json');
    const result = { assignmentId: id, round: number, state: code === 0 ? 'awaiting_review' : childSession.stopReason === 'runtime_limit' ? 'timed_out' : childSession.stopReason === 'token_limit' ? 'budget_limited' : childSession.executionState === 'cancelled' ? 'cancelled' : 'failed', stopReason: childSession.stopReason || childSession.failure?.category || null,
      workerClaim: report?.status || 'unknown', summary: (report?.summary || 'Worker returned without a structured assignment report.').slice(0, 8000),
      report: report || null, artifacts: [...outputs, patch].map(a => ({ id: a.id, label: a.label, size: a.size, sha256: a.sha256 })),
      missingReport: !report, changes, usage: childSession.usage ? { ...childSession.usage, elapsedSeconds: childSession.elapsedSeconds } : null, exitCode: code, finishedAt: now() };
    const fullReport = artifact(childSession, JSON.stringify(result, null, 2), 'assignment-report', 'application/json');
    result.reportArtifactId = fullReport.id;
    result.artifacts.push({ id: fullReport.id, label: fullReport.label, size: fullReport.size, sha256: fullReport.sha256 });
    transaction(db => {
      putRecord('round', `${id}:${number}`, { ...getRecord('round', `${id}:${number}`), ...result }, db);
      putRecord('assignment', id, { ...getRecord('assignment', id), latestReport: result }, db);
      appendEvent(parent.id, 'assignment.finished', { id, round: number, state: result.state, report: { ...result, changes: undefined, report: undefined } }, db);
    });
  } catch (error) {
    putRecord('round', `${id}:${number}`, { ...getRecord('round', `${id}:${number}`), state: 'failed', error: error.message, finishedAt: now() });
    if (job) appendEvent(job.parentSessionId, 'assignment.failed', { id, round: number, error: error.message });
  }
  return 0;
}
