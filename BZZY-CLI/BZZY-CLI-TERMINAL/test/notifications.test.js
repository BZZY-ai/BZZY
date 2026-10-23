import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createSession } from '../src/store.js';
import { BUILTINS } from '../src/providers.js';
import { newGoal } from '../src/goals.js';
import { formatTelegram, goalEvent, NotificationHub, sendTelegram } from '../src/notifications.js';
import { telegramSettings } from '../src/notifications.js';
import { configureTelegram } from '../src/telegram.js';

let dir, session, previousEnv;
test.beforeEach(() => {
  previousEnv = Object.fromEntries(['BZZY_HOME', 'BZZY_TELEGRAM_BOT_TOKEN', 'BZZY_TELEGRAM_CHAT_ID'].map(key => [key, process.env[key]]));
  delete process.env.BZZY_TELEGRAM_BOT_TOKEN; delete process.env.BZZY_TELEGRAM_CHAT_ID;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-notifications-')); process.env.BZZY_HOME = dir;
  session = createSession(BUILTINS.codex, dir); session.goal = newGoal('Finish the task');
});
test.afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); for (const [key, value] of Object.entries(previousEnv)) if (value == null) delete process.env[key]; else process.env[key] = value; });

test('only completed and stalled lifecycle states create versioned provider-neutral events', () => {
  assert.equal(goalEvent(session), null);
  session.goal.status = 'paused'; assert.equal(goalEvent(session), null);
  session.goal.status = 'complete';
  assert.equal(goalEvent(session).type, 'goal.completed');
  for (const status of ['blocked', 'budget_limited', 'usage_limited']) {
    session.goal.status = status;
    assert.equal(goalEvent(session).type, 'goal.stalled');
  }
});

test('delivery failures are durable and retry does not resend successful destinations', async () => {
  let good = 0, flaky = 0;
  const registry = new Map([
    ['good', { enabled: () => true, send: async () => { good++; return { messageId: 1 }; } }],
    ['flaky', { enabled: () => true, send: async () => { if (++flaky === 1) throw new Error('offline'); return { messageId: 2 }; } }],
  ]);
  session.goal.status = 'complete';
  const hub = new NotificationHub({ registry });
  const first = await hub.publish(session);
  assert.equal(hub.records()[0].deliveries.flaky.status, 'failed');
  await new NotificationHub({ registry }).retry();
  assert.equal(good, 1); assert.equal(flaky, 2);
  const again = await hub.publish(session);
  assert.equal(first.id, again.id);
  assert.equal(good, 1); assert.equal(flaky, 2);
});

test('resuming a stalled goal creates a new notification epoch; historical events do not enroll new transports', async () => {
  session.goal.status = 'blocked';
  const hub = new NotificationHub({ registry: new Map() });
  await hub.publish(session);
  let sent = 0;
  const registry = new Map([['new', { enabled: () => true, send: async () => { sent++; } }]]);
  await new NotificationHub({ registry }).retry();
  assert.equal(sent, 0);
  session.goal.notificationEpoch = 1;
  await new NotificationHub({ registry }).publish(session);
  assert.equal(sent, 1);
});

test('concurrent delivery attempts cannot send the same outbox record twice', async () => {
  let sent = 0;
  const registry = new Map([['slow', { enabled: () => true, send: async () => {
    sent++;
    await new Promise(resolve => setTimeout(resolve, 30));
  } }]]);
  session.goal.status = 'complete';
  const first = new NotificationHub({ registry });
  const second = new NotificationHub({ registry });
  await Promise.all([first.publish(session), second.publish(session)]);
  assert.equal(sent, 1);
  await second.retry();
  assert.equal(sent, 1);
});

test('Telegram sends plain text, bounds message size, and redacts tokens from failures', async () => {
  session.goal.status = 'complete';
  session.goal.objective = 'x'.repeat(10000);
  const event = goalEvent(session);
  const result = await sendTelegram(event, { token: '123:secret', chatId: '-1001', fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.telegram.org/bot123:secret/sendMessage');
    const body = JSON.parse(options.body);
    assert.equal(body.chat_id, '-1001'); assert.ok(body.text.length <= 4096);
    assert.equal(body.parse_mode, undefined);
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 4 } }) };
  } });
  assert.equal(result.messageId, 4);
  await assert.rejects(sendTelegram(event, { token: '123:secret', chatId: '1', fetchImpl: async () => { throw new Error('failed at bot123:secret/sendMessage'); } }), error => !error.message.includes('123:secret'));
});
test('debate Telegram completion includes the goal, consensus, elapsed time, and per-agent usage', () => {
  session.mode = 'debate'; session.goal.status = 'complete';
  session.goal.objective = 'is this a real vulnerability or a false positive?';
  session.goal.reason = 'majority_consensus'; session.goal.tokensUsed = 2193661; session.goal.runtimeUsedSeconds = 263;
  session.summary = { usage: { complete: true, totalTokens: 2193661, agents: [
    { provider: 'codex', model: 'gpt-5.6-sol', tokens: 521671 },
    { provider: 'claude', model: 'claude-opus-5', tokens: 996076 },
    { provider: 'deepseek', model: 'deepseek-flash', tokens: 675914 }
  ] } };
  session.modeResult = { goalId: session.goal.id, kind: 'debate', outcome: 'assessed', stopReason: 'majority_consensus',
    consensus: { verdict: 'real', required: 2, total: 3, counts: { real: 3, false_positive: 0 } },
    conclusions: ['The finding is real.'], unresolved: [] };
  const text = formatTelegram(goalEvent(session));
  assert.match(text, /\/goal is this a real vulnerability or a false positive\?/);
  assert.match(text, /CONSENSUS 3\/3 · REAL\nThe finding is real\./);
  assert.match(text, /GOAL ACHIEVED · 00:04:23 · 2,193,661 tokens/);
  assert.match(text, /codex\/gpt-5\.6-sol · 521,671 tokens/);
  assert.match(text, /claude\/claude-opus-5 · 996,076 tokens/);
  assert.match(text, /deepseek\/deepseek-flash · 675,914 tokens/);
  assert.match(text, new RegExp(`Session · ${session.id}`));
  assert.match(text, /Reason · majority_consensus/);
});
test('interactive Telegram configuration persists private credentials and on/off controls achieved and stalled deliveries', async () => {
  const messages = []; let sent = 0, prompts = 0;
  const ui = { secret: async () => { prompts++; return '123:fixture_token'; }, ask: async () => '-1001234', event: (_type, data) => messages.push(data.message) };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    sent++; const body = JSON.parse(options.body); assert.equal(body.chat_id, '-1001234'); assert.match(body.text, /goal achieved|goal stalled/);
    return { ok: true, json: async () => ({ ok: true, result: { message_id: sent } }) };
  };
  try {
    fs.writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify({ deepseek: 'existing-fixture-key' }), { mode: 0o600 });
    await configureTelegram('manual', ui);
    assert.equal(telegramSettings().enabled, true); assert.equal(telegramSettings().token, '123:fixture_token'); assert.equal(sent, 0, 'setup never sends a test message');
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'credentials.json'))); assert.equal(saved.deepseek, 'existing-fixture-key');
    for (const file of ['credentials.json', 'config.json']) assert.equal(fs.statSync(path.join(dir, file)).mode & 0o777, 0o600);
    await configureTelegram('off', ui); assert.equal(telegramSettings().enabled, false);
    session.goal.status = 'complete'; const hub = new NotificationHub(); await hub.publish(session); assert.equal(sent, 0);
    await configureTelegram('on', ui); assert.equal(telegramSettings().enabled, true); assert.equal(prompts, 1);
    session.goal.notificationEpoch = 1; await hub.publish(session); assert.equal(sent, 1);
    session.goal.notificationEpoch = 2; session.goal.status = 'blocked'; await hub.publish(session); assert.equal(sent, 2);
    await configureTelegram('off', ui); session.goal.notificationEpoch = 3; await hub.publish(session); assert.equal(sent, 2);
    await configureTelegram('status', ui); assert.doesNotMatch(messages.join('\n'), /123:fixture_token/);
  } finally { globalThis.fetch = originalFetch; }
});
test('cancelling Telegram setup keeps existing settings and does not save partial credentials', async () => {
  const ui = { secret: async () => '123:fixture', ask: async () => null, event() {} };
  await configureTelegram('manual', ui); assert.equal(fs.existsSync(path.join(dir, 'credentials.json')), false);
  ui.secret = async () => null; ui.ask = async () => { throw new Error('Cancelled input must not request a chat ID.'); };
  await configureTelegram('manual', ui); assert.equal(telegramSettings().enabled, false);
});
