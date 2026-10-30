import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSession, saveSession } from '../src/engine/store.js';
import { getProvider } from '../src/engine/providers.js';
import { getRecord, putRecord } from '../src/engine/database.js';
import { assignmentHandoff } from '../src/engine/assignment-handoff.js';
import { CodexEngine } from '../src/engine/engines/codex.js';

let directory, previous, worker, job;
test.beforeEach(() => {
  previous = process.env.BZZY_HOME;
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-handoff-')));
  process.env.BZZY_HOME = path.join(directory, 'private');
  worker = createSession(getProvider('codex'), directory, 'offline-fixture');
  job = { id: 'assignment', parentSessionId: 'parent', contract: { objective: 'Inspect only the offline control.' } };
  Object.assign(worker, { assignmentId: job.id, assignmentRound: 2, parentSessionId: job.parentSessionId }); saveSession(worker);
});
test.afterEach(() => {
  if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
  fs.rmSync(directory, { recursive: true, force: true });
});

test('a host receipt is bounded, masks complete values and distinguishes observations from a worker claim', () => {
  const long = '文'.repeat(3000) + ' password="private-fixture-password"';
  putRecord('checkpoint', worker.id, { revision: 4, scope: { assignmentId: job.id, assignmentRound: 2 },
    decisions: Array(50).fill(long), completedWork: Array(50).fill(long), pendingActions: [], unresolvedQuestions: Array(50).fill(long) });
  for (const round of [1, 2]) putRecord('core.episode.observation', 'observation-' + round,
    { sessionId: worker.id, assignmentId: job.id, assignmentRound: round, sourceSeq: round, name: 'commandExecution', outcome: 'succeeded' });
  const result = assignmentHandoff(job, worker, 2, { stopReason: 'token_limit', report: { status: 'partial', nextSteps: [] },
    artifacts: Array.from({ length: 30 }, (_, i) => ({ id: 'artifact-' + i, label: long, sha256: 'a'.repeat(64) })),
    changes: Array.from({ length: 30 }, () => ({ path: long })) });
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 8192);
  assert.equal(result.missingReport, false); assert.equal(result.state, 'incomplete'); assert.equal(result.report, undefined);
  assert.match(result.remainingChecks[0], /Not fully recorded/); assert.equal(result.omittedDetails, true);
  assert.equal(result.attempts.length, 1); assert.equal(result.attempts[0].id, 'observation-2');
  assert.ok(!JSON.stringify(result).includes('private-fixture-password'));
  assert.equal(getRecord('checkpoint', worker.id).decisions.length, 50);
});

test('a prior round checkpoint and another worker scope never become current progress', () => {
  putRecord('checkpoint', worker.id, { revision: 1, scope: { assignmentId: job.id, assignmentRound: 1 }, completedWork: ['Historical result'] });
  assert.equal(assignmentHandoff(job, worker, 2).checkpoint, null);
  assert.equal(assignmentHandoff(job, worker, 1), null);
  assert.equal(assignmentHandoff({ ...job, parentSessionId: 'other-parent' }, worker, 2), null);
});

test('input headroom follows one native thread across reconnects and resets its delta on thread rotation', () => {
  const engine = new CodexEngine(getProvider('codex'), worker, {}, { event() {} });
  const usage = (threadId, inputTokens, totalTokens, last) => engine.notification('thread/tokenUsage/updated',
    { threadId, tokenUsage: { total: { inputTokens, totalTokens }, ...(last == null ? {} : { last: { inputTokens: last } }) } });
  usage('first', 37448, 37741); assert.equal(worker.usage.lastRequestInputTokens, 37448);
  usage('first', 75406, 76201); assert.equal(worker.usage.lastRequestInputTokens, 37958);
  const reconnected = new CodexEngine(getProvider('codex'), worker, {}, { event() {} });
  reconnected.notification('thread/tokenUsage/updated', { threadId: 'first', tokenUsage: { total: { inputTokens: 110000, totalTokens: 111000 } } });
  assert.equal(worker.usage.lastRequestInputTokens, 34594);
  worker.engineTokenOffset = worker.usage.tokens;
  usage('second', 120000, 121000); assert.equal(worker.usage.lastRequestInputTokens, 120000);
  assert.equal(worker.usage.tokens, 232000);
  usage('second', 150000, 151000, 29800); assert.equal(worker.usage.lastRequestInputTokens, 29800);
});

test('an exhausted worker allowance is rejected before an exposed backend dispatch', async () => {
  worker.usage = { tokens: 76201, available: true };
  const engine = new CodexEngine(getProvider('codex'), worker, { tokenBudget: 60000 }, { event() {} });
  engine.open = async () => assert.fail('Exhausted work must not open a backend.');
  await engine.run('Continue the offline control.');
  assert.equal(engine.stopReason, 'token_limit'); assert.equal(worker.usage.tokens, 76201);
});
