import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { startRelay } from '@bzzy/relay/server';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { BzzyCore } from '../src/core.js';
import { CoreAgents } from '../src/agents.js';
import { CoreWorkspaces } from '../src/workspaces.js';
import { RelayGateway, importTerminalShare } from '../src/relay/index.js';
import { RelayClient, createIdentity } from '../src/relay/sdk.js';
import { ProjectTransferService, importProjectShare } from '../src/relay/project-transfer.js';
import { appendEvent, events, getRecord, putRecord, listRecords } from '../src/engine/database.js';
import { runtimeInfo, runtimeRequest } from '../src/engine/runtime.js';
import { identityAlive } from '../src/engine/process-identity.js';

const sdk = pathToFileURL(createRequire(import.meta.url).resolve('@bzzy/relay'));
const { RelayStore } = await import(new URL('./store.js', sdk));
async function waitFor(check) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(25); }
  assert.fail('Expected local transfer state was not reached.');
}
async function fixture(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-project-transfer-')));
  const previous = process.env.BZZY_HOME; process.env.BZZY_HOME = path.join(directory, 'private'); fs.mkdirSync(process.env.BZZY_HOME, { mode: 0o700 });
  const source = path.join(directory, 'source'), recipient = path.join(directory, 'recipient'); fs.mkdirSync(source); fs.mkdirSync(recipient);
  const store = new RelayStore(), host = createIdentity(), audit = [], wire = [];
  // Provisioning tools may reorder certificate keys; signatures/identity do not.
  store.provisionHost(Object.fromEntries(Object.entries(host.certificate).sort(([a], [b]) => a.localeCompare(b))));
  const relay = await startRelay({ store, allowInsecureLocal: true, audit: event => audit.push(event) });
  let hostClient;
  const gateway = new RelayGateway({ identity: host, url: relay.audience, allowInsecureLocal: true, autoReconnect: false, clientFactory: options => {
    const client = new RelayClient(options);
    hostClient = client;
    client.on('status', status => {
      if (status !== 'online') return;
      const send = client.ws.send.bind(client.ws); client.ws.send = (frame, ...args) => { wire.push(String(frame)); return send(frame, ...args); };
    });
    return client;
  } });
  await gateway.start();
  const core = new BzzyCore(), session = core.createConversation({ provider: 'codex', cwd: source, model: 'fixture-share-model' }, { requestId: randomUUID() });
  t.after(async () => {
    await gateway.close();
    const info = runtimeInfo();
    if (info && identityAlive(info.identity)) await runtimeRequest(info, 'POST', '/shutdown', {}).catch(() => {});
    for (let count = 0; info && identityAlive(info.identity) && count < 100; count++) await delay(20);
    await relay.close(); store.close();
    if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, source, recipient, store, host, relay, gateway, core, session, audit, wire, hostClient };
}

test('an actual encrypted Relay ZIP transfer imports project files and durable history into recipient cwd inactive', async t => {
  const f = await fixture(t), raw = '<message version="1"><p><b>Shared source history</b></p></message>';
  const marker = 'PRIVATE_PROJECT_TRANSFER_MARKER_391843';
  fs.writeFileSync(path.join(f.source, 'README.txt'), marker + '\n' + 'Project source.\n'.repeat(4000));
  fs.writeFileSync(path.join(f.source, 'asset.bin'), randomBytes(64 * 1024));
  fs.mkdirSync(path.join(f.source, '.bzzy')); fs.writeFileSync(path.join(f.source, '.bzzy/notes.txt'), 'Approved project context.');
  appendEvent(f.session.id, 'message.user', { text: 'Source project instruction.' }); appendEvent(f.session.id, 'text', { text: raw, itemId: 'source-message' });
  const share = await f.gateway.createProjectShare({ sessionId: f.session.id });
  assert.match(share.code, /^BZZY-TERMINAL-/); assert.match(share.qr, /^BZZY:INVITE:1:/); assert.ok(share.terminalQR.length > 0);
  const originalSend = RelayClient.prototype.send; let delayedFirstRequest = false;
  RelayClient.prototype.send = async function (grantId, payload, options) {
    if (!delayedFirstRequest && payload?.protocol === 'bzzy-project-transfer' && payload.op === 'chunk' && payload.params.offset === 0) {
      delayedFirstRequest = true; await delay(90);
    }
    return originalSend.call(this, grantId, payload, options);
  };
  t.after(() => { RelayClient.prototype.send = originalSend; });
  let recipientFingerprint; const progress = [];
  const download = importTerminalShare({ code: share.qr, cwd: f.recipient, expectedSenderFingerprint: f.host.certificate.id,
    url: f.relay.audience, allowInsecureLocal: true, onIdentity: value => { recipientFingerprint = value.recipientFingerprint; },
    onProgress: value => progress.push(value) });
  const pending = await waitFor(() => f.gateway.projectShareStatus(share.shareId).pending[0]);
  assert.equal(pending.fingerprint, recipientFingerprint);
  await assert.rejects(f.gateway.approveProjectShare({ shareId: share.shareId, claimId: pending.claimId, confirmedFingerprint: createIdentity().certificate.id }), { code: 'CONFIRMATION_REQUIRED' });
  await f.gateway.approveProjectShare({ shareId: share.shareId, claimId: pending.claimId, confirmedFingerprint: recipientFingerprint });
  const imported = await download;
  assert.equal(imported.cwd, f.recipient); assert.ok(imported.primarySession); assert.notEqual(imported.primarySession.id, f.session.id);
  assert.equal(imported.primarySession.cwd, f.recipient); assert.equal(imported.primarySession.executionState, 'idle');
  assert.equal(imported.primarySession.importedUntrusted, true);
  assert.equal(fs.readFileSync(path.join(f.recipient, 'README.txt'), 'utf8'), fs.readFileSync(path.join(f.source, 'README.txt'), 'utf8'));
  assert.equal(fs.readFileSync(path.join(f.recipient, '.bzzy/notes.txt'), 'utf8'), 'Approved project context.');
  assert.ok(events(imported.primarySession.id).some(event => event.type === 'text' && event.data.text === raw));
  assert.equal(listRecords('execution').length, 0); assert.equal(f.gateway.projectShareStatus(share.shareId).state, 'complete');
  assert.equal(progress.at(-1).received, share.bytes);
  assert.ok(progress.length > 3, 'The real ZIP crossed multiple bounded encrypted chunks');
  assert.equal(delayedFirstRequest, true, 'Variable request latency must not bypass response-based chunk pacing');
  assert.ok(!f.wire.join('\n').includes(marker)); assert.ok(!JSON.stringify(f.audit).includes(marker));
  assert.ok(!JSON.stringify(f.audit).includes(share.code));
  assert.equal(fs.existsSync(path.join(process.env.BZZY_HOME, 'relay/shares', share.shareId, 'project.zip')), false);
});

test('import requires a trusted source fingerprint and cancellation never executes or materializes source files', async t => {
  const f = await fixture(t); fs.writeFileSync(path.join(f.source, 'file.txt'), 'Source project');
  const share = await f.gateway.createProjectShare({ sessionId: f.session.id });
  await assert.rejects(importTerminalShare({ code: share.code, cwd: f.recipient, onIdentity() {} }), { code: 'CONFIRMATION_REQUIRED' });
  const controller = new AbortController();
  const importing = importTerminalShare({ code: share.code, cwd: f.recipient, expectedSenderFingerprint: f.host.certificate.id,
    url: f.relay.audience, allowInsecureLocal: true, signal: controller.signal, onIdentity() {} });
  await waitFor(() => f.gateway.projectShareStatus(share.shareId).pending.length); controller.abort();
  await assert.rejects(importing);
  assert.deepEqual(fs.readdirSync(f.recipient), []); assert.equal(listRecords('execution').length, 0);
  await f.gateway.revokeProjectShare(share.shareId);
  assert.equal(f.gateway.projectShareStatus(share.shareId).state, 'revoked');
});

test('expired project codes remove their private prepared ZIP', async t => {
  const f = await fixture(t); fs.writeFileSync(path.join(f.source, 'file.txt'), 'Source project');
  const share = await f.gateway.createProjectShare({ sessionId: f.session.id, ttlSeconds: 1 });
  await waitFor(() => f.gateway.projectShareStatus(share.shareId).state === 'expired');
  assert.equal(fs.existsSync(path.join(process.env.BZZY_HOME, 'relay/shares', share.shareId)), false);
  assert.equal(getRecord('session', f.session.id).cwd, f.source);
});

test('a corrupted chunk fails the complete ZIP hash before any recipient project file is extracted', async t => {
  const f = await fixture(t); fs.writeFileSync(path.join(f.source, 'asset.bin'), randomBytes(40 * 1024));
  const share = await f.gateway.createProjectShare({ sessionId: f.session.id });
  const send = f.hostClient.send.bind(f.hostClient); let corrupted = false;
  f.hostClient.send = (grant, payload, options) => {
    if (!corrupted && payload?.protocol === 'bzzy-project-transfer' && payload.result?.offset === 0) {
      const bytes = Buffer.from(payload.result.data, 'base64url'); bytes[0] ^= 1;
      payload = { ...payload, result: { ...payload.result, data: bytes.toString('base64url') } }; corrupted = true;
    }
    return send(grant, payload, options);
  };
  let recipientFingerprint;
  const downloading = importTerminalShare({ code: share.code, cwd: f.recipient, expectedSenderFingerprint: f.host.certificate.id,
    url: f.relay.audience, allowInsecureLocal: true, onIdentity: value => { recipientFingerprint = value.recipientFingerprint; } });
  const pending = await waitFor(() => f.gateway.projectShareStatus(share.shareId).pending[0]);
  await f.gateway.approveProjectShare({ shareId: share.shareId, claimId: pending.claimId, confirmedFingerprint: recipientFingerprint });
  await assert.rejects(downloading, { code: 'FORBIDDEN' });
  assert.equal(corrupted, true); assert.deepEqual(fs.readdirSync(f.recipient), []); assert.equal(listRecords('execution').length, 0);
  await f.gateway.revokeProjectShare(share.shareId);
});

test('encrypted Agent archives require injected registry authority and cannot be imported as Terminals', async t => {
  const f = await fixture(t);
  new CoreWorkspaces().configure({ path: path.join(f.directory, 'managed'), create: true }, { requestId: randomUUID(), expectedRevision: 0 });
  const agents = new CoreAgents(), agent = agents.create({ name: 'Portable agent', instructions: 'Preserve the complete approved mission.', provider: 'codex', model: 'source-agent-model', effort: 'default' }, { requestId: randomUUID() });
  const raw = '<message version="1"><p><b>Agent history</b></p></message>';
  fs.mkdirSync(path.join(agent.cwd, '.bzzy')); fs.writeFileSync(path.join(agent.cwd, '.bzzy/notes.txt'), 'Preserved Agent mission notes.');
  fs.writeFileSync(path.join(agent.cwd, 'asset.bin'), randomBytes(48 * 1024));
  appendEvent(agent.sessionId, 'text', { text: raw });
  const service = new ProjectTransferService({ client: f.hostClient });
  f.hostClient.route = RelayClient.prototype.route.bind(f.hostClient);
  const claim = data => service.handleClaim(data), receive = data => { void service.handleMessage(data); };
  f.hostClient.on('invite.requested', claim); f.hostClient.on('message', receive);
  let imports = 0, authorized = true;
  const options = { authorize: () => {
    if (!authorized) throw Object.assign(Error('Denied.'), { code: 'FORBIDDEN' });
    agents.forSession(agent.sessionId);
  }, exportArchive: (session, file) => agents.exportArchive(session.id, file) };
  try {
    await assert.rejects(service.createShare({ sessionId: f.session.id, kind: 'AGENT' }, options), { code: 'FORBIDDEN' });
    await assert.rejects(service.createShare({ sessionId: agent.sessionId, kind: 'AGENT' }), { code: 'OPERATION_DENIED' });
    const share = await service.createShare({ sessionId: agent.sessionId, kind: 'AGENT' }, options);
    assert.equal(share.kind, 'AGENT'); assert.match(share.code, /^BZZY-AGENT-/);
    await assert.rejects(importTerminalShare({ code: share.qr, cwd: f.recipient, expectedSenderFingerprint: f.host.certificate.id,
      url: f.relay.audience, allowInsecureLocal: true, onIdentity() {} }), { code: 'INVALID_REQUEST' });
    let fingerprint;
    const downloading = importProjectShare({ expectedKind: 'AGENT', code: share.qr, cwd: f.recipient,
      expectedSenderFingerprint: f.host.certificate.id, url: f.relay.audience, allowInsecureLocal: true,
      onIdentity: value => { fingerprint = value.recipientFingerprint; }, importArchive: async (file, cwd) => {
        imports++; assert.equal(cwd, f.recipient);
        return agents.importArchive(file, { name: 'Received agent', provider: 'codex', model: 'recipient-agent-model', effort: 'default' }, { importId: randomUUID() });
      } });
    const pending = await waitFor(() => service.status(share.shareId).pending[0]);
    await service.approveShare({ shareId: share.shareId, claimId: pending.claimId, confirmedFingerprint: fingerprint });
    const received = await downloading; assert.equal(imports, 1);
    assert.notEqual(received.id, agent.id); assert.notEqual(received.sessionId, agent.sessionId);
    assert.equal(received.instructions, agent.instructions); assert.equal(received.model, 'recipient-agent-model');
    assert.equal(fs.readFileSync(path.join(received.cwd, '.bzzy/notes.txt'), 'utf8'), 'Preserved Agent mission notes.');
    assert.deepEqual(fs.readFileSync(path.join(received.cwd, 'asset.bin')), fs.readFileSync(path.join(agent.cwd, 'asset.bin')));
    assert.ok(events(received.sessionId).some(event => event.type === 'text' && event.data.text === raw));
    assert.equal(listRecords('execution').length, 0);
    authorized = false;
    assert.throws(() => service.status(share.shareId), { code: 'FORBIDDEN' });
  } finally { f.hostClient.off('invite.requested', claim); f.hostClient.off('message', receive); await service.close(); }
});

test('a mismatched Agent transfer manifest is rejected before the archive importer or materialization', async t => {
  const f = await fixture(t), agentId = randomUUID();
  putRecord('session', f.session.id, { ...getRecord('session', f.session.id), purpose: 'agent', agentId });
  const service = new ProjectTransferService({ client: f.hostClient });
  f.hostClient.route = RelayClient.prototype.route.bind(f.hostClient);
  const claim = data => service.handleClaim(data), receive = data => { void service.handleMessage(data); };
  f.hostClient.on('invite.requested', claim); f.hostClient.on('message', receive);
  const send = f.hostClient.send.bind(f.hostClient); let imports = 0;
  f.hostClient.send = (grant, payload, options) => {
    if (payload?.protocol === 'bzzy-project-transfer' && payload.result?.format === 'bzzy-project-zip') payload = { ...payload, result: { ...payload.result, kind: 'TERMINAL' } };
    return send(grant, payload, options);
  };
  try {
    const share = await service.createShare({ sessionId: f.session.id, kind: 'AGENT' }, {
      authorize() {}, exportArchive: async (_session, file) => { fs.writeFileSync(file, 'opaque archive fixture'); return {}; } });
    let fingerprint;
    const downloading = importProjectShare({ expectedKind: 'AGENT', code: share.code, cwd: f.recipient, expectedSenderFingerprint: f.host.certificate.id,
      url: f.relay.audience, allowInsecureLocal: true, onIdentity: value => { fingerprint = value.recipientFingerprint; }, importArchive: async () => { imports++; } });
    const pending = await waitFor(() => service.status(share.shareId).pending[0]);
    await service.approveShare({ shareId: share.shareId, claimId: pending.claimId, confirmedFingerprint: fingerprint });
    await assert.rejects(downloading, { code: 'INVALID_REQUEST' });
    assert.equal(imports, 0); assert.deepEqual(fs.readdirSync(f.recipient), []);
  } finally { f.hostClient.off('invite.requested', claim); f.hostClient.off('message', receive); await service.close(); }
});
