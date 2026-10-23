import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';
import { startRelay } from '@bzzy/relay/server';
import { RelayClient, createIdentity, saveIdentity } from '../src/relay/sdk.js';
import { CoreRelayClient } from '../src/relay/client.js';
import { BzzyCore } from '../src/core.js';
import { runtimeInfo, runtimeRequest } from '../src/engine/runtime.js';
import { identityAlive } from '../src/engine/process-identity.js';
import { listRecords } from '../src/engine/database.js';

const sdk = pathToFileURL(createRequire(import.meta.url).resolve('@bzzy/relay'));
const { RelayStore } = await import(new URL('./store.js', sdk));
async function waitFor(check) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { if (await check()) return; await delay(25); }
  assert.fail('The private Relay facade fixture did not reach its expected state.');
}
async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'brc-'));
  const previous = process.env.BZZY_HOME; process.env.BZZY_HOME = path.join(directory, 'private');
  fs.mkdirSync(path.join(process.env.BZZY_HOME, 'relay'), { recursive: true, mode: 0o700 });
  const identity = createIdentity(), store = new RelayStore(); store.provisionHost(identity.certificate);
  const relay = await startRelay({ store, allowInsecureLocal: true });
  saveIdentity(path.join(process.env.BZZY_HOME, 'relay/host.identity.json'), identity);
  fs.writeFileSync(path.join(process.env.BZZY_HOME, 'relay/service.json'), JSON.stringify({ enabled: false, url: relay.audience, allowInsecureLocal: true }), { mode: 0o600 });
  const clients = [], core = new BzzyCore();
  const client = new CoreRelayClient(); clients.push(client); await client.start();
  t.after(async () => {
    await Promise.all(clients.map(value => value.close()));
    const info = runtimeInfo();
    if (info && identityAlive(info.identity)) await runtimeRequest(info, 'POST', '/shutdown', {}).catch(() => {});
    if (info) await waitFor(() => !identityAlive(info.identity));
    await relay.close(); store.close();
    if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, core, client, clients, relay, identity };
}

test('the same local Relay facade clears stale online/pairing state and rediscovers a restarted daemon with a new listener credential', { timeout: 20000 }, async t => {
  const f = await fixture(t), workspace = path.join(f.directory, 'project'); fs.mkdirSync(workspace);
  const session = f.core.createConversation({ provider: 'codex', cwd: workspace }, { requestId: randomUUID() });
  const invitation = await f.client.createPairing({ sessionId: session.id });
  const peer = new RelayClient({ identity: createIdentity(), url: f.relay.audience, allowInsecureLocal: true, autoReconnect: false }); f.clients.push(peer);
  await peer.connect(); await peer.claim(invitation.code);
  await waitFor(() => f.client.pendingPairings().length === 1);
  const old = runtimeInfo(), failed = once(f.client, 'fault', { signal: AbortSignal.timeout(10000) });
  await runtimeRequest(old, 'POST', '/shutdown', {}); await waitFor(() => !identityAlive(old.identity));
  fs.rmSync(path.join(process.env.BZZY_HOME, 'runtime/listener.json'));
  await f.core.start();
  assert.equal(runtimeInfo().token !== old.token, true, 'The disposable listener credential should rotate.');
  await failed;
  assert.equal(f.client.status().transport, 'offline'); assert.deepEqual(f.client.pendingPairings(), []); assert.deepEqual(f.client.grants(), []);
  await waitFor(() => f.client.status().transport === 'online');
  assert.notDeepEqual(runtimeInfo().identity, old.identity);
  assert.equal(listRecords('execution').length, 0);
});

test('closing a Relay view suppresses its in-flight status response while the daemon gateway remains online', { timeout: 10000 }, async t => {
  const f = await fixture(t), originalFetch = globalThis.fetch;
  let release, started, holding = true, statusEvents = 0;
  const blocked = new Promise(resolve => { started = resolve; }), gate = new Promise(resolve => { release = resolve; });
  globalThis.fetch = async (url, options) => {
    const response = await originalFetch(url, options);
    if (holding && String(url).endsWith('/v1/relay/status')) { holding = false; started(); await gate; }
    return response;
  };
  try {
    await blocked;
    f.client.on('status', () => statusEvents++);
    await f.client.close(); release(); await delay(100);
    assert.equal(statusEvents, 0); assert.equal(f.client.status().transport, 'offline'); assert.deepEqual(f.client.pendingPairings(), []);
    const managed = await runtimeRequest(runtimeInfo(), 'GET', '/v1/relay/status');
    assert.equal(managed.status.gateway, 'ready'); assert.equal(managed.status.transport, 'online');
  } finally { release(); globalThis.fetch = originalFetch; }
});

test('the managed Relay facade renders a local PNG while preserving its cached terminal QR', { timeout: 10000 }, async t => {
  const f = await fixture(t), workspace = path.join(f.directory, 'project'); fs.mkdirSync(workspace);
  const session = f.core.createConversation({ provider: 'codex', cwd: workspace }, { requestId: randomUUID() });
  const invitation = await f.client.createPairing({ sessionId: session.id });
  const terminal = await invitation.renderQR();
  assert.equal(typeof terminal, 'string'); assert.match(terminal, /\u001b\[/);
  assert.equal(await invitation.renderQR({ terminal: true }), terminal);
  const png = await invitation.renderQR({ terminal: false, format: 'png' });
  assert.ok(Buffer.isBuffer(png));
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.equal(png.toString('ascii', 12, 16), 'IHDR');
  assert.equal(png.readUInt32BE(16), png.readUInt32BE(20));
  assert.ok(png.readUInt32BE(16) >= 300);
  assert.match(invitation.qr, /^BZZY:INVITE:1:/);
  assert.match(await invitation.renderQR({ terminal: false }), /^<svg\s/);
  assert.equal(await invitation.renderQR(), terminal);
  assert.equal(f.client.pendingPairings().length, 0);
  assert.equal(f.client.grants().length, 0);
  assert.equal(listRecords('execution').length, 0);
  const originalNow = Date.now;
  try {
    Date.now = () => invitation.expiresAt;
    await assert.rejects(invitation.renderQR({ terminal: false, format: 'png' }), { code: 'INVITE_EXPIRED' });
  } finally { Date.now = originalNow; }
});

test('the managed Relay facade rejects a malformed QR payload before rendering a PNG', { timeout: 10000 }, async t => {
  const f = await fixture(t), workspace = path.join(f.directory, 'project'); fs.mkdirSync(workspace);
  const session = f.core.createConversation({ provider: 'codex', cwd: workspace }, { requestId: randomUUID() });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const response = await originalFetch(url, options);
    if (String(url).endsWith('/v1/relay/pair') && response.ok) {
      const value = await response.json();
      return Response.json({ ...value, qr: 'invalid invitation payload' });
    }
    return response;
  };
  try {
    const invitation = await f.client.createPairing({ sessionId: session.id });
    await assert.rejects(invitation.renderQR({ terminal: false, format: 'png' }), { code: 'INVALID_INVITATION' });
    assert.equal(typeof await invitation.renderQR(), 'string');
  } finally { globalThis.fetch = originalFetch; }
});
