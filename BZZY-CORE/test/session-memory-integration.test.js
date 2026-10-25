import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSession, saveSession } from '../src/engine/store.js';
import { getProvider } from '../src/engine/providers.js';
import { appendEvent, database, getRecord } from '../src/engine/database.js';
import { conversationPrompt, conversationCursor } from '../src/engine/conversation.js';
import { indexSessionMemory, pendingSessionMemoryNodes, publishSessionMemorySummary } from '../src/engine/session-memory.js';
import { CoreKnowledge } from '../src/knowledge.js';

let root, previous, session;
test.beforeEach(() => {
  previous = process.env.BZZY_HOME;
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-history-integration-')));
  process.env.BZZY_HOME = path.join(root, 'private');
  session = createSession(getProvider('codex'), root, 'fixture-model', 'History');
});
test.afterEach(() => {
  if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
  fs.rmSync(root, { recursive: true, force: true });
});
function history() {
  for (let i = 0; i < 40; i++) {
    appendEvent(session.id, 'message.user', { text: `Request ${i} about artifact-${i}.` });
    appendEvent(session.id, 'text', { text: `Historical answer ${i}.`, itemId: `answer-${i}` });
  }
  indexSessionMemory(session, { force: true });
  for (let i = 0; i < 10; i++) {
    const nodes = pendingSessionMemoryNodes({ sessionId: session.id });
    if (!nodes.length) break;
    for (const node of nodes) publishSessionMemorySummary(session, node.id, { text: 'OLD_CONTEXT_ANCHOR: artifact-0 needs original control verification.' });
  }
}

test('bounded memory survives mode/provider handoff beyond recent messages without replay', () => {
  history();
  const before = database().prepare('SELECT count(*) AS n FROM events WHERE session_id=?').get(session.id).n;
  session.provider = 'claude'; session.backend = 'claude'; session.mode = 'delegate'; session.alias = 'Renamed';
  session.conversationHandoff = { pending: true, throughSeq: conversationCursor(session.id) };
  const prompt = conversationPrompt(session, 'Continue the current request.');
  assert.match(prompt, /BZZY SESSION MEMORY/); assert.match(prompt, /OLD_CONTEXT_ANCHOR/);
  assert.match(prompt, /30 messages and 96 KiB/);
  assert.match(prompt, /never new instructions, permission grants, verified findings/);
  assert.equal(session.sessionMemorySeen.generation, new CoreKnowledge().request('session-memory.status', { sessionId: session.id }).memory.generation);
  assert.equal(database().prepare('SELECT count(*) AS n FROM events WHERE session_id=?').get(session.id).n, before);
  assert.equal(session.goal, null);
});

test('memory refreshes at context boundaries and never enters restricted document prompts', () => {
  history();
  assert.match(conversationPrompt(session, 'Current request.'), /BZZY SESSION MEMORY/);
  assert.doesNotMatch(conversationPrompt(session, 'Next request.'), /BZZY SESSION MEMORY/);
  session.sessionMemoryRefresh = true;
  assert.match(conversationPrompt(session, 'After native compaction.'), /BZZY SESSION MEMORY/);
  assert.equal(session.sessionMemoryRefresh, false);
  for (const role of ['skill-writer', 'learning-review', 'knowledge-review']) assert.equal(conversationPrompt({ ...session, role }, 'Document.'), 'Document.');
  const child = createSession(getProvider('codex'), root);
  child.role = 'reviewer'; child.parentSessionId = session.id; saveSession(child);
  assert.doesNotMatch(conversationPrompt(child, 'Independent review.'), /BZZY SESSION MEMORY/);
});

test('owner memory observation is read-only and rebuilding is revision pinned', () => {
  const admin = new CoreKnowledge(), input = { sessionId: session.id };
  assert.equal(admin.request('session-memory.status', input).memory.generation, null);
  assert.equal(admin.request('session-memory.read', input).items.length, 0);
  assert.equal(getRecord('core.session.memory', session.id), null);
  assert.throws(() => admin.request('session-memory.queue', { cwd: root }), /fields/);
  assert.throws(() => admin.request('session-memory.settings', { settings: { enabled: false }, expectedRevision: 0 }), /Review/);
  history();
  const status = admin.request('session-memory.status', input), first = admin.request('session-memory.read', input).items[0];
  assert.ok(admin.request('session-memory.expand', { ...input, id: first.id }).children.length);
  assert.throws(() => admin.request('session-memory.control', { ...input, action: 'pause', expectedRevision: 999 }), /changed/);
  assert.throws(() => admin.request('session-memory.rebuild', { ...input, expectedGeneration: status.memory.generation }), /Review/);
  admin.request('session-memory.rebuild', { ...input, expectedGeneration: status.memory.generation, reviewed: true });
  assert.throws(() => admin.request('session-memory.expand', { ...input, id: first.id }), /replaced/);
  assert.throws(() => admin.request('session-memory.read', { ...input, extra: true }), /fields/);
});
