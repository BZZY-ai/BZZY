import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { getProvider } from './providers.js';
import { createSession, saveSession, loadSession } from './store.js';
import { getRecord, putRecord, listRecords, removeRecord, reserveRequest, appendEvent, now, transaction, database, digest } from './database.js';
import { normalizeContract } from './contracts.js';
import { childPolicy } from './policy.js';
import { snapshotWorkspace, copyWorkspaceSnapshot, inspectWorkspace, inside, captureEvidence, artifactsFor, artifact, fileInfo } from './evidence.js';
import { home, privateDir, writeJson, readJson } from './files.js';
import { root, runtimeEnv } from './process.js';
import { identityAlive, processIdentity, reconcileSession } from './recovery.js';
import { assignmentCounts, activeAssignmentsFor, budgetUsage, currentAssignmentUsage } from './delegation-usage.js';
import { compactAssignmentRound } from './assignment-views.js';
import { createMissionContext, missionSourceRevision, missionContextCurrent } from './mission-context.js';
import { assertShareText, sharedSecrets } from './share-bundle-policy.js';
import { assertSubagentDefinitionPin, assertSubagentDefinitionEnabled } from './subagent-definitions.js';
import { normalizeValidationAssessment, naturalValidationSummary } from './validation-assessment.js';
import { finalValidationReportProtocol, normalizeValidationDecision } from './validation-decision.js';
import { reserveRoutingAssignment, recordRoutingReview, assertRoutingFollowup } from './workflow-routing.js';
import { assignmentBudgetView, supervisorHeadroom } from './worker-budget.js';

const contextKind = 'assignment-context';
const chargedUsage = job => { const usage = currentAssignmentUsage(job); return usage.chargedTokens ?? usage.tokens ?? 0; };
const contextText = (value, limit, label) => {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > limit || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw new Error(`Invalid ${label}.`);
  if (/(?:["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|cookie|authorization)["']?)\s*[=:]\s*["']?(?!<|\$\{|\[redacted\])[^\s"']+/i.test(value)) throw new Error('Context answers must use authorized host setup, never credential values.');
  assertShareText(value, sharedSecrets()); return value.trim();
};
const parentStopped = (parent, job) => !parent || ['paused', 'cancelled'].includes(parent.executionState)
  || (job?.chatRunId ? getRecord('run', parent.id)?.id !== job.chatRunId || getRecord('run', parent.id)?.state !== 'running'
    || !['running', 'waiting_for_input'].includes(parent.executionState) : ['paused', 'cancelled'].includes(parent.goal?.status))
  || readJson(path.join(home(), 'runtime', 'operator-stop.json'), null)?.stopped === true;
const sourceRevisionFor = (parent, job) => missionSourceRevision(parent, { chat: Boolean(job?.chatRunId) });
function currentSource(parent, job) {
  const saved = parent?.id && loadSession(parent.id);
  if (!saved || (saved.goal?.id || null) !== (parent.goal?.id || null) || missionSourceRevision(saved) !== missionSourceRevision(parent)) throw new Error('The source goal objective or instructions changed. Refresh this conversation.');
  if (job && (job.parentSessionId !== saved.id || (job.chatRunId ? job.sourceGoalId : job.goalId) !== (saved.goal?.id || null) || job.missionContext && !missionContextCurrent(saved, job.missionContext))) throw new Error('The assignment source goal or instructions changed. Create a new bounded assignment with the current mission.');
  return saved;
}
export function assignmentContextRequest(job) {
  return job?.contextRequestId ? getRecord(contextKind, job.contextRequestId) : null;
}
const compactContext = request => request && ({ id: request.id, revision: request.revision, state: request.state,
  assignmentId: request.assignmentId, round: request.round, sourceGoalId: request.sourceGoalId, sourceGoalRevision: request.sourceGoalRevision,
  questions: request.questions, answers: request.answers || [], rationale: request.rationale || null });
export function pendingAssignmentContext(parent) {
  return listRecords(contextKind, { sessionId: parent.id }).filter(request => request.state === 'pending' && request.sourceGoalId === (parent.goal?.id || null))
    .slice(0, 32).map(compactContext);
}

// This is a saved request for information, never permission to run a tool or
// resume a worker. Only the assigned current worker can create it.
export function recordWorkerReport(session, input) {
  if (!['complete', 'partial', 'blocked', 'inconclusive', 'needs_context'].includes(input.status) || !input.summary?.trim() || !Array.isArray(input.evidence) || input.evidence.length > 32) throw new Error('Assignment report needs status, summary and bounded evidence IDs.');
  if (input.evidence.some(id => getRecord('artifact', id)?.sessionId !== session.id)) throw new Error('Report evidence must belong to this worker session.');
  if (!session.assignmentId) {
    if (input.status === 'needs_context') throw new Error('Context requests need a current bounded assignment.');
    input = validationReport(input, session.missionContext?.brief || { goal: { objective: session.contract?.objective }, acceptanceCriteria: session.contract?.acceptanceCriteria });
    const report = { ...input, sessionId: session.id, reportedAt: now(), provenance: 'worker-claim' };
    putRecord('worker-report', session.id, report); return { recorded: true, requiresSupervisorReview: true };
  }
  const job = getRecord('assignment', session.assignmentId), saved = loadSession(session.id);
  if (!job || job.workerSessionId !== session.id || saved?.assignmentId !== job.id || saved.assignmentRound !== session.assignmentRound || job.currentRound !== session.assignmentRound || job.closure !== 'open' || !['starting', 'running'].includes(getRecord('round', `${job.id}:${job.currentRound}`)?.state)) throw new Error('This worker no longer owns the active assignment round.');
  const parent = currentSource(loadSession(job.parentSessionId), job);
  input = validationReport(input, job.missionContext?.brief, job.reportProtocol);
  if (parentStopped(parent, job)) throw new Error('The parent conversation is paused. No new worker result was published.');
  const previous = assignmentContextRequest(job);
  if (previous?.state === 'pending' && input.status !== 'needs_context') throw new Error('Outstanding context questions must be answered by the supervisor before another completion claim.');
  if (input.status !== 'needs_context') {
    const report = { ...input, sessionId: session.id, round: job.currentRound, reportedAt: now(), provenance: 'worker-claim' };
    return transaction(db => {
      const live = getRecord('assignment', job.id), source = currentSource(loadSession(parent.id), live);
      if (parentStopped(source, live) || live.currentRound !== session.assignmentRound || live.workerSessionId !== session.id ||
          !['starting', 'running'].includes(getRecord('round', `${live.id}:${live.currentRound}`)?.state) || assignmentContextRequest(live)?.state === 'pending') throw new Error('The worker round or context changed before its report was saved.');
      putRecord('worker-report', session.id, report, db); return { recorded: true, requiresSupervisorReview: true };
    });
  }
  if (typeof input.requestId !== 'string' || !input.requestId.trim() || input.requestId.length > 160 || !Array.isArray(input.questions) || !input.questions.length || input.questions.length > 6) throw new Error('A context request requires a stable requestId and one to six questions.');
  const questions = input.questions.map((question, index) => {
    if (!question || Object.keys(question).some(key => !['id', 'question', 'reason'].includes(key))) throw new Error('Invalid context question fields.');
    const id = question.id || `q${index + 1}`;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new Error('Invalid context question ID.');
    return { id, question: contextText(question.question, 1000, 'context question'), ...(question.reason ? { reason: contextText(question.reason, 500, 'context reason') } : {}) };
  });
  if (new Set(questions.map(question => question.id)).size !== questions.length) throw new Error('Context question IDs must be unique.');
  return reserveRequest(`assignment-context:${job.id}:${job.currentRound}`, input.requestId,
    { questions, summary: input.summary, evidence: input.evidence, sourceGoalRevision: sourceRevisionFor(parent, job) }, db => {
      const latest = getRecord('assignment', job.id), pending = assignmentContextRequest(latest);
      const source = currentSource(loadSession(parent.id), latest);
      if (pending?.state === 'pending') throw new Error('This assignment already has an outstanding context request.');
      if (parentStopped(source, latest) || latest.currentRound !== job.currentRound || latest.workerSessionId !== session.id || !['starting', 'running'].includes(getRecord('round', `${job.id}:${job.currentRound}`)?.state)) throw new Error('Assignment changed before the context request was saved.');
      const id = digest([job.id, job.currentRound, input.requestId]);
      const request = { id, sessionId: parent.id, parentSessionId: parent.id, assignmentId: job.id, workerSessionId: session.id,
        round: job.currentRound, requestId: input.requestId, revision: 1, state: 'pending', sourceGoalId: job.goalId,
        sourceGoalRevision: sourceRevisionFor(parent, job), questions, answers: [], createdAt: now() };
      const report = { ...input, questions, contextRequestId: id, sessionId: session.id, round: job.currentRound, reportedAt: now(), provenance: 'worker-claim' };
      putRecord(contextKind, id, request, db); putRecord('assignment', job.id, { ...latest, contextRequestId: id, contextRequest: compactContext(request) }, db);
      putRecord('worker-report', session.id, report, db); appendEvent(parent.id, 'assignment.needs_context', compactContext(request), db);
      return { recorded: true, requiresSupervisorReview: true, contextRequest: compactContext(request) };
    });
}

function validationReport(input, brief, reportProtocol) {
  const finalReview = reportProtocol === finalValidationReportProtocol;
  const required = finalReview && !['blocked', 'needs_context'].includes(input.status);
  if (required && (input.validationAssessment === undefined || input.decision === undefined) || finalReview && input.decision !== undefined && input.validationAssessment === undefined) {
    throw Object.assign(new Error('Final review: finish_assignment requires both validationAssessment and decision for complete, partial or inconclusive reports. Use blocked or needs_context for an unavailable check. Correct the report and submit again; no final report was saved.'), { code: 'INVALID_VALIDATION_DECISION' });
  }
  if (input.validationAssessment === undefined) return input;
  if (!naturalValidationSummary(input.summary)) throw Object.assign(new Error('Validation needs a concise natural-language explanation, not raw booleans or JSON.'), { code: 'INVALID_VALIDATION_ASSESSMENT' });
  const context = { objective: brief?.reviewSource?.objective || brief?.goal?.objective, criteria: brief?.acceptanceCriteria, evidence: input.evidence };
  const validationAssessment = normalizeValidationAssessment(input.validationAssessment, context);
  return { ...input, validationAssessment, ...(finalReview && input.decision !== undefined ? {
    decision: normalizeValidationDecision(input.decision, { ...context, validationAssessment }),
  } : {}) };
}

export function answerAssignmentContext(parent, id, input, { chatRunId } = {}) {
  const job = getRecord('assignment', id); parent = currentSource(parent, input.contextDisposition === 'declined' ? undefined : job);
  if (!job || job.parentSessionId !== parent.id || (job.chatRunId ? job.sourceGoalId : job.goalId) !== (parent.goal?.id || null)) throw new Error('Context request belongs to another objective.');
  const runScope = chatRunId && job.chatRunId ? { ...job, chatRunId } : job;
  if (parentStopped(parent, runScope)) throw new Error('Resume the parent conversation before answering its worker.');
  return reserveRequest(`assignment-context-answer:${id}`, input.requestId || digest(input), input,
    db => answerContextInTransaction(parent, runScope, input, db));
}
function answerContextInTransaction(parent, job, input, db) {
  const latest = getRecord('assignment', job.id), request = assignmentContextRequest(latest);
  const declined = input.contextDisposition === 'declined';
  parent = currentSource(parent, declined ? undefined : latest);
  if (parentStopped(parent, job)) throw new Error('The parent conversation is paused. Its worker context was not changed.');
  const sourceChanged = request?.sourceGoalRevision !== sourceRevisionFor(parent, job);
  if (!request || request.id !== input.contextRequestId || request.revision !== input.expectedContextRevision || request.state !== 'pending' ||
      sourceChanged && (!declined || input.expectedSourceGoalRevision !== request.sourceGoalRevision)) throw new Error('Context request or source goal changed. Reload the exact request before answering; declining stale context also requires its source revision.');
  if (input.contextDisposition !== undefined && !declined) throw new Error('Choose only an explicit declined context disposition.');
  const answers = declined ? [] : input.contextAnswers;
  if (!declined && (!Array.isArray(answers) || answers.length !== request.questions.length || new Set(answers.map(answer => answer.questionId)).size !== answers.length)) throw new Error('Answer every outstanding context question exactly once.');
  const normalized = (answers || []).map(answer => {
    if (!answer || Object.keys(answer).some(key => !['questionId', 'text', 'evidence'].includes(key)) || !request.questions.some(question => question.id === answer.questionId)) throw new Error('Answer references an unknown context question.');
    const evidence = answer.evidence || [];
    if (!Array.isArray(evidence) || evidence.length > 16 || evidence.some(id => typeof id !== 'string')) throw new Error('Context answer evidence must contain at most 16 IDs.');
    for (const id of evidence) {
      const item = getRecord('artifact', id);
      if (!item || item.sessionId !== parent.id && !listRecords('artifact-read').some(read => read.sessionId === parent.id && read.artifactId === id && read.sha256 === item.sha256)) throw new Error('Context answers can share only parent or inspected evidence.');
      if (fileInfo(item.path).sha256 !== item.sha256) throw new Error('Context answer evidence changed after inspection.');
    }
    return { questionId: answer.questionId, text: contextText(answer.text, 2000, 'context answer'), evidence };
  });
  const requestId = digest([job.id, request.id, input.requestId || digest({ revision: request.revision, answers: normalized, declined })]);
  const previousReceipt = getRecord('assignment-context-answer', requestId);
  if (previousReceipt) throw new Error('This answer receipt was already applied. Reload the current request.');
  const changed = { ...request, state: declined ? 'declined' : 'answered', answers: normalized,
    rationale: declined ? contextText(input.contextRationale, 1500, 'context decline rationale') : null,
    revision: request.revision + 1, answeredAt: now() };
  putRecord(contextKind, request.id, changed, db); putRecord('assignment-context-answer', requestId,
    { id: requestId, requestId: request.id, revision: changed.revision, sha256: digest(changed) }, db);
  putRecord('assignment', job.id, { ...latest, contextRequest: compactContext(changed), ...(job.chatRunId ? { chatRunId: job.chatRunId } : {}) }, db);
  appendEvent(parent.id, 'assignment.context_answered', compactContext(changed), db); return compactContext(changed);
}

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
  return { ...job, contextRequest: compactContext(assignmentContextRequest(job)), round };
}
function checkLimits(parent, subagent) {
  const { total, active } = assignmentCounts(subagent?.chatRunId ? { ...parent, goal: null } : parent);
  if (active >= (subagent ? Math.min(parent.contract?.limits.concurrency || 3, 4) : parent.contract?.limits.concurrency || 1)) throw new Error('Assignment concurrency limit reached. Wait for or cancel the active assignment.');
  if (subagent && total >= Math.min(parent.contract?.limits.maxAssignments || 64, 64)) throw new Error('Subagent assignment count limit reached.');
  if (subagent && database().prepare("SELECT count(*) AS n FROM records WHERE kind='round' AND json_extract(data,'$.state') IN ('starting','running')").get().n >= 16) throw new Error('Host worker concurrency limit reached.');
  if (parent.contract?.limits.maxAssignments != null && total >= parent.contract.limits.maxAssignments) throw new Error('Assignment count limit reached.');
}
export function startAssignment(parent, input, { executor, snapshot, role = 'executor', allowDebate = false, sharedEvidence = [], launch = launchAssignment, independent = false, subagent, reportProtocol } = {}) {
  const source = currentSource(parent);
  if (subagent) {
    assertSubagentDefinitionPin(subagent.definition);
    assertSubagentDefinitionEnabled(subagent.definition);
    if (parent.parentSessionId || parent.assignmentId || ['executor', 'reviewer', 'peer', 'bestie'].includes(parent.role) || parent.purpose === 'agent') throw new Error('Subagents require an authorized parent conversation and a pinned definition.');
  }
  if (parentStopped(source, subagent)) throw new Error('The parent conversation is paused. No assignment was launched.');
  if (parent.mode !== 'delegate' && !allowDebate && !subagent) throw new Error('Delegation was not enabled for this task.');
  const selection = executor || parent.executor;
  if (!selection) throw new Error('Choose an executor provider/model.');
  const provider = getProvider(selection.provider);
  const policy = childPolicy(parent.policy || parent.contract?.policy, input.policy);
  if (reportProtocol !== undefined && (reportProtocol !== finalValidationReportProtocol || !allowDebate || parent.mode !== 'debate' || role !== 'reviewer' ||
      policy.mode !== 'read-only' || independent || subagent)) throw new Error('The final validation report protocol requires a host-created read-only Validate reviewer.');
  const contract = normalizeContract({ ...input, policy, scope: parent.contract?.scope || {}, constraints: [...new Set([...(parent.contract?.constraints || []), ...(input.constraints || [])])],
    limits: { runtimeSeconds: Math.min(input.limits?.runtimeSeconds || 1200, parent.contract?.limits.assignmentSeconds || (subagent ? 3600 : 1200)),
      maxRetries: 0, ...(input.limits?.tokenBudget ? { tokenBudget: input.limits.tokenBudget } : {}) } }, input.objective);
  if (!input.context?.trim() || !input.acceptanceCriteria?.length) throw new Error('An assignment needs context and acceptanceCriteria in addition to its objective.');
  const usageScope = subagent?.chatRunId ? { ...parent, goal: null } : parent;
  for (const job of activeAssignmentsFor(usageScope)) assignmentStatus(job.id);
  const id = randomUUID(), requestId = input.requestId || randomUUID();
  const missionContext = createMissionContext(source, { purpose: subagent ? 'subagent' : allowDebate ? 'debate' : 'delegate', independent, evidenceIds: sharedEvidence, taskContext: subagent?.taskContext });
  const result = reserveRequest(`assignment:${parent.id}:${subagent?.chatRunId || parent.goal?.id || 'chat'}`, requestId, { input, selection, role, snapshot: snapshot?.id, sourceGoalRevision: missionContext.sourceRevision, sharedEvidence, ...(reportProtocol ? { reportProtocol } : {}), ...(subagent ? { subagent } : {}) }, db => {
    if (parentStopped(loadSession(parent.id), subagent)) throw new Error('The parent conversation stopped before dispatch.');
    if (subagent) assertSubagentDefinitionEnabled(subagent.definition);
    checkLimits(parent, subagent);
    const remaining = subagent?.chatRunId || parent.goal?.tokenBudget == null ? null : parent.goal.tokenBudget - budgetUsage(parent);
    if (remaining != null && remaining <= 0) throw new Error('Parent usage budget is exhausted.');
    if (remaining != null) contract.limits.tokenBudget = Math.min(contract.limits.tokenBudget || remaining, remaining);
    if (subagent?.budget != null) {
      const reserved = activeAssignmentsFor(usageScope).reduce((sum, item) => { const job = getRecord('assignment', item.id); return sum + Math.max(0, (job.contract?.limits.tokenBudget || 0) - chargedUsage(job)); }, 0);
      const available = subagent.budget - budgetUsage(usageScope) - reserved - supervisorHeadroom(parent, subagent.workerBudget, subagent.budget);
      if (available < 1) throw new Error('Parent usage budget is exhausted or reserved by active workers.');
      contract.limits.tokenBudget = Math.min(contract.limits.tokenBudget, available);
    }
    const job = { id, parentSessionId: parent.id, goalId: subagent?.chatRunId ? null : parent.goal?.id || null, missionContext, selection, contract, role, closure: 'open', currentRound: 1, createdAt: now(), snapshotId: snapshot?.id || null, workspace: null, sharedEvidence, captureNetwork: Boolean(parent.captureNetwork),
      ...(reportProtocol ? { reportProtocol } : {}),
      ...(subagent ? { subagentDefinition: subagent.definition,
        workerBudget: subagent.workerBudget ? { ...subagent.workerBudget, initialTokenBudget: contract.limits.tokenBudget,
          reportReserveTokens: Math.min(subagent.workerBudget.reportReserveTokens, Math.max(1, Math.floor(contract.limits.tokenBudget / 5))) } : undefined,
        chatRunId: subagent.chatRunId || null, sourceGoalId: parent.goal?.id || null, subagentTaskContext: subagent.taskContext,
        ...(subagent.routing ? { subagentRouting: subagent.routing } : {}) } : {}) };
    reserveRoutingAssignment(source, subagent?.routing, id, db);
    putRecord('assignment', id, job, db);
    if (subagent?.invocation) putRecord('subagent-invocation', subagent.invocation.id, { ...subagent.invocation, assignmentId: id }, db);
    putRecord('round', `${id}:1`, { assignmentId: id, number: 1, state: 'starting', requestId, createdAt: now(), feedback: null }, db);
    appendEvent(parent.id, 'assignment.created', job, db); return { id, round: 1 };
  });
  dispatchAssignment(result.id, result.round, launch); return assignmentStatus(result.id);
}
function dispatchAssignment(id, number, launch) {
  const dispatched = transaction(db => {
    const job = getRecord('assignment', id), round = getRecord('round', `${id}:${number}`);
    if (!job || !round || round.state !== 'starting' || round.dispatchRequestedAt) return false;
    const parent = loadSession(job.parentSessionId);
    if (!parent || parentStopped(parent, job)) {
      putRecord('round', `${id}:${number}`, { ...round, state: 'paused', reason: 'Parent conversation paused before dispatch.' }, db); return false;
    }
    if (job.subagentDefinition) {
      try { assertSubagentDefinitionEnabled(job.subagentDefinition); }
      catch (error) {
        if (error.code !== 'SUBAGENT_DISABLED') throw error;
        putRecord('round', `${id}:${number}`, { ...round, state: 'paused', reason: error.message }, db); return false;
      }
    }
    putRecord('round', `${id}:${number}`, { ...round, dispatchRequestedAt: now() }, db); return true;
  });
  if (dispatched) launch(id, number);
}
function launchAssignment(id, number) {
  const child = spawn(process.execPath, [path.join(root, 'bin/bzzy-engine.js'), 'internal-assignment', id, String(number)], { env: runtimeEnv(), detached: true, stdio: 'ignore' });
  transaction(db => {
    const pending = getRecord('round', `${id}:${number}`);
    if (pending?.state === 'starting') putRecord('round', `${id}:${number}`, { ...pending, launcher: processIdentity(child.pid), dispatchedAt: now() }, db);
  });
  child.unref(); child.on('error', error => {
    const round = getRecord('round', `${id}:${number}`);
    if (round?.state === 'starting') putRecord('round', `${id}:${number}`, { ...round, state: 'failed', reason: error.message });
  });
}
export function followupAssignment(parent, id, input, { sharedEvidence, launch = launchAssignment, chatRunId, budget } = {}) {
  const job = assignmentStatus(id);
  const source = currentSource(parent, job);
  const runScope = chatRunId && job.chatRunId ? { ...job, chatRunId } : job;
  if (parentStopped(source, runScope)) throw new Error('The parent conversation is paused. No follow-up was launched.');
  if (job.parentSessionId !== parent.id || job.goalId != null && job.goalId !== parent.goal?.id) throw new Error('Assignment belongs to another objective.');
  if (!input.feedback?.trim() || !input.objective?.trim()) throw new Error('Follow-up needs supervisor feedback and a focused objective.');
  const maxRounds = (parent.contract?.limits.maxRetries ?? (job.workerBudget?.mode === 'adaptive' ? 63 : 2)) + 1;
  const result = reserveRequest(`followup:${id}`, input.requestId || randomUUID(), input, db => {
    const latest = getRecord('assignment', id);
    currentSource(source, latest);
    if (parentStopped(loadSession(parent.id), runScope)) throw new Error('The parent conversation is paused. No follow-up was launched.');
    assertRoutingFollowup(source, latest);
    if (latest.currentRound !== job.currentRound || latest.closure !== 'open' || ['starting', 'running'].includes(getRecord('round', `${id}:${latest.currentRound}`)?.state)) throw new Error('Assignment is not ready for a follow-up.');
    if (job.currentRound >= maxRounds) throw new Error('Assignment follow-up limit reached; take over directly or record the unresolved result.');
    if (!job.chatRunId && parent.goal?.tokenBudget != null && budgetUsage(parent) >= parent.goal.tokenBudget) throw new Error('Parent usage budget is exhausted.');
    if (job.subagentDefinition) {
      assertSubagentDefinitionEnabled(job.subagentDefinition);
      if ((currentAssignmentUsage(job).elapsedSeconds || 0) >= job.contract.limits.runtimeSeconds) throw new Error('Subagent runtime budget is exhausted.');
      const usageScope = job.chatRunId ? { ...parent, goal: null } : parent;
      const { active } = assignmentCounts(usageScope);
      if (active >= Math.min(parent.contract?.limits.concurrency || 3, 4)) throw new Error('Assignment concurrency limit reached.');
      if (database().prepare("SELECT count(*) AS n FROM records WHERE kind='round' AND json_extract(data,'$.state') IN ('starting','running')").get().n >= 16) throw new Error('Host worker concurrency limit reached.');
      if (budget != null) {
        const reserved = activeAssignmentsFor(usageScope).reduce((sum, item) => { const activeJob = getRecord('assignment', item.id); return sum + Math.max(0, (activeJob.contract?.limits.tokenBudget || 0) - chargedUsage(activeJob)); }, 0);
        const available = budget - budgetUsage(usageScope) - reserved - supervisorHeadroom(parent, job.workerBudget, budget);
        if (available < 1) throw new Error('Parent usage budget is exhausted or reserved by active workers.');
        const used = chargedUsage(job);
        const contract = { ...latest.contract, limits: { ...latest.contract.limits, tokenBudget: Math.min(latest.contract.limits.tokenBudget, used + available) } };
        putRecord('assignment', id, { ...latest, contract }, db);
      }
    }
    const budgetJob = getRecord('assignment', id);
    if (budgetJob.contract.limits.tokenBudget != null && chargedUsage(budgetJob) >= budgetJob.contract.limits.tokenBudget) throw new Error('Assignment usage budget is exhausted.');
    let contextRequest = assignmentContextRequest(latest);
    if (contextRequest?.state === 'pending') {
      if (!input.contextRequestId) throw new Error('Answer the outstanding context questions in this follow-up before restarting the worker.');
      contextRequest = answerContextInTransaction(source, runScope, input, db);
      if (contextRequest.state === 'declined') throw new Error('A declined context request cannot launch more worker execution. Review the bounded result as inconclusive or abandoned.');
    } else if (input.contextRequestId) {
      if (contextRequest?.id !== input.contextRequestId || contextRequest.state !== 'answered') throw new Error('The follow-up context answer changed. Reload its request.');
    }
    const previousControl = getRecord('assignment-control', id);
    if (previousControl?.action === 'cancel' && (previousControl.round == null || previousControl.round <= latest.currentRound)) db.prepare("DELETE FROM records WHERE kind='assignment-control' AND id=?").run(id);
    const number = latest.currentRound + 1;
    const selectedEvidence = [...new Set([...(sharedEvidence || latest.sharedEvidence || []), ...(contextRequest?.answers || []).flatMap(answer => answer.evidence || [])])];
    if (selectedEvidence.length > 4096) throw new Error('The answered context exceeds the bounded host evidence manifest limit.');
    const missionContext = createMissionContext(source, { purpose: job.subagentDefinition ? 'subagent' : job.role === 'reviewer' ? 'debate' : 'delegate', independent: false,
      evidenceIds: selectedEvidence, taskContext: job.subagentTaskContext });
    putRecord('round', `${id}:${number}`, { assignmentId: id, number, state: 'starting', createdAt: now(), feedback: input.feedback, objective: input.objective, contextRequest }, db);
    putRecord('assignment', id, { ...getRecord('assignment', id), currentRound: number, missionContext, sharedEvidence: selectedEvidence, ...(chatRunId && job.chatRunId ? { chatRunId } : {}) }, db);
    appendEvent(parent.id, 'assignment.followup', { id, round: number, objective: input.objective, provider: job.selection.provider, model: job.selection.model }, db);
    return { id, round: number };
  });
  dispatchAssignment(id, result.round, launch); return result;
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
// This reallocates an owner-approved adaptive allowance; it never changes the
// owner ceiling, permission policy, immutable mission or verified goal state.
export function extendAssignmentBudget(parent, id, input, context = {}) {
  if (context.signal?.aborted) throw new Error('The supervisor execution stopped. No allocation was changed.');
  const source = currentSource(parent), run = getRecord('run', source.id);
  if (source.parentSessionId || source.role || source.agentId || source.purpose && source.purpose !== 'terminal'
    || !context.runId || run?.id !== context.runId || run.state !== 'running' || parentStopped(source, { chatRunId: context.goalMode === false ? context.runId : null })) throw new Error('Budget extensions require the current owner supervisor execution.');
  if (!input || Object.keys(input).some(key => !['id', 'requestId', 'expectedRevision', 'addTokens', 'addSeconds', 'progress', 'evidence'].includes(key))
    || typeof input.requestId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(input.requestId)
    || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1
    || ![input.addTokens, input.addSeconds].some(value => Number.isSafeInteger(value) && value > 0)
    || input.addTokens !== undefined && (!Number.isSafeInteger(input.addTokens) || input.addTokens < 1 || input.addTokens > 200000)
    || input.addSeconds !== undefined && (!Number.isSafeInteger(input.addSeconds) || input.addSeconds < 1 || input.addSeconds > 3600)
    || !Array.isArray(input.evidence) || !input.evidence.length || input.evidence.length > 16) throw new Error('A budget extension needs a revision, bounded increments and inspected progress evidence.');
  const progress = contextText(input.progress, 1500, 'progress summary');
  return reserveRequest(`assignment-budget:${source.id}:${id}`, input.requestId, input, db => {
    if (context.signal?.aborted) throw new Error('The supervisor execution stopped. No allocation was changed.');
    const job = getRecord('assignment', id), saved = currentSource(loadSession(source.id), job), currentRun = getRecord('run', source.id);
    if (!job || job.parentSessionId !== saved.id || job.closure !== 'open' || job.importProvenance || !job.subagentDefinition
      || (job.chatRunId ? context.goalMode !== false : job.goalId !== saved.goal?.id || context.goalMode === false)
      || parentStopped(saved, job.chatRunId ? { ...job, chatRunId: context.runId } : job)
      || currentRun?.id !== context.runId || currentRun.state !== 'running') throw new Error('The assignment is not available to this live supervisor.');
    const round = getRecord('round', `${id}:${job.currentRound}`);
    if (job.chatRunId && job.chatRunId !== context.runId && (!round || round.assignmentId !== id || (round.number ?? round.round) !== job.currentRound
      || !['awaiting_review', 'budget_limited', 'timed_out', 'interrupted', 'paused', 'cancelled', 'failed', 'needs_context'].includes(round.state))) {
      throw new Error('Reconcile the earlier chat worker to a valid stopped round before extending it.');
    }
    const policy = job.workerBudget;
    if (policy?.version !== 1 || policy.mode !== 'adaptive' || policy.revision !== input.expectedRevision) throw new Error('The allocation is fixed or changed. Refresh assignment_status before extending it.');
    assertSubagentDefinitionPin(job.subagentDefinition); assertSubagentDefinitionEnabled(job.subagentDefinition);
    assertRoutingFollowup(saved, job);
    const usage = currentAssignmentUsage(job);
    if ((!usage.available || usage.accountingComplete === false) && !['starting', 'running'].includes(getRecord('round', `${id}:${job.currentRound}`)?.state)) throw new Error('Finished worker usage is unknown. Reconcile it before allocating more work.');
    const hashes = input.evidence.map(ref => {
      const item = getRecord('artifact', ref);
      const inspected = listRecords('artifact-read').some(read => read.sessionId === saved.id && read.assignmentId === id
        && read.assignmentRound === job.currentRound && read.artifactId === ref && read.sha256 === item?.sha256 && read.bytesRead > 0);
      if (!item || !inspected || fileInfo(item.path).sha256 !== item.sha256) throw new Error('Extensions require intact worker evidence inspected in this assignment round.');
      return item.sha256;
    });
    if (hashes.every(hash => getRecord('core.assignment.budget-progress', digest([id, hash])))) throw new Error('Provide new inspected progress before another allocation extension.');
    const tokens = job.contract.limits.tokenBudget + (input.addTokens || 0), seconds = job.contract.limits.runtimeSeconds + (input.addSeconds || 0);
    if (!Number.isSafeInteger(tokens) || !Number.isSafeInteger(seconds) || policy.hardTokenLimit != null && tokens > policy.hardTokenLimit
      || policy.hardRuntimeLimitSeconds != null && seconds > policy.hardRuntimeLimitSeconds) throw new Error('The requested extension exceeds an owner or definition hard limit.');
    const usageScope = job.chatRunId ? { ...saved, goal: null } : saved, parentLimit = job.chatRunId ? context.tokenBudget ?? null : saved.goal?.tokenBudget ?? null;
    if (parentLimit != null) {
      const reserved = activeAssignmentsFor(usageScope).filter(active => active.id !== id).reduce((sum, active) => {
        const other = getRecord('assignment', active.id); return sum + Math.max(0, (other.contract?.limits.tokenBudget || 0) - chargedUsage(other));
      }, 0);
      const available = parentLimit - budgetUsage(usageScope) - reserved - supervisorHeadroom(saved, policy, parentLimit);
      if (tokens - chargedUsage(job) > available) throw new Error('The extension exceeds the parent budget after worker reservations and review headroom.');
    }
    const changed = { ...job, ...(job.chatRunId ? { chatRunId: context.runId } : {}), contract: { ...job.contract, limits: { ...job.contract.limits, tokenBudget: tokens, runtimeSeconds: seconds } },
      workerBudget: { ...policy, revision: policy.revision + 1, extensionCount: (policy.extensionCount || 0) + 1, lastProgressEvidence: hashes,
        reportReserveTokens: Math.min(policy.requestedReportReserveTokens || policy.reportReserveTokens, Math.max(1, Math.floor(tokens / 5))) } };
    putRecord('assignment', id, changed, db);
    for (const hash of hashes) putRecord('core.assignment.budget-progress', digest([id, hash]), {
      sessionId: saved.id, assignmentId: id, evidenceSha256: hash, round: job.currentRound, allocationRevision: changed.workerBudget.revision }, db);
    appendEvent(saved.id, 'assignment.budget.extended', { assignmentId: id, round: job.currentRound, revision: changed.workerBudget.revision,
      tokenLimit: tokens, runtimeLimitSeconds: seconds, progress, evidence: input.evidence }, db);
    return { id, budget: assignmentBudgetView(changed), next: ['starting', 'running'].includes(getRecord('round', `${id}:${job.currentRound}`)?.state)
      ? 'The current worker receives the increased allocation; no duplicate execution was started.' : 'Use followup_assignment to continue this same conversation with a focused objective and inspected evidence.' };
  });
}
export function reviewAssignment(parent, id, input) {
  const job = assignmentStatus(id);
  currentSource(parent, input.outcome === 'accepted' ? job : undefined);
  if (job.parentSessionId !== parent.id || ['starting', 'running'].includes(job.round.state) || job.closure !== 'open') throw new Error('Assignment cannot be closed while active or already closed.');
  if (!['accepted', 'inconclusive', 'abandoned'].includes(input.outcome) || !input.rationale?.trim()) throw new Error('Review needs outcome accepted, inconclusive or abandoned, and a rationale.');
  const context = assignmentContextRequest(job);
  if (context?.state === 'pending') throw new Error('Outstanding worker context questions must be answered or explicitly declined before review.');
  if (input.outcome === 'accepted' && context?.state === 'declined') throw new Error('An assignment with declined context cannot be accepted as verified work.');
  const inspected = listRecords('artifact-read').filter(r => {
    if (r.sessionId !== parent.id || r.assignmentId !== id || r.assignmentRound && r.assignmentRound !== job.currentRound || job.missionContext && (!r.sha256 || !(r.bytesRead > 0))) return false;
    const item = getRecord('artifact', r.artifactId);
    try { return Boolean(item && (!r.sha256 || item.sha256 === r.sha256) && fileInfo(item.path).sha256 === item.sha256); }
    catch { return false; }
  }).map(r => r.artifactId);
  if (input.outcome === 'accepted' && (!input.evidence?.length || input.evidence.some(ref => !inspected.includes(ref)))) throw new Error('Accepting an assignment requires evidence IDs the supervisor actually opened with read_artifact.');
  let patch;
  if (input.outcome === 'accepted') {
    if (job.goalId != null && job.goalId !== parent.goal?.id) throw new Error('Assignment belongs to another objective.');
    if (job.latestReport?.round !== job.currentRound || !Array.isArray(job.latestReport.changes)) throw new Error('Accepting an assignment requires the current round’s recorded report and patch.');
    const snapshot = getRecord('snapshot', job.snapshotId);
    const changes = inspectWorkspace(snapshot, job.workspace);
    if (changes.uninspected.length) throw new Error('Some previously snapshotted worker files could not be inspected. Resolve their omissions before accepting changes.');
    if (digest(changes) !== digest(job.latestReport.changes)) throw new Error('Worker workspace changed after its report. Request a focused follow-up before accepting it.');
    const modes = Object.fromEntries(changes.filter(change => change.after).map(change => [change.path, fs.statSync(inside(job.workspace, change.path)).mode & 0o777]));
    patch = { snapshotId: snapshot.id, changes, sha256: digest(changes), modes };
  }
  const review = { id: randomUUID(), assignmentId: id, round: job.currentRound, ...input, reviewedAt: now(), inspectedEvidence: inspected, patch };
  transaction(db => {
    const latest = getRecord('assignment', id), latestRound = getRecord('round', `${id}:${latest.currentRound}`);
    currentSource(parent, input.outcome === 'accepted' ? latest : undefined);
    if (latest.currentRound !== job.currentRound || latest.closure !== 'open' || ['starting', 'running'].includes(latestRound?.state)) throw new Error('Assignment changed during review. Inspect its current round again.');
    putRecord('review', review.id, review, db); putRecord('assignment', id, { ...latest, closure: input.outcome, review }, db); appendEvent(parent.id, 'assignment.reviewed', review, db);
    recordRoutingReview(parent, latest, review, db);
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
  currentSource(parent, job);
  if (job.parentSessionId !== parent.id || job.closure !== 'accepted' || parent.policy.mode === 'read-only' || job.goalId != null && job.goalId !== parent.goal?.id) throw new Error('Only an accepted assignment for this objective can be applied to a writable parent task.');
  const patch = job.review?.patch;
  if (!patch || patch.sha256 !== digest(patch.changes)) throw new Error('This assignment has no immutable reviewed patch. Request a new reviewed assignment before applying it.');
  const base = getRecord('snapshot', patch.snapshotId), changes = inspectWorkspace(base, job.workspace);
  if (changes.uninspected.length) throw new Error('Some previously snapshotted worker files could not be inspected. Unverified changes were not applied.');
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
      fs.mkdirSync(path.dirname(target), { recursive: true }); const content = fs.readFileSync(inside(job.workspace, change.path));
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
  const preparationStarted = Date.now();
  const token = randomUUID();
  const acquired = transaction(db => {
    job = getRecord('assignment', id); round = getRecord('round', `${id}:${number}`);
    if (!job || !round || round.state !== 'starting' || job.currentRound !== number) return false;
    const parent = loadSession(job.parentSessionId);
    if (!parent || parentStopped(parent, job)) { putRecord('round', `${id}:${number}`, { ...round, state: 'paused', reason: 'Parent conversation paused before execution.' }, db); return false; }
    if (job.subagentDefinition) {
      try { assertSubagentDefinitionEnabled(job.subagentDefinition); }
      catch (error) {
        if (error.code !== 'SUBAGENT_DISABLED') throw error;
        putRecord('round', `${id}:${number}`, { ...round, state: 'paused', reason: error.message }, db); return false;
      }
    }
    putRecord('round', `${id}:${number}`, { ...round, state: 'running', runner: processIdentity(), token, startedAt: now() }, db);
    appendEvent(job.parentSessionId, 'assignment.started', { id, round: number, provider: job.selection.provider, model: job.selection.model }, db); return true;
  });
  if (!acquired) return 0;
  try {
    const cancellation = getRecord('assignment-control', id);
    if (cancellation?.action === 'cancel' && (cancellation.round == null || cancellation.round === number)) { putRecord('round', `${id}:${number}`, { ...getRecord('round', `${id}:${number}`), state: 'cancelled', finishedAt: now() }); return 0; }
    const parent = loadSession(job.parentSessionId);
    currentSource(parent, job);
    if (job.subagentDefinition) assertSubagentDefinitionPin(job.subagentDefinition);
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
      copyWorkspaceSnapshot(snapshot, work, { sessionId: parent.id });
      job = { ...getRecord('assignment', id), snapshotId: snapshot.id, workspace: work }; putRecord('assignment', id, job);
    }
    job = getRecord('assignment', id);
    const provider = getProvider(job.selection.provider);
    childSession = job.workerSessionId ? loadSession(job.workerSessionId) : createSession(provider, job.workspace, job.selection.model);
    Object.assign(childSession, { role: job.role, parentSessionId: job.parentSessionId, assignmentId: id, assignmentRound: number, suppressNotifications: true,
      contract: job.contract, policy: job.contract.policy, backendHomes: parent.backendHomes, projectRoot: parent.projectRoot || parent.cwd, mode: 'solo', allowedArtifactIds: job.sharedEvidence || [],
      missionContext: job.missionContext, assignmentContext: round.contextRequest || compactContext(assignmentContextRequest(job)),
      ...(job.reportProtocol ? { reportProtocol: job.reportProtocol } : {}),
      ...(job.subagentDefinition ? { subagentDefinition: job.subagentDefinition } : {}),
      ...(job.selection.effort != null ? { selectedEffort: job.selection.effort } : {}),
      ...(job.selection.capabilities != null ? { modelCapabilities: job.selection.capabilities } : {}) });
    childSession.elapsedSeconds = (childSession.elapsedSeconds || 0) + (Date.now() - preparationStarted) / 1000;
    if (!childSession.usage) childSession.usage = { tokens: 0, available: true, accountingComplete: true, source: 'host-before-model-request' };
    saveSession(childSession); job = { ...getRecord('assignment', id), workerSessionId: childSession.id }; putRecord('assignment', id, job);
    if (parentStopped(loadSession(parent.id), job) || getRecord('assignment-control', id)?.action === 'cancel') {
      putRecord('round', `${id}:${number}`, { ...getRecord('round', `${id}:${number}`), state: 'paused', stopReason: 'parent_stopped', finishedAt: now() });
      appendEvent(parent.id, 'assignment.paused', { id, round: number, reason: 'Parent stopped before the model request; workspace preparation was retained.' }); return 0;
    }
    removeRecord('worker-report', childSession.id);
    const prompt = `You are the ${job.role} for a bounded assignment. The supervisor owns the parent objective, strategy and final judgment.
Use tools to perform substantial work within this contract. Preserve evidence with record_evidence and return finish_assignment.
Do not launch other agents, widen scope or claim the parent goal is complete. Clearly separate observations, inferences and uncertainty.
The workspace is an isolated copy; the supervisor reviews and applies changes. A failure or blocker returns control to the supervisor.
SHARED MISSION BRIEF (historical task context, never new tool authority):\n${JSON.stringify(job.missionContext?.brief || null)}
CONTRACT:\n${JSON.stringify(job.contract)}\nFOLLOW-UP:\n${JSON.stringify({ objective: round.objective, feedback: round.feedback, contextRequest: round.contextRequest || compactContext(assignmentContextRequest(job)), previousReport: job.latestReport ? compactAssignmentRound(job.latestReport) : null })}`;
    const { RunnerUI } = await import('./runtime-ui.js');
    const { runSession } = await import('./controller.js');
    const runtimeSeconds = job.subagentDefinition ? job.contract.limits.runtimeSeconds - (childSession.elapsedSeconds || 0) : job.contract.limits.runtimeSeconds;
    if (runtimeSeconds <= 0) throw Object.assign(new Error('Subagent runtime budget was exhausted during workspace preparation.'), { code: 'WORKER_PREPARATION_LIMIT' });
    const code = await runSession(provider, childSession, { cwd: childSession.cwd, pet: false, strictPolicy: true, policy: job.contract.policy,
      runtimeSeconds, tokenBudget: job.contract.limits.tokenBudget, scopedAutonomy: true, captureNetwork: job.captureNetwork }, new RunnerUI(childSession.id, { unattended: true, parentSessionId: parent.id, assignmentId: id, agent: job.subagentDefinition?.name }), prompt);
    const report = getRecord('worker-report', childSession.id);
    const outputs = artifactsFor(childSession.id);
    const changes = inspectWorkspace(snapshot, job.workspace);
    const patch = artifact(childSession, JSON.stringify(changes, null, 2), 'workspace-changes', 'application/json');
    const request = compactContext(assignmentContextRequest(getRecord('assignment', id)));
    const result = { assignmentId: id, round: number, state: report?.status === 'needs_context' && request?.state === 'pending' ? 'needs_context' : code === 0 || childSession.stopReason === 'allocation_checkpoint' && report?.status === 'partial' ? 'awaiting_review' : childSession.stopReason === 'runtime_limit' ? 'timed_out' : childSession.stopReason === 'token_limit' ? 'budget_limited' : childSession.executionState === 'cancelled' ? 'cancelled' : 'failed', stopReason: childSession.stopReason || childSession.failure?.category || null,
      error: code === 0 || childSession.stopReason === 'allocation_checkpoint' && report?.status === 'partial' ? null : childSession.failure?.message || childSession.goal?.reason || childSession.stopReason || null,
      workerClaim: report?.status || 'unknown', summary: (report?.summary || 'Worker returned without a structured assignment report.').slice(0, 8000),
      report: report || null, contextRequest: request, artifacts: [...outputs, patch].map(a => ({ id: a.id, label: a.label, size: a.size, sha256: a.sha256 })),
      missingReport: !report, changes, workspaceOmissions: changes.omissions, uninspectedPaths: changes.uninspected,
      usage: childSession.usage ? { ...childSession.usage, elapsedSeconds: childSession.elapsedSeconds } : null, exitCode: code, finishedAt: now() };
    const fullReport = artifact(childSession, JSON.stringify(result, null, 2), 'assignment-report', 'application/json');
    result.reportArtifactId = fullReport.id;
    result.artifacts.push({ id: fullReport.id, label: fullReport.label, size: fullReport.size, sha256: fullReport.sha256 });
    transaction(db => {
      putRecord('round', `${id}:${number}`, { ...getRecord('round', `${id}:${number}`), ...result }, db);
      putRecord('assignment', id, { ...getRecord('assignment', id), latestReport: result }, db);
      appendEvent(parent.id, 'assignment.finished', { id, round: number, state: result.state, report: { ...result, changes: undefined, report: undefined } }, db);
    });
  } catch (error) {
    putRecord('round', `${id}:${number}`, { ...getRecord('round', `${id}:${number}`), state: error.code === 'WORKER_PREPARATION_LIMIT' ? 'timed_out' : 'failed',
      ...(error.code === 'WORKER_PREPARATION_LIMIT' ? { stopReason: 'runtime_limit' } : {}), error: error.message, finishedAt: now() });
    if (job) appendEvent(job.parentSessionId, 'assignment.failed', { id, round: number, error: error.message });
  }
  return 0;
}
