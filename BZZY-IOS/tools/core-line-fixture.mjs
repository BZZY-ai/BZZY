// Disposable local Relay + actual Core runtime for the native Swift line check.
// JSON-lines over stdio is test control only, never a replacement app protocol.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { startRelay } from '../../BZZY-RELAY/src/server.js';
import { RelayStore } from '../../BZZY-RELAY/src/store.js';
import { createIdentity, verifyCertificate, saveIdentity } from '../../BZZY-RELAY/src/identity.js';
import { CoreRelayClient } from '../../BZZY-CORE/src/relay/client.js';
import { BzzyCore } from '../../BZZY-CORE/src/core.js';
import { CoreAssistant } from '../../BZZY-CORE/src/assistant.js';
import { CoreWorkspaces } from '../../BZZY-CORE/src/workspaces.js';
import { appendEvent, listRecords, getRecord, putRecord } from '../../BZZY-CORE/src/engine.js';
import { runtimeInfo, runtimeRequest, clearOperatorStopIntent } from '../../BZZY-CORE/src/engine/runtime.js';
import { identityAlive } from '../../BZZY-CORE/src/engine/process-identity.js';
import { renderMessageBody } from '../../BZZY-CLI/BZZY-CLI-TERMINAL/src/message-renderer.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
if (Number(process.versions.node.split('.')[0]) < 24) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: 'NODE_24_REQUIRED' })}\n`);
  process.exit(1);
}
const directory = fs.mkdtempSync('/tmp/bzzy-native-line-');
const workspace = path.join(directory, 'project');
fs.mkdirSync(workspace, { mode: 0o700 });
Object.assign(process.env, { BZZY_HOME: path.join(directory, 'private'), BZZY_CODEX_HOME: path.join(directory, 'codex'),
  BZZY_CLAUDE_HOME: path.join(directory, 'claude'), BZZY_CODEX_BIN: path.join(root, 'BZZY-IOS/tools/core-line-model.mjs') });
fs.mkdirSync(process.env.BZZY_HOME, { mode: 0o700 });
putRecord('core.update.preferences', 'default', { monitoringEnabled: false });
fs.mkdirSync(process.env.BZZY_CODEX_HOME, { mode: 0o700 });
// Synthetic test marker only; the offline backend never authenticates or reads
// real account files. The production isolation path still requires a private file.
fs.writeFileSync(path.join(process.env.BZZY_CODEX_HOME, 'auth.json'), JSON.stringify({ fixture: true }), { mode: 0o600 });
fs.mkdirSync(process.env.BZZY_CLAUDE_HOME, { mode: 0o700 });
const store = new RelayStore(), host = createIdentity(), audit = [];
store.provisionHost(host.certificate);
const relay = await startRelay({ store, allowInsecureLocal: true, audit: event => audit.push(event) });
fs.mkdirSync(path.join(process.env.BZZY_HOME, 'relay'), { mode: 0o700 });
saveIdentity(path.join(process.env.BZZY_HOME, 'relay/host.identity.json'), host);
fs.writeFileSync(path.join(process.env.BZZY_HOME, 'relay/service.json'), JSON.stringify({ enabled: false,
  url: relay.audience, allowInsecureLocal: true }), { mode: 0o600 });
const core = new BzzyCore(), assistant = new CoreAssistant();
let gateway, expectedPhone, direct, observer, task, stopping = false;
const controls = ['observe', 'claim', 'takeover', 'execute', 'answer', 'pause', 'cancel', 'steer'];
const makeGateway = () => {
  const value = new CoreRelayClient();
  value.on('pairing.requested', request => {
    // Only this test's independently supplied disposable phone is approved.
    if (['v', 'id', 'signKey', 'boxKey', 'signature'].some(key => request.certificate[key] !== expectedPhone[key])) return;
    void value.approvePairing({ claimId: request.claimId, confirmedCertificate: expectedPhone,
      confirmedFingerprint: expectedPhone.id }).catch(() => {});
  });
  return value;
};

async function stop() {
  if (stopping) return;
  stopping = true;
  try { await gateway?.close(); } catch {}
  const info = runtimeInfo();
  if (info && identityAlive(info.identity)) await runtimeRequest(info, 'POST', '/shutdown', {}).catch(() => {});
  for (let attempt = 0; info && identityAlive(info.identity) && attempt < 200; attempt++) await delay(20);
  await relay.close(); store.close();
  fs.rmSync(directory, { recursive: true, force: true });
}

async function handle(input) {
  switch (input.op) {
    case 'start': {
      expectedPhone = verifyCertificate(input.certificate);
      gateway = makeGateway(); await gateway.start();
      direct = core.createConversation({ provider: 'codex', model: 'fixture-model', cwd: workspace }, { requestId: randomUUID() });
      if (input.advanced === true) {
        new CoreWorkspaces().configure({ path: path.join(directory, 'managed'), create: true }, { requestId: randomUUID(), expectedRevision: 0 });
        fs.writeFileSync(path.join(workspace, 'source.txt'), 'Synthetic native share source project.');
      }
      observer = core.createConversation({ provider: 'codex', model: 'fixture-model', cwd: workspace }, { requestId: randomUUID() });
      assistant.configure({ source: 'core', provider: 'codex', model: 'coordinator-fixture' }, { requestId: randomUUID(), expectedRevision: 0 });
      task = assistant.createContext({ cwd: workspace }, { requestId: randomUUID() });
      return { endpoint: relay.audience, host: host.certificate, sessionId: direct.id, otherSessionId: observer.id,
        taskSessionId: task.contextId,
        direct: await gateway.createPairing({ sessionId: direct.id, permissions: controls, sessionAccess: true,
          agentAccess: input.advanced === true, shareAccess: input.advanced === true }),
        observer: await gateway.createPairing({ sessionId: observer.id }),
        task: await gateway.createPairing({ sessionId: task.contextId, permissions: controls }) };
    }
    case 'state': {
      const executionRecords = listRecords('execution');
      const executions = executionRecords.map(value => ({ id: value.id, sessionId: value.sessionId, state: value.state, exitCode: value.exitCode }));
      const output = direct ? (await core.events(direct.id)).events.filter(event => event.type === 'text').map(event => event.data.text || '').join('') : '';
      const managed = await runtimeRequest(runtimeInfo(), 'GET', '/v1/relay/status');
      return { executions, executionCount: executions.length, activeGrants: managed.status.activeGrants,
        nativeExecutionCount: executionRecords.filter(value => !value.importProvenance).length,
        importedExecutionCount: executionRecords.filter(value => value.importProvenance?.observation === 'imported-history').length,
        cursors: listRecords('core.relay.cursor').map(value => ({ sessionId: value.sessionId, seq: value.seq })),
        terminalRendersBody: output.includes('<message version="1">') && renderMessageBody(output).lines.join('\n').includes('Offline result'),
        plaintextLeak: /LINE_NATIVE_PRIVATE_PROMPT|Offline result/.test(JSON.stringify(audit)) };
    }
    case 'detach': {
      await gateway.close();
      const managed = await runtimeRequest(runtimeInfo(), 'GET', '/v1/relay/status');
      return { ready: managed.status.gateway === 'ready', managed: managed.status.managed === true };
    }
    case 'operator-stop':
      return runtimeRequest(runtimeInfo(), 'POST', '/v1/operator-stop', { shutdown: false });
    case 'operator-start':
    case 'restart': {
      await gateway.close();
      const previous = runtimeInfo();
      await runtimeRequest(previous, 'POST', '/shutdown', {});
      for (let attempt = 0; identityAlive(previous.identity) && attempt < 200; attempt++) await delay(20);
      if (input.op === 'operator-start') clearOperatorStopIntent();
      await core.start();
      // No POST connect: the new daemon must restore the enabled host gateway.
      let managed;
      for (let attempt = 0; attempt < 100; attempt++) {
        managed = await runtimeRequest(runtimeInfo(), 'GET', '/v1/relay/status');
        if (managed.status.gateway === 'ready') break;
        await delay(50);
      }
      gateway = makeGateway();
      return { ready: managed.status.gateway === 'ready', restarted: runtimeInfo().identity.pid !== previous.identity.pid };
    }
    case 'append': {
      const event = appendEvent(direct.id, 'future.line-check', { text: 'Reconnect observation', provenance: 'host-observed' });
      return { id: event.id, seq: event.seq };
    }
    case 'revoke':
      await runtimeRequest(runtimeInfo(), 'POST', '/v1/relay/revoke', { grantId: input.grantId });
      return { revoked: Boolean(getRecord('core.relay.grant', input.grantId)?.revokedAt) };
    case 'stop': await stop(); return { stopped: true };
    default: throw new Error('UNKNOWN_TEST_OPERATION');
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
