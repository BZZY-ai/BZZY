// Disposable local Relay/Core only. Never reads the installed host or phone identity.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { startRelay } from '../../BZZY-RELAY/src/server.js';
import { RelayStore } from '../../BZZY-RELAY/src/store.js';
import { createIdentity, verifyCertificate } from '../../BZZY-RELAY/src/identity.js';
import { encodePairingQR } from '../../BZZY-RELAY/src/invitation.js';
import { RelayGateway } from '../../BZZY-CORE/src/relay/gateway.js';
import { BzzyCore } from '../../BZZY-CORE/src/core.js';
import { CoreAssistant } from '../../BZZY-CORE/src/assistant.js';
import { CoreWorkspaces } from '../../BZZY-CORE/src/workspaces.js';
import { getRecord, listRecords, putRecord } from '../../BZZY-CORE/src/engine.js';
import { prepareTask } from '../../BZZY-CORE/src/engine/task.js';
import { newGoal } from '../../BZZY-CORE/src/engine/goals.js';
import { runtimeInfo, runtimeRequest } from '../../BZZY-CORE/src/engine/runtime.js';
import { identityAlive } from '../../BZZY-CORE/src/engine/process-identity.js';
import { RelayClient } from '../../BZZY-RELAY/src/client.js';
import { attachSession } from '../../BZZY-CLI/BZZY-CLI-TERMINAL/src/runtime-client.js';

const directory = fs.mkdtempSync('/tmp/bzzy-pair-connection-');
for (const name of ['private', 'codex', 'claude', 'project']) fs.mkdirSync(path.join(directory, name), { mode: 0o700 });
Object.assign(process.env, { BZZY_HOME: path.join(directory, 'private'),
  BZZY_CODEX_HOME: path.join(directory, 'codex'), BZZY_CLAUDE_HOME: path.join(directory, 'claude'),
  BZZY_CODEX_BIN: fileURLToPath(new URL('../../BZZY-CORE/test/fixtures/codex.mjs', import.meta.url)) });
fs.writeFileSync(path.join(directory, 'codex/auth.json'), '{"fixture":true}', { mode: 0o600 });
putRecord('core.update.preferences', 'default', { monitoringEnabled: false });
const store = new RelayStore(), host = createIdentity();
store.provisionHost(host.certificate);
const relay = await startRelay({ store, allowInsecureLocal: true });
let metricsFailure = false, metricsFailures = 0;
const gateway = new RelayGateway({ identity: host, url: relay.audience, allowInsecureLocal: true,
  clientFactory: options => {
    const client = new RelayClient(options), metricsRequests = new Set(), send = client.send.bind(client);
    client.on('message', data => { if (data.payload.op === 'host.metrics') metricsRequests.add(data.payload.id); });
    client.send = (grantId, payload) => {
      if (payload.type === 'response' && metricsRequests.delete(payload.id) && metricsFailure) {
        metricsFailures++;
        payload = { v: 1, protocol: 'bzzy-core', type: 'response', id: payload.id,
          ok: false, error: { code: 'GATEWAY_UNAVAILABLE' } };
      }
      return send(grantId, payload);
    };
    return client;
  } });
const core = new BzzyCore();
let phone, session, stopping = false, cliTask, closeCLI, cliOwner, cliReady = false, cliClosed = false;

async function stop() {
  if (stopping) return;
  stopping = true;
  cliClosed = true;
  closeCLI?.(null);
  await cliTask?.catch(() => {});
  await gateway.close().catch(() => {});
  const info = runtimeInfo();
  if (info && identityAlive(info.identity)) await runtimeRequest(info, 'POST', '/shutdown', {}).catch(() => {});
  for (let count = 0; info && identityAlive(info.identity) && count < 200; count++) await delay(20);
  await relay.close(); store.close();
  fs.rmSync(directory, { recursive: true, force: true });
}

async function handle(input) {
  switch (input.op) {
    case 'start': {
      phone = verifyCertificate(input.certificate);
      await gateway.start();
      session = core.createConversation({ provider: 'codex', model: 'pair-fixture', cwd: path.join(directory, 'project') }, { requestId: randomUUID() });
      const pairing = await gateway.createPairing({ sessionId: session.id,
        permissions: ['observe', 'claim', 'takeover', 'execute', 'answer', 'pause', 'cancel', 'steer'].filter(permission => input.allowTakeover !== false || permission !== 'takeover'),
        sessionAccess: true, shareAccess: true, agentAccess: true });
      // Only the test transport is redirected to loopback. Exercise the exact
      // production compact codec without connecting to its configured endpoint.
      const qr = encodePairingQR({ relay: 'wss://190.114.255.214/v1/socket', code: pairing.code,
        sender: host.certificate, expiresAt: pairing.expiresAt });
      return { endpoint: relay.audience, host: host.certificate, code: pairing.code, qr, sessionId: session.id,
        coordinatorConfigured: new CoreAssistant().settings().configured };
    }
    case 'approve': {
      const pending = gateway.pendingPairings();
      if (pending.length !== 1 || ['v', 'id', 'signKey', 'boxKey', 'signature'].some(key => pending[0].certificate[key] !== phone[key])) throw new Error('UNEXPECTED_FIXTURE_PHONE');
      await gateway.approvePairing({ claimId: pending[0].claimId, confirmedCertificate: phone, confirmedFingerprint: phone.id });
      return { approved: true };
    }
    case 'state':
      return { pendingCount: gateway.pendingPairings().length, activeGrants: gateway.status().activeGrants,
        subscriptions: gateway.status().subscriptions, gateway: gateway.status().gateway,
        coordinatorConfigured: new CoreAssistant().settings().configured, executionCount: listRecords('execution').length,
        metricsFailures, cliReady };
    case 'goal-seed': {
      prepareTask(session, {}, 'Previous unfinished goal'); session.goal = newGoal('Previous unfinished goal');
      session.acceptance = { passed: true }; putRecord('session', session.id, session);
      return { goalID: session.goal.id };
    }
    case 'goal-state': {
      const current = listRecords('session').find(row => row.id === session.id), jobs = listRecords('execution');
      return { goalID: current.goal?.id, objective: current.goal?.objective, status: current.goal?.status,
        goalExecution: jobs[0]?.goal, executionCount: jobs.length,
        inputHeldByCLI: Boolean(cliOwner && getRecord('input-owner', session.id)?.owner === cliOwner),
        notificationCount: listRecords('outbox').filter(row => row.event.type === 'goal.completed').length };
    }
    case 'cli-attach': {
      if (cliTask) throw new Error('CLI_ALREADY_ATTACHED');
      let signalReady;
      const ready = new Promise(resolve => { signalReady = resolve; });
      const ui = { interactive: true, cursors: new Map(), setSession() {}, updateSession() {}, event() {},
        ask() {
          if (cliClosed) return Promise.resolve(null);
          cliReady = true; signalReady();
          return new Promise(resolve => { closeCLI = resolve; ui.reader = { close: () => resolve(null) }; });
        } };
      cliTask = attachSession(session, {}, ui);
      await Promise.race([ready, cliTask.then(() => { throw new Error('CLI_DID_NOT_ATTACH'); })]);
      const snapshot = await runtimeRequest(runtimeInfo(), 'GET', `/sessions/${session.id}`);
      cliOwner = snapshot.inputOwner?.owner;
      return { attached: cliReady, ownsInput: snapshot.inputOwner != null };
    }
    case 'cli-close': {
      if (!closeCLI) throw new Error('CLI_NOT_ATTACHED');
      cliClosed = true;
      closeCLI(null); await cliTask;
      const snapshot = await runtimeRequest(runtimeInfo(), 'GET', `/sessions/${session.id}`);
      return { closed: true, ownsInput: snapshot.inputOwner != null };
    }
    case 'metrics-failure': metricsFailure = true; return { enabled: true };
    case 'voice-configure':
      new CoreWorkspaces().configure({ path: path.join(directory, 'project') }, { expectedRevision: 0, requestId: randomUUID() });
      new CoreAssistant().configure({ source: 'core', provider: 'codex', model: 'native-voice-fixture' }, { expectedRevision: 0, requestId: randomUUID() });
      return { configured: true };
    case 'core-stop':
      await runtimeRequest(runtimeInfo(), 'POST', '/operator-stop', { shutdown: false });
      return { stopped: true };
    case 'stop': await stop(); return { stopped: true };
    default: throw new Error('UNKNOWN_FIXTURE_OPERATION');
  }
}

process.once('SIGTERM', () => { void stop().finally(() => process.exit(0)); });
try {
  for await (const line of readline.createInterface({ input: process.stdin })) {
    try {
      const input = JSON.parse(line), result = await handle(input);
      process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
      if (input.op === 'stop') break;
    } catch (error) {
      const code = typeof error.code === 'string' && /^[A-Z_]{1,40}$/.test(error.code) ? error.code : 'FIXTURE_FAILED';
      process.stdout.write(`${JSON.stringify({ ok: false, error: code })}\n`);
    }
  }
} finally { await stop(); }
