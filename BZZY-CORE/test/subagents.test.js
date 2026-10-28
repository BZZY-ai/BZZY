import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSession, loadSession, saveSession } from '../src/engine/store.js';
import { getProvider } from '../src/engine/providers.js';
import { normalizeContract, normalizePolicy } from '../src/engine/contracts.js';
import { newGoal } from '../src/engine/goals.js';
import { getRecord, putRecord, listRecords, now, appendEvent } from '../src/engine/database.js';
import { initializeProject } from '../src/engine/project.js';
import { artifact } from '../src/engine/evidence.js';
import { processIdentity, identityAlive, signalProcess } from '../src/engine/recovery.js';
import { assignmentStatus, cancelAssignment, runAssignment, startAssignment, reviewAssignment, recordWorkerReport } from '../src/engine/delegation.js';
import { taskTools, ToolHost } from '../src/engine/tools.js';
import { saveSubagentDefinition } from '../src/engine/subagent-definitions.js';
import { spawnSubagent, subagentStatus, listSubagentRuns, followupSubagent } from '../src/engine/subagents.js';
import { runSession } from '../src/engine/controller.js';
import { claudeArgs } from '../src/engine/engines/claude.js';
import { activeAssignmentsFor, currentAssignmentUsage, budgetUsage, assignmentsFor, delegationUsage } from '../src/engine/delegation-usage.js';
import { assessCompletion } from '../src/engine/verification.js';

let directory, previousHome, parent, launched;
test.beforeEach(() => {
  previousHome = process.env.BZZY_HOME;
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-subagents-')));
  process.env.BZZY_HOME = path.join(directory, 'private');
  const cwd = path.join(directory, 'project'); fs.mkdirSync(cwd); fs.writeFileSync(path.join(cwd, 'fixture.txt'), 'Offline baseline.');
  parent = createSession(getProvider('codex'), cwd, 'synthetic-parent');
  parent.mode = 'solo'; parent.policy = normalizePolicy(); initializeProject(parent); saveSession(parent);
  launched = [];
});
test.afterEach(async () => {
  const identities = [...listRecords('session').map(session => session.backendProcess),
    ...listRecords('round').flatMap(round => [round.launcher, round.runner])].filter(identity => identity && identity.pid !== process.pid);
  for (const identity of identities) if (identityAlive(identity)) signalProcess(identity, 'SIGKILL', { group: identity.pgid === identity.pid });
  const deadline = Date.now() + 2000;
  while (identities.some(identityAlive) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  if (previousHome === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previousHome;
  fs.rmSync(directory, { recursive: true, force: true });
});
const define = (name, extra = {}, options = {}) => saveSubagentDefinition({ name, description: `Offline ${name} specialist.`,
  instructions: `Inspect only the supplied local ${name} fixtures. Preserve uncertainty.`, ...extra }, { cwd: parent.cwd, ...options });
const noExecution = (id, round) => launched.push({ id, round });
function beginRun({ goalMode = false, prompt = 'Compare the two supplied offline observations.' } = {}) {
  parent.executionState = 'running'; saveSession(parent);
  const run = { id: randomUUID(), sessionId: parent.id, state: 'running', runner: processIdentity(), startedAt: now() };
  putRecord('run', parent.id, run);
  return { goalMode, runId: run.id, prompt, launch: noExecution };
}
const input = (name = 'http-analyst', extra = {}) => ({ name, requestId: `request-${name}`, objective: `Inspect the local ${name} baseline.`, ...extra });
const rejected = (operation, pattern) => assert.rejects(async () => operation(), pattern);
function finishOfflineRound(id) {
  const job = getRecord('assignment', id), round = getRecord('round', `${id}:${job.currentRound}`);
  const result = { ...round, state: 'awaiting_review', summary: 'Offline claim needs supervisor inspection.',
    workerClaim: 'partial', report: { status: 'partial', summary: 'Offline claim.', evidence: [] }, artifacts: [], changes: [],
    usage: { tokens: 0, available: true, accountingComplete: true, elapsedSeconds: 0 }, finishedAt: now() };
  putRecord('round', `${id}:${job.currentRound}`, result); putRecord('assignment', id, { ...job, latestReport: result });
}

test('ordinary solo chat launches multiple selected specialists without creating or mutating a goal', async () => {
  define('http-analyst', { provider: 'codex', model: 'synthetic-http', effort: 'default' });
  define('code-reviewer', { provider: 'codex', model: 'synthetic-review' });
  const context = beginRun();
  const first = await spawnSubagent(parent, input(), context), second = await spawnSubagent(parent, input('code-reviewer'), context);
  assert.notEqual(first.id, second.id); assert.equal(launched.length, 2);
  const jobs = [first, second].map(item => getRecord('assignment', item.id));
  assert.deepEqual(jobs.map(job => job.selection.model), ['synthetic-http', 'synthetic-review']);
  assert.ok(jobs.every(job => job.role === 'executor' && job.goalId === null && job.chatRunId === context.runId));
  assert.match(jobs[0].subagentDefinition.instructions, /supplied local http-analyst/);
  assert.match(JSON.stringify(jobs[0].missionContext.brief), /Compare the two supplied offline observations/);
  assert.equal(loadSession(parent.id).goal, null); assert.equal(loadSession(parent.id).mode, 'solo');
  assert.equal(listRecords('execution').length, 0, 'offline launch callback never invokes a provider');
});

for (const providerId of ['codex', 'claude', 'deepseek', 'abliteration', 'orcarouter']) {
  test(`an unpinned specialist inherits the current ${providerId} provider, model and effort`, async () => {
    const provider = getProvider(providerId);
    parent = createSession(provider, parent.cwd, provider.model || `synthetic-${providerId}`);
    parent.mode = 'solo'; parent.policy = normalizePolicy(); parent.selectedEffort = 'high';
    parent.modelCapabilities = { supportedEfforts: ['low', 'high'], contextWindow: 64000 }; saveSession(parent);
    define('http-analyst');
    const result = await spawnSubagent(parent, input(), beginRun());
    assert.equal(result.selection.provider, providerId); assert.equal(result.selection.model, parent.model);
    assert.equal(result.selection.effort, parent.selectedEffort); assert.deepEqual(result.selection.capabilities, parent.modelCapabilities);
    assert.equal(launched.length, 1);
  });
}

test('chat subagents use the current request while preserving an older paused goal and contract exactly', async () => {
  define('http-analyst');
  parent.contract = normalizeContract({ context: 'Earlier goal instructions.',
    acceptanceCriteria: [{ id: 'old-acceptance', description: 'OLD ACCEPTANCE DO NOT CARRY', modelJudgment: true }],
    artifacts: [{ path: 'old-result.json' }] }, 'Earlier saved objective');
  parent.reviewSource = { label: 'OLD REVIEW DO NOT CARRY', sourceId: 'previous-review' };
  parent.goal = newGoal(parent.contract.objective, 900); parent.goal.status = 'paused'; parent.goal.tokensUsed = 900; parent.goal.nativeTokensUsed = 900; saveSession(parent);
  const original = structuredClone({ goal: parent.goal, contract: parent.contract });
  const context = beginRun({ prompt: 'Review this new offline chat request without continuing the earlier goal.' });
  const result = await spawnSubagent(parent, input(), context), job = getRecord('assignment', result.id);
  assert.equal(job.goalId, null); assert.equal(job.sourceGoalId, original.goal.id);
  assert.match(JSON.stringify(job.missionContext.brief), /new offline chat request/);
  assert.equal(JSON.stringify(job.missionContext.brief).includes('OLD ACCEPTANCE DO NOT CARRY'), false);
  assert.equal(JSON.stringify(job.missionContext.brief).includes('OLD REVIEW DO NOT CARRY'), false);
  assert.deepEqual(job.missionContext.brief.deliverables, []); assert.equal(job.missionContext.brief.reviewSource, undefined);
  assert.deepEqual(loadSession(parent.id).goal, original.goal); assert.deepEqual(loadSession(parent.id).contract, original.contract);
});

test('retries reuse one pinned invocation after its reusable definition changes', async () => {
  const definition = define('http-analyst', { model: 'synthetic-original' }), context = beginRun(), request = input();
  const result = await spawnSubagent(parent, request, context);
  define('http-analyst', { model: 'synthetic-revised', instructions: 'Revised reusable local inspection behavior.' }, { expectedRevision: definition.revision });
  const retried = await spawnSubagent(parent, request, context), pinned = getRecord('assignment', result.id);
  assert.equal(retried.id, result.id); assert.equal(launched.length, 1);
  assert.equal(pinned.subagentDefinition.version, definition.version); assert.equal(pinned.selection.model, 'synthetic-original');
  const fresh = await spawnSubagent(parent, input('http-analyst', { requestId: 'revised-invocation' }), context);
  assert.equal(getRecord('assignment', fresh.id).selection.model, 'synthetic-revised');
  await rejected(() => spawnSubagent(parent, { ...request, objective: 'Different work under the same request ID.' }, context), /conflict|different input|already used/i);
});

test('ordinary chat spawning requires the exact live parent run and cannot restart a paused conversation', async () => {
  define('http-analyst');
  await rejected(() => spawnSubagent(parent, input(), { runId: randomUUID(), prompt: 'Offline task.', launch: noExecution }), /run|running|active|live.*execution/i);
  const context = beginRun();
  await rejected(() => spawnSubagent(parent, input(), { ...context, runId: randomUUID() }), /run|running|active|live.*execution/i);
  parent.executionState = 'paused'; saveSession(parent);
  await rejected(() => spawnSubagent(parent, input(), context), /paused|running|active|live.*execution/i);
  assert.equal(launched.length, 0); assert.equal(listRecords('assignment').length, 0);
});

test('named subagents cannot widen parent permissions or receive another session evidence', async () => {
  define('http-analyst');
  parent.policy = normalizePolicy({ mode: 'read-only', network: 'disabled' }); saveSession(parent);
  const context = beginRun();
  await rejected(() => spawnSubagent(parent, input('http-analyst', { policy: { mode: 'workspace-write', network: 'inherit' } }), context), /widen|read.only|network|permission/i);
  const foreign = createSession(getProvider('codex'), parent.cwd, 'synthetic-foreign'), evidence = artifact(foreign, 'Unrelated private observation.', 'foreign-observation');
  await rejected(() => spawnSubagent(parent, input('http-analyst', { evidence: [evidence.id] }), context), /evidence|artifact|outside|authoriz/i);
  assert.equal(launched.length, 0);
});

test('model-facing discovery cannot redirect reads to another project or global scope', async () => {
  const local = define('http-analyst'), foreignRoot = path.join(directory, 'other-project'); fs.mkdirSync(foreignRoot);
  define('foreign-only', { instructions: 'Unrelated private project instructions.' }, { cwd: foreignRoot });
  const context = beginRun(), host = new ToolHost(parent, { event() {} }, context);
  await rejected(() => host.call('list_subagents', { cwd: foreignRoot, scope: 'global' }), /field|invalid|scope/i);
  const discovered = await host.call('list_subagents', {});
  assert.ok(discovered.subagents.some(item => item.name === local.name));
  assert.equal(discovered.subagents.some(item => item.name === 'foreign-only'), false);
  const selected = await host.call('read_subagent', { name: local.name, cwd: foreignRoot, scope: 'global' });
  assert.equal(selected.id, local.id); assert.equal(selected.projectRoot, parent.cwd);
});

test('a no-op edit and reviewed revert can reuse the same content pin without rejecting a new invocation', async () => {
  const original = define('http-analyst'), unchanged = define('http-analyst', {}, { expectedRevision: original.revision });
  assert.equal(unchanged.version, original.version); assert.equal(unchanged.revision, 2);
  const changed = define('http-analyst', { instructions: 'Inspect a revised local baseline.' }, { expectedRevision: unchanged.revision });
  const reverted = define('http-analyst', {}, { expectedRevision: changed.revision });
  assert.equal(reverted.version, original.version); assert.equal(reverted.revision, 4);
  const result = await spawnSubagent(parent, input(), beginRun());
  assert.equal(result.subagentDefinition.version, original.version); assert.equal(result.subagentDefinition.revision, reverted.revision);
  assert.equal(launched.length, 1);
});

test('specialist concurrency is bounded independently of the number of saved definitions', async () => {
  for (let index = 0; index < 4; index++) define(`specialist-${index}`);
  const context = beginRun();
  for (let index = 0; index < 3; index++) await spawnSubagent(parent, input(`specialist-${index}`), context);
  await rejected(() => spawnSubagent(parent, input('specialist-3'), context), /concurren|limit|capacity/i);
  assert.equal(launched.length, 3); assert.equal(listRecords('assignment').length, 3);
});

test('follow-ups share the same concurrency reservation as fresh specialist invocations', async () => {
  for (let index = 0; index < 4; index++) define(`specialist-${index}`);
  const context = beginRun(), completed = [];
  for (let index = 0; index < 3; index++) {
    const result = await spawnSubagent(parent, input(`specialist-${index}`), context); finishOfflineRound(result.id); completed.push(result.id);
  }
  await spawnSubagent(parent, input('specialist-3'), context);
  const followup = index => followupSubagent(parent, completed[index], { requestId: `continue-${index}`, objective: 'Resolve the remaining local uncertainty.', feedback: 'Keep the original specialist boundary.' }, context);
  await followup(0); await followup(1);
  await rejected(() => followup(2), /concurren|limit|capacity/i);
  assert.equal(activeAssignmentsFor(parent).length, 3); assert.equal(launched.length, 6);
});

test('status and follow-ups enforce parent ownership and reuse the original specialist pin', async () => {
  const definition = define('http-analyst', { model: 'synthetic-original' });
  parent.contract = normalizeContract({}, 'Earlier paused owner goal'); parent.goal = newGoal(parent.contract.objective, 500);
  parent.goal.status = 'paused'; saveSession(parent); const originalGoal = structuredClone(parent.goal), context = beginRun();
  const result = await spawnSubagent(parent, input(), context); finishOfflineRound(result.id);
  define('http-analyst', { model: 'synthetic-revised' }, { expectedRevision: definition.revision });
  const stranger = createSession(getProvider('codex'), parent.cwd, 'synthetic-stranger');
  await rejected(() => subagentStatus(stranger, result.id), /another|belong|authoriz|unknown|not found/i);
  await rejected(() => followupSubagent(stranger, result.id, { requestId: 'foreign-followup', objective: 'Continue local work.', feedback: 'Inspect further.' }, context), /another|belong|authoriz|run|unknown|not found|live.*execution/i);
  const next = beginRun({ prompt: 'Follow up the same local inspection.' });
  appendEvent(parent.id, 'message.user', { text: 'Follow up the same local inspection in this ordinary chat.' });
  const followup = await followupSubagent(parent, result.id, { requestId: 'continue-once', objective: 'Explain the missing local baseline.', feedback: 'Keep uncertainty explicit.' }, next);
  assert.equal(followup.id, result.id); assert.equal(getRecord('assignment', result.id).currentRound, 2);
  assert.equal(getRecord('assignment', result.id).selection.model, 'synthetic-original');
  assert.equal(getRecord('assignment', result.id).subagentDefinition.version, definition.version);
  assert.equal(launched.length, 2);
  assert.ok(JSON.stringify(await listSubagentRuns(parent)).includes(result.id));
  assert.deepEqual(loadSession(parent.id).goal, originalGoal);
  finishOfflineRound(result.id); parent.contract.scope = { allowedActions: ['read'] }; saveSession(parent);
  await rejected(() => followupSubagent(parent, result.id, { requestId: 'changed-scope-followup', objective: 'Continue.', feedback: 'Continue under changed scope.' }, beginRun()), /source|mission|changed|scope|instructions/i);
  assert.equal(launched.length, 2, 'a changed task boundary cannot reuse the earlier mission');
});

for (const disposition of ['answered', 'declined']) {
  test(`a later chat turn can explicitly resolve a specialist context request as ${disposition} without restarting work`, async () => {
    define('http-analyst');
    parent.contract = normalizeContract({}, 'Earlier paused owner goal'); parent.goal = newGoal(parent.contract.objective, 500);
    parent.goal.status = 'paused'; saveSession(parent); const originalGoal = structuredClone(parent.goal);
    const earlier = beginRun({ prompt: 'Inspect the supplied local baseline.' }), result = await spawnSubagent(parent, input(), earlier);
    const job = getRecord('assignment', result.id), worker = createSession(getProvider('codex'), parent.cwd, 'synthetic-worker');
    Object.assign(worker, { role: 'executor', parentSessionId: parent.id, assignmentId: job.id, assignmentRound: 1,
      contract: job.contract, policy: job.contract.policy, missionContext: job.missionContext }); saveSession(worker);
    putRecord('assignment', job.id, { ...job, workerSessionId: worker.id });
    putRecord('round', `${job.id}:1`, { ...getRecord('round', `${job.id}:1`), state: 'running', runner: processIdentity() });
    const request = recordWorkerReport(worker, { status: 'needs_context', requestId: 'missing-local-baseline', summary: 'The supplied fixture does not identify the comparison baseline.', evidence: [],
      questions: [{ id: 'baseline', question: 'Which supplied local observation is the authorized baseline?' }] }).contextRequest;
    const report = getRecord('worker-report', worker.id), round = { ...getRecord('round', `${job.id}:1`), state: 'needs_context',
      workerClaim: 'needs_context', report, contextRequest: request, artifacts: [], changes: [], finishedAt: now() };
    putRecord('round', `${job.id}:1`, round); putRecord('assignment', job.id, { ...getRecord('assignment', job.id), latestReport: round });
    worker.executionState = 'paused'; worker.stopReason = 'needs_context'; saveSession(worker);
    putRecord('run', parent.id, { ...getRecord('run', parent.id), state: 'idle' }); parent.executionState = 'idle'; saveSession(parent);
    const current = beginRun({ prompt: 'Resolve the saved specialist question without resuming its work.' });
    appendEvent(parent.id, 'message.user', { text: 'Resolve the saved specialist question in this new ordinary chat turn.' });
    assert.notEqual(current.runId, earlier.runId);
    const host = new ToolHost(parent, { event() {} }, current), answer = { id: job.id, requestId: `resolve-${disposition}`,
      contextRequestId: request.id, expectedContextRevision: request.revision,
      ...(disposition === 'declined' ? { contextDisposition: 'declined', contextRationale: 'The baseline is unavailable; retain the result as inconclusive.' }
        : { contextAnswers: [{ questionId: 'baseline', text: 'Use the supplied owner observation as the local baseline.', evidence: [] }] }) };
    const saved = await host.call('answer_assignment_context', answer);
    assert.equal(saved.state, disposition); assert.deepEqual(await host.call('answer_assignment_context', answer), saved);
    assert.equal(getRecord('assignment', job.id).currentRound, 1); assert.equal(getRecord('round', `${job.id}:1`).state, 'needs_context');
    assert.equal(launched.length, 1); assert.equal(listRecords('execution').length, 0);
    if (disposition === 'declined') {
      await rejected(() => host.call('review_assignment', { id: job.id, outcome: 'accepted', rationale: 'A missing baseline cannot prove the claim.', evidence: [] }), /declined|cannot be accepted/i);
      await host.call('review_assignment', { id: job.id, outcome: 'inconclusive', rationale: 'The required comparison baseline was explicitly unavailable.' });
      assert.equal(getRecord('assignment', job.id).closure, 'inconclusive');
    }
    assert.deepEqual(loadSession(parent.id).goal, originalGoal); assert.equal(loadSession(worker.id).executionState, 'paused');
  });
}

test('a changed immutable mission brief cannot authorize a follow-up or a forged completion', async () => {
  define('http-analyst'); const context = beginRun(), result = await spawnSubagent(parent, input(), context);
  finishOfflineRound(result.id);
  const job = getRecord('assignment', result.id); job.missionContext.brief.instructions = 'Forged source instructions.'; putRecord('assignment', job.id, job);
  await rejected(() => followupSubagent(parent, result.id, { requestId: 'tampered-followup', objective: 'Continue.', feedback: 'Continue.' }, context), /mission|integrity|changed|source|context/i);
  assert.equal(launched.length, 1);
});

test('goal subagents reserve only the remaining parent budget and never report parent completion', async () => {
  define('http-analyst', { limits: { tokenBudget: 1500 } }); define('code-reviewer', { limits: { tokenBudget: 1500 } });
  parent.contract = normalizeContract({ context: 'Offline goal instructions.', limits: { concurrency: 3 } }, 'Inspect both local baselines');
  parent.policy = parent.contract.policy; parent.goal = newGoal(parent.contract.objective, 2000); saveSession(parent);
  const context = beginRun({ goalMode: true }), original = structuredClone(parent.goal);
  await spawnSubagent(parent, input(), context);
  try { await spawnSubagent(parent, input('code-reviewer'), context); } catch (error) { assert.match(error.message, /budget|token|limit|reserv/i); }
  const jobs = listRecords('assignment');
  assert.ok(jobs.length > 0); assert.ok(jobs.reduce((sum, job) => sum + (job.contract.limits.tokenBudget || 0), 0) <= 2000);
  assert.ok(jobs.every(job => job.goalId === parent.goal.id));
  assert.deepEqual(loadSession(parent.id).goal, original);
});

test('solo goal completion waits for named specialist review even when the model requirement already passes', async () => {
  define('http-analyst');
  parent.contract = normalizeContract({}, 'Inspect the supplied offline observation'); parent.policy = parent.contract.policy;
  parent.goal = newGoal(parent.contract.objective, 1000); saveSession(parent);
  const context = beginRun({ goalMode: true });
  assert.equal((await assessCompletion(parent)).passed, true, 'the independent model-judgment baseline is satisfied');
  const result = await spawnSubagent(parent, input(), context), pending = await assessCompletion(parent);
  assert.equal(pending.passed, false); assert.deepEqual(pending.openAssignments, [result.id]);
  finishOfflineRound(result.id);
  assert.equal((await assessCompletion(parent)).passed, false, 'a returned claim still needs supervisor review');
  reviewAssignment(parent, result.id, { outcome: 'abandoned', rationale: 'The bounded offline result is not needed for this already assessed objective.' });
  assert.equal((await assessCompletion(parent)).passed, true); assert.equal(parent.mode, 'solo');
});

test('resuming a retained goal excludes later chat specialists from goal acceptance and usage', async () => {
  define('http-analyst');
  parent.contract = normalizeContract({}, 'Earlier saved goal'); parent.policy = parent.contract.policy;
  parent.goal = newGoal(parent.contract.objective, 1000); parent.goal.status = 'paused';
  parent.goal.nativeTokensUsed = 40; parent.goal.tokensUsed = 40; parent.usage = { tokens: 40, available: true }; saveSession(parent);
  const originalGoalId = parent.goal.id;
  const result = await spawnSubagent(parent, input(), beginRun({ prompt: 'A later unrelated offline chat task.' }));
  finishOfflineRound(result.id);
  const chatJob = getRecord('assignment', result.id);
  chatJob.latestReport.usage = { tokens: 123, available: true }; putRecord('assignment', chatJob.id, chatJob);
  assert.equal(chatJob.goalId, null); assert.equal(chatJob.sourceGoalId, originalGoalId); assert.equal(chatJob.closure, 'open');
  assert.equal(delegationUsage({ ...parent, goal: null }).delegatedTokens, 123, 'chat usage retains its specialist history');
  parent.goal.status = 'active'; saveSession(parent); beginRun({ goalMode: true });
  assert.equal(assignmentsFor(parent).some(job => job.id === chatJob.id), false);
  assert.equal(delegationUsage(parent).delegatedTokens, 0); assert.equal(budgetUsage(parent), 40);
  const acceptance = await assessCompletion(parent);
  assert.equal(acceptance.passed, true); assert.deepEqual(acceptance.openAssignments, []);
  assert.equal(loadSession(parent.id).goal.id, originalGoalId); assert.equal(getRecord('assignment', chatJob.id).closure, 'open');
});

test('reported worker usage and outstanding reservations constrain later spawns and follow-ups together', async () => {
  define('http-analyst', { limits: { tokenBudget: 800 } });
  parent.contract = normalizeContract({ limits: { concurrency: 3 } }, 'Inspect the supplied offline baseline');
  parent.policy = parent.contract.policy; parent.goal = newGoal(parent.contract.objective, 1000); saveSession(parent);
  const context = beginRun({ goalMode: true });
  const first = await spawnSubagent(parent, input(), context);
  const second = await spawnSubagent(parent, input('http-analyst', { requestId: 'second-budget-reservation' }), context);
  assert.equal(getRecord('assignment', first.id).contract.limits.tokenBudget, 800);
  assert.equal(getRecord('assignment', second.id).contract.limits.tokenBudget, 200);
  finishOfflineRound(first.id);
  const finished = getRecord('assignment', first.id); finished.latestReport.usage = { tokens: 600, available: true }; putRecord('assignment', first.id, finished);
  const third = await spawnSubagent(parent, input('http-analyst', { requestId: 'third-budget-reservation' }), context);
  assert.equal(getRecord('assignment', third.id).contract.limits.tokenBudget, 200);
  await rejected(() => followupSubagent(parent, first.id, { requestId: 'over-budget-followup', objective: 'Continue local inspection.', feedback: 'Resolve uncertainty.' }, context), /budget|reserv|token/i);
  const reserved = activeAssignmentsFor(parent).reduce((sum, item) => { const job = getRecord('assignment', item.id); return sum + job.contract.limits.tokenBudget - (currentAssignmentUsage(job).tokens || 0); }, 0);
  assert.ok(budgetUsage(parent) + reserved <= 1000); assert.equal(launched.length, 3);
});

test('a specialist that spent its cumulative runtime cannot obtain another execution through a follow-up', async () => {
  define('http-analyst', { limits: { runtimeSeconds: 10 } });
  const context = beginRun(), result = await spawnSubagent(parent, input(), context); finishOfflineRound(result.id);
  const finished = getRecord('assignment', result.id);
  finished.latestReport.usage = { tokens: 10, available: true, elapsedSeconds: 10 }; putRecord('assignment', result.id, finished);
  await rejected(() => followupSubagent(parent, result.id, { requestId: 'spent-runtime', objective: 'Do another local pass.', feedback: 'Continue.' }, context), /runtime|time.*budget|exhausted/i);
  assert.equal(launched.length, 1); assert.equal(getRecord('assignment', result.id).currentRound, 1);
});

test('shared assignment controls cannot continue a legacy Delegate worker from ordinary chat or solo mode', async () => {
  const keys = ['BZZY_CODEX_BIN', 'BZZY_CODEX_HOME'], previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    process.env.BZZY_CODEX_BIN = path.join(directory, 'no-native-provider'); process.env.BZZY_CODEX_HOME = path.join(directory, 'offline-auth');
    parent.mode = 'delegate'; parent.executor = { provider: 'codex', model: 'synthetic-hands' };
    parent.contract = normalizeContract({}, 'Original Delegate objective'); parent.policy = parent.contract.policy;
    parent.goal = newGoal(parent.contract.objective, 1000); saveSession(parent); beginRun({ goalMode: true });
    const result = startAssignment(parent, { requestId: 'legacy-assignment', objective: 'Inspect the local fixture.', context: 'Offline task.', acceptanceCriteria: ['Retain uncertainty.'] }, { launch: noExecution });
    finishOfflineRound(result.id);
    const followup = { id: result.id, requestId: 'legacy-chat-followup', objective: 'Continue the bounded fixture inspection.', feedback: 'Inspect further.', waitSeconds: 0 };
    const ordinary = new ToolHost(parent, { event() {} }, beginRun());
    assert.ok(taskTools(parent, { goalMode: false }).some(tool => tool.name === 'followup_assignment'));
    await rejected(() => ordinary.call('followup_assignment', followup), /explicit Delegate goal/i);
    parent.mode = 'solo'; saveSession(parent);
    const solo = new ToolHost(parent, { event() {} }, beginRun({ goalMode: true }));
    await rejected(() => solo.call('followup_assignment', { ...followup, requestId: 'legacy-solo-followup' }), /explicit Delegate goal/i);
    assert.equal(launched.length, 1); assert.equal(getRecord('assignment', result.id).currentRound, 1);
  } finally {
    for (const key of keys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
  }
});

test('worker roles have no recursive Core subagent tools and cancellation remains durable', async () => {
  define('http-analyst'); const context = beginRun(), result = await spawnSubagent(parent, input(), context);
  const worker = createSession(getProvider('codex'), parent.cwd, 'synthetic-worker');
  worker.role = 'executor'; worker.parentSessionId = parent.id; worker.assignmentId = result.id; worker.policy = parent.policy; saveSession(worker);
  assert.equal(taskTools(worker).some(tool => ['spawn_subagent', 'delegate'].includes(tool.name)), false);
  await rejected(() => new ToolHost(worker, { event() {} }, context).call('spawn_subagent', input()), /authoriz|worker|recursive|subagent/i);
  await rejected(() => spawnSubagent(worker, input(), context), /worker|recursive|subagent|run|parent/i);
  cancelAssignment(parent.id, result.id, 'Parent paused this offline invocation.');
  const cancellation = getRecord('assignment-control', result.id);
  assert.equal(cancellation.action, 'cancel'); assert.equal(cancellation.round, 1);
  assert.equal(assignmentStatus(result.id).id, result.id); assert.equal(launched.length, 1);
});

test('Claude specialist workers disable native Agent and Task spawning while retaining bounded Core reporting', () => {
  const definition = define('http-analyst'), worker = createSession(getProvider('claude'), parent.cwd, 'synthetic-claude');
  Object.assign(worker, { role: 'executor', parentSessionId: parent.id, subagentDefinition: definition, policy: parent.policy }); saveSession(worker);
  const args = claudeArgs(worker, { scopedAutonomy: true, policy: worker.policy }, '/offline/core-mcp.json');
  const blocked = args.indexOf('--disallowedTools'); assert.ok(blocked >= 0);
  assert.deepEqual(args.slice(blocked + 1, blocked + 3), ['Agent', 'Task']);
  assert.ok(args.includes('mcp__bzzy_goal__finish_assignment')); assert.equal(args.includes('mcp__bzzy_goal__spawn_subagent'), false);
});

test('orphan recovery reports interruption without replay and explicit continuation retains the specialist pin', async () => {
  const definition = define('http-analyst'), context = beginRun(), result = await spawnSubagent(parent, input(), context);
  const round = getRecord('round', `${result.id}:1`);
  putRecord('round', `${result.id}:1`, { ...round, createdAt: new Date(Date.now() - 60000).toISOString(), launcher: null });
  const recovered = await subagentStatus(parent, result.id);
  assert.equal(recovered.round.state, 'interrupted'); assert.equal(launched.length, 1);
  await listSubagentRuns(parent); assert.equal(launched.length, 1, 'reading recovered state never restarts work');
  const resumed = await followupSubagent(parent, result.id, { requestId: 'reviewed-recovery', objective: 'Reinspect the local baseline.', feedback: 'Continue only the missing work after inspecting retained context.' }, beginRun());
  assert.equal(resumed.id, result.id); assert.equal(getRecord('assignment', resumed.id).currentRound, 2);
  assert.equal(getRecord('assignment', resumed.id).subagentDefinition.version, definition.version); assert.equal(launched.length, 2);
});

test('a real offline provider worker receives its specialist instructions, returns evidence and leaves the saved parent goal paused', { timeout: 20000 }, async () => {
  const keys = ['BZZY_CODEX_BIN', 'BZZY_CODEX_HOME'], previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const fixture = path.join(directory, 'offline-subagent.mjs'), auth = path.join(directory, 'fixture-auth');
  fs.mkdirSync(auth, { mode: 0o700 }); fs.writeFileSync(path.join(auth, 'auth.json'), '{}', { mode: 0o600 });
  fs.writeFileSync(fixture, `#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
if (process.argv.includes('--version')) { console.log('codex-cli 0.163.0 (offline subagent fixture)'); process.exit(0); }
if (process.argv.includes('login')) { console.log('Logged in using ChatGPT'); process.exit(0); }
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const notify = (method, params) => send({ method, params: { threadId: 'offline-specialist', ...params } });
fs.writeFileSync(path.join(process.env.CODEX_HOME, 'worker-launch.json'), JSON.stringify({ pid: process.pid, cwd: process.cwd(), args: process.argv.slice(2) }));
for await (const line of readline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  fs.appendFileSync(path.join(process.env.CODEX_HOME, 'worker-calls.jsonl'), JSON.stringify(request) + '\\n');
  if (request.id === 901 && !request.method) {
    if (!request.result?.success) process.exit(12);
    notify('thread/tokenUsage/updated', { tokenUsage: { total: { totalTokens: 37 } } });
    notify('item/agentMessage/delta', { itemId: 'reply', delta: 'The offline specialist inspected its local baseline.' });
    notify('turn/completed', { turn: { id: 'turn', status: 'completed' } });
    continue;
  }
  if (!request.method) continue;
  const result = ['thread/start', 'thread/resume'].includes(request.method) ? { thread: { id: 'offline-specialist' } }
    : request.method === 'turn/start' ? { turn: { id: 'turn' } } : {};
  if (request.id !== undefined) send({ id: request.id, result });
  if (request.method === 'turn/start') setTimeout(() => {
    notify('turn/started', { turn: { id: 'turn' } });
    fs.writeFileSync('specialist-observation.txt', 'Local baseline retained.');
    send({ id: 901, method: 'item/tool/call', params: { threadId: 'offline-specialist', turnId: 'turn', callId: 'finish', tool: 'finish_assignment',
      arguments: { status: 'complete', summary: 'The local baseline was inspected; parent acceptance remains separate.', evidence: [] } } });
  }, 10);
}
`, { mode: 0o700 });
  let worker;
  try {
    process.env.BZZY_CODEX_BIN = fixture; process.env.BZZY_CODEX_HOME = auth;
    define('http-analyst', { model: 'synthetic-http', instructions: 'SPECIALIST PIN: compare the local baseline and retain uncertainty.' });
    parent.contract = normalizeContract({}, 'Earlier paused goal'); parent.goal = newGoal(parent.contract.objective, 500);
    parent.goal.status = 'paused'; saveSession(parent);
    const original = structuredClone(parent.goal), context = beginRun({ prompt: 'CURRENT CHAT MISSION: inspect the supplied local baseline.' });
    const result = await spawnSubagent(parent, input(), context);
    await runAssignment(result.id, 1);
    const completed = assignmentStatus(result.id); worker = loadSession(completed.workerSessionId);
    assert.equal(completed.round.state, 'awaiting_review', completed.round.error);
    assert.equal(completed.round.workerClaim, 'complete'); assert.equal(completed.closure, 'open');
    assert.equal(worker.executionState, 'idle'); assert.equal(worker.usage.tokens, 37);
    assert.notEqual(worker.cwd, parent.cwd); assert.equal(fs.existsSync(path.join(parent.cwd, 'specialist-observation.txt')), false);
    assert.equal(fs.readFileSync(path.join(worker.cwd, 'specialist-observation.txt'), 'utf8'), 'Local baseline retained.');
    assert.deepEqual(loadSession(parent.id).goal, original); assert.equal(loadSession(parent.id).executionState, 'running');
    const calls = fs.readFileSync(path.join(auth, 'worker-calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    const started = calls.find(call => call.method === 'thread/start'), turn = calls.find(call => call.method === 'turn/start');
    assert.equal(started.params.model, 'synthetic-http'); assert.match(JSON.stringify([started.params, turn.params]), /SPECIALIST PIN/);
    assert.match(JSON.stringify(turn.params), /CURRENT CHAT MISSION/);
    assert.equal(started.params.dynamicTools.some(tool => ['spawn_subagent', 'delegate'].includes(tool.name)), false);
    const launch = JSON.parse(fs.readFileSync(path.join(auth, 'worker-launch.json'), 'utf8'));
    for (const setting of ['agents.max_threads=1', 'agents.enabled=false', 'features.multi_agent=false', 'features.multi_agent_v2=false']) assert.ok(launch.args.includes(setting), setting);
    assert.equal(identityAlive(processIdentity(launch.pid)), false);
  } finally {
    if (worker?.backendProcess && identityAlive(worker.backendProcess)) signalProcess(worker.backendProcess, 'SIGKILL', { group: true });
    for (const key of keys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
  }
});

test('ordinary provider chat can call spawn_subagent and ending the parent run durably stops its unfinished worker', { timeout: 20000 }, async () => {
  const keys = ['BZZY_CODEX_BIN', 'BZZY_CODEX_HOME'], previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const fixture = path.join(directory, 'parent-subagent.mjs'), auth = path.join(directory, 'fixture-auth');
  fs.mkdirSync(auth, { mode: 0o700 }); fs.writeFileSync(path.join(auth, 'auth.json'), '{}', { mode: 0o600 });
  fs.writeFileSync(fixture, `#!${process.execPath}
import path from 'node:path';
import readline from 'node:readline';
if (process.argv.includes('--version')) { console.log('codex-cli 0.163.0 (offline parent fixture)'); process.exit(0); }
if (process.argv.includes('login')) { console.log('Logged in using ChatGPT'); process.exit(0); }
const parent = path.basename(process.cwd()) === 'project', threadId = parent ? 'parent-thread' : 'worker-thread';
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const notify = (method, params) => send({ method, params: { threadId, ...params } });
for await (const line of readline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.id === 902 && !request.method) {
    if (!request.result?.success) { console.error(JSON.stringify(request.result)); process.exit(12); }
    notify('item/agentMessage/delta', { itemId: 'reply', delta: 'Worker started; this parent turn is ending.' });
    notify('turn/completed', { turn: { id: 'turn', status: 'completed' } }); continue;
  }
  if (!request.method) continue;
  const result = ['thread/start', 'thread/resume'].includes(request.method) ? { thread: { id: threadId } }
    : request.method === 'turn/start' ? { turn: { id: 'turn' } } : {};
  if (request.id !== undefined) send({ id: request.id, result });
  if (request.method === 'turn/start') setTimeout(() => {
    notify('turn/started', { turn: { id: 'turn' } });
    if (parent) send({ id: 902, method: 'item/tool/call', params: { threadId, turnId: 'turn', callId: 'spawn', tool: 'spawn_subagent',
      arguments: { name: 'http-analyst', requestId: 'parent-worker', objective: 'Inspect the offline baseline.', waitSeconds: 0 } } });
  }, 10);
  if (request.method === 'turn/interrupt') notify('turn/completed', { turn: { id: 'turn', status: 'interrupted' } });
}
`, { mode: 0o700 });
  try {
    process.env.BZZY_CODEX_BIN = fixture; process.env.BZZY_CODEX_HOME = auth;
    define('http-analyst', { limits: { runtimeSeconds: 10 } });
    parent.contract = normalizeContract({}, 'An earlier paused goal'); parent.goal = newGoal(parent.contract.objective, 500);
    parent.goal.status = 'paused'; saveSession(parent); const originalGoal = structuredClone(parent.goal);
    const ui = { interactive: false, json: true, event() {}, newline() {}, async ask() { return ''; }, async approve() { return false; } };
    const code = await runSession(getProvider('codex'), parent, { pet: false }, ui, 'Inspect this offline baseline using the saved specialist.');
    assert.equal(code, 0);
    const jobs = listRecords('assignment', { parentSessionId: parent.id }); assert.equal(jobs.length, 1);
    const job = assignmentStatus(jobs[0].id);
    assert.equal(job.subagentDefinition.name, 'http-analyst'); assert.equal(job.goalId, null);
    assert.equal(getRecord('assignment-control', job.id).action, 'cancel');
    assert.equal(['starting', 'running'].includes(job.round.state), false, JSON.stringify(job.round));
    assert.equal(loadSession(parent.id).executionState, 'idle'); assert.deepEqual(loadSession(parent.id).goal, originalGoal);
  } finally {
    for (const key of keys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
  }
});
