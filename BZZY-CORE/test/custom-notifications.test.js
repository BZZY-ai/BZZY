import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { queueCustomNotification, currentCustomNotification } from '../src/engine/custom-notifications.js';
import { registerDeviceNotifications } from '../src/push/registration.js';
import { CorePushWorker } from '../src/push/worker.js';
import { getRecord, putRecord, listRecords, digest } from '../src/engine/database.js';
import { sessionPermissions } from '../src/engine/session-access.js';
import { ensureRuntime, runtimeInfo, runtimeRequest } from '../src/engine/runtime.js';
import { identityAlive } from '../src/engine/process-identity.js';
import { BzzyClient } from '../src/client.js';
import { fixture, pair } from '../../BZZY-RELAY/test/helpers.js';

let directory, previous;
const token = 'ab'.repeat(32);
test.beforeEach(() => {
  previous = process.env.BZZY_HOME; directory = fs.realpathSync(fs.mkdtempSync('/tmp/bc-custom-'));
  process.env.BZZY_HOME = path.join(directory, 'private'); fs.mkdirSync(process.env.BZZY_HOME, { mode: 0o700 });
});
test.afterEach(async () => {
  const info = runtimeInfo();
  if (info && identityAlive(info.identity)) await runtimeRequest(info, 'POST', '/shutdown', {}).catch(() => {});
  for (let i = 0; info && identityAlive(info.identity) && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 20));
  if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
  fs.rmSync(directory, { recursive: true, force: true });
});
function localRegistration({ hostId = 'H'.repeat(43), peerId = randomUUID(), certificate = { id: peerId }, grantId = randomUUID(), resource = randomUUID(), relayUrl = 'wss://relay.example/v1/socket', full = true } = {}) {
  const id = randomUUID(), accessToken = randomUUID(), coreGrantId = randomUUID(), permissions = full ? [...sessionPermissions] : ['observe'];
  const row = { id: grantId, resource, sessionId: id, hostId, peerId, peerDigest: digest(certificate), relayUrl,
    sessionAccess: full, agentAccess: full, shareAccess: full, permissions, token: accessToken, coreGrantId, expiresAt: Date.now() + 3600000 };
  putRecord('session', id, { id, cwd: directory, provider: 'codex', alias: 'Fixture' });
  putRecord('access-token', digest(accessToken), { id: coreGrantId, sessionId: id, expiresAt: row.expiresAt, includeChildren: false, permissions });
  putRecord('core.relay.pin', peerId, { hostId, certificate }); putRecord('core.relay.grant', row.id, row);
  registerDeviceNotifications(row, { enabled: true, deviceToken: token, environment: 'sandbox', scope: full ? 'authorized' : 'session', relayPush: true, hostHints: true });
  return { row, registration: listRecords('core.push.registration').find(item => item.relayGrantId === row.id) };
}

test('custom notifications validate approval/text, deduplicate stable IDs and never create model work', () => {
  assert.throws(() => queueCustomNotification({ message: 'hey' }, 'first'), { code: 'PUSH_REGISTRATION_REQUIRED' });
  const narrow = localRegistration({ full: false });
  assert.throws(() => queueCustomNotification({ message: 'hey' }, 'first'), { code: 'PUSH_REGISTRATION_REQUIRED' });
  putRecord('core.relay.grant', narrow.row.id, { ...narrow.row, revokedAt: new Date().toISOString() });
  localRegistration();
  for (const input of [{ message: '' }, { message: '🙂'.repeat(181) }, { message: 'password=private-fixture' }, { message: 'hey', sessionId: 'foreign' }, { message: 1 }])
    assert.throws(() => queueCustomNotification(input, randomUUID()), { code: 'INVALID_NOTIFICATION' });
  const saved = queueCustomNotification({ message: 'hey' }, 'first');
  assert.deepEqual(queueCustomNotification({ message: 'hey' }, 'first'), saved);
  assert.throws(() => queueCustomNotification({ message: 'different' }, 'first'), { code: 'CONFLICT' });
  assert.equal(saved.recipientCount, 1); assert.equal(saved.state, 'queued');
  const event = getRecord('outbox', saved.id).event;
  assert.equal(currentCustomNotification(event).message, 'hey');
  assert.equal(currentCustomNotification({ ...event, message: 'forged' }), null);
  assert.equal(listRecords('outbox').length, 1);
  assert.equal(listRecords('execution').length, 0); assert.equal(listRecords('run').length, 0);
  assert.equal(JSON.stringify(saved).includes('hey'), false);
});

test('custom creation rate is bounded and retries do not spend a new slot', () => {
  localRegistration();
  for (let i = 0; i < 60; i++) queueCustomNotification({ message: 'hey' }, `rate-${i}`);
  assert.equal(queueCustomNotification({ message: 'hey' }, 'rate-0').state, 'queued');
  assert.throws(() => queueCustomNotification({ message: 'hey' }, 'rate-60'), { code: 'NOTIFICATION_RATE_LIMIT' });
});

test('owner HTTP/SDK queues one notification; scoped observers cannot send', async () => {
  const { row } = localRegistration(), info = await ensureRuntime();
  const client = new BzzyClient({ url: info.url, token: info.token });
  const saved = await client.sendNotification({ message: 'hey', requestId: 'owner-once' });
  assert.deepEqual(await client.sendNotification({ message: 'hey', requestId: 'owner-once' }), saved);
  const grant = await client.observerToken(row.sessionId);
  const observer = new BzzyClient({ url: info.url, token: grant.token });
  await assert.rejects(observer.sendNotification({ message: 'blocked', requestId: 'observer' }), { status: 403 });
  assert.equal(listRecords('core.notification.custom').length, 1);
  assert.equal(listRecords('execution').length, 0);
});

test('real Core custom payload crosses Relay and sends once to the offline phone', async t => {
  const sends = [], f = await fixture(t, { server: { push: { configurationLoader: () => ({ environment: 'sandbox', fingerprint: 'fixture' }),
    clientFactory: () => ({ send: async value => sends.push(value), close() {} }) } } });
  const host = await f.client({ host: true }), phone = await f.client(), { grant } = await pair(host, phone);
  await phone.request('push.register', { enabled: true, deviceToken: token, environment: 'sandbox', grantIds: [grant.id] });
  localRegistration({ hostId: grant.hostId, peerId: grant.recipientId, certificate: phone.identity.certificate, grantId: grant.id, resource: grant.spec.resource, relayUrl: host.url });
  await phone.close(); queueCustomNotification({ message: 'hey' }, 'relay-once');
  const worker = new CorePushWorker({ configurationLoader: () => null, hostID: () => grant.hostId,
    relaySend: (_binding, input) => host.request('push.enqueue', { grantId: grant.id, notificationId: input.id,
      occurredAt: input.occurredAt, environment: 'sandbox', payload: input.payload }) });
  t.after(() => worker.close());
  await worker.tick();
  for (const delivery of listRecords('core.push.delivery')) putRecord('core.push.delivery', delivery.id, { ...delivery, nextAttemptAt: 0 });
  await worker.tick();
  for (let i = 0; i < 50 && !sends.length; i++) await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(sends.length, 1); assert.deepEqual(sends[0].payload.aps.alert, { title: 'BZZY notification', body: 'hey' });
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM push_queue').get().n, 1);
  assert.deepEqual(Object.keys(sends[0].payload.bzzy).sort(), ['destination','eventId','hostId','v']);
  assert.equal(sends[0].payload.bzzy.destination, 'terminal');
});

test('revocation prevents custom delivery and newly registered phones cannot receive old alerts', async () => {
  const first = localRegistration(), saved = queueCustomNotification({ message: 'hey' }, 'before-revoke');
  putRecord('core.relay.grant', first.row.id, { ...first.row, revokedAt: new Date().toISOString() });
  const second = localRegistration({ hostId: first.row.hostId }); let sends = 0;
  const worker = new CorePushWorker({ configurationLoader: () => null, hostID: () => first.row.hostId, relaySend: async () => { sends++; return { state: 'sent' }; } });
  try { await worker.tick(); } finally { worker.close(); }
  assert.equal(sends, 0); assert.ok(!currentCustomNotification(getRecord('outbox', saved.id).event).recipientIds.includes(second.registration.id));
});
