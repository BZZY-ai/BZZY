// Local smoke measurement, not a capacity claim for the intended VPS.
import { once } from 'node:events';
import { RelayStore } from '../src/store.js';
import { startRelay } from '../src/server.js';
import { RelayClient } from '../src/client.js';
import { createIdentity } from '../src/identity.js';

const store = new RelayStore(), identity = createIdentity(); store.provisionHost(identity.certificate);
const relay = await startRelay({ store, allowInsecureLocal: true });
const host = new RelayClient({ url: relay.audience, identity, allowInsecureLocal: true, autoReconnect: false });
const clients = [];
try {
  await host.connect();
  for (let i = 0; i < 4; i++) {
    const client = new RelayClient({ url: relay.audience, identity: createIdentity(), allowInsecureLocal: true, autoReconnect: false });
    clients.push(client); await client.connect();
    const inv = await host.createInvitation({ kind: 'PAIR', resource: `measurement_${i}` });
    const claim = await client.claim(inv.code);
    const { grant } = await host.approve(claim.claimId, client.identity.certificate);
    client.trustPeer(identity.certificate); client.measurementGrant = grant.id;
  }
  const start = performance.now(), cpu = process.cpuUsage(); let peak = relay.metrics();
  for (let i = 0; i < 20; i++) {
    for (const client of clients) {
      const received = once(client, 'message', { signal: AbortSignal.timeout(3000) });
      await host.send(client.measurementGrant, { type: 'measurement', sequence: i, data: 'x'.repeat(4096) });
      await received;
      const current = relay.metrics();
      peak = Object.fromEntries(Object.keys(current).map(key => [key, Math.max(peak[key], current[key])]));
    }
  }
  console.log(JSON.stringify({ kind: 'local-smoke-only', node: process.version, platform: process.platform, architecture: process.arch,
    messages: 80, applicationBytes: 80 * 4096, elapsedMs: Math.round(performance.now() - start), cpuMicroseconds: process.cpuUsage(cpu),
    sampledMaximumAfterReceipts: peak, final: relay.metrics(), disk: 'in-memory metadata; no payload persistence',
    note: 'Samples are taken after receipts, not continuously. RSS includes server and all five endpoints in one process. VPS/TLS capacity is not measured.' }, null, 2));
} finally { await Promise.all([host.close(), ...clients.map(c => c.close())]); await relay.close(); store.close(); }
