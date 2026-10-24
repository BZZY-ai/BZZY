import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSession, saveSession, loadSession } from '../src/engine/store.js';
import { BUILTINS, saveModeDefault } from '../src/engine/providers.js';
import { newGoal } from '../src/engine/goals.js';
import { claimInput, effectiveInputOwner } from '../src/engine/runtime.js';
import { submitSessionInput } from '../src/engine/session-input.js';
import { getRecord, putRecord, listRecords, events } from '../src/engine/database.js';
import { Coordinator } from '../src/engine/coordination.js';
import { setSessionMode } from '../src/engine/session-operations.js';

let directory, previous, session;
const agents = [{ provider: 'codex', model: 'fixture-brain', effort: 'high' }, { provider: 'claude', model: 'fixture-peer', effort: 'default' }];
test.beforeEach(() => {
  previous = process.env.BZZY_HOME; directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-mode-'));
  process.env.BZZY_HOME = path.join(directory, 'private'); session = createSession(BUILTINS.codex, directory, 'original', 'Same chat');
  for (const mode of ['delegate', 'debate', 'parallel', 'besties']) saveModeDefault(mode, agents);
});
test.afterEach(() => { if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous; fs.rmSync(directory, { recursive: true, force: true }); });
const context = { authorize() {}, request: async () => { throw new Error('Mode selection must not execute or call a provider.'); } };
const change = (mode, id = randomUUID()) => submitSessionInput(session.id, { owner: 'phone', operation: 'mode', mode, expectedUpdatedAt: loadSession(session.id).updatedAt }, id, context);

test('unpaused mode requests cannot take input or queue work; all five paused modes retain one chat and goal', async () => {
  claimInput(session.id, 'cli'); await assert.rejects(change('parallel'), { code: 'CONFLICT' });
  assert.equal(effectiveInputOwner(session.id).owner, 'cli');
  session.executionState = 'paused'; session.goal = { ...newGoal('Keep this objective'), status: 'paused', tokensUsed: 41, evidence: ['original-evidence'] };
  session.policy = { mode: 'read-only' }; session.contract = { limits: { concurrency: 3 } }; saveSession(session);
  const original = structuredClone(session), inputId = randomUUID();
  for (const mode of ['parallel', 'besties', 'debate', 'delegate', 'solo']) {
    const receipt = await change(mode, mode === 'parallel' ? inputId : randomUUID());
    const current = loadSession(session.id);
    assert.deepEqual(receipt, { sessionId: session.id, mode });
    assert.equal(current.mode, mode); assert.equal(current.executionState, 'paused');
    assert.equal(current.goal.id, original.goal.id); assert.equal(current.goal.tokensUsed, 41);
    assert.deepEqual(current.goal.evidence, original.goal.evidence); assert.deepEqual(current.policy, original.policy);
    assert.equal(current.cwd, original.cwd); assert.equal(current.alias, original.alias);
  }
  assert.equal(loadSession(session.id).model, 'original'); assert.equal(listRecords('execution').length, 0);
  const accepted = listRecords('input-intent').find(row => row.requestId === inputId);
  const active = loadSession(session.id); active.executionState = 'running'; saveSession(active);
  const replay = await submitSessionInput(session.id, { owner: 'phone', operation: 'mode', mode: 'parallel', expectedUpdatedAt: 'different' }, inputId, context).catch(error => error);
  assert.equal(replay.code, 'CONFLICT', 'different revision is different request content');
  const input = { owner: 'phone', operation: 'mode', mode: 'parallel', expectedUpdatedAt: original.updatedAt };
  // The first transition used exactly this revision.
  assert.equal(accepted.state, 'accepted');
  assert.deepEqual(await submitSessionInput(session.id, input, inputId, context), { sessionId: session.id, mode: 'parallel' });
});

test('mode changes reject stale revisions and outstanding workers, and never increase a concurrency boundary', async () => {
  session.executionState = 'paused'; session.contract = { limits: { concurrency: 1 } }; saveSession(session); claimInput(session.id, 'phone');
  await assert.rejects(change('besties'), /concurrent peers/);
  const current = loadSession(session.id);
  assert.throws(() => setSessionMode(session.id, 'phone', { mode: 'parallel', selection: { agents }, expectedUpdatedAt: 'stale' }), { code: 'CONFLICT' });
  const child = createSession(BUILTINS.codex, directory); child.parentSessionId = session.id; saveSession(child);
  putRecord('execution', 'queued-child', { id: 'queued-child', sessionId: child.id, state: 'queued' });
  await assert.rejects(change('parallel'), /executing|active|idle|busy|running/i);
  assert.equal(loadSession(session.id).mode, current.mode); assert.equal(events(session.id).filter(event => event.type === 'mode.changed').length, 0);
});

test('a new group generation retains spent tokens, and an unchanged group resumes with its original budget offset', () => {
  session.mode = 'parallel'; session.modeRevision = 2; session.goal = { ...newGoal('same goal'), tokensUsed: 70, supervisorTokensUsed: 70 };
  putRecord('parallel', session.id, { goalId: session.goal.id, modeRevision: 1, tokenOffset: 5 });
  const fresh = new Coordinator(session, {}, {}); assert.equal(fresh.tokenOffset, 70);
  putRecord('parallel', session.id, { goalId: session.goal.id, modeRevision: 2, tokenOffset: 40 });
  assert.equal(new Coordinator(session, {}, {}).tokenOffset, 40);
  session.mode = 'debate'; assert.equal(new Coordinator(session, {}, {}).tokenOffset, 70);
});
