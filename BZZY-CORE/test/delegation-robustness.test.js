import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createSession, loadSession, saveSession } from '../src/engine/store.js';
import { getProvider } from '../src/engine/providers.js';
import { normalizeContract } from '../src/engine/contracts.js';
import { newGoal } from '../src/engine/goals.js';
import { getRecord, putRecord, listRecords } from '../src/engine/database.js';
import { initializeProject } from '../src/engine/project.js';
import { artifact, snapshotWorkspace, inspectWorkspace } from '../src/engine/evidence.js';
import { contextFor, processIdentity, identityAlive, signalProcess } from '../src/engine/recovery.js';
import { ToolHost, taskTools } from '../src/engine/tools.js';
import { runtimeEnv } from '../src/engine/process.js';
import { startAssignment, followupAssignment, recordWorkerReport, answerAssignmentContext, assignmentStatus,
  reviewAssignment, pendingAssignmentContext } from '../src/engine/delegation.js';
import { compactAssignmentStatus } from '../src/engine/assignment-views.js';

let directory, oldHome, parent, launched;
test.beforeEach(() => {
  oldHome = process.env.BZZY_HOME;
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-delegate-robust-')));
  process.env.BZZY_HOME = path.join(directory, 'private');
  const project = path.join(directory, 'project'); fs.mkdirSync(project); fs.writeFileSync(path.join(project, 'offline.txt'), 'offline fixture');
  parent = createSession(getProvider('codex'), project, 'synthetic-brain');
  parent.mode = 'delegate'; parent.executor = { provider: 'codex', model: 'synthetic-hands' };
  parent.contract = normalizeContract({ context: 'FULL OWNER DIRECTIVE: preserve the negative control and do not contact targets.',
    constraints: ['Offline observations only.'], limits: { maxRetries: 2 } }, 'Classify the supplied offline authorization observation');
  parent.policy = parent.contract.policy; parent.goal = newGoal(parent.contract.objective); initializeProject(parent); saveSession(parent);
  launched = [];
});
test.afterEach(async () => {
  const identities = [...listRecords('session').map(session => session.backendProcess),
    ...listRecords('round').flatMap(round => [round.launcher, round.runner])].filter(identity => identity && identity.pid !== process.pid);
  for (const identity of identities) if (identityAlive(identity)) signalProcess(identity, 'SIGKILL', { group: identity.pgid === identity.pid });
  const deadline = Date.now() + 2000;
  while (identities.some(identityAlive) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  if (oldHome === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = oldHome;
  fs.rmSync(directory, { recursive: true, force: true });
});
const noExecution = (id, round) => launched.push({ id, round });
function assignment() {
  const snapshot = snapshotWorkspace(parent), input = { requestId: 'assignment-once', objective: 'Compare the offline baselines',
    context: 'Focused local comparison only.', acceptanceCriteria: ['Preserve missing proof as inconclusive.'] };
  const job = startAssignment(parent, input, { snapshot, launch: noExecution });
  const workspace = path.join(directory, 'worker'); fs.cpSync(snapshot.directory, workspace, { recursive: true });
  const worker = createSession(getProvider('codex'), workspace, 'synthetic-hands');
  Object.assign(worker, { role: 'executor', parentSessionId: parent.id, assignmentId: job.id, assignmentRound: 1,
    contract: job.contract, policy: job.contract.policy, missionContext: job.missionContext, projectRoot: parent.cwd }); saveSession(worker);
  putRecord('assignment', job.id, { ...getRecord('assignment', job.id), workerSessionId: worker.id, workspace });
  putRecord('round', `${job.id}:1`, { ...getRecord('round', `${job.id}:1`), state: 'running', runner: processIdentity() });
  return { job: assignmentStatus(job.id), worker, snapshot, input };
}
function contextRequest(worker, extra = {}) {
  return recordWorkerReport(worker, { status: 'needs_context', requestId: 'need-owner-baseline', summary: 'The selected observation does not identify the authorized baseline.', evidence: [],
    questions: [{ id: 'baseline', question: 'Which supplied observation is the authorized baseline?', reason: 'A role comparison needs an identified baseline.' }], ...extra }).contextRequest;
}
function finishRound(job, worker, snapshot, state = 'needs_context') {
  const latest = getRecord('assignment', job.id), report = getRecord('worker-report', worker.id);
  const result = { assignmentId: job.id, round: latest.currentRound, state, report, workerClaim: report.status,
    summary: report.summary, contextRequest: latest.contextRequest, changes: inspectWorkspace(snapshot, latest.workspace), artifacts: [] };
  putRecord('round', `${job.id}:${latest.currentRound}`, result); putRecord('assignment', job.id, { ...latest, latestReport: result });
}
const answer = request => ({ requestId: 'answer-baseline-once', contextRequestId: request.id, expectedContextRevision: request.revision,
  contextAnswers: [{ questionId: 'baseline', text: 'The owner-role observation in the selected fixture is the baseline. Missing proof remains inconclusive.', evidence: [] }] });

test('the full immutable mission accompanies the focused assignment without replaying unrelated history', () => {
  const { job, worker } = assignment();
  assert.equal(job.missionContext.brief.goal.objective, parent.goal.objective);
  assert.match(job.missionContext.brief.instructions, /FULL OWNER DIRECTIVE/);
  assert.ok(job.missionContext.brief.constraints.includes('Offline observations only.'));
  const context = JSON.parse(contextFor(worker)); assert.match(context.mission.instructions, /FULL OWNER DIRECTIVE/);
  assert.equal(context.projectContext, undefined); assert.equal(context.assignments, undefined);
});

test('missing-context questions are durable, idempotent, visible to the brain and cannot be waived by a complete claim', () => {
  const { job, worker, snapshot, input } = assignment(), request = contextRequest(worker);
  assert.deepEqual(contextRequest(worker), request); assert.equal(listRecords('assignment-context').length, 1);
  assert.equal(pendingAssignmentContext(parent)[0].id, request.id);
  assert.throws(() => recordWorkerReport(worker, { status: 'complete', summary: 'Pretend the unknown baseline was sufficient.', evidence: [] }), /Outstanding context/);
  finishRound(job, worker, snapshot);
  const brain = JSON.parse(contextFor(parent)); assert.equal(brain.assignments[0].contextRequest.questions[0].id, 'baseline');
  assert.equal(compactAssignmentStatus(assignmentStatus(job.id)).contextRequest.id, request.id);
  assert.throws(() => reviewAssignment(parent, job.id, { outcome: 'abandoned', rationale: 'Skip the question.' }), /Outstanding worker context/);
  assert.throws(() => followupAssignment(parent, job.id, { requestId: 'missing-answer', objective: 'Continue guessing', feedback: 'Do more work' }, { launch: noExecution }), /Answer the outstanding/);
  startAssignment(parent, input, { snapshot, launch: noExecution }); assert.equal(launched.length, 1, 'retrying creation never dispatches another worker');
});

test('an exact context answer is recorded without execution and explicit follow-up reuses the same worker conversation', () => {
  const { job, worker, snapshot } = assignment(), request = contextRequest(worker); finishRound(job, worker, snapshot);
  const resolved = answerAssignmentContext(parent, job.id, answer(request));
  assert.equal(resolved.state, 'answered'); assert.deepEqual(answerAssignmentContext(parent, job.id, answer(request)), resolved);
  assert.equal(launched.length, 1); assert.equal(pendingAssignmentContext(parent).length, 0);
  const followup = { requestId: 'continue-once', objective: 'Use the identified baseline', feedback: 'Keep the same controls and inspect the evidence.', contextRequestId: request.id };
  const started = followupAssignment(parent, job.id, followup, { launch: noExecution });
  assert.equal(started.round, 2); assert.equal(getRecord('assignment', job.id).workerSessionId, worker.id);
  assert.equal(getRecord('round', `${job.id}:2`).contextRequest.answers[0].questionId, 'baseline');
  assert.deepEqual(followupAssignment(parent, job.id, followup, { launch: noExecution }), started); assert.equal(launched.length, 2);
  assert.equal(listRecords('execution').length, 0, 'answering and reading never create an assessment execution');
});

test('declining unavailable context requires a rationale and cannot authorize accepting that assignment', () => {
  const { job, worker, snapshot } = assignment(), request = contextRequest(worker); finishRound(job, worker, snapshot);
  assert.throws(() => answerAssignmentContext(parent, job.id, { ...answer(request), contextAnswers: undefined, contextDisposition: 'declined' }), /rationale/);
  answerAssignmentContext(parent, job.id, { ...answer(request), contextAnswers: undefined, contextDisposition: 'declined', contextRationale: 'The owner supplied no baseline; this result remains inconclusive.' });
  assert.throws(() => reviewAssignment(parent, job.id, { outcome: 'accepted', rationale: 'A complete claim suffices.', evidence: [] }), /declined context/);
  assert.equal(reviewAssignment(parent, job.id, { outcome: 'inconclusive', rationale: 'Missing baseline prevents a finding.', evidence: [] }).outcome, 'inconclusive');
  assert.equal(launched.length, 1);
});

test('changed source instructions, foreign evidence and stale worker rounds fail before publishing answers or work', async () => {
  const { job, worker, snapshot } = assignment(), request = contextRequest(worker); finishRound(job, worker, snapshot);
  const foreign = createSession(getProvider('codex'), directory, 'no-model'), privateEvidence = artifact(foreign, 'Unrelated project record', 'foreign');
  assert.throws(() => answerAssignmentContext(parent, job.id, { ...answer(request), contextAnswers: [{ questionId: 'baseline', text: 'Use an unrelated account record.', evidence: [privateEvidence.id] }] }), /parent or inspected/);
  assert.equal(pendingAssignmentContext(parent).length, 1);
  parent.contract.context += ' NEW OWNER BOUNDARY'; saveSession(parent);
  assert.throws(() => answerAssignmentContext(parent, job.id, answer(request)), /instructions changed/);
  assert.throws(() => followupAssignment(parent, job.id, { requestId: 'stale-source', objective: 'Continue', feedback: 'Old instructions' }, { launch: noExecution }), /instructions changed/);
  assert.equal(launched.length, 1); assert.equal(listRecords('assignment-context')[0].state, 'pending');
  const decline = { ...answer(request), contextAnswers: undefined, contextDisposition: 'declined', contextRationale: 'The owner changed these instructions; retain the earlier result as inconclusive.' };
  assert.throws(() => answerAssignmentContext(parent, job.id, decline), /source revision/);
  answerAssignmentContext(parent, job.id, { ...decline, expectedSourceGoalRevision: request.sourceGoalRevision });
  assert.equal(reviewAssignment(parent, job.id, { outcome: 'inconclusive', rationale: 'Earlier source context is superseded.' }).outcome, 'inconclusive');
  worker.assignmentRound = 2; saveSession(worker);
  assert.throws(() => recordWorkerReport(worker, { status: 'complete', summary: 'A stale worker claim.', evidence: [] }), /no longer owns/);
});

test('pausing and read-only recovery expose questions without dispatching or implicitly answering them', () => {
  const { job, worker, snapshot } = assignment(), request = contextRequest(worker); finishRound(job, worker, snapshot);
  parent.executionState = 'paused'; parent.goal.status = 'paused'; saveSession(parent);
  assert.throws(() => answerAssignmentContext(parent, job.id, answer(request)), /Resume the parent/);
  assert.throws(() => followupAssignment(parent, job.id, { requestId: 'paused', objective: 'Continue', feedback: 'Continue', ...answer(request) }, { launch: noExecution }), /paused/);
  assert.equal(assignmentStatus(job.id).contextRequest.state, 'pending'); assert.match(contextFor(parent), /authorized baseline/);
  assert.equal(launched.length, 1); assert.equal(loadSession(worker.id).id, worker.id);
});

test('incidental snapshot omissions cannot authorize deletion or acceptance of an uninspected worker edit', async () => {
  const { job, worker, snapshot } = assignment();
  const proof = artifact(worker, 'A selected offline observation', 'observation');
  recordWorkerReport(worker, { status: 'complete', summary: 'Selected observation recorded.', evidence: [proof.id] });
  fs.writeFileSync(path.join(process.env.BZZY_HOME, 'config.json'), JSON.stringify({ snapshotLimits: { maxFileMiB: 1 } }));
  const fd = fs.openSync(path.join(worker.cwd, 'offline.txt'), 'r+'); fs.ftruncateSync(fd, 2 * 1024 * 1024); fs.closeSync(fd);
  finishRound(job, worker, snapshot, 'awaiting_review');
  const brain = new ToolHost(parent, { event() {} }); await brain.call('read_artifact', { id: proof.id });
  assert.throws(() => reviewAssignment(parent, job.id, { outcome: 'accepted', rationale: 'The observation was read.', evidence: [proof.id] }), /could not be inspected/);
  assert.equal(fs.readFileSync(path.join(parent.cwd, 'offline.txt'), 'utf8'), 'offline fixture');
  assert.equal(assignmentStatus(job.id).closure, 'open');
});

test('all successful evidence reads create hash-pinned bounded receipts while forged or modified evidence cannot be accepted', async () => {
  const { job, worker, snapshot } = assignment(), evidence = artifact(worker, 'A controlled comparison', 'comparison');
  recordWorkerReport(worker, { status: 'complete', summary: 'The supplied comparison is ready for review.', evidence: [evidence.id] }); finishRound(job, worker, snapshot, 'awaiting_review');
  const own = new ToolHost(worker, { event() {} }); await own.call('read_artifact', { id: evidence.id }); await own.call('read_artifact', { id: evidence.id });
  const ownReceipts = listRecords('artifact-read').filter(read => read.sessionId === worker.id);
  assert.equal(ownReceipts.length, 1); assert.equal(ownReceipts[0].sha256, evidence.sha256); assert.equal(ownReceipts[0].assignmentRound, 1);
  assert.throws(() => reviewAssignment(parent, job.id, { outcome: 'accepted', rationale: 'Trust the worker claim.', evidence: [evidence.id] }), /actually opened/);
  const brain = new ToolHost(parent, { event() {} }); await brain.call('read_artifact', { id: evidence.id, offset: evidence.size + 1 });
  assert.throws(() => reviewAssignment(parent, job.id, { outcome: 'accepted', rationale: 'An empty read counts as inspection.', evidence: [evidence.id] }), /actually opened/);
  await brain.call('read_artifact', { id: evidence.id });
  fs.writeFileSync(evidence.path, 'Changed after inspection');
  assert.throws(() => reviewAssignment(parent, job.id, { outcome: 'accepted', rationale: 'The old receipt is enough.', evidence: [evidence.id] }), /actually opened/);
  await assert.rejects(brain.call('read_artifact', { id: evidence.id }), /integrity/);
});

test('worker roles expose context questions but never supervisor answer or review administration', async () => {
  const { worker } = assignment(), tools = taskTools(worker);
  assert.ok(tools.find(tool => tool.name === 'finish_assignment').inputSchema.properties.status.enum.includes('needs_context'));
  assert.equal(tools.some(tool => tool.name === 'answer_assignment_context'), false);
  await assert.rejects(new ToolHost(worker, { event() {} }).call('answer_assignment_context', { id: randomUUID() }), /not authorized/);
});

test('the real worker runner stops a needs_context native turn and kills an unresponsive backend without pausing its parent goal', { timeout: 20000 }, async () => {
  const keys = ['BZZY_CODEX_BIN', 'BZZY_CODEX_HOME', 'NODE_OPTIONS'], previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  let backend;
  try {
    process.env.BZZY_CODEX_BIN = fileURLToPath(new URL('./fixtures/delegation-needs-context.mjs', import.meta.url));
    process.env.BZZY_CODEX_HOME = path.join(directory, 'fixture-auth'); process.env.NODE_OPTIONS = '';
    fs.mkdirSync(process.env.BZZY_CODEX_HOME, { mode: 0o700 });
    fs.writeFileSync(path.join(process.env.BZZY_CODEX_HOME, 'auth.json'), '{}', { mode: 0o600 });
    const runnerLog = path.join(directory, 'runner.log');
    const launch = (id, number) => {
      const descriptor = fs.openSync(runnerLog, 'a', 0o600);
      const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/bzzy-engine.js', import.meta.url)), 'internal-assignment', id, String(number)],
        { detached: true, env: runtimeEnv(), stdio: ['ignore', descriptor, descriptor] }); fs.closeSync(descriptor);
      child.unref(); putRecord('round', `${id}:${number}`, { ...getRecord('round', `${id}:${number}`), launcher: processIdentity(child.pid) });
    };
    const startedAt = Date.now(), job = startAssignment(parent, { requestId: 'native-context-worker', objective: 'Inspect only supplied offline observations',
      context: 'Request the missing baseline; no target access is needed.', acceptanceCriteria: ['Unidentified baselines remain inconclusive.'], limits: { runtimeSeconds: 12 } }, { launch });
    const pidFile = path.join(process.env.BZZY_CODEX_HOME, 'offline-needs-context-pid.json');
    const until = async check => {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) { const value = check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 25)); }
      assert.fail(JSON.stringify(assignmentStatus(job.id)) + '\n' + (fs.existsSync(runnerLog) ? fs.readFileSync(runnerLog, 'utf8') : ''));
    };
    await until(() => fs.existsSync(pidFile)); backend = processIdentity(JSON.parse(fs.readFileSync(pidFile, 'utf8')).pid); assert.ok(backend);
    await until(() => assignmentStatus(job.id).round.state === 'needs_context');
    await until(() => !identityAlive(backend));
    const result = assignmentStatus(job.id), worker = loadSession(result.workerSessionId);
    assert.equal(result.contextRequest.state, 'pending'); assert.equal(result.latestReport.workerClaim, 'needs_context');
    assert.equal(worker.executionState, 'paused'); assert.equal(worker.stopReason, 'needs_context');
    assert.equal(loadSession(parent.id).goal.status, 'active'); assert.equal(pendingAssignmentContext(parent).length, 1);
    assert.ok(Date.now() - startedAt < 10000, 'the native review closes within its bounded kill grace');
    assert.equal(listRecords('execution').length, 0);
  } finally {
    if (backend && identityAlive(backend)) signalProcess(backend, 'SIGKILL', { group: backend.pgid === backend.pid });
    for (const key of keys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
  }
});
