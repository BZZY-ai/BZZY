// Disposable loopback transport only. No Core, private identities or account files.
import readline from 'node:readline';
import { RelayStore } from '../../BZZY-RELAY/src/store.js';
import { startRelay } from '../../BZZY-RELAY/src/server.js';
import { RelayClient } from '../../BZZY-RELAY/src/client.js';
import { createIdentity, seal } from '../../BZZY-RELAY/src/identity.js';
import { random } from '../../BZZY-RELAY/src/protocol.js';

let store, relay, host, grant, pending, burst;
let sent = 0, received = 0, failure = null;
async function command(frame) {
  switch (frame.op) {
    case 'start': {
      store = new RelayStore();
      relay = await startRelay({ store, allowInsecureLocal: true,
        ...(frame.dataLimit ? { limits: { transferRequestsPerMinute: frame.dataLimit } } : {}) });
      const identity = createIdentity(); store.provisionHost(identity.certificate);
      host = new RelayClient({ url: relay.audience, identity, allowInsecureLocal: true, autoReconnect: false });
      host.on('invite.requested', value => { pending = value; });
      host.on('delivery.received', () => { received++; });
      await host.connect();
      const invitation = await host.createInvitation({ kind: 'PAIR', resource: 'transport-fixture', actions: ['observe'] });
      return { endpoint: relay.audience, host: identity.certificate, code: invitation.code };
    }
    case 'approve':
      ({ grant } = await host.approve(pending.claimId, frame.certificate));
      return { grantID: grant.id };
    case 'burst': {
      // Return before sending so URLSession's main actor can process deliveries.
      // A single current signed presence is sufficient for this isolated burst;
      // the production SDK continues to inspect every route.
      burst = (async () => {
        const { grant: current, peer } = await host.route(grant.id);
        for (let index = 0; index < frame.count; index++) {
          const messageId = random(), envelope = { v: 1, from: host.identity.certificate.id,
            to: peer.id, grantId: grant.id, messageId, receiverEpoch: current.presence.epoch,
            expiresAt: Date.now() + 60000, payload: { index } };
          await host.request('route.send', { grantId: grant.id, messageId, box: seal(host.identity, peer, envelope) });
          sent++;
          // Receipt-dependent tests must not accidentally coalesce two in-flight
          // grant inspections. Wait for this accepted delivery before the next.
          const deadline = Date.now() + 5000;
          while (index + 1 < frame.count && received <= index && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 5));
          }
        }
      })().catch(error => { failure = error.code || 'FAILED'; });
      return { started: true };
    }
    case 'state': return { sent, received, failure };
    case 'stop':
      await host?.close(); await relay?.close(); store?.close(); return { stopped: true };
    default: throw new Error('INVALID_FIXTURE_COMMAND');
  }
}
for await (const line of readline.createInterface({ input: process.stdin })) {
  try { const frame = JSON.parse(line), result = await command(frame); process.stdout.write(JSON.stringify({ ok: true, result }) + '\n'); if (frame.op === 'stop') break; }
  catch { process.stdout.write(JSON.stringify({ ok: false }) + '\n'); }
}
