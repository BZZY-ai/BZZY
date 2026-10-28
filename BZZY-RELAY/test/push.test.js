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

test('temporary outages retry beyond eight attempts across restart with stable IDs until recovery', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-outage-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const f = await fixture(t), host = await f.client({ host: true }), phone = await f.client();
  const { grant } = await pair(host, phone, { kind: 'PAIR', resource: 'outage-fixture', grantTtlSeconds: 86400 });
  let clock = Date.now(); const sends = [];
  const open = () => {
    const store = new RelayStore({ directory });
    store.putDevice(f.store.device(grant.hostId)); store.putDevice(f.store.device(grant.recipientId));
    store.db.prepare('INSERT OR IGNORE INTO grants VALUES (?,?)').run(grant.id, JSON.stringify(grant));
    const worker = new RelayPushService({ store, clock: () => clock, configurationLoader: () => configuration,
      clientFactory: () => ({ send: async value => {
        sends.push(value);
        if (sends.length <= 10) throw Object.assign(new Error('fixture pre-dispatch outage'), { code: 'APNS_UNAVAILABLE', uncertain: false });
      }, close() {} }) });
    return { store, worker };
  };
  let { store, worker } = open();
  worker.register(grant.recipientId, { enabled: true, deviceToken: token, environment: 'sandbox', grantIds: [grant.id] });
  const params = { grantId: grant.id, id: 'outage', occurredAt: clock, environment: 'sandbox', payload: payload(grant.hostId, grant.spec.resource) };
  worker.enqueue(grant.hostId, params);
  for (let attempt = 1; attempt <= 10; attempt++) {
    await worker.tick();
    const row = JSON.parse(store.db.prepare('SELECT data FROM push_queue').get().data);
    assert.equal(row.state, 'retry'); assert.equal(row.attempts, attempt);
    assert.ok(row.nextAttemptAt > clock && row.nextAttemptAt <= clock + 300_000);
    await worker.tick(); assert.equal(sends.length, attempt, 'Backoff prevents repeated dispatch in the same interval');
    if (attempt === 5) {
      await worker.close(); store.close();
      ({ store, worker } = open());
      await worker.tick(); assert.equal(sends.length, attempt, 'Restart preserves the durable backoff');
    }
    clock = row.nextAttemptAt;
  }
  await worker.tick();
  assert.equal(sends.length, 11);
  assert.equal(worker.enqueue(grant.hostId, params).state, 'sent');
  assert.equal(new Set(sends.map(value => value.id)).size, 1);
  assert.equal(new Set(sends.map(value => value.collapseID)).size, 1);
  assert.equal(store.db.prepare('SELECT data FROM push_queue').get().data.includes('Verified result.'), false);
  await worker.close(); store.close();
});

test('a temporary outage stops at the existing event expiry without dispatching stale alerts', async t => {
  const f = await fixture(t), host = await f.client({ host: true }), phone = await f.client();
  const { grant } = await pair(host, phone, { kind: 'PAIR', resource: 'expiry-fixture', grantTtlSeconds: 86400 });
  let clock = Date.now(), calls = 0;
  const worker = new RelayPushService({ store: f.store, clock: () => clock, configurationLoader: () => configuration,
    clientFactory: () => ({ send: async () => { calls++; throw Object.assign(new Error(), { code: 'APNS_UNAVAILABLE' }); }, close() {} }) });
  t.after(() => worker.close());
  worker.register(grant.recipientId, { enabled: true, deviceToken: token, environment: 'sandbox', grantIds: [grant.id] });
  worker.enqueue(grant.hostId, { grantId: grant.id, id: 'expires', occurredAt: clock, environment: 'sandbox', payload: payload(grant.hostId, grant.spec.resource) });
  await worker.tick();
  const row = JSON.parse(f.store.db.prepare('SELECT data FROM push_queue').get().data);
  assert.equal(row.state, 'retry');
  clock = row.expiresAt + 1;
  await worker.tick();
  assert.equal(calls, 1);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM push_queue').get().n, 0);
});

test('restart during connection setup safely retries but the public receipt remains queued', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-connecting-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const f = await fixture(t), host = await f.client({ host: true }), phone = await f.client();
  const { grant } = await pair(host, phone);
  let calls = 0;
  const open = () => {
    const store = new RelayStore({ directory });
    store.putDevice(f.store.device(grant.hostId)); store.putDevice(f.store.device(grant.recipientId));
    store.db.prepare('INSERT OR IGNORE INTO grants VALUES (?,?)').run(grant.id, JSON.stringify(grant));
    const worker = new RelayPushService({ store, configurationLoader: () => configuration,
      clientFactory: () => ({ send: async value => {
        assert.equal(JSON.parse(store.db.prepare('SELECT data FROM push_queue').get().data).state, 'connecting');
        value.beforeDispatch();
        assert.equal(JSON.parse(store.db.prepare('SELECT data FROM push_queue').get().data).state, 'dispatching');
        calls++;
      }, close() {} }) });
    return { store, worker };
  };
  let { store, worker } = open();
  worker.register(grant.recipientId, { enabled: true, deviceToken: token, environment: 'sandbox', grantIds: [grant.id] });
  const params = { grantId: grant.id, id: 'connecting-restart', occurredAt: Date.now(), environment: 'sandbox', payload: payload(grant.hostId, grant.spec.resource) };
  worker.enqueue(grant.hostId, params);
  const queued = JSON.parse(store.db.prepare('SELECT data FROM push_queue').get().data);
  worker.put('push_queue', queued.id, { ...queued, state: 'connecting', attempts: 1 });
  assert.equal(worker.enqueue(grant.hostId, params).state, 'queued', 'Internal connection progress cannot change the existing public protocol');
  await worker.close(); store.close();
  ({ store, worker } = open());
  await worker.tick();
  assert.equal(calls, 1); assert.equal(worker.enqueue(grant.hostId, params).state, 'sent');
  await worker.close(); store.close();
});

test('revocation and token changes during connection setup stop POST at the durable fence', async t => {
  for (const mutation of ['revoke', 'disable', 'rotate']) {
    const f = await fixture(t), host = await f.client({ host: true }), phone = await f.client();
    const { grant } = await pair(host, phone);
    let posts = 0;
    const worker = new RelayPushService({ store: f.store, configurationLoader: () => configuration,
      clientFactory: () => ({ send: async value => {
        await Promise.resolve();
        if (mutation === 'revoke') f.store.revokeGrant(grant.hostId, grant.id);
        else if (mutation === 'disable') worker.register(grant.recipientId, { enabled: false });
        else worker.register(grant.recipientId, { enabled: true, deviceToken: 'cd'.repeat(32), environment: 'sandbox', grantIds: [grant.id] });
        value.beforeDispatch(); posts++;
      }, close() {} }) });
    t.after(() => worker.close());
    worker.register(grant.recipientId, { enabled: true, deviceToken: token, environment: 'sandbox', grantIds: [grant.id] });
    const params = { grantId: grant.id, id: mutation, occurredAt: Date.now(), environment: 'sandbox', payload: payload(grant.hostId, grant.spec.resource) };
    worker.enqueue(grant.hostId, params); await worker.tick();
    const row = JSON.parse(f.store.db.prepare('SELECT data FROM push_queue').get().data);
    assert.equal(posts, 0); assert.equal(row.state, 'failed'); assert.equal(row.code, 'FORBIDDEN');
  }
});

for (const blockedBy of ['backoff', 'unconfigured environment']) {
  test(`a ready alert is not hidden behind256 older alerts blocked by ${blockedBy}`, async t => {
    const f = await fixture(t), oldHost = await f.client({ host: true }), readyHost = await f.client({ host: true });
    const oldPhone = await f.client(), readyPhone = await f.client();
    const { grant: oldGrant } = await pair(oldHost, oldPhone), { grant: readyGrant } = await pair(readyHost, readyPhone);
    let clock = Date.now(); const sends = [];
    const worker = new RelayPushService({ store: f.store, clock: () => clock, configurationLoader: () => configuration,
      clientFactory: () => ({ send: async value => { value.beforeDispatch(); sends.push(value); }, close() {} }) });
    t.after(() => worker.close());
    const oldEnvironment = blockedBy === 'backoff' ? 'sandbox' : 'production';
    worker.register(oldGrant.recipientId, { enabled: true, deviceToken: token, environment: oldEnvironment, grantIds: [oldGrant.id] });
    worker.register(readyGrant.recipientId, { enabled: true, deviceToken: 'cd'.repeat(32), environment: 'sandbox', grantIds: [readyGrant.id] });
    for (let index = 0; index < 256; index++) {
      worker.enqueue(oldGrant.hostId, { grantId: oldGrant.id, id: `older-${index}`, occurredAt: clock,
        environment: oldEnvironment, payload: payload(oldGrant.hostId, oldGrant.spec.resource) });
    }
    if (blockedBy === 'backoff') {
      for (const item of f.store.db.prepare('SELECT data FROM push_queue').all()) {
        const row = JSON.parse(item.data);
        worker.put('push_queue', row.id, { ...row, state: 'retry', nextAttemptAt: clock + 300_000 });
      }
    }
    clock++;
    const ready = { grantId: readyGrant.id, id: 'new-ready', occurredAt: clock,
      environment: 'sandbox', payload: payload(readyGrant.hostId, readyGrant.spec.resource) };
    worker.enqueue(readyGrant.hostId, ready);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM push_queue').get().n, 257);
    await worker.tick();
    assert.equal(sends.length, 1, 'One ready alert must dispatch in the first bounded pass');
    assert.equal(sends[0].payload.bzzy.hostId, readyGrant.hostId);
    assert.equal(worker.enqueue(readyGrant.hostId, ready).state, 'sent');
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM push_queue WHERE json_extract(data,'$.hostId')=? AND json_extract(data,'$.attempts')=0").get(oldGrant.hostId).n, 256,
      'Backoff and missing-environment entries must not create native connection attempts');
  });
}
