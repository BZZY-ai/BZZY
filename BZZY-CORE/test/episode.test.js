import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSession, saveSession } from '../src/engine/store.js';
import { getProvider } from '../src/engine/providers.js';
import { appendEvent, getRecord, putRecord, listRecords } from '../src/engine/database.js';
import { captureEpisode, episodeMaterial, recordWorkObservation, recentErrorSignatures } from '../src/engine/episode.js';
import { CodexEngine } from '../src/engine/engines/codex.js';

let root, prior, session;
test.beforeEach(() => {
  prior = process.env.BZZY_HOME;
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-episodes-')));
  process.env.BZZY_HOME = path.join(root, 'private');
  const cwd = path.join(root, 'project'); fs.mkdirSync(cwd);
  session = createSession(getProvider('codex'), cwd, 'offline');
  session.projectRoot = cwd; session.goal = { id: 'goal-a', status: 'active' }; saveSession(session);
  putRecord('run', session.id, { id: 'run-a', sessionId: session.id, state: 'running', goalMode: true, goalId: 'goal-a' });
});
test.afterEach(() => {
  if (prior === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = prior;
  fs.rmSync(root, { recursive: true, force: true });
});
const observe = input => recordWorkObservation(session, { runId: 'run-a', threadRef: 'thread', turnId: 'turn', kind: 'command',
  name: 'shell', command: 'npm test', ...input });

test('host capture links failed and successful attempts without claiming a verified fix', () => {
  const failed = observe({ itemId: 'failed', output: 'TypeError: value is undefined', exitCode: 1 });
  observe({ itemId: 'edit', kind: 'file_change', command: '', changes: [{ path: 'main.js', diff: '+ const value = 1;' }], status: 'completed' });
  const passed = observe({ itemId: 'passed', output: 'Tests passed', exitCode: 0 });
  assert.equal(observe({ itemId: 'passed', exitCode: 0 }).id, passed.id);
  const material = episodeMaterial(session, { runId: 'run-a', goalId: 'goal-a' });
  assert.equal(material.attempts.length, 3); assert.equal(material.counts.failed, 1);
  assert.equal(material.transitions.length, 1);
  assert.equal(material.transitions[0].failureId, failed.id); assert.equal(material.transitions[0].successId, passed.id);
  assert.equal(material.transitions[0].authority, 'temporal-sequence-only');
  assert.equal(material.attempts[1].changedFiles[0].path, 'main.js');
  const first = captureEpisode(session, { runId: 'run-a', goalId: 'goal-a' });
  appendEvent(session.id, 'text', { text: 'Unrelated text does not create another progress snapshot.' });
  const second = captureEpisode(session, { runId: 'run-a', goalId: 'goal-a' });
  assert.equal(first.id, second.id); assert.equal(listRecords('core.episode').length, 1);
  assert.equal(getRecord('core.episode.progress', session.id).counts.attempts, 3);
});

test('complete outputs are scrubbed before bounded excerpts and private operations are omitted', () => {
  observe({ itemId: 'secret', output: 'password="fixture-private\nvalue"\nSafe fact', exitCode: 1 });
  observe({ itemId: 'private', command: 'cat .env', output: 'UNLABELLED_PRIVATE_CONTENT', exitCode: 0 });
  observe({ itemId: 'oversize', output: 'OVERSIZE_PRIVATE_CONTENT'.repeat(10000), exitCode: 1 });
  const text = JSON.stringify(episodeMaterial(session, { runId: 'run-a', goalId: 'goal-a' }));
  assert.doesNotMatch(text, /fixture-private|UNLABELLED_PRIVATE_CONTENT|OVERSIZE_PRIVATE_CONTENT/);
  assert.match(text, /Safe fact/); assert.match(text, /redacted/);
});

test('goal/run cutoffs exclude later work, ordinary chat does not inherit a previous goal', () => {
  const old = observe({ itemId: 'old', output: 'OLD_GOAL', exitCode: 1 });
  putRecord('run', session.id, { id: 'run-b', state: 'running', goalMode: true, goalId: 'goal-b' });
  recordWorkObservation(session, { runId: 'run-b', itemId: 'new', output: 'NEW_GOAL', exitCode: 0 });
  const earlier = episodeMaterial(session, { throughSeq: old.sourceSeq, goalId: 'goal-a', runId: 'run-a' });
  assert.equal(earlier.attempts.length, 1); assert.doesNotMatch(JSON.stringify(earlier), /NEW_GOAL/);
  putRecord('run', session.id, { id: 'run-chat', state: 'running', goalMode: false, goalId: null });
  recordWorkObservation(session, { runId: 'run-chat', itemId: 'chat', output: 'CHAT_ONLY', exitCode: 0 });
  const chat = episodeMaterial(session, { goalId: null, runId: 'run-chat' });
  assert.equal(chat.attempts.length, 1); assert.equal(chat.goalId, null);
  assert.doesNotMatch(JSON.stringify(chat), /OLD_GOAL|NEW_GOAL/);
  assert.equal(recentErrorSignatures(session, { goalId: null, runId: 'run-chat' }).length, 0);
  assert.equal(recentErrorSignatures(session, { goalId: 'goal-a', runId: 'other-run' }).length, 1);
  assert.throws(() => episodeMaterial({ ...session, cwd: root }), /unavailable/);
  putRecord('session-deletion', session.id, { sessionId: session.id });
  assert.throws(() => episodeMaterial(session), /unavailable/);
});

test('small packets prioritize failed/success pairs and state bounded coverage', () => {
  observe({ itemId: 'failure', output: 'Error: early useful failure', exitCode: 1 });
  observe({ itemId: 'success', output: 'Verified command exit, not verified root cause.', exitCode: 0 });
  for (let index = 0; index < 600; index++) observe({ itemId: 'later-' + index, command: 'read-' + index, output: 'x'.repeat(2000), exitCode: 0 });
  const material = episodeMaterial(session, { runId: 'run-a', goalId: 'goal-a', maxBytes: 4096 });
  assert.ok(Buffer.byteLength(JSON.stringify(material)) <= 4096);
  assert.equal(material.coverage.truncated, true); assert.ok(material.coverage.omittedEvents >= 90);
  assert.ok(material.coverage.omittedAttempts > 0);
});

test('a small packet keeps the intervening edit with its failed and successful command pair', () => {
  const failure = observe({ itemId: 'failure', output: 'Error: early failure ' + 'details '.repeat(90), exitCode: 1 });
  const edit = observe({ itemId: 'edit', kind: 'file_change', command: '', changes: [{ path: 'main.js', diff: '+ THE_RECORDED_FIX ' + 'x'.repeat(1500) }], status: 'completed' });
  const success = observe({ itemId: 'success', output: 'Final command passed ' + 'details '.repeat(90), exitCode: 0 });
  for (let index = 0; index < 12; index++) observe({ itemId: 'noise-' + index, command: 'unrelated-' + index, output: 'UNRELATED '.repeat(120), exitCode: 0 });
  const material = episodeMaterial(session, { runId: 'run-a', goalId: 'goal-a', maxBytes: 4096 });
  assert.ok(Buffer.byteLength(JSON.stringify(material)) <= 4096); assert.equal(material.transitions.length, 1);
  assert.deepEqual(material.transitions[0].changeIds, [edit.id]);
  for (const id of [failure.id, edit.id, success.id]) assert.ok(material.attempts.some(item => item.id === id));
  assert.match(JSON.stringify(material), /THE_RECORDED_FIX/);
});

test('worker reviews require parent, goal and run ownership; raw worker history stays excluded', () => {
  putRecord('assignment', 'worker-a', { id: 'worker-a', parentSessionId: session.id, goalId: 'goal-a', chatRunId: 'run-a' });
  putRecord('assignment', 'foreign', { id: 'foreign', parentSessionId: 'other', goalId: 'goal-a' });
  appendEvent(session.id, 'assignment.reviewed', { assignmentId: 'worker-a', outcome: 'accepted', round: 1, inspectedEvidence: [] });
  appendEvent(session.id, 'assignment.reviewed', { assignmentId: 'foreign', outcome: 'accepted', round: 1, inspectedEvidence: [] });
  const material = episodeMaterial(session, { goalId: 'goal-a', runId: 'run-a' });
  assert.equal(material.verification.length, 1); assert.equal(material.verification[0].assignmentId, 'worker-a');
  assert.match(material.verification[0].authority, /not independent verification/);
});

test('native Codex completion notifications record real exit status and file changes exactly once', () => {
  const engine = new CodexEngine(getProvider('codex'), session, { toolHost: { context: { runId: 'run-a' } } }, { event() {}, newline() {} });
  engine.threadId = 'native-thread';
  const failed = { threadId: 'native-thread', turnId: 'native-turn', item: { id: 'native-command', type: 'commandExecution', command: 'npm test', aggregatedOutput: 'Error: native completion fixture', exitCode: 2, status: 'failed' } };
  engine.notification('item/completed', failed); engine.notification('item/completed', failed);
  engine.notification('item/completed', { threadId: 'native-thread', turnId: 'native-turn', item: { id: 'native-edit', type: 'fileChange', status: 'completed', changes: [{ path: 'main.js', diff: '+ NATIVE_DIFF' }] } });
  engine.notification('item/completed', { threadId: 'foreign-thread', item: { ...failed.item, id: 'foreign' } });
  const material = episodeMaterial(session, { goalId: 'goal-a', runId: 'run-a' });
  assert.equal(material.attempts.length, 2); assert.equal(material.attempts[0].exitCode, 2);
  assert.match(material.attempts[1].changedFiles[0].diff, /NATIVE_DIFF/);
});
