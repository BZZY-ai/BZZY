import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { putRecord, listRecords, appendEvent } from '../src/engine/database.js';
import { beginSessionCost, observeSessionCost, sessionSpending, deepseekSpendingVisible } from '../src/engine/session-cost.js';
import { beginCompactionCost, observeCompactionCost, finishCompactionCost } from '../src/engine/compaction-cost.js';
import { sessionMetrics } from '../src/engine/session-metrics.js';

let directory, previous;
test.beforeEach(t => {
  previous = process.env.BZZY_HOME; directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-session-cost-'));
  process.env.BZZY_HOME = directory;
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-28T12:00:00Z') });
});
test.afterEach(() => {
  if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
  fs.rmSync(directory, { recursive: true, force: true });
});
const total = (multiplier = 1) => ({ inputTokens: 10000 * multiplier, cachedInputTokens: 8000 * multiplier,
  outputTokens: 1000 * multiplier, totalTokens: 11000 * multiplier });
const source = (extra = {}) => ({ id: 'chat', provider: 'deepseek', model: 'deepseek-flash', ...extra });
function add(session, threadId = 'thread', multiplier = 1, last) {
  return observeSessionCost(session, { threadId, tokenUsage: { total: total(multiplier), ...(last ? { last } : {}) } });
}
test('only the official provider identity enables Solo or either Delegate role', () => {
  assert.equal(deepseekSpendingVisible(source()), true);
  assert.equal(deepseekSpendingVisible(source({ mode: 'delegate', provider: 'codex', executor: { provider: 'deepseek' } })), true);
  assert.equal(deepseekSpendingVisible(source({ mode: 'delegate', executor: { provider: 'claude' } })), true);
  for (const provider of ['codex', 'claude', 'orcarouter', 'experiential']) {
    assert.equal(deepseekSpendingVisible(source({ provider })), false);
    const other = source({ provider }); beginSessionCost(other, { threadId: provider, resumed: false }); add(other, provider);
  }
  assert.equal(deepseekSpendingVisible(source({ mode: 'parallel' })), false);
  assert.equal(listRecords('core.session.spending.receipt').length, 0);
});
test('chat charges cumulative deltas once, preserving prior model prices across switches and reopen', () => {
  const session = source(); beginSessionCost(session, { threadId: 'thread', resumed: false }); add(session); add(session);
  assert.equal(sessionSpending(session.id).chat.estimatedUsd.min, 0.000924);
  session.model = 'deepseek-v4-pro'; add(session, 'thread', 2);
  const before = sessionSpending(session.id); assert.ok(Math.abs(before.chat.estimatedUsd.min - 0.0044) < 1e-12);
  session.provider = 'codex'; add(session, 'thread', 3);
  assert.deepEqual(sessionSpending(session.id), before);
  session.provider = 'deepseek'; beginSessionCost(session, { threadId: 'thread', resumed: true }); add(session, 'thread', 2);
  assert.deepEqual(sessionSpending(session.id), before);
});
test('Codex brain plus direct DeepSeek executor roll up with compactor costs, excluding gateways and unrelated chats', () => {
  const parent = source({ provider: 'codex', mode: 'delegate', executor: { provider: 'deepseek' } }); putRecord('session', parent.id, parent);
  const worker = source({ id: 'hands', parentSessionId: parent.id, assignmentId: 'assignment', role: 'executor' });
  putRecord('session', worker.id, worker);
  putRecord('assignment', 'assignment', { id: 'assignment', parentSessionId: parent.id, workerSessionId: worker.id, chatRunId: 'run' });
  beginSessionCost(worker, { threadId: 'hands-thread', resumed: false }); add(worker, 'hands-thread');
  const unrelated = source({ id: 'unrelated' }); beginSessionCost(unrelated, { threadId: 'other', resumed: false }); add(unrelated, 'other');
  const draft = { id: 'summary', documentTaskKind: 'session-compaction', documentTaskId: 'job', documentSourceSessionId: parent.id };
  beginCompactionCost(draft, source()); observeCompactionCost(draft, { provider: 'deepseek', model: 'deepseek-flash', detail: total() });
  finishCompactionCost(draft, { completed: true });
  const cost = sessionMetrics(parent.id).spending;
  assert.equal(cost.chat.estimatedUsd.min, 0.000924); assert.equal(cost.compactor.estimatedUsd.min, 0.000924);
  assert.equal(cost.total.estimatedUsd.min, 0.001848); assert.equal(cost.total.complete, true);
});
test('resuming older native history never prices its whole cumulative total as a new request', () => {
  const session = source(); beginSessionCost(session, { threadId: 'old', resumed: true }); add(session, 'old', 10, total());
  const cost = sessionSpending(session.id); assert.equal(cost.chat.historical, true);
  assert.equal(cost.chat.estimatedUsd.min, 0.000924); assert.equal(cost.total.complete, false);
  const unknown = source({ id: 'missing-last' }); beginSessionCost(unknown, { threadId: 'old', resumed: true }); add(unknown, 'old', 10);
  assert.equal(sessionSpending(unknown.id).chat.estimatedUsd, null); assert.equal(sessionSpending(unknown.id).total.estimatedUsd, null);
  add(unknown, 'old', 11); assert.equal(sessionSpending(unknown.id).chat.estimatedUsd.min, 0.000924);
});
test('legacy and interrupted usage remain partial without dollar charges for reserved tokens', () => {
  putRecord('session', 'old-without-events', source({ id: 'old-without-events', usage: { tokens: 1000000, available: true } }));
  assert.equal(sessionSpending('old-without-events').chat.estimatedUsd, null);
  assert.equal(sessionSpending('old-without-events').chat.historical, true);
  appendEvent('chat', 'usage.updated', { provider: 'deepseek', tokens: 1000000, detail: total(100) });
  putRecord('usage.run', 'run', { sessionId: 'chat', provider: 'deepseek', state: 'finished', accountingComplete: false, chargedTokens: 20000 });
  const cost = sessionSpending('chat'); assert.equal(cost.chat.historical, true); assert.equal(cost.chat.incompleteRuns, 1);
  assert.equal(cost.chat.estimatedUsd, null); assert.equal(cost.total.estimatedUsd, null);
});

test('linked document helpers belong to Chat while the compactor cannot be counted in both subtotals', () => {
  const helper = source({ id: 'helper', role: 'learning-review', purpose: 'document', documentSourceSessionId: 'chat' });
  beginSessionCost(helper, { threadId: 'helper-thread', resumed: false }); add(helper, 'helper-thread');
  assert.equal(sessionSpending('chat').chat.estimatedUsd.min, 0.000924);
  const compactor = { ...helper, id: 'compactor', documentTaskKind: 'session-compaction' };
  beginSessionCost(compactor, { threadId: 'compactor-thread', resumed: false }); add(compactor, 'compactor-thread');
  assert.equal(sessionSpending('chat').chat.estimatedUsd.min, 0.000924);
  assert.equal(listRecords('core.session.spending.receipt').length, 1);
});
