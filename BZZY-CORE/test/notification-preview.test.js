import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSession, saveSession } from '../src/engine/store.js';
import { BUILTINS } from '../src/engine/providers.js';
import { appendEvent, getRecord, putRecord } from '../src/engine/database.js';
import { newGoal } from '../src/engine/goals.js';
import { goalEvent } from '../src/engine/lifecycle.js';
import { goalAlert } from '../src/push/worker.js';
import { notificationPreview } from '../src/engine/notification-preview.js';

let directory, previous, session;
test.beforeEach(() => {
  previous = process.env.BZZY_HOME; directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-preview-test-'));
  process.env.BZZY_HOME = path.join(directory, 'private'); session = createSession(BUILTINS.codex, directory, null, 'TestSession');
  session.goal = newGoal('Tell me Messi age');
});
test.afterEach(() => {
  if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
  fs.rmSync(directory, { recursive: true, force: true });
});
test('goal outcome pins the last complete streamed reply rather than the objective, analysis or a later chat', () => {
  appendEvent(session.id, 'message.user', { text: session.goal.objective, kind: 'goal' });
  appendEvent(session.id, 'text', { text: 'Checking sources.', itemId: 'analysis' });
  appendEvent(session.id, 'tool', { name: 'fixture' });
  appendEvent(session.id, 'text', { text: '<message version="1"><p>Lionel Messi was <b>38</b>', itemId: 'final' });
  appendEvent(session.id, 'text', { text: ' at the time.</p></message>', itemId: 'final' });
  appendEvent(session.id, 'text', { text: '\n' });
  session.goal.status = 'complete'; saveSession(session);
  const key = `${session.id}-${session.goal.id}-0-goal.completed`, saved = getRecord('outbox', key).event;
  assert.deepEqual(goalAlert(saved, session), { title: 'Goal achieved - TestSession', body: 'Lionel Messi was 38 at the time.' });
  appendEvent(session.id, 'message.user', { text: 'A later chat.' }); appendEvent(session.id, 'text', { text: 'Unrelated answer.' });
  assert.equal(goalAlert(saved, session).body, 'Lionel Messi was 38 at the time.');
});
test('no reply never reuses earlier conversation, truncation is bounded, and known credentials are omitted before outbox persistence', () => {
  appendEvent(session.id, 'text', { text: 'Old unrelated reply.' }); appendEvent(session.id, 'message.user', { text: 'New goal', kind: 'goal' });
  session.goal.status = 'blocked'; session.goal.reason = 'No reliable source was available.';
  assert.equal(goalEvent(session).replyPreview, ''); assert.equal(goalAlert(goalEvent(session), session).body, session.goal.reason);
  const preview = notificationPreview('🐝'.repeat(300)); assert.equal([...preview].length, 180); assert.ok(preview.endsWith('...'));
  assert.equal(notificationPreview('Value fixture-private-value', 180, ['fixture-private-value']), '');
  appendEvent(session.id, 'text', { text: 'API_KEY=fixture-private-value' }); saveSession(session);
  assert.equal(goalEvent(session).replyPreview, '');
});
test('group previews use only the current goal’s own peer replies', () => {
  session.mode = 'parallel'; session.goal.status = 'complete';
  const child = createSession(BUILTINS.codex, directory); child.parentSessionId = session.id; child.goal = newGoal(session.goal.objective); putRecord('session', child.id, child);
  appendEvent(child.id, 'message.user', { text: child.goal.objective, kind: 'goal' });
  appendEvent(child.id, 'text', { text: 'A bounded peer answer.', itemId: 'final' });
  putRecord('parallel', session.id, { goalId: 'previous-goal', peers: [{ sessionId: child.id }] });
  assert.equal(goalEvent(session).replyPreview, '');
  putRecord('parallel', session.id, { goalId: session.goal.id, peers: [{ sessionId: child.id }] });
  assert.equal(goalEvent(session).replyPreview, 'Agent 1: A bounded peer answer.');
});
