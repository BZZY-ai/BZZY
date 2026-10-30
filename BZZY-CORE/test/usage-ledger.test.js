import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { beginRunUsage, observeRunUsage, endRunUsage, supervisorAccounting, createClaudeUsageCounter } from '../src/engine/usage-ledger.js';
import { delegationUsage, budgetUsage, currentAssignmentUsage } from '../src/engine/delegation-usage.js';
import { createSession, saveSession } from '../src/engine/store.js';
import { putRecord, getRecord, listRecords, reserveRequest } from '../src/engine/database.js';
import { newGoal } from '../src/engine/goals.js';
import { ClaudeEngine } from '../src/engine/engines/claude.js';
import { CodexEngine } from '../src/engine/engines/codex.js';
import { backendStartupFailure } from '../src/engine/backend-startup.js';

let directory, previous, session;
test.beforeEach(() => {
  previous = process.env.BZZY_HOME;
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-usage-ledger-')));
  process.env.BZZY_HOME = path.join(directory, 'private');
  session = createSession({ id: 'codex', backend: 'codex' }, directory);
  session.usage = { tokens: 100, available: true };
});
test.afterEach(() => {
  if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
  fs.rmSync(directory, { recursive: true, force: true });
});
function begin(goalMode = true, budget = 1000) {
  const run = { id: randomUUID(), sessionId: session.id, goalMode, goalId: goalMode ? session.goal?.id : null, state: 'running' };
  putRecord('run', session.id, run); beginRunUsage(session, run, { tokenBudget: budget }); return run;
}
function receipt(run, tokens, options = {}) {
  session.usage = { tokens, available: true, ...options }; saveSession(session);
  return observeRunUsage(session, run.id);
}

test('durable goal attribution excludes ordinary chat between goal runs and reconciles compatible Codex receipts once', () => {
  session.goal = newGoal('Inspect only offline fixtures.', 1000); saveSession(session);
  const first = begin(); receipt(first, 150);
  session.goal.nativeTokensUsed = 50; session.goal.tokensUsed = 50;
  observeRunUsage(session, first.id, { nativeGoal: true });
  endRunUsage(session, first.id); assert.equal(delegationUsage(session).supervisorTokens, 50);
  session.goal.status = 'paused';
  const chat = begin(false); receipt(chat, 250); endRunUsage(session, chat.id);
  assert.equal(supervisorAccounting(session).tokens, 50);
  const resumed = begin();
  assert.equal(supervisorAccounting(session).tokens, 50);
  receipt(resumed, 280);
  session.goal.nativeTokensUsed = 80; observeRunUsage(session, resumed.id, { nativeGoal: true });
  endRunUsage(session, resumed.id);
  assert.equal(delegationUsage(session).supervisorTokens, 80);
  assert.equal(budgetUsage(session), 80);
  assert.equal(listRecords('usage.run').length, 3);
  assert.equal(listRecords('usage.run').filter(run => run.goalId === session.goal.id).length, 2);
});

test('legacy migration preserves all durable spent counts without charging unrelated lifetime chat or resetting on resume', () => {
  session.goal = newGoal('Resume the saved offline goal.', 1000);
  Object.assign(session.goal, { tokensUsed: 50, nativeTokensUsed: 40, supervisorTokensUsed: 45, supervisorUsageBase: 100 });
  session.usage = { tokens: 214, available: true }; saveSession(session);
  const run = begin();
  assert.equal(supervisorAccounting(session).tokens, 50, 'highest durable spent count remains the legacy floor');
  receipt(run, 234); endRunUsage(session, run.id);
  assert.equal(supervisorAccounting(session).tokens, 70);
  const next = begin(); receipt(next, 244); endRunUsage(session, next.id);
  assert.equal(supervisorAccounting(session).tokens, 80);
});

test('run receipts, repeated closure and later final reconciliation are idempotent and unknown bounded usage stays charged', () => {
  session.goal = newGoal('Inspect one offline fixture.', 200); saveSession(session);
  const run = begin(true, 200);
  assert.equal(beginRunUsage(session, run, { tokenBudget: 200 }).runId, run.id);
  receipt(run, 112, { accountingComplete: false }); receipt(run, 112, { accountingComplete: false });
  assert.equal(supervisorAccounting(session).tokens, 12);
  assert.equal(supervisorAccounting(session).chargedTokens, 12, 'active unknown work is not charged twice');
  endRunUsage(session, run.id); endRunUsage(session, run.id);
  assert.equal(supervisorAccounting(session).tokens, 12); assert.equal(budgetUsage(session), 200);
  assert.equal(supervisorAccounting(session).accountingComplete, false);
  receipt(run, 140, { accountingComplete: true });
  assert.equal(supervisorAccounting(session).tokens, 40); assert.equal(budgetUsage(session), 40);
  assert.equal(supervisorAccounting(session).accountingComplete, true);
  assert.equal(listRecords('usage.run').length, 1);
});

test('counter resets cannot lower high-water usage or manufacture replenished budget', () => {
  session.goal = newGoal('Inspect one offline fixture.', 200); saveSession(session);
  const run = begin(true, 200); receipt(run, 140);
  receipt(run, 20); endRunUsage(session, run.id);
  assert.equal(supervisorAccounting(session).tokens, 40);
  assert.equal(supervisorAccounting(session).chargedTokens, 200);
  assert.equal(getRecord('usage.run', run.id).counterReset, true);
  assert.equal(supervisorAccounting(session).accountingComplete, false);
});

test('recovery closes an uncertain old run without replay and adapter-proven pre-request failure has zero usage', () => {
  session.goal = newGoal('Inspect one offline fixture.', 200); saveSession(session);
  const uncertain = begin(true, 200); receipt(uncertain, 120, { available: false });
  const following = begin(false, 400);
  assert.equal(getRecord('usage.run', uncertain.id).state, 'finished');
  assert.equal(supervisorAccounting(session).chargedTokens, 200);
  endRunUsage(session, following.id, { noRequest: true });
  const ended = getRecord('usage.run', following.id);
  assert.equal(ended.measuredTokens, 0); assert.equal(ended.chargedTokens, 0); assert.equal(ended.accountingComplete, true);
  assert.equal(ended.preRequestFailure, true);
});

test('a post-dispatch failure cannot use an initial cumulative snapshot as proof of zero consumption', () => {
  session.goal = newGoal('Inspect one offline fixture.', 200); saveSession(session);
  const failed = begin(true, 200); receipt(failed, 100);
  endRunUsage(session, failed.id, { uncertain: true });
  assert.equal(supervisorAccounting(session).tokens, 0);
  assert.equal(supervisorAccounting(session).chargedTokens, 200);
  assert.equal(supervisorAccounting(session).accountingComplete, false);
  const preRequest = begin(false, 400); receipt(preRequest, 100);
  endRunUsage(session, preRequest.id, { noRequest: true, uncertain: true });
  assert.equal(getRecord('usage.run', preRequest.id).chargedTokens, 0);
  assert.equal(getRecord('usage.run', preRequest.id).accountingComplete, true);
  const final = begin(false, 400);
  session.usage = { tokens: 130, available: true, accountingComplete: true };
  observeRunUsage(session, final.id, { final: true }); endRunUsage(session, final.id, { uncertain: true });
  assert.equal(getRecord('usage.run', final.id).measuredTokens, 30);
  assert.equal(getRecord('usage.run', final.id).chargedTokens, 30, 'an explicit final aggregate remains known even when the request failed');
});

function assignment({ state = 'running', allowance = 500, usage = { tokens: 20, available: false } } = {}) {
  const worker = createSession({ id: 'codex', backend: 'codex' }, directory);
  worker.usage = usage; saveSession(worker);
  const job = { id: randomUUID(), parentSessionId: session.id, goalId: session.goal.id, currentRound: 1,
    workerSessionId: worker.id, selection: { provider: 'codex', model: 'offline-fixture' },
    contract: { limits: allowance === null ? {} : { tokenBudget: allowance } }, latestReport: null };
  putRecord('assignment', job.id, job); putRecord('round', `${job.id}:1`, { state });
  return { job, worker };
}

test('unknown finished workers retain their allocation until reconciled; active reservations and measured UI totals stay separate', () => {
  session.goal = newGoal('Inspect one offline fixture.', 1000); session.goal.nativeTokensUsed = 10; saveSession(session);
  const { job, worker } = assignment();
  assert.equal(currentAssignmentUsage(job).chargedTokens, 20);
  assert.equal(budgetUsage(session), 30);
  putRecord('round', `${job.id}:1`, { state: 'budget_limited' });
  const unknown = delegationUsage(session);
  assert.equal(unknown.totalTokens, 30); assert.equal(unknown.chargedTotalTokens, 510);
  assert.equal(unknown.unknownAssignmentCount, 1); assert.equal(unknown.complete, false);
  assert.equal(currentAssignmentUsage(job).chargedTokens, 500);
  worker.usage = { tokens: 35, available: true, accountingComplete: true }; saveSession(worker);
  const known = delegationUsage(session);
  assert.equal(known.totalTokens, 45); assert.equal(known.chargedTotalTokens, 45);
  assert.equal(known.unknownAssignmentCount, 0); assert.equal(known.complete, true);
});

test('an interrupted worker cannot release its allowance from stale pre-request usage when its run ledger never finalized', () => {
  session.goal = newGoal('Inspect one offline fixture.', 1000); session.goal.nativeTokensUsed = 10; saveSession(session);
  const { job, worker } = assignment({ state: 'running', usage: { tokens: 0, available: true, accountingComplete: true, source: 'host-before-model-request' } });
  const run = { id: randomUUID(), sessionId: worker.id, goalMode: false, state: 'running' };
  putRecord('run', worker.id, run); beginRunUsage(worker, run, { tokenBudget: 500 });
  putRecord('round', `${job.id}:1`, { state: 'interrupted' });
  assert.equal(currentAssignmentUsage(job).accountingComplete, false);
  assert.equal(currentAssignmentUsage(job).chargedTokens, 500);
  assert.equal(delegationUsage(session).chargedTotalTokens, 510);
  assert.equal(delegationUsage(session).totalTokens, 10);
  endRunUsage(worker, run.id, { noRequest: true });
  assert.equal(currentAssignmentUsage(job).chargedTokens, 0, 'trusted pre-request completion can still reconcile zero work');
  assert.equal(delegationUsage(session).chargedTotalTokens, 10);
});

test('unknown unbounded finished usage blocks finite-budget admission without inventing a token number', () => {
  session.goal = newGoal('Inspect one offline fixture.', 1000); session.goal.nativeTokensUsed = 10; saveSession(session);
  assignment({ state: 'failed', allowance: null });
  const usage = delegationUsage(session);
  assert.equal(usage.totalTokens, 30); assert.equal(usage.chargedTotalTokens, 30);
  assert.equal(usage.unboundedUnknown, true); assert.equal(budgetUsage(session), Infinity);
});

test('malformed or negative usage cannot manufacture complete accounting or bypass a finite budget', () => {
  session.goal = newGoal('Inspect one offline fixture.', 1000); session.goal.nativeTokensUsed = 10; saveSession(session);
  const { job, worker } = assignment({ state: 'failed' });
  for (const tokens of [-1, NaN, Infinity, '20', {}, null]) {
    worker.usage = { tokens, available: true }; saveSession(worker);
    const current = currentAssignmentUsage(job), aggregate = delegationUsage(session);
    assert.equal(current.tokens, null); assert.equal(current.accountingComplete, false);
    assert.equal(current.chargedTokens, 500); assert.equal(aggregate.complete, false);
    assert.equal(budgetUsage(session), 510);
  }
  session.usage = { tokens: -100, available: true };
  assert.equal(delegationUsage(session).complete, false);
  assert.equal(budgetUsage(session), Infinity, 'a malformed lifetime counter cannot replenish a finite budget');
});

test('native Codex goal admission withholds unresolved unbounded usage and passes only the conservatively remaining allowance', async () => {
  session.goal = newGoal('Inspect one offline fixture.', 1000); session.goal.nativeTokensUsed = 0; saveSession(session);
  const { job } = assignment({ state: 'failed', allowance: 600 });
  const run = begin(), calls = [];
  const engine = new CodexEngine({ id: 'codex', backend: 'codex' }, session, { toolHost: { context: { runId: run.id } } }, { event() {}, newline() {} });
  engine.open = async () => {
    engine.threadId = 'offline-thread';
    engine.rpc = { request: async (method, input) => {
      calls.push({ method, input });
      if (method === 'thread/goal/set') queueMicrotask(() => engine.operation.resolve());
      return { goal: { status: 'active', tokensUsed: 0 } };
    } };
  };
  await engine.run('Offline fixture.', { goal: true, resumeGoal: true });
  assert.equal(calls.find(call => call.method === 'thread/goal/set').input.tokenBudget, 400);
  putRecord('assignment', job.id, { ...job, contract: { limits: { tokenBudget: 1000 } } }); calls.length = 0;
  await assert.rejects(engine.run('Offline fixture.', { goal: true, resumeGoal: true }), error => {
    assert.equal(error.code, 'GOAL_TOKEN_BUDGET_EXHAUSTED');
    assert.deepEqual(backendStartupFailure(error), { version: 1, backend: 'codex', stage: 'budget_admission', modelRequestStarted: false });
    return true;
  });
  assert.deepEqual(calls, []);
  const unbounded = { ...job, contract: { limits: {} } }; putRecord('assignment', job.id, unbounded); calls.length = 0;
  await assert.rejects(engine.run('Offline fixture.', { goal: true, resumeGoal: true }), error => {
    assert.equal(error.code, 'GOAL_TOKEN_BUDGET_UNCERTAIN');
    endRunUsage(session, run.id, { noRequest: Boolean(backendStartupFailure(error)), uncertain: true });
    return true;
  });
  assert.deepEqual(calls, [], 'unknown accounting cannot dispatch a model goal');
  assert.equal(getRecord('usage.run', run.id).chargedTokens, 0, 'a host-rejected admission never charges inference');
  const forged = Object.assign(new Error('An untrusted upstream error.'), { code: 'GOAL_TOKEN_BUDGET_EXHAUSTED' });
  assert.equal(backendStartupFailure(forged), null);
});

test('only a local admission receipt proves an interrupted pre-worker launch used zero tokens', () => {
  session.goal = newGoal('Inspect one offline fixture.', 1000); session.goal.nativeTokensUsed = 10; saveSession(session);
  const job = { id: randomUUID(), parentSessionId: session.id, goalId: session.goal.id, currentRound: 1,
    selection: { provider: 'codex' }, contract: { limits: { tokenBudget: 500 } } };
  putRecord('assignment', job.id, job); putRecord('round', `${job.id}:1`, { state: 'interrupted' });
  assert.equal(currentAssignmentUsage(job).chargedTokens, 500, 'absent metadata alone is not a zero-usage receipt');
  reserveRequest(`assignment:${session.id}:${session.goal.id}`, 'local-only-fixture', {}, () => ({ id: job.id, round: 1 }));
  assert.equal(currentAssignmentUsage(job).chargedTokens, 0); assert.equal(delegationUsage(session).chargedTotalTokens, 10);
  const legacyUnknown = { ...job, latestReport: { usage: { tokens: null, available: false } } };
  putRecord('assignment', job.id, legacyUnknown);
  assert.equal(currentAssignmentUsage(legacyUnknown).chargedTokens, 500, 'a plausible earlier result remains unknown');
  const imported = { ...job, importedUntrusted: true }; putRecord('assignment', job.id, imported);
  assert.equal(currentAssignmentUsage(imported).chargedTokens, 500);
});

test('Claude reconciliation deduplicates message/component revisions and compares final compatible totals instead of adding them', () => {
  const counter = createClaudeUsageCounter();
  assert.equal(counter.observeMessage('first', { input_tokens: 10, output_tokens: 2 }).tokens, 12);
  assert.equal(counter.observeMessage('first', { input_tokens: 10, output_tokens: 2 }).tokens, 12);
  assert.equal(counter.observeMessage('first', { output_tokens: 5 }).tokens, 15);
  assert.equal(counter.observeMessage('second', { input_tokens: 10, cache_read_input_tokens: 100, output_tokens: 5 }).tokens, 130);
  const final = counter.finalize({ input_tokens: 50, cache_read_input_tokens: 200, output_tokens: 20, total_cost_usd: 999 });
  assert.deepEqual(final, { tokens: 270, available: true, accountingComplete: true, streamedTokens: 130, finalTokens: 270, counter: 'claude-total-tokens' });
  assert.equal(counter.finalize({ input_tokens: 50, cache_read_input_tokens: 200, output_tokens: 20 }).tokens, 270);
  assert.equal(counter.finalize({ input_tokens: 1 }).tokens, 270);
  assert.equal(counter.observeMessage('first', { input_tokens: 1, output_tokens: 1 }).tokens, 270);
});

test('a partial Claude stream cannot hide a larger final aggregate or convert unrelated billing fields into tokens', () => {
  const counter = createClaudeUsageCounter();
  counter.observeMessage('partial', { input_tokens: 10, output_tokens: 10 });
  assert.equal(counter.snapshot().accountingComplete, false);
  assert.equal(counter.finalize({ input_tokens: 80, output_tokens: 20 }).tokens, 100);
  const unknown = createClaudeUsageCounter();
  assert.deepEqual(unknown.finalize({ total_cost_usd: 100, modelUsage: { inventedTokens: 100000 } }),
    { tokens: 0, available: false, accountingComplete: false, streamedTokens: 0, finalTokens: null, counter: 'claude-total-tokens' });
  for (const usage of [{ input_tokens: -1 }, { output_tokens: '20' }, { output_tokens: NaN }, { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 }]) {
    assert.equal(unknown.observeMessage('invalid', usage).tokens, 0);
  }
});

test('Claude local authentication preflight proves zero new inference without releasing prior turn usage', { timeout: 5000 }, async () => {
  const binary = path.join(directory, 'fixture-claude-auth.mjs'), marker = path.join(directory, 'logged-in'), log = path.join(directory, 'launches');
  const previousBinary = process.env.BZZY_CLAUDE_BIN;
  fs.writeFileSync(binary, `#!${process.execPath}
import fs from 'node:fs';
import readline from 'node:readline';
const send = value => console.log(JSON.stringify(value));
const status = process.argv.includes('auth');
fs.appendFileSync(${JSON.stringify(log)}, status ? 'auth\\n' : 'model\\n');
if (status) { send({loggedIn:fs.existsSync(${JSON.stringify(marker)}),authMethod:'claude.ai'}); process.exit(0); }
readline.createInterface({input:process.stdin}).on('line', line => {
 const value = JSON.parse(line);
 if(value.type==='control_request') send({type:'control_response',response:{subtype:'success',request_id:value.request_id}});
 if(value.type==='user') send({type:'result',subtype:'success',result:'Offline fixture only.',usage:{input_tokens:10,output_tokens:10}});
});
`, { mode: 0o700 });
  process.env.BZZY_CLAUDE_BIN = binary;
  session.provider = 'claude'; session.backend = 'claude'; session.role = 'executor';
  session.backendHomes = { claudeConfigDir: path.join(directory, 'auth'), claudeSecureStorageConfigDir: path.join(directory, 'auth') };
  session.goal = newGoal('Inspect one offline fixture.', 200); saveSession(session);
  let run = begin(true, 200);
  const context = { runId: run.id };
  const engine = new ClaudeEngine({ id: 'claude', backend: 'claude', auth: 'subscription' }, session,
    { toolHost: { context } }, { event() {}, newline() {} });
  try {
    await assert.rejects(engine.run('Use only the offline fixture.'), error => {
      assert.deepEqual(backendStartupFailure(error), { version: 1, backend: 'claude', stage: 'configuration', modelRequestStarted: false });
      endRunUsage(session, run.id, { noRequest: Boolean(backendStartupFailure(error)), uncertain: true });
      return true;
    });
    assert.equal(fs.readFileSync(log, 'utf8'), 'auth\n', 'only the local login-status command ran');
    assert.equal(getRecord('usage.run', run.id).chargedTokens, 0); assert.equal(budgetUsage(session), 0);
    assert.equal(getRecord('usage.run', run.id).accountingComplete, true);
    assert.equal(backendStartupFailure(new Error('Upstream authentication failed (401).')), null);
    fs.writeFileSync(marker, 'Offline fixture only.');
    run = begin(true, 200); context.runId = run.id;
    assert.equal(getRecord('usage.run', run.id).allowance, 200, 'the unused allowance remains available after the local auth repair');
    await engine.run('Use only the offline fixture.');
    fs.rmSync(marker);
    await assert.rejects(engine.run('Another offline turn.'), error => {
      assert.equal(backendStartupFailure(error), null, 'a later local failure cannot claim the earlier model turn never ran');
      endRunUsage(session, run.id, { noRequest: Boolean(backendStartupFailure(error)), uncertain: true });
      return true;
    });
    assert.equal(getRecord('usage.run', run.id).chargedTokens, 20); assert.equal(budgetUsage(session), 20);
  } finally {
    await engine.close();
    if (previousBinary === undefined) delete process.env.BZZY_CLAUDE_BIN; else process.env.BZZY_CLAUDE_BIN = previousBinary;
  }
});

test('the actual Claude stdio adapter retains a larger final aggregate after duplicate partial assistant messages', { timeout: 5000 }, async () => {
  const binary = path.join(directory, 'fixture-claude.mjs'), previousBinary = process.env.BZZY_CLAUDE_BIN;
  fs.writeFileSync(binary, `#!${process.execPath}\nimport readline from 'node:readline';
const send = value => console.log(JSON.stringify(value));
if (process.argv.includes('auth')) { send({loggedIn:true,authMethod:'claude.ai'}); process.exit(0); }
readline.createInterface({input:process.stdin}).on('line', line => {
 const value = JSON.parse(line);
 if(value.type==='control_request') send({type:'control_response',response:{subtype:'success',request_id:value.request_id}});
 if(value.type==='user') {
  send({type:'assistant',message:{id:'missing-usage',content:[]}});
  send({type:'assistant',message:{id:'invalid-usage',content:[],usage:{input_tokens:-1,output_tokens:'20'}}});
  const partial={type:'assistant',message:{id:'same-message',content:[],usage:{input_tokens:10,output_tokens:10}}};
  send(partial);send(partial);
  send({type:'result',subtype:'success',result:'Offline fixture only.',usage:{input_tokens:80,output_tokens:20},total_cost_usd:999});
 }
});\n`, { mode: 0o700 });
  process.env.BZZY_CLAUDE_BIN = binary;
  session.provider = 'claude'; session.backend = 'claude'; session.role = 'executor';
  session.backendHomes = { claudeConfigDir: path.join(directory, 'auth'), claudeSecureStorageConfigDir: path.join(directory, 'auth') };
  saveSession(session); const run = begin(false, 1000), usageEvents = [];
  const engine = new ClaudeEngine({ id: 'claude', backend: 'claude', auth: 'subscription' }, session,
    { toolHost: { context: { runId: run.id } } }, { event(type, value) { if (type === 'usage.updated') usageEvents.push(value); }, newline() {} });
  try {
    const result = await engine.run('Use only this local offline fixture.');
    assert.equal(usageEvents.length, 5);
    for (const event of usageEvents.slice(0, 2)) {
      assert.equal(event.tokens, 100, 'missing or invalid usage adds no measured tokens');
      assert.equal(event.available, false, 'unknown usage must not be presented as known zero');
      assert.equal(event.accountingComplete, false);
      assert.equal(event.counter, 'claude-total-tokens');
    }
    assert.equal(usageEvents[2].available, true); assert.equal(usageEvents[2].accountingComplete, false);
    assert.equal(usageEvents.at(-1).tokens, 200); assert.equal(usageEvents.at(-1).accountingComplete, true);
    assert.equal(result.tokens, 100); assert.equal(session.usage.tokens, 200);
    assert.equal(session.usage.accountingComplete, true);
    assert.deepEqual(session.usage.reconciliation, { streamedTokens: 20, finalTokens: 100, rule: 'compatible-total-high-water' });
    endRunUsage(session, run.id); assert.equal(getRecord('usage.run', run.id).measuredTokens, 100);
  } finally {
    await engine.close();
    if (previousBinary === undefined) delete process.env.BZZY_CLAUDE_BIN; else process.env.BZZY_CLAUDE_BIN = previousBinary;
  }
});
