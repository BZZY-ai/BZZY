import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { RelayClient } from '../src/client.js';
import { RelayStore } from '../src/store.js';
import { createIdentity, loadIdentity, ReplayGuard, saveIdentity, seal, verifyCertificate } from '../src/identity.js';
import { LIMITS, RateLimiter, random, relayUrl } from '../src/protocol.js';
import { decodeInvitation } from '../src/invitation.js';
import { fixture, next, pair } from './helpers.js';

test('invitation consumption and revocation survive an actual database restart', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-relay-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const host = createIdentity(), client = createIdentity();
  let store = new RelayStore({ directory }); store.provisionHost(host.certificate);
  const invitation = store.createInvitation(host.certificate.id, { kind: 'TERMINAL', resource: 'workspace' });
  const claim = store.claim(invitation.code, client.certificate, () => true);
  const { grant } = store.decide(host.certificate.id, claim.claimId, true, client.certificate);
  store.close(); store = new RelayStore({ directory });
  assert.throws(() => store.claim(invitation.code, client.certificate, () => true), { code: 'INVITE_UNAVAILABLE' });
  assert.equal(store.activeGrant(grant.id, client.certificate.id).id, grant.id);
  store.revokeGrant(host.certificate.id, grant.id); store.close(); store = new RelayStore({ directory });
  assert.throws(() => store.activeGrant(grant.id, client.certificate.id), { code: 'GRANT_UNAVAILABLE' });
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(directory, 'relay.sqlite')).mode & 0o777, 0o600);
  store.close();
});

test('private identity files cannot be overwritten, read through links or loaded with unsafe permissions', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-identity-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'device.identity.json'), identity = createIdentity();
  saveIdentity(file, identity); assert.deepEqual(loadIdentity(file), identity);
  assert.throws(() => saveIdentity(file, createIdentity()), { code: 'EEXIST' });
  const link = path.join(directory, 'link'); fs.symlinkSync(file, link);
  assert.throws(() => loadIdentity(link), { code: 'PRIVATE_FILE_REQUIRED' });
  fs.chmodSync(file, 0o644); assert.throws(() => loadIdentity(file), { code: 'PRIVATE_FILE_REQUIRED' });
  fs.chmodSync(file, 0o600);
  const changed = { ...identity.certificate, boxKey: createIdentity().certificate.boxKey };
  assert.throws(() => verifyCertificate(changed), { code: 'INVALID_IDENTITY' });
  const dbLink = path.join(directory, 'relay.sqlite'); fs.symlinkSync(file, dbLink);
  assert.throws(() => new RelayStore({ directory }));
  assert.deepEqual(loadIdentity(file), identity);
});

test('TLS, protocol-purpose validation and bounded replay/rate state fail closed', () => {
  assert.throws(() => relayUrl('ws://public.example/v1/socket', true), { code: 'TLS_REQUIRED' });
  assert.throws(() => relayUrl('wss://public.example/v1/socket?code=private'), { code: 'INVALID_RELAY_URL' });
  assert.throws(() => decodeInvitation('https://example.invalid/share/anything'), { code: 'INVALID_INVITATION' });
  let now = 100;
  const replay = new ReplayGuard({ maxEntries: 1, now: () => now });
  replay.accept('first', 200);
  assert.throws(() => replay.accept('first', 200), { code: 'REPLAY' });
  assert.throws(() => replay.accept('second', 200), { code: 'REPLAY_CAPACITY' });
  now = 201; replay.accept('second', 300);
  const rate = new RateLimiter({ maxKeys: 1, limit: 1, windowMs: 10, now: () => now });
  assert.equal(rate.take('a'), true); assert.equal(rate.take('a'), false); assert.equal(rate.take('b'), false);
  now += 11; assert.equal(rate.take('b'), true); assert.equal(rate.buckets.size, 1);
});

test('durable metadata quotas bound invitations, grants and device registration', t => {
  const store = new RelayStore({ limits: { ...LIMITS, devices: 2, invitations: 2, grants: 1 } });
  t.after(() => store.close());
  const host = createIdentity(), a = createIdentity(), b = createIdentity(); store.provisionHost(host.certificate);
  const first = store.createInvitation(host.certificate.id, { kind: 'PAIR', resource: 'x' });
  const second = store.createInvitation(host.certificate.id, { kind: 'PAIR', resource: 'y' });
  assert.throws(() => store.createInvitation(host.certificate.id, { kind: 'PAIR', resource: 'z' }), { code: 'INVITE_CAPACITY' });
  const claim = store.claim(first.code, a.certificate, () => true);
  store.decide(host.certificate.id, claim.claimId, true, a.certificate);
  const otherClaim = store.claim(second.code, b.certificate, () => true);
  assert.throws(() => store.decide(host.certificate.id, otherClaim.claimId, true, b.certificate), { code: 'DEVICE_CAPACITY' });
  assert.equal(store.device(b.certificate.id), null);
});

test('automatic reconnect restores only connectivity and never repeats an application command', async t => {
  const f = await fixture(t), host = await f.client({ host: true }), recipient = await f.client({ autoReconnect: true });
  const { grant } = await pair(host, recipient);
  let commands = 0; recipient.on('message', () => commands++);
  const received = next(recipient, 'message');
  await host.send(grant.id, { operation: 'execute', requestId: 'stable_core_id' }); await received;
  const epoch = recipient.epoch;
  const restored = new Promise(resolve => recipient.on('status', status => { if (status === 'online') resolve(); }));
  recipient.ws.terminate();
  await restored;
  assert.notEqual(recipient.epoch, epoch);
  assert.equal(commands, 1);
  assert.equal(recipient.pending.size, 0);
  assert.equal(f.relay.metrics().pendingDeliveries, 0);
});

test('operator device revocation closes active sockets and rejects later authentication', async t => {
  const f = await fixture(t), host = await f.client({ host: true }), recipient = await f.client();
  const { grant } = await pair(host, recipient);
  f.store.revokeDevice(recipient.identity.certificate.id);
  await assert.rejects(host.send(grant.id, {}), { code: 'GRANT_UNAVAILABLE' });
  await recipient.close();
  await assert.rejects(recipient.connect(), { code: 'DEVICE_REVOKED' });
  assert.equal(recipient.stopped, true);
});

test('request rates and handshake origin/version requirements are enforced over real sockets', async t => {
  const f = await fixture(t, { server: { limits: { requestsPerMinute: 1 } } });
  const client = await f.client(); await client.grants();
  await assert.rejects(client.grants(), { code: 'RATE_LIMITED' });
  const ws = new WebSocket(f.relay.audience, 'bzzy-relay.v1', { origin: 'https://foreign.invalid' });
  const error = await new Promise(resolve => ws.on('error', resolve));
  assert.match(error.message, /403/);
  const wrongVersion = new WebSocket(f.relay.audience, 'bzzy-relay.v2');
  assert.match((await new Promise(resolve => wrongVersion.on('error', resolve))).message, /403/);
});

test('portable terminal transfer budget is participant scoped and never raises invitation or guessed-grant limits', async t => {
  const f = await fixture(t, { server: { limits: { requestsPerMinute: 8, transferRequestsPerMinute: 32 } } });
  const host = await f.client({ host: true }), recipient = await f.client(), stranger = await f.client();
  const { grant } = await pair(host, recipient, { kind: 'TERMINAL', resource: 'transfer', grantTtlSeconds: 3600 });
  for (let index = 0; index < 20; index++) assert.equal((await recipient.request('grant.inspect', { grantId: grant.id })).id, grant.id);
  for (let index = 0; index < 8; index++) await assert.rejects(stranger.request('grant.inspect', { grantId: grant.id }), { code: 'GRANT_UNAVAILABLE' });
  await assert.rejects(stranger.grants(), { code: 'RATE_LIMITED' });
  for (let index = 0; index < 7; index++) await recipient.grants();
  await assert.rejects(recipient.grants(), { code: 'RATE_LIMITED' });
  for (let index = 0; index < 12; index++) await recipient.request('grant.inspect', { grantId: grant.id });
  await assert.rejects(recipient.request('grant.inspect', { grantId: grant.id }), { code: 'RATE_LIMITED' });
  await host.revokeGrant(grant.id);
  await assert.rejects(recipient.request('grant.inspect', { grantId: grant.id }), { code: 'RATE_LIMITED' });
});

test('approved live PAIR data has a separate bounded participant budget without widening administration or revoked grants', async t => {
  const f = await fixture(t, { server: { limits: { requestsPerMinute: 8, transferRequestsPerMinute: 32 } } });
  const host = await f.client({ host: true }), recipient = await f.client(), stranger = await f.client();
  const { grant } = await pair(host, recipient, { kind: 'PAIR', resource: 'live-core', actions: ['observe'] });
  for (let index = 0; index < 12; index++) {
    const received = next(host, 'message');
    await recipient.send(grant.id, { encryptedApplicationRead: index }); await received;
  }
  for (let index = 0; index < 8; index++) await assert.rejects(stranger.request('grant.inspect', { grantId: grant.id }), { code: 'GRANT_UNAVAILABLE' });
  await assert.rejects(stranger.grants(), { code: 'RATE_LIMITED' });
  for (let index = 0; index < 7; index++) await recipient.grants();
  await assert.rejects(recipient.grants(), { code: 'RATE_LIMITED' });
  await host.revokeGrant(grant.id);
  await assert.rejects(recipient.request('grant.inspect', { grantId: grant.id }), { code: 'RATE_LIMITED' });
});

test('portable AGENT grants have the same bounded participant data budget and one-hour ceiling as TERMINAL', async t => {
  const f = await fixture(t, { server: { limits: { requestsPerMinute: 8, transferRequestsPerMinute: 32 } } });
  const host = await f.client({ host: true }), recipient = await f.client();
  await assert.rejects(host.createInvitation({ kind: 'AGENT', resource: 'too-long', grantTtlSeconds: 3601 }), { code: 'INVALID_LIMIT' });
  const { grant } = await pair(host, recipient, { kind: 'AGENT', resource: 'agent-copy', grantTtlSeconds: 3600 });
  assert.equal(grant.spec.kind, 'AGENT'); assert.deepEqual(grant.spec.actions, ['import']);
  for (let index = 0; index < 32; index++) await recipient.request('grant.inspect', { grantId: grant.id });
  await assert.rejects(recipient.request('grant.inspect', { grantId: grant.id }), { code: 'RATE_LIMITED' });
  for (let index = 0; index < 7; index++) await recipient.grants();
  await assert.rejects(recipient.grants(), { code: 'RATE_LIMITED' });
  await host.revokeGrant(grant.id);
  await assert.rejects(recipient.request('grant.inspect', { grantId: grant.id }), { code: 'RATE_LIMITED' });
});

test('oversized raw frames are closed by WebSocket limits before parsing', async t => {
  const f = await fixture(t);
  const ws = new WebSocket(f.relay.audience, 'bzzy-relay.v1');
  await next(ws, 'message');
  const closed = next(ws, 'close');
  ws.send('x'.repeat(LIMITS.frameBytes + 1));
  assert.equal(await closed, 1009);
});

test('connection recovery waits for a stale socket without taking it over or resending work', async t => {
  const f = await fixture(t), original = await f.client();
  const replacement = new RelayClient({ url: f.relay.audience, identity: original.identity, allowInsecureLocal: true, autoReconnect: true });
  f.clients.push(replacement);
  await assert.rejects(replacement.connect(), { code: 'DEVICE_CONNECTED' });
  const restored = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Reconnect deadline exceeded')), 4000);
    replacement.on('status', status => { if (status === 'online') { clearTimeout(timer); resolve(); } });
  });
  await original.close(); await restored;
  assert.equal(replacement.status, 'online');
  assert.equal(replacement.pending.size, 0);
});

test('bounded clock skew works, while expired and excessively future ciphertext is rejected', async t => {
  const f = await fixture(t), host = await f.client({ host: true }), recipient = await f.client();
  const { grant } = await pair(host, recipient);
  const send = async expiresAt => {
    const messageId = random();
    const box = seal(host.identity, recipient.identity.certificate, { v: 1, from: host.identity.certificate.id,
      to: recipient.identity.certificate.id, grantId: grant.id, messageId, receiverEpoch: recipient.epoch, expiresAt, payload: { fixture: true } });
    return host.request('route.send', { grantId: grant.id, messageId, box });
  };
  const message = next(recipient, 'message'); await send(Date.now() + 62000); await message;
  for (const expiry of [Date.now() - 10000, Date.now() + 90000]) {
    const rejected = next(recipient, 'rejected'); await send(expiry);
    assert.equal((await rejected).code, 'MESSAGE_EXPIRED');
  }
});

test('unacknowledged deliveries time out as uncertain and are never retransmitted', async t => {
  const f = await fixture(t, { server: { limits: { deliveryTimeoutMs: 50 } } });
  const host = await f.client({ host: true }), recipient = await f.client();
  const { grant } = await pair(host, recipient);
  recipient.forgetPeer(host.identity.certificate.id);
  const uncertain = next(host, 'delivery.uncertain');
  const result = await host.send(grant.id, { requestId: 'uncertain_example' });
  assert.equal((await uncertain).messageId, result.messageId);
  assert.equal(f.relay.metrics().pendingDeliveries, 0);
});
