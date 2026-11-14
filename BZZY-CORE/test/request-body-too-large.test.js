import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyFailure, runSession } from '../src/engine/controller.js';
import { CodexEngine } from '../src/engine/engines/codex.js';
import { createSession, loadSession, saveSession } from '../src/engine/store.js';
import { getProvider } from '../src/engine/providers.js';
import { newGoal } from '../src/engine/goals.js';

// The real DeepSeek /responses gateway rejection for an oversized request body.
// It must classify as a distinct, recoverable `request_too_large` category — not
// the generic `backend_failure` that dead-ends a goal as `blocked`.
test('classifyFailure recognises a provider request-body-size rejection', () => {
  const real = classifyFailure(new Error('unexpected status 413 Payload Too Large: Failed to buffer the request body: length limit exceeded (request_id: 0c3d1156-d3fd-4307-baf1-ab565e1dbf6a), url: https://api.deepseek.com/responses'));
  assert.equal(real.category, 'request_too_large');
  // It is not retried blindly: the identical oversized body would 413 again.
  assert.equal(real.retryable, false);
  assert.equal(real.requiresInput, false);

  for (const message of [
    'HTTP 413 Request Entity Too Large',
    'request body too large for this endpoint',
    'Failed to buffer the request body: length limit exceeded',
  ]) assert.equal(classifyFailure(new Error(message)).category, 'request_too_large', message);
});

test('classifyFailure keeps other categories distinct from request_too_large', () => {
  assert.equal(classifyFailure(new Error('401 unauthorized: invalid api key')).category, 'authentication');
  assert.equal(classifyFailure(new Error('429 rate limit exceeded')).category, 'rate_limit');
  assert.equal(classifyFailure(new Error('backend timed out handling thread/resume')).category, 'timeout');
  assert.equal(classifyFailure(new Error('some other failure')).category, 'backend_failure');
});

test('an ordinary chat 413 records its oversized thread without changing a blocked saved goal', async () => {
  const originalHome = process.env.BZZY_HOME, originalRun = CodexEngine.prototype.run;
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-chat-413-')));
  try {
    process.env.BZZY_HOME = path.join(root, 'private');
    const cwd = path.join(root, 'project'); fs.mkdirSync(cwd);
    const provider = getProvider('codex'), session = createSession(provider, cwd, 'offline-fixture');
    session.engineThreadId = 'oversized-native-thread';
    session.goal = newGoal('Preserve this saved goal.', null);
    session.goal.status = 'blocked'; session.goal.reason = 'native_blocked';
    const goal = structuredClone(session.goal); saveSession(session);
    CodexEngine.prototype.run = async () => { throw new Error('HTTP 413: Failed to buffer the request body: length limit exceeded'); };
    const ui = { interactive: false, json: true, event() {}, newline() {}, async ask() { return ''; }, async approve() { return false; } };
    await assert.rejects(runSession(provider, session, { pet: false }, ui, 'An ordinary chat message.'), /HTTP 413/);
    const saved = loadSession(session.id);
    assert.equal(saved.executionState, 'failed');
    assert.equal(saved.failure.category, 'request_too_large');
    assert.deepEqual(saved.oversizedNativeThread, { version: 1, threadId: 'oversized-native-thread', pending: true });
    assert.deepEqual(saved.goal, goal);
  } finally {
    CodexEngine.prototype.run = originalRun;
    if (originalHome === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = originalHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
