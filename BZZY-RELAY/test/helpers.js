import { once } from 'node:events';
import { createIdentity } from '../src/identity.js';
import { RelayStore } from '../src/store.js';
import { startRelay } from '../src/server.js';
import { RelayClient } from '../src/client.js';

export function next(emitter, event) {
  return once(emitter, event, { signal: AbortSignal.timeout(4000) }).then(([data]) => data);
}
export async function fixture(t, options = {}) {
  const store = new RelayStore(options.store);
  const audit = [];
  const relay = await startRelay({ store, allowInsecureLocal: true, audit: row => audit.push(row), ...options.server });
  const clients = [];
  t.after(async () => { await Promise.all(clients.map(c => c.close())); await relay.close(); store.close(); });
  const client = async ({ host = false, identity = createIdentity(), ...extra } = {}) => {
    if (host) store.provisionHost(identity.certificate);
    const c = new RelayClient({ url: relay.audience, identity, allowInsecureLocal: true, autoReconnect: false, ...extra });
    clients.push(c); await c.connect(); return c;
  };
  return { store, relay, client, audit, clients };
}
export async function pair(host, recipient, spec = { kind: 'PAIR', resource: 'test_resource' }) {
  const invitation = await host.createInvitation(spec);
  const request = next(host, 'invite.requested');
  const claim = await recipient.claim(invitation.code);
  await request;
  const { grant } = await host.approve(claim.claimId, recipient.identity.certificate);
  recipient.trustPeer(host.identity.certificate);
  return { grant, invitation, claim };
}
