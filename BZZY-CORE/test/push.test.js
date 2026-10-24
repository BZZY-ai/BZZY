import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http2 from 'node:http2';
import { generateKeyPairSync, createPublicKey, verify, randomUUID } from 'node:crypto';
import { APNsClient, loadAPNsConfiguration, PushError } from '../src/push/apns.js';
import { registerDeviceNotifications, updateDeviceNotifications, revokeDeviceNotifications, authorizedPushRegistration } from '../src/push/registration.js';
import { CorePushWorker } from '../src/push/worker.js';
import { newGoal } from '../src/engine/goals.js';
import { saveSession } from '../src/engine/store.js';
import { superviseExecutions } from '../src/engine/runtime-processes.js';
import { getRecord, putRecord, listRecords, digest } from '../src/engine/database.js';
import { validateRequest, sanitize } from '../src/relay/protocol.js';
import { CoreAgents } from '../src/agents.js';
import { CoreWorkspaces } from '../src/workspaces.js';

const token = 'ab'.repeat(32), hostId = 'H'.repeat(43), peerId = 'phone-fixture';
let directory, previous;
test.beforeEach(() => {
  previous = process.env.BZZY_HOME;
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-push-')));
  process.env.BZZY_HOME = path.join(directory, 'private');
  fs.mkdirSync(process.env.BZZY_HOME, { mode: 0o700 });
});
test.afterEach(() => {
  if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
  fs.rmSync(directory, { recursive: true, force: true });
});
function session(purpose) {
  const id = randomUUID(), cwd = path.join(directory, id); fs.mkdirSync(cwd);
  const row = { id, cwd, provider: 'codex', createdAt: new Date().toISOString(), ...(purpose ? { purpose } : {}) };
  putRecord('session', id, row); return row;
}
function grant({ catalog = false, agentAccess = false, selected = session(), peer = peerId, host = hostId } = {}) {
  const certificate = { id: peer, fixture: true }, accessToken = randomUUID(), coreGrantId = randomUUID();
  const row = { id: randomUUID(), resource: randomUUID(), sessionId: selected.id, hostId: host, peerId: peer,
    peerDigest: digest(certificate), relayUrl: 'wss://relay.example/v1/socket', sessionAccess: catalog, agentAccess,
    permissions: ['observe'], token: accessToken, coreGrantId, expiresAt: Date.now() + 3600_000 };
  putRecord('access-token', digest(accessToken), { id: coreGrantId, sessionId: selected.id, expiresAt: row.expiresAt,
    includeChildren: false, permissions: ['observe'] });
  putRecord('core.relay.pin', peer, { hostId: host, certificate });
  putRecord('core.relay.grant', row.id, row); return row;
}
function configuration() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { keyId: 'KEYID12345', teamId: 'TEAMID1234', topic: 'app.bzzy.ios', environment: 'sandbox', privateKey, fingerprint: randomUUID() };
}
function register(row, extra = {}) { return registerDeviceNotifications(row, { deviceToken: token, environment: 'sandbox', enabled: true, ...extra }); }
function outbox(selected, type = 'goal.completed', extra = {}) {
  const event = { id: randomUUID(), sessionId: selected.id, type, occurredAt: new Date(Date.now() + 10).toISOString(),
    objective: 'PRIVATE GOAL TEXT', cwd: '/private/workspace', ...extra };
  putRecord('outbox', event.id, { event, deliveries: {} }); return event;
}

test('private APNs configuration validates owner-only P256 keys without returning credentials to the remote app', () => {
  const cfg = configuration(), folder = path.join(process.env.BZZY_HOME, 'push'); fs.mkdirSync(folder, { mode: 0o700 });
  const key = path.join(folder, 'AuthKey.p8');
  fs.writeFileSync(key, cfg.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const file = path.join(folder, 'apns.json');
  fs.writeFileSync(file, JSON.stringify({ keyId: cfg.keyId, teamId: cfg.teamId, topic: cfg.topic, environment: cfg.environment, signingKeyFile: key }), { mode: 0o600 });
  const loaded = loadAPNsConfiguration({ strict: true }); assert.equal(loaded.topic, 'app.bzzy.ios'); assert.equal(loaded.privateKey.asymmetricKeyType, 'ec');
  const publicResult = register(grant()); assert.equal(publicResult.providerConfigured, true);
  assert.deepEqual(Object.keys(publicResult).sort(), ['enabled', 'providerConfigured', 'registered', 'scope']);
  assert.equal(registerDeviceNotifications(grant(), { deviceToken: token, environment: 'production', enabled: true }).providerConfigured, false);
  fs.chmodSync(key, 0o644); assert.equal(loadAPNsConfiguration(), null);
  assert.throws(() => loadAPNsConfiguration({ strict: true }), { code: 'APNS_CONFIGURATION_INVALID' });
});

test('notification registration stays within exact device/resource grants, catalog opt-in and fixed RPC fields', () => {
  const row = grant();
  assert.throws(() => register(row, { scope: 'terminals' }), { code: 'FORBIDDEN' });
  assert.deepEqual(register(row), { registered: true, enabled: true, providerConfigured: false, scope: 'session' });
  const saved = listRecords('core.push.registration')[0];
  assert.equal(saved.hostHints, false, 'Unnegotiated clients retain their legacy payload shape');
  for (const hostHints of ['true', 1, null]) {
    assert.throws(() => register(row, { hostHints }), { code: 'INVALID_REQUEST' });
    assert.throws(() => validateRequest({ v: 1, protocol: 'bzzy-core', type: 'request', id: 'request', resource: row.resource,
      op: 'notifications.register', params: { deviceToken: token, environment: 'sandbox', enabled: true, hostHints } }), { code: 'INVALID_REQUEST' });
  }
  putRecord('core.push.registration', saved.id, { ...saved, enabledSince: saved.enabledSince - 10_000 });
  register(row);
  assert.equal(getRecord('core.push.registration', saved.id).enabledSince, saved.enabledSince - 10_000, 'Foreground token refresh preserves queued background alerts');
  assert.equal(authorizedPushRegistration(saved, row.sessionId), true);
  assert.equal(authorizedPushRegistration(saved, session().id), false);
  assert.throws(() => register(grant({ peer: 'another-phone' })), { code: 'FORBIDDEN' });
  assert.equal(updateDeviceNotifications(row, { enabled: false }).enabled, false);
  assert.deepEqual(revokeDeviceNotifications(row, {}), { revoked: true });
  assert.equal(listRecords('core.push.registration')[0].deviceToken, undefined);
  for (const field of ['topic', 'url', 'recipient', 'sessionId', 'hostId', 'message']) {
    assert.throws(() => validateRequest({ v: 1, protocol: 'bzzy-core', type: 'request', id: 'request', resource: row.resource,
      op: 'notifications.register', params: { deviceToken: token, environment: 'sandbox', enabled: true, [field]: 'denied' } }));
  }
  assert.equal(sanitize({ deviceToken: token }).deviceToken, '[redacted]');
});

test('one phone token stays privately registered on two Core hosts with independently pinned alert routes and collapse IDs', async () => {
  const { sessionPermissions } = await import('../src/engine/session-access.js');
  const hosts = [hostId, 'R'.repeat(43)], bindings = [], sendsByHost = [], goalEventID = randomUUID(), updateEventID = randomUUID();
  for (const [index, host] of hosts.entries()) {
    process.env.BZZY_HOME = path.join(directory, 'host-' + index);
    fs.mkdirSync(process.env.BZZY_HOME, { mode: 0o700 });
    const row = grant({ catalog: true, agentAccess: true, host }), cfg = configuration(), sends = [];
    Object.assign(row, { shareAccess: true, permissions: [...sessionPermissions] });
    putRecord('core.relay.grant', row.id, row);
    const access = getRecord('access-token', digest(row.token));
    putRecord('access-token', digest(row.token), { ...access, permissions: [...sessionPermissions] });
    register(row, { scope: 'authorized', hostHints: true });
    const selected = getRecord('session', row.sessionId); selected.alias = 'Example'; putRecord('session', selected.id, selected);
    // Queued/model-controlled metadata cannot redirect either alert family.
    outbox(selected, 'goal.completed', { id: goalEventID, replyPreview: 'Verified result.', hostId: hosts[1 - index] });
    const update = { id: updateEventID, type: 'system.update_available', target: 'b'.repeat(40), hostId: hosts[1 - index], occurredAt: new Date(Date.now() + 20).toISOString() };
    putRecord('core.update.status', 'default', { phase: 'ready', available: true, target: update.target });
    putRecord('outbox', 'system-update-test', { event: update, deliveries: {} });
    const worker = new CorePushWorker({ configurationLoader: () => cfg, hostID: () => host,
      clientFactory: () => ({ send: async value => { sends.push(value); return { accepted: true, apnsId: value.id }; }, close() {} }) });
    try { await worker.tick(); await worker.tick(); } finally { worker.close(); }
    assert.equal(sends.length, 2);
    for (const sent of sends) {
      assert.equal(sent.payload.bzzy.hostId, host);
      assert.match(sent.collapseID, /^[a-f0-9]{64}$/);
      assert.equal(sent.payload.bzzy.eventId, sent.collapseID);
      const payload = JSON.stringify(sent.payload);
      assert.ok(!payload.includes(token)); assert.ok(!payload.includes(row.token)); assert.ok(!payload.includes('/private/workspace'));
    }
    assert.deepEqual(sends.find(sent => sent.payload.bzzy.destination === 'terminal').payload.aps.alert,
      { title: 'Goal achieved - Example', body: 'Verified result.' });
    assert.equal(sends.find(sent => sent.payload.bzzy.destination === 'updates').payload.bzzy.resource, undefined);
    bindings.push({ home: process.env.BZZY_HOME, row }); sendsByHost.push(sends);
  }
  for (const destination of ['terminal', 'updates']) {
    const [first, second] = sendsByHost.map(sends => sends.find(sent => sent.payload.bzzy.destination === destination));
    assert.notEqual(first.collapseID, second.collapseID, 'A host cannot replace another host alert on the same phone');
    assert.notEqual(first.payload.aps['thread-id'], second.payload.aps['thread-id']);
  }
  process.env.BZZY_HOME = bindings[0].home;
  revokeDeviceNotifications(bindings[0].row, {});
  assert.equal(listRecords('core.push.registration')[0].deviceToken, undefined);
  process.env.BZZY_HOME = bindings[1].home;
  assert.equal(listRecords('core.push.registration')[0].enabled, true, 'Revoking one private host binding cannot revoke the other');
  assert.equal(authorizedPushRegistration(listRecords('core.push.registration')[0]), true);
});

test('legacy bindings keep iOS v1 notification keys until the device explicitly negotiates host hints', async () => {
  const { sessionPermissions } = await import('../src/engine/session-access.js');
  const row = grant({ catalog: true, agentAccess: true }), cfg = configuration(), sends = [];
  Object.assign(row, { shareAccess: true, permissions: [...sessionPermissions] }); putRecord('core.relay.grant', row.id, row);
  const access = getRecord('access-token', digest(row.token));
  putRecord('access-token', digest(row.token), { ...access, permissions: [...sessionPermissions] });
  register(row, { scope: 'authorized' });
  const saved = listRecords('core.push.registration')[0], { hostHints: ignored, ...legacyBinding } = saved;
  putRecord('core.push.registration', saved.id, legacyBinding);
  const selected = getRecord('session', row.sessionId);
  outbox(selected, 'goal.completed', { replyPreview: 'Saved result.' });
  const update = { id: randomUUID(), type: 'system.update_available', target: 'c'.repeat(40), occurredAt: new Date(Date.now() + 20).toISOString() };
  putRecord('core.update.status', 'default', { phase: 'ready', available: true, target: update.target });
  putRecord('outbox', 'legacy-update', { event: update, deliveries: {} });
  const worker = new CorePushWorker({ configurationLoader: () => cfg, hostID: () => hostId,
    clientFactory: () => ({ send: async value => { sends.push(value); return { accepted: true, apnsId: value.id }; }, close() {} }) });
  try {
    await worker.tick(); assert.equal(sends.length, 2);
    const legacyKeys = new Set(['v', 'eventId', 'destination', 'resource', 'sessionId', 'agentId']);
    for (const sent of sends) {
      assert.equal(sent.payload.bzzy.hostId, undefined);
      assert.ok(Object.keys(sent.payload.bzzy).every(key => legacyKeys.has(key)), 'Core-first updates preserve the old strict iOS parser');
    }
    register(row, { scope: 'authorized', hostHints: true });
    assert.equal(getRecord('core.push.registration', saved.id).enabledSince, saved.enabledSince, 'Negotiating metadata retains queued-event eligibility');
    outbox(selected, 'goal.stalled', { replyPreview: 'Needs attention.' });
    await worker.tick(); assert.equal(sends.length, 3); assert.equal(sends.at(-1).payload.bzzy.hostId, hostId);
    register(row, { scope: 'authorized', hostHints: false });
    outbox(selected, 'goal.waiting_for_input');
    await worker.tick(); assert.equal(sends.length, 4); assert.equal(sends.at(-1).payload.bzzy.hostId, undefined);
  } finally { worker.close(); }
});

test('real HTTP/2 APNs wire uses ES256 JWT, fixed topic/alert headers, bounded generic payload and token invalidation', async t => {
  const cfg = configuration(), calls = []; let responseStatus = 200;
  const server = http2.createServer();
  server.on('stream', (stream, headers) => {
    let body = ''; stream.on('data', value => { body += value; });
    stream.on('end', () => { calls.push({ headers, body }); stream.respond({ ':status': responseStatus, 'apns-id': headers['apns-id'] });
      stream.end(responseStatus === 200 ? '' : JSON.stringify({ reason: 'Unregistered', timestamp: Date.now() })); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const client = new APNsClient({ configuration: cfg, endpoint, allowInsecureLocal: true });
  t.after(() => { client.close(); server.close(); });
  const payload = { aps: { alert: { title: 'BZZY', body: 'A goal update is available.' } }, bzzy: { v: 1, eventId: 'opaque', destination: 'terminal' } };
  assert.equal((await client.send({ token, payload, collapseID: 'dedup' })).accepted, true);
  const request = calls[0], jwt = request.headers.authorization.slice(7).split('.');
  assert.equal(request.headers[':path'], '/3/device/' + token);
  assert.equal(request.headers['apns-topic'], 'app.bzzy.ios'); assert.equal(request.headers['apns-push-type'], 'alert');
  assert.equal(request.headers['apns-priority'], '10');
  assert.deepEqual(JSON.parse(Buffer.from(jwt[0], 'base64url')), { alg: 'ES256', kid: cfg.keyId });
  assert.equal(JSON.parse(Buffer.from(jwt[1], 'base64url')).iss, cfg.teamId);
  assert.equal(verify('sha256', Buffer.from(jwt.slice(0, 2).join('.')), { key: createPublicKey(cfg.privateKey), dsaEncoding: 'ieee-p1363' }, Buffer.from(jwt[2], 'base64url')), true);
  assert.deepEqual(JSON.parse(request.body), payload);
  await client.send({ token, payload, collapseID: 'dedup' }); assert.equal(calls[1].headers.authorization, request.headers.authorization);
  responseStatus = 410;
  await assert.rejects(client.send({ token, payload, collapseID: 'dedup' }), error => error.code === 'APNS_TOKEN_INVALID' && error.invalidated && error.permanent);
  assert.throws(() => new APNsClient({ configuration: cfg, endpoint: 'http://example.com', allowInsecureLocal: true }), { code: 'APNS_CONFIGURATION_INVALID' });
});

test('every stalled outcome is saved once and sent through APNs without a connected phone socket', async () => {
  const row = grant({ catalog: true }), cfg = configuration(), sends = [];
  register(row, { scope: 'terminals' });
  const worker = new CorePushWorker({ configurationLoader: () => cfg, hostID: () => hostId,
    clientFactory: () => ({ send: async value => { sends.push(value); return { accepted: true, apnsId: value.id }; }, close() {} }) });
  try {
    for (const [status, reason] of [['blocked', 'A required source is unavailable.'], ['usage_limited', 'Provider quota reached.'],
      ['budget_limited', 'Runtime limit reached.'], ['awaiting_review', 'Acceptance needs review.'], ['paused', 'turn_limit'], ['paused', 'recovery_required']]) {
      const selected = session(); selected.alias = 'Stalled goal'; selected.goal = { ...newGoal('Check this goal'), status, reason };
      saveSession(selected); saveSession(selected);
      const entries = listRecords('outbox').filter(item => item.event.sessionId === selected.id);
      assert.equal(entries.length, 1, status + ':' + reason); assert.equal(entries[0].event.type, 'goal.stalled');
      await worker.tick(); await worker.tick();
      assert.equal(sends.filter(item => item.payload.bzzy.sessionId === selected.id).length, 1);
      assert.equal(sends.at(-1).payload.aps.alert.title, 'Goal stalled - Stalled goal');
      assert.equal(sends.at(-1).payload.aps.alert.body, reason);
    }
    const selected = session(); selected.goal = newGoal('A crashed runner must alert'); selected.deferTerminalNotification = true; selected.executionState = 'running';
    saveSession(selected);
    const executionId = randomUUID();
    putRecord('execution', executionId, { id: executionId, sessionId: selected.id, state: 'running', goal: true, runner: null, runnerExitedAt: new Date().toISOString(), runnerExitCode: 1 });
    superviseExecutions();
    const failure = listRecords('outbox').filter(item => item.event.sessionId === selected.id);
    assert.equal(failure.length, 1, 'forced runner finalization must release notification deferral');
    assert.equal(failure[0].event.type, 'goal.stalled');
    await worker.tick(); assert.ok(sends.some(item => item.payload.bzzy.sessionId === selected.id));
    assert.equal(getRecord('session', selected.id).deferTerminalNotification, undefined);
  } finally { worker.close(); }
});

test('catalog notifications cover future CLI goals while socket-free, exclude internal contexts and deduplicate durable outbox events', async () => {
  const row = grant({ catalog: true }), cfg = configuration(), sends = [];
  register(row, { scope: 'terminals', hostHints: true });
  const futureTerminal = session(), internal = session('core-assistant');
  outbox(futureTerminal); outbox(internal); outbox(session(), 'text');
  const worker = new CorePushWorker({ configurationLoader: () => cfg, hostID: () => hostId,
    clientFactory: () => ({ send: async value => { sends.push(value); return { accepted: true, apnsId: value.id }; }, close() {} }) });
  try {
    await worker.tick(); await worker.tick();
    assert.equal(sends.length, 1); const serialized = JSON.stringify(sends[0].payload);
    assert.equal(sends[0].payload.aps.alert.body, 'PRIVATE GOAL TEXT'); assert.ok(!serialized.includes('/private/workspace'));
    assert.equal(sends[0].payload.bzzy.resource, row.resource);
    assert.equal(sends[0].payload.bzzy.hostId, hostId);
    assert.equal(sends[0].payload.bzzy.sessionId, futureTerminal.id);
    assert.equal(listRecords('core.push.delivery')[0].state, 'sent');
    assert.ok(!JSON.stringify(listRecords('core.push.delivery')).includes(token));
    putRecord('core.relay.grant', row.id, { ...row, revokedAt: new Date().toISOString() });
    outbox(futureTerminal, 'goal.stalled'); await worker.tick(); assert.equal(sends.length, 1);
  } finally { worker.close(); }
});

test('APNs explicit rejection retries with backoff, uncertain dispatch never retries, and invalid tokens are removed', async () => {
  const row = grant(), cfg = configuration(); register(row);
  const selected = getRecord('session', row.sessionId); outbox(selected);
  let time = Date.now() + 100, sends = 0, failure = new PushError('APNS_REJECTED', { status: 503 });
  const worker = new CorePushWorker({ configurationLoader: () => cfg, hostID: () => hostId, clock: () => time,
    clientFactory: () => ({ send: async () => { sends++; throw failure; }, close() {} }) });
  try {
    await worker.tick(); assert.equal(sends, 1); assert.equal(listRecords('core.push.delivery')[0].state, 'retry');
    await worker.tick(); assert.equal(sends, 1);
    time += 5000; failure = new PushError('APNS_UNAVAILABLE', { uncertain: true });
    await worker.tick(); assert.equal(sends, 2); assert.equal(listRecords('core.push.delivery')[0].state, 'uncertain');
    time += 100_000; await worker.tick(); assert.equal(sends, 2);
    outbox(selected, 'goal.stalled'); failure = new PushError('APNS_TOKEN_INVALID', { invalidated: true, permanent: true, timestamp: Date.now() + 50_000 });
    await worker.tick(); assert.equal(sends, 3);
    const registration = listRecords('core.push.registration')[0]; assert.equal(registration.enabled, false); assert.equal(registration.deviceToken, undefined);
  } finally { worker.close(); }
});

test('authorized notifications include only explicitly approved live agent definitions and never widen an agent-only grant to terminals', async () => {
  new CoreWorkspaces().configure({ path: path.join(directory, 'Managed'), create: true }, { requestId: randomUUID(), expectedRevision: 0 });
  const agents = new CoreAgents(), agent = agents.create({ name: 'Private purpose', instructions: 'Private durable mission.', provider: 'codex', effort: 'default' }, { requestId: randomUUID() });
  const row = grant({ agentAccess: true }), cfg = configuration(), sends = [];
  assert.throws(() => register(row, { scope: 'terminals' }), { code: 'FORBIDDEN' });
  assert.equal(register(row, { scope: 'authorized', hostHints: true }).scope, 'authorized');
  outbox(getRecord('session', agent.sessionId)); outbox(session()); outbox(session('core-assistant'));
  const worker = new CorePushWorker({ configurationLoader: () => cfg, hostID: () => hostId,
    clientFactory: () => ({ send: async value => { sends.push(value); return { accepted: true, apnsId: value.id }; }, close() {} }) });
  try {
    await worker.tick(); assert.equal(sends.length, 1);
    assert.equal(sends[0].payload.bzzy.destination, 'agents'); assert.equal(sends[0].payload.bzzy.agentId, agent.id);
    assert.equal(sends[0].payload.bzzy.hostId, hostId);
    assert.equal(sends[0].payload.bzzy.sessionId, agent.sessionId);
    assert.equal(sends[0].payload.aps.alert.title, 'Goal achieved');
    assert.match(sends[0].payload.aps['thread-id'], /^[a-f0-9]{64}$/);
    assert.ok(!JSON.stringify(sends[0].payload).includes(agent.name));
    agents.archive({ agentId: agent.id, expectedRevision: 1 }, { requestId: randomUUID() });
    outbox(getRecord('session', agent.sessionId), 'goal.stalled');
    await worker.tick(); assert.equal(sends.length, 1, 'Archived agents no longer authorize background notifications');
  } finally { worker.close(); }
});

test('missing Apple configuration has a durable waiting state and dispatches after secure host setup', async () => {
  const row = grant(); register(row); const selected = getRecord('session', row.sessionId); outbox(selected);
  let cfg = null, sends = 0;
  const worker = new CorePushWorker({ configurationLoader: () => cfg, hostID: () => hostId,
    clientFactory: () => ({ send: async value => { sends++; return { accepted: true, apnsId: value.id }; }, close() {} }) });
  try {
    await worker.tick(); const waiting = listRecords('core.push.delivery')[0];
    assert.equal(waiting.state, 'waiting_for_configuration'); assert.equal(waiting.code, 'APNS_SETUP_REQUIRED'); assert.equal(sends, 0);
    cfg = configuration(); await worker.tick(); await worker.tick();
    assert.equal(sends, 1); assert.equal(listRecords('core.push.delivery')[0].state, 'sent');
  } finally { worker.close(); }
});

test('a rotating bounded scan cannot starve a goal behind more than one thousand outbox records', async () => {
  const row = grant(); register(row); const cfg = configuration(), selected = getRecord('session', row.sessionId);
  const event = { id: randomUUID(), sessionId: selected.id, type: 'goal.completed', occurredAt: new Date(Date.now() + 10).toISOString(), objective: 'Age check' };
  putRecord('outbox', 'zz-last-sorted', { event, deliveries: {} });
  for (let index = 0; index < 1100; index++) putRecord('outbox', 'aa-' + String(index).padStart(5, '0'), { event: { ...event, type: 'ignored' }, deliveries: {} });
  const sends = [], worker = new CorePushWorker({ configurationLoader: () => cfg, hostID: () => hostId,
    clientFactory: () => ({ send: async value => { sends.push(value); return { accepted: true, apnsId: value.id }; }, close() {} }) });
  try { for (let tick = 0; tick < 8; tick++) await worker.tick(); assert.equal(sends.length, 1); }
  finally { worker.close(); }
});

test('minimal alerts contain the requested alias/objective, bound their size and omit credential-like text', async () => {
  const { goalAlert } = await import('../src/push/worker.js');
  assert.deepEqual(goalAlert({ type: 'goal.completed', objective: 'Tell me Elon Musk age', replyPreview: 'The final answer.' }, { alias: 'Research' }), { title: 'Goal achieved - Research', body: 'The final answer.' });
  const alert = goalAlert({ type: 'goal.stalled', objective: 'Use API_KEY=private-value' }, { alias: 'My token' });
  assert.equal(alert.title, 'Goal stalled'); assert.equal(alert.body, 'Open BZZY for details.');
  const preview = goalAlert({ type: 'goal.completed', replyPreview: 'a'.repeat(500) }, {}).body;
  assert.equal(preview.length, 180); assert.ok(preview.endsWith('...'));
});

test('new-version push alerts route to Settings only for the full own-phone grant and honor its notification toggle', async () => {
 const { sessionPermissions } = await import('../src/engine/session-access.js');
 const { updateDeviceKey } = await import('../src/engine/update-access.js');
 const row = grant({ catalog: true, agentAccess: true }), cfg = configuration(), sends = [];
 Object.assign(row, { shareAccess: true, permissions: [...sessionPermissions] }); putRecord('core.relay.grant', row.id, row);
 const access = getRecord('access-token', digest(row.token)); putRecord('access-token', digest(row.token), { ...access, permissions: [...sessionPermissions] }); register(row, { scope: 'authorized', hostHints: true });
 const event = { id: randomUUID(), type: 'system.update_available', occurredAt: new Date(Date.now() + 20).toISOString(), target: 'b'.repeat(40) };
 putRecord('core.update.status', 'default', { phase: 'ready', available: true, target: event.target });
 putRecord('outbox', 'system-update-test', { event, deliveries: {} });
 const worker = new CorePushWorker({ configurationLoader: () => cfg, hostID: () => hostId, clientFactory: () => ({ send: async value => { sends.push(value); return { accepted: true, apnsId: value.id }; }, close() {} }) });
 try {
  await worker.tick(); await worker.tick(); assert.equal(sends.length, 1);
  assert.equal(sends[0].payload.aps.alert.title, 'BZZY update available'); assert.equal(sends[0].payload.bzzy.destination, 'updates');
  assert.equal(sends[0].payload.bzzy.hostId, hostId);
  assert.equal(sends[0].payload.bzzy.sessionId, undefined); assert.equal(sends[0].payload.bzzy.resource, undefined);
  putRecord('core.update.device', updateDeviceKey(row), { notificationsEnabled: false });
  putRecord('outbox', 'system-update-next', { event: { ...event, id: randomUUID() }, deliveries: {} }); await worker.tick(); assert.equal(sends.length, 1);
  putRecord('core.update.device', updateDeviceKey(row), { notificationsEnabled: true });
  putRecord('core.update.status', 'default', { phase: 'ready', available: false, current: event.target, target: event.target });
  await worker.tick(); assert.equal(sends.length, 1, 'an installed update must not generate a stale availability alert');
 } finally { worker.close(); }
});
