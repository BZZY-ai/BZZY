// Operator-only verification with disposable in-memory endpoint secrets.
// Writes public certificates only. Never use real account data in this script.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { once } from 'node:events';
import readline from 'node:readline/promises';
import { RelayClient } from '../src/client.js';
import { createIdentity } from '../src/identity.js';
import { encodeInvitation, decodeInvitation } from '../src/invitation.js';
import { random, relayUrl } from '../src/protocol.js';

const [url, publicFile] = process.argv.slice(2);
relayUrl(url);
if (!publicFile) throw new Error('A public certificate output file is required.');
const identities = [createIdentity(), createIdentity(), createIdentity()];
fs.writeFileSync(publicFile, JSON.stringify(identities.map(identity => identity.certificate)) + '\n', { mode: 0o600, flag: 'wx' });
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const clients = identities.map(identity => new RelayClient({ url, identity, autoReconnect: true }));
const [host, recipient, outsider] = clients;
const event = (client, name) => once(client, name, { signal: AbortSignal.timeout(10000) }).then(([data]) => data);
const ready = client => client.status === 'online' ? Promise.resolve() : new Promise((resolve, reject) => {
  const timer = setTimeout(() => { client.off('status', status); reject(new Error('Reconnect deadline')); }, 15000);
  const status = value => { if (value === 'online') { clearTimeout(timer); client.off('status', status); resolve(); } };
  client.on('status', status);
});
try {
  await rl.question('Public certificates prepared. Provision only the first certificate as a temporary host, then press Enter.\n');
  await Promise.all(clients.map(client => client.connect()));
  const invitation = await host.createInvitation({ kind: 'AGENT', resource: 'public_smoke_fixture' });
  const qr = encodeInvitation({ relay: url, code: invitation.code, sender: identities[0].certificate, expiresAt: invitation.expiresAt });
  assert.equal(decodeInvitation(qr).code, invitation.code);
  const claim = await recipient.claim(invitation.code);
  await assert.rejects(host.approve(claim.claimId, identities[2].certificate), { code: 'RECIPIENT_MISMATCH' });
  const { grant } = await host.approve(claim.claimId, identities[1].certificate);
  recipient.trustPeer(identities[0].certificate);
  assert.deepEqual(grant.spec.actions, ['import']);
  await assert.rejects(outsider.request('grant.inspect', { grantId: grant.id }), { code: 'GRANT_UNAVAILABLE' });
  await assert.rejects(recipient.createInvitation({ kind: 'PAIR', resource: 'forbidden' }), { code: 'HOST_REQUIRED' });
  await assert.rejects(recipient.claim(invitation.code), { code: 'INVITE_UNAVAILABLE' });
  const frames = [], send = host.ws.send.bind(host.ws);
  host.ws.send = (data, ...args) => { frames.push(String(data)); return send(data, ...args); };
  const fixture = `public-smoke-fictional-content-${random()}`;
  let receivedCount = 0; recipient.on('message', () => receivedCount++);
  const start = performance.now();
  for (let seq = 1; seq <= 20; seq++) {
    const received = event(recipient, 'message');
    await host.send(grant.id, { fixture, event: { id: `fixture:${seq}`, seq, provenance: 'test-fixture' } });
    assert.equal((await received).payload.event.seq, seq);
  }
  assert.ok(!frames.join('').includes(fixture));
  const captured = frames.map(frame => JSON.parse(frame)).filter(frame => frame.op === 'route.send').at(-1);
  const replay = event(recipient, 'rejected');
  await host.request('route.send', { grantId: grant.id, messageId: captured.messageId, box: captured.box });
  assert.equal((await replay).code, 'REPLAY');
  await recipient.close(); await recipient.connect();
  const stale = event(recipient, 'rejected');
  await host.request('route.send', { grantId: grant.id, messageId: random(), box: captured.box });
  assert.equal((await stale).code, 'ROUTING_MISMATCH');
  assert.equal(receivedCount, 20);
  for (const kind of ['PAIR', 'TERMINAL']) {
    const inv = await host.createInvitation({ kind, resource: 'public_smoke_fixture' });
    const c = await recipient.claim(inv.code);
    const approved = await host.approve(c.claimId, identities[1].certificate);
    assert.deepEqual(approved.grant.spec.actions, kind === 'PAIR' ? ['observe'] : ['import']);
    await host.revokeGrant(approved.grant.id);
  }
  const expiring = await host.createInvitation({ kind: 'AGENT', resource: 'expiry_fixture', ttlSeconds: 1 });
  await new Promise(resolve => setTimeout(resolve, 1100));
  await assert.rejects(recipient.claim(expiring.code), { code: 'INVITE_EXPIRED' });
  await host.revokeGrant(grant.id);
  await assert.rejects(recipient.send(grant.id, {}), { code: 'GRANT_UNAVAILABLE' });
  const beforeRestart = host.epoch;
  console.log(JSON.stringify({ publicWss: 'passed', encryptedMessages: receivedCount, elapsedMs: Math.round(performance.now() - start),
    checks: ['recipient-confirmation', 'cross-device-isolation', 'single-use', 'opaque-wire', 'replay', 'reconnect', 'pair-agent-terminal-purpose', 'expiry', 'revocation'] }));
  await rl.question('Restart Relay using the operator connection, then press Enter to verify persisted state.\n');
  await Promise.all(clients.map(ready));
  assert.notEqual(host.epoch, beforeRestart);
  await assert.rejects(recipient.claim(invitation.code), { code: 'INVITE_UNAVAILABLE' });
  await assert.rejects(recipient.send(grant.id, {}), { code: 'GRANT_UNAVAILABLE' });
  console.log(JSON.stringify({ restartPersistence: 'passed', deviceIdsToRevoke: identities.map(identity => identity.certificate.id) }));
} catch (error) {
  console.error(JSON.stringify({ publicVerification: 'failed', code: error.code || error.name }));
  process.exitCode = 1;
} finally { rl.close(); await Promise.all(clients.map(client => client.close())); }
