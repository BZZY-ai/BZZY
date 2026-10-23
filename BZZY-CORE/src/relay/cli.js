import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { once } from 'node:events';
import { writeJson } from '../engine.js';
import { fail, uuid } from '../validation.js';
import { processIdentity, identityAlive } from '../engine/process-identity.js';
import { RelayGateway } from './gateway.js';
import { initializeRelayIdentity, relayDirectory } from './identity.js';
import { revokeLocalRelayGrant } from './revocation.js';

const HELP = 'Usage: bzzy-core relay <init|status|run|pair SESSION_UUID [--permissions observe,claim,...]|revoke GRANT_ID>\ninit prints only the public certificate for operator enrollment. Pairing requires a private interactive terminal.';
export async function relayCommand(args) {
  const [command = 'help', ...rest] = args;
  if (command === 'help') { console.log(HELP); return; }
  if (command === 'init') {
    if (rest.length) fail('INVALID_REQUEST', 'Unexpected initialization arguments.');
    console.log(JSON.stringify(initializeRelayIdentity())); return;
  }
  if (command === 'status') {
    const file = path.join(relayDirectory(), 'gateway.json');
    const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    console.log(JSON.stringify(saved && identityAlive(saved.process) ? saved.status : { transport: 'offline', gateway: 'stopped' })); return;
  }
  if (command === 'revoke') {
    if (rest.length !== 1) fail('INVALID_REQUEST', 'Choose one local gateway grant.');
    console.log(JSON.stringify(revokeLocalRelayGrant(rest[0]))); return;
  }
  if (!['run', 'pair'].includes(command)) fail('INVALID_REQUEST', HELP);
  let sessionId, permissions = ['observe'];
  if (command === 'pair') {
    sessionId = uuid(rest[0]);
    if (!process.stdin.isTTY || !process.stdout.isTTY) fail('PRIVATE_TERMINAL_REQUIRED', 'Pairing QR/codes must be displayed only in a private interactive terminal.');
    if (rest.length > 1) {
      if (rest.length !== 3 || rest[1] !== '--permissions') fail('INVALID_REQUEST', HELP);
      permissions = rest[2].split(',');
    }
  } else if (rest.length) fail('INVALID_REQUEST', HELP);
  const gateway = new RelayGateway(), interrupted = new AbortController();
  const stop = () => interrupted.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  let ui, approvals = Promise.resolve();
  gateway.on('status', status => {
    writeJson(path.join(relayDirectory(), 'gateway.json'), { process: processIdentity(), status: { ...status, relayUrl: gateway.status().relayUrl } });
    if (process.stdout.isTTY) console.log(`Relay transport: ${status.transport}`);
  });
  gateway.on('fault', value => { process.stderr.write(`Relay status: ${value.code}\n`); });
  try {
    await gateway.start();
    if (command === 'pair') {
      ui = createInterface({ input: process.stdin, output: process.stdout });
      gateway.on('pairing.requested', request => {
        approvals = approvals.then(async () => {
          if (interrupted.signal.aborted) return;
          console.log(`Device fingerprint: ${request.deviceId}\nSession: ${request.sessionId}\nPermissions: ${request.permissions.join(', ')}`);
          const confirmed = await ui.question('Type the fingerprint displayed on the phone to approve, or Enter to deny: ', { signal: interrupted.signal });
          if (confirmed.trim() === request.deviceId) {
            const approved = await gateway.approvePairing({ claimId: request.claimId, confirmedCertificate: request.certificate, confirmedFingerprint: confirmed.trim() });
            console.log(`Device paired. Local grant: ${approved.id}`);
          } else { await gateway.denyPairing(request.claimId); console.log('Pairing denied.'); }
        }).catch(() => { if (!interrupted.signal.aborted) process.stderr.write('Pairing was not approved.\n'); });
      });
      const invitation = await gateway.createPairing({ sessionId, permissions });
      console.log(await invitation.renderQR({ terminal: true }));
      console.log(`Pairing code: ${invitation.code}\nScan inside BZZY. Verify the host fingerprint: ${gateway.status().hostId}`);
    }
    if (process.stdout.isTTY) console.log('Core Relay gateway is running. Ctrl+C disconnects the gateway; managed Core work continues.');
    if (!interrupted.signal.aborted) await once(interrupted.signal, 'abort');
  } finally {
    ui?.close(); await gateway.close();
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
}
