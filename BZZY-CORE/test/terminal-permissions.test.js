import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSession, saveSession, loadSession } from '../src/engine/store.js';
import { BUILTINS } from '../src/engine/providers.js';
import { getRecord, putRecord, events, listRecords } from '../src/engine/database.js';
import { setTerminalYolo, terminalYolo, approvePendingWithYolo, enableAttachedTerminalYolo } from '../src/engine/terminal-permissions.js';
import { enqueueExecution } from '../src/engine/execution-queue.js';
import { RunnerUI } from '../src/engine/runtime-ui.js';
import { sharedKinds } from '../src/engine/share-bundle-policy.js';
import { newGoal } from '../src/engine/goals.js';
import { processIdentity } from '../src/engine/process-identity.js';

let directory, previous, session;
test.beforeEach(() => {
  previous = process.env.BZZY_HOME; directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-permission-'));
  process.env.BZZY_HOME = path.join(directory, 'private');
  session = createSession(BUILTINS.codex, directory);
});
test.afterEach(() => {
  if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
  fs.rmSync(directory, { force: true, recursive: true });
});
const authorization = { authorize() {} };
const set = (enabled, questionId, requestId = randomUUID()) => setTerminalYolo(session.id, { enabled, ...(questionId ? { questionId } : {}) }, requestId, authorization);
function question(extra = {}) {
  const record = { id: randomUUID(), sessionId: session.id, kind: 'approval', question: 'Fixture command', state: 'pending', expiresAt: Date.now() + 60000, ...extra };
  putRecord('question', record.id, record); return record;
}

test('YOLO is Core-owned, inherited by queued work and excluded from portable state', () => {
  assert.equal(terminalYolo(session.id), null); set(true); assert.equal(terminalYolo(session.id), true);
  const accepted = enqueueExecution(session.id, { prompt: 'Fixture', options: { yolo: false } }, randomUUID(), authorization);
  assert.equal(getRecord('execution', accepted.executionId).options.yolo, true);
  assert.throws(() => set(false), { code: 'CONFLICT' });
  putRecord('execution', accepted.executionId, { ...getRecord('execution', accepted.executionId), state: 'finished' });
  set(false); assert.equal(terminalYolo(session.id), false); assert.equal(sharedKinds.has('terminal-permissions'), false);
});
test('enabling YOLO atomically accepts the exact pending approval once and preserves denied or expired requests', async () => {
  const job = enqueueExecution(session.id, { prompt: 'Fixture' }, randomUUID(), authorization), pending = question(), requestId = randomUUID();
  assert.deepEqual(set(true, pending.id, requestId), { yolo: true, approvedQuestionId: pending.id });
  assert.equal(getRecord('question', pending.id).answer, 'yes');
  set(true, pending.id, requestId); assert.equal(events(session.id).filter(event => event.type === 'question.answered').length, 1);
  const runner = new RunnerUI(session.id); assert.equal(await runner.approve('Future request'), true); runner.close();
  assert.equal(listRecords('question').length, 1, 'the next approval is bypassed without fabricating a new question');
  for (const bad of [question({ state: 'answered', answer: 'no' }), question({ expiresAt: Date.now() - 1 }), question({ sessionId: randomUUID() }), question({ kind: 'input' })]) {
    assert.throws(() => set(true, bad.id), { code: 'CONFLICT' });
    assert.equal(approvePendingWithYolo(bad.id, session.id), false);
  }
  assert.equal(getRecord('execution', job.executionId).state, 'queued');
});
test('permission changes require authorization and cannot widen read-only or isolated Agent policies', () => {
  assert.throws(() => setTerminalYolo(session.id, { enabled: true }, randomUUID()), /authorized owner/);
  assert.throws(() => setTerminalYolo(session.id, { enabled: true }, randomUUID(), { authorize() { throw new Error('Ownership lost'); } }), /Ownership lost/);
  assert.equal(terminalYolo(session.id), null);
  session.contract = { policy: { mode: 'read-only', network: 'disabled', writablePaths: [] } }; saveSession(session);
  assert.throws(() => set(true), { code: 'FORBIDDEN' }); assert.equal(terminalYolo(session.id), false);
  session.contract = null; session.purpose = 'agent'; saveSession(session);
  assert.throws(() => set(true), { code: 'FORBIDDEN' }); assert.equal(terminalYolo(session.id), false);
});
test('read-only descendants never inherit an ancestor’s approval bypass', async () => {
  set(true);
  const child = createSession(BUILTINS.codex, directory); child.parentSessionId = session.id; saveSession(child);
  assert.equal(terminalYolo(child.id), true);
  child.contract = { policy: { mode: 'read-only', network: 'disabled', writablePaths: [] } }; saveSession(child);
  assert.equal(terminalYolo(child.id), false);
  const pending = question({ sessionId: child.id });
  assert.equal(approvePendingWithYolo(pending.id, child.id), false);
  assert.equal(getRecord('question', pending.id).state, 'pending');
  child.contract.policy.mode = 'workspace-write'; child.policy = { mode: 'read-only', network: 'disabled', writablePaths: [] }; saveSession(child);
  assert.equal(terminalYolo(child.id), false, 'the active runtime policy is also authoritative');
});
test('a real RunnerUI permission wait resolves when YOLO accepts its pending question', async () => {
  const runner = new RunnerUI(session.id), answer = runner.approve('Fixture command');
  const pending = listRecords('question', { sessionId: session.id, state: 'pending' })[0];
  assert.ok(pending); set(true, pending.id);
  assert.equal(await answer, true); assert.equal(getRecord('question', pending.id).answer, 'yes'); runner.close();
});

test('explicit attachment enables the parent without widening read-only review children or approving their requests', () => {
  session.contract = { policy: { mode: 'workspace-write', network: 'inherit', writablePaths: ['.'] } }; saveSession(session);
  const child = createSession(BUILTINS.codex, directory); child.parentSessionId = session.id; child.role = 'reviewer';
  child.contract = { policy: { mode: 'read-only', network: 'disabled', writablePaths: [] } }; child.policy = child.contract.policy; saveSession(child);
  const pending = question({ sessionId: child.id });
  putRecord('execution', 'review-job', { id: 'review-job', sessionId: child.id, state: 'running' });
  // A long-lived parent can accumulate more historical workers than a normal
  // whole-tree permission change accepts. Attachment only changes the parent.
  for (let index = 0; index < 260; index++) {
    const id = randomUUID(); putRecord('session', id, { id, parentSessionId: session.id, role: 'reviewer', policy: child.policy });
  }
  assert.deepEqual(enableAttachedTerminalYolo(session.id, randomUUID(), authorization), { yolo: true });
  assert.equal(terminalYolo(session.id), true); assert.equal(terminalYolo(child.id), false);
  assert.equal(approvePendingWithYolo(pending.id, child.id), false);
  assert.equal(getRecord('question', pending.id).state, 'pending'); assert.deepEqual(loadSession(child.id).contract, child.contract);
  const queued = enqueueExecution(session.id, { prompt: 'Continue the synthetic parent', options: { yolo: false } }, randomUUID(), authorization);
  assert.equal(getRecord('execution', queued.executionId).options.yolo, true);
});

test('owner attachment can upgrade an idle saved parent while retaining its goal, evidence, scope and network policy', () => {
  session.goal = { ...newGoal('Keep the existing objective'), status: 'paused', evidence: ['existing-evidence'] };
  session.contract = { objective: session.goal.objective, context: 'Retain the original context.', scope: { allowedTargets: ['fixture.invalid'] },
    policy: { mode: 'read-only', network: 'disabled', writablePaths: [] } };
  session.policy = session.contract.policy; session.strictPolicy = true; saveSession(session);
  const before = structuredClone(session), requestId = randomUUID();
  assert.throws(() => enableAttachedTerminalYolo(session.id, requestId), /authorized owner/);
  assert.throws(() => set(true), { code: 'FORBIDDEN' }, 'Ordinary permission requests do not become policy upgrades');
  assert.deepEqual(enableAttachedTerminalYolo(session.id, requestId, authorization), { yolo: true, policyUpgraded: true });
  const saved = loadSession(session.id); assert.equal(terminalYolo(saved.id), true);
  assert.equal(saved.contract.policy.mode, 'workspace-write'); assert.deepEqual(saved.contract.policy.writablePaths, ['.']);
  assert.equal(saved.contract.policy.network, 'disabled'); assert.equal(saved.strictPolicy, true);
  assert.deepEqual(saved.goal, before.goal); assert.deepEqual(saved.contract.scope, before.contract.scope); assert.equal(saved.contract.context, before.contract.context);
  assert.equal(listRecords('execution').length, 0); assert.equal(listRecords('terminal-policy-change').length, 1);
  assert.deepEqual(listRecords('terminal-policy-change')[0].previousContractPolicy, before.contract.policy);
  enableAttachedTerminalYolo(session.id, requestId, authorization);
  assert.equal(listRecords('terminal-policy-change').length, 1); assert.equal(sharedKinds.has('terminal-policy-change'), false);
});

test('reattaching to an already-YOLO live parent is idempotent; enabling it on a non-YOLO live runner still requires pause', () => {
  set(true); putRecord('execution', 'live', { id: 'live', sessionId: session.id, state: 'running', options: { yolo: true } });
  const count = events(session.id).filter(event => event.type === 'permissions.changed').length;
  assert.deepEqual(enableAttachedTerminalYolo(session.id, randomUUID(), authorization), { yolo: true });
  assert.equal(events(session.id).filter(event => event.type === 'permissions.changed').length, count);
  putRecord('execution', 'live', { id: 'live', sessionId: session.id, state: 'finished' }); set(false);
  session.executionState = 'running'; saveSession(session);
  putRecord('run', session.id, { sessionId: session.id, runner: processIdentity(), state: 'running' });
  assert.throws(() => enableAttachedTerminalYolo(session.id, randomUUID(), authorization), { code: 'CONFLICT' });
  assert.equal(terminalYolo(session.id), false);
});

test('CLI attachment never widens isolated workers, persistent Agents or validation contexts', () => {
  for (const extra of [{ parentSessionId: session.id }, { role: 'reviewer' }, { assignmentId: randomUUID() }, { purpose: 'agent' }, { mode: 'debate' }]) {
    const protectedSession = createSession(BUILTINS.codex, directory);
    Object.assign(protectedSession, extra, { contract: { policy: { mode: 'read-only', network: 'disabled', writablePaths: [] } } }); saveSession(protectedSession);
    assert.throws(() => enableAttachedTerminalYolo(protectedSession.id, randomUUID(), authorization), { code: 'FORBIDDEN' });
    assert.equal(terminalYolo(protectedSession.id), false); assert.equal(loadSession(protectedSession.id).contract.policy.mode, 'read-only');
  }
});
