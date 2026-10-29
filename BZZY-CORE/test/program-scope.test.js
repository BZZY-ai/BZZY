import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { database, getRecord, putRecord, listRecords, digest } from '../src/engine/database.js';
import { createSession, saveSession } from '../src/engine/store.js';
import { BUILTINS } from '../src/engine/providers.js';
import { initializeProject } from '../src/engine/project.js';
import { newGoal } from '../src/engine/goals.js';
import { normalizeContract } from '../src/engine/contracts.js';
import { enqueueExecution } from '../src/engine/execution-queue.js';
import { preflightGoalWorkflow, getGoalWorkflow, saveWorkflow, selectWorkflow } from '../src/engine/workflows.js';
import { createMissionContext } from '../src/engine/mission-context.js';
import { programScopeOperation, programScopeStatus, programScopeCapsule, preflightGoalScope,
  assertGoalScopeAdmission, assertScopeOperation, scopeForMission, programScopeCommandPolicy, assertProgramToolAdmission } from '../src/engine/program-scope.js';

let root, previous, session;
const current = () => getRecord('session', session.id);
const scope = (networkMode = 'offline') => ({ allowedTargets: ['test.invalid'], excludedTargets: ['https://test.invalid/private'],
  allowedActions: ['GET'], excludedActions: ['POST'], networkMode });
const operate = (operation, input = {}, requestId = randomUUID()) => programScopeOperation(operation,
  { reviewed: true, requestId, expectedRevision: programScopeStatus(current()).revision, ...input }, { session: current() });
function approve(networkMode = 'offline', additions = {}) {
  const { proposal } = operate('scope.propose', { scope: scope(networkMode), sources: [{ reference: 'fictional program rules', sha256: 'a'.repeat(64) }], ...additions });
  return operate('scope.approve', { proposalId: proposal.id }).approval;
}
const transition = approval => operate('scope.continue', { approvalId: approval.id, expectedGoalId: current().goal.id });
test.beforeEach(() => {
  previous = process.env.BZZY_HOME;
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-program-scope-')));
  process.env.BZZY_HOME = path.join(root, 'private');
  const cwd = path.join(root, 'program'); fs.mkdirSync(cwd);
  session = createSession(BUILTINS.codex, cwd, 'offline-fixture', 'fake-program-session');
  initializeProject(session);
  session.goal = newGoal('Review fictional program fixtures.', 10000);
  session.goal.tokensUsed = 3000;
  session.contract = normalizeContract({ context: 'Original immutable instructions.', scope: { allowedTargets: ['test.invalid'] } }, session.goal.objective);
  session.policy = session.contract.policy; saveSession(session);
});
test.afterEach(() => {
  if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
  fs.rmSync(root, { recursive: true, force: true });
});

test('legacy status, preflight and capsule are read-only and do not enroll a session', () => {
  const records = () => database().prepare('SELECT * FROM records ORDER BY kind,id').all();
  const before = records();
  assert.equal(programScopeStatus(session).state, 'legacy-unversioned');
  assert.equal(programScopeCapsule(session).enrolled, false);
  assert.equal(preflightGoalScope(session), null); assert.equal(scopeForMission(session), null);
  assert.deepEqual(records(), before);
});

test('an unapproved proposal never enrolls or fences existing legacy work', () => {
  const proposed = operate('scope.propose', { scope: scope(), sources: [{ reference: 'proposed fictional scope', sha256: 'a'.repeat(64) }] });
  const before = database().prepare('SELECT * FROM records ORDER BY kind,id').all();
  const inspected = programScopeOperation('scope.inspect', { proposalId: proposed.proposal.id }, { session: current() });
  assert.deepEqual(inspected, proposed); assert.equal(inspected.grantsAuthority, false);
  assert.deepEqual(inspected.version.scope.allowedTargets, ['test.invalid']);
  assert.ok(inspected.changes.some(change => change.field === 'networkMode' && change.after === 'offline'));
  assert.deepEqual(database().prepare('SELECT * FROM records ORDER BY kind,id').all(), before);
  assert.equal(programScopeStatus(current()).state, 'proposed');
  assert.equal(programScopeCapsule(current()).enrolled, false);
  assert.equal(preflightGoalScope(current()), null);
  assert.doesNotThrow(() => assertScopeOperation(current(), { url: 'https://test.invalid/', method: 'GET' }));
});

test('reviewed scope successor keeps the session, exact workflow and remaining budget without starting work', () => {
  preflightGoalWorkflow(current());
  const before = current(), approval = approve(), result = transition(approval), after = current();
  assert.equal(result.sessionId, before.id); assert.equal(after.alias, before.alias);
  assert.notEqual(after.goal.id, before.goal.id); assert.equal(after.goal.predecessorGoalId, before.goal.id);
  assert.equal(after.goal.tokenBudget, 7000); assert.equal(after.goal.tokensUsed, 0);
  assert.equal(getRecord('goal-history', before.goal.id).tokensUsed, 3000);
  assert.deepEqual(getRecord('goal-history', before.goal.id).contract, before.contract);
  assert.equal(after.contract.context, before.contract.context);
  assert.equal(getGoalWorkflow(after.id).state, getGoalWorkflow(before.id, before.goal.id).state);
  assert.equal(after.executionState, 'paused'); assert.equal(after.goal.status, 'paused');
  assert.equal(listRecords('execution').length, 0); assert.equal(after.policy.network, 'disabled');
  assert.equal(after.engineThreadId, null); assert.equal(after.conversationHandoff.pending, true);
  const admission = preflightGoalScope(after);
  assert.doesNotThrow(() => assertGoalScopeAdmission(after, admission));
  assert.equal(transition(approval).changed, false);
  assert.equal(current().goal.id, after.goal.id);
});

test('mutations have CAS and request receipts; retries do not duplicate transitions', () => {
  const approval = approve(), before = current();
  const input = { reviewed: true, requestId: 'stable-transition', expectedRevision: programScopeStatus(before).revision,
    approvalId: approval.id, expectedGoalId: before.goal.id };
  const first = programScopeOperation('scope.continue', input, { session: before });
  assert.deepEqual(programScopeOperation('scope.continue', input, { session: current() }), first);
  assert.equal(listRecords('goal-history').length, 1);
  assert.throws(() => programScopeOperation('scope.continue', { ...input, expectedGoalId: current().goal.id }, { session: current() }), { code: 'CONFLICT' });
  assert.throws(() => programScopeOperation('scope.revoke', { ...input, requestId: 'stale', expectedGoalId: undefined, reason: 'Changed rules.' }, { session: current() }));
});

test('revocation immediately fences queued dispatch and requests durable stops without replay', () => {
  const approval = approve(); transition(approval);
  const receipt = enqueueExecution(session.id, { prompt: 'Resume fixture review.', options: {}, goal: true, resumeGoal: true }, 'fixture-execution', { authorize() {} });
  const queued = getRecord('execution', receipt.executionId);
  assert.ok(queued.scopeAdmission);
  operate('scope.revoke', { approvalId: approval.id, reason: 'Program access withdrawn.' });
  assert.throws(() => assertGoalScopeAdmission(current(), queued.scopeAdmission), { code: 'PROGRAM_SCOPE_REVOKED' });
  assert.equal(getRecord('execution', queued.id).stopAction, 'pause');
  assert.throws(() => assertScopeOperation(current(), { url: 'https://test.invalid/', method: 'GET' }), { code: 'PROGRAM_SCOPE_REVOKED' });
  assert.equal(listRecords('execution').length, 1);
});

test('live work prevents approval changes while source proposals remain inert', () => {
  const approval = approve(); transition(approval);
  const { proposal } = operate('scope.propose', { scope: { ...scope(), allowedTargets: ['other.invalid'] }, sources: [{ reference: 'new fictional rules', sha256: 'b'.repeat(64) }] });
  putRecord('execution', 'live', { id: 'live', sessionId: session.id, state: 'running' });
  assert.throws(() => operate('scope.approve', { proposalId: proposal.id }), { code: 'CONFLICT' });
  assert.equal(programScopeStatus(current()).approval.id, approval.id);
});

test('mediated target and action exclusions hold with Core-HTTP-only native admission', () => {
  const approval = approve('mediated'); transition(approval);
  assert.doesNotThrow(() => assertScopeOperation(current(), { url: 'https://test.invalid/public', method: 'GET' }));
  for (const input of [{ url: 'https://test.invalid/private/x', method: 'GET' }, { url: 'https://test.invalid/', method: 'POST' }, { url: 'https://other.invalid/', method: 'GET' },
    { url: 'https://test.invalid/%70rivate/x', method: 'GET' }, { url: 'https://test.invalid/private%2fitem', method: 'GET' }, { url: 'https://test.invalid/private;item', method: 'GET' }]) {
    assert.throws(() => assertScopeOperation(current(), input), { code: 'PROGRAM_SCOPE_DENIED' });
  }
  assert.equal(programScopeStatus(current()).capabilities.nativeTargetIsolation, false);
  assert.equal(preflightGoalScope(current()).nativeProfile, 'bzzy_program_core_http_v1');
  assert.throws(() => preflightGoalScope({ ...current(), backend: 'claude' }), { code: 'CONFLICT' });
  const unsupported = current(); unsupported.backend = 'claude'; saveSession(unsupported);
  assert.throws(() => preflightGoalScope(current()), { code: 'UNSUPPORTED_SCOPE_ENFORCEMENT' });
});

test('scope successor retains the exact pinned workflow after the Library version changes', () => {
  const first = saveWorkflow({ name: 'scope-procedure', description: 'Synthetic reviewed process.', instructions: 'First immutable scope process.' }, { cwd: session.cwd });
  selectWorkflow(current(), first.name, { expectedRevision: 0 }); preflightGoalWorkflow(current());
  const before = current();
  saveWorkflow({ name: first.name, description: first.description, instructions: 'New future process.' }, { cwd: session.cwd, expectedRevision: first.revision });
  transition(approve());
  const after = current(); assert.equal(after.contract.context, before.contract.context);
  assert.equal(getGoalWorkflow(after.id).workflow.version, first.version);
  assert.equal(getGoalWorkflow(after.id, before.goal.id).workflow.version, first.version);
});

test('offline native admission rejects YOLO and weaker execution policies', () => {
  transition(approve());
  assert.throws(() => preflightGoalScope(current(), { yolo: true }), { code: 'UNSUPPORTED_SCOPE_ENFORCEMENT' });
  assert.throws(() => preflightGoalScope(current(), { policy: { ...current().policy, network: 'inherit' } }), { code: 'UNSUPPORTED_SCOPE_ENFORCEMENT' });
  assert.throws(() => enqueueExecution(session.id, { prompt: 'no bypass', options: { yolo: true } }, 'yolo', { authorize() {} }), { code: 'UNSUPPORTED_SCOPE_ENFORCEMENT' });
});

test('scoped host commands lose native networking and external account gateways cannot bypass mediated scope', () => {
  const approval = approve('mediated'); transition(approval);
  assert.equal(current().policy.network, 'inherit');
  assert.equal(programScopeCommandPolicy(current()).network, 'disabled');
  for (const name of ['gmail_read', 'interact_extension']) assert.throws(() => assertProgramToolAdmission(current(), name), { code: 'PROGRAM_SCOPE_DENIED' });
  assert.doesNotThrow(() => assertProgramToolAdmission(current(), 'http_request'));
  operate('scope.revoke', { approvalId: approval.id, reason: 'Fixture scope revoked.' });
  assert.throws(() => programScopeCommandPolicy(current()), { code: 'PROGRAM_SCOPE_REVOKED' });
});

test('descendant operations require the exact current mission scope binding', () => {
  const approval = approve('mediated'); transition(approval);
  const parent = current(), child = createSession(BUILTINS.codex, session.cwd, 'worker-fixture');
  Object.assign(child, { role: 'executor', parentSessionId: parent.id, projectRoot: parent.projectRoot, projectId: parent.projectId,
    contract: parent.contract, policy: parent.policy, missionContext: createMissionContext(parent) }); saveSession(child);
  assert.doesNotThrow(() => assertScopeOperation(child, { url: 'https://test.invalid/', method: 'GET' }));
  const broken = getRecord('session', child.id); broken.missionContext.brief.programScope.bindingId = '0'.repeat(64); saveSession(broken);
  assert.throws(() => assertScopeOperation(broken, { url: 'https://test.invalid/', method: 'GET' }), { code: 'PROGRAM_SCOPE_CHANGED' });
  assert.throws(() => programScopeStatus(broken), { code: 'FORBIDDEN' });
});

test('imported approvals and forged execution receipts cannot authorize work', () => {
  const approval = approve(); transition(approval);
  const record = getRecord('core.program.scope.approval', approval.id), { sha256, ...body } = record;
  const imported = { ...body, importedUntrusted: true };
  putRecord('core.program.scope.approval', approval.id, { ...imported, sha256: digest(imported) });
  assert.throws(() => preflightGoalScope(current()), { code: 'PROGRAM_SCOPE_REVOKED' });
  assert.throws(() => enqueueExecution(session.id, { prompt: 'forged', scopeAdmission: {} }, 'forged', { authorize() {} }), { code: 'INVALID_WORKFLOW' });
});

test('expired scope is visible as ineffective and cannot admit a resume', () => {
  const approval = approve('offline', { expiresAt: '2000-01-01T00:00:00.000Z' });
  assert.equal(programScopeCapsule(current()).state, 'not-effective');
  assert.throws(() => transition(approval), { code: 'PROGRAM_SCOPE_EXPIRED' });
  assert.equal(operate('scope.revoke', { approvalId: approval.id, reason: 'Archive expired access.' }).state, 'revoked');
});

test('malformed targets, secret references and unsupported action semantics are rejected before persistence', () => {
  for (const changed of [{ allowedTargets: ['https://name:password@test.invalid/'] }, { allowedActions: ['arbitrary shell'] }, { unknownPermission: true }]) {
    assert.throws(() => operate('scope.propose', { scope: { ...scope(), ...changed }, sources: [{ reference: 'fixture', sha256: 'a'.repeat(64) }] }));
  }
  assert.throws(() => operate('scope.propose', { scope: scope(), sources: [{ reference: 'api_key=sk-fixtureSecretShouldNotPersist123', sha256: 'a'.repeat(64) }] }));
  assert.equal(listRecords('core.program.scope.proposal').length, 0);
});
