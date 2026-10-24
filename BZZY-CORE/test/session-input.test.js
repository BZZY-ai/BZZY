import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { submitSessionInput } from '../src/engine/session-input.js';
import { createSession } from '../src/engine/store.js';
import { BUILTINS } from '../src/engine/providers.js';
import { claimInput, effectiveInputOwner } from '../src/engine/runtime.js';
import { getRecord, listRecords } from '../src/engine/database.js';

let directory, previous, session;
test.beforeEach(() => {
  previous = process.env.BZZY_HOME; directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-input-router-'));
  process.env.BZZY_HOME = path.join(directory, 'private');
  session = createSession(BUILTINS.codex, directory);
});
test.afterEach(() => {
  if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
  fs.rmSync(directory, { recursive: true, force: true });
});
const context = authorize => ({ authorize: authorize || (() => {}), request: async () => ({ capabilities: {}, execution: null }) });

test('Core admits a phone input without a separate claim and duplicate receipts never retake control', async () => {
  claimInput(session.id, 'cli');
  const id = randomUUID(), input = { owner: 'phone', operation: 'execute', prompt: 'Inspect the supplied context' };
  const receipt = await submitSessionInput(session.id, input, id, context());
  assert.equal(effectiveInputOwner(session.id).owner, 'phone');
  claimInput(session.id, 'cli', true);
  assert.deepEqual(await submitSessionInput(session.id, input, id, context()), receipt);
  assert.equal(effectiveInputOwner(session.id).owner, 'cli');
  assert.equal(listRecords('execution').length, 1);
  await assert.rejects(submitSessionInput(session.id, { ...input, prompt: 'Different' }, id, context()), { code: 'CONFLICT' });
});

test('Core denies a handoff without the granted permission and preserves the previous actor', async () => {
  claimInput(session.id, 'cli');
  const denied = context(permission => { if (permission === 'takeover') throw Object.assign(new Error('Denied'), { status: 403, code: 'FORBIDDEN' }); });
  await assert.rejects(submitSessionInput(session.id, { owner: 'phone', operation: 'execute', prompt: 'Blocked' }, randomUUID(), denied), { code: 'FORBIDDEN' });
  assert.equal(effectiveInputOwner(session.id).owner, 'cli'); assert.equal(listRecords('execution').length, 0);
});

test('per-session admission serializes asynchronous operations and permission checks happen again after waiting', async () => {
  let release, entered;
  const enteredFirst = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const first = submitSessionInput(session.id, { owner: 'phone', operation: 'control', action: 'pause' }, randomUUID(), {
    authorize() {}, request: async () => { entered(); await held; return { controlId: randomUUID() }; },
  });
  await enteredFirst;
  let valid = true;
  const second = submitSessionInput(session.id, { owner: 'cli', operation: 'execute', prompt: 'Should remain queued' }, randomUUID(),
    context(() => { if (!valid) throw Object.assign(new Error('Revoked'), { code: 'FORBIDDEN', status: 403 }); }));
  assert.equal(effectiveInputOwner(session.id).owner, 'phone');
  valid = false; release(); await first;
  await assert.rejects(second, { code: 'FORBIDDEN' });
  assert.equal(listRecords('execution').length, 0);
});

test('uncertain dispatch is never silently replayed', async () => {
  const id = randomUUID(), input = { owner: 'phone', operation: 'control', action: 'pause' };
  let calls = 0;
  const broken = { authorize() {}, request: async () => { calls++; throw new Error('Lost dispatch result'); } };
  await assert.rejects(submitSessionInput(session.id, input, id, broken), /Lost dispatch/);
  await assert.rejects(submitSessionInput(session.id, input, id, broken), { code: 'UNCERTAIN' });
  assert.equal(calls, 1);
});
