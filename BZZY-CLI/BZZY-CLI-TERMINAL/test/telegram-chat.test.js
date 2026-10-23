import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { root } from '../src/process.js';
import { createSession, saveSession, loadSession, writeJson } from '../src/store.js';
import { BUILTINS, saveConfig, config } from '../src/providers.js';
import { prepareTask } from '../src/task.js';
import { getRecord, putRecord, listRecords, appendEvent, events, digest } from '../src/database.js';
import { ensureRuntime, runtimeInfo, runtimeRequest, claimInput, requireOwner, effectiveInputOwner } from '../src/runtime.js';
import { identityAlive } from '../src/recovery.js';
import { delay } from '../src/delegation.js';
import { linkTelegram, unlinkTelegram, telegramAttachment, telegramViewState, updateTelegramAttachment } from '../src/telegram-state.js';
import { replyText, TelegramBridge, telegramAuthorizedMessage } from '../src/telegram-bridge.js';
import { TelegramApi, telegramTextParts } from '../src/telegram-api.js';
import { pairTelegram, configureTelegram, attachTelegram, autoAttachTelegram } from '../src/telegram.js';

let directory, previous, sequence;
const keys = ['BZZY_HOME', 'BZZY_CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'BZZY_CODEX_BIN', 'BZZY_CLAUDE_BIN', 'BZZY_TEST_ADVANCED', 'BZZY_TEST_LOG', 'BZZY_TELEGRAM_BOT_TOKEN', 'BZZY_TELEGRAM_CHAT_ID', 'DEEPSEEK_API_KEY'];
test.beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-tg-chat-')); sequence = 100;
  previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { BZZY_HOME: path.join(directory, 'private'), BZZY_CODEX_HOME: path.join(directory, 'codex'), CLAUDE_CONFIG_DIR: path.join(directory, 'claude'),
    BZZY_CODEX_BIN: path.join(root, 'test/fixtures/advanced-agent.mjs'), BZZY_CLAUDE_BIN: path.join(root, 'test/fixtures/advanced-agent.mjs'), BZZY_TEST_ADVANCED: 'conversation', BZZY_TEST_LOG: path.join(directory, 'backend.jsonl'), DEEPSEEK_API_KEY: 'fixture-only-key' });
  delete process.env.BZZY_TELEGRAM_BOT_TOKEN; delete process.env.BZZY_TELEGRAM_CHAT_ID;
  writeJson(path.join(directory, 'private', 'credentials.json'), { telegramBotToken: '12345:fixture_bot_token' });
  saveConfig({ version: 1, providers: {}, notifications: { telegram: { enabled: false, chatId: '42' } } });
  fs.writeFileSync(path.join(directory, 'source.txt'), 'Supplied fixture');
});
test.afterEach(async () => {
  const info = runtimeInfo(); if (info && identityAlive(info.identity)) await runtimeRequest(info, 'POST', '/shutdown', {}).catch(() => {});
  for (let i = 0; i < 80 && info && identityAlive(info.identity); i++) await delay(20);
  for (const [key, value] of Object.entries(previous)) if (value == null) delete process.env[key]; else process.env[key] = value;
  fs.rmSync(directory, { recursive: true, force: true });
});
class FakeBot {
  constructor() { this.sent = []; this.calls = []; this.updates = []; this.next = 1000; }
  async call(method, body) {
    this.calls.push({ method, body });
    if (method === 'getMe') return { id: 12345, username: 'bzzy_fixture_bot' };
    if (method === 'getWebhookInfo') return { url: '' };
    if (method === 'getUpdates') return body.offset === -1 ? [] : this.updates.filter(update => update.update_id >= body.offset);
    return true;
  }
  async send(chatId, text, extra = {}) { const record = { message_id: this.next++, chatId, text, extra }; this.sent.push(record); return record; }
}
function session() {
  const result = createSession(BUILTINS.codex, directory); prepareTask(result, {}, 'Continue this conversation');
  result.backendHomes.codexApi = path.join(directory, 'api'); saveSession(result); return result;
}
function attach(source) { const owner = randomUUID(); claimInput(source.id, owner); return { owner, attachment: linkTelegram(source.id, () => requireOwner(source.id, owner)) }; }
function incoming(text, extra = {}) { return { update_id: sequence++, message: { message_id: sequence, text, chat: { id: 42, type: 'private' }, from: { id: 42, is_bot: false }, ...extra } }; }
function callback(data) { return { update_id: sequence++, callback_query: { id: 'callback-' + sequence, data, from: { id: 42, is_bot: false }, message: { chat: { id: 42, type: 'private' } } } }; }
function fixtureBridge(bot = new FakeBot()) { return { bot, bridge: new TelegramBridge({ apiFactory: () => bot, minSendIntervalMs: 0 }) }; }
async function drain(bridge) { await bridge.tick(); for (let i = 0; i < 100 && listRecords('telegram-delivery').some(row => row.attachmentId === telegramAttachment()?.id && row.state === 'pending'); i++) await bridge.tick(); }
async function finished(id) {
  for (let i = 0; i < 300; i++) { const result = getRecord('execution', id); if (result && !['queued', 'launching', 'running'].includes(result.state)) return result; await delay(30); }
  throw new Error('Fixture execution did not finish.');
}

test('attachment mirrors only new terminal and assistant messages and stops forwarding when disabled', async () => {
  const source = session();
  appendEvent(source.id, 'message.user', { text: 'OLD-HISTORY', executionId: 'old' });
  appendEvent(source.id, 'text', { text: 'OLD-ANSWER' });
  const { attachment } = attach(source), { bot, bridge } = fixtureBridge();
  try {
    await bridge.initialize(bridge.binding());
    appendEvent(source.id, 'message.user', { text: 'New terminal message', executionId: 'new' });
    appendEvent(source.id, 'text', { text: 'New assistant reply.' });
    appendEvent(source.id, 'execution.finished', { id: 'new', exitCode: 0 });
    await drain(bridge);
    assert.match(bot.sent.map(item => item.text).join('\n'), /🖥 TERMINAL INPUT\nNew terminal message.*New assistant reply/s);
    assert.doesNotMatch(bot.sent.map(item => item.text).join('\n'), /OLD-HISTORY|OLD-ANSWER/);
    const before = bot.sent.length;
    unlinkTelegram(attachment.id);
    appendEvent(source.id, 'message.user', { text: 'After disabling', executionId: 'after' });
    appendEvent(source.id, 'text', { text: 'Not forwarded.' }); appendEvent(source.id, 'execution.finished', { id: 'after' });
    await bridge.tick(); assert.equal(bot.sent.length, before);
    assert.equal(config().notifications.telegram.enabled, false);
  } finally { bridge.close(); }
});
test('attaching mid-reply does not forward text from before the attachment', async () => {
  const source = session(); appendEvent(source.id, 'message.user', { text: 'OLD-REQUEST', executionId: 'mid' }); appendEvent(source.id, 'text', { text: 'OLD-PARTIAL' });
  attach(source); const { bot, bridge } = fixtureBridge();
  try {
    await bridge.initialize(bridge.binding()); appendEvent(source.id, 'text', { text: 'Only this new part.' }); appendEvent(source.id, 'execution.finished', { id: 'mid' });
    await drain(bridge); const text = bot.sent.map(item => item.text).join('\n');
    assert.match(text, /Only this new part/); assert.doesNotMatch(text, /OLD-/);
  } finally { bridge.close(); }
});
test('an attached chat receives the structured debate result when the run has no assistant text event', () => {
  const source = session(); source.mode = 'debate'; source.goal = {
    id: randomUUID(), objective: 'validate this finding', status: 'complete', reason: 'majority_consensus',
    tokensUsed: 300, runtimeUsedSeconds: 65, turns: 1, evidence: []
  };
  source.summary = { usage: { complete: true, agents: [{ provider: 'codex', model: 'fixture', tokens: 300 }] } };
  source.modeResult = { goalId: source.goal.id, kind: 'debate', outcome: 'assessed',
    consensus: { verdict: 'real', total: 2, required: 2, counts: { real: 2 } }, conclusions: ['The finding is real.'], unresolved: [] };
  saveSession(source);
  appendEvent(source.id, 'message.user', { text: '/goal validate this finding', executionId: 'debate-run' });
  appendEvent(source.id, 'text', { text: 'Final debate note.' });
  const finished = appendEvent(source.id, 'execution.finished', { id: 'debate-run', exitCode: 0 });
  const text = replyText(source.id, 'debate-run', finished.seq);
  assert.match(text, /^Final debate note\./);
  assert.match(text, /\/goal validate this finding/);
  assert.match(text, /CONSENSUS 2\/2 · REAL/);
  assert.match(text, /GOAL ACHIEVED · 00:01:05 · 300 tokens/);
});
test('enabled goal notifications prevent an attached chat from duplicating the debate summary', () => {
  const source = session(); source.mode = 'debate'; source.goal = {
    id: randomUUID(), objective: 'validate this finding', status: 'complete', reason: 'majority_consensus',
    tokensUsed: 300, runtimeUsedSeconds: 65, turns: 1, evidence: []
  };
  source.summary = { usage: { complete: true, agents: [] } };
  source.modeResult = { goalId: source.goal.id, kind: 'debate', outcome: 'assessed',
    consensus: { verdict: 'real', total: 2, required: 2, counts: { real: 2 } }, conclusions: ['The finding is real.'], unresolved: [] };
  saveSession(source);
  const value = config(); value.notifications.telegram.enabled = true; saveConfig(value);
  appendEvent(source.id, 'message.user', { text: '/goal validate this finding', executionId: 'debate-run' });
  const finished = appendEvent(source.id, 'execution.finished', { id: 'debate-run', exitCode: 0 });
  assert.equal(replyText(source.id, 'debate-run', finished.seq), '');
});
test('only the paired private sender is accepted and received updates are durable and deduplicated', async () => {
  const source = session(), { attachment } = attach(source), { bridge } = fixtureBridge();
  try {
    await bridge.initialize(bridge.binding());
    const valid = incoming('Remember this chat marker: orchard-violet');
    const stranger = incoming('Foreign command', { chat: { id: 43, type: 'private' }, from: { id: 43 } });
    const group = incoming('Group command', { chat: { id: 42, type: 'group' } });
    const bot = incoming('Bot command', { from: { id: 42, is_bot: true } });
    assert.equal(telegramAuthorizedMessage(valid, attachment), true);
    for (const rejected of [stranger, group, bot]) assert.equal(telegramAuthorizedMessage(rejected, attachment), false);
    bridge.receive([valid, stranger, group, bot], attachment); bridge.receive([valid], attachment);
    assert.equal(listRecords('telegram-inbox').length, 1);
    assert.equal(events(source.id).filter(event => event.type === 'telegram.message' && event.data.direction === 'incoming').length, 1);
    assert.equal(getRecord('telegram-poll', attachment.bot).offset, bot.update_id + 1);
  } finally { bridge.close(); }
});
test('restarting the Telegram relay resumes its saved cursor and keeps messages received while disconnected', async () => {
  const source = session(), { attachment } = attach(source), bot = new FakeBot(), first = fixtureBridge(bot).bridge;
  await first.initialize(first.binding());
  const received = incoming('Before disconnect'); first.receive([received], attachment); first.close();
  updateTelegramAttachment(attachment.id, { status: 'reconnecting' });
  const offline = incoming('While disconnected'); bot.updates = [received, offline];
  const second = fixtureBridge(bot).bridge;
  try {
    await second.pollOnce();
    assert.equal(bot.calls.filter(call => call.method === 'getUpdates' && call.body.offset === -1).length, 1, 'restarts must not discard the backlog again');
    assert.equal(listRecords('telegram-inbox').length, 2);
    assert.equal(getRecord('telegram-poll', attachment.bot).offset, offline.update_id + 1);
    await second.pollOnce(); assert.equal(listRecords('telegram-inbox').length, 2, 'an update is recorded once across reconnects');
  } finally { second.close(); }
});
test('delivery respects rate-limit order and never automatically retries an uncertain send', async () => {
  const source = session(); attach(source); const { bot, bridge } = fixtureBridge();
  try {
    const attachment = bridge.binding(); await bridge.initialize(attachment); await drain(bridge);
    const send = bot.send.bind(bot); let attempts = 0;
    bot.send = async (...args) => { attempts++; if (attempts === 1) throw Object.assign(new Error('Rate limited'), { definite: true, retryAfter: 30 }); return send(...args); };
    const [first] = bridge.queueText(attachment, 'ordered-first', 'First message'); bridge.queueText(attachment, 'ordered-second', 'Second message');
    await bridge.tick(); await bridge.tick(); assert.equal(attempts, 1, 'later messages must wait for the first message’s retry delay');
    putRecord('telegram-delivery', first.id, { ...getRecord('telegram-delivery', first.id), retryAt: 0 }); await drain(bridge);
    assert.deepEqual(bot.sent.slice(-2).map(row => row.text), ['First message', 'Second message']);
    bot.send = async () => { attempts++; throw new Error('Connection lost after sending'); };
    const [uncertain] = bridge.queueText(attachment, 'uncertain', 'May have been delivered'); await bridge.tick(); const before = attempts;
    await bridge.tick(); await bridge.tick(); assert.equal(attempts, before);
    assert.equal(getRecord('telegram-delivery', uncertain.id).state, 'uncertain');
  } finally { bridge.close(); }
});
test('a goal started from Telegram retains project boundaries and limits and uses the persistent goal controller', async () => {
  const source = session();
  source.contract.constraints = ['Only inspect supplied files']; source.contract.scope = { domains: ['example.test'] };
  source.contract.limits = { ...source.contract.limits, runtimeSeconds: 30, tokenBudget: 500 };
  source.contract.policy = { ...source.contract.policy, mode: 'read-only', writablePaths: [] }; source.policy = source.contract.policy; source.strictPolicy = true; saveSession(source);
  await ensureRuntime(); const { attachment } = attach(source), { bridge } = fixtureBridge();
  try {
    await bridge.initialize(bridge.binding()); const update = incoming('/goal Inspect the supplied project and report verified observations');
    bridge.receive([update], attachment); await bridge.tick();
    const job = getRecord('telegram-inbox', `${attachment.bot}:${update.update_id}`);
    const result = await finished(job.executionId); assert.equal(result.exitCode, 0, result.error);
    const saved = loadSession(source.id);
    assert.equal(saved.goal.status, 'complete'); assert.equal(saved.goal.tokenBudget, 500);
    assert.equal(saved.policy.mode, 'read-only'); assert.deepEqual(saved.contract.constraints, source.contract.constraints); assert.deepEqual(saved.contract.scope, source.contract.scope);
    assert.equal(saved.contract.limits.runtimeSeconds, 30); assert.equal(saved.strictPolicy, true);
    assert.ok(events(source.id).some(event => event.type === 'goal.completed'));
  } finally { bridge.close(); }
});

test('a new Telegram /goal stops and replaces active work in the same conversation', async () => {
  process.env.BZZY_TEST_ADVANCED = 'slow';
  const source = session(); await ensureRuntime();
  const { attachment } = attach(source), { bridge } = fixtureBridge();
  try {
    await bridge.initialize(bridge.binding());
    bridge.receive([incoming('/goal Original task')], attachment); await bridge.tick();
    const original = loadSession(source.id).goal;
    const first = listRecords('telegram-inbox').find(item => item.text === '/goal Original task');
    bridge.receive([incoming('/goal Replacement task')], attachment); await bridge.tick();
    assert.equal((await finished(first.executionId)).exitCode, 130);
    await bridge.tick();
    const replacement = listRecords('telegram-inbox').find(item => item.text === '/goal Replacement task');
    assert.ok(replacement.executionId);
    assert.equal((await finished(replacement.executionId)).exitCode, 0);
    const saved = loadSession(source.id);
    assert.equal(saved.goal.objective, 'Replacement task'); assert.equal(saved.goal.status, 'complete');
    assert.equal(getRecord('goal-history', original.id).supersededBy, saved.goal.id);
    assert.equal(saved.id, source.id);
  } finally { bridge.close(); }
});
test('Telegram and terminal input share one native conversation, queue while busy and execute an update once', async () => {
  const source = session(), info = await ensureRuntime(), { owner, attachment } = attach(source), { bot, bridge } = fixtureBridge();
  try {
    await bridge.initialize(bridge.binding());
    const update = incoming('Remember this chat marker: orchard-violet'); bridge.receive([update], attachment); await bridge.tick();
    const inbox = listRecords('telegram-inbox')[0]; assert.equal(inbox.state, 'dispatched');
    const queued = incoming('Repeat the chat marker'); bridge.receive([queued], attachment); await bridge.tick();
    assert.equal(listRecords('execution').length, 1);
    assert.equal((await finished(inbox.executionId)).exitCode, 0);
    const firstThread = loadSession(source.id).engineThreadId;
    await bridge.tick(); const second = listRecords('telegram-inbox').find(row => row.updateId === queued.update_id);
    assert.equal((await finished(second.executionId)).exitCode, 0);
    assert.equal(loadSession(source.id).engineThreadId, firstThread);
    bridge.receive([update], attachment); await drain(bridge); assert.equal(listRecords('execution').length, 2);
    const terminal = await runtimeRequest(info, 'POST', `/sessions/${source.id}/execute`, { owner, prompt: 'What chat marker did I give you?', options: {}, goal: false }, randomUUID());
    assert.equal((await finished(terminal.executionId)).exitCode, 0); await drain(bridge);
    assert.match(bot.sent.map(row => row.text).join('\n'), /The chat marker is orchard-violet/);
    assert.ok(events(source.id).some(event => event.type === 'message.user' && event.data.channel === 'telegram'));
    assert.equal(effectiveInputOwner(source.id).owner, owner, 'Telegram is an explicitly delegated channel and does not take the terminal lease');
  } finally { bridge.close(); }
});
test('Telegram questions require direct replies and cannot approve a permission from unrelated chat text', async () => {
  const source = session(), { attachment } = attach(source), { bot, bridge } = fixtureBridge();
  try {
    await bridge.initialize(bridge.binding());
    const question = { id: randomUUID(), sessionId: source.id, kind: 'approval', question: 'Allow this local check?', state: 'pending' }; putRecord('question', question.id, question);
    putRecord('execution', 'active', { id: 'active', sessionId: source.id, state: 'running' });
    await drain(bridge); const sent = bot.sent.find(row => row.text.includes(question.question)); assert.ok(sent.extra.reply_markup.force_reply);
    bridge.receive([incoming('yes')], attachment); await bridge.tick(); assert.equal(getRecord('question', question.id).state, 'pending');
    bridge.receive([incoming('yes', { reply_to_message: { message_id: sent.message_id } })], attachment); await bridge.tick();
    assert.equal(getRecord('question', question.id).state, 'answered'); assert.equal(getRecord('question', question.id).answeredBy, 'telegram');
  } finally { bridge.close(); }
});
test('bot provider/model/effort menus retain the conversation, respect the terminal owner and pass history to the next provider', async () => {
  const source = session(), info = await ensureRuntime(), { owner, attachment } = attach(source), { bot, bridge } = fixtureBridge();
  const original = await runtimeRequest(info, 'POST', `/sessions/${source.id}/execute`, { owner, prompt: 'Remember this chat marker: orchard-violet', options: {}, goal: false }, randomUUID());
  assert.equal((await finished(original.executionId)).exitCode, 0);
  async function select(label) {
    await drain(bridge);
    const menu = bot.sent.findLast(item => item.extra.reply_markup?.inline_keyboard);
    const button = menu.extra.reply_markup.inline_keyboard.flat().find(row => row.text.includes(label)); assert.ok(button, JSON.stringify(menu));
    assert.ok(Buffer.byteLength(button.callback_data) <= 64);
    bridge.receive([callback(button.callback_data)], telegramAttachment()); await bridge.tick();
  }
  try {
    await bridge.initialize(bridge.binding()); bridge.receive([incoming('/providers')], attachment); await bridge.tick();
    await select('claude'); await select('Opus'); await select('high');
    assert.equal(loadSession(source.id).provider, 'claude'); assert.equal(loadSession(source.id).model, 'opus'); assert.equal(loadSession(source.id).selectedEffort, 'high');
    assert.equal(effectiveInputOwner(source.id).owner, owner);
    bridge.receive([incoming('/default')], telegramAttachment()); await bridge.tick(); await drain(bridge);
    assert.equal(config().defaultSelection.provider, 'claude'); assert.equal(config().defaultSelection.model, 'opus'); assert.equal(config().defaultSelection.effort, 'high');
    assert.deepEqual(config().defaultSelection.capabilities.supportedEfforts, ['medium', 'high']);
    assert.match(bot.sent.at(-1).text, /Default saved · claude · opus · effort high/);
    bridge.receive([incoming('Recall the marker in this same conversation')], telegramAttachment()); await bridge.tick();
    const latest = listRecords('telegram-inbox').find(row => row.text.startsWith('Recall')); assert.equal((await finished(latest.executionId)).exitCode, 0);
    await drain(bridge); assert.match(bot.sent.map(row => row.text).join('\n'), /orchard-violet/);
    assert.ok(bot.calls.some(row => row.method === 'setMyCommands' && row.body.commands.some(command => command.command === 'providers')));
    assert.ok(bot.calls.some(row => row.method === 'setMyCommands' && row.body.commands.some(command => command.command === 'default')));
  } finally { bridge.close(); }
});
test('bot-token pairing discovers the private chat ID without prompting for it and preserves notification preference', async () => {
  let phrase, asks = 0, polls = 0;
  const bot = new FakeBot();
  bot.call = async (method, body) => {
    if (method === 'getMe') return { username: 'bzzy_fixture_bot' };
    if (method === 'getWebhookInfo') return { url: '' };
    if (method === 'getUpdates' && body.offset === -1) return [{ update_id: 1 }];
    if (method === 'getUpdates') { polls++; return [incoming('Wrong pairing phrase'), incoming(phrase, { chat: { id: 42, type: 'group' } }), incoming(phrase)]; }
  };
  const ui = { interactive: true, async secret() { return '98765:new_fixture_token'; }, async ask() { asks++; throw new Error('Chat ID must be discovered automatically'); }, event(_type, data) { const match = /send: (BZZY [A-F0-9]+)/.exec(data.message); if (match) phrase = match[1]; } };
  const result = await pairTelegram(ui, { apiFactory: () => bot, stopBridge: async () => {}, startBridge: async () => {} });
  assert.equal(result.chatId, '42'); assert.ok(phrase.startsWith('BZZY ')); assert.equal(asks, 0); assert.equal(polls, 1);
  assert.equal(config().notifications.telegram.chatId, '42'); assert.equal(config().notifications.telegram.enabled, false);
  assert.equal(config().notifications.telegram.autoAttach, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'private', 'credentials.json'))).telegramBotToken, '98765:new_fixture_token');
  assert.equal(fs.statSync(path.join(directory, 'private', 'credentials.json')).mode & 0o777, 0o600);
});
test('notifications and chat attachment are independent switches', async () => {
  const source = session(), { attachment } = attach(source), ui = { event() {} };
  await configureTelegram('on', ui); assert.equal(config().notifications.telegram.enabled, true); assert.ok(telegramAttachment());
  await configureTelegram('off', ui); assert.equal(config().notifications.telegram.enabled, false); assert.equal(telegramAttachment().id, attachment.id);
  await configureTelegram('detach', ui, { stopBridge: async () => {} }); assert.equal(telegramViewState(source.id).attached, false); assert.equal(config().notifications.telegram.enabled, false);
});
test('auto-attach preserves the paired conversation and explicit attach can move it', async () => {
  const first = session(), second = session(); let starts = 0;
  const context = { startBridge: async () => { starts++; } };
  const initial = await attachTelegram(first.id, undefined, context);
  assert.equal(config().notifications.telegram.autoAttach, true);
  assert.equal(config().notifications.telegram.enabled, false);
  const restored = await autoAttachTelegram(first, context);
  assert.equal(restored.id, initial.id, 'reopening the same chat preserves its delivery cursor');
  assert.equal(await autoAttachTelegram(second, context), undefined);
  assert.equal(telegramAttachment().sessionId, first.id);
  assert.equal(starts, 2, 'another terminal does not start or retarget the bridge');
  const next = await attachTelegram(second.id, undefined, context);
  assert.equal(next.sessionId, second.id); assert.equal(next.chatId, '42');
  assert.equal(telegramAttachment().sessionId, second.id);
  assert.equal(config().notifications.telegram.chatId, '42');
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'private', 'credentials.json'))).telegramBotToken, '12345:fixture_bot_token');
  assert.equal(starts, 3);
  await configureTelegram('detach', { event() {} }, { stopBridge: async () => {} });
  assert.equal(config().notifications.telegram.autoAttach, false);
  assert.equal(await autoAttachTelegram(first, context), undefined);
  assert.equal(starts, 3);
  assert.equal(telegramAttachment(), null);
});
test('bot detach disables auto-attach, and saved preferences skip groups and missing credentials', async () => {
  const source = session();
  const value = config(); value.notifications.telegram.autoAttach = true; saveConfig(value);
  let starts = 0; const context = { startBridge: async () => { starts++; } };
  assert.equal(await autoAttachTelegram({ ...source, mode: 'parallel' }, context), undefined);
  assert.equal(await autoAttachTelegram({ ...source, mode: 'besties' }, context), undefined);
  const group = config(); group.notifications.telegram.chatId = '-42'; saveConfig(group);
  assert.equal(await autoAttachTelegram(source, context), undefined);
  const privateChat = config(); privateChat.notifications.telegram.chatId = '42'; saveConfig(privateChat);
  fs.rmSync(path.join(directory, 'private', 'credentials.json'));
  assert.equal(await autoAttachTelegram(source, context), undefined);
  assert.equal(starts, 0);
  writeJson(path.join(directory, 'private', 'credentials.json'), { telegramBotToken: '12345:fixture_bot_token' });
  const attachment = await autoAttachTelegram(source, context);
  const { bridge } = fixtureBridge();
  try { bridge.binding(); await bridge.processMessage(attachment, { id: 'detach-command', text: '/detach' }); }
  finally { bridge.close(); }
  assert.equal(config().notifications.telegram.autoAttach, false);
  assert.equal(await autoAttachTelegram(source, context), undefined);
});
test('Telegram API redirects fail safely and Unicode replies split within message limits without losing text', async () => {
  const token = '12345:private_fixture_token', api = new TelegramApi(token, { fetchImpl: async (_url, options) => { assert.equal(options.redirect, 'error'); throw new Error('Network error with ' + token); } });
  await assert.rejects(api.call('getUpdates'), error => !error.message.includes(token) && !error.definite);
  const text = 'Hello 🐝\n'.repeat(1500), parts = telegramTextParts(text);
  assert.equal(parts.join(''), text); assert.ok(parts.every(part => part.length <= 3800 && !/[\uD800-\uDBFF]$/.test(part)));
});
