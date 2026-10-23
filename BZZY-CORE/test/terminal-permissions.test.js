import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSession, saveSession } from '../src/engine/store.js';
import { BUILTINS } from '../src/engine/providers.js';
import { getRecord, putRecord, events, listRecords } from '../src/engine/database.js';
import { setTerminalYolo, terminalYolo, approvePendingWithYolo } from '../src/engine/terminal-permissions.js';
import { enqueueExecution } from '../src/engine/execution-queue.js';
import { RunnerUI } from '../src/engine/runtime-ui.js';
import { sharedKinds } from '../src/engine/share-bundle-policy.js';

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
