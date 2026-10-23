import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSession, saveSession } from '../src/store.js';
import { BUILTINS } from '../src/providers.js';
import { normalizeContract } from '../src/contracts.js';
import { newGoal } from '../src/goals.js';
import { now, putRecord, getRecord, reserveRequest } from '../src/database.js';
import { snapshotWorkspace, inspectWorkspace, captureEvidence } from '../src/evidence.js';
import { startAssignment, assignmentStatus, followupAssignment, cancelAssignment, reviewAssignment, applyAssignment } from '../src/delegation.js';
import { assignmentsFor, delegationUsage, budgetUsage } from '../src/delegation-usage.js';
import { processIdentity } from '../src/recovery.js';
import { assessCompletion, assessRequirement } from '../src/verification.js';
import { ClaudeEngine } from '../src/engines/claude.js';
import { runSession } from '../src/controller.js';
import { fileURLToPath } from 'node:url';

let directory, saved;
test.beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-delegation-'));
  saved = { BZZY_HOME: process.env.BZZY_HOME, BZZY_CODEX_BIN: process.env.BZZY_CODEX_BIN };
  process.env.BZZY_HOME = path.join(directory, 'private'); process.env.BZZY_CODEX_BIN = '/bin/false';
});
test.afterEach(() => {
  for (const [key, value] of Object.entries(saved)) if (value == null) delete process.env[key]; else process.env[key] = value;
  fs.rmSync(directory, { recursive: true, force: true });
});
function parent(limits = {}) {
  const project = path.join(directory, 'project'); fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'source.txt'), 'original');
  const session = createSession(BUILTINS.codex, project);
  session.mode = 'delegate'; session.executor = { provider: 'deepseek', model: 'deepseek-chat' };
  session.contract = normalizeContract({ limits }, 'Assess the supplied local challenge'); session.policy = session.contract.policy;
  session.goal = newGoal(session.contract.objective); session.usage = { tokens: 10, available: true }; session.goal.nativeTokensUsed = 10; saveSession(session);
  return session;
}
function jobFor(session, extra = {}) {
  const id = randomUUID(), job = { id, parentSessionId: session.id, goalId: session.goal.id, selection: session.executor,
    role: 'executor', closure: 'open', currentRound: 1, createdAt: now(), contract: normalizeContract({ limits: {} }, 'Inspect one bounded input'), ...extra };
  putRecord('assignment', id, job); putRecord('round', `${id}:1`, { number: 1, state: 'awaiting_review', ...extra.round }); return job;
}
function reviewable(session) {
  const snapshot = snapshotWorkspace(session), work = path.join(directory, 'worker'); fs.cpSync(snapshot.directory, work, { recursive: true });
  fs.writeFileSync(path.join(work, 'result.txt'), 'reviewed content');
  const worker = createSession(BUILTINS.codex, work); worker.role = 'executor'; saveSession(worker);
  const evidence = captureEvidence(worker, 'result.txt');
  const job = jobFor(session, { workspace: work, snapshotId: snapshot.id, workerSessionId: worker.id,
    latestReport: { round: 1, changes: inspectWorkspace(snapshot, work), usage: { tokens: 20, available: true } } });
  putRecord('artifact-read', randomUUID(), { sessionId: session.id, assignmentId: job.id, artifactId: evidence.id });
  return { job, worker, evidence };
}

test('assignment totals and completion are scoped to the current objective, including live worker tokens', async () => {
  const session = parent(), oldGoal = session.goal;
  jobFor(session, { latestReport: { usage: { tokens: 90, available: true } } });
  session.goal = newGoal('Inspect a different local challenge'); session.goal.createdAt = new Date(Date.now() + 1).toISOString(); saveSession(session);
  assert.equal(assignmentsFor(session).length, 0);
  const worker = createSession(BUILTINS.codex, session.cwd); worker.usage = { tokens: 31, available: true }; saveSession(worker);
  const current = jobFor(session, { workerSessionId: worker.id, latestReport: { usage: { tokens: 12, available: true } } });
  assert.equal(delegationUsage(session).delegatedTokens, 31); assert.equal(budgetUsage(session), 31);
  putRecord('assignment', current.id, { ...current, closure: 'accepted' });
  assert.equal((await assessCompletion(session)).passed, true, 'an unresolved older goal cannot prevent the new objective completing');
  assert.notEqual(oldGoal.id, session.goal.id);
});

test('a retry of the same follow-up returns its original round after the worker finishes', () => {
  const session = parent({ maxRetries: 1 }), job = jobFor(session, { currentRound: 2 });
  putRecord('round', `${job.id}:2`, { state: 'awaiting_review', number: 2 });
  const input = { requestId: 'followup-once', objective: 'Check a negative control', feedback: 'Return a control comparison' };
  reserveRequest(`followup:${job.id}`, input.requestId, input, () => ({ id: job.id, round: 2 }));
  assert.deepEqual(followupAssignment(session, job.id, input), { id: job.id, round: 2 });
  assert.equal(getRecord('assignment', job.id).currentRound, 2);
});

test('cancellation names one round so a later follow-up is not poisoned', () => {
  const session = parent(), job = jobFor(session);
  putRecord('round', `${job.id}:1`, { state: 'running', runner: processIdentity(), number: 1 });
  assert.equal(cancelAssignment(session.id, job.id).round, 1);
  const control = getRecord('assignment-control', job.id); assert.equal(control.round, 1);
  putRecord('round', `${job.id}:1`, { state: 'cancelled', number: 1 });
  const next = followupAssignment(session, job.id, { requestId: 'retry-after-cancel', objective: 'Inspect a smaller case', feedback: 'Use the retained evidence' });
  assert.equal(next.round, 2); assert.notEqual(control.round, next.round);
  // The detached launcher must not invoke even a fake provider after this unit test ends.
  putRecord('round', `${job.id}:2`, { state: 'cancelled', number: 2 });
});

test('abandoned launch reservations become recoverable rather than occupying concurrency forever', () => {
  const session = parent(), job = jobFor(session);
  putRecord('round', `${job.id}:1`, { state: 'starting', createdAt: new Date(Date.now() - 60000).toISOString() });
  assert.equal(assignmentStatus(job.id).round.state, 'interrupted');
});

test('applying accepted work rejects bytes changed after the reviewed report', () => {
  const session = parent(), { job, evidence } = reviewable(session);
  reviewAssignment(session, job.id, { outcome: 'accepted', rationale: 'Inspected the output file', evidence: [evidence.id] });
  fs.writeFileSync(path.join(job.workspace, 'result.txt'), 'unreviewed replacement');
  assert.throws(() => applyAssignment(session, job.id), /changed after supervisor review/);
  assert.equal(fs.existsSync(path.join(session.cwd, 'result.txt')), false);
});

test('accepted patch application is idempotent and resumes a journaled partial apply without overwriting a conflict', () => {
  const session = parent(), { job, evidence } = reviewable(session);
  const review = reviewAssignment(session, job.id, { outcome: 'accepted', rationale: 'Inspected immutable output', evidence: [evidence.id] });
  fs.copyFileSync(path.join(job.workspace, 'result.txt'), path.join(session.cwd, 'result.txt'));
  putRecord('assignment-apply', job.id, { patchSha256: review.patch.sha256, paths: { 'result.txt': { state: 'planned' } } });
  assert.deepEqual(applyAssignment(session, job.id).applied, ['result.txt']);
  assert.equal(applyAssignment(session, job.id).alreadyApplied, true);
  fs.writeFileSync(path.join(session.cwd, 'result.txt'), 'a later user change');
  assert.throws(() => applyAssignment(session, job.id), /Workspace changed/);
});

test('new assignments have explicit-only count limits and current-goal idempotency keys', () => {
  const session = parent({ maxAssignments: 1 });
  jobFor(session, { goalId: randomUUID(), closure: 'accepted' });
  const input = { requestId: 'bounded-work', objective: 'Inspect one file', context: 'Only the supplied file', acceptanceCriteria: ['Return the observation'] };
  const first = startAssignment(session, input); assert.equal(first.goalId, session.goal.id);
  putRecord('round', `${first.id}:1`, { state: 'cancelled', number: 1 });
  assert.equal(startAssignment(session, input).id, first.id, 'replaying a reservation does not consume the count again');
  session.goal = newGoal('A new assessment'); saveSession(session);
  const second = startAssignment(session, input); assert.notEqual(second.id, first.id);
  putRecord('round', `${second.id}:1`, { state: 'cancelled', number: 1 });
});

test('hours-long goals can exceed twenty assignments while telemetry remains bounded', () => {
  const session = parent();
  for (let index = 0; index < 40; index++) jobFor(session, { closure: 'accepted', latestReport: { usage: { tokens: 2, available: true } } });
  const usage = delegationUsage(session);
  assert.equal(usage.assignmentCount, 40); assert.equal(usage.delegatedTokens, 80); assert.equal(usage.agents.length, 32); assert.equal(usage.omittedAgents, 8);
  assert.equal(usage.providers[0].tokens, 80); assert.equal(usage.providers[0].assignments, 40);
  const next = startAssignment(session, { objective: 'Inspect the next case', context: 'A bounded local case', acceptanceCriteria: ['Return evidence'] });
  putRecord('round', `${next.id}:1`, { state: 'cancelled', number: 1 });
});

test('a new objective cannot reuse an earlier supervisor acceptance for the same criterion ID', async () => {
  const session = parent(); session.contract = normalizeContract({ acceptanceCriteria: [{ id: 'proof', description: 'Verify the supplied challenge' }] }, session.goal.objective);
  jobFor(session, { closure: 'accepted' });
  const evidence = captureEvidence(session, 'source.txt');
  assessRequirement(session, { id: 'proof', status: 'supported', rationale: 'Inspected this objective’s evidence', evidence: [evidence.id] });
  assert.equal((await assessCompletion(session)).passed, true);
  session.goal = newGoal('Assess a new challenge with the same criterion ID');
  assert.equal((await assessCompletion(session)).passed, false);
});

test('delegate completion requires current-goal executor work and brain review, including small lookups', async () => {
  const session = parent();
  let result = await assessCompletion(session);
  assert.equal(result.passed, false); assert.equal(result.requirements[0].passed, true);
  assert.equal(result.delegation.assignmentCount, 0); assert.match(result.delegation.reason, /Use delegate/);
  jobFor(session, { goalId: randomUUID(), closure: 'accepted' });
  result = await assessCompletion(session);
  assert.equal(result.delegation.assignmentCount, 0, 'an earlier goal’s assignment cannot satisfy delegation');
  const job = jobFor(session);
  result = await assessCompletion(session);
  assert.equal(result.passed, false); assert.equal(result.delegation.assignmentCount, 1); assert.equal(result.delegation.reviewedAssignments, 0);
  putRecord('assignment', job.id, { ...job, closure: 'accepted' });
  result = await assessCompletion(session);
  assert.equal(result.passed, true); assert.equal(result.delegation.reviewedAssignments, 1);
  putRecord('assignment', job.id, { ...job, closure: 'abandoned' });
  result = await assessCompletion(session);
  assert.equal(result.passed, true, 'a reviewed worker failure permits a verified brain takeover');
});

test('Claude worker tokens are recorded incrementally and enforce the assignment budget without double counting', async () => {
  const binary = path.join(directory, 'local-claude.mjs');
  fs.writeFileSync(binary, `#!${process.execPath}\nimport readline from 'node:readline';
const send = event => console.log(JSON.stringify(event));
if (process.argv.includes('auth')) { send({loggedIn:true,authMethod:'claude.ai'}); process.exit(0); }
readline.createInterface({input:process.stdin}).on('line', line => {
  const event=JSON.parse(line);
  if(event.type==='control_request') send({type:'control_response',response:{subtype:'success',request_id:event.request_id}});
  if(event.type==='user') {
    send({type:'assistant',message:{id:'message-1',content:[],usage:{input_tokens:20,output_tokens:5}}});
    setTimeout(()=>send({type:'result',subtype:'success',result:'done',usage:{input_tokens:20,output_tokens:5}}),500);
  }
});\n`, { mode: 0o700 });
  const previous = process.env.BZZY_CLAUDE_BIN; process.env.BZZY_CLAUDE_BIN = binary;
  try {
    const session = parent(); session.provider = 'claude'; session.backend = 'claude'; session.role = 'executor'; session.goal = null;
    session.usage = { tokens: 100, available: true }; saveSession(session);
    const events = [], engine = new ClaudeEngine(BUILTINS.claude, session, { tokenBudget: 120 }, { event: (type, data) => events.push({ type, data }), newline() {} });
    try {
      const result = await engine.run('Inspect the supplied case');
      assert.equal(result.interrupted, true); assert.equal(engine.stopReason, 'token_limit');
      assert.equal(session.usage.tokens, 125); assert.equal(events.find(event => event.type === 'usage.updated').data.tokens, 125);
    } finally { await engine.close(); }
  } finally { if (previous == null) delete process.env.BZZY_CLAUDE_BIN; else process.env.BZZY_CLAUDE_BIN = previous; }
});

test('a parent token limit observes active delegated usage before the worker report is final', async () => {
  const keys = ['BZZY_CODEX_BIN', 'BZZY_CODEX_HOME', 'BZZY_TEST_ADVANCED'], previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { BZZY_CODEX_BIN: fileURLToPath(new URL('fixtures/advanced-agent.mjs', import.meta.url)), BZZY_CODEX_HOME: path.join(directory, 'native'), BZZY_TEST_ADVANCED: 'slow' });
  try {
    const session = parent(); session.goal.tokenBudget = 20; saveSession(session);
    const worker = createSession(BUILTINS.codex, session.cwd); worker.usage = { tokens: 30, available: true }; saveSession(worker);
    jobFor(session, { workerSessionId: worker.id });
    const code = await runSession(BUILTINS.codex, session, { tokenBudget: 20, pet: false }, { interactive: false, json: true, event() {}, newline() {}, ask: async () => '', approve: async () => false }, 'Assess this case', { goal: true });
    assert.equal(code, 2); assert.equal(session.goal.status, 'budget_limited'); assert.equal(session.goal.reason, 'token_limit');
    assert.equal(session.summary.usage.delegatedTokens, 30); assert.ok(session.summary.usage.totalTokens >= 30);
  } finally { for (const [key, value] of Object.entries(previous)) if (value == null) delete process.env[key]; else process.env[key] = value; }
});
