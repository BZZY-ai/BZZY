import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { startRelay } from '@bzzy/relay/server';
import { RelayGateway, initializeRelayIdentity, loadRelayIdentity, revokeLocalRelayGrant } from '../src/relay/index.js';
import { RelayClient, createIdentity } from '../src/relay/sdk.js';
import { BzzyCore } from '../src/core.js';
import { CoreAssistant } from '../src/assistant.js';
import { CoreWorkspaces } from '../src/workspaces.js';
import { getRecord, listRecords, putRecord, appendEvent, digest } from '../src/engine.js';
import { runtimeInfo, runtimeRequest } from '../src/engine/runtime.js';
import { identityAlive } from '../src/engine/process-identity.js';
import { prepareTask } from '../src/engine/task.js';
import { newGoal } from '../src/engine/goals.js';

const sdk = pathToFileURL(createRequire(import.meta.url).resolve('@bzzy/relay'));
const { RelayStore } = await import(new URL('./store.js', sdk));
const coreRoot = fileURLToPath(new URL('../', import.meta.url));
const next = (emitter, event) => once(emitter, event, { signal: AbortSignal.timeout(6000) }).then(([value]) => value);
const controls = ['observe', 'claim', 'takeover', 'execute', 'answer', 'pause', 'cancel', 'steer'];

async function waitFor(check) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(25); }
  assert.fail('Expected fixture state was not reached.');
}
async function fixture(t, { provisioned = true, subscriptionLeaseMs = 60000 } = {}) {
  const directory = fs.mkdtempSync(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'bg-'));
  const keys = ['BZZY_HOME', 'BZZY_CODEX_BIN', 'BZZY_CODEX_HOME'], previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { BZZY_HOME: path.join(directory, 'private'), BZZY_CODEX_HOME: path.join(directory, 'codex'), BZZY_CODEX_BIN: path.join(coreRoot, 'test/fixtures/codex.mjs') });
  fs.mkdirSync(process.env.BZZY_HOME, { mode: 0o700 });
  // This offline CLI fixture reports a subscription login. Its synthetic auth
  // file lets Core pin the same private login reference in the isolated home.
  fs.mkdirSync(process.env.BZZY_CODEX_HOME, { mode: 0o700 });
  fs.writeFileSync(path.join(process.env.BZZY_CODEX_HOME, 'auth.json'), '{"fixture":true}', { mode: 0o600 });
  const workspace = path.join(directory, 'project'); fs.mkdirSync(workspace);
  const store = new RelayStore(), host = createIdentity(), relayAudit = [];
  if (provisioned) store.provisionHost(host.certificate);
  const relay = await startRelay({ store, allowInsecureLocal: true, audit: event => relayAudit.push(event) });
  const clients = [], wire = [], context = { directory, workspace, store, relay, host, clients, wire, relayAudit, core: new BzzyCore() };
  context.makeGateway = () => new RelayGateway({ identity: host, url: relay.audience, allowInsecureLocal: true, autoReconnect: false,
    pollIntervalMs: 100, subscriptionLeaseMs, requestTimeoutMs: 2000, clientFactory: options => {
      const client = new RelayClient(options);
      context.hostClient = client;
      client.on('status', status => {
        if (status !== 'online') return;
        const send = client.ws.send.bind(client.ws);
        client.ws.send = (data, ...rest) => { wire.push(String(data)); return send(data, ...rest); };
      });
      return client;
    } });
  context.gateway = context.makeGateway();
  context.createSession = () => context.core.createConversation({ provider: 'codex', cwd: workspace }, { requestId: randomUUID() });
  context.newPeer = async () => {
    const peer = new RelayClient({ identity: createIdentity(), url: relay.audience, allowInsecureLocal: true, autoReconnect: false, requestTimeoutMs: 2000 });
    clients.push(peer); await peer.connect(); return peer;
  };
  context.pair = async (sessionId, permissions = ['observe'], peer, options = {}) => {
    peer ||= await context.newPeer();
    const invitation = await context.gateway.createPairing({ sessionId, permissions, ...options });
    const waiting = next(context.gateway, 'pairing.requested');
    const claimed = await peer.claim(invitation.code), requested = await waiting;
    const local = await context.gateway.approvePairing({ claimId: claimed.claimId, confirmedCertificate: peer.identity.certificate, confirmedFingerprint: peer.identity.certificate.id });
    peer.trustPeer(host.certificate);
    return { peer, local, invitation, requested };
  };
  context.rpc = async (paired, op, params = {}, { id = randomUUID(), resource = paired.local.resource, extra = {} } = {}) => {
    const incoming = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { paired.peer.removeListener('message', listener); reject(new Error('Fixture Core response timed out.')); }, 6000);
      const listener = message => {
        if (message.payload.type !== 'response' || message.payload.id !== id) return;
        clearTimeout(timer); paired.peer.removeListener('message', listener); resolve(message.payload);
      };
      paired.peer.on('message', listener);
    });
    await paired.peer.send(paired.local.id, { v: 1, protocol: 'bzzy-core', type: 'request', id, resource, op, params, ...extra });
    return incoming;
  };
  t.after(async () => {
    await context.gateway.close();
    await Promise.all(clients.map(client => client.close()));
    await relay.close(); store.close();
    const info = runtimeInfo();
    if (info && identityAlive(info.identity)) await runtimeRequest(info, 'POST', '/shutdown', {}).catch(() => {});
    for (let attempt = 0; info && identityAlive(info.identity) && attempt < 100; attempt++) await delay(20);
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  if (provisioned) await context.gateway.start();
  return context;
}

test('an unprovisioned host cannot become a gateway or start an execution', async t => {
  const f = await fixture(t, { provisioned: false });
  await assert.rejects(f.gateway.start(), { code: 'HOST_ENROLLMENT_REQUIRED' });
  assert.equal(f.gateway.status().gateway, 'stopped'); assert.equal(listRecords('execution').length, 0);
});

test('private identity setup is exclusive, persistent and never returns secret keys', async t => {
  const f = await fixture(t);
  const first = initializeRelayIdentity(), second = initializeRelayIdentity();
  assert.deepEqual(first, second); assert.equal(first.signingSecret, undefined); assert.equal(first.boxSecret, undefined);
  assert.equal(loadRelayIdentity().certificate.id, first.id);
  assert.equal(fs.statSync(path.join(process.env.BZZY_HOME, 'relay/host.identity.json')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(process.env.BZZY_HOME, 'relay')).mode & 0o777, 0o700);
  assert.equal(f.gateway.status().activeGrants, 0);
});

test('explicit Agent sharing/import remains base-device scoped and restores full context without executing', async t => {
  const f = await fixture(t), terminal = f.createSession();
  new CoreWorkspaces().configure({ path: path.join(f.directory, 'BZZY'), create: true }, { requestId: randomUUID(), expectedRevision: 0 });
  const manage = await f.pair(terminal.id, ['observe'], undefined, { agentAccess: true });
  const input = { name: 'Portable helper', instructions: 'Preserve notes and use recipient accounts only.', provider: 'codex', model: 'source-model', effort: 'default' };
  const created = await f.rpc(manage, 'agents.create', input), agent = created.result.agent;
  fs.mkdirSync(path.join(agent.cwd, '.bzzy')); fs.writeFileSync(path.join(agent.cwd, '.bzzy/notes.txt'), 'ALL portable notes.');
  const raw = '<message version="1"><p>ALL Agent chat.</p></message>'; appendEvent(agent.sessionId, 'text', { text: raw });
  const noShare = (await f.rpc(manage, 'agents.open', { agentId: agent.id })).result;
  assert.equal((await f.rpc(manage, 'share.create', {}, { resource: noShare.resource })).error.code, 'FORBIDDEN');
  const paired = await f.pair(terminal.id, ['observe'], undefined, { agentAccess: true, shareAccess: true });
  const child = (await f.rpc(paired, 'agents.open', { agentId: agent.id })).result;
  const snapshot = (await f.rpc(paired, 'session.get', {}, { resource: child.resource })).result;
  assert.equal(snapshot.capabilities.shareAccess, true); assert.equal(snapshot.capabilities.shareKind, 'AGENT');
  const share = (await f.rpc(paired, 'share.create', {}, { resource: child.resource })).result;
  assert.equal(share.kind, 'AGENT'); assert.match(share.code, /^BZZY-AGENT-/);
  const receive = { code: share.qr, expectedSenderFingerprint: f.host.certificate.id, provider: 'claude', model: 'recipient-model', effort: 'default' };
  const narrow = await f.pair(terminal.id);
  assert.equal((await f.rpc(narrow, 'agents.import', receive)).error.code, 'FORBIDDEN');
  assert.equal((await f.rpc(paired, 'agents.import', receive, { resource: child.resource })).error.code, 'FORBIDDEN');
  const id = randomUUID(), started = await f.rpc(paired, 'agents.import', receive, { id });
  assert.equal(started.ok, true); assert.equal(started.result.state, 'accepted');
  const importId = started.result.importId;
  assert.equal((await f.rpc(paired, 'agents.import', receive, { id })).result.importId, importId);
  assert.equal((await f.rpc(manage, 'agents.import.status', { importId })).error.code, 'FORBIDDEN');
  const status = await waitFor(async () => {
    const response = await f.rpc(paired, 'agents.import.status', { importId });
    return response.result?.state === 'awaitingApproval' && response.result;
  });
  const pending = await waitFor(async () => (await f.rpc(paired, 'share.status', { shareId: share.shareId }, { resource: child.resource })).result?.pending[0]);
  assert.equal(pending.fingerprint, status.recipientFingerprint);
  assert.equal((await f.rpc(paired, 'share.approve', { shareId: share.shareId, claimId: pending.claimId,
    confirmedFingerprint: status.recipientFingerprint }, { resource: child.resource })).ok, true);
  const complete = await waitFor(async () => {
    const response = await f.rpc(paired, 'agents.import.status', { importId });
    if (response.result?.state === 'failed') assert.fail(`Agent fixture failed: ${response.result.errorCode}`);
    return response.result?.state === 'complete' && response.result;
  });
  assert.equal(complete.agent.provider, 'claude'); assert.equal(complete.agent.model, 'recipient-model');
  assert.equal(complete.agent.importId, importId); assert.notEqual(complete.agent.sessionId, agent.sessionId);
  assert.equal(fs.readFileSync(path.join(complete.agent.cwd, '.bzzy/notes.txt'), 'utf8'), 'ALL portable notes.');
  assert.ok(listRecords('core.agent').some(row => row.id === complete.agent.id));
  assert.equal(listRecords('execution').length, 0);
  assert.ok(!JSON.stringify(listRecords('core.relay.command')).includes(share.code));
  assert.ok(!JSON.stringify(f.relayAudit).includes(share.code));
});

test('pairing needs the independently confirmed exact recipient and local scope', async t => {
  const f = await fixture(t), session = f.createSession(), peer = await f.newPeer();
  const invitation = await f.gateway.createPairing({ sessionId: session.id });
  assert.match(invitation.qr, /^BZZY:INVITE:1:/);
  assert.doesNotMatch(JSON.stringify(listRecords('core.relay.pairing')), new RegExp(invitation.code));
  const waiting = next(f.gateway, 'pairing.requested'), claim = await peer.claim(invitation.code); await waiting;
  await assert.rejects(f.gateway.approvePairing({ claimId: claim.claimId, confirmedCertificate: peer.identity.certificate, confirmedFingerprint: 'wrong' }), { code: 'CONFIRMATION_REQUIRED' });
  const wrong = createIdentity().certificate;
  await assert.rejects(f.gateway.approvePairing({ claimId: claim.claimId, confirmedCertificate: wrong, confirmedFingerprint: wrong.id }), { code: 'FORBIDDEN' });
  assert.equal(f.gateway.grants().length, 0);
  const local = await f.gateway.approvePairing({ claimId: claim.claimId, confirmedCertificate: peer.identity.certificate, confirmedFingerprint: peer.identity.certificate.id });
  assert.deepEqual(local.permissions, ['observe']); assert.equal(local.sessionId, session.id); assert.equal(local.token, undefined);
  const privateGrant = getRecord('core.relay.grant', local.id), coreGrant = getRecord('access-token', digest(privateGrant.token));
  assert.equal(coreGrant.includeChildren, false); assert.equal(coreGrant.recipient, `relay_${peer.identity.certificate.id}`);
  assert.equal(listRecords('execution').length, 0);
});

test('a paired observer reads the existing session but cannot cross scope or gain control', async t => {
  const f = await fixture(t), session = f.createSession(), other = f.createSession(), paired = await f.pair(session.id);
  const read = await f.rpc(paired, 'session.get');
  assert.equal(read.ok, true); assert.equal(read.result.session.id, session.id); assert.equal(read.result.session.cwd, fs.realpathSync(f.workspace));
  assert.equal(read.result.capabilities.relay, true); assert.equal(read.result.capabilities.portableSharing, false);
  for (const op of ['input.claim', 'execution.execute', 'question.answer', 'control.request']) {
    const params = op === 'control.request' ? { owner: 'phone', action: 'pause' } : op === 'execution.execute' ? { owner: 'phone', prompt: 'Forbidden' } : op === 'question.answer' ? { owner: 'phone', questionId: randomUUID(), answer: 'No' } : { owner: 'phone' };
    assert.equal((await f.rpc(paired, op, params)).error.code, 'FORBIDDEN');
  }
  assert.equal((await f.rpc(paired, 'session.get', {}, { resource: other.id })).error.code, 'FORBIDDEN');
  assert.equal(listRecords('execution').length, 0);
});

test('a live Relay cannot report Core ready or mutate resources after the local operator stopped Core', async t => {
  const f = await fixture(t), session = f.createSession(), paired = await f.pair(session.id, controls, undefined, { agentAccess: true });
  const info = runtimeInfo();
  await runtimeRequest(info, 'POST', '/v1/operator-stop', { shutdown: false });
  for (const [op, params] of [['session.get', {}], ['host.metrics', {}], ['agents.status', {}], ['input.claim', { owner: 'stopped-phone' }]]) {
    assert.equal((await f.rpc(paired, op, params)).error.code, 'CORE_STOPPED');
  }
  await runtimeRequest(info, 'POST', '/shutdown', {});
  await waitFor(() => !identityAlive(info.identity));
  assert.equal((await f.rpc(paired, 'host.metrics')).error.code, 'CORE_STOPPED');
  assert.equal(runtimeInfo(), null); assert.equal(listRecords('execution').length, 0);
});

test('encrypted metrics and actual event acknowledgments have bounded separate budgets without widening command limits', { timeout: 30000 }, async t => {
  const f = await fixture(t), session = f.createSession(), paired = await f.pair(session.id);
  const batches = [], waiters = [];
  paired.peer.on('message', message => {
    if (message.payload.type !== 'events') return;
    if (waiters.length) waiters.shift()(message.payload); else batches.push(message.payload);
  });
  const subscribed = await f.rpc(paired, 'events.subscribe', { consumerId: 'metrics-stream' });
  let cursor = 0;
  for (let index = 0; index < 65; index++) {
    if (index < 30) {
      const metrics = await f.rpc(paired, 'host.metrics');
      assert.equal(metrics.ok, true); assert.equal(metrics.result.version, 1);
      assert.ok(metrics.result.host.memory.totalBytes > 0);
      assert.doesNotMatch(JSON.stringify(metrics.result), /pid|hostname|token|path|identity/i);
    }
    if (index < 59) assert.equal((await f.rpc(paired, 'session.usage')).ok, true);
    const incoming = batches.length ? Promise.resolve(batches.shift()) : new Promise(resolve => waiters.push(resolve));
    appendEvent(session.id, 'fixture.metrics.stream', { index });
    const batch = await incoming; cursor = batch.nextCursor;
    assert.equal((await f.rpc(paired, 'events.ack', { subscriptionId: subscribed.result.subscriptionId, seq: cursor })).ok, true);
  }
  assert.equal((await f.rpc(paired, 'session.usage')).error.code, 'RATE_LIMITED');
  assert.equal((await f.rpc(paired, 'host.metrics')).error.code, 'RATE_LIMITED');
  assert.equal((await f.rpc(paired, 'events.ack', { subscriptionId: subscribed.result.subscriptionId, seq: cursor })).ok, true);
  assert.equal((await f.rpc(paired, 'events.ack', { subscriptionId: randomUUID(), seq: cursor })).error.code, 'RATE_LIMITED');
  assert.equal(listRecords('execution').length, 0);
  await f.gateway.revokeGrant(paired.local.id);
  await assert.rejects(paired.peer.send(paired.local.id, { v: 1, protocol: 'bzzy-core', type: 'request', id: randomUUID(), resource: paired.local.resource, op: 'host.metrics', params: {} }), { code: 'GRANT_UNAVAILABLE' });
});

test('session-only grants cannot discover or open any other terminal', async t => {
  const f = await fixture(t), first = f.createSession(), other = f.createSession(), paired = await f.pair(first.id, controls);
  assert.equal(paired.invitation.sessionAccess, false); assert.equal(paired.requested.sessionAccess, false);
  assert.equal((await f.rpc(paired, 'session.get')).result.capabilities.sessionAccess, false);
  assert.equal((await f.rpc(paired, 'sessions.list')).error.code, 'FORBIDDEN');
  assert.equal((await f.rpc(paired, 'sessions.open', { sessionId: other.id })).error.code, 'FORBIDDEN');
  assert.equal(listRecords('core.relay.context').length, 0); assert.equal(listRecords('execution').length, 0);
});

test('project sharing needs an independent grant and its codes never enter the durable journal', async t => {
  const f = await fixture(t), first = f.createSession(), other = f.createSession();
  fs.writeFileSync(path.join(f.workspace, 'project.txt'), 'Approved project context');
  const control = await f.pair(first.id, controls);
  assert.equal((await f.rpc(control, 'share.create')).error.code, 'FORBIDDEN');
  assert.equal((await f.rpc(control, 'session.get')).result.capabilities.shareAccess, false);
  const sharing = await f.pair(first.id, ['observe'], undefined, { shareAccess: true });
  assert.equal(sharing.invitation.shareAccess, true); assert.equal(sharing.requested.shareAccess, true); assert.equal(sharing.local.shareAccess, true);
  const id = randomUUID(), created = await f.rpc(sharing, 'share.create', {}, { id });
  assert.equal(created.ok, true); assert.equal(created.result.state, 'accepted'); assert.match(created.result.code, /^BZZY-TERMINAL-/);
  const repeat = await f.rpc(sharing, 'share.create', {}, { id }); assert.equal(repeat.result.code, created.result.code);
  assert.equal((await f.rpc(sharing, 'command.status', { requestId: id })).result.acceptance.shareId, created.result.shareId);
  const elsewhere = await f.pair(other.id, ['observe'], sharing.peer, { shareAccess: true });
  assert.equal((await f.rpc(elsewhere, 'share.status', { shareId: created.result.shareId })).error.code, 'FORBIDDEN');
  assert.equal((await f.rpc(elsewhere, 'share.revoke', { shareId: created.result.shareId })).error.code, 'FORBIDDEN');
  assert.ok(!JSON.stringify(listRecords('core.relay.command')).includes(created.result.code));
  assert.ok(!JSON.stringify((await f.core.events(first.id)).events).includes(created.result.code));
  assert.equal((await f.rpc(sharing, 'share.revoke', { shareId: created.result.shareId })).result.revoked, true);
  assert.equal((await f.rpc(sharing, 'share.status', { shareId: created.result.shareId })).result.state, 'revoked');
  assert.equal(listRecords('execution').length, 0);
});

test('agent management is independently approved and its native chat uses a distinct authorized Core context', async t => {
  const f = await fixture(t), terminal = f.createSession(), ordinary = await f.pair(terminal.id, controls);
  for (const op of ['agents.status', 'agents.providers', 'agents.list']) assert.equal((await f.rpc(ordinary, op)).error.code, 'FORBIDDEN');
  const paired = await f.pair(terminal.id, controls, undefined, { agentAccess: true });
  assert.equal(paired.requested.agentAccess, true); assert.equal(paired.local.agentAccess, true);
  assert.equal((await f.rpc(paired, 'agents.status')).result.configured, false);
  const id = randomUUID(), input = { name: 'Project helper', instructions: 'Explain the approved local project.', provider: 'codex', model: 'fixture-model' };
  assert.equal((await f.rpc(paired, 'agents.create', input, { id })).error.code, 'WORKSPACE_SETUP_REQUIRED');
  assert.equal((await f.rpc(paired, 'command.status', { requestId: id })).result.state, 'rejected');
  const workspaces = new CoreWorkspaces(); workspaces.configure({ path: path.join(f.directory, 'managed'), create: true }, { requestId: randomUUID(), expectedRevision: 0 });
  const providers = (await f.rpc(paired, 'agents.providers')).result.providers; assert.ok(providers.some(provider => provider.id === 'codex'));
  const createID = randomUUID(), created = await f.rpc(paired, 'agents.create', input, { id: createID });
  assert.equal(created.ok, true); assert.equal(created.result.state, 'accepted');
  const agent = created.result.agent;
  assert.ok(agent.cwd.startsWith(fs.realpathSync(path.join(f.directory, 'managed')) + '/Agents/'));
  assert.equal((await f.rpc(paired, 'agents.create', input, { id: createID })).result.agent.id, agent.id);
  assert.equal(listRecords('core.agent').length, 1); assert.equal(listRecords('execution').length, 0);
  const command = listRecords('core.relay.command').find(value => value.op === 'agents.create' && value.state === 'accepted');
  putRecord('core.relay.command', command.id, { ...command, state: 'uncertain', result: undefined });
  assert.equal((await f.rpc(paired, 'command.status', { requestId: createID })).result.acceptance.agent.id, agent.id);
  assert.equal((await f.rpc(paired, 'agents.get', { agentId: agent.id })).result.agent.instructions, input.instructions);
  const opened = (await f.rpc(paired, 'agents.open', { agentId: agent.id })).result;
  assert.equal(opened.kind, 'agent'); assert.equal(opened.sessionId, agent.sessionId); assert.notEqual(opened.resource, paired.local.resource);
  assert.equal((await f.rpc(paired, 'agents.open', { agentId: agent.id })).result.resource, opened.resource);
  const selected = (await f.rpc(paired, 'session.get', {}, { resource: opened.resource })).result;
  assert.equal(selected.session.id, agent.sessionId); assert.equal(selected.capabilities.agentAccess, false);
  assert.equal((await f.rpc(paired, 'agents.list', {}, { resource: opened.resource })).error.code, 'FORBIDDEN');
  assert.equal((await f.rpc(ordinary, 'session.get', {}, { resource: opened.resource })).error.code, 'FORBIDDEN');
  assert.equal((await f.rpc(paired, 'agents.list')).result.agents[0].existingResource, opened.resource);
  assert.equal((await f.rpc(paired, 'sessions.list')).error.code, 'FORBIDDEN');
  await f.rpc(paired, 'input.claim', { owner: 'phone-agent' }, { resource: opened.resource });
  const run = await f.rpc(paired, 'execution.execute', { owner: 'phone-agent', prompt: 'Explain the approved project.' }, { resource: opened.resource });
  assert.equal(run.ok, true); await waitFor(() => getRecord('execution', run.result.executionId)?.state === 'finished');
  const backendCalls = fs.readFileSync(path.join(getRecord('session', agent.sessionId).engineHome, 'fixture-calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.ok(backendCalls.some(call => call.method === 'permissionProfile/list'));
  const agentThread = backendCalls.find(call => call.method === 'thread/start');
  assert.equal(agentThread.params.permissions, 'bzzy_agent_isolated_v1'); assert.equal(agentThread.params.approvalPolicy, 'never');
  assert.ok(agentThread.params.dynamicTools.some(tool => tool.name === 'read_project_file'));
  assert.ok(!agentThread.params.dynamicTools.some(tool => ['http_request', 'record_evidence', 'delegate', 'peer_message'].includes(tool.name)));
  assert.equal(listRecords('execution', { sessionId: agent.sessionId }).length, 1);
  const badRevision = randomUUID();
  assert.equal((await f.rpc(paired, 'agents.update', { agentId: agent.id, expectedRevision: 0, name: 'Changed' }, { id: badRevision })).error.code, 'INVALID_REQUEST');
  assert.equal((await f.rpc(paired, 'command.status', { requestId: badRevision })).result.state, 'rejected');
  const changed = (await f.rpc(paired, 'agents.update', { agentId: agent.id, expectedRevision: 1, name: 'Updated helper' })).result.agent;
  assert.equal(changed.name, 'Updated helper'); assert.equal(changed.revision, 2);
  await f.gateway.close(); await delay(30); f.gateway = f.makeGateway(); await f.gateway.start();
  assert.equal((await f.rpc(paired, 'agents.list')).result.agents[0].existingResource, opened.resource);
  assert.equal((await f.rpc(paired, 'session.get', {}, { resource: opened.resource })).result.session.id, agent.sessionId);
  const context = getRecord('core.relay.context', opened.resource);
  assert.equal((await f.rpc(paired, 'agents.archive', { agentId: agent.id, expectedRevision: 2 })).result.agent.archived, true);
  assert.ok(getRecord('access-token', digest(context.token)).revokedAt);
  assert.equal((await f.rpc(paired, 'session.get', {}, { resource: opened.resource })).error.code, 'FORBIDDEN');
  assert.equal((await f.rpc(paired, 'agents.list')).result.agents.length, 0);
});

test('an explicitly approved terminal catalog retains original directories and opens existing sessions only', async t => {
  const f = await fixture(t), first = f.createSession(), outside = path.join(f.directory, 'outside-managed-root'); fs.mkdirSync(outside);
  const other = f.core.createConversation({ provider: 'codex', cwd: outside, model: 'different-terminal-model' }, { requestId: randomUUID() });
  const managed = new CoreWorkspaces(); managed.configure({ path: path.join(f.directory, 'managed'), create: true }, { requestId: randomUUID(), expectedRevision: 0 });
  const internal = f.createSession(); putRecord('session', internal.id, { ...internal, purpose: 'core-assistant' });
  const worker = f.createSession(); putRecord('session', worker.id, { ...worker, parentSessionId: first.id });
  const privateDirectory = path.join(f.directory, '.ssh'); fs.mkdirSync(privateDirectory);
  const secretSession = f.core.createConversation({ provider: 'codex', cwd: privateDirectory }, { requestId: randomUUID() });
  const paired = await f.pair(first.id, ['observe'], undefined, { sessionAccess: true });
  assert.equal(paired.invitation.sessionAccess, true); assert.equal(paired.requested.sessionAccess, true); assert.equal(paired.local.sessionAccess, true);
  const page = (await f.rpc(paired, 'sessions.list', { limit: 1 })).result;
  assert.equal(page.sessions.length, 1); assert.equal(page.hasMore, true); assert.equal(page.nextCursor, page.sessions[0].id);
  const nextPage = (await f.rpc(paired, 'sessions.list', { after: page.nextCursor, limit: 25 })).result;
  const catalog = [...page.sessions, ...nextPage.sessions];
  assert.deepEqual(new Set(catalog.map(item => item.id)), new Set([first.id, other.id]));
  assert.equal(catalog.find(item => item.id === other.id).cwd, fs.realpathSync(outside));
  for (const denied of [internal, worker, secretSession]) assert.equal((await f.rpc(paired, 'sessions.open', { sessionId: denied.id })).error.code, 'FORBIDDEN');
  const count = listRecords('session').length, requestId = randomUUID();
  const opened = await f.rpc(paired, 'sessions.open', { sessionId: other.id }, { id: requestId });
  assert.equal(opened.ok, true); assert.equal(opened.result.state, 'accepted'); assert.notEqual(opened.result.resource, paired.local.resource);
  assert.equal(opened.result.cwd, fs.realpathSync(outside));
  assert.equal((await f.rpc(paired, 'sessions.open', { sessionId: other.id }, { id: requestId })).result.resource, opened.result.resource);
  assert.equal((await f.rpc(paired, 'sessions.open', { sessionId: other.id })).result.resource, opened.result.resource);
  assert.equal((await f.rpc(paired, 'command.status', { requestId })).result.acceptance.resource, opened.result.resource);
  assert.equal((await f.rpc(paired, 'sessions.open', { sessionId: first.id }, { id: requestId })).error.code, 'CONFLICT');
  const child = getRecord('core.relay.context', opened.result.resource), access = getRecord('access-token', digest(child.token));
  assert.deepEqual(access.permissions, ['observe']); assert.equal(access.includeChildren, false); assert.equal(access.sessionId, other.id);
  assert.ok(child.expiresAt <= getRecord('core.relay.grant', paired.local.id).expiresAt);
  const viewed = await f.rpc(paired, 'session.get', {}, { resource: child.resource });
  assert.equal(viewed.result.session.id, other.id); assert.equal(viewed.result.session.cwd, fs.realpathSync(outside));
  assert.equal(viewed.result.capabilities.sessionAccess, false);
  assert.equal((await f.rpc(paired, 'session.get')).result.session.id, first.id);
  assert.equal((await f.rpc(paired, 'input.claim', { owner: 'phone' }, { resource: child.resource })).error.code, 'FORBIDDEN');
  assert.equal((await f.rpc(paired, 'sessions.list', {}, { resource: child.resource })).error.code, 'FORBIDDEN');
  assert.equal(listRecords('session').length, count); assert.equal(listRecords('execution').length, 0);
  const rediscovered = (await f.rpc(paired, 'sessions.list')).result.sessions.find(item => item.id === other.id);
  assert.equal(rediscovered.existingResource, child.resource);
  managed.configure({ path: path.join(f.directory, 'managed-again'), create: true }, { requestId: randomUUID(), expectedRevision: 1 });
  assert.equal((await f.rpc(paired, 'session.get', {}, { resource: child.resource })).result.session.cwd, fs.realpathSync(outside));
});

test('catalog child resources retain scopes across restart and parent revocation denies every child token', async t => {
  const f = await fixture(t), first = f.createSession(), other = f.createSession();
  const paired = await f.pair(first.id, controls, undefined, { sessionAccess: true });
  const opened = (await f.rpc(paired, 'sessions.open', { sessionId: other.id })).result;
  const separatelyPaired = await f.pair(first.id, ['observe'], paired.peer);
  assert.equal((await f.rpc(separatelyPaired, 'session.get', {}, { resource: opened.resource })).error.code, 'FORBIDDEN');
  await f.rpc(paired, 'input.claim', { owner: 'phone' }, { resource: opened.resource });
  const request = randomUUID(), params = { owner: 'phone', prompt: 'Catalog existing terminal task' };
  const accepted = await f.rpc(paired, 'execution.execute', params, { resource: opened.resource, id: request });
  assert.equal(accepted.ok, true);
  assert.equal((await f.rpc(paired, 'execution.execute', params, { resource: opened.resource, id: request })).result.executionId, accepted.result.executionId);
  await waitFor(() => getRecord('execution', accepted.result.executionId)?.state === 'finished');
  assert.equal(listRecords('execution', { sessionId: other.id }).length, 1);
  await f.gateway.close(); await delay(30); f.gateway = f.makeGateway(); await f.gateway.start();
  assert.equal((await f.rpc(paired, 'session.get', {}, { resource: opened.resource })).result.session.id, other.id);
  const child = getRecord('core.relay.context', opened.resource);
  await f.gateway.close();
  revokeLocalRelayGrant(paired.local.id, { hostId: f.host.certificate.id, relayUrl: f.relay.audience });
  assert.ok(getRecord('core.relay.context', child.resource).revokedAt);
  assert.ok(getRecord('access-token', digest(child.token)).revokedAt);
  await delay(30); f.gateway = f.makeGateway(); await f.gateway.start();
  await waitFor(() => getRecord('core.relay.revocation', paired.local.id)?.state === 'complete');
  await assert.rejects(paired.peer.send(paired.local.id, {}));
  assert.equal(listRecords('execution', { sessionId: other.id }).length, 1);
});

test('catalog contexts are bounded and cannot become session creation or host directory browsing', async t => {
  const f = await fixture(t), first = f.createSession(), paired = await f.pair(first.id, ['observe'], undefined, { sessionAccess: true });
  for (let index = 0; index < 32; index++) {
    const session = f.createSession();
    assert.equal((await f.rpc(paired, 'sessions.open', { sessionId: session.id })).ok, true);
  }
  const additional = f.createSession();
  assert.equal((await f.rpc(paired, 'sessions.open', { sessionId: additional.id })).error.code, 'CAPACITY');
  assert.equal(listRecords('core.relay.context').length, 32);
  assert.equal((await f.rpc(paired, 'sessions.list', { limit: 26 })).error.code, 'INVALID_REQUEST');
  assert.equal((await f.rpc(paired, 'sessions.list', { after: randomUUID() })).error.code, 'INVALID_CURSOR');
  for (const op of ['sessions.create', 'workspace.list', 'workspace.newSession']) assert.equal((await f.rpc(paired, op)).error.code, 'OPERATION_DENIED');
  assert.equal(listRecords('execution').length, 0);
});

test('unknown protocol operations and remote environment/options/URL injection fail closed', async t => {
  const f = await fixture(t), paired = await f.pair(f.createSession().id, controls);
  for (const op of ['tokens.create', 'runtime.shutdown', 'http.proxy', 'session.create', 'agent.import']) assert.equal((await f.rpc(paired, op)).error.code, 'OPERATION_DENIED');
  for (const field of ['options', 'environment', 'url', 'headers', 'sessionId']) {
    const reply = await f.rpc(paired, 'execution.execute', { owner: 'phone', prompt: 'Do not execute', [field]: {} });
    assert.equal(reply.error.code, 'INVALID_REQUEST');
  }
  assert.equal((await f.rpc(paired, 'execution.execute', { owner: 'phone', prompt: 'Do not execute', coordinateInput: 'yes' })).error.code, 'INVALID_REQUEST');
  assert.equal((await f.rpc(paired, 'session.get', {}, { extra: { v: 2 } })).error.code, 'PROTOCOL_UNSUPPORTED');
  assert.equal(listRecords('execution').length, 0);
});

test('remote turns use principal-bound ownership and durable idempotency on the same CLI execution', async t => {
  const f = await fixture(t), session = f.createSession(), paired = await f.pair(session.id, controls), owner = 'phone-ui';
  const claimed = await f.rpc(paired, 'input.claim', { owner });
  assert.equal(claimed.ok, true); assert.equal(claimed.result.principal, undefined);
  const id = randomUUID(), input = { owner, prompt: 'PRIVATE_GATEWAY_TASK_FIXTURE' };
  const first = await f.rpc(paired, 'execution.execute', input, { id });
  assert.equal(first.ok, true); assert.equal(first.result.state, 'accepted');
  const repeated = await f.rpc(paired, 'execution.execute', input, { id });
  assert.equal(repeated.result.executionId, first.result.executionId);
  assert.equal((await f.rpc(paired, 'execution.execute', { ...input, prompt: 'Different' }, { id })).error.code, 'CONFLICT');
  const status = await f.rpc(paired, 'command.status', { requestId: id });
  assert.equal(status.result.state, 'accepted'); assert.equal(status.result.acceptance.executionId, first.result.executionId);
  await f.rpc(paired, 'input.release', { owner });
  await waitFor(() => ['finished', 'stopped'].includes(getRecord('execution', first.result.executionId)?.state));
  assert.equal(getRecord('execution', first.result.executionId).exitCode, 0);
  assert.equal((await f.core.session(session.id)).execution.id, first.result.executionId);
  assert.equal(listRecords('execution', { sessionId: session.id }).length, 1);
  assert.doesNotMatch(f.wire.join('\n'), /PRIVATE_GATEWAY_TASK_FIXTURE/);
  assert.doesNotMatch(JSON.stringify(f.relayAudit), /PRIVATE_GATEWAY_TASK_FIXTURE/);
});

test('mobile slash goals require replacement confirmation and complete through the actual goal and notification lifecycle', async t => {
  const f = await fixture(t), session = f.createSession(), paired = await f.pair(session.id, controls), owner = 'phone-goal';
  prepareTask(session, {}, 'Old goal'); session.goal = newGoal('Old goal'); session.acceptance = { passed: true };
  putRecord('session', session.id, session);
  await f.rpc(paired, 'session.get');
  await runtimeRequest(runtimeInfo(), 'POST', `/sessions/${session.id}/claim`, { owner: 'cli-streaming' });
  assert.equal((await f.rpc(paired, 'session.get')).result.capabilities.goalSubmission, true);
  const input = { owner, prompt: '/goal Entirely new objective', coordinateInput: true };
  const denied = await f.rpc(paired, 'execution.execute', input);
  assert.equal(denied.error?.code, 'CONFIRMATION_REQUIRED');
  assert.equal(listRecords('execution', { sessionId: session.id }).length, 0);
  assert.equal((await f.core.session(session.id)).inputOwner.owner, 'cli-streaming');
  const id = randomUUID(), confirmed = { ...input, replaceGoalId: session.goal.id };
  const first = await f.rpc(paired, 'execution.execute', confirmed, { id });
  assert.equal(first.ok, true, JSON.stringify(first));
  const repeated = await f.rpc(paired, 'execution.execute', confirmed, { id });
  assert.equal(repeated.result.executionId, first.result.executionId);
  await waitFor(() => ['finished', 'stopped'].includes(getRecord('execution', first.result.executionId)?.state));
  const changed = getRecord('session', session.id), job = getRecord('execution', first.result.executionId);
  assert.equal(job.goal, true); assert.equal(job.prompt, 'Entirely new objective'); assert.equal(job.exitCode, 0);
  assert.equal(changed.goal.objective, 'Entirely new objective'); assert.equal(changed.contract.objective, changed.goal.objective);
  assert.equal(changed.goal.status, 'complete'); assert.equal(changed.acceptance.passed, true);
  assert.notEqual(changed.goal.id, session.goal.id);
  assert.equal(getRecord('goal-history', session.goal.id).supersededBy, changed.goal.id);
  const notifications = listRecords('outbox').filter(item => item.event.sessionId === session.id && item.event.type === 'goal.completed');
  assert.equal(notifications.length, 1); assert.equal(notifications[0].event.objective, changed.goal.objective);
  assert.equal(listRecords('execution', { sessionId: session.id }).length, 1);
});

test('resubscribing before an ACK replays the exact pending frame without waiting for expiration', async t => {
  const f = await fixture(t), session = f.createSession(), paired = await f.pair(session.id);
  appendEvent(session.id, 'text', { text: 'A saved reply that must survive reconnect.' });
  const frame = () => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { paired.peer.removeListener('message', receive); reject(new Error('No replayed frame')); }, 2000);
    const receive = message => {
      if (message.payload.type !== 'events') return;
      clearTimeout(timeout); paired.peer.removeListener('message', receive); resolve(message.payload);
    };
    paired.peer.on('message', receive);
  });
  const firstFrame = frame();
  const first = await f.rpc(paired, 'events.subscribe', { consumerId: 'same-device-cache' });
  const delivered = await firstFrame;
  // Simulate a phone that saved the frame but lost its ACK during suspension.
  const replayFrame = frame();
  const next = await f.rpc(paired, 'events.subscribe', { consumerId: 'same-device-cache' });
  assert.equal(next.result.subscriptionId, first.result.subscriptionId);
  const replayed = await replayFrame;
  assert.deepEqual(replayed.events, delivered.events);
  assert.equal(replayed.nextCursor, delivered.nextCursor);
  const ack = await f.rpc(paired, 'events.ack', { subscriptionId: next.result.subscriptionId, seq: replayed.nextCursor });
  assert.equal(ack.result.processedCursor, delivered.nextCursor);
});

test('only the full own phone can change terminal YOLO and accept its exact pending approval idempotently', async t => {
  const f = await fixture(t), terminal = f.createSession(), owner = 'ios-permission-client';
  const paired = await f.pair(terminal.id, controls, undefined, { sessionAccess: true, agentAccess: true, shareAccess: true });
  const friend = await f.pair(terminal.id, controls);
  assert.equal((await f.rpc(friend, 'session.get')).result.capabilities.yoloControl, false);
  assert.equal((await f.rpc(friend, 'permissions.set', { owner, enabled: true })).error.code, 'FORBIDDEN');
  assert.equal((await f.rpc(paired, 'session.get')).result.capabilities.yoloControl, true);
  await f.rpc(paired, 'input.claim', { owner });
  const questionId = randomUUID();
  putRecord('question', questionId, { id: questionId, sessionId: terminal.id, kind: 'approval', question: 'Fixture action', state: 'pending', expiresAt: Date.now() + 60000 });
  const id = randomUUID(), params = { owner, enabled: true, questionId };
  const accepted = await f.rpc(paired, 'permissions.set', params, { id });
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  assert.deepEqual(accepted.result, { state: 'accepted', yolo: true, approvedQuestionId: questionId });
  assert.equal(getRecord('question', questionId).answer, 'yes');
  assert.deepEqual((await f.rpc(paired, 'permissions.set', params, { id })).result, accepted.result);
  assert.equal((await f.rpc(paired, 'session.get')).result.capabilities.yolo, true);
  assert.equal((await f.rpc(paired, 'permissions.set', { owner, enabled: false })).result.yolo, false);
  assert.equal(listRecords('execution').length, 0, 'permission controls never submit model work');
});

test('full-phone voice chat executes the default Core assistant through encrypted Relay and recovers the spoken reply', async t => {
  const f = await fixture(t), seed = f.createSession();
  new CoreWorkspaces().configure({ path: f.workspace }, { requestId: randomUUID(), expectedRevision: 0 });
  new CoreAssistant().configure({ source: 'core', provider: 'codex', model: 'fixture-model' }, { requestId: randomUUID(), expectedRevision: 0 });
  const paired = await f.pair(seed.id, controls, undefined, { sessionAccess: true, agentAccess: true, shareAccess: true });
  const before = listRecords('execution').length;
  assert.equal((await f.rpc(paired, 'voice.status')).result.configured, true);
  assert.equal(listRecords('execution').length, before);
  const id = randomUUID(), text = 'SYNTHETIC_VOICE_MESSAGE';
  assert.equal((await f.rpc(paired, 'voice.send', { text }, { id })).result.state, 'accepted');
  assert.equal((await f.rpc(paired, 'voice.send', { text }, { id })).result.state, 'accepted');
  const record = listRecords('core.voice.turn')[0];
  await waitFor(() => getRecord('execution', record.executionId)?.state === 'finished');
  const spoken = await f.rpc(paired, 'voice.poll', { requestId: id, cursor: 0 });
  assert.equal(spoken.ok, true); assert.equal(spoken.result.state, 'finished'); assert.match(spoken.result.text, /First pass/);
  assert.equal(listRecords('execution').length, before + 1);
  assert.doesNotMatch(f.wire.join('\n'), /SYNTHETIC_VOICE_MESSAGE/);
  const contexts = listRecords('core.relay.context').filter(row => row.kind === 'voice');
  assert.equal(contexts.length, 1); assert.equal(getRecord('session', contexts[0].sessionId).model, 'fixture-model');
  const observer = await f.pair(seed.id, ['observe']);
  assert.equal((await f.rpc(observer, 'voice.status')).error.code, 'FORBIDDEN');
  assert.equal((await f.rpc(observer, 'voice.poll', { requestId: id, cursor: 0 })).error.code, 'FORBIDDEN');
});

test('a background task uses the configured Core AI and the same durable execution without terminal chat input', async t => {
  const f = await fixture(t), assistant = new CoreAssistant();
  assistant.configure({ source: 'core', provider: 'codex', model: 'fixture-model' }, { requestId: randomUUID(), expectedRevision: 0 });
  const context = assistant.createContext({ cwd: f.workspace }, { requestId: randomUUID() }), paired = await f.pair(context.contextId, controls);
  assert.equal((await f.rpc(paired, 'assistant.status')).result.model, 'fixture-model');
  const owner = 'ios-task-client'; await f.rpc(paired, 'input.claim', { owner });
  const id = randomUUID(), params = { owner, instruction: 'SYNTHETIC_BACKGROUND_TASK' };
  const submitted = await f.rpc(paired, 'task.submit', params, { id });
  assert.equal(submitted.ok, true); assert.equal(submitted.result.state, 'accepted');
  assert.equal(submitted.result.sessionId, undefined); assert.equal(submitted.result.executionId, undefined);
  const taskId = submitted.result.taskId;
  assert.equal((await f.rpc(paired, 'task.submit', params, { id })).result.taskId, taskId);
  assert.equal((await f.rpc(paired, 'task.submit', { ...params, instruction: 'Changed' }, { id })).error.code, 'CONFLICT');
  await f.rpc(paired, 'input.release', { owner });
  const record = getRecord('core.relay.command', taskId);
  await waitFor(() => getRecord('execution', record.result.executionId)?.state === 'finished');
  const task = await f.rpc(paired, 'task.get', { taskId });
  assert.equal(task.result.state, 'finished'); assert.equal(task.result.execution.exitCode, 0);
  assert.equal(task.result.verification, 'not-assessed'); assert.equal(task.result.output.source, 'execution-events');
  assert.ok(Number.isSafeInteger(task.result.output.after)); assert.ok(task.result.output.through > task.result.output.after);
  const output = (await f.core.events(context.contextId, task.result.output.after)).events.filter(event => event.seq <= task.result.output.through);
  assert.equal(output[0].type, 'execution.started'); assert.equal(output.at(-1).type, 'execution.finished');
  assert.ok(output.some(event => event.type === 'text'));
  assert.equal(getRecord('session', context.contextId).provider, 'codex');
  assert.equal(listRecords('execution', { sessionId: context.contextId }).length, 1);
  assert.doesNotMatch(JSON.stringify(record), /SYNTHETIC_BACKGROUND_TASK/);
  assert.doesNotMatch(f.wire.join('\n'), /SYNTHETIC_BACKGROUND_TASK/);
  // Recover the lost task receipt through the existing Core acceptance journal.
  putRecord('core.relay.command', taskId, { ...record, state: 'uncertain', result: undefined });
  assert.equal((await f.rpc(paired, 'command.status', { requestId: id })).result.acceptance.taskId, taskId);
  assert.equal(listRecords('execution', { sessionId: context.contextId }).length, 1);
});

test('task access stays inside its exact device/context and cannot become global Core administration', async t => {
  const f = await fixture(t), assistant = new CoreAssistant();
  assistant.configure({ source: 'core', provider: 'codex' }, { requestId: randomUUID(), expectedRevision: 0 });
  const context = assistant.createContext({ cwd: f.workspace }, { requestId: randomUUID() }), controller = await f.pair(context.contextId, controls);
  const observer = await f.pair(context.contextId), terminal = await f.pair(f.createSession().id, controls);
  assert.equal((await f.rpc(observer, 'task.submit', { owner: 'observer', instruction: 'Do not run' })).error.code, 'FORBIDDEN');
  for (const op of ['assistant.configure', 'assistant.createContext', 'permissions.grant', 'agent.create']) assert.equal((await f.rpc(controller, op)).error.code, 'OPERATION_DENIED');
  assert.equal((await f.rpc(terminal, 'task.submit', { owner: 'terminal', instruction: 'Do not run' })).error.code, 'OPERATION_DENIED');
  assert.equal((await f.rpc(terminal, 'assistant.status')).error.code, 'OPERATION_DENIED');
  await f.rpc(controller, 'input.claim', { owner: 'owner' });
  for (const field of ['model', 'provider', 'environment', 'options', 'cwd', 'permissions', 'bindings']) {
    assert.equal((await f.rpc(controller, 'task.submit', { owner: 'owner', instruction: 'Do not run', [field]: 'unsupported' })).error.code, 'INVALID_REQUEST');
  }
  const accepted = await f.rpc(controller, 'task.submit', { owner: 'owner', instruction: 'Fixture task' });
  assert.equal((await f.rpc(observer, 'task.get', { taskId: accepted.result.taskId })).error.code, 'FORBIDDEN');
  await f.gateway.revokeGrant(controller.local.id);
  assert.equal(getRecord('access-token', digest(getRecord('core.relay.grant', controller.local.id).token)).revokedAt != null, true);
  assert.equal(listRecords('execution').length, 1);
});

test('an oversized event reports subscription closure and never acknowledges lost evidence', async t => {
  const f = await fixture(t), session = f.createSession(), paired = await f.pair(session.id);
  appendEvent(session.id, 'evidence.large', { text: 'x'.repeat(30000), provenance: 'fixture-host-observation' });
  const closed = new Promise(resolve => {
    paired.peer.on('message', message => { if (message.payload.type === 'subscription.closed') resolve(message.payload); });
  });
  const delivered = new Promise(resolve => {
    paired.peer.on('message', message => { if (message.payload.type === 'events') resolve(message.payload); });
  });
  const subscribed = await f.rpc(paired, 'events.subscribe', { consumerId: 'large-event' });
  // Acknowledge the actual delivered prefix, including any pairing audit events.
  const batch = await Promise.race([delivered, delay(3000).then(() => assert.fail('Missing event prefix'))]);
  await f.rpc(paired, 'events.ack', { subscriptionId: subscribed.result.subscriptionId, seq: batch.nextCursor });
  const notice = await Promise.race([closed, delay(3000).then(() => assert.fail('Missing subscription closure'))]);
  assert.equal(notice.subscriptionId, subscribed.result.subscriptionId); assert.equal(notice.code, 'RESULT_TOO_LARGE');
  assert.equal((await f.rpc(paired, 'events.list', { after: batch.nextCursor })).error.code, 'RESULT_TOO_LARGE');
  const resumed = await f.rpc(paired, 'events.subscribe', { consumerId: 'large-event' });
  assert.equal(resumed.result.processedCursor, batch.nextCursor);
});

test('each device owns a separate input identity and takeover stays explicit', async t => {
  const f = await fixture(t), session = f.createSession();
  const first = await f.pair(session.id, controls), second = await f.pair(session.id, controls);
  const a = await f.rpc(first, 'input.claim', { owner: 'same-client-text' });
  assert.equal((await f.rpc(second, 'input.claim', { owner: 'same-client-text' })).error.code, 'CONFLICT');
  const b = await f.rpc(second, 'input.claim', { owner: 'same-client-text', takeover: true });
  assert.notEqual(a.result.owner, b.result.owner);
  const denied = await f.rpc(first, 'execution.execute', { owner: 'same-client-text', prompt: 'Denied after takeover' });
  assert.equal(denied.error.code, 'CONFLICT'); assert.equal(listRecords('execution').length, 0);
});

test('question answers remain scoped and controls report acceptance rather than goal completion', async t => {
  const f = await fixture(t), session = f.createSession(), other = f.createSession(), paired = await f.pair(session.id, controls);
  await f.rpc(paired, 'input.claim', { owner: 'phone' });
  const questionId = randomUUID(); putRecord('question', questionId, { id: questionId, sessionId: other.id, state: 'pending', text: 'Other session' });
  assert.equal((await f.rpc(paired, 'question.answer', { owner: 'phone', questionId, answer: 'Denied' })).error.code, 'FORBIDDEN');
  putRecord('question', questionId, { id: questionId, sessionId: session.id, state: 'pending', text: 'Approved session' });
  const answer = await f.rpc(paired, 'question.answer', { owner: 'phone', questionId, answer: 'Approved' });
  assert.equal(answer.result.state, 'accepted'); assert.equal(getRecord('question', questionId).state, 'answered');
  const control = await f.rpc(paired, 'control.request', { owner: 'phone', action: 'pause' });
  assert.equal(control.result.state, 'accepted'); assert.ok(control.result.controlId);
  assert.equal((await f.rpc(paired, 'session.get')).result.session.goal, null);
});

test('known credentials are redacted without dropping event identity or provenance', async t => {
  const f = await fixture(t), session = f.createSession(), paired = await f.pair(session.id);
  const privateGrant = getRecord('core.relay.grant', paired.local.id), ownerToken = runtimeInfo().token;
  const event = appendEvent(session.id, 'future.unknown', { provenance: 'host-observed', evidence: 'Evidence ID',
    text: `${ownerToken} ${privateGrant.token} ${f.host.signingSecret}`, token: 'synthetic-private-value' });
  const reply = await f.rpc(paired, 'events.list');
  assert.equal(reply.ok, true);
  const observed = reply.result.events.find(item => item.id === event.id);
  assert.equal(observed.seq, event.seq); assert.equal(observed.createdAt, event.createdAt); assert.equal(observed.data.provenance, 'host-observed');
  const serialized = JSON.stringify(reply);
  for (const secret of [ownerToken, privateGrant.token, f.host.signingSecret, 'synthetic-private-value']) assert.ok(!serialized.includes(secret));
});

test('processed event acknowledgments survive restart; transport receipts never advance cursors', async t => {
  const f = await fixture(t), session = f.createSession(), paired = await f.pair(session.id);
  const tail = appendEvent(session.id, 'future.event', { provenance: 'host-observed' });
  const batches = [];
  const collect = message => { if (message.payload.type === 'events') batches.push(message.payload); };
  paired.peer.on('message', collect);
  t.after(() => paired.peer.removeListener('message', collect));
  const subscribed = await f.rpc(paired, 'events.subscribe', { consumerId: 'phone-projection' });
  assert.equal(subscribed.result.processedCursor, 0);
  const batch = await waitFor(() => batches[0]);
  assert.ok(batch.events.some(event => event.id === tail.id));
  assert.equal(listRecords('core.relay.cursor').length, 0);
  const wrong = await f.rpc(paired, 'events.ack', { subscriptionId: batch.subscriptionId, seq: tail.seq + 1000 });
  assert.equal(wrong.error.code, 'INVALID_CURSOR');
  const acked = await f.rpc(paired, 'events.ack', { subscriptionId: batch.subscriptionId, seq: tail.seq });
  assert.equal(acked.result.processedCursor, tail.seq);
  await f.gateway.close(); await delay(30);
  f.gateway = f.makeGateway(); await f.gateway.start();
  const count = listRecords('execution').length;
  const unprocessed = appendEvent(session.id, 'future.after-restart', { value: 1 });
  batches.length = 0;
  const restored = await f.rpc(paired, 'events.subscribe', { consumerId: 'phone-projection' });
  assert.equal(restored.result.processedCursor, tail.seq);
  const replay = await waitFor(() => batches.find(value => value.events.some(event => event.id === unprocessed.id)));
  assert.ok(replay.events.every(event => event.seq > tail.seq)); assert.equal(listRecords('execution').length, count);
});

test('a crashed acceptance record reconciles from Core without dispatching again', async t => {
  const f = await fixture(t), session = f.createSession(), paired = await f.pair(session.id, controls);
  await f.rpc(paired, 'input.claim', { owner: 'phone' });
  const id = randomUUID(), params = { owner: 'phone', prompt: 'Fixture command retained across a gateway crash' };
  const accepted = await f.rpc(paired, 'execution.execute', params, { id });
  assert.equal(accepted.ok, true);
  const command = listRecords('core.relay.command')[0];
  const { result, ...rest } = command; putRecord('core.relay.command', command.id, { ...rest, state: 'dispatching' });
  await f.gateway.close(); await delay(30); f.gateway = f.makeGateway(); await f.gateway.start();
  assert.equal(getRecord('core.relay.command', command.id).state, 'uncertain');
  const reconciled = await f.rpc(paired, 'command.status', { requestId: id });
  assert.equal(reconciled.result.state, 'accepted'); assert.equal(reconciled.result.acceptance.executionId, accepted.result.executionId);
  assert.equal((await f.rpc(paired, 'execution.execute', params, { id })).result.executionId, accepted.result.executionId);
  assert.equal(listRecords('execution', { sessionId: session.id }).length, 1);
  await waitFor(() => ['finished', 'stopped'].includes(getRecord('execution', accepted.result.executionId)?.state));
});

test('uncertain commands with no durable Core acceptance are never automatically retried', async t => {
  const f = await fixture(t), paired = await f.pair(f.createSession().id, controls), id = randomUUID();
  const params = { owner: 'phone', prompt: 'Do not replay an uncertain command' };
  const key = digest({ host: f.host.certificate.id, peer: paired.peer.identity.certificate.id, resource: paired.local.resource, request: id });
  putRecord('core.relay.command', key, { id: key, hostId: f.host.certificate.id, relayUrl: f.relay.audience,
    peerId: paired.peer.identity.certificate.id, resource: paired.local.resource, sessionId: paired.local.sessionId,
    op: 'execution.execute', fingerprint: digest({ op: 'execution.execute', params }), state: 'uncertain' });
  const reply = await f.rpc(paired, 'execution.execute', params, { id });
  assert.equal(reply.error.code, 'UNCERTAIN'); assert.equal(listRecords('execution').length, 0);
});

test('Relay grant metadata cannot widen a locally approved observer', async t => {
  const f = await fixture(t), paired = await f.pair(f.createSession().id);
  const row = f.store.db.prepare('SELECT data FROM grants WHERE id=?').get(paired.local.id), grant = JSON.parse(row.data);
  grant.spec.actions = controls;
  f.store.db.prepare('UPDATE grants SET data=? WHERE id=?').run(JSON.stringify(grant), paired.local.id);
  const reply = await f.rpc(paired, 'execution.execute', { owner: 'phone', prompt: 'Relay cannot authorize this' });
  assert.equal(reply.error.code, 'FORBIDDEN'); assert.equal(listRecords('execution').length, 0);
});

test('a portable transport grant cannot create a Core device authorization', async t => {
  const f = await fixture(t), peer = await f.newPeer();
  const invitation = await f.hostClient.createInvitation({ kind: 'TERMINAL', mode: 'portable', resource: 'portable-fixture', actions: ['import'] });
  const rejected = next(f.gateway, 'fault'), claim = await peer.claim(invitation.code);
  assert.equal((await rejected).code, 'PAIRING_CLAIM_REJECTED');
  const { grant } = await f.hostClient.approve(claim.claimId, peer.identity.certificate);
  peer.trustPeer(f.host.certificate);
  const denied = next(f.gateway, 'fault');
  await peer.send(grant.id, { v: 1, protocol: 'bzzy-core', type: 'request', id: randomUUID(), resource: 'portable-fixture', op: 'session.get', params: {} });
  assert.equal((await denied).code, 'RELAY_MESSAGE_REJECTED');
  assert.equal(f.gateway.status().activeGrants, 0); assert.equal(listRecords('execution').length, 0);
});

test('processed cursors and subscription acknowledgments cannot cross session grants', async t => {
  const f = await fixture(t), first = await f.pair(f.createSession().id), second = await f.pair(f.createSession().id, ['observe'], first.peer);
  const a = await f.rpc(first, 'events.subscribe', { consumerId: 'same-consumer' });
  const b = await f.rpc(second, 'events.subscribe', { consumerId: 'same-consumer' });
  assert.notEqual(a.result.subscriptionId, b.result.subscriptionId);
  assert.equal(a.result.processedCursor, 0); assert.equal(b.result.processedCursor, 0);
  const denied = await f.rpc(second, 'events.ack', { subscriptionId: a.result.subscriptionId, seq: 1 });
  assert.equal(denied.error.code, 'FORBIDDEN'); assert.equal(listRecords('core.relay.cursor').length, 0);
});

test('revocation cancels a live subscription and the Core token remains revoked after restart', async t => {
  const f = await fixture(t), session = f.createSession(), paired = await f.pair(session.id);
  await f.rpc(paired, 'events.subscribe', { consumerId: 'phone' });
  assert.equal(f.gateway.status().subscriptions, 1);
  await f.gateway.revokeGrant(paired.local.id);
  assert.equal(f.gateway.status().subscriptions, 0);
  const row = getRecord('core.relay.grant', paired.local.id);
  assert.ok(row.revokedAt); assert.ok(getRecord('access-token', digest(row.token)).revokedAt);
  await f.gateway.close(); await delay(30); f.gateway = f.makeGateway(); await f.gateway.start();
  assert.equal(f.gateway.status().activeGrants, 0);
  await assert.rejects(paired.peer.send(paired.local.id, {}));
  assert.equal(listRecords('execution').length, 0);
});

test('offline local revocation is enforced before Relay revocation completes', async t => {
  const f = await fixture(t), paired = await f.pair(f.createSession().id);
  await f.gateway.close();
  const queued = revokeLocalRelayGrant(paired.local.id, { hostId: f.host.certificate.id, relayUrl: f.relay.audience });
  assert.equal(queued.revoked, true); assert.equal(queued.relayRevocation, 'pending');
  await delay(30); f.gateway = f.makeGateway(); await f.gateway.start();
  assert.equal(f.gateway.status().activeGrants, 0);
  await waitFor(() => getRecord('core.relay.revocation', paired.local.id)?.state === 'complete');
  await assert.rejects(paired.peer.send(paired.local.id, {}));
});

test('recent history bootstrap is scoped, durable and separate from strict delivered acknowledgments', async t => {
  const f = await fixture(t), session = f.createSession(), other = f.createSession(), paired = await f.pair(session.id);
  const envelopes = Array.from({ length: 70 }, (_, i) => appendEvent(session.id, 'text', { text: `history-${i}`, itemId: `item-${i}` }));
  const latest = await f.rpc(paired, 'events.list', { latest: true, limit: 10 });
  assert.equal(latest.ok, true); assert.deepEqual(latest.result.events.map(event => event.seq), envelopes.slice(-10).map(event => event.seq));
  assert.equal(latest.result.hasOlder, true); assert.equal(latest.result.oldestCursor, envelopes.at(-10).seq);
  const older = await f.rpc(paired, 'events.list', { before: latest.result.oldestCursor, limit: 10 });
  assert.deepEqual(older.result.events.map(event => event.seq), envelopes.slice(-20, -10).map(event => event.seq));
  assert.equal(older.result.bootstrapToken, undefined);
  const otherPair = await f.pair(other.id);
  assert.equal((await f.rpc(otherPair, 'events.subscribe', { consumerId: 'tail', bootstrapToken: latest.result.bootstrapToken })).error.code, 'INVALID_CURSOR');
  const subscribed = await f.rpc(paired, 'events.subscribe', { consumerId: 'tail', bootstrapToken: latest.result.bootstrapToken });
  assert.equal(subscribed.result.processedCursor, latest.result.nextCursor);
  assert.equal((await f.rpc(paired, 'events.ack', { subscriptionId: subscribed.result.subscriptionId, seq: latest.result.nextCursor + 999 })).error.code, 'INVALID_CURSOR');
  const proof = listRecords('core.relay.bootstrap').find(row => row.resource === paired.local.resource);
  putRecord('core.relay.bootstrap', digest({ host: f.host.certificate.id, peer: paired.peer.identity.certificate.id, resource: paired.local.resource }), { ...proof, expiresAt: 0 });
  assert.equal((await f.rpc(paired, 'events.subscribe', { consumerId: 'expired', bootstrapToken: latest.result.bootstrapToken })).error.code, 'INVALID_CURSOR');
  // Ambiguous acceptance recovers its already committed consumer without a
  // proof; a fresh uncommitted cache can explicitly disclose a newer tail.
  assert.equal((await f.rpc(paired, 'events.subscribe', { consumerId: 'tail' })).result.processedCursor, latest.result.nextCursor);
  const refreshed = await f.rpc(paired, 'events.list', { latest: true, limit: 10 });
  assert.equal((await f.rpc(paired, 'events.subscribe', { consumerId: 'fresh-after-expiry', bootstrapToken: refreshed.result.bootstrapToken })).result.processedCursor, refreshed.result.nextCursor);
});

test('large event chunk transfer preserves exact sanitized bytes across paging and live acknowledgment', async t => {
  const f = await fixture(t), session = f.createSession(), paired = await f.pair(session.id);
  const large = appendEvent(session.id, 'text', { text: 'A compound eye 🪰 '.repeat(4000), provenance: 'model-reported' });
  const latest = await f.rpc(paired, 'events.list', { latest: true, eventChunks: true, limit: 1 });
  assert.equal(latest.ok, true);
  const descriptor = latest.result.events[0]; assert.equal(descriptor.chunked, true); assert.equal(descriptor.seq, large.seq);
  const chunks = [];
  for (let offset = 0; offset < descriptor.bytes;) {
    const response = await f.rpc(paired, 'events.chunk', { seq: large.seq, offset, limit: 16384 });
    assert.equal(response.ok, true); assert.equal(response.result.sha256, descriptor.sha256);
    chunks.push(Buffer.from(response.result.data, 'base64')); offset = response.result.nextOffset;
  }
  const encoded = Buffer.concat(chunks); assert.equal(digest(encoded), descriptor.sha256); assert.deepEqual(JSON.parse(encoded), large);
  const cross = await f.pair(f.createSession().id);
  assert.equal((await f.rpc(cross, 'events.chunk', { seq: large.seq, offset: 0, limit: 16384 })).error.code, 'INVALID_CURSOR');
  assert.equal((await f.rpc(paired, 'events.chunk', { seq: large.seq, offset: descriptor.bytes, limit: 16384 })).error.code, 'RESULT_TOO_LARGE');
  const incoming = new Promise(resolve => paired.peer.on('message', message => { if (message.payload.type === 'events' && message.payload.events.some(event => event.seq === large.seq)) resolve(message.payload); }));
  const subscribed = await f.rpc(paired, 'events.subscribe', { consumerId: 'chunks', eventChunks: true });
  const page = await incoming;
  assert.equal(page.events.find(event => event.seq === large.seq).sha256, descriptor.sha256);
  assert.equal((await f.rpc(paired, 'events.ack', { subscriptionId: subscribed.result.subscriptionId, seq: page.nextCursor })).result.processedCursor, page.nextCursor);
});

test('an existing observation consumer upgrades to chunked events without changing its durable cursor', async t => {
  const f = await fixture(t), session = f.createSession(), paired = await f.pair(session.id);
  const large = appendEvent(session.id, 'text', { text: 'large exact reply '.repeat(3000) });
  const pages = [], notices = [];
  paired.peer.on('message', message => {
    if (message.payload.type === 'events') pages.push(message.payload);
    if (message.payload.type === 'subscription.closed') notices.push(message.payload);
  });
  const first = await f.rpc(paired, 'events.subscribe', { consumerId: 'upgrade' });
  const upgraded = await f.rpc(paired, 'events.subscribe', { consumerId: 'upgrade', eventChunks: true });
  assert.equal(upgraded.result.subscriptionId, first.result.subscriptionId);
  assert.equal(upgraded.result.processedCursor, first.result.processedCursor);
  let descriptor;
  await waitFor(async () => {
    assert.equal(notices.length, 0, 'An upgraded consumer must not close at an oversized event.');
    const page = pages.shift();
    if (!page) return false;
    descriptor = page.events.find(event => event.seq === large.seq);
    await f.rpc(paired, 'events.ack', { subscriptionId: upgraded.result.subscriptionId, seq: page.nextCursor });
    return descriptor;
  });
  assert.equal(descriptor.chunked, true); assert.equal(descriptor.id, large.id);
});

test('idle subscriptions expire and reclaim capacity while same-resource health renews the lease', async t => {
  const f = await fixture(t, { subscriptionLeaseMs: 400 }), session = f.createSession(), paired = await f.pair(session.id);
  const notices = [];
  paired.peer.on('message', message => { if (message.payload.type === 'subscription.closed') notices.push(message.payload); });
  for (let i = 0; i < 4; i++) assert.equal((await f.rpc(paired, 'events.subscribe', { consumerId: `idle-${i}` })).ok, true);
  assert.equal((await f.rpc(paired, 'events.subscribe', { consumerId: 'capacity' })).error.code, 'CAPACITY');
  await delay(650);
  assert.equal(notices.filter(notice => notice.code === 'SUBSCRIPTION_EXPIRED').length, 4);
  const active = await f.rpc(paired, 'events.subscribe', { consumerId: 'active' });
  for (let i = 0; i < 4; i++) { await delay(170); assert.equal((await f.rpc(paired, 'session.get')).ok, true); }
  const renewed = await f.rpc(paired, 'events.subscribe', { consumerId: 'active' });
  assert.equal(renewed.result.subscriptionId, active.result.subscriptionId);
  assert.equal(notices.length, 4);
});

test('fully approved phone switches its single foreground subscription without orphan capacity or cursor loss', async t => {
  const f = await fixture(t), session = f.createSession();
  const paired = await f.pair(session.id, controls, undefined, { sessionAccess: true, agentAccess: true, shareAccess: true });
  const snapshot = await f.rpc(paired, 'session.get'); assert.equal(snapshot.result.capabilities.singleViewSubscription, true);
  const first = await f.rpc(paired, 'events.subscribe', { consumerId: 'first-view', singleView: true });
  for (let i = 0; i < 6; i++) {
    const nextSession = f.createSession(), opened = await f.rpc(paired, 'sessions.open', { sessionId: nextSession.id });
    const response = await f.rpc(paired, 'events.subscribe', { consumerId: `view-${i}`, singleView: true }, { resource: opened.result.resource });
    assert.equal(response.ok, true);
  }
  const reopened = await f.rpc(paired, 'events.subscribe', { consumerId: 'first-view', singleView: true });
  assert.notEqual(reopened.result.subscriptionId, first.result.subscriptionId);
  assert.equal(reopened.result.processedCursor, first.result.processedCursor);
  const scoped = await f.pair(session.id, ['observe']);
  assert.equal((await f.rpc(scoped, 'events.subscribe', { consumerId: 'scoped', singleView: true })).error.code, 'FORBIDDEN');
  assert.equal((await f.rpc(scoped, 'events.subscribe', { consumerId: 'scoped' })).ok, true);
});
