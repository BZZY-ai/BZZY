import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createSession } from '../src/store.js';
import { BUILTINS } from '../src/providers.js';
import { newGoal } from '../src/goals.js';
import { goalEvent, NotificationHub } from '../src/notifications.js';

let dir, session, previousEnv;
test.beforeEach(() => {
  previousEnv = Object.fromEntries(['BZZY_HOME', 'BZZY_TELEGRAM_BOT_TOKEN', 'BZZY_TELEGRAM_CHAT_ID'].map(key => [key, process.env[key]]));
  delete process.env.BZZY_TELEGRAM_BOT_TOKEN; delete process.env.BZZY_TELEGRAM_CHAT_ID;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-notifications-')); process.env.BZZY_HOME = dir;
  session = createSession(BUILTINS.codex, dir); session.goal = newGoal('Finish the task');
});
test.afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); for (const [key, value] of Object.entries(previousEnv)) if (value == null) delete process.env[key]; else process.env[key] = value; });

test('goal outcomes and explicit pauses create distinct versioned provider-neutral events', () => {
  assert.equal(goalEvent(session), null);
  session.goal.status = 'paused'; assert.equal(goalEvent(session).type, 'goal.paused');
  session.goal.status = 'cancelled'; assert.equal(goalEvent(session).type, 'goal.cancelled');
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
