import path from 'node:path';
import { home, writeJson } from '../engine/files.js';
import { processIdentity } from '../engine/process-identity.js';

// Trusted local status persistence shared by operator and terminal adapters.
// Invitation payloads, tokens and key material are intentionally not accepted.
export function recordGatewayStatus(status) {
  const safe = Object.fromEntries(['transport', 'gateway', 'relayUrl', 'hostId', 'protocol', 'version', 'activeGrants',
    'subscriptions', 'enabled', 'managed', 'portableSharing', 'projectSharing', 'errorCode', 'connectedAt', 'pendingPairings', 'grants']
    .filter(key => Object.hasOwn(status, key) && ['string', 'number', 'boolean'].includes(typeof status[key]))
    .map(key => [key, status[key]]));
  writeJson(path.join(home(), 'relay', 'gateway.json'), { process: processIdentity(), status: safe });
}
