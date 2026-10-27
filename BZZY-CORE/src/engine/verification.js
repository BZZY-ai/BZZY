import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { artifact, captureEvidence, inside, fileInfo, artifactsFor, inspectWorkspace, workspaceManifest } from './evidence.js';
import { schemaErrors } from './contracts.js';
import { putRecord, getRecord, listRecords, appendEvent, now, digest } from './database.js';
import { spawnBounded, stopProcess } from './policy.js';
import { assignmentsFor } from './delegation-usage.js';
import { pendingAssignmentContext } from './delegation.js';
import { missionSourceRevision, missionResultRevision, missionContextCurrent, missionEvidenceCurrent } from './mission-context.js';
import { assessDebateGoal, assessObjectionDispositions, assessDebateEvidenceCoverage } from './debate-format.js';
import { assessValidationAgreement } from './investigation.js';
import { remapValidationAssessment, normalizeValidationAssessment } from './validation-assessment.js';
import { assertRoutingCompletion, routingStatus } from './workflow-routing.js';

function canonicalValidationReport(report, artifacts) {
  const aliases = new Map((artifacts || []).filter(item => !item.omitted).flatMap(item => [[item.originalId || item.id, item.id], [item.id, item.id]]));
  return report ? { ...report, evidence: report.evidence?.map(id => aliases.get(id) || id),
    ...(report.validationAssessment ? { validationAssessment: remapValidationAssessment(report.validationAssessment, aliases) } : {}) } : null;
}

export function assessAdaptiveValidationProtocol(session, record, { requireTrue = true } = {}) {
  const protocol = record?.protocol, reasons = [], initial = protocol?.initialInvestigation;
  const count = protocol?.selectedCount;
  if (!protocol || protocol.version !== 1 || !['direct-review', 'targeted-followup'].includes(protocol.kind) || ![2, 3].includes(count) ||
      initial?.protocol !== 'tri-state-v1' || initial.reports?.length !== count || protocol.independentAssignments?.length !== count ||
      protocol.finalAssignments?.length !== count || protocol.followups?.length > count) return { passed: false, reasons: ['The adaptive validation protocol is incomplete.'] };
  const agreement = assessValidationAgreement(record.investigation, count, { sessionId: session.id,
    objective: session.reviewSource?.objective || session.goal.objective, criteria: session.contract.acceptanceCriteria });
  const workers = new Set();
  for (const [index, pin] of protocol.independentAssignments.entries()) {
    if (!requireTrue && !agreement.participants[index]?.valid) continue;
    const job = getRecord('assignment', pin.assignmentId), round = getRecord('round', `${pin.assignmentId}:${pin.round}`);
    const mission = getRecord('core.mission.context', pin.missionContextId), worker = job?.workerSessionId && getRecord('session', job.workerSessionId);
    if (!job || !worker || job.parentSessionId !== session.id || job.goalId !== session.goal.id || worker.parentSessionId !== session.id ||
        worker.assignmentId !== job.id || pin.workerSessionId !== worker.id || workers.has(worker.id) || pin.round !== 1 || round?.state !== 'awaiting_review' ||
        digest(round.report) !== pin.reportHash || digest(canonicalValidationReport(initial.reports[index]?.report, initial.reports[index]?.artifacts)) !==
          digest(canonicalValidationReport(round.report, initial.reports[index]?.artifacts)) ||
        initial.reports[index]?.assignmentId !== job.id || mission?.brief?.independent !== true || !missionContextCurrent(session, mission)) reasons.push('An independent check is missing, altered, stale or not independently bound to this goal.');
    workers.add(worker?.id);
  }
  for (const pin of protocol.finalAssignments) {
    if (!requireTrue && !agreement.participants.some(item => item.valid && item.assignmentId === pin.assignmentId)) continue;
    const job = getRecord('assignment', pin.assignmentId), round = job && getRecord('round', `${job.id}:${job.currentRound}`);
    if (!job || job.parentSessionId !== session.id || job.goalId !== session.goal.id || job.currentRound !== pin.round || job.workerSessionId !== pin.workerSessionId ||
        round?.state !== 'awaiting_review' || digest(round.report) !== pin.reportHash || !protocol.independentAssignments.some(item => item.assignmentId === job.id)) reasons.push('The latest independent report changed after the adaptive decision.');
  }
  if (requireTrue && !agreement.agreeTrue) reasons.push('Every selected independent check must support the original goal before final evidence review.');
  if (requireTrue) {
    const pin = protocol.finalReviewer, job = pin && getRecord('assignment', pin.assignmentId), worker = job?.workerSessionId && getRecord('session', job.workerSessionId);
    const round = job && getRecord('round', `${job.id}:${job.currentRound}`);
    if (!pin || !job || !worker || job.parentSessionId !== session.id || job.goalId !== session.goal.id || worker.parentSessionId !== session.id ||
        job.role !== 'reviewer' || job.contract?.policy?.mode !== 'read-only' || job.currentRound !== 1 || pin.round !== 1 ||
        workers.has(worker.id) || pin.workerSessionId !== worker.id || round?.state !== 'awaiting_review' || digest(round.report) !== pin.reportHash ||
        record.assessment?.defenderAssignmentId !== job.id || record.assessment?.defenderSessionId !== worker.id ||
        digest(round.report?.decision) !== digest(record.decision) || record.assessment?.challengeRounds !== 0 || record.transcript?.length) reasons.push('The final evidence reviewer is not a fresh, scoped direct-review assignment.');
    try {
      const finalAssessment = normalizeValidationAssessment(round?.report?.validationAssessment, {
        objective: session.reviewSource?.objective || session.goal.objective, criteria: session.contract.acceptanceCriteria, evidence: round?.report?.evidence });
      if (round?.report?.status !== 'complete' || finalAssessment.achieved !== true) reasons.push('The final evidence reviewer did not support every original criterion.');
    } catch { reasons.push('The final evidence reviewer did not return a valid assessment of every original criterion.'); }
  }
  const evidence = [...new Set(agreement.participants.filter(item => item.valid && (requireTrue || item.achieved === false)).flatMap(item => item.evidence || []))];
  return { passed: reasons.length === 0, reasons, agreement, evidence,
    bindings: protocol.finalAssignments, protocol: protocol.kind, semanticVerification: 'not-automated' };
}

export function recordAdaptiveValidationPolicy(session, record) {
  if (!record?.validationPolicy) return null;
  const checked = assessAdaptiveValidationProtocol(session, record, { requireTrue: false });
  const source = session.reviewSource && getRecord('session', session.reviewSource.sessionId);
  const sourceCurrent = !session.reviewSource || source && (source.goal?.id || null) === session.reviewSource.goalId &&
    missionSourceRevision(source) === session.reviewSource.sourceRevision && missionResultRevision(source) === session.reviewSource.resultRevision;
  const rejected = checked.passed && sourceCurrent && checked.agreement.hasFalse;
  const bindings = rejected ? checked.bindings.filter(pin => checked.agreement.participants.some(item => item.valid && item.achieved === false && item.assignmentId === pin.assignmentId)) : checked.bindings || [];
  const id = digest({ sessionId: session.id, goalId: session.goal.id, bindings, outcome: rejected ? 'rejected' : 'inconclusive' });
  const receipt = { id, sessionId: session.id, goalId: session.goal.id, sourceGoalId: session.reviewSource?.goalId || session.goal.id,
    sourceRevision: session.reviewSource?.sourceRevision || missionSourceRevision(session), resultRevision: session.reviewSource?.resultRevision || null,
    outcome: rejected ? 'rejected' : 'inconclusive', reason: rejected ? 'agent_dissent' : 'missing_evidence',
    protocol: checked.protocol || record.protocol?.kind, bindings, evidence: checked.evidence || [],
    passed: checked.passed && Boolean(sourceCurrent), semanticVerification: 'not-automated', createdAt: now() };
  putRecord('core.validation.policy', id, receipt);
  record.validationPolicy.receiptId = id; record.validationPolicy.receiptFingerprint = digest(receipt);
  record.validationPolicy.outcome = receipt.outcome; record.validationPolicy.reason = receipt.reason;
  return receipt;
}

export function assessRequirement(session, input, role = 'supervisor') {
  if (role === 'executor' || role === 'reviewer') throw new Error('Only the supervisor can accept parent requirements.');
  const criterion = session.contract?.acceptanceCriteria.find(c => c.id === input.id);
  if (!criterion || !['supported', 'partial', 'unsupported', 'inconclusive'].includes(input.status) || !input.rationale?.trim()) throw new Error('Assessment needs a declared requirement ID, status and rationale.');
  if (!Array.isArray(input.evidence) || (input.status === 'supported' && !input.evidence.length)) throw new Error('Supported assessments need recorded evidence IDs.');
  for (const id of input.evidence) {
    const item = getRecord('artifact', id);
    if (!item || item.sessionId !== session.id) throw new Error('Assessment evidence must belong to the current session. Inspect or copy worker evidence first.');
  }
  const assessment = { id: randomUUID(), sessionId: session.id, goalId: session.goal?.id || null, missionRevision: missionSourceRevision(session), criterionId: input.id, status: input.status, rationale: input.rationale, evidence: input.evidence, role, createdAt: now(), provenance: role === 'debate-review' ? 'debate-evidence-review' : role === 'group-assessment' ? 'aggregate-peer-assessment' : role === 'bestie' ? 'peer-judgment' : 'supervisor-judgment' };
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
export async function assessCompletion(session, { signal, prerequisite = true, settledAssignmentIds = [] } = {}) {
  let routing;
  try { routing = { ...assertRoutingCompletion(session), passed: true }; }
  catch (error) { routing = { ...routingStatus(session, { limit: 0 }), passed: false, reason: error.message }; }
  if (!session.contract) return { passed: prerequisite && !signal?.aborted && routing.passed, level: 'legacy-model-judgment', requirements: [], artifacts: [], checks: [], ...(routing.enforced ? { routing } : {}) };
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
      const stale = Boolean(assessment.missionRevision && assessment.missionRevision !== missionSourceRevision(session)) || assessment.evidence.some(id => {
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
    if (c.modelJudgment) return { id: c.id, description: c.description, passed: true, provenance: 'backend-model-judgment', evidence: artifactsFor(session.id).filter(a => a.label === 'agent-output' &&
      (!session.goal || (a.goalId ? a.goalId === session.goal.id : !session.goal.createdAt || a.createdAt >= session.goal.createdAt))).map(a => a.id) };
    return { id: c.id, description: c.description, passed: false, reason: 'Supervisor has not assessed this requirement with recorded evidence.' };
  });
  const assignments = assignmentsFor(session), settled = new Set(settledAssignmentIds);
  const openAssignments = assignments.filter(a => a.closure === 'open' && !(settled.has(a.id) &&
    getRecord('round', `${a.id}:${a.currentRound}`)?.state === 'awaiting_review' && a.latestReport?.report?.status !== 'needs_context'));
  const delegation = session.mode === 'delegate' && session.goal && !['executor', 'reviewer'].includes(session.role) ? {
    required: true, assignmentCount: assignments.filter(a => a.role === 'executor').length,
    reviewedAssignments: assignments.filter(a => a.role === 'executor' && ['accepted', 'inconclusive', 'abandoned'].includes(a.closure)).length,
  } : null;
  if (delegation) {
    delegation.pendingContext = pendingAssignmentContext(session);
    delegation.declinedContext = listRecords('assignment-context', { sessionId: session.id }).filter(request => request.sourceGoalId === session.goal.id && request.state === 'declined').map(request => request.id);
    const explicitSupport = requirements.every(requirement => requirement.passed && requirement.assessment?.status === 'supported' && requirement.assessment.evidence?.length);
    delegation.passed = delegation.reviewedAssignments > 0 && !delegation.pendingContext.length && (!delegation.declinedContext.length || explicitSupport);
    if (delegation.pendingContext.length) delegation.reason = 'An executor needs missing task context. Answer or explicitly resolve its context request before completing this goal.';
    else if (delegation.declinedContext.length && !explicitSupport) delegation.reason = 'Declining missing worker context does not establish the parent goal. Record current evidence-backed assessments for every original requirement.';
    else if (!delegation.passed) delegation.reason = 'Delegate mode requires a bounded executor assignment for this goal and brain review of its result. Use delegate, inspect the evidence, then review_assignment before completing.';
  }
  const passed = prerequisite && routing.passed && !signal?.aborted && requiredArtifacts.every(a => a.passed) && checks.length === session.contract.verification.length && checks.every(c => c.passed) && requirements.every(r => r.passed) && !openAssignments.length && (!delegation || delegation.passed);
  const result = { id: randomUUID(), sessionId: session.id, goalId: session.goal?.id || null, passed, level: session.contract.acceptanceCriteria.some(c => c.modelJudgment) ? 'model-judgment-with-declared-checks' : 'evidence-and-supervisor-assessment',
    requirements, artifacts: requiredArtifacts, checks, openAssignments: openAssignments.map(a => a.id), ...(delegation ? { delegation } : {}), ...(routing.enforced ? { routing } : {}), createdAt: now() };
  putRecord('acceptance', result.id, result); appendEvent(session.id, 'acceptance', result); return result;
}

// Debate completion is an assessment of the original task, subject to the
// same declared artifacts/checks as ordinary work. Votes are never a bypass.
export async function assessDebateCompletion(session, record, { signal } = {}) {
  const assessment = record?.assessment || {}, reasons = [];
  const defender = assessment.defenderSessionId && getRecord('session', assessment.defenderSessionId);
  const defenderJob = assessment.defenderAssignmentId && getRecord('assignment', assessment.defenderAssignmentId);
  const actualChallengeRounds = (record?.transcript || []).filter(round => Array.isArray(round.assessments) && round.assessments.length > 0 && round.assessments.every(item => item.assignmentId && item.report) && round.mainResponse?.decision).length;
  const ids = new Set([record?.opening?.assignmentId, assessment.defenderAssignmentId,
    ...(record?.investigation?.reports || []).map(report => report.assignmentId),
    ...(record?.transcript || []).flatMap(round => (round.assessments || []).map(report => report.assignmentId))].filter(Boolean));
  const jobs = [...ids].map(id => getRecord('assignment', id));
  const adaptive = record?.protocol?.version === 1 ? assessAdaptiveValidationProtocol(session, record) : null;
  if (assessment.passed !== true || record.goalSatisfaction !== 'supported' || (adaptive ? !adaptive.passed : actualChallengeRounds < 1 || assessment.challengeRounds !== actualChallengeRounds)) {
    reasons.push(...(adaptive?.reasons || ['The original goal has no complete supported challenge-and-response assessment.']));
    if (!reasons.length) reasons.push('The final evidence review did not support the original goal.');
  }
  if (!defender || !defenderJob || defender.parentSessionId !== session.id || defenderJob.parentSessionId !== session.id || defenderJob.goalId !== session.goal?.id ||
    defenderJob.workerSessionId !== defender.id || defender.assignmentId !== defenderJob.id || defender.assignmentRound !== defenderJob.currentRound) reasons.push('The final reviewer is not bound to this goal.');
  if (jobs.some(job => !job || job.parentSessionId !== session.id || job.goalId !== session.goal?.id || getRecord('round', `${job.id}:${job.currentRound}`)?.state !== 'awaiting_review')) reasons.push('A debate participant is missing, still running or belongs to another goal.');
  if (record?.missionContext && !missionContextCurrent(session, record.missionContext)) reasons.push('The original instructions or mission evidence changed during review.');
  if (session.reviewSource) {
    const source = getRecord('session', session.reviewSource.sessionId);
    if (!source || (source.goal?.id || null) !== session.reviewSource.goalId || missionSourceRevision(source) !== session.reviewSource.sourceRevision ||
      (source.goal?.status || 'reply') !== session.reviewSource.claimedStatus || session.reviewSource.resultRevision && missionResultRevision(source) !== session.reviewSource.resultRevision ||
      session.reviewSource.missionContextId && !missionContextCurrent(source, session.reviewSource.missionContextId)) reasons.push('The source goal or its achieved claim changed during review.');
  }
  const allowedArtifactIds = [...new Set([...(defender?.allowedArtifactIds || []), ...artifactsFor(defender?.id || session.id).map(item => item.id)])];
  const evidenceContext = { sessionId: session.id, defenderSessionId: defender?.id, allowedArtifactIds };
  const goalReview = assessDebateGoal(session, record?.decision, evidenceContext);
  const objectionReview = assessObjectionDispositions(record?.objectionLedger || [], record?.decision, evidenceContext);
  const coverage = assessDebateEvidenceCoverage(session.reviewSource?.evidenceIds || [], evidenceContext);
  if (!goalReview.passed) reasons.push(...goalReview.reasons);
  if (!objectionReview.complete || objectionReview.unresolved.length) reasons.push('Some objections lack an inspected, evidence-backed disposition.');
  if (!coverage.complete) reasons.push('The final reviewer did not inspect all original goal evidence.');
  if (record?.unresolvedDisagreement?.length || record?.decision?.nextVerificationSteps?.length) reasons.push('The result still has unresolved disagreement or required verification.');
  const entries = goalReview.inspectedEvidence.map(id => getRecord('artifact', id)).filter(Boolean);
  if (entries.length !== goalReview.inspectedEvidence.length || !missionEvidenceCurrent(entries)) reasons.push('Cited decision evidence is missing, changed or stale.');
  // Model assessments remain labeled as such. Host checks establish provenance,
  // inspection and contract compliance, not universal semantic truth.
  if (!reasons.length) {
    const copies = new Map();
    for (const item of entries) {
      let imported = item;
      if (item.sessionId !== session.id) {
        imported = artifact(session, fs.readFileSync(item.path), `debate-reviewed:${item.label}`, item.mediaType);
        Object.assign(imported, { importedFrom: item.id, importedSha256: item.sha256,
          ...(item.source ? { source: item.source, sourceWorkspace: item.sourceWorkspace, sourceSha256: item.sourceSha256 } : {}) });
        putRecord('artifact', imported.id, imported);
      }
      copies.set(item.id, imported.id);
    }
    for (const criterion of goalReview.assessment.criteria) assessRequirement(session, {
      id: criterion.id, status: 'supported', rationale: criterion.rationale,
      evidence: criterion.evidence.map(id => copies.get(id)),
    }, 'debate-review');
  }
  const result = await assessCompletion(session, { signal, prerequisite: reasons.length === 0, settledAssignmentIds: [...ids] });
  Object.assign(result, { debate: { passed: reasons.length === 0, reasons, sourceGoalId: session.reviewSource?.goalId || session.goal?.id,
    goalSatisfaction: goalReview.goalSatisfaction, evidenceCoverage: coverage,
    ...(adaptive ? { protocol: adaptive.protocol, independentBindings: adaptive.bindings, independentEvidence: adaptive.evidence } : {}), semanticVerification: 'not-automated' } });
  putRecord('acceptance', result.id, result);
  return result;
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
