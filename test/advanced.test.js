import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createSession, saveSession, loadSession, writeJson } from '../src/store.js';
import { BUILTINS } from '../src/providers.js';
import { normalizeContract, schemaErrors } from '../src/contracts.js';
import { prepareTask } from '../src/task.js';
import { database, getRecord, putRecord, events, reserveRequest, appendEvent } from '../src/database.js';
import { remember, recall, checkpoint } from '../src/memory.js';
import { initializeProject, issue, projectContext } from '../src/project.js';
import { artifact, captureEvidence, snapshotWorkspace, inspectWorkspace, inside } from '../src/evidence.js';
import { assessRequirement, assessCompletion } from '../src/verification.js';
import { childPolicy, sandboxCommand, sandboxSupport } from '../src/policy.js';
import { reconcileSession, processIdentity, identityAlive } from '../src/recovery.js';
import { newGoal } from '../src/goals.js';
import { ToolHost } from '../src/tools.js';
import { recordActivity } from '../src/activity.js';
import { NotificationHub } from '../src/notifications.js';

let dir, session;
test.beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-adv-')); process.env.BZZY_HOME = path.join(dir, 'private');
  fs.writeFileSync(path.join(dir, 'source.txt'), 'original evidence');
  session = createSession(BUILTINS.codex, dir); prepareTask(session, {}, 'Assess this project'); initializeProject(session);
});
test.afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); delete process.env.BZZY_HOME; });

test('transactional events and idempotency preserve one result and reject changed requests', () => {
  let calls = 0;
  const operation = db => { calls++; appendEvent(session.id, 'accepted', { value: 42 }, db); return { value: 42 }; };
  assert.deepEqual(reserveRequest('test', 'same', { x: 1, y: 2 }, operation), { value: 42 });
  assert.deepEqual(reserveRequest('test', 'same', { y: 2, x: 1 }, operation), { value: 42 });
  assert.equal(calls, 1); assert.throws(() => reserveRequest('test', 'same', { x: 2 }, operation), /conflict/i);
  const initial = events(session.id, 0, 1); assert.equal(initial.length, 1);
  const rest = events(session.id, initial[0].seq, 100); assert.ok(rest.every(e => e.seq > initial[0].seq));
  assert.throws(() => reserveRequest('test', 'rollback', {}, db => { putRecord('temporary', 'x', {}, db); throw new Error('rollback'); }));
  assert.equal(getRecord('temporary', 'x'), null);
});

test('project constraints and knowledge survive new conversations and flag changed evidence', () => {
  writeJson(path.join(dir, '.bzzy', 'constraints.json'), { constraints: ['Only test approved accounts'], scope: { allowedTargets: ['https://scope.example'] } });
  const evidence = captureEvidence(session, 'source.txt');
  const note = remember(session, { kind: 'observation', statement: 'The source contains a parameter.', evidence: [evidence.id], inputs: ['source.txt'] });
  remember(session, { kind: 'inconclusive', statement: 'A failed experiment did not disprove the hypothesis.' });
  checkpoint(session, { constraints: ['Preserve cleanup obligations'], pendingActions: ['Inspect the ownership check'], unresolvedQuestions: ['Is the response account-specific?'] });
  issue(session, { title: 'Potential ownership issue', status: 'investigating', evidence: [evidence.id] });
  const next = createSession(BUILTINS.claude, dir); prepareTask(next, {}, 'Continue assessment');
  assert.deepEqual(next.contract.constraints, ['Only test approved accounts']);
  assert.deepEqual(next.contract.scope.allowedTargets, ['https://scope.example']);
  assert.ok(fs.existsSync(path.join(dir, '.bzzy', 'memory', note.id + '.json')));
  assert.equal(projectContext(dir).issues.length, 1);
  assert.equal(recall(dir, 'parameter')[0].stale, false);
  fs.writeFileSync(path.join(dir, 'source.txt'), 'different source');
  assert.equal(recall(dir, 'parameter')[0].stale, true);
  assert.throws(() => remember(session, { kind: 'disproved', statement: 'Disproved without evidence' }), /evidence/i);
});

test('acceptance checks reject missing artifacts, missing assessment, invalid schemas and stale evidence', async () => {
  session.contract = normalizeContract({ acceptanceCriteria: [{ id: 'ownership', description: 'Establish ownership behavior' }], artifacts: [{ path: 'result.json', schema: { type: 'object', required: ['supported'], properties: { supported: { type: 'boolean' } }, additionalProperties: false } }] }, 'Assess ownership');
  session.policy = session.contract.policy;
  let result = await assessCompletion(session); assert.equal(result.passed, false);
  fs.writeFileSync(path.join(dir, 'result.json'), '{"supported":"maybe"}');
  const evidence = captureEvidence(session, 'source.txt');
  assessRequirement(session, { id: 'ownership', status: 'supported', rationale: 'Inspected the decisive file', evidence: [evidence.id] });
  result = await assessCompletion(session); assert.equal(result.passed, false);
  fs.writeFileSync(path.join(dir, 'result.json'), '{"supported":true}');
  result = await assessCompletion(session); assert.equal(result.passed, true);
  fs.writeFileSync(path.join(dir, 'source.txt'), 'changed');
  result = await assessCompletion(session); assert.equal(result.passed, false); assert.equal(result.requirements[0].stale, true);
  assert.throws(() => normalizeContract({ artifacts: [{ path: 'x', schema: { oneOf: [] } }] }, 'test'), /Unsupported/);
  assert.deepEqual(schemaErrors({ n: 1 }, { type: 'object', required: ['n'], properties: { n: { type: 'integer' } } }), []);
});

test('host verification records command evidence and respects read-only isolation', async () => {
  if (!sandboxSupport()) return;
  session.contract = normalizeContract({ acceptanceCriteria: [{ id: 'task', description: 'Inspect', modelJudgment: true }], verification: [{ id: 'readonly', argv: [process.execPath, '-e', 'require("fs").writeFileSync("source.txt","bad")'], timeoutSeconds: 5 }], policy: { mode: 'read-only' } }, 'Inspect');
  session.policy = session.contract.policy;
  const result = await assessCompletion(session);
  assert.equal(result.passed, false); assert.equal(result.checks[0].passed, false);
  assert.equal(fs.readFileSync(path.join(dir, 'source.txt'), 'utf8'), 'original evidence');
  assert.ok(getRecord('artifact', result.checks[0].evidence));
});

test('permissions cannot widen through worker assignments and symlink evidence is rejected', () => {
  assert.throws(() => childPolicy({ mode: 'read-only', writablePaths: [], network: 'disabled' }, { mode: 'workspace-write' }), /widen/);
  assert.throws(() => childPolicy({ mode: 'workspace-write', writablePaths: ['src'], network: 'disabled' }, { mode: 'workspace-write', writablePaths: ['.'], network: 'disabled' }), /exceed/);
  fs.symlinkSync('/etc/passwd', path.join(dir, 'link')); assert.throws(() => captureEvidence(session, 'link'), /symlink/);
  assert.throws(() => inside(dir, '../outside'), /outside/);
});

test('recovery preserves completed evidence and marks uncertain actions without replay', () => {
  session.goal = newGoal('Finish assessment'); session.executionState = 'running';
  session.startSnapshotId = snapshotWorkspace(session).id; saveSession(session);
  const actionId = randomUUID(); putRecord('operation', actionId, { id: actionId, sessionId: session.id, state: 'dispatched' });
  putRecord('run', session.id, { sessionId: session.id, state: 'running', runner: { pid: 2147483646, start: 'gone', boot: 'gone' } });
  fs.writeFileSync(path.join(dir, 'source.txt'), 'partial work survived');
  const result = reconcileSession(session.id);
  assert.equal(result.automaticallyReplayed, false); assert.deepEqual(result.uncertainOperations, [actionId]);
  assert.ok(result.workspaceChanges.some(c => c.path === 'source.txt')); assert.equal(getRecord('operation', actionId).state, 'uncertain');
  assert.equal(loadSession(session.id).goal.status, 'paused');
});

test('recovery stops a verified orphan backend before allowing a replacement', async () => {
  if (process.platform !== 'linux') return;
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  const identity = processIdentity(child.pid);
  try {
    session.backendProcess = identity; session.executionState = 'running'; session.goal = newGoal('Recover safely'); saveSession(session);
    putRecord('run', session.id, { sessionId: session.id, state: 'running', runner: { pid: 2147483646, start: 'gone', boot: 'gone' } });
    const result = reconcileSession(session.id);
    assert.equal(result.state, 'reconciled'); assert.equal(result.orphanCleanup.stopped, true);
    assert.equal(identityAlive(identity), false); assert.equal(loadSession(session.id).backendProcess, null);
  } finally { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
});

test('worker roles cannot accept parent requirements or invoke delegation; activity is attributed and durable', async () => {
  session.role = 'executor'; const host = new ToolHost(session, { event() {} });
  await assert.rejects(host.call('assess_requirement', {}), /not authorized/);
  await assert.rejects(host.call('delegate', {}), /not authorized/);
  const record = recordActivity(session, { summary: 'Testing IDOR candidates at /users/getProfile', details: 'The user_id field is a hypothesis; compare approved accounts before drawing a conclusion.', observation: 'Parameter is present', inference: 'Ownership enforcement is unknown', nextCheck: 'Compare approved account controls' });
  assert.equal(record.provenance, 'agent-reported');
  assert.ok(events(session.id).some(e => e.type === 'activity'));
});

test('completed lifecycle and notification outbox are committed together before delivery', async () => {
  session.goal = newGoal('Finish'); session.goal.status = 'complete'; saveSession(session);
  const key = `${session.id}-${session.goal.id}-0-goal.completed`;
  assert.equal(getRecord('outbox', key).event.type, 'goal.completed');
  assert.equal(new NotificationHub().records().length, 1);
});
