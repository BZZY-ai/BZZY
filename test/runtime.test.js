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
  ui.chooseOne = async (_title, choices) => Array.isArray(await choices) ? 'codex' : { value: 'fixture-brain', effort: 'xhigh' };
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
  const session = makeSession(), inputs = ['/telegram off', '/telegram status', '/models attached-model', '/exit'];
  const ui = { interactive: true, cursors: new Map(), setSession() {}, event() {}, updateSession() {}, async ask() { return inputs.shift(); } };
  assert.equal(await attachSession(session, {}, ui), 0);
  assert.equal(loadSession(session.id).model, 'attached-model');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'private', 'config.json'))).notifications.telegram.enabled, false);
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
test('attached goal resume keeps the same long-running objective and does not turn the word resume into a new goal', async () => {
  const source = makeSession({ mode: 'delegate', executor: 'deepseek' }); source.goal.status = 'paused'; saveSession(source);
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
test('debate preserves independent assessments, fixed snapshots and unresolved disagreement', async () => {
  const session = makeSession({ mode: 'debate' }), launched = await start(session, { artifact: 'source.txt', participants: ['codex', 'claude'], rounds: 3, runtimeSeconds: 30 });
  const job = await finished(launched.executionId, 40000); assert.equal(job.exitCode, 2, job.error || JSON.stringify(loadSession(session.id).goal));
  const result = getRecord('debate', session.id); assert.ok(result.transcript.length >= 2); assert.equal(result.stopReason, 'positions_stable');
  assert.deepEqual(result.unresolvedDisagreement, ['missing-control'], JSON.stringify(result.investigation)); assert.equal(result.newVerificationPerformed, null); assert.equal(result.newVerificationDuringRounds, false);
  assert.equal(result.outcome, 'unresolved'); assert.equal(loadSession(session.id).goal.status, 'awaiting_review');
  assert.equal(result.investigation.reports.length, 2);
  assert.ok(result.investigation.reports.every(report => report.artifacts.some(item => item.path?.startsWith('BZZY_INVESTIGATION_EVIDENCE/'))), JSON.stringify(result.investigation.reports));
  const history = (await new BzzyClient(launched.info).events(session.id, 0, 1000)).events;
  const investigationDone = history.findIndex(event => event.type === 'debate.phase' && event.data.status === 'finished');
  const firstDiscussion = history.findIndex(event => event.type === 'debate.message' && event.data.role === 'reviewer');
  assert.ok(investigationDone >= 0 && firstDiscussion > investigationDone);
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
  process.env.BZZY_TEST_ADVANCED = 'slow';
  const session = makeSession(), launched = await start(session), client = new BzzyClient(launched.info);
  const observerToken = await client.observerToken(session.id);
  for (let i = 0; i < 100 && getRecord('execution', launched.executionId)?.state !== 'running'; i++) await delay(20);
  assert.equal(getRecord('execution', launched.executionId).state, 'running');
  const runner = getRecord('execution', launched.executionId).runner;
  await runtimeRequest(launched.info, 'POST', '/shutdown', {});
  const restarted = await ensureRuntime(); assert.equal(restarted.url, launched.info.url); assert.equal(restarted.token, launched.info.token);
  assert.ok(identityAlive(runner));
  const observer = new BzzyClient({ url: restarted.url, token: observerToken.token });
  assert.equal((await observer.session(session.id)).execution.id, launched.executionId);
  assert.equal((await finished(launched.executionId)).exitCode, 0);
  const logs = fs.readFileSync(path.join(dir, 'backend.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(logs.filter(item => item.started).length, 1);
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
