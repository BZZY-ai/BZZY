import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { artifact, captureEvidence, inside, fileInfo, artifactsFor, inspectWorkspace, workspaceManifest } from './evidence.js';
import { schemaErrors } from './contracts.js';
import { putRecord, getRecord, listRecords, appendEvent, now } from './database.js';
import { spawnBounded, stopProcess } from './policy.js';
import { assignmentsFor } from './delegation-usage.js';

export function assessRequirement(session, input, role = 'supervisor') {
  if (role === 'executor' || role === 'reviewer') throw new Error('Only the supervisor can accept parent requirements.');
  const criterion = session.contract?.acceptanceCriteria.find(c => c.id === input.id);
  if (!criterion || !['supported', 'partial', 'unsupported', 'inconclusive'].includes(input.status) || !input.rationale?.trim()) throw new Error('Assessment needs a declared requirement ID, status and rationale.');
  if (!Array.isArray(input.evidence) || (input.status === 'supported' && !input.evidence.length)) throw new Error('Supported assessments need recorded evidence IDs.');
  for (const id of input.evidence) {
    const item = getRecord('artifact', id);
    if (!item || item.sessionId !== session.id) throw new Error('Assessment evidence must belong to the current session. Inspect or copy worker evidence first.');
  }
  const assessment = { id: randomUUID(), sessionId: session.id, goalId: session.goal?.id || null, criterionId: input.id, status: input.status, rationale: input.rationale, evidence: input.evidence, role, createdAt: now(), provenance: role === 'group-assessment' ? 'aggregate-peer-assessment' : role === 'bestie' ? 'peer-judgment' : 'supervisor-judgment' };
  putRecord('assessment', `${session.id}:${session.goal?.id || 'chat'}:${input.id}`, assessment); appendEvent(session.id, 'assessment', assessment); return assessment;
}
export async function runCheck(session, check, { signal } = {}) {
  const op = { id: randomUUID(), sessionId: session.id, checkId: check.id, argv: check.argv, state: 'planned', createdAt: now() };
  putRecord('operation', op.id, op); appendEvent(session.id, 'verification.started', { id: op.id, checkId: check.id });
  const child = spawnBounded(check.argv[0], check.argv.slice(1), { cwd: session.cwd, policy: session.policy || session.contract.policy });
  op.state = 'dispatched'; op.pid = child.pid; putRecord('operation', op.id, op);
  let stdout = '', stderr = '', truncated = false, timedOut = false;
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  const add = (previous, chunk) => {
    const combined = previous + chunk;
    if (Buffer.byteLength(combined) <= 1024 * 1024) return combined;
    truncated = true;
    const bytes = Buffer.from(combined); let start = bytes.length - 1024 * 1024;
    while ((bytes[start] & 0xc0) === 0x80) start++;
    return bytes.subarray(start).toString('utf8');
  };
  child.stdout.on('data', chunk => { stdout = add(stdout, chunk); }); child.stderr.on('data', chunk => { stderr = add(stderr, chunk); });
  let force;
  const stop = () => { stopProcess(child); force = setTimeout(() => stopProcess(child, 'SIGKILL'), 2000); };
  const timer = setTimeout(() => { timedOut = true; stop(); }, (check.timeoutSeconds || 120) * 1000);
  signal?.addEventListener('abort', stop, { once: true });
  let code;
  try { code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }); }
  finally { clearTimeout(timer); clearTimeout(force); signal?.removeEventListener('abort', stop); stopProcess(child, 'SIGKILL'); }
  const evidence = artifact(session, JSON.stringify({ argv: check.argv, cwd: session.cwd, code, timedOut, truncated, stdout, stderr }, null, 2), `verification:${check.id}`, 'application/json');
  Object.assign(op, { state: 'observed', code, timedOut, truncated, passed: !timedOut && !signal?.aborted && code === (check.expectedExitCode ?? 0), evidence: evidence.id, finishedAt: now() });
  putRecord('operation', op.id, op); appendEvent(session.id, 'verification.completed', op); return op;
}
export async function assessCompletion(session, { signal, prerequisite = true } = {}) {
  if (!session.contract) return { passed: true, level: 'legacy-model-judgment', requirements: [], artifacts: [], checks: [] };
  const requiredArtifacts = [];
  for (const required of session.contract.artifacts) {
    try {
      const file = inside(session.cwd, required.path), info = fileInfo(file);
      if (required.schema) {
        const errors = schemaErrors(JSON.parse(fs.readFileSync(file, 'utf8')), required.schema);
        if (errors.length) throw new Error(errors.join('; '));
      }
      const evidence = captureEvidence(session, required.path, `required:${required.path}`);
      requiredArtifacts.push({ path: required.path, passed: true, ...info, evidence: evidence.id });
    } catch (error) { requiredArtifacts.push({ path: required.path, passed: false, reason: error.message }); }
  }
  const checks = [];
  for (const check of session.contract.verification) {
    if (signal?.aborted) break;
    try { checks.push(await runCheck(session, check, { signal })); }
    catch (error) { checks.push({ checkId: check.id, passed: false, reason: error.message }); }
  }
  const requirements = session.contract.acceptanceCriteria.map(c => {
    let assessment = getRecord('assessment', `${session.id}:${session.goal?.id || 'chat'}:${c.id}`);
    if (!assessment) {
      const legacy = getRecord('assessment', `${session.id}:${c.id}`);
      if (legacy && (!session.goal || legacy.goalId === session.goal.id || legacy.goalId == null && legacy.createdAt >= session.goal.createdAt)) assessment = legacy;
    }
    if (assessment) {
      const stale = assessment.evidence.some(id => {
        const item = getRecord('artifact', id);
        if (!item) return true;
        // Recorded observations remain usable after temporary source cleanup.
        // Explicit criteria still require current source evidence.
        try { if (fileInfo(item.path).sha256 !== item.sha256) return true; } catch { return true; }
        if (!item.source) return false;
        try { return fileInfo(inside(item.sourceWorkspace, item.source, { exists: false })).sha256 !== item.sourceSha256; }
        catch (error) { return !(c.modelJudgment && error.code === 'ENOENT'); }
      });
      return { id: c.id, description: c.description, passed: assessment.status === 'supported' && !stale, stale, assessment };
    }
    // A free-text goal has no independently specified acceptance contract. Label its limit honestly.
    if (c.modelJudgment) return { id: c.id, description: c.description, passed: true, provenance: 'backend-model-judgment', evidence: artifactsFor(session.id).filter(a => a.label === 'agent-output').map(a => a.id) };
    return { id: c.id, description: c.description, passed: false, reason: 'Supervisor has not assessed this requirement with recorded evidence.' };
  });
  const assignments = assignmentsFor(session), openAssignments = assignments.filter(a => a.closure === 'open');
  const delegation = session.mode === 'delegate' && session.goal && !['executor', 'reviewer'].includes(session.role) ? {
    required: true, assignmentCount: assignments.filter(a => a.role === 'executor').length,
    reviewedAssignments: assignments.filter(a => a.role === 'executor' && ['accepted', 'inconclusive', 'abandoned'].includes(a.closure)).length,
  } : null;
  if (delegation) {
    delegation.passed = delegation.reviewedAssignments > 0;
    if (!delegation.passed) delegation.reason = 'Delegate mode requires a bounded executor assignment for this goal and brain review of its result. Use delegate, inspect the evidence, then review_assignment before completing.';
  }
  const passed = prerequisite && !signal?.aborted && requiredArtifacts.every(a => a.passed) && checks.length === session.contract.verification.length && checks.every(c => c.passed) && requirements.every(r => r.passed) && !openAssignments.length && (!delegation || delegation.passed);
  const result = { id: randomUUID(), sessionId: session.id, goalId: session.goal?.id || null, passed, level: session.contract.acceptanceCriteria.some(c => c.modelJudgment) ? 'model-judgment-with-declared-checks' : 'evidence-and-supervisor-assessment',
    requirements, artifacts: requiredArtifacts, checks, openAssignments: openAssignments.map(a => a.id), ...(delegation ? { delegation } : {}), createdAt: now() };
  putRecord('acceptance', result.id, result); appendEvent(session.id, 'acceptance', result); return result;
}

// A group must also deliver the contract in the user's original workspace.
// Child success alone establishes neither those paths nor those final checks.
export async function assessGroupCompletion(session, children, { mutualReviewed = true, signal } = {}) {
  const group = getRecord(session.mode, session.id), snapshot = group?.snapshotId && getRecord('snapshot', group.snapshotId);
  const project = snapshot ? workspaceManifest(session.cwd, snapshot.limits) : {};
  const workspaces = children.map(child => {
    const changes = snapshot ? inspectWorkspace(snapshot, child.cwd) : [];
    const unapplied = changes.filter(change => {
      try {
        inside(session.cwd, change.path, { exists: false });
        return (project[change.path]?.sha256 || null) !== (change.after?.sha256 || null);
      } catch { return true; }
    });
    return { sessionId: child.id, agent: child.agentNamespace || child.provider, directory: child.cwd, changes, unapplied: unapplied.map(change => change.path) };
  });
  const integrated = workspaces.every(workspace => !workspace.unapplied.length);
  const aggregate = artifact(session, JSON.stringify({ goalId: session.goal?.id, mutualReviewed,
    children: children.map(child => ({ sessionId: child.id, goalId: child.goal?.id, provider: child.provider, model: child.model,
      status: child.goal?.status, acceptance: child.acceptance || null })) }, null, 2), 'group-acceptance-evidence', 'application/json');
  for (const criterion of session.contract.acceptanceCriteria) {
    if (criterion.modelJudgment) continue;
    const supported = mutualReviewed && children.length > 0 && children.every(child => child.goal?.status === 'complete' && child.acceptance?.passed && child.acceptance.requirements?.some(requirement => {
      if (requirement.id !== criterion.id || requirement.description !== criterion.description || !requirement.passed || requirement.stale) return false;
      return (requirement.assessment?.evidence || []).every(id => {
        const item = getRecord('artifact', id); if (!item) return false;
        try { return fileInfo(item.path).sha256 === item.sha256 && (!item.source || fileInfo(inside(item.sourceWorkspace, item.source)).sha256 === item.sourceSha256); } catch { return false; }
      });
    }));
    assessRequirement(session, { id: criterion.id, status: supported ? 'supported' : 'inconclusive', evidence: [aggregate.id],
      rationale: supported ? 'Every current peer passed this requirement; the aggregate links their recorded judgments and evidence.' : 'The current peers do not all support this requirement with current accepted evidence.' }, 'group-assessment');
  }
  const prerequisite = integrated && mutualReviewed && children.length > 0 && children.every(child => child.goal?.status === 'complete' && child.acceptance?.passed);
  const result = await assessCompletion(session, { signal, prerequisite });
  result.aggregateEvidenceId = aggregate.id; result.childSessions = children.map(child => child.id); result.mutualReviewed = mutualReviewed;
  result.workspaces = workspaces; result.integrated = integrated;
  if (!integrated) result.reason = 'Peer changes remain in private workspaces. Review and integrate the selected result before completing the project goal.';
  putRecord('acceptance', result.id, result); return result;
}
