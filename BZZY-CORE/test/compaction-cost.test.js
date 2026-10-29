import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { database, getRecord, putRecord } from '../src/engine/database.js';
import { beginCompactionCost, observeCompactionCost, finishCompactionCost, sessionCompactionCost,
  normalizeCompactionTokens } from '../src/engine/compaction-cost.js';

const KIND = 'core.session.compactor.cost', JOB = 'core.session.compactor.job';
let directory, previous;
test.beforeEach(t => {
  previous = process.env.BZZY_HOME; directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-compaction-cost-'));
  process.env.BZZY_HOME = directory;
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-28T12:00:00Z') });
});
test.afterEach(() => {
  if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
  fs.rmSync(directory, { force: true, recursive: true });
});
function draft(sessionId = 'source', provider = 'deepseek', model = 'deepseek-flash', jobId = randomUUID()) {
  const value = { id: randomUUID(), provider, model, documentTaskKind: 'session-compaction',
    documentTaskId: jobId, documentSourceSessionId: sessionId };
  beginCompactionCost(value, { provider, model }); return value;
}
function usage(value, input = 10000, cached = 8000, output = 1000) {
  observeCompactionCost(value, { provider: value.provider, model: value.model,
    detail: { inputTokens: input, cachedInputTokens: cached, outputTokens: output, totalTokens: input + output, reasoningOutputTokens: 400 } });
}
test('cache is a subset of input and reasoning is already part of output', () => {
  const value = draft(); usage(value); finishCompactionCost(value, { completed: true });
  const cost = sessionCompactionCost('source');
  assert.deepEqual(cost.estimatedUsd, { min: 0.000924, max: 0.000924 });
  assert.equal(cost.complete, true); assert.equal(cost.reportedTokens, 11000);
  assert.equal(normalizeCompactionTokens({ inputTokens: 10, outputTokens: 3, totalTokens: 14 }), null);
  assert.equal(normalizeCompactionTokens({ inputTokens: 10, cachedInputTokens: 11, outputTokens: 3 }), null);
  assert.equal(normalizeCompactionTokens({ inputTokens: -1, outputTokens: 3 }), null);
});
test('cumulative duplicate events and finalization never add a second charge; source chats stay separate', () => {
  const value = draft(); usage(value); usage(value); usage(value, 20000, 18000, 2000);
  finishCompactionCost(value, { completed: true }); const first = sessionCompactionCost('source');
  finishCompactionCost(value, { completed: true }); usage(value, 50000, 0, 5000);
  assert.deepEqual(sessionCompactionCost('source'), first); assert.equal(first.attempts, 1);
  assert.equal(sessionCompactionCost('another-chat').attempts, 0);
  assert.deepEqual(first.estimatedUsd, { min: 0.001554, max: 0.001554 });
});
test('Flash and Pro attempts retain their prices across model changes, retries and reopening', () => {
  const jobId = randomUUID();
  putRecord(JOB, jobId, { id: jobId, sessionId: 'source', attempts: 2, selection: { provider: 'deepseek', model: 'deepseek-flash' } });
  const first = draft('source', 'deepseek', 'deepseek-flash', jobId); usage(first); finishCompactionCost(first, { completed: true });
  const second = draft('source', 'deepseek', 'deepseek-v4-pro', jobId); usage(second); finishCompactionCost(second, { completed: true });
  putRecord('session', 'source', { id: 'source', provider: 'codex', model: 'different-model' });
  const cost = sessionCompactionCost('source'); assert.equal(cost.attempts, 2); assert.equal(cost.legacyAttempts, 0);
  assert.equal(cost.models.length, 2); assert.equal(cost.complete, true);
  assert.ok(Math.abs(cost.estimatedUsd.min - (0.000924 + 0.003476)) < 1e-12);
  assert.equal(getRecord(KIND, first.id).pricing.version, 'deepseek-2026-10-28');
  const before = database().prepare('SELECT count(*) AS count FROM records').get().count;
  assert.deepEqual(sessionCompactionCost('source'), cost);
  assert.equal(database().prepare('SELECT count(*) AS count FROM records').get().count, before);
});
test('older totals and conservative reservations are unpriced, including more than the status job page', () => {
  for (let index = 0; index < 45; index++) putRecord(JOB, `old-${index}`, { id: `old-${index}`, sessionId: 'source', attempts: 1,
    state: 'completed', totalTokensUsed: 20000, usage: { tokens: null, chargedTokens: 20000, conservative: true },
    selection: { provider: 'deepseek', model: 'deepseek-flash' } });
  const cost = sessionCompactionCost('source');
  assert.equal(cost.estimatedUsd, null); assert.equal(cost.legacyAttempts, 45); assert.equal(cost.unpricedAttempts, 45);
  assert.equal(cost.summaries, 45); assert.equal(cost.reportedTokens, 0); assert.equal(cost.complete, false);
  const next = draft(); usage(next); finishCompactionCost(next, { completed: true });
  assert.equal(sessionCompactionCost('source').attempts, 46);
  assert.deepEqual(sessionCompactionCost('source').estimatedUsd, { min: 0.000924, max: 0.000924 });
});
test('unfinished requests and counter resets remain partial, while unsupported models are unpriced', () => {
  const pending = draft(); usage(pending); finishCompactionCost(pending);
  let cost = sessionCompactionCost('source'); assert.equal(cost.incompleteAttempts, 1); assert.equal(cost.complete, false);
  assert.equal(cost.estimatedUsd.min, 0.000924);
  const reset = draft(); usage(reset); usage(reset, 100, 0, 10); finishCompactionCost(reset, { completed: true });
  assert.equal(getRecord(KIND, reset.id).counterReset, true);
  const other = draft('source', 'deepseek', 'unknown-future-model'); usage(other); finishCompactionCost(other, { completed: true });
  const subscription = draft('source', 'codex', 'subscription-model'); finishCompactionCost(subscription);
  cost = sessionCompactionCost('source'); assert.equal(cost.attempts, 4); assert.equal(cost.unpricedAttempts, 2);
  assert.equal(cost.incompleteAttempts, 3); assert.equal(cost.complete, false);
});
test('peak/holiday uncertainty and missing cache counters produce ranges', t => {
  t.mock.timers.setTime(Date.parse('2026-10-28T01:00:00Z'));
  const value = draft(); usage(value); finishCompactionCost(value, { completed: true });
  assert.deepEqual(sessionCompactionCost('source').estimatedUsd, { min: 0.000924, max: 0.001848 });
  t.mock.timers.setTime(Date.parse('2026-10-28T12:00:00Z'));
  const missing = draft('cache-unknown');
  observeCompactionCost(missing, { provider: 'deepseek', model: 'deepseek-flash', detail: { inputTokens: 10000, outputTokens: 1000 } });
  finishCompactionCost(missing, { completed: true });
  assert.deepEqual(sessionCompactionCost('cache-unknown').estimatedUsd, { min: 0.00063, max: 0.0021 });
});
test('a proven pre-request failure is zero; a changed resolved model is never priced as the old one', () => {
  const zero = draft(); finishCompactionCost(zero, { noInference: true });
  assert.deepEqual(sessionCompactionCost('source').estimatedUsd, { min: 0, max: 0 });
  const changed = draft('changed'); usage(changed); changed.resolvedModel = 'unknown-future-model';
  finishCompactionCost(changed, { completed: true });
  assert.equal(sessionCompactionCost('changed').estimatedUsd, null);
});
