import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { CoreAssistant } from '../src/assistant.js';
import { CoreKnowledge } from '../src/knowledge.js';
import { appendEvent, getRecord, putRecord, listRecords, events } from '../src/engine/database.js';
import { createSession, loadSession, saveSession, setSessionAlias } from '../src/engine/store.js';
import { getProvider } from '../src/engine/providers.js';
import { deleteTerminalConversation } from '../src/engine/session-deletion.js';
import { processIdentity, identityAlive, signalProcess } from '../src/engine/process-identity.js';
import { runRestrictedDocumentModel } from '../src/engine/document-model.js';
import { indexSessionMemory, readSessionMemory, resetSessionMemory, sessionMemoryStatus } from '../src/engine/session-memory.js';
import { queueSessionCompaction, processSessionCompactions, sessionCompactionSettings, configureSessionCompaction,
  sessionCompactionStatus, sessionCompactionUsage, pauseSessionCompaction, pauseAllSessionCompactions,
  controlSessionCompaction, recoverSessionCompactions } from '../src/engine/session-compactor.js';

const JOB = 'core.session.compactor.job';
let root, session, previous;
const variables = ['BZZY_HOME', 'DEEPSEEK_API_KEY'];
test.beforeEach(() => {
  previous = Object.fromEntries(variables.map(key => [key, process.env[key]]));
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-compactor-')));
  process.env.BZZY_HOME = path.join(root, 'private');
  process.env.DEEPSEEK_API_KEY = 'synthetic-compactor-fixture-value';
  new CoreAssistant().configure({ source: 'core', provider: 'deepseek', model: getProvider('deepseek').model, effort: 'low' }, { requestId: randomUUID(), expectedRevision: 0 });
  const cwd = path.join(root, 'project'); fs.mkdirSync(cwd);
  session = createSession(getProvider('codex'), cwd, 'main-chat-model', 'fixture');
  session.goal = { id: 'fixture-goal', status: 'active', objective: 'Check controlled observations.' }; saveSession(session);
});
test.afterEach(() => {
  for (const key of variables) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
  fs.rmSync(root, { recursive: true, force: true });
});
function queue(target = session, { text, count = 8 } = {}) {
  for (let index = 0; index < count; index++) appendEvent(target.id, index % 2 ? 'text' : 'message.user', {
    text: text || `Observation ${index}: ${'A controlled baseline and unresolved response must remain inconclusive. '.repeat(7)}` });
  return queueSessionCompaction(target, { force: true });
}
const summary = (tokens = 100) => ({ text: 'Objective: compare authorization controls. Events retain inconclusive observations; ownership verification is unresolved.', tokens, usageAvailable: true });
const job = (target = session) => listRecords(JOB, { sessionId: target.id })[0];
const resume = (target = session) => controlSessionCompaction(target, 'resume', { expectedRevision: sessionCompactionStatus(target).control.revision });

test('compactor inherits Core coordinator selection independently from the foreground, with CAS budgets', () => {
  const settings = sessionCompactionSettings();
  assert.equal(settings.provider, 'deepseek'); assert.equal(settings.model, getProvider('deepseek').model); assert.equal(settings.effort, 'low');
  assert.equal(settings.selectionSource, 'core'); assert.equal(settings.coordinatorRevision, 1);
  assert.throws(() => configureSessionCompaction({ tokenBudget: 25000 }, { expectedRevision: 1 }), { code: 'CONFLICT' });
  configureSessionCompaction({ tokenBudget: 25000 }, { expectedRevision: 0 });
  assert.equal(loadSession(session.id).model, 'main-chat-model');
  assert.throws(() => configureSessionCompaction({ effort: 'impossible' }, { expectedRevision: 1 }), { code: 'INVALID_COMPACTOR' });
  new CoreAssistant().configure({ source: 'core', provider: 'claude', model: 'core-model', effort: 'default' }, { requestId: randomUUID(), expectedRevision: 1 });
  assert.equal(sessionCompactionSettings().provider, 'claude'); assert.equal(sessionCompactionSettings().model, 'core-model');
  assert.equal(loadSession(session.id).model, 'main-chat-model');
});

test('completed source queues stable jobs, selects the compactor, and leaves original history and goal unchanged', async () => {
  queue(); const id = job().id, before = events(session.id, 0, 100), goal = loadSession(session.id).goal;
  queueSessionCompaction(session, { force: true }); assert.equal(job().id, id); assert.equal(listRecords(JOB).length, 1);
  let calls = 0;
  const [completed] = await processSessionCompactions({ runModel: async input => {
    calls++; assert.equal(input.source.id, session.id); assert.equal(input.selection.provider, 'deepseek'); assert.equal(input.selection.effort, 'low');
    assert.match(input.instructions, /untrusted/); assert.ok(input.budget.tokenBudget <= 20000); return summary();
  } });
  assert.equal(calls, 1); assert.equal(completed.state, 'completed');
  assert.deepEqual(events(session.id, 0, 100), before); assert.deepEqual(loadSession(session.id).goal, goal);
  assert.equal(readSessionMemory(session).items.length, 1);
  assert.equal(sessionCompactionUsage().tokensUsed, 100); assert.equal(sessionCompactionUsage().reservedTokens, 0);
  assert.deepEqual(await processSessionCompactions({ runModel: () => assert.fail('Stable nodes must not submit twice') }), []);
});

test('small sanitized material is published by the host without a model or key', async () => {
  delete process.env.DEEPSEEK_API_KEY;
  queue(session, { text: 'Keep uncertainty explicit; password=fixture-private-password', count: 1 });
  const [result] = await processSessionCompactions({ runModel: () => assert.fail('Small excerpts need no model call') });
  assert.equal(result.state, 'completed');
  const node = readSessionMemory(session).items[0]; assert.match(node.summary, /redacted/); assert.doesNotMatch(node.summary, /fixture-private-password/);
  assert.equal(getRecord('core.session.memory.node', node.id).summarizer.provider, 'host'); assert.equal(sessionCompactionUsage().tokensUsed, 0);
});

test('missing private host key waits with backoff and never falls back to the foreground provider', async () => {
  delete process.env.DEEPSEEK_API_KEY; queue();
  const [result] = await processSessionCompactions({ runModel: () => assert.fail('No request without the configured key') });
  assert.equal(result.state, 'waiting_for_auth'); assert.equal(result.error, 'COMPACTOR_AUTH_REQUIRED');
  assert.equal(result.attempts, 0); assert.equal(sessionCompactionUsage().reservedTokens, 0);
  assert.deepEqual(await processSessionCompactions({ runModel: () => assert.fail('Auth retry must back off') }), []);
});

test('foreground work has dispatch priority, but a pinned summary can finish after foreground starts', async () => {
  queue(); session.executionState = 'running'; saveSession(session);
  assert.deepEqual(await processSessionCompactions({ runModel: () => assert.fail('Foreground source is busy') }), []);
  session.executionState = 'idle'; saveSession(session);
  putRecord('execution', 'foreground', { id: 'foreground', state: 'queued', sessionId: session.id });
  assert.deepEqual(await processSessionCompactions({ runModel: () => assert.fail('Queued foreground has priority') }), []);
  putRecord('execution', 'foreground', { id: 'foreground', state: 'finished' });
  const [completed] = await processSessionCompactions({ runModel: async () => {
    session.executionState = 'running'; saveSession(session); return summary();
  } });
  assert.equal(completed.state, 'completed'); assert.equal(loadSession(session.id).executionState, 'running');
});

test('session identity isolates chats sharing a cwd and survives alias/provider changes', async () => {
  const other = createSession(getProvider('codex'), session.cwd, 'other-model', 'other');
  queue(session); queue(other); setSessionAlias(session.id, 'renamed');
  const changed = loadSession(session.id); changed.provider = 'deepseek'; changed.model = 'some-other-model'; saveSession(changed);
  await processSessionCompactions({ runModel: async () => summary() }); await processSessionCompactions({ runModel: async () => summary() });
  assert.equal(readSessionMemory(session).items.length, 1); assert.equal(readSessionMemory(other).items.length, 1);
  assert.notEqual(readSessionMemory(session).items[0].id, readSessionMemory(other).items[0].id);
  assert.equal(sessionCompactionStatus(session).jobs[0].selection.model, getProvider('deepseek').model);
});

test('host concurrency is one and daily tokens are reserved before dispatch', async () => {
  queue(); let started, release;
  const began = new Promise(resolve => { started = resolve; }), held = new Promise(resolve => { release = resolve; });
  const pending = processSessionCompactions({ runModel: async () => { started(); return held; } }); await began;
  assert.equal(sessionCompactionUsage().reservedTokens, 20000);
  assert.deepEqual(await processSessionCompactions({ runModel: () => assert.fail('No second concurrent dispatch') }), []);
  release(summary()); await pending; assert.equal(sessionCompactionUsage().reservedTokens, 0);
});

test('unknown successful usage consumes the whole reservation conservatively', async () => {
  queue(); const [result] = await processSessionCompactions({ runModel: async () => ({ text: summary().text, usageAvailable: false }) });
  assert.equal(result.state, 'completed'); assert.equal(sessionCompactionUsage().tokensUsed, 20000);
  assert.equal(result.usage.conservative, true); assert.equal(result.usage.tokens, null);
});

test('completed helper overage charges actual reported tokens even when the helper rejects its output budget', async () => {
  queue(); let closed = false;
  class Engine {
    constructor(provider, draft, options, ui) { this.ui = ui; assert.equal(options.tokenBudget, 20000); }
    async run() { this.ui.event('text', { text: summary().text }); return { tokens: 23000 }; }
    async close() { closed = true; }
  }
  const [result] = await processSessionCompactions({ runModel: input => runRestrictedDocumentModel({ ...input, Engine }) });
  assert.equal(result.state, 'budget_limited'); assert.equal(result.error, 'COMPACTOR_BUDGET');
  assert.equal(result.usage.tokens, 23000); assert.equal(result.usage.conservative, false); assert.equal(result.totalTokensUsed, 23000);
  assert.equal(sessionCompactionUsage().tokensUsed, 23000); assert.equal(sessionCompactionUsage().reservedTokens, 0);
  assert.equal(readSessionMemory(session).items.length, 0); assert.equal(closed, true);
});

test('daily exhaustion defers requests until the next UTC day', async () => {
  configureSessionCompaction({ dailyTokenBudget: 20000 }, { expectedRevision: 0 }); queue();
  await processSessionCompactions({ runModel: async () => summary(20000) });
  queue(); const [limited] = await processSessionCompactions({ runModel: () => assert.fail('The day is exhausted') });
  assert.equal(limited.error, 'COMPACTOR_DAILY_BUDGET'); assert.equal(limited.reasonPaused, 'daily_budget');
  assert.match(limited.nextAttemptAt, /T00:00:00\.000Z$/);
});

test('oversized source is explained before dispatch and is never silently truncated', async () => {
  configureSessionCompaction({ tokenBudget: 1000 }, { expectedRevision: 0 }); queue();
  const [result] = await processSessionCompactions({ runModel: () => assert.fail('No truncation or model call to fit the budget') });
  assert.equal(result.state, 'budget_limited'); assert.equal(result.error, 'COMPACTOR_INPUT_BUDGET');
  assert.ok(result.estimatedTokens > 1000); assert.equal(result.attempts, 0); assert.equal(sessionCompactionUsage().tokensUsed, 0);
});

test('queued work pins completed history and status alone never enrolls a tree', async () => {
  queue(); const cursor = sessionCompactionStatus(session).control.throughSeq;
  appendEvent(session.id, 'message.user', { text: 'A later draft must not enter the completed snapshot.' });
  await processSessionCompactions({ runModel: async () => summary() }); assert.equal(sessionMemoryStatus(session).indexedThroughSeq, cursor);
  const other = createSession(getProvider('codex'), session.cwd, 'other');
  appendEvent(other.id, 'message.user', { text: 'An explicitly indexed tree has not been queued for a model.' });
  indexSessionMemory(other, { force: true }); sessionCompactionStatus(other);
  assert.deepEqual(await processSessionCompactions({ runModel: () => assert.fail('A history view is not permission to queue requests') }), []);
  assert.equal(listRecords(JOB, { sessionId: other.id }).length, 0);
});

test('large history continues bounded indexing until its pinned finalized cursor', async () => {
  queue(session, { text: 'x'.repeat(300000), count: 1 });
  assert.equal(sessionCompactionStatus(session).control.indexingRemaining, true);
  const target = sessionCompactionStatus(session).control.throughSeq;
  await processSessionCompactions({ runModel: async () => summary() });
  assert.equal(sessionMemoryStatus(session).indexedThroughSeq, target);
  assert.equal(sessionMemoryStatus(session).indexingRemaining, false);
  assert.equal(sessionCompactionStatus(session).control.indexingRemaining, false);
});

test('discovery pages past old assigned pending nodes so later work cannot starve', async () => {
  for (let index = 0; index < 808; index++) appendEvent(session.id, index % 2 ? 'text' : 'message.user', { text: `Observation ${index}: ${'Keep uncertain evidence unresolved. '.repeat(10)}` });
  let indexed;
  do { indexed = indexSessionMemory(session, { force: true }); } while (indexed.indexingRemaining);
  queueSessionCompaction(session, { force: true }); assert.equal(listRecords(JOB).length, 100);
  for (const prior of listRecords(JOB)) putRecord(JOB, prior.id, { ...prior, state: 'failed', attempts: 3 });
  const [completed] = await processSessionCompactions({ runModel: async () => summary() });
  assert.equal(completed.state, 'completed'); assert.equal(listRecords(JOB).length, 101);
});

test('invalid source controls fail locally without a model call or token reservation', async () => {
  queue(session, { text: 'Unexpected control \u001b byte', count: 1 });
  const [result] = await processSessionCompactions({ runModel: () => assert.fail('Reject malformed input locally') });
  assert.equal(result.state, 'failed'); assert.equal(result.error, 'COMPACTOR_INPUT'); assert.equal(sessionCompactionUsage().tokensUsed, 0);
});

test('invalid model summaries retry with backoff at most three times', async () => {
  queue(); let calls = 0;
  const runModel = async () => { calls++; return { text: 'x'.repeat(2049), tokens: 50, usageAvailable: true }; };
  for (let attempt = 0; attempt < 3; attempt++) {
    const [result] = await processSessionCompactions({ runModel });
    assert.equal(result.attempts, attempt + 1);
    if (attempt < 2) { assert.equal(result.state, 'retry_wait'); putRecord(JOB, result.id, { ...getRecord(JOB, result.id), nextAttemptAt: null }); }
    else assert.equal(result.state, 'failed');
  }
  await processSessionCompactions({ runModel }); assert.equal(calls, 3); assert.equal(sessionCompactionUsage().tokensUsed, 150);
});

test('dispatched failure is charged conservatively and requires explicit resume, without provider error leakage', async () => {
  queue(); const [result] = await processSessionCompactions({ runModel: async () => { throw Error('Bearer private-error-token'); } });
  assert.equal(result.state, 'paused'); assert.equal(result.reasonPaused, 'uncertain_request'); assert.equal(sessionCompactionUsage().tokensUsed, 20000);
  assert.doesNotMatch(JSON.stringify(result), /private-error-token/);
  queueSessionCompaction(session, { force: true });
  assert.deepEqual(await processSessionCompactions({ runModel: () => assert.fail('A new turn is not consent to repeat an uncertain call') }), []);
  configureSessionCompaction({ tokenBudget: 40000 }, { expectedRevision: 0 }); resume();
  const [completed] = await processSessionCompactions({ runModel: async () => summary() }); assert.equal(completed.state, 'completed');
});

test('pause rejects late output, settles conservatively and never implicitly resumes', async () => {
  queue(); let started, release;
  const began = new Promise(resolve => { started = resolve; }), held = new Promise(resolve => { release = resolve; });
  const pending = processSessionCompactions({ runModel: async () => { started(); return held; } }); await began;
  pauseSessionCompaction(session.id, 'owner_pause'); release(summary()); const [result] = await pending;
  assert.equal(result.state, 'paused'); assert.equal(result.reasonPaused, 'owner_pause'); assert.equal(readSessionMemory(session).items.length, 0);
  assert.equal(sessionCompactionUsage().reservedTokens, 0); assert.equal(sessionCompactionUsage().tokensUsed, 20000);
  assert.deepEqual(await processSessionCompactions({ runModel: () => assert.fail('Pause is durable') }), []);
  assert.throws(() => controlSessionCompaction(session, 'resume', { expectedRevision: 0 }), { code: 'CONFLICT' });
});

test('owner stop and disabled settings pause queued work without automatic resumption', async () => {
  queue(); pauseAllSessionCompactions('host_stopped');
  assert.deepEqual(await processSessionCompactions({ runModel: () => assert.fail('Stop is durable') }), []);
  configureSessionCompaction({ enabled: false }, { expectedRevision: 0 });
  assert.throws(() => resume(), { code: 'COMPACTOR_PAUSED' });
  configureSessionCompaction({ enabled: true }, { expectedRevision: 1 });
  assert.deepEqual(await processSessionCompactions({ runModel: () => assert.fail('Enabled does not mean resumed') }), []);
});

test('deletion or a rebuilt generation rejects in-flight output', async () => {
  queue(); const [result] = await processSessionCompactions({ runModel: async () => {
    deleteTerminalConversation(session.id, { requestId: 'delete-compacting' }); return summary();
  } });
  assert.equal(result.state, 'paused'); assert.equal(loadSession(session.id), null);
  const other = createSession(getProvider('codex'), session.cwd, 'other'); queue(other);
  const [changed] = await processSessionCompactions({ runModel: async () => { resetSessionMemory(other); return summary(); } });
  assert.equal(changed.state, 'cancelled'); assert.equal(changed.reasonPaused, 'memory_rebuilt'); assert.equal(sessionMemoryStatus(other).ready, 0);
});

test('owner rebuild retires queued old-generation jobs without pausing fresh rebuilt work', async () => {
  queue(session, { count: 16 });
  const owner = new CoreKnowledge(), previousGeneration = sessionMemoryStatus(session).generation, before = events(session.id, 0, 100);
  const oldIds = new Set(listRecords(JOB).map(item => item.id)); assert.equal(oldIds.size, 2);
  owner.request('session-memory.rebuild', { sessionId: session.id, expectedGeneration: previousGeneration, reviewed: true });
  assert.notEqual(sessionMemoryStatus(session).generation, previousGeneration);
  const [completed] = await processSessionCompactions({ runModel: async () => summary() });
  assert.equal(completed.state, 'completed'); assert.equal(oldIds.has(completed.id), false);
  for (const id of oldIds) { assert.equal(getRecord(JOB, id).state, 'cancelled'); assert.equal(getRecord(JOB, id).reasonPaused, 'memory_rebuilt'); }
  assert.equal(sessionCompactionStatus(session).control.state, 'enabled'); assert.deepEqual(events(session.id, 0, 100), before);
  assert.throws(() => owner.request('session-memory.rebuild', { sessionId: session.id, expectedGeneration: previousGeneration, reviewed: true }), { code: 'CONFLICT' });
});

test('a rebuilt generation can proceed after an old dispatched call returns an uncertain failure', async () => {
  queue(); const original = job(), owner = new CoreKnowledge();
  const [retired] = await processSessionCompactions({ runModel: async () => {
    owner.request('session-memory.rebuild', { sessionId: session.id, expectedGeneration: original.generation, reviewed: true });
    throw new Error('Synthetic uncertain result for the retired generation.');
  } });
  assert.equal(retired.state, 'cancelled'); assert.equal(retired.reasonPaused, 'memory_rebuilt');
  assert.equal(sessionCompactionStatus(session).control.state, 'enabled'); assert.equal(sessionCompactionUsage().tokensUsed, 20000);
  const [completed] = await processSessionCompactions({ runModel: async () => summary() }); assert.equal(completed.state, 'completed');
});

test('crash recovery charges unsettled calls once and never automatically replays', async () => {
  queue(); const queued = job(), reservationId = 'crashed-reservation';
  putRecord('core.session.compactor.reservation', reservationId, { id: reservationId, jobId: queued.id, day: '2026-10-25', tokens: 20000, state: 'reserved' });
  putRecord('core.session.compactor.usage', '2026-10-25', { day: '2026-10-25', tokensUsed: 0, reservedTokens: 20000 });
  putRecord(JOB, queued.id, { ...queued, state: 'running', dispatched: true, runner: null, reservationId, startedAt: new Date().toISOString() });
  assert.deepEqual(recoverSessionCompactions(), [queued.id]); assert.deepEqual(recoverSessionCompactions(), []);
  assert.equal(sessionCompactionUsage('2026-10-25').tokensUsed, 20000); assert.equal(sessionCompactionUsage('2026-10-25').reservedTokens, 0);
  assert.equal(job().reasonPaused, 'recovery_required');
  assert.deepEqual(await processSessionCompactions({ runModel: () => assert.fail('Recovery never replays an uncertain request') }), []);
});

test('recovery releases reservations if the owner pause committed before the crash', () => {
  queue(); const queued = job(), reservationId = 'paused-crash', day = new Date().toISOString().slice(0, 10);
  putRecord('core.session.compactor.reservation', reservationId, { id: reservationId, jobId: queued.id, day, tokens: 20000, state: 'reserved' });
  putRecord('core.session.compactor.usage', day, { day, tokensUsed: 0, reservedTokens: 20000 });
  putRecord(JOB, queued.id, { ...queued, state: 'paused', reasonPaused: 'owner_pause', dispatched: true,
    runner: null, reservationId, startedAt: new Date().toISOString() });
  assert.deepEqual(recoverSessionCompactions(), [queued.id]); assert.equal(sessionCompactionUsage().reservedTokens, 0);
  assert.equal(sessionCompactionUsage().tokensUsed, 20000); assert.equal(job().state, 'paused');
});

test('Core subscription coordinator selection is pinned per job and uses its own authentication', async () => {
  const assistant = new CoreAssistant();
  assistant.configure({ source: 'core', provider: 'claude', model: 'claude-core', effort: 'default' }, { requestId: randomUUID(), expectedRevision: 1 }); queue();
  assistant.configure({ source: 'core', provider: 'codex', model: 'new-core-model', effort: 'default' }, { requestId: randomUUID(), expectedRevision: 2 });
  const [result] = await processSessionCompactions({ authAvailable: async provider => { assert.equal(provider.id, 'claude'); return true; }, runModel: async input => {
    assert.equal(input.selection.provider, 'claude'); assert.equal(input.selection.model, 'claude-core'); return summary();
  } });
  assert.equal(result.state, 'completed'); assert.equal(result.coordinatorRevision, 2);
  assert.equal(sessionCompactionSettings().provider, 'codex');
});

test('unconfigured Core defers compaction without falling back to terminal defaults', async () => {
  putRecord('core.assistant', 'default', { source: 'core', revision: 2 }); queue();
  const [result] = await processSessionCompactions({ runModel: () => assert.fail('No implicit main-model fallback') });
  assert.equal(result.state, 'waiting_for_configuration'); assert.equal(result.error, 'COMPACTOR_SETUP_REQUIRED');
  new CoreAssistant().configure({ source: 'core', provider: 'deepseek', effort: 'low' }, { requestId: randomUUID(), expectedRevision: 2 });
  const [completed] = await processSessionCompactions({ runModel: async () => summary() });
  assert.equal(completed.state, 'completed'); assert.equal(completed.coordinatorRevision, 3);
});

test('backend default model is attributed explicitly when the coordinator leaves model unset', async () => {
  new CoreAssistant().configure({ source: 'core', provider: 'codex' }, { requestId: randomUUID(), expectedRevision: 1 }); queue();
  const [result] = await processSessionCompactions({ authAvailable: async () => true, runModel: async input => {
    assert.equal(input.selection.model, null); assert.equal(input.task.kind, 'session-compaction'); return summary();
  } });
  assert.equal(result.state, 'completed');
  const node = getRecord('core.session.memory.node', readSessionMemory(session).items[0].id);
  assert.equal(node.summarizer.model, 'backend-default');
});

test('crash recovery stops only the exact verified compactor backend and blocks unverified live backends', async () => {
  queue(); const queued = job(), children = [];
  const alive = async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' }); children.push(child);
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    return processIdentity(child.pid);
  };
  try {
    const backend = await alive(), unrelated = await alive(); assert.ok(backend); assert.ok(unrelated);
    for (const [index, identity] of [backend, unrelated].entries()) {
      const draft = createSession(getProvider('codex'), root, 'offline');
      Object.assign(draft, { role: 'learning-review', purpose: 'document', documentSourceSessionId: session.id,
        documentTaskKind: index ? 'skill-creation' : 'session-compaction', documentTaskId: queued.id, backendProcess: identity }); saveSession(draft);
    }
    putRecord(JOB, queued.id, { ...queued, state: 'running', runner: null, dispatched: true });
    recoverSessionCompactions();
    const deadline = Date.now() + 3000; while (identityAlive(backend) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(identityAlive(backend), false); assert.equal(identityAlive(unrelated), true);
    const unknown = createSession(getProvider('codex'), root, 'offline');
    Object.assign(unknown, { role: 'learning-review', purpose: 'document', documentSourceSessionId: session.id,
      documentTaskKind: 'session-compaction', documentTaskId: queued.id, backendProcess: { pid: unrelated.pid, start: 'platform-unverified' } }); saveSession(unknown);
    recoverSessionCompactions(); assert.equal(identityAlive(unrelated), true);
    assert.throws(() => resume(), { code: 'CONFLICT' });
  } finally {
    for (const child of children) child.kill('SIGKILL');
  }
});

test('cached summaries recover host publication without another model request', async () => {
  queue(); await processSessionCompactions({ runModel: async () => summary() });
  const completed = job(); putRecord(JOB, completed.id, { ...completed, state: 'running', runner: null, dispatched: true });
  recoverSessionCompactions(); resume();
  const [result] = await processSessionCompactions({ runModel: () => assert.fail('Use the checked cached result') });
  assert.equal(result.state, 'completed'); assert.equal(readSessionMemory(session).items.length, 1); assert.equal(sessionCompactionUsage().tokensUsed, 100);
});
