import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getWorkerBudgetSettings, setWorkerBudgetSettings, applyWorkerBudgetSettingsToGoal, assignmentBudgetView, currentBudgetCapsule } from '../src/engine/worker-budget.js';
import { createSession, saveSession, loadSession } from '../src/engine/store.js';
import { getRecord, putRecord, listRecords, events } from '../src/engine/database.js';
import { getProvider } from '../src/engine/providers.js';
import { normalizeContract, normalizePolicy } from '../src/engine/contracts.js';
import { initializeProject } from '../src/engine/project.js';
import { newGoal } from '../src/engine/goals.js';
import { saveSubagentDefinition, setSubagentEnabled } from '../src/engine/subagent-definitions.js';
import { spawnSubagent, followupSubagent } from '../src/engine/subagents.js';
import { extendAssignmentBudget, assignmentStatus } from '../src/engine/delegation.js';
import { artifact } from '../src/engine/evidence.js';
import { ToolHost, taskTools } from '../src/engine/tools.js';
import { portableState, stripWorkflowAuthority } from '../src/engine/share-bundle-policy.js';
import { compactTaskState } from '../src/engine/recovery.js';
import { compactAssignmentStatus } from '../src/engine/assignment-views.js';

let directory, oldHome, parent, context, launched;
test.beforeEach(() => {
  oldHome = process.env.BZZY_HOME; directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-worker-budget-')));
  process.env.BZZY_HOME = path.join(directory, 'private'); const cwd = path.join(directory, 'project'); fs.mkdirSync(cwd);
  parent = createSession(getProvider('codex'), cwd, 'offline-model'); parent.policy = normalizePolicy(); parent.contract = normalizeContract({}, 'Inspect local evidence');
  parent.mode = 'solo'; parent.executionState = 'running'; parent.usage = { tokens: 0, available: true };
  initializeProject(parent); launched = [];
  context = { goalMode: true, runId: randomUUID(), launch: (id, round) => launched.push({ id, round }) };
  putRecord('run', parent.id, { id: context.runId, state: 'running', goalMode: true });
});
test.afterEach(() => {
  if (oldHome === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = oldHome;
  fs.rmSync(directory, { recursive: true, force: true });
});
function goal(limit = 100000, pin = true) {
  const policy = { ...getWorkerBudgetSettings(), initialTokenBudget: 1000, initialRuntimeSeconds: 60, maxTokenBudget: 5000, maxRuntimeSeconds: 600 };
  parent.goal = newGoal(parent.contract.objective, limit, pin ? { workerBudgetPolicy: policy } : {}); saveSession(parent); return policy;
}
function definition(extra = {}) {
  return saveSubagentDefinition({ name: 'evidence-analyst', description: 'Inspect authorized offline evidence.', instructions: 'Keep incomplete checks explicit.', ...extra }, { cwd: parent.cwd });
}
function spawn(extra = {}) {
  return spawnSubagent(parent, { name: 'evidence-analyst', requestId: randomUUID(), objective: 'Inspect the supplied local control.', ...extra }, context);
}
function worker(job, tokens = 950, available = true) {
  const child = createSession(getProvider('codex'), parent.cwd, 'offline-worker');
  Object.assign(child, { parentSessionId: parent.id, role: 'executor', assignmentId: job.id, assignmentRound: 1,
    usage: { tokens, available, accountingComplete: available }, elapsedSeconds: 20, contract: job.contract, policy: parent.policy, projectRoot: parent.cwd }); saveSession(child);
  const report = { round: 1, state: 'budget_limited', workerClaim: 'partial', report: { status: 'partial', summary: 'Control inspected; further checks remain.', evidence: [] },
    usage: child.usage, artifacts: [], changes: [] };
  putRecord('assignment', job.id, { ...getRecord('assignment', job.id), workerSessionId: child.id, workspace: parent.cwd, latestReport: report });
  putRecord('round', `${job.id}:1`, { assignmentId: job.id, number: 1, ...report }); return child;
}
async function proof(child, text) {
  const item = artifact(child, text, 'offline-progress');
  await new ToolHost(parent, { event() {} }, context).call('read_artifact', { id: item.id }); return item.id;
}
const extension = (job, evidence, extra = {}) => ({ id: job.id, requestId: randomUUID(), expectedRevision: getRecord('assignment', job.id).workerBudget.revision,
  addTokens: 1000, progress: 'The inspected control narrows the remaining local checks.', evidence: [evidence], ...extra });

test('owner settings are revision checked, private, bounded and idle; existing goals need explicit adoption', () => {
  const initial = getWorkerBudgetSettings(); assert.equal(initial.mode, 'adaptive'); assert.equal(initial.maxTokenBudget, null);
  const saved = setWorkerBudgetSettings({ mode: 'fixed', initialTokenBudget: 5000 }, { expectedRevision: 0 });
  assert.equal(saved.revision, 1); assert.equal(fs.statSync(path.join(process.env.BZZY_HOME, 'config.json')).mode & 0o777, 0o600);
  assert.throws(() => setWorkerBudgetSettings({ mode: 'adaptive' }, { expectedRevision: 0 }), { code: 'WORKER_BUDGET_STALE' });
  assert.throws(() => setWorkerBudgetSettings({ maxTokenBudget: 1000 }, { expectedRevision: 1 }), { code: 'WORKER_BUDGET_INVALID' });
  goal(10000, false); const originalContract = structuredClone(parent.contract), originalGoal = structuredClone(parent.goal);
  assert.throws(() => applyWorkerBudgetSettingsToGoal(parent.id, { expectedGoalId: parent.goal.id, expectedRevision: 1 }), { code: 'WORKER_BUDGET_ACTIVE' });
  assert.deepEqual(loadSession(parent.id).goal, originalGoal);
  parent.executionState = 'paused'; parent.goal.status = 'paused'; saveSession(parent); putRecord('run', parent.id, { id: context.runId, state: 'paused' });
  const result = applyWorkerBudgetSettingsToGoal(parent.id, { expectedGoalId: parent.goal.id, expectedRevision: 1 });
  assert.equal(result.applied, true); const after = loadSession(parent.id);
  assert.equal(after.goal.workerBudgetPolicy.mode, 'fixed'); assert.equal(after.goal.tokenBudget, 10000); assert.equal(after.goal.status, 'paused'); assert.deepEqual(after.contract, originalContract);
  assert.equal(listRecords('execution').length, 0); assert.equal(listRecords('assignment').length, 0);
  fs.writeFileSync(path.join(process.env.BZZY_HOME, 'config.json'), '{"password":"PRIVATE_PARSE_FRAGMENT",');
  assert.throws(() => getWorkerBudgetSettings(), error => error.code === 'WORKER_BUDGET_INVALID' && !error.message.includes('PRIVATE_PARSE_FRAGMENT'));
});

test('new adaptive allocations reserve review room; legacy goals and explicit definition limits keep their ceilings', () => {
  goal(2500); definition(); const jobs = [spawn(), spawn(), spawn()];
  assert.deepEqual(jobs.map(job => job.contract.limits.tokenBudget), [1000, 1000, 250]);
  assert.throws(() => spawn(), /concurrency|budget|reserv/);
  assert.equal(jobs[0].workerBudget.hardTokenLimit, 5000);
  assert.equal(jobs[2].workerBudget.reportReserveTokens, 50);
  const stored = getRecord('assignment', jobs[0].id); assert.equal(assignmentBudgetView(stored).mode, 'adaptive');
  // Saved legacy goals intentionally omit the new policy and retain fixed defaults.
  parent.goal = newGoal('Separate legacy goal', 100000); parent.contract = normalizeContract({}, parent.goal.objective); saveSession(parent);
  const legacy = spawn(); assert.equal(legacy.workerBudget.mode, 'fixed'); assert.equal(legacy.contract.limits.tokenBudget, 20000);
});

test('reviewed progress extends one stopped investigation idempotently and retains cumulative consumption across follow-up', async () => {
  goal(); definition(); const job = spawn(), child = worker(job), evidence = await proof(child, 'First observed control.');
  const request = extension(job, evidence, { addSeconds: 60 });
  const before = structuredClone(getRecord('assignment', job.id)); const granted = extendAssignmentBudget(parent, job.id, request, context);
  assert.equal(granted.budget.tokenLimit, 2000); assert.equal(granted.budget.runtimeLimitSeconds, 120); assert.equal(granted.budget.tokensUsed, 950);
  assert.deepEqual(extendAssignmentBudget(parent, job.id, request, context), granted);
  assert.equal(events(parent.id, 0, 1000).filter(event => event.type === 'assignment.budget.extended').length, 1);
  const changed = getRecord('assignment', job.id); assert.deepEqual(changed.missionContext, before.missionContext); assert.deepEqual(changed.contract.policy, before.contract.policy);
  const continued = followupSubagent(parent, job.id, { requestId: 'continue-same-investigation', objective: 'Inspect the remaining local control.', feedback: 'Continue from the inspected first observation.' }, context);
  assert.equal(continued.round, 2); assert.equal(getRecord('assignment', job.id).workerSessionId, child.id);
  assert.equal(compactAssignmentStatus(assignmentStatus(job.id)).task, 'Inspect the remaining local control.');
  assert.equal(loadSession(child.id).usage.tokens, 950); assert.equal(listRecords('assignment').length, 1); assert.equal(launched.length, 2);
});

test('bounded live task previews preserve navigation with large quote-heavy assigned objectives', () => {
  goal(); definition();
  for (let index = 0; index < 3; index++) spawn({ objective: `Inspect local control ${index}: ` + '"'.repeat(1500) });
  const state = compactTaskState(parent, {}, context);
  assert.ok(Buffer.byteLength(JSON.stringify(state)) <= 8192);
  assert.equal(state.liveAgents.assignments.length, 3);
  for (const job of listRecords('assignment')) {
    const status = compactAssignmentStatus(assignmentStatus(job.id)); assert.ok(Buffer.byteLength(status.task) <= 600);
    assert.ok(status.task.startsWith('Inspect local control'));
  }
});

test('extensions cannot recycle evidence, cross owner ceilings, use unknown spending or inherit worker permissions', async () => {
  goal(); const def = definition(); const job = spawn(), child = worker(job, 200), a = await proof(child, 'Progress A'), b = await proof(child, 'Progress B');
  extendAssignmentBudget(parent, job.id, extension(job, a, { addTokens: 100 }), context);
  extendAssignmentBudget(parent, job.id, extension(job, b, { addTokens: 100 }), context);
  assert.throws(() => extendAssignmentBudget(parent, job.id, extension(job, a, { addTokens: 100 }), context), /new inspected progress/);
  const c = await proof(child, 'Progress C');
  const abort = new AbortController(); abort.abort();
  assert.throws(() => extendAssignmentBudget(parent, job.id, extension(job, c), { ...context, signal: abort.signal }), /execution stopped/);
  assert.throws(() => extendAssignmentBudget(parent, job.id, extension(job, c, { addTokens: 5000 }), context), /hard limit/);
  assert.throws(() => extendAssignmentBudget(child, job.id, extension(job, c), context), /supervisor|source|instructions/);
  const original = loadSession(child.id); original.usage.available = false; original.usage.accountingComplete = false; saveSession(original);
  const stored = getRecord('assignment', job.id); stored.latestReport.usage = original.usage; putRecord('assignment', job.id, stored);
  assert.throws(() => extendAssignmentBudget(parent, job.id, extension(job, c), context), /usage is unknown/);
  original.usage.available = true; original.usage.accountingComplete = true; saveSession(original); stored.latestReport.usage = original.usage; putRecord('assignment', job.id, stored);
  setSubagentEnabled(def.name, false, { expectedRevision: def.revision, cwd: parent.cwd });
  assert.throws(() => extendAssignmentBudget(parent, job.id, extension(job, c), context), /disabled|enabled|unavailable/);
  assert.ok(!taskTools(child).some(tool => tool.name === 'extend_assignment_budget'));
});

test('live budget polling leaves structural state stable and imported policies cannot authorize renewal', () => {
  goal(); definition(); const job = spawn(), child = worker(job, 300);
  const first = compactTaskState(parent, {}, context); child.usage.tokens = 400; saveSession(child);
  const second = compactTaskState(parent, { knownRevision: first.revision, contextGeneration: first.contextGeneration }, context);
  assert.equal(second.notModified, true); assert.equal(second.revision, first.revision); assert.equal(second.executionBudget.tokensUsed, 400);
  assert.equal(currentBudgetCapsule(child).budget.tokensUsed, 400);
  const changed = getRecord('assignment', job.id); changed.contract.limits.tokenBudget += 100; changed.workerBudget.revision++;
  putRecord('assignment', job.id, changed);
  assert.notEqual(compactTaskState(parent).revision, first.revision, 'An allocation change invalidates structural state without invalidating it on usage ticks');
  const payload = { goal: parent.goal, workerBudget: job.workerBudget, unchanged: 'portable behavior' };
  const shared = portableState({ records: [{ kind: 'session', id: parent.id, data: payload }], events: [] }).records[0].data;
  for (const result of [shared, stripWorkflowAuthority(payload)]) {
    assert.equal(result.goal.workerBudgetPolicy, undefined); assert.equal(result.workerBudget, undefined); assert.equal(result.unchanged, 'portable behavior');
  }
  const shape = assignmentBudgetView({ ...job, contract: { limits: { tokenBudget: '/private/SECRET_PATH' } }, workerBudget: { mode: '/private/SECRET_PATH' } });
  assert.ok(!JSON.stringify(shape).includes('SECRET_PATH'));
});

test('a later owner chat turn can extend a stopped exhausted worker without duplicating work or borrowing an active round', async () => {
  const policy = goal(); parent.goal = null; saveSession(parent);
  context = { ...context, goalMode: false };
  putRecord('run', parent.id, { id: context.runId, state: 'running', goalMode: false, workerBudgetPolicy: policy });
  definition(); const job = spawn(), child = worker(job, 1000), origin = job.chatRunId;
  context = { ...context, runId: randomUUID() };
  putRecord('run', parent.id, { id: context.runId, state: 'running', goalMode: false, workerBudgetPolicy: policy });
  const evidence = await proof(child, 'Progress retained from the original chat turn.');
  const request = extension(job, evidence), savedRound = getRecord('round', `${job.id}:1`);
  putRecord('round', `${job.id}:1`, { ...savedRound, state: 'running' });
  assert.throws(() => extendAssignmentBudget(parent, job.id, request, context), /valid stopped round/);
  assert.equal(getRecord('assignment', job.id).chatRunId, origin);
  putRecord('round', `${job.id}:1`, savedRound);
  assert.throws(() => extendAssignmentBudget(parent, job.id, { ...request, addTokens: 10000 }, context), /hard limit/);
  assert.equal(getRecord('assignment', job.id).chatRunId, origin);
  const granted = extendAssignmentBudget(parent, job.id, request, context);
  assert.equal(granted.budget.tokenLimit, 2000); assert.equal(granted.budget.tokensUsed, 1000);
  assert.equal(getRecord('assignment', job.id).chatRunId, context.runId);
  const next = followupSubagent(parent, job.id, { requestId: 'later-chat-followup', objective: 'Continue the unfinished local check.', feedback: 'Preserve the first turn’s evidence.' }, context);
  assert.equal(next.round, 2); assert.equal(getRecord('assignment', job.id).workerSessionId, child.id); assert.equal(listRecords('assignment').length, 1);
});
