// Isolated transport demonstration. Does not touch Core, private accounts or project data.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { RelayStore } from '../src/store.js';
import { startRelay } from '../src/server.js';
import { RelayClient } from '../src/client.js';
import { createIdentity } from '../src/identity.js';
import { encodeInvitation, decodeInvitation, renderInvitationQR } from '../src/invitation.js';

const store = new RelayStore(), hostIdentity = createIdentity(), deviceIdentity = createIdentity();
store.provisionHost(hostIdentity.certificate);
const relay = await startRelay({ store, allowInsecureLocal: true });
const host = new RelayClient({ url: relay.audience, identity: hostIdentity, allowInsecureLocal: true, autoReconnect: false });
const device = new RelayClient({ url: relay.audience, identity: deviceIdentity, allowInsecureLocal: true, autoReconnect: false });
try {
  await Promise.all([host.connect(), device.connect()]);
  const invitation = await host.createInvitation({ kind: 'PAIR', resource: 'demo_observer' });
  const content = { relay: relay.audience, code: invitation.code, sender: hostIdentity.certificate, expiresAt: invitation.expiresAt };
  const qr = encodeInvitation(content, { allowInsecureLocal: true });
  const svg = await renderInvitationQR(content, { allowInsecureLocal: true });
  assert.ok(svg.startsWith('<svg')); assert.equal(decodeInvitation(qr, { allowInsecureLocal: true }).code, invitation.code);
  const claim = await device.claim(invitation.code);
  // Demo fixtures know each other's identity. Real UIs compare both fingerprints
  // before calling approve()/trustPeer(); they never automatically approve a claim.
  const { grant } = await host.approve(claim.claimId, deviceIdentity.certificate);
  device.trustPeer(hostIdentity.certificate);
  const message = once(device, 'message', { signal: AbortSignal.timeout(3000) });
  await host.send(grant.id, { type: 'event', event: { id: 'demo:1', seq: 1, provenance: 'demo-fixture' } });
  assert.equal((await message)[0].payload.event.id, 'demo:1');
  await host.revokeGrant(grant.id);
  await assert.rejects(device.send(grant.id, { type: 'observe' }), { code: 'GRANT_UNAVAILABLE' });
  console.log('Verified: QR generation, explicit pairing, encrypted delivery, event identity, revocation.');
} finally { await Promise.all([host.close(), device.close()]); await relay.close(); store.close(); }
