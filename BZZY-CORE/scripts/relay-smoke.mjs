import { RelayClient, createIdentity } from '../src/relay/sdk.js';
import { DEFAULT_RELAY_URL } from '../src/relay/identity.js';

// Opt-in public probe. A disposable candidate does not register a device, create
// an invitation, authorize a session, or leave a private endpoint key on disk.
let client;
try {
  const health = await fetch(new URL('/healthz', DEFAULT_RELAY_URL.replace(/^wss:/, 'https:')), { signal: AbortSignal.timeout(10000), redirect: 'error' });
  if (!health.ok) throw new Error('HEALTH_FAILED');
  const status = await health.json();
  client = new RelayClient({ url: DEFAULT_RELAY_URL, identity: createIdentity(), autoReconnect: false });
  const authentication = await client.connect();
  if (authentication.role !== 'candidate') throw new Error('UNEXPECTED_ROLE');
  console.log(JSON.stringify({ health: status.ok === true, tls: 'verified', authenticatedCandidate: true, hostEnrollment: false }));
} catch { process.stderr.write('Public Relay probe failed; no host connection or session authorization is claimed.\n'); process.exitCode = 1; }
finally { await client?.close(); }
