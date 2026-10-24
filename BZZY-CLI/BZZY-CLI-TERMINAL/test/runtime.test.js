import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { ensureRuntime, runtimeRequest, runtimeInfo, claimInput, requireOwner } from '../src/runtime.js';
import { createSession, saveSession, loadSession } from '../src/store.js';
import { BUILTINS } from '../src/providers.js';
import { prepareTask } from '../src/task.js';
import { newGoal } from '../src/goals.js';
import { events, getRecord, putRecord, listRecords, appendEvent } from '../src/database.js';
import { delay } from '../src/delegation.js';
import { BzzyClient } from '../src/api-client.js';
import { identityAlive } from '../src/recovery.js';
import { changeSessionModel, changeSessionProvider, attachSession, viewSession, restoreConversation, conversationInput } from '../src/runtime-client.js';
import { changeConversationProvider } from '../src/conversation-settings.js';
import { conversationMessages } from '../src/conversation.js';
import { initializeProject, writeProjectRecord } from '../src/project.js';
import { suspendCoreHost, servicePlan } from '@bzzy/core/engine/host-service.js';
import { beginCoreMaintenance } from '@bzzy/core/engine/maintenance.js';

const root = fileURLToPath(new URL('../', import.meta.url));
let dir, savedEnv;
test.beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-rt-'));
  savedEnv = Object.fromEntries(['BZZY_HOME', 'BZZY_CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'BZZY_CODEX_BIN', 'BZZY_CLAUDE_BIN', 'BZZY_TEST_ADVANCED', 'BZZY_TEST_LOG', 'DEEPSEEK_API_KEY'].map(k => [k, process.env[k]]));
  Object.assign(process.env, { BZZY_HOME: path.join(dir, 'private'), BZZY_CODEX_HOME: path.join(dir, 'codex'), CLAUDE_CONFIG_DIR: path.join(dir, 'claude'), BZZY_CODEX_BIN: path.join(root, 'test/fixtures/advanced-agent.mjs'), BZZY_CLAUDE_BIN: path.join(root, 'test/fixtures/advanced-agent.mjs'), BZZY_TEST_LOG: path.join(dir, 'backend.jsonl'), DEEPSEEK_API_KEY: 'fixture-not-a-real-key' });
  fs.writeFileSync(path.join(dir, 'source.txt'), 'Supplied evidence');
});
test.afterEach(async () => {
  const info = runtimeInfo();
  if (info && identityAlive(info.identity)) await runtimeRequest(info, 'POST', '/shutdown', {}).catch(() => {});
  for (let i = 0; i < 50 && info && identityAlive(info.identity); i++) await delay(20);
  for (const [k, v] of Object.entries(savedEnv)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  fs.rmSync(dir, { recursive: true, force: true });
});
function makeSession(options = {}) {
  const session = createSession(BUILTINS.codex, dir); prepareTask(session, options, 'Assess supplied evidence'); session.goal = newGoal(session.contract.objective, options.tokenBudget); saveSession(session); return session;
}
async function start(session, options = {}) {
  const info = await ensureRuntime(), owner = randomUUID();
  await runtimeRequest(info, 'POST', `/sessions/${session.id}/claim`, { owner, takeover: true });
  const result = await runtimeRequest(info, 'POST', `/sessions/${session.id}/execute`, { owner, prompt: 'Assess supplied evidence', options, goal: true }, randomUUID());
  return { info, owner, ...result };
}
async function finished(id, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const job = getRecord('execution', id); if (job && !['queued', 'launching', 'running'].includes(job.state)) return job; await delay(50); }
  throw new Error(`Execution timed out: ${JSON.stringify(getRecord('execution', id))}`);
}
test('runtime survives client detachment and view replays history without executing', async () => {
  process.env.BZZY_TEST_ADVANCED = 'wait';
  const session = makeSession(), launched = await start(session);
  await runtimeRequest(launched.info, 'POST', `/sessions/${session.id}/release`, { owner: launched.owner });
  const job = await finished(launched.executionId); assert.equal(job.exitCode, 0, job.error);
  const before = fs.readFileSync(path.join(dir, 'backend.jsonl'), 'utf8');
  const client = new BzzyClient(launched.info), history = await client.events(session.id);
  assert.ok(history.events.some(e => e.type === 'activity'));
  assert.ok(history.events.some(e => e.type === 'summary' && e.data.usage.totalTokens === 42));
  const next = await client.events(session.id, history.nextCursor); assert.equal(next.events.length, 0);
  assert.equal(fs.readFileSync(path.join(dir, 'backend.jsonl'), 'utf8'), before);
  assert.equal(loadSession(session.id).goal.status, 'complete');
  const activity = (await client.activities(session.id)).items[0];
  assert.ok(activity.closedAt); assert.equal(activity.executionActive, false); assert.equal(activity.status, 'running');
});
test('an update restores the saved chat without replaying work or taking input from the phone', async () => {
  const session = createSession(BUILTINS.codex, dir), info = await ensureRuntime(), phone = 'paired-phone';
  appendEvent(session.id, 'message.user', { text: 'Saved conversation' });
  appendEvent(session.id, 'text', { text: 'Saved answer' });
  await runtimeRequest(info, 'POST', `/sessions/${session.id}/claim`, { owner: phone });
  let mode, cwd;
  const ui = { interactive: true, cursors: new Map(), event() {}, ask: async () => null,
    setSession(_id, value) { mode = value; }, updateSession(snapshot) { cwd = snapshot.session.cwd; } };
  await attachSession(session, { restoreAfterUpdate: true }, ui);
  assert.equal(mode, 'VIEW', 'Reloading must not silently take over the phone lease');
  assert.equal(cwd, dir, 'The existing chat keeps its original directory');
  assert.equal((await runtimeRequest(info, 'GET', `/sessions/${session.id}`)).inputOwner.owner, phone);
  assert.equal(listRecords('execution', { sessionId: session.id }).length, 0);
});
test('a bestie child view replays the complete parent shared room', async () => {
  const parent = makeSession({ mode: 'besties', besties: [{ provider: 'codex' }, { provider: 'claude' }] });
  const first = createSession(BUILTINS.codex, dir), second = createSession(BUILTINS.claude, dir);
  const peers = [{ namespace: 'codex-bestie-1', sessionId: first.id }, { namespace: 'claude-bestie-2', sessionId: second.id }];
  for (const child of [first, second]) {
    Object.assign(child, { role: 'bestie', bestiesSessionId: parent.id, parentSessionId: parent.id, peers, goal: newGoal(parent.goal.objective) }); saveSession(child);
  }
  putRecord('besties', parent.id, { goalId: parent.goal.id, peers, cursors: {} });
  appendEvent(parent.id, 'peer.message', { id: 'shared-message', groupId: parent.id, from: first.id, to: second.id, text: 'Inspect the current proof.', evidence: ['proof-id'] });
  appendEvent(parent.id, 'peer.review', { id: 'shared-review', groupId: parent.id, reviewer: second.id, peerSessionId: first.id, messageId: 'shared-message', assessment: 'supported', rationale: 'Current proof inspected.', evidence: ['proof-id'] });
  const seen = [], ui = { interactive: false, cursors: new Map(), setSession() {}, updateSession() {}, event(type, data) { seen.push({ type, data }); } };
  await viewSession(first, { follow: false }, ui);
  assert.ok(seen.some(item => item.type === 'peer.message' && item.data.id === 'shared-message'));
  assert.ok(seen.some(item => item.type === 'peer.review' && item.data.id === 'shared-review'));
});
test('execution requests are idempotent and ownership transfers invalidate the old client', async () => {
  process.env.BZZY_TEST_ADVANCED = 'wait';
  const session = makeSession(), info = await ensureRuntime(), owner = randomUUID();
  await runtimeRequest(info, 'POST', `/sessions/${session.id}/claim`, { owner });
  const body = { owner, prompt: 'Assess', options: {}, goal: true }, key = randomUUID();
  const [a, b] = await Promise.all([runtimeRequest(info, 'POST', `/sessions/${session.id}/execute`, body, key), runtimeRequest(info, 'POST', `/sessions/${session.id}/execute`, body, key)]);
  assert.equal(a.executionId, b.executionId);
  await assert.rejects(runtimeRequest(info, 'POST', `/sessions/${session.id}/execute`, { ...body, prompt: 'Different' }, key), /conflict/i);
  const nextOwner = randomUUID(); await runtimeRequest(info, 'POST', `/sessions/${session.id}/claim`, { owner: nextOwner, takeover: true });
  await assert.rejects(runtimeRequest(info, 'POST', `/sessions/${session.id}/control`, { owner, action: 'cancel' }, randomUUID()), /own input/);
  await finished(a.executionId);
});
test('pending questions survive a client disconnect and attach answers the existing execution', async () => {
  process.env.BZZY_TEST_ADVANCED = 'question'; const session = makeSession(), launched = await start(session);
  let snapshot;
  for (let i = 0; i < 100; i++) { snapshot = await runtimeRequest(launched.info, 'GET', `/sessions/${session.id}`); if (snapshot.questions.length) break; await delay(30); }
  assert.equal(snapshot.questions.length, 1);
  const owner = randomUUID(); await runtimeRequest(launched.info, 'POST', `/sessions/${session.id}/claim`, { owner, takeover: true });
  await runtimeRequest(launched.info, 'POST', `/sessions/${session.id}/answer`, { owner, questionId: snapshot.questions[0].id, answer: 'approved-account-A' }, randomUUID());
  assert.equal((await finished(launched.executionId)).exitCode, 0);
  assert.match(fs.readFileSync(path.join(dir, 'backend.jsonl'), 'utf8'), /approved-account-A/);
});
test('observer tokens cannot control sessions or read another session; SSE replays by cursor', async () => {
  const session = makeSession(), info = await ensureRuntime(), rootClient = new BzzyClient(info);
  const token = await rootClient.observerToken(session.id), observer = new BzzyClient({ url: info.url, token: token.token });
  await assert.rejects(observer.claim(session.id, randomUUID()), /observation only/);
  const other = makeSession(); await assert.rejects(observer.session(other.id), /another session/);
  const first = appendEvent(session.id, 'activity', { summary: 'First' }), second = appendEvent(session.id, 'network.response', { status: 200 });
  const abort = new AbortController(), seen = [];
  for await (const event of observer.stream(session.id, { after: first.seq, signal: abort.signal, types: ['network.*'] })) { seen.push(event); abort.abort(); }
  assert.equal(seen.length, 1); assert.equal(seen[0].seq, second.seq);
});
test('model changes preserve the goal and native thread, reject active or unowned edits, and reach the next turn', async () => {
  process.env.BZZY_TEST_ADVANCED = 'slow';
  const session = makeSession(), launched = await start(session), ui = { event() {}, updateSession() {} };
  await assert.rejects(changeSessionModel(session.id, 'next-model', ui, launched), /still running/);
  await finished(launched.executionId);
  const before = loadSession(session.id);
  await assert.rejects(changeSessionModel(session.id, 'next-model', ui, { info: launched.info, owner: randomUUID() }), /own input/);
  const changed = await changeSessionModel(session.id, 'next-model', ui, launched);
  assert.equal(changed.engineThreadId, before.engineThreadId); assert.equal(changed.goal.id, before.goal.id);
  assert.equal(changed.model, 'next-model'); assert.equal(changed.resolvedModel, null);
  ui.chooseOne = async (_title, choices) => Array.isArray(await choices) ? 'codex' : { value: JSON.stringify(['codex', 'fixture-brain']), effort: 'xhigh' };
  const tuned = await changeConversationProvider(loadSession(session.id), '', ui, launched);
  assert.equal(tuned.id, session.id, 'reselecting Codex edits the current conversation');
  assert.equal((await runtimeRequest(launched.info, 'GET', `/sessions/${session.id}`)).inputOwner.owner, launched.owner);
  assert.equal(tuned.selectedEffort, 'xhigh'); assert.equal(loadSession(session.id).selectedEffort, 'xhigh');
  const next = await runtimeRequest(launched.info, 'POST', `/sessions/${session.id}/execute`, { owner: launched.owner, prompt: 'Continue the same conversation', options: { effort: 'medium' }, goal: false }, randomUUID());
  assert.equal((await finished(next.executionId)).exitCode, 0);
  const log = fs.readFileSync(path.join(dir, 'backend.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(log.some(entry => entry.threadMethod === 'thread/resume' && entry.model === 'fixture-brain' && entry.config.model_reasoning_effort === 'xhigh' && entry.threadId === before.engineThreadId));
  assert.ok(log.some(entry => entry.args?.includes('model_reasoning_effort="xhigh"')));
  assert.equal(events(session.id, 0, 1000).filter(event => event.type === 'model.changed').length, 2);
});
test('attached chats process the plural models shortcut before exiting without inference', async () => {
  const session = makeSession(), inputs = ['/models attached-model', '/exit'];
  const ui = { interactive: true, cursors: new Map(), setSession() {}, event() {}, updateSession() {}, async ask() { return inputs.shift(); } };
  assert.equal(await attachSession(session, {}, ui), 0);
  assert.equal(loadSession(session.id).model, 'attached-model');
  assert.equal(fs.existsSync(path.join(dir, 'backend.jsonl')), false);
});
test('an idle terminal observes and completes replies started by another input channel', async () => {
  process.env.BZZY_TEST_ADVANCED = 'slow';
  const session = makeSession(), info = await ensureRuntime(), owner = randomUUID(); let first = true, closeInput;
  const seen = [], ui = { interactive: true, cursors: new Map(), setSession() {}, updateSession() {}, event(type, data) { seen.push({ type, data }); },
    async ask() {
      if (first) { first = false; return new Promise(resolve => { closeInput = () => resolve(null); ui.reader = { close: closeInput }; }); }
      if (['queued', 'launching', 'running'].includes(getRecord('execution', executionId)?.state)) return new Promise(resolve => { ui.reader = { close: () => resolve(null) }; });
      return '/exit';
    },
  };
  let executionId;
  const waiting = conversationInput(session, ui);
  for (let i = 0; i < 100 && !closeInput; i++) await delay(10);
  await runtimeRequest(info, 'POST', `/sessions/${session.id}/claim`, { owner });
  const execution = await runtimeRequest(info, 'POST', `/sessions/${session.id}/execute`, { owner, prompt: 'Started from another input channel', options: {}, goal: false }, randomUUID()); executionId = execution.executionId;
  await runtimeRequest(info, 'POST', `/sessions/${session.id}/release`, { owner });
  assert.equal(await waiting, '/exit');
  assert.ok(seen.some(event => event.type === 'message.user' && event.data.text === 'Started from another input channel'));
  assert.ok(seen.some(event => event.type === 'text' && /Fixture work/.test(event.data.text)));
});
test('input submitted as an observed execution ends returns to idle chat without being lost', async () => {
  process.env.BZZY_TEST_ADVANCED = 'slow';
  const session = makeSession(), info = await ensureRuntime(), owner = randomUUID();
  const followup = 'Explain the completed result'; let prompts = 0, closeIdle;
  const ui = { interactive: true, cursors: new Map(), setSession() {}, updateSession() {}, event() {},
    ask() {
      prompts++;
      if (prompts === 1) return new Promise(resolve => { closeIdle = () => resolve(null); ui.reader = { close: closeIdle }; });
      if (prompts === 2) return new Promise(resolve => { ui.reader = { close: () => resolve(followup) }; });
      throw new Error('The submitted follow-up was lost during execution cleanup.');
    },
  };
  const waiting = conversationInput(session, ui);
  for (let i = 0; i < 100 && !closeIdle; i++) await delay(10);
  await runtimeRequest(info, 'POST', `/sessions/${session.id}/claim`, { owner });
  await runtimeRequest(info, 'POST', `/sessions/${session.id}/execute`, { owner, prompt: 'Started from another channel', options: {}, goal: false }, randomUUID());
  await runtimeRequest(info, 'POST', `/sessions/${session.id}/release`, { owner });
  assert.equal(await waiting, followup);
  assert.equal(prompts, 2);
});

test('model and provider switches retain readable history and pass only chat context to each new backend', async () => {
  process.env.BZZY_TEST_ADVANCED = 'conversation';
  const session = createSession(BUILTINS.codex, dir), info = await ensureRuntime(), owner = randomUUID(), connection = { info, owner };
  session.backendHomes = { codex: path.join(dir, 'codex'), codexApi: path.join(dir, 'private', 'codex-api') }; saveSession(session);
  await runtimeRequest(info, 'POST', `/sessions/${session.id}/claim`, { owner, takeover: true });
  const ui = { event() {}, updateSession() {} };
  const say = async prompt => {
    const execution = await runtimeRequest(connection.info, 'POST', `/sessions/${session.id}/execute`, { owner, prompt, options: {}, goal: false }, randomUUID());
    const job = await finished(execution.executionId); assert.equal(job.exitCode, 0, job.error);
    const log = fs.readFileSync(path.join(dir, 'backend.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    const reply = log.findLast(entry => typeof entry.prompt === 'string');
    assert.match(reply.reply, /orchard-violet/); return reply;
  };
  await say('Remember this chat marker: orchard-violet');
  const original = loadSession(session.id);
  initializeProject(original);
  writeProjectRecord(original, 'memory', randomUUID(), { statement: 'PRIVATE-NOTE-DO-NOT-FORWARD' });
  appendEvent(session.id, 'backend', { method: 'reasoning', params: { text: 'PRIVATE-REASONING-DO-NOT-FORWARD' } });
  appendEvent(session.id, 'tool', { name: 'shell', detail: 'PRIVATE-TOOL-DO-NOT-FORWARD' });
  await changeSessionModel(session.id, 'fixture-light', ui, connection);
  const sameProvider = await say('What chat marker did I give you?');
  assert.equal(sameProvider.threadId, original.engineThreadId);
  assert.doesNotMatch(sameProvider.prompt, /PREVIOUS CONVERSATION/);
  const switchTo = async provider => {
    const source = loadSession(session.id);
    const changed = await changeSessionProvider(source, provider, { model: provider.model || 'fixture-brain', capabilities: null, effort: null }, ui, connection);
    assert.equal(changed.id, session.id); assert.equal(changed.engineThreadId, null);
    assert.equal((await runtimeRequest(connection.info, 'GET', `/sessions/${session.id}`)).inputOwner.owner, owner);
    return changed;
  };
  const firstClaude = await switchTo(BUILTINS.claude);
  // A pending chat handoff must survive restarting the runtime before the next turn.
  await runtimeRequest(info, 'POST', '/shutdown', {});
  for (let i = 0; i < 100 && identityAlive(info.identity); i++) await delay(20);
  connection.info = await ensureRuntime();
  await runtimeRequest(connection.info, 'POST', `/sessions/${session.id}/claim`, { owner });
  const claude = await say('What was the chat marker?');
  assert.match(claude.prompt, /PREVIOUS CONVERSATION \(JSON\):/);
  assert.match(claude.prompt, /The chat marker is orchard-violet/);
  assert.doesNotMatch(claude.prompt, /PRIVATE-(NOTE|REASONING|TOOL)-DO-NOT-FORWARD/);
  assert.equal(loadSession(session.id).conversationHandoff.pending, false);
  const nextClaude = await say('Repeat that marker');
  assert.equal(nextClaude.threadId, claude.threadId); assert.equal(nextClaude.prompt, 'Repeat that marker');
  await switchTo(BUILTINS.deepseek);
  const deepseek = await say('Recall the marker from this conversation');
  assert.match(deepseek.prompt, /Repeat that marker/);
  assert.equal(loadSession(session.id).engineHome, path.join(dir, 'private', 'codex-api'));
  await switchTo(BUILTINS.codex);
  await say('Keep the same marker after returning to Codex');
  assert.equal(loadSession(session.id).engineHome, path.join(dir, 'codex'));
  const secondClaude = await switchTo(BUILTINS.claude);
  assert.notEqual(secondClaude.engineSessionId, firstClaude.engineSessionId, 'returning to Claude starts a fresh native thread with the complete current chat');
  await say('What marker did we use throughout?');
  const replayed = [], viewer = { cursors: new Map(), setSession(id) { assert.equal(id, session.id); }, clearHistory() {}, updateSession() {}, event(type, data) { replayed.push({ type, data }); } };
  await restoreConversation(loadSession(session.id), viewer);
  assert.equal(replayed.filter(event => event.type === 'message.user').length, 7);
  assert.equal(replayed.filter(event => event.type === 'text').length, 7);
  assert.equal(events(session.id, 0, 1000).filter(event => event.type === 'provider.changed').length, 4);
  const messages = conversationMessages(session.id, Number.MAX_SAFE_INTEGER);
  assert.equal(messages.length, 14); assert.equal(messages[0].content, 'Remember this chat marker: orchard-violet');
  assert.equal(loadSession(session.id).usage.tokens, 228, 'usage remains cumulative across new native threads');
});
test('an attached provider switch releases the old input lease before entering the new conversation', async () => {
  const source = makeSession(), target = createSession(BUILTINS.claude, dir), info = await ensureRuntime(); let active;
  const ui = { interactive: true, cursors: new Map(), setSession(id) { active = id; }, event() {}, updateSession() {},
    async onProvider(id, _argument, connection) {
      assert.equal(id, source.id);
      assert.equal((await runtimeRequest(info, 'GET', `/sessions/${source.id}`)).inputOwner.owner, connection.owner);
      return target;
    },
    async ask() {
      if (active === source.id) return '/providers';
      assert.equal(active, target.id);
      assert.equal((await runtimeRequest(info, 'GET', `/sessions/${source.id}`)).inputOwner, null);
      return '/exit';
    },
  };
  assert.equal(await attachSession(source, {}, ui), 0);
  assert.equal((await runtimeRequest(info, 'GET', `/sessions/${target.id}`)).inputOwner, null);
});
test('a goal resumed on a different provider receives the chat and only its remaining native token budget', async () => {
  process.env.BZZY_TEST_ADVANCED = 'conversation';
  const session = createSession(BUILTINS.codex, dir);
  prepareTask(session, {}, 'Remember this chat marker: orchard-violet'); saveSession(session);
  const info = await ensureRuntime(), owner = randomUUID(), connection = { info, owner }, ui = { event() {}, updateSession() {} };
  await runtimeRequest(info, 'POST', `/sessions/${session.id}/claim`, { owner });
  const chat = await runtimeRequest(info, 'POST', `/sessions/${session.id}/execute`, { owner, prompt: 'Remember this chat marker: orchard-violet', options: {}, goal: false }, randomUUID());
  assert.equal((await finished(chat.executionId)).exitCode, 0);
  const source = loadSession(session.id); source.goal = newGoal('Verify the marker from our conversation', 100);
  Object.assign(source.goal, { status: 'paused', tokensUsed: 40, nativeTokensUsed: 40 }); saveSession(source);
  await changeSessionProvider(source, BUILTINS.deepseek, { model: 'deepseek-flash', capabilities: null, effort: null }, ui, connection);
  const resumed = await runtimeRequest(info, 'POST', `/sessions/${session.id}/execute`, { owner, prompt: 'Continue the existing goal', options: {}, goal: true, resumeGoal: true }, randomUUID());
  const result = await finished(resumed.executionId); assert.equal(result.exitCode, 0, result.error);
  const log = fs.readFileSync(path.join(dir, 'backend.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const activation = log.findLast(entry => entry.goalMethod === 'thread/goal/set');
  assert.equal(activation.tokenBudget, 60); assert.match(activation.objective, /Read the complete goal objective at/);
  const received = log.findLast(entry => entry.prompt);
  assert.match(received.prompt, /orchard-violet/); assert.match(received.prompt, /Verify the marker from our conversation/);
  assert.equal(loadSession(session.id).goal.status, 'complete'); assert.equal(loadSession(session.id).goal.tokensUsed, 82);
});
test('delegate completion recovers from a brain-only attempt by dispatching and reviewing the executor', async () => {
  process.env.BZZY_TEST_ADVANCED = 'delegation-recovery';
  const session = makeSession({ mode: 'delegate', executor: 'deepseek' }), started = await start(session);
  const result = await finished(started.executionId);
  assert.equal(result.exitCode, 0, result.error);
  const saved = loadSession(session.id), history = events(session.id, 0, 1000);
  const assessments = history.filter(event => event.type === 'acceptance');
  assert.equal(assessments[0].data.passed, false); assert.equal(assessments[0].data.delegation.assignmentCount, 0);
  assert.equal(saved.acceptance.delegation.reviewedAssignments, 1); assert.equal(saved.goal.status, 'complete');
  assert.equal(saved.goal.turns, 2);
  assert.ok(saved.summary.usage.supervisorTokens > 0); assert.ok(saved.summary.usage.delegatedTokens > 0);
  const summary = history.findLast(event => event.type === 'summary').data;
  assert.match(summary.message, /BRAIN.*tokens/); assert.match(summary.message, /HANDS \/ EXECUTOR.*tokens/); assert.match(summary.message, /TOTAL.*tokens/);
});

test('delegate chat reserves executor tools for a later goal but cannot launch workers during chat', async () => {
  const session = makeSession({ mode: 'delegate', executor: 'deepseek' }); session.goal = null; saveSession(session);
  const info = await ensureRuntime(), owner = randomUUID();
  await runtimeRequest(info, 'POST', `/sessions/${session.id}/claim`, { owner });
  const chat = await runtimeRequest(info, 'POST', `/sessions/${session.id}/execute`, { owner, prompt: 'Hello', options: {}, goal: false }, randomUUID());
  assert.equal((await finished(chat.executionId)).exitCode, 0);
  assert.equal(listRecords('assignment').filter(job => job.parentSessionId === session.id).length, 0);
  const fresh = loadSession(session.id), threadId = fresh.engineThreadId;
  fresh.goal = newGoal('Create result.txt from supplied evidence'); saveSession(fresh);
  const goal = await runtimeRequest(info, 'POST', `/sessions/${session.id}/execute`, { owner, prompt: fresh.goal.objective, options: {}, goal: true }, randomUUID());
  assert.equal((await finished(goal.executionId)).exitCode, 0);
  const saved = loadSession(session.id);
  assert.equal(saved.engineThreadId, threadId); assert.equal(saved.goal.status, 'complete');
  assert.equal(saved.summary.usage.assignmentCount, 1); assert.ok(saved.summary.usage.delegatedTokens > 0);
});

test('delegation retains a supervisor, bounded worker reports, inspected evidence and conflict-aware apply', async () => {
  const session = makeSession({ mode: 'delegate', executor: 'deepseek' });
  session.selectedEffort = 'xhigh'; session.executor.effort = 'low'; session.executor.capabilities = { supportedEfforts: ['low', 'high', 'max'] }; saveSession(session);
  const launched = await start(session);
  const job = await finished(launched.executionId, 35000); assert.equal(job.exitCode, 0, job.error);
  assert.match(fs.readFileSync(path.join(dir, 'result.txt'), 'utf8'), /Supplied evidence/);
  const assignment = listRecords('assignment').find(a => a.parentSessionId === session.id);
  assert.equal(assignment.closure, 'accepted'); assert.equal(assignment.latestReport.workerClaim, 'complete');
  assert.equal(loadSession(assignment.workerSessionId).selectedEffort, 'low');
  assert.equal(loadSession(assignment.workerSessionId).reasoningEffort, 'low', 'the worker backend ran with its own effort');
  assert.equal(loadSession(session.id).selectedEffort, 'xhigh');
  assert.equal(loadSession(session.id).reasoningEffort, 'xhigh');
  assert.ok(assignment.review.inspectedEvidence.length); assert.equal(loadSession(session.id).goal.status, 'complete');
  assert.equal(loadSession(session.id).summary.usage.totalTokens, 84);
});
test('an attached delegate conversation starts durable work only with /goal and preserves its boundary', async () => {
  const source = makeSession({ mode: 'delegate', executor: 'deepseek' });
  source.goal = null; source.contract.constraints = ['Keep the approved scope']; source.contract.scope = { allowedTargets: ['https://scope.example'] }; saveSession(source);
  const commands = ['/goal Create result.txt from the supplied evidence', '/goal status', '/exit'], seen = [];
  const ui = { interactive: true, cursors: new Map(), setSession() {}, updateSession() {}, event(type, data) { seen.push({ type, data }); },
    async ask() {
      if (listRecords('execution').some(job => job.sessionId === source.id && ['queued', 'launching', 'running'].includes(job.state))) return new Promise(resolve => { ui.reader = { close: () => resolve(null) }; });
      return commands.shift() || '/exit';
    },
  };
  await attachSession(source, { cwd: dir }, ui);
  const saved = loadSession(source.id);
  assert.equal(saved.goal.objective, 'Create result.txt from the supplied evidence'); assert.equal(saved.goal.status, 'complete');
  assert.equal(saved.mode, 'delegate'); assert.equal(saved.executor.provider, 'deepseek');
  assert.deepEqual(saved.contract.scope.allowedTargets, ['https://scope.example']); assert.ok(saved.contract.constraints.includes('Keep the approved scope'));
  assert.match(fs.readFileSync(path.join(dir, 'result.txt'), 'utf8'), /Supplied evidence/);
  assert.ok(seen.some(event => event.type === 'info' && event.data.message.startsWith('Goal complete')));
});
for (const status of ['paused', 'blocked', 'awaiting_review']) test(`attached /goal resume continues a ${status} goal with the same objective`, async () => {
  const source = makeSession({ mode: 'delegate', executor: 'deepseek' }); source.goal.status = status; saveSession(source);
  const original = source.goal.id, commands = ['/goal resume', '/goal status', '/exit'];
  const ui = { interactive: true, cursors: new Map(), setSession() {}, updateSession() {}, event() {}, async ask() {
    if (listRecords('execution').some(job => job.sessionId === source.id && ['queued', 'launching', 'running'].includes(job.state))) return new Promise(resolve => { ui.reader = { close: () => resolve(null) }; });
    return commands.shift() || '/exit';
  } };
  await attachSession(source, { cwd: dir }, ui); const saved = loadSession(source.id);
  assert.equal(saved.goal.id, original); assert.equal(saved.goal.objective, 'Assess supplied evidence'); assert.equal(saved.goal.status, 'complete');
  assert.equal(listRecords('execution').filter(job => job.sessionId === source.id).length, 1);
  assert.ok(listRecords('execution').find(job => job.sessionId === source.id).resumeGoal);
});

for (const provider of ['codex', 'claude']) test(`${provider}: /goal replaces active work without closing the chat or overlapping runners`, { timeout: 25000 }, async () => {
  process.env.BZZY_TEST_ADVANCED = 'slow';
  const source = makeSession(); source.provider = provider; source.backend = BUILTINS[provider].backend;
  source.contract.constraints = ['Preserve approved scope']; source.contract.scope.allowedTargets = ['https://scope.example']; saveSession(source);
  const original = source.goal.id, launched = await start(source);
  for (let i = 0; i < 150 && !loadSession(source.id).engineThreadId; i++) await delay(20);
  const thread = loadSession(source.id).engineThreadId; assert.ok(thread);
  let prompts = 0; const seen = [];
  const ui = { interactive: true, cursors: new Map(), setSession() {}, updateSession() {}, event(type, data) { seen.push({ type, data }); },
    async ask(question) {
      if (question.startsWith('Replace current goal?')) return 'y';
      if (!prompts++) return '/goal Inspect the replacement objective';
      if (listRecords('execution').some(job => job.sessionId === source.id && ['queued', 'launching', 'running'].includes(job.state))) return new Promise(resolve => { ui.reader = { close: () => resolve(null) }; });
      return '/exit';
    },
  };
  await attachSession(source, { cwd: dir }, ui);
  const saved = loadSession(source.id), archive = getRecord('goal-history', original);
  assert.notEqual(saved.goal.id, original); assert.equal(saved.goal.objective, 'Inspect the replacement objective');
  assert.equal(saved.goal.status, 'complete'); assert.equal(saved.engineThreadId, thread);
  assert.equal(archive.supersededBy, saved.goal.id); assert.equal(archive.status, 'cancelled');
  assert.equal(getRecord('execution', launched.executionId).exitCode, 130);
  const jobs = listRecords('execution').filter(job => job.sessionId === source.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  assert.equal(jobs.length, 2); assert.ok(jobs[0].finishedAt <= jobs[1].createdAt);
  assert.deepEqual(saved.contract.scope.allowedTargets, ['https://scope.example']); assert.ok(saved.contract.constraints.includes('Preserve approved scope'));
  assert.ok(seen.some(event => event.type === 'info' && /Replacing the current goal/.test(event.data.message)));
});

test('/goal from a parallel agent tab replaces the whole group objective and stops the old peers', { timeout: 25000 }, async () => {
  process.env.BZZY_TEST_ADVANCED = 'slow';
  const source = makeSession({ mode: 'parallel', agents: 'codex,codex' }), original = source.goal.id;
  const launched = await start(source);
  for (let i = 0; i < 150 && !getRecord('parallel', source.id)?.peers.length; i++) await delay(20);
  const oldPeers = getRecord('parallel', source.id).peers.map(peer => peer.sessionId);
  let prompts = 0, finishInput;
  const ui = { interactive: true, cursors: new Map(), setSession() {}, setTabs() {}, clearHistory() {}, event() {},
    updateSession() {
      const goal = loadSession(source.id).goal;
      if (goal.objective === 'Replacement group task' && goal.status === 'complete') finishInput?.('/exit');
    }, async ask(question) {
      if (question.startsWith('Replace current goal?')) return 'y';
      if (!prompts++) return '/goal Replacement group task';
      return new Promise(resolve => { finishInput = resolve; ui.reader = { close: () => resolve(null), setPrompt() {}, prompt() {} }; });
    },
  };
  await attachSession(source, { cwd: dir }, ui);
  const saved = loadSession(source.id), group = getRecord('parallel', source.id);
  assert.equal(saved.goal.objective, 'Replacement group task'); assert.equal(saved.goal.status, 'complete');
  assert.equal(getRecord('goal-history', original).supersededBy, saved.goal.id);
  assert.equal(getRecord('execution', launched.executionId).exitCode, 130);
  assert.ok(oldPeers.every(id => loadSession(id).goal.status === 'cancelled'));
  assert.ok(group.peers.every(peer => !oldPeers.includes(peer.sessionId) && loadSession(peer.sessionId).goal.objective === saved.goal.objective));
});

test('declining a goal replacement preserves the active goal and starts no new execution', { timeout: 15000 }, async () => {
  process.env.BZZY_TEST_ADVANCED = 'slow';
  const source = makeSession(), original = source.goal.id, launched = await start(source);
  let prompts = 0, confirmations = 0;
  const ui = { interactive: true, cursors: new Map(), setSession() {}, updateSession() {}, event() {},
    async ask(question) {
      if (question.startsWith('Replace current goal?')) { confirmations++; return 'n'; }
      return prompts++ ? '/exit' : '/goal Do not replace this goal';
    },
  };
  await attachSession(source, { cwd: dir }, ui);
  assert.equal(confirmations, 1); assert.equal(loadSession(source.id).goal.id, original);
  assert.equal(listRecords('execution').filter(job => job.sessionId === source.id).length, 1);
  assert.equal(getRecord('goal-history', original), null);
  await finished(launched.executionId);
  assert.equal(getRecord('execution', launched.executionId).exitCode, 0, 'No must leave the original execution able to finish');
});
test('debate preserves independent assessments, fixed snapshots and unresolved disagreement', async () => {
  const session = makeSession({ mode: 'debate' }), launched = await start(session, { artifact: 'source.txt', participants: ['codex', 'claude'], rounds: 3, runtimeSeconds: 30 });
  const job = await finished(launched.executionId, 40000); assert.equal(job.exitCode, 2, job.error || JSON.stringify(loadSession(session.id).goal));
  const result = getRecord('debate', session.id); assert.ok(result.transcript.length >= 2); assert.equal(result.stopReason, 'positions_stable');
  assert.ok(result.unresolvedDisagreement.includes('missing-control'), JSON.stringify(result.investigation)); assert.equal(result.newVerificationPerformed, null); assert.equal(result.newVerificationDuringRounds, false);
  assert.equal(result.outcome, 'unresolved'); assert.equal(loadSession(session.id).goal.status, 'awaiting_review');
  assert.equal(result.investigation.reports.length, 3, 'main and challengers all assess independently before the opening case');
  assert.ok(result.investigation.reports.every(report => report.artifacts.some(item => item.path?.startsWith('BZZY_INVESTIGATION_EVIDENCE/'))), JSON.stringify(result.investigation.reports));
  const history = (await new BzzyClient(launched.info).events(session.id, 0, 1000)).events;
  const investigationDone = history.findIndex(event => event.type === 'debate.phase' && event.data.status === 'finished');
  const opening = history.findIndex(event => event.type === 'debate.opening');
  const firstDiscussion = history.findIndex(event => event.type === 'debate.message' && event.data.role === 'reviewer');
  assert.ok(investigationDone >= 0 && opening > investigationDone && firstDiscussion > opening);
  assert.ok(!history.some(event => event.type === 'info' && event.data.message.startsWith('/goal ')), 'phase headings do not duplicate the submitted goal');
  assert.ok(history.some(event => event.type === 'debate.message' && event.data.role === 'main agent'));
  assert.equal(fs.readFileSync(path.join(dir, 'source.txt'), 'utf8'), 'Supplied evidence');
});
test('review-only debate skips investigations and inherits disabled networking and read-only access', async () => {
  const session = makeSession({ mode: 'debate', readOnly: true });
  session.policy.network = 'disabled'; session.contract.policy = session.policy;
  session.contract.scope = { allowedTargets: ['https://approved.example'] }; saveSession(session);
  const launched = await start(session, { reviewOnly: true, participants: ['codex'], rounds: 1, runtimeSeconds: 20 });
  const job = await finished(launched.executionId); assert.equal(job.exitCode, 2, job.error);
  const result = getRecord('debate', session.id);
  assert.equal(result.independentInvestigationPerformed, false);
  assert.equal(result.newVerificationPerformed, false);
  assert.equal(result.investigation, null);
  assert.equal(result.transcript.length, 1);
  const assignments = listRecords('assignment').filter(item => item.parentSessionId === session.id);
  assert.equal(assignments.length, 2);
  for (const assignment of assignments) {
    assert.equal(assignment.role, 'reviewer');
    assert.equal(assignment.contract.policy.mode, 'read-only');
    assert.equal(assignment.contract.policy.network, 'disabled');
    assert.deepEqual(assignment.contract.scope, session.contract.scope);
  }
  assert.equal(fs.readFileSync(path.join(dir, 'source.txt'), 'utf8'), 'Supplied evidence');
});
test('debate stops before an opening case when independent work yields no usable evidence', async () => {
  process.env.BZZY_TEST_ADVANCED = 'debate-no-evidence';
  const session = makeSession({ mode: 'debate' }), launched = await start(session, { participants: ['codex', 'claude'], rounds: 5, runtimeSeconds: 30 });
  const job = await finished(launched.executionId, 40000); assert.equal(job.exitCode, 2, job.error);
  const result = getRecord('debate', session.id);
  assert.equal(result.stopReason, 'insufficient_investigation_evidence'); assert.equal(result.opening, null); assert.deepEqual(result.transcript, []);
  assert.equal(result.investigationReadiness.usable, 0); assert.equal(result.investigationReadiness.required, 2);
  const history = (await new BzzyClient(launched.info).events(session.id, 0, 1000)).events;
  assert.ok(history.some(event => event.type === 'info' && /evidence phase not ready/.test(event.data.message)));
  assert.ok(!history.some(event => ['debate.opening', 'debate.round'].includes(event.type)));
  assert.equal(listRecords('assignment').filter(item => item.parentSessionId === session.id).length, 3, 'only the three independent investigations ran');
});
test('debate challenges independent majority agreement and checks the original goal before completion', async () => {
  process.env.BZZY_TEST_ADVANCED = 'debate-agreement';
  const session = makeSession({ mode: 'debate' }), launched = await start(session, { participants: ['codex', 'claude'], rounds: 5, runtimeSeconds: 30 });
  const job = await finished(launched.executionId, 40000); assert.equal(job.exitCode, 0, job.error);
  const result = getRecord('debate', session.id);
  assert.equal(result.stopReason, 'issues_resolved'); assert.equal(result.transcript.length, 1); assert.ok(result.opening); assert.deepEqual(result.unresolvedDisagreement, []);
  assert.equal(result.assessment.passed, true); assert.equal(result.assessment.challengeRounds, 1); assert.equal(result.goalSatisfaction, 'supported');
  assert.equal(result.investigationConsensus.verdict, 'real'); assert.equal(result.investigationConsensus.counts.real, 3);
  assert.equal(result.outcome, 'assessed'); assert.equal(loadSession(session.id).goal.status, 'complete');
  const notification = listRecords('goal-event').find(event => event.sessionId === session.id && event.type === 'goal.completed');
  assert.equal(notification.mode, 'debate'); assert.equal(notification.result.consensus.verdict, 'real');
  assert.equal(notification.result.consensus.counts.real, 3); assert.equal(notification.reason, 'issues_resolved');
  assert.equal(notification.usage.agents.length, 6);
});
test('parallel agents receive the same goal, independent sessions and attributed project ledgers', async () => {
  const session = makeSession({ mode: 'parallel' }), launched = await start(session, { agents: 'codex,claude,deepseek', concurrency: 3, runtimeSeconds: 30 });
  const job = await finished(launched.executionId, 40000); assert.equal(job.exitCode, 0, job.error);
  const result = getRecord('parallel-result', session.id); assert.equal(result.peers.length, 3);
  assert.equal(new Set(result.peers.map(p => p.sessionId)).size, 3);
  for (const peer of result.peers) {
    const child = loadSession(peer.sessionId); assert.equal(child.goal.objective, session.goal.objective); assert.equal(child.goal.status, 'complete');
    assert.deepEqual(child.backendHomes, session.backendHomes);
    assert.ok(fs.readdirSync(path.join(dir, '.bzzy', 'agents', peer.namespace, 'issues')).length);
  }
  assert.equal(result.usage.totalTokens, 104); assert.ok(result.usage.complete);
  const client = new BzzyClient(launched.info), group = await client.session(session.id);
  assert.equal(group.capabilities.chatTabs, true); assert.equal(group.children.length, 3);
  const token = await client.observerToken(session.id), viewer = new BzzyClient({ url: launched.info.url, token: token.token });
  const owner = randomUUID(); await client.claim(session.id, owner, true);
  for (const peer of result.peers) {
    const snapshot = await viewer.session(peer.sessionId); assert.equal(snapshot.inputOwner.owner, owner);
    const history = await viewer.events(peer.sessionId);
    assert.ok(history.events.some(e => e.type === 'message.user' && e.data.text === session.goal.objective));
    assert.ok(history.events.some(e => e.type === 'text'));
    await assert.rejects(viewer.execute(peer.sessionId, { owner, prompt: 'Not allowed', requestId: randomUUID() }), /observation only/);
  }
  const first = result.peers[0].sessionId;
  const message = await client.execute(first, { owner, prompt: 'Explain your findings and uncertainty', requestId: randomUUID() });
  assert.equal((await finished(message.executionId)).exitCode, 0);
  const history = await client.events(first);
  assert.ok(history.events.some(e => e.type === 'message.user' && e.data.text === 'Explain your findings and uncertainty'));
  const separateOwner = randomUUID(); await client.claim(first, separateOwner, true);
  await assert.rejects(client.control(first, { owner, action: 'pause', requestId: randomUUID() }), /own input/);
  assert.equal((await client.session(result.peers[1].sessionId)).inputOwner.owner, owner);
  await client.release(session.id, owner);
  assert.equal((await client.session(first)).inputOwner.owner, separateOwner);
  assert.equal((await client.session(result.peers[1].sessionId)).inputOwner, null);
});

test('runtime restart preserves its address, observer tokens and the existing live runner', async () => {
  process.env.BZZY_TEST_ADVANCED = 'question';
  const session = makeSession(), launched = await start(session), client = new BzzyClient(launched.info);
  const observerToken = await client.observerToken(session.id);
  let question;
  for (let i = 0; i < 200 && !question; i++) {
    question = listRecords('question', { sessionId: session.id, state: 'pending' })[0];
    if (!question) await delay(30);
  }
  assert.ok(question, 'the runner waits for explicit input throughout the restart');
  assert.equal(getRecord('execution', launched.executionId).state, 'running');
  const runner = getRecord('execution', launched.executionId).runner;
  const seen = []; let finishInput, snapshots = 0, viewEnded = false;
  const watching = viewSession(session, { follow: true }, {
    interactive: true, cursors: new Map(), setSession() {}, updateSession() { snapshots++; },
    event(type, data) { seen.push({ type, data }); },
    ask() { return new Promise(resolve => { finishInput = () => resolve('/exit'); this.reader = { close: () => resolve(null) }; }); },
  }).finally(() => { viewEnded = true; });
  for (let attempt = 0; attempt < 100 && !snapshots; attempt++) await delay(10);
  assert.ok(snapshots);
  const maintenance = beginCoreMaintenance();
  try {
    await suspendCoreHost({ plan: servicePlan({ userHome: path.join(dir, 'operator'), coreHome: process.env.BZZY_HOME }), run: () => ({ status: 1 }) });
    await assert.rejects(ensureRuntime(), { code: 'CORE_MAINTENANCE' });
    assert.ok(identityAlive(runner));
    assert.equal(getRecord('execution', launched.executionId).state, 'running');
    assert.equal(loadSession(session.id).goal?.status, session.goal?.status);
    await delay(4500); // Longer than the transport's ordinary request retries.
    assert.equal(viewEnded, false, 'an open CLI must survive the control handoff');
  } finally { maintenance(); }
  const restarted = await ensureRuntime(); assert.equal(restarted.url, launched.info.url); assert.equal(restarted.token, launched.info.token);
  assert.ok(identityAlive(runner));
  assert.deepEqual(getRecord('execution', launched.executionId).runner, runner);
  const observer = new BzzyClient({ url: restarted.url, token: observerToken.token });
  assert.equal((await observer.session(session.id)).execution.id, launched.executionId);
  appendEvent(session.id, 'text', { text: 'Control handoff replay marker', messageId: 'handoff-replay' });
  for (let attempt = 0; attempt < 200 && !seen.some(item => item.data.text === 'Control handoff replay marker'); attempt++) await delay(20);
  finishInput(); await watching;
  assert.equal(seen.filter(item => item.data.text === 'Control handoff replay marker').length, 1);
  await runtimeRequest(restarted, 'POST', `/sessions/${session.id}/answer`, { owner: launched.owner, questionId: question.id, answer: 'approved-account-A' }, randomUUID());
  assert.equal((await finished(launched.executionId)).exitCode, 0);
  const logs = fs.readFileSync(path.join(dir, 'backend.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(logs.filter(item => item.started).length, 1);
});

test('connection status verifies the running Core, keeps a disabled Relay offline and rejects observer administration', async () => {
  const session = makeSession(), info = await ensureRuntime(), client = new BzzyClient(info);
  const state = await runtimeRequest(info, 'GET', '/v1/connections');
  assert.equal(state.core.online, true); assert.equal(state.relay.online, false);
  assert.deepEqual(state.identity, info.identity);
  const observer = await client.observerToken(session.id);
  await assert.rejects(runtimeRequest({ url: info.url, token: observer.token }, 'GET', '/v1/connections'), /local owner/);
});

test('cancelling a parallel group stops active work and prevents queued peers from launching', async () => {
  process.env.BZZY_TEST_ADVANCED = 'slow';
  const session = makeSession({ mode: 'parallel' }), launched = await start(session, { agents: 'codex,claude,deepseek', concurrency: 1, runtimeSeconds: 30 });
  const client = new BzzyClient(launched.info);
  let group;
  for (let i = 0; i < 150; i++) { group = await client.session(session.id); if (group.children.length === 3 && listRecords('execution').some(j => j.sessionId === group.children[0].id)) break; await delay(20); }
  assert.equal(group.children.length, 3);
  await client.control(session.id, { owner: launched.owner, action: 'cancel', requestId: randomUUID() });
  assert.equal((await finished(launched.executionId)).exitCode, 130);
  const childIds = new Set(group.children.map(child => child.id));
  assert.equal(listRecords('execution').filter(job => childIds.has(job.sessionId) && ['queued', 'launching', 'running'].includes(job.state)).length, 0);
  assert.equal(loadSession(session.id).goal.status, 'cancelled');
  for (const child of group.children) assert.equal(loadSession(child.id).goal.status, 'cancelled');
  assert.deepEqual(getRecord('parallel-result', session.id).pendingStopSessions, []);
});
