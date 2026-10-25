import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createIdentity, authText, presenceText, sign, seal } from '../src/identity.js';
import { random, RelayError } from '../src/protocol.js';
import { encodeInvitation, decodeInvitation } from '../src/invitation.js';
import { fixture, next, pair } from './helpers.js';

test('concurrent route inspections share one fresh request without caching peer presence', async t => {
  const f = await fixture(t), host = await f.client({ host: true }), recipient = await f.client();
  const { grant } = await pair(host, recipient);
  const request = host.request.bind(host); let inspections = 0;
  host.request = async (op, fields) => {
    if (op === 'grant.inspect') { inspections++; await new Promise(resolve => setTimeout(resolve, 15)); }
    return request(op, fields);
  };
  const routes = await Promise.all(Array.from({ length: 8 }, () => host.route(grant.id)));
  assert.equal(inspections, 1); assert.ok(routes.every(route => route.grant.id === grant.id));
  await host.route(grant.id); assert.equal(inspections, 2);
});

test('transient receipt failure disconnects without dispatching an unacknowledged message', async t => {
  const f = await fixture(t), host = await f.client({ host: true }), recipient = await f.client();
  const { grant } = await pair(host, recipient);
  const request = recipient.request.bind(recipient); let messages = 0;
  recipient.on('message', () => { messages++; });
  recipient.request = (op, fields) => op === 'delivery.ack' ? Promise.reject(new RelayError('BACKPRESSURE')) : request(op, fields);
  const rejected = next(recipient, 'rejected'), offline = next(recipient, 'status');
  await host.send(grant.id, { mustReplay: true });
  assert.equal((await rejected).code, 'BACKPRESSURE'); assert.equal(await offline, 'offline');
  assert.equal(messages, 0);
});

test('pairing uses sender approval; only encrypted application content reaches Relay', async t => {
  const f = await fixture(t), host = await f.client({ host: true }), recipient = await f.client();
  const invitation = await host.createInvitation({ kind: 'PAIR', resource: 'opaque_session' });
  const qr = encodeInvitation({ relay: f.relay.audience, code: invitation.code, sender: host.identity.certificate, expiresAt: invitation.expiresAt }, { allowInsecureLocal: true });
  assert.ok(qr.startsWith('BZZY:INVITE:1:')); assert.ok(!qr.startsWith('https://'));
  assert.equal(decodeInvitation(qr, { allowInsecureLocal: true }).sender.id, host.identity.certificate.id);
  const requested = next(host, 'invite.requested');
  const claim = await recipient.claim(invitation.code); const preview = await requested;
  assert.equal(preview.recipient.id, recipient.identity.certificate.id);
  assert.deepEqual((await recipient.grants()).grants, []);
  await assert.rejects(recipient.request('grant.inspect', { grantId: invitation.invitationId }), { code: 'GRANT_UNAVAILABLE' });
  await assert.rejects(host.approve(claim.claimId, createIdentity().certificate), { code: 'RECIPIENT_MISMATCH' });
  const approved = await host.approve(claim.claimId, recipient.identity.certificate);
  recipient.trustPeer(host.identity.certificate);
  const secretText = 'private application text ' + random();
  const rpcFrames = [];
  const original = host.ws.send.bind(host.ws);
  host.ws.send = (frame, ...args) => { rpcFrames.push(String(frame)); return original(frame, ...args); };
  const message = next(recipient, 'message'), receipt = next(host, 'delivery.received');
  assert.equal((await host.send(approved.grant.id, { text: secretText, event: { id: 'session:123', seq: 123, provenance: 'observed' } })).status, 'forwarded');
  const delivered = await message; await receipt;
  assert.equal(delivered.payload.text, secretText);
  assert.deepEqual(delivered.payload.event, { id: 'session:123', seq: 123, provenance: 'observed' });
  assert.ok(!rpcFrames.join('').includes(secretText));
  assert.ok(!JSON.stringify(f.audit).includes(invitation.code));
  assert.ok(!JSON.stringify(f.store.db.prepare('SELECT * FROM invitations').all()).includes(invitation.code));
  assert.ok(!JSON.stringify(f.store.db.prepare('SELECT * FROM grants').all()).includes(secretText));
});

test('atomic single use, explicit denial, expiration, invitation revocation and host offline', async t => {
  let offset = 0;
  const f = await fixture(t, { store: { now: () => Date.now() + offset } });
  const host = await f.client({ host: true }), a = await f.client(), b = await f.client();
  const inv = await host.createInvitation({ kind: 'AGENT', resource: 'agent' });
  const results = await Promise.allSettled([a.claim(inv.code), b.claim(inv.code)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'INVITE_UNAVAILABLE');
  const winner = results[0].status === 'fulfilled' ? a : b, claim = results.find(r => r.status === 'fulfilled').value;
  await host.deny(claim.claimId);
  assert.equal((await winner.claimStatus(claim.claimId)).state, 'denied');
  await assert.rejects(winner.claim(inv.code), { code: 'INVITE_UNAVAILABLE' });
  const expiring = await host.createInvitation({ kind: 'TERMINAL', resource: 'terminal', ttlSeconds: 1 });
  offset = 2000;
  await assert.rejects(a.claim(expiring.code), { code: 'INVITE_EXPIRED' });
  offset = 0;
  const revoked = await host.createInvitation({ kind: 'PAIR', resource: 'gateway' });
  await host.revokeInvitation(revoked.invitationId);
  await assert.rejects(a.claim(revoked.code), { code: 'INVITE_UNAVAILABLE' });
  const offline = await host.createInvitation({ kind: 'PAIR', resource: 'gateway' });
  await host.close();
  await assert.rejects(a.claim(offline.code), { code: 'HOST_OFFLINE' });
});

test('portable agent, terminal and Library grants never create host/admin rights; tenants stay isolated', async t => {
  const f = await fixture(t), host = await f.client({ host: true }), otherHost = await f.client({ host: true });
  const recipient = await f.client(), stranger = await f.client();
  for (const kind of ['AGENT', 'TERMINAL', 'LIBRARY']) {
    const { grant } = await pair(host, recipient, { kind, resource: 'opaque_resource' });
    assert.equal(grant.spec.mode, 'portable'); assert.deepEqual(grant.spec.actions, ['import']);
    await assert.rejects(recipient.createInvitation({ kind: 'PAIR', resource: 'x' }), { code: 'HOST_REQUIRED' });
    await assert.rejects(otherHost.revokeGrant(grant.id), { code: 'GRANT_UNAVAILABLE' });
    await assert.rejects(stranger.request('grant.inspect', { grantId: grant.id }), { code: 'GRANT_UNAVAILABLE' });
    await assert.rejects(recipient.revokeGrant(grant.id), { code: 'HOST_REQUIRED' });
  }
  await assert.rejects(host.createInvitation({ kind: 'AGENT', mode: 'portable', resource: 'x', actions: ['execute'] }), { code: 'INVALID_ACTIONS' });
  await assert.rejects(host.createInvitation({ kind: 'AGENT', mode: 'pair', resource: 'x' }), { code: 'INVALID_PURPOSE' });
  await assert.rejects(host.createInvitation({ kind: 'TERMINAL', mode: 'live', resource: 'x', actions: ['observe', 'execute'] }), { code: 'INVALID_ACTIONS' });
  await assert.rejects(host.createInvitation({ kind: 'LIBRARY', mode: 'live', resource: 'x', actions: ['observe'] }), { code: 'INVALID_PURPOSE' });
  await assert.rejects(host.createInvitation({ kind: 'LIBRARY', mode: 'pair', resource: 'x' }), { code: 'INVALID_PURPOSE' });
  await assert.rejects(host.createInvitation({ kind: 'LIBRARY', resource: 'x', actions: ['import', 'execute'] }), { code: 'INVALID_ACTIONS' });
});

test('grant/peer revocation blocks later traffic and reconnect does not restore access', async t => {
  const f = await fixture(t), host = await f.client({ host: true }), recipient = await f.client();
  const { grant } = await pair(host, recipient);
  const notice = next(recipient, 'grant.revoked'); await host.revokePeer(recipient.identity.certificate.id); await notice;
  await assert.rejects(recipient.send(grant.id, { action: 'execute' }), { code: 'GRANT_UNAVAILABLE' });
  await recipient.close(); await recipient.connect();
  await assert.rejects(recipient.send(grant.id, { action: 'execute' }), { code: 'GRANT_UNAVAILABLE' });
  assert.deepEqual((await recipient.grants()).grants, []);
});

test('decrypt, metadata binding and replay checks reject tampering and old connection epochs', async t => {
  const f = await fixture(t), host = await f.client({ host: true }), recipient = await f.client();
  const { grant } = await pair(host, recipient);
  const messageId = random(), envelope = { v: 1, from: host.identity.certificate.id, to: recipient.identity.certificate.id,
    grantId: grant.id, messageId, receiverEpoch: recipient.epoch, expiresAt: Date.now() + 30000, payload: { type: 'command', requestId: 'stable-id' } };
  const box = seal(host.identity, recipient.identity.certificate, envelope);
  const message = next(recipient, 'message');
  await host.request('route.send', { grantId: grant.id, messageId, box }); await message;
  const replayed = next(recipient, 'rejected');
  await host.request('route.send', { grantId: grant.id, messageId, box });
  assert.equal((await replayed).code, 'REPLAY');
  const mismatch = next(recipient, 'rejected');
  await host.request('route.send', { grantId: grant.id, messageId: random(), box });
  assert.equal((await mismatch).code, 'ROUTING_MISMATCH');
  const corrupt = next(recipient, 'rejected');
  const bytes = Buffer.from(box.ciphertext, 'base64url'); bytes[0] ^= 1;
  await host.request('route.send', { grantId: grant.id, messageId: random(), box: { ...box, ciphertext: bytes.toString('base64url') } });
  assert.equal((await corrupt).code, 'DECRYPTION_FAILED');
  await recipient.close(); await recipient.connect();
  const oldEpoch = next(recipient, 'rejected');
  await host.request('route.send', { grantId: grant.id, messageId, box });
  assert.equal((await oldEpoch).code, 'ROUTING_MISMATCH');
});

test('recipient must pin sender identity; Relay-supplied certificates never establish trust', async t => {
  const f = await fixture(t), host = await f.client({ host: true }), recipient = await f.client();
  const { grant } = await pair(host, recipient);
  recipient.forgetPeer(host.identity.certificate.id);
  const rejected = next(recipient, 'rejected');
  await host.send(grant.id, { private: 'data' });
  assert.equal((await rejected).code, 'UNTRUSTED_PEER');
});

test('fresh challenge signatures are socket-bound and cannot authenticate another connection', async t => {
  const f = await fixture(t), identity = createIdentity();
  const connectRaw = () => {
    const ws = new WebSocket(f.relay.audience, 'bzzy-relay.v1');
    t.after(() => ws.terminate()); return ws;
  };
  const a = connectRaw(); const challengeA = JSON.parse((await next(a, 'message')).toString()).data;
  const epoch = random(), presence = { epoch, signature: sign(identity, presenceText(identity.certificate.id, epoch)) };
  const auth = { v: 1, op: 'auth', id: random(), certificate: identity.certificate, presence,
    signature: sign(identity, authText(f.relay.audience, challengeA.challenge, epoch)) };
  a.send(JSON.stringify(auth)); assert.equal(JSON.parse((await next(a, 'message')).toString()).ok, true);
  const b = connectRaw(); await next(b, 'message');
  b.send(JSON.stringify(auth));
  assert.equal(JSON.parse((await next(b, 'message')).toString()).error.code, 'AUTH_FAILED');
});

test('bounded deliveries, oversized messages, request limits and sanitized failures', async t => {
  const f = await fixture(t, { server: { limits: { pendingDeliveries: 1 } } });
  const host = await f.client({ host: true }), recipient = await f.client();
  const { grant } = await pair(host, recipient);
  // An authenticated but invalid encrypted frame cannot consume an unbounded queue.
  const box = { nonce: random(24), ciphertext: random(32) };
  await host.request('route.send', { grantId: grant.id, messageId: random(), box });
  await assert.rejects(host.request('route.send', { grantId: grant.id, messageId: random(), box }), { code: 'DELIVERY_CAPACITY' });
  assert.equal(f.relay.metrics().pendingDeliveries, 1);
  await assert.rejects(host.send(grant.id, { data: 'x'.repeat(100000) }), { code: 'BACKPRESSURE' });
  const privateValue = 'do-not-reflect-' + random();
  await assert.rejects(recipient.request('unknown.' + privateValue), { code: 'UNKNOWN_OPERATION' });
  assert.ok(!JSON.stringify(f.audit).includes(privateValue));
  const url = f.relay.audience.replace('ws:', 'http:').replace('/v1/socket', '/healthz');
  assert.deepEqual(await (await fetch(url)).json(), { ok: true, version: 1 });
});

test('authenticated self registration reuses one public identity and cannot register another device or undo revocation', async t => {
  const f = await fixture(t), host = await f.client();
  await assert.rejects(host.createInvitation({ kind: 'PAIR', resource: 'fresh' }), { code: 'HOST_REQUIRED' });
  const registered = await host.request('host.register');
  assert.equal(registered.id, host.identity.certificate.id);
  assert.equal(f.store.count('devices'), 1);
  assert.deepEqual(await host.request('host.register'), registered);
  assert.equal(f.store.count('devices'), 1);
  await assert.rejects(host.request('host.register', { certificate: createIdentity().certificate }), { code: 'INVALID_MESSAGE' });
  const recipient = await f.client();
  assert.deepEqual((await recipient.grants()).grants, []);
  await pair(host, recipient);
  const before = f.store.count('devices');
  await host.request('host.register');
  assert.equal(f.store.count('devices'), before);
  assert.equal((await host.grants()).grants.length, 1);
  f.store.revokeDevice(host.identity.certificate.id);
  await assert.rejects(host.request('host.register'), { code: 'DEVICE_REVOKED' });
});
