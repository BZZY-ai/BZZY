import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { RelayStore } from '../src/store.js';
import { RelayPushService } from '../src/push.js';
import { fixture, pair } from './helpers.js';

const token = 'ab'.repeat(32), configuration = { environment: 'sandbox', fingerprint: 'fixture' };
const payload = (host, resource) => ({ aps: { alert: { title: 'Goal achieved - starbucks-japan', body: 'Verified result.' }, sound: 'default', category: 'BZZY_UPDATE', 'thread-id': 'thread' },
  bzzy: { v: 1, eventId: 'event', hostId: host, resource, sessionId: randomUUID(), destination: 'terminal' } });

test('real sockets queue to the bound phone while offline, deduplicate lost receipts and never expose tokens in replies/audit', async t => {
  let configured = false; const sends = [];
  const f = await fixture(t, { server: { push: { configurationLoader: () => configured ? configuration : null,
    clientFactory: () => ({ send: async value => { sends.push(value); }, close() {} }) } } });
  const host = await f.client({ host: true }), phone = await f.client(), outsider = await f.client({ host: true });
  const { grant } = await pair(host, phone);
  const result = await phone.request('push.register', { enabled: true, deviceToken: token, environment: 'sandbox', grantIds: [grant.id] });
  assert.deepEqual(result, { registered: true, providerConfigured: false });
  await phone.close();
  const fields = { grantId: grant.id, notificationId: 'goal-event', occurredAt: Date.now(), environment: 'sandbox', payload: payload(host.identity.certificate.id, grant.spec.resource) };
  assert.equal((await host.request('push.enqueue', fields)).state, 'queued');
  assert.equal((await host.request('push.enqueue', fields)).state, 'queued');
  await assert.rejects(outsider.request('push.enqueue', fields), { code: 'GRANT_UNAVAILABLE' });
  await assert.rejects(host.request('push.enqueue', { ...fields, payload: { ...fields.payload, command: 'run' } }), { code: 'INVALID_MESSAGE' });
  configured = true;
  for (let i = 0; i < 40 && !sends.length; i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(sends.length, 1); assert.equal(sends[0].token, token);
  assert.equal((await host.request('push.enqueue', fields)).state, 'sent');
  assert.equal(JSON.stringify(f.audit).includes(token), false);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM push_queue').get().n, 1);
  assert.equal(f.store.db.prepare('SELECT data FROM push_queue').get().data.includes('Verified result.'), false, 'delivered previews are removed');
});

test('queue survives database restart; dispatch rechecks grant revocation and device preferences', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-push-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const f = await fixture(t), host = await f.client({ host: true }), phone = await f.client();
  const { grant } = await pair(host, phone);
  const sends = [];
  const open = () => {
    const store = new RelayStore({ directory });
    store.putDevice(f.store.device(grant.hostId)); store.putDevice(f.store.device(grant.recipientId));
    store.db.prepare('INSERT OR IGNORE INTO grants VALUES (?,?)').run(grant.id, JSON.stringify(grant));
    const worker = new RelayPushService({ store, configurationLoader: () => configuration,
      clientFactory: () => ({ send: async value => sends.push(value), close() {} }) });
    return { store, worker };
  };
  let { store, worker } = open();
  worker.register(grant.recipientId, { enabled: true, deviceToken: token, environment: 'sandbox', grantIds: [grant.id] });
  const params = { grantId: grant.id, id: 'first', occurredAt: Date.now(), environment: 'sandbox', payload: payload(grant.hostId, grant.spec.resource) };
  worker.enqueue(grant.hostId, params); await worker.close(); store.close();
  ({ store, worker } = open());
  await worker.tick(); assert.equal(sends.length, 1);
  assert.equal(worker.enqueue(grant.hostId, params).state, 'sent');
  worker.enqueue(grant.hostId, { ...params, id: 'disabled' });
  worker.register(grant.recipientId, { enabled: false });
  await worker.tick(); assert.equal(sends.length, 1);
  worker.register(grant.recipientId, { enabled: true, deviceToken: token, environment: 'sandbox', grantIds: [grant.id] });
  worker.enqueue(grant.hostId, { ...params, id: 'revoked', occurredAt: Date.now() });
  store.revokeGrant(grant.hostId, grant.id);
  await worker.tick(); assert.equal(sends.length, 1);
  await worker.close(); store.close();
});

test('rotation, stale events, foreign tokens, payload tampering and ambiguous APNs outcomes fail safely', async t => {
  const f = await fixture(t), host = await f.client({ host: true }), phone = await f.client(), other = await f.client();
  const { grant } = await pair(host, phone); const { grant: otherGrant } = await pair(host, other);
  let clock = Date.now(), calls = 0;
  const worker = new RelayPushService({ store: f.store, clock: () => clock, configurationLoader: () => configuration,
    clientFactory: () => ({ send: async () => { calls++; throw Object.assign(new Error(), { uncertain: true }); }, close() {} }) });
  t.after(() => worker.close());
  worker.register(grant.recipientId, { enabled: true, deviceToken: token, environment: 'sandbox', grantIds: [grant.id] });
  assert.throws(() => worker.register(other.identity.certificate.id, { enabled: true, deviceToken: token, environment: 'sandbox', grantIds: [otherGrant.id] }), { code: 'PUSH_UNAVAILABLE' });
  const params = { grantId: grant.id, id: 'first', occurredAt: clock, environment: 'sandbox', payload: payload(grant.hostId, grant.spec.resource) };
  assert.throws(() => worker.enqueue(grant.hostId, { ...params, occurredAt: clock - 1 }), { code: 'PUSH_REGISTRATION_REQUIRED' });
  assert.throws(() => worker.enqueue(grant.hostId, { ...params, payload: { ...params.payload, bzzy: { ...params.payload.bzzy, hostId: 'forged' } } }), { code: 'INVALID_PUSH' });
  worker.enqueue(grant.hostId, params);
  assert.throws(() => worker.enqueue(grant.hostId, { ...params, payload: { ...params.payload, aps: { ...params.payload.aps, alert: { title: 'Goal achieved', body: 'Changed' } } } }), { code: 'PUSH_CONFLICT' });
  await worker.tick(); await worker.tick(); assert.equal(calls, 1);
  assert.equal(worker.enqueue(grant.hostId, params).state, 'uncertain');
  worker.enqueue(grant.hostId, { ...params, id: 'rotate' });
  worker.register(grant.recipientId, { enabled: true, deviceToken: 'cd'.repeat(32), environment: 'sandbox', grantIds: [grant.id] });
  await worker.tick(); assert.equal(calls, 1, 'old event cannot move to a new token');
  clock += 86400_001; await worker.tick();
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM push_queue').get().n, 0);
});

test('explicit Apple rejection backs off with stable IDs; a crash during dispatch remains uncertain', async t => {
  const f = await fixture(t), host = await f.client({ host: true }), phone = await f.client();
  const { grant } = await pair(host, phone);
  let clock = Date.now(); const sends = [];
  const worker = new RelayPushService({ store: f.store, clock: () => clock, configurationLoader: () => configuration,
    clientFactory: () => ({ send: async value => { sends.push(value); if (sends.length === 1) throw Object.assign(new Error(), { code: 'APNS_REJECTED' }); }, close() {} }) });
  t.after(() => worker.close());
  worker.register(grant.recipientId, { enabled: true, deviceToken: token, environment: 'sandbox', grantIds: [grant.id] });
  const params = { grantId: grant.id, id: 'retry', occurredAt: clock, environment: 'sandbox', payload: payload(grant.hostId, grant.spec.resource) };
  worker.enqueue(grant.hostId, params); await worker.tick(); await worker.tick();
  assert.equal(sends.length, 1); clock += 2001; await worker.tick();
  assert.equal(sends.length, 2); assert.equal(sends[0].id, sends[1].id); assert.equal(sends[0].collapseID, sends[1].collapseID);
  worker.enqueue(grant.hostId, { ...params, id: 'crash' });
  const crashed = JSON.parse(f.store.db.prepare("SELECT data FROM push_queue WHERE json_extract(data,'$.state')='queued'").get().data);
  worker.put('push_queue', crashed.id, { ...crashed, state: 'dispatching' });
  await worker.tick(); assert.equal(sends.length, 2);
  assert.equal(worker.enqueue(grant.hostId, { ...params, id: 'crash' }).state, 'uncertain');
});

test('forgetting one computer removes its pending alerts without disabling another computer; reauthorization cannot replay old alerts', async t => {
  const f = await fixture(t), host = await f.client({ host: true }), second = await f.client({ host: true }), phone = await f.client();
  const { grant } = await pair(host, phone), { grant: secondGrant } = await pair(second, phone);
  let clock = Date.now(); const sends = [];
  const worker = new RelayPushService({ store: f.store, clock: () => clock, configurationLoader: () => configuration,
    clientFactory: () => ({ send: async value => sends.push(value), close() {} }) });
  t.after(() => worker.close());
  const registration = { enabled: true, deviceToken: token, environment: 'sandbox' };
  worker.register(grant.recipientId, { ...registration, grantIds: [grant.id, secondGrant.id] });
  const first = { grantId: grant.id, id: 'first', occurredAt: clock, environment: 'sandbox', payload: payload(grant.hostId, grant.spec.resource) };
  worker.enqueue(grant.hostId, first);
  worker.enqueue(secondGrant.hostId, { ...first, grantId: secondGrant.id, id: 'second', payload: payload(secondGrant.hostId, secondGrant.spec.resource) });
  clock++;
  worker.register(grant.recipientId, { ...registration, grantIds: [secondGrant.id] });
  await worker.tick(); assert.equal(sends.length, 1); assert.equal(sends[0].payload.bzzy.hostId, secondGrant.hostId);
  assert.equal(worker.enqueue(grant.hostId, first).state, 'failed');
  clock++;
  worker.register(grant.recipientId, { ...registration, grantIds: [grant.id, secondGrant.id] });
  assert.throws(() => worker.enqueue(grant.hostId, { ...first, id: 'stale' }), { code: 'PUSH_REGISTRATION_REQUIRED' });
  worker.enqueue(grant.hostId, { ...first, id: 'new', occurredAt: clock }); await worker.tick();
  assert.equal(sends.length, 2);
});
