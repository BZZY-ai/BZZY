import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { BzzyCore, BzzyClient } from '../src/index.js';
import { runtimeInfo, runtimeRequest, ensureRuntime } from '../src/engine/runtime.js';
import { getRecord, listRecords, appendEvent } from '../src/engine/database.js';
import { identityAlive } from '../src/engine/process-identity.js';
import { CoreMetricsClient } from '../src/metrics.js';

const root = fileURLToPath(new URL('../', import.meta.url));
let directory, core, workspace, saved;
const keys = ['BZZY_HOME', 'BZZY_CODEX_HOME', 'BZZY_CODEX_BIN', 'BZZY_TEST_LOG'];
test.before(async () => {
  saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  // macOS Unix socket paths have a small limit; its default TMPDIR is lengthy.
  directory = fs.mkdtempSync(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'bc-'));
  workspace = path.join(directory, 'project'); fs.mkdirSync(workspace);
  Object.assign(process.env, { BZZY_HOME: path.join(directory, 'private'), BZZY_CODEX_HOME: path.join(directory, 'codex'),
    BZZY_CODEX_BIN: path.join(root, 'test/fixtures/codex.mjs'), BZZY_TEST_LOG: path.join(directory, 'backend.jsonl') });
  fs.mkdirSync(process.env.BZZY_HOME);
  fs.writeFileSync(path.join(process.env.BZZY_HOME, 'config.json'), JSON.stringify({ executionEnvironment: { allow: ['BZZY_TEST_LOG'] } }));
  core = new BzzyCore();
  await core.start();
});
test.after(async () => {
  const info = runtimeInfo();
  if (info && identityAlive(info.identity)) await runtimeRequest(info, 'POST', '/shutdown', {}).catch(() => {});
  for (let attempt = 0; info && identityAlive(info.identity) && attempt < 100; attempt++) await delay(20);
  for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  fs.rmSync(directory, { recursive: true, force: true });
});
const create = () => core.createConversation({ provider: 'codex', cwd: workspace }, { requestId: randomUUID() });
async function finished(id) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const execution = getRecord('execution', id);
    if (execution && !['queued', 'launching', 'running'].includes(execution.state)) return execution;
    await delay(30);
  }
  assert.fail('The fixture execution did not finish.');
}

test('Core and a trusted host client discover the same daemon without exposing its owner token', async () => {
  const status = await core.status(), start = await core.start();
  assert.equal(status.running, true); assert.equal(start.apiVersion, 1);
  assert.equal(status.token, undefined); assert.equal(start.token, undefined);
  const original = runtimeInfo(), host = await ensureRuntime();
  assert.deepEqual(host.identity, original.identity);
  const session = create();
  assert.ok((await core.sessions()).some(item => item.id === session.id));
  const fromCLI = await runtimeRequest(host, 'GET', `/v1/sessions/${session.id}`);
  assert.equal(fromCLI.session.id, session.id);
});

test('two clients and lost acknowledgments still queue exactly one execution', async () => {
  const session = create(), owner = randomUUID(); await core.claim(session.id, owner);
  const requestId = randomUUID(), input = { owner, prompt: 'Return the fixture response.', requestId };
  const [a, b] = await Promise.all([core.execute(session.id, input), core.execute(session.id, input)]);
  assert.equal(a.executionId, b.executionId);
  await core.release(session.id, owner);
  const execution = await finished(a.executionId);
  assert.equal(execution.exitCode, 0, execution.error || (execution.logPath && fs.readFileSync(execution.logPath, 'utf8')));
  assert.equal(listRecords('execution', { sessionId: session.id }).length, 1);
  const observed = await core.session(session.id);
  assert.equal(observed.execution.id, a.executionId);
  assert.notEqual(observed.session.goal?.status, 'complete');
  await assert.rejects(core.execute(session.id, { ...input, prompt: 'Different request' }), /own input/);
});

test('successive goals in one chat attach their own model outputs without inheriting an earlier achieved claim', async () => {
  const session = core.createConversation({ provider: 'codex', model: 'fixture-model', cwd: workspace }, { requestId: randomUUID() });
  const info = runtimeInfo(), owner = randomUUID(); let previousOutput = [];
  for (const objective of ['Assess the first supplied offline observation', 'Assess the second independent offline observation']) {
    const accepted = await runtimeRequest(info, 'POST', `/sessions/${session.id}/input`, { operation: 'goal', owner, objective }, randomUUID());
    const execution = await finished(accepted.executionId); assert.equal(execution.exitCode, 0, execution.error);
    const saved = getRecord('session', session.id); assert.equal(saved.goal.status, 'complete');
    const outputs = listRecords('artifact', { sessionId: session.id }).filter(item => item.label === 'agent-output' && item.goalId === saved.goal.id);
    assert.ok(outputs.length > 0); assert.ok(outputs.every(item => saved.goal.evidence.includes(item.id)));
    assert.ok(previousOutput.every(id => !saved.goal.evidence.includes(id)), 'old goal replies are not evidence for the new goal');
    assert.ok(previousOutput.every(id => !(saved.acceptance?.requirements || []).some(requirement => requirement.evidence?.includes(id))), 'old replies are not reused by implicit model-judgment acceptance');
    previousOutput = outputs.map(item => item.id);
  }
});

test('observer subscriptions replay the same events, fail control and stop after revocation', async () => {
  const session = create(), other = create();
  const grant = await core.grantSession({ sessionId: session.id, expiresInSeconds: 60 });
  const observer = new BzzyClient({ url: `${runtimeInfo().url}/v1`, token: grant.token });
  assert.notEqual(grant.token, runtimeInfo().token);
  await assert.rejects(observer.claim(session.id, randomUUID()), { status: 403 });
  await assert.rejects(observer.session(other.id), { status: 403 });
  const expected = appendEvent(session.id, 'future.unknown', { value: 1 }), abort = new AbortController();
  for await (const event of observer.stream(session.id, { after: expected.seq - 1, signal: abort.signal })) {
    assert.equal(event.id, expected.id); abort.abort();
  }
  await core.revokeSession(grant.id);
  await assert.rejects(observer.session(session.id), { status: 401 });
});

test('Relay administration is local-owner-only and daemon startup stays offline unless enabled', async () => {
  const info = runtimeInfo();
  const snapshot = await runtimeRequest(info, 'GET', '/v1/relay/status');
  assert.equal(snapshot.status.managed, true);
  assert.equal(snapshot.status.enabled, false);
  const session = create(), grant = await core.grantSession({ sessionId: session.id, expiresInSeconds: 60 });
  for (const [method, route, body] of [['GET', 'status'], ['POST', 'connect', {}], ['POST', 'init', {}], ['POST', 'library-share-create', {}]]) {
    const response = await fetch(`${info.url}/v1/relay/${route}`, { method,
      headers: { authorization: `Bearer ${grant.token}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal(response.status, 403);
    assert.match((await response.json()).error, /local owner/);
  }
  assert.equal(fs.existsSync(path.join(process.env.BZZY_HOME, 'relay', 'host.identity.json')), false);
  await core.revokeSession(grant.id);
});

test('knowledge administration is local-owner-only and reading status never queues inference', async () => {
  const info = runtimeInfo(), session = create();
  const grant = await core.grantSession({ sessionId: session.id, recipient: randomUUID(), permissions: ['observe', 'claim', 'execute', 'pause'], expiresInSeconds: 60 });
  const before = listRecords('execution').length, jobs = listRecords('core.learning.job').length;
  const status = await runtimeRequest(info, 'POST', '/v1/knowledge/status', { sessionId: session.id });
  assert.ok(status.project.id); assert.ok(status.settings.tokenBudget > 0);
  assert.equal(listRecords('execution').length, before); assert.equal(listRecords('core.learning.job').length, jobs);
  for (const [operation, input] of [['status', { sessionId: session.id }], ['profile.update', { target: 'user', text: 'Unapproved change.', reviewed: true }], ['learning.queue', { sessionId: session.id, requestId: randomUUID() }]]) {
    const response = await fetch(`${info.url}/v1/knowledge/${operation}`, { method: 'POST', headers: { authorization: `Bearer ${grant.token}`, 'content-type': 'application/json' }, body: JSON.stringify(input) });
    assert.equal(response.status, 403); assert.match((await response.json()).error, /local owner/);
  }
  const get = await fetch(`${info.url}/v1/knowledge/status`, { headers: { authorization: `Bearer ${info.token}` } }); assert.equal(get.status, 405);
  assert.equal(listRecords('core.learning.job').length, jobs);
  await core.revokeSession(grant.id);
});

test('metrics are authenticated, cached daemon observations and revoked observers immediately lose access', async () => {
  const info = runtimeInfo(), url = `${info.url}/v1/metrics`;
  for (const headers of [{}, { authorization: 'Bearer invalid' }]) assert.equal((await fetch(url, { headers })).status, 401);
  const session = create(), grant = await core.grantSession({ sessionId: session.id, expiresInSeconds: 60 });
  const observer = new BzzyClient({ url: info.url, token: grant.token });
  const observed = await observer.metrics();
  assert.equal(observed.version, 1); assert.ok(Number.isFinite(Date.parse(observed.sampledAt)));
  assert.ok(observed.host.memory.totalBytes > 0); assert.ok(observed.core.rssBytes > 0);
  assert.equal(observed.host.memory.usedBytes + observed.host.memory.freeBytes, observed.host.memory.totalBytes);
  const trusted = await new CoreMetricsClient().read();
  assert.equal(trusted.version, observed.version); assert.ok(Date.parse(trusted.sampledAt) >= Date.parse(observed.sampledAt));
  assert.doesNotMatch(JSON.stringify(observed), /pid|hostname|identity|token|runtimeBuild|environment|path/i);
  await core.revokeSession(grant.id); await assert.rejects(observer.metrics(), { status: 401 });
});

test('a metrics view recovers after its daemon stops and cannot follow a changed private host context', { timeout: 15000 }, async () => {
  const client = new CoreMetricsClient(), before = await client.read(), old = runtimeInfo(), executions = listRecords('execution').length;
  const originalHome = process.env.BZZY_HOME, unrelated = path.join(directory, 'different-private-host');
  try {
    process.env.BZZY_HOME = unrelated;
    await assert.rejects(client.read(), { code: 'HOST_CONTEXT_CHANGED' });
    assert.equal(fs.existsSync(unrelated), false);
  } finally { process.env.BZZY_HOME = originalHome; }
  await runtimeRequest(old, 'POST', '/shutdown', {});
  for (let attempt = 0; identityAlive(old.identity) && attempt < 100; attempt++) await delay(20);
  assert.equal(identityAlive(old.identity), false);
  await assert.rejects(client.read());
  assert.equal(runtimeInfo(), null);
  await assert.rejects(client.read(), 'polling cannot restart Core');
  assert.equal(runtimeInfo(), null);
  await core.start();
  const recovered = await client.read();
  assert.equal(recovered.version, 1); assert.ok(Date.parse(recovered.sampledAt) >= Date.parse(before.sampledAt));
  assert.notDeepEqual(runtimeInfo().identity, old.identity);
  assert.equal(listRecords('execution').length, executions);
});

test('a service restart preserves history and processed cursors without creating more executions', async () => {
  const session = create(), tail = appendEvent(session.id, 'checkpoint', { evidence: [] });
  await core.processEvents(session.id, { consumerId: 'phone', handle: () => {} });
  const old = runtimeInfo(), count = listRecords('execution').length;
  await runtimeRequest(old, 'POST', '/shutdown', {});
  for (let attempt = 0; identityAlive(old.identity) && attempt < 100; attempt++) await delay(20);
  await core.start();
  assert.notDeepEqual(runtimeInfo().identity, old.identity);
  const restarted = new BzzyCore();
  assert.equal(restarted.processedCursor('phone', session.id), tail.seq);
  assert.equal((await restarted.processEvents(session.id, { consumerId: 'phone', handle: () => assert.fail('History replayed twice') })).processed, 0);
  assert.equal(listRecords('execution').length, count);
});

test('the Core status command does not start an engine or disclose listener credentials', async () => {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/bzzy-core.js', import.meta.url)), 'status'], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', chunk => output += chunk);
    child.on('error', reject); child.on('close', code => resolve({ code, output }));
  });
  assert.equal(result.code, 0); assert.equal(JSON.parse(result.output).running, true);
  assert.doesNotMatch(result.output, /token|environment|runtimeBuild/);
});
