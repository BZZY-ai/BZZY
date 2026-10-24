// Two disposable Core homes and identities behind one loopback Relay. No host
// installation, real phone identity, provider account or user workspace is read.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { startRelay } from '../../BZZY-RELAY/src/server.js';
import { RelayStore } from '../../BZZY-RELAY/src/store.js';
import { createIdentity, verifyCertificate } from '../../BZZY-RELAY/src/identity.js';
import { RelayClient } from '../../BZZY-RELAY/src/client.js';
import { encodePairingQR } from '../../BZZY-RELAY/src/invitation.js';

const worker = process.argv.includes('--worker');
let handle, cleanup;
if (worker) {
  const { RelayGateway } = await import('../../BZZY-CORE/src/relay/gateway.js');
  const { BzzyCore } = await import('../../BZZY-CORE/src/core.js');
  const { appendEvent, listRecords, putRecord } = await import('../../BZZY-CORE/src/engine.js');
  const { runtimeInfo, runtimeRequest } = await import('../../BZZY-CORE/src/engine/runtime.js');
  const { pauseRuntimeExecutions } = await import('../../BZZY-CORE/src/engine/runtime-processes.js');
  const { identityAlive } = await import('../../BZZY-CORE/src/engine/process-identity.js');
  putRecord('core.update.preferences', 'default', { monitoringEnabled: false });
  const core = new BzzyCore();
  let gateway, host, phone, session, approvedGrant, closed = false;
  const notificationCalls = [], controlCalls = [];
  let holdNotificationResponses = false, heldNotificationResponses = [];
  cleanup = async () => {
    if (closed) return; closed = true;
    await gateway?.close().catch(() => {});
    const info = runtimeInfo();
    // Runtime shutdown preserves durable work. This disposable fixture owns its
    // intentionally held turns and must stop their verified runner/backend
    // identities before the parent removes this worker's isolated private home.
    if (info && identityAlive(info.identity)) {
      await runtimeRequest(info, 'POST', '/operator-stop', { shutdown: false });
      await runtimeRequest(info, 'POST', '/shutdown', {});
    } else await pauseRuntimeExecutions({ timeoutMs: 4000 });
    for (let i = 0; info && identityAlive(info.identity) && i < 200; i++) await delay(20);
    if (info && identityAlive(info.identity)) throw new Error('FIXTURE_CLEANUP_INCOMPLETE');
  };
  handle = async input => {
    switch (input.op) {
      case 'start': {
        host = input.identity; phone = verifyCertificate(input.certificate);
        gateway = new RelayGateway({ identity: host, url: input.endpoint, allowInsecureLocal: true,
          clientFactory: options => {
            const client = new RelayClient(options), send = client.send.bind(client), notificationRequests = new Set();
            client.on('message', data => {
              const op = data.payload.op;
              if (['notifications.register', 'notifications.update', 'notifications.revoke'].includes(op)) {
                notificationCalls.push({ op, enabled: data.payload.params?.enabled, hostHints: data.payload.params?.hostHints });
                notificationRequests.add(data.payload.id);
              }
              if (['input.claim', 'input.release', 'control.request', 'execution.execute', 'task.submit', 'voice.send', 'voice.cancel'].includes(op)) controlCalls.push(op);
            });
            client.send = (grant, payload) => {
              if (holdNotificationResponses && payload.type === 'response' && notificationRequests.delete(payload.id)) {
                heldNotificationResponses.push(() => send(grant, payload)); return Promise.resolve({ held: true });
              }
              if (input.advertiseHostHints === false && payload.type === 'response' && payload.result?.capabilities) {
                payload = structuredClone(payload); delete payload.result.capabilities.notificationsHostRouting;
              }
              return send(grant, payload);
            };
            return client;
          } });
        await gateway.start();
        session = core.createConversation({ provider: 'codex', model: 'multi-host-fixture', alias: input.name,
          cwd: path.join(path.dirname(process.env.BZZY_HOME), 'project') }, { requestId: randomUUID() });
        appendEvent(session.id, 'message.user', { text: `${input.name} private question` });
        appendEvent(session.id, 'text', { text: `${input.name} private answer`, itemId: 'fixture-reply' });
        const pairing = await gateway.createPairing({ sessionId: session.id,
          permissions: ['observe', 'claim', 'takeover', 'execute', 'answer', 'pause', 'cancel', 'steer'],
          sessionAccess: true, shareAccess: true, agentAccess: true });
        const qr = encodePairingQR({ relay: 'wss://190.114.255.214/v1/socket', code: pairing.code,
          sender: host.certificate, expiresAt: pairing.expiresAt });
        return { host: host.certificate, sessionId: session.id, code: pairing.code, qr };
      }
      case 'approve': {
        const pending = gateway.pendingPairings();
        if (pending.length !== 1 || pending[0].certificate.id !== phone.id) throw new Error('UNEXPECTED_PHONE');
        approvedGrant = await gateway.approvePairing({ claimId: pending[0].claimId, confirmedCertificate: phone, confirmedFingerprint: phone.id });
        return { approved: true };
      }
      case 'state': return { pendingCount: gateway.pendingPairings().length, ...gateway.status(),
        modeCommands: listRecords('core.relay.command').filter(row => row.op === 'session.mode').map(row => ({ state: row.state, code: row.code || null, mode: row.result?.mode || null })),
        notificationHostHints: listRecords('core.push.registration').map(row => row.hostHints === true),
        notificationRelayPush: listRecords('core.push.registration').map(row => row.relayPush === true),
        notificationBindings: listRecords('core.push.registration').map(row => ({ enabled: row.enabled, revoked: Boolean(row.revokedAt), hasToken: Boolean(row.deviceToken) })),
        notificationCalls, controlCalls,
        executions: listRecords('execution').map(e => ({ id: e.id, state: e.state, prompt: e.prompt })), executionCount: listRecords('execution').length };
      case 'hold-notification-responses': holdNotificationResponses = true; return { holding: true };
      case 'release-notification-responses': {
        holdNotificationResponses = false;
        const pending = heldNotificationResponses; heldNotificationResponses = [];
        await Promise.all(pending.map(send => send())); return { released: pending.length };
      }
      case 'append': return { eventId: appendEvent(session.id, 'text', { text: input.text, itemId: randomUUID() }).id };
      case 'offline': await gateway.close(); return { offline: true };
      case 'online': await gateway.start(); return { online: true };
      case 'revoke': await gateway.revokeGrant(approvedGrant.id); return { revoked: true };
      case 'stop': await cleanup(); return { stopped: true };
      default: throw new Error('UNKNOWN_OPERATION');
    }
  };
} else {
  const directory = fs.mkdtempSync('/tmp/bzzy-multi-host-'), store = new RelayStore(), children = [];
  const identities = [createIdentity(), createIdentity()];
  for (const identity of identities) store.provisionHost(identity.certificate);
  const relay = await startRelay({ store, allowInsecureLocal: true });
  let closed = false;
  const request = (child, fields) => new Promise((resolve, reject) => {
    child.waiters.push({ resolve, reject }); child.stdin.write(`${JSON.stringify(fields)}\n`);
  });
  cleanup = async () => {
    if (closed) return; closed = true;
    const stopped = await Promise.allSettled(children.map(async child => {
      try { await request(child, { op: 'stop' }); }
      finally { child.stdin.end(); }
    }));
    await relay.close(); store.close();
    // Keep the private fixture directory available for diagnosis if any worker
    // could not verify shutdown; never delete a still-running worker's home.
    if (stopped.some(result => result.status === 'rejected')) throw new Error('FIXTURE_CLEANUP_INCOMPLETE');
    fs.rmSync(directory, { recursive: true, force: true });
  };
  handle = async input => {
    if (input.op === 'start') {
      const hosts = [];
      for (let index = 0; index < 2; index++) {
        const home = path.join(directory, String(index));
        for (const name of ['', 'private', 'project', 'codex', 'claude']) fs.mkdirSync(path.join(home, name), { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(home, 'codex/auth.json'), '{"fixture":true}', { mode: 0o600 });
        const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--worker'], {
          env: { ...process.env, BZZY_HOME: path.join(home, 'private'), BZZY_CODEX_HOME: path.join(home, 'codex'), BZZY_CLAUDE_HOME: path.join(home, 'claude'),
            BZZY_CODEX_BIN: fileURLToPath(new URL('./core-line-model.mjs', import.meta.url)) },
          stdio: ['pipe', 'pipe', 'inherit'] });
        child.waiters = [];
        readline.createInterface({ input: child.stdout }).on('line', line => {
          const pending = child.waiters.shift();
          if (!pending) return;
          try { const frame = JSON.parse(line); frame.ok ? pending.resolve(frame.result) : pending.reject(new Error(frame.error)); }
          catch (error) { pending.reject(error); }
        });
        child.on('exit', () => { for (const pending of child.waiters.splice(0)) pending.reject(new Error('WORKER_EXIT')); });
        children.push(child);
        hosts.push(await request(child, { op: 'start', identity: identities[index], endpoint: relay.audience, certificate: input.certificate, advertiseHostHints: input.advertiseHostHints, name: index === 0 ? 'Test Mac' : 'Real server' }));
      }
      return { endpoint: relay.audience, hosts };
    }
    if (input.op === 'stop') { await cleanup(); return { stopped: true }; }
    return request(children[input.host ?? 0], input);
  };
}
process.once('SIGTERM', () => { void cleanup().finally(() => process.exit(0)); });
try {
  for await (const line of readline.createInterface({ input: process.stdin })) {
    try {
      const input = JSON.parse(line), result = await handle(input);
      process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
      if (input.op === 'stop') break;
    } catch { process.stdout.write(`${JSON.stringify({ ok: false, error: 'FIXTURE_FAILED' })}\n`); }
  }
} finally { await cleanup(); }
