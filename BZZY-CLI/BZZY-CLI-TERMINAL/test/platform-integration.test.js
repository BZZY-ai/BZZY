import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { BzzyClient } from '../src/api-client.js';
import { ensureRuntime, runtimeRequest, runtimeInfo, effectiveInputOwner } from '../src/runtime.js';
import { createSession, saveSession } from '../src/store.js';
import { BUILTINS, saveConfig } from '../src/providers.js';
import { appendEvent, digest, getRecord, putRecord, listRecords } from '../src/database.js';
import { captureEnvironment, toolEnvironment } from '../src/execution-environment.js';
import { subscriptionEnvironment } from '../src/auth.js';
import { agentInstructions, generationSecurityPolicy } from '../src/instructions.js';
import { snapshotWorkspace, captureEvidence } from '../src/evidence.js';
import { root } from '../src/process.js';
import { identityAlive } from '../src/recovery.js';

let directory, saved;
const keys = ['BZZY_HOME', 'BZZY_CODEX_HOME', 'BZZY_CODEX_BIN', 'BZZY_TEST_LOG'];
test.beforeEach(() => {
  directory = fs.realpathSync(fs.mkdtempSync(path.join(process.platform === 'darwin' ? '/private/tmp' : os.tmpdir(), 'bzzy-platform-')));
  saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { BZZY_HOME: path.join(directory, 'private'), BZZY_CODEX_HOME: path.join(directory, 'native'),
    BZZY_CODEX_BIN: path.join(root, 'test/fixtures/codex.mjs'), BZZY_TEST_LOG: path.join(directory, 'backend.jsonl') });
  fs.mkdirSync(path.join(directory, 'project'));
});
test.afterEach(async () => {
  const info = runtimeInfo();
  if (info && identityAlive(info.identity)) {
    await runtimeRequest(info, 'POST', '/shutdown', {}).catch(() => {});
    for (let i = 0; i < 100 && identityAlive(info.identity); i++) await new Promise(resolve => setTimeout(resolve, 20));
  }
  for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  fs.rmSync(directory, { recursive: true, force: true });
});
const session = () => createSession(BUILTINS.codex, path.join(directory, 'project'));
const clientFor = (owner, grant) => new BzzyClient({ url: owner.url, token: grant.token });

test('generation instructions include the mandatory policy in chat, goals, workers and document drafting', () => {
  const s = session();
  for (const [fields, options] of [[{}, {}], [{}, { goalMode: true }], [{ role: 'executor' }, {}], [{ role: 'reviewer' }, {}], [{ role: 'bestie' }, { goalMode: true }], [{}, { documentOnly: true }]]) {
    assert.ok(agentInstructions({ ...s, ...fields }, options).includes(generationSecurityPolicy));
  }
  const platformPolicy = new URL('../../../SECURITY.md', import.meta.url);
  if (fs.existsSync(platformPolicy)) assert.ok(fs.readFileSync(platformPolicy, 'utf8').includes('"' + generationSecurityPolicy + '"'));
});

test('execution inherits declared configuration and provider keys; tools and subscription backends drop provider credentials', () => {
  saveConfig({ providers: { example: { envKey: 'EXAMPLE_PROVIDER_KEY' } }, executionEnvironment: { allow: ['PROJECT_REGION'] } });
  const source = { PATH: '/safe/bin', BZZY_ENV_ALLOW: '', PROJECT_REGION: 'local', AWS_SECRET_ACCESS_KEY: 'fixture-unrelated-secret',
    GITHUB_TOKEN: 'fixture-unrelated-token', EXAMPLE_PROVIDER_KEY: 'fixture-provider-key', DEEPSEEK_API_KEY: 'fixture-model-key', NODE_OPTIONS: '--inspect', RANDOM_SETTING: 'private',
    BZZY_TELEGRAM_BOT_TOKEN: 'fixture-bot-token', BZZY_TELEGRAM_CHAT_ID: 'fixture-chat' };
  assert.deepEqual(captureEnvironment(source), { PATH: '/safe/bin', BZZY_ENV_ALLOW: '', PROJECT_REGION: 'local', EXAMPLE_PROVIDER_KEY: 'fixture-provider-key', DEEPSEEK_API_KEY: 'fixture-model-key' });
  assert.deepEqual(toolEnvironment(source), { PATH: '/safe/bin', BZZY_ENV_ALLOW: '', PROJECT_REGION: 'local' });
  const previous = process.env.EXAMPLE_PROVIDER_KEY; process.env.EXAMPLE_PROVIDER_KEY = source.EXAMPLE_PROVIDER_KEY;
  try { assert.equal(subscriptionEnvironment('codex').EXAMPLE_PROVIDER_KEY, undefined); }
  finally { if (previous === undefined) delete process.env.EXAMPLE_PROVIDER_KEY; else process.env.EXAMPLE_PROVIDER_KEY = previous; }
  saveConfig({ executionEnvironment: { allow: ['MY_PRIVATE_KEY'] } });
  assert.throws(() => captureEnvironment(source), /non-secret/);
});

test('snapshots exclude tracked and untracked credential stores and evidence capture refuses them', () => {
  const s = session();
  for (const relative of ['source.txt', '.env', '.ssh/id_ed25519', '.aws/credentials', '.config/gcloud/application_default_credentials.json', '.docker/config.json', '.npmrc', 'nested/auth.json', 'nested/private.pem', '._source.txt']) {
    const file = path.join(s.cwd, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, relative === 'source.txt' ? 'public source' : 'fixture-private-material');
  }
  assert.deepEqual(Object.keys(snapshotWorkspace(s).manifest), ['source.txt']);
  const git = spawnSync('git', ['init', '-q', s.cwd]); assert.equal(git.status, 0);
  assert.equal(spawnSync('git', ['-C', s.cwd, 'add', '.']).status, 0);
  assert.deepEqual(Object.keys(snapshotWorkspace(s).manifest), ['source.txt']);
  for (const relative of ['.env', '.ssh/id_ed25519', '.docker/config.json', 'nested/private.pem']) assert.throws(() => captureEvidence(s, relative), /Private credential/);
  fs.writeFileSync(path.join(directory, 'outside.txt'), 'private outside'); fs.symlinkSync(path.join(directory, 'outside.txt'), path.join(s.cwd, 'escape'));
  assert.throws(() => captureEvidence(s, 'escape'), /symlink/);
  assert.throws(() => captureEvidence(s, '../outside.txt'), /outside/);
  assert.deepEqual(listRecords('artifact'), []);
});

test('session grants default to observation and validate scopes, lifetimes and recipient identity', async () => {
  const s = session(), owner = new BzzyClient(await ensureRuntime());
  const grant = await owner.observerToken(s.id), observer = clientFor(owner, grant);
  assert.deepEqual(grant.permissions, ['observe']); assert.equal(grant.token.length, 43);
  assert.ok(getRecord('access-token', digest(grant.token))); assert.equal(JSON.stringify(await owner.grants()).includes(grant.token), false);
  assert.equal((await observer.capabilities()).revocableAccess, true);
  for (const options of [{ expiresInSeconds: '60' }, { expiresInSeconds: 0 }, { expiresInSeconds: 2592001 }, { includeChildren: 'true' }, { permissions: ['observe', 'execute'], recipient: 'device-A' }, { permissions: ['observe', 'claim'] }, { permissions: ['observe', 'admin'] }]) {
    await assert.rejects(owner.sessionToken(s.id, options), error => error.status === 400);
  }
  await assert.rejects(observer.claim(s.id, 'viewer'), error => error.status === 403);
  await assert.rejects(observer.grants(), error => error.status === 403);
  await assert.rejects(observer.revokeToken(grant.id), error => error.status === 403);
  await assert.rejects(observer.sessionToken(s.id), error => error.status === 403);
  const other = session(); await assert.rejects(observer.session(other.id), error => error.status === 403);
  assert.deepEqual((await observer.sessions()).map(s => s.id), [s.id]);
});

test('control permissions cannot spoof another credential, widen host execution policy or take over implicitly', async () => {
  const s = session(), owner = new BzzyClient(await ensureRuntime());
  const options = { permissions: ['observe', 'claim', 'execute', 'answer', 'pause'], recipient: 'device-A' };
  const a = clientFor(owner, await owner.sessionToken(s.id, options)), b = clientFor(owner, await owner.sessionToken(s.id, { ...options, recipient: 'device-B' }));
  await a.claim(s.id, 'same-owner');
  await assert.rejects(b.claim(s.id, 'same-owner'), error => error.status === 409);
  await assert.rejects(b.control(s.id, { owner: 'same-owner', action: 'pause', requestId: randomUUID() }), error => error.status === 409);
  await b.release(s.id, 'same-owner'); assert.equal(effectiveInputOwner(s.id).principal.startsWith('grant:'), true);
  await assert.rejects(a.claim(s.id, 'different-owner', true), error => error.status === 403);
  for (const change of [{ options: { yolo: true } }, { options: { policy: { mode: 'workspace-write' } } }, { environment: { NODE_OPTIONS: '--inspect' } }]) {
    await assert.rejects(a.request('POST', `/sessions/${s.id}/execute`, { owner: 'same-owner', prompt: 'denied', ...change }, randomUUID()), error => error.status === 403);
  }
  await assert.rejects(a.control(s.id, { owner: 'same-owner', action: 'cancel', requestId: randomUUID() }), error => error.status === 403);
  const question = { id: randomUUID(), sessionId: s.id, question: 'Select an approved reference', state: 'pending' }; putRecord('question', question.id, question);
  const answer = { owner: 'same-owner', questionId: question.id, answer: 'reference-A', requestId: randomUUID() };
  assert.deepEqual(await a.answer(s.id, answer), await a.answer(s.id, answer));
  assert.equal(getRecord('question', question.id).answer, 'reference-A');
  assert.equal(listRecords('execution').length, 0);
  await owner.claim(s.id, 'local-owner', true);
  await assert.rejects(a.control(s.id, { owner: 'local-owner', action: 'pause', requestId: randomUUID() }), error => error.status === 409);
});

test('explicit child scope excludes child snapshots and questions; child-only grants remain discoverable', async () => {
  const parent = session(), child = session(); child.parentSessionId = parent.id; saveSession(child);
  putRecord('activity', 'child-activity', { id: 'child-activity', sessionId: child.id, summary: 'private child', createdAt: new Date().toISOString() });
  putRecord('question', 'child-question', { id: 'child-question', sessionId: child.id, state: 'pending' });
  const owner = new BzzyClient(await ensureRuntime()), grant = await owner.sessionToken(parent.id, { includeChildren: false }), observer = clientFor(owner, grant);
  await assert.rejects(observer.session(child.id), error => error.status === 403);
  assert.deepEqual((await observer.activities(parent.id)).items, []);
  assert.deepEqual((await observer.session(parent.id)).children, []); assert.deepEqual((await observer.session(parent.id)).questions, []);
  const childObserver = clientFor(owner, await owner.observerToken(child.id));
  assert.deepEqual((await childObserver.sessions()).map(s => s.id), [child.id]);
  assert.equal((await clientFor(owner, await owner.observerToken(parent.id)).session(child.id)).session.id, child.id);
});

test('revocation closes an existing stream, releases input and survives service restart without cancelling work', async () => {
  const s = session(), owner = new BzzyClient(await ensureRuntime());
  const grant = await owner.sessionToken(s.id, { permissions: ['observe', 'claim', 'pause'], recipient: 'device-A' }), controller = clientFor(owner, grant);
  await controller.claim(s.id, 'device-owner');
  const event = appendEvent(s.id, 'activity', { summary: 'visible before revocation' });
  const abort = new AbortController(), timeout = setTimeout(() => abort.abort(), 10000);
  const stream = controller.stream(s.id, { after: event.seq - 1, signal: abort.signal, reconnectDelayMs: 0 });
  try {
    assert.equal((await stream.next()).value.seq, event.seq);
    const revoked = await owner.revokeToken(grant.id); assert.ok(revoked.revokedAt);
    assert.deepEqual(await owner.revokeToken(grant.id), revoked);
    assert.equal(effectiveInputOwner(s.id), null);
    appendEvent(s.id, 'activity', { summary: 'must not be streamed' });
    await assert.rejects(stream.next(), error => error.status === 401);
    await assert.rejects(controller.session(s.id), error => error.status === 401);
  } finally { clearTimeout(timeout); abort.abort(); await stream.return(); }
  const info = runtimeInfo(); await runtimeRequest(info, 'POST', '/shutdown', {});
  for (let i = 0; i < 100 && identityAlive(info.identity); i++) await new Promise(resolve => setTimeout(resolve, 20));
  const restarted = await ensureRuntime(); controller.url = restarted.url;
  await assert.rejects(controller.session(s.id), error => error.status === 401);
  assert.equal(listRecords('execution').length, 0);
  const audit = JSON.stringify(listRecords('access-token')); assert.ok(!audit.includes(grant.token));
});

test('expired credentials fail authentication and cannot retain input ownership', async () => {
  const s = session(), owner = new BzzyClient(await ensureRuntime());
  const grant = await owner.sessionToken(s.id, { permissions: ['observe', 'claim'], recipient: 'device-A' }), controller = clientFor(owner, grant);
  await controller.claim(s.id, 'device-owner');
  const record = getRecord('access-token', digest(grant.token)); putRecord('access-token', digest(grant.token), { ...record, expiresAt: Date.now() - 1 });
  assert.equal(effectiveInputOwner(s.id), null);
  await assert.rejects(controller.claim(s.id, 'device-owner'), error => error.status === 401);
  await owner.claim(s.id, 'local-owner'); assert.equal(effectiveInputOwner(s.id).owner, 'local-owner');
});

test('a scoped client starts exactly one managed execution and revocation leaves that accepted work intact', async () => {
  const s = session(), owner = new BzzyClient(await ensureRuntime());
  const grant = await owner.sessionToken(s.id, { permissions: ['observe', 'claim', 'execute'], recipient: 'device-A' }), controller = clientFor(owner, grant);
  await controller.claim(s.id, 'device-owner');
  const input = { owner: 'device-owner', prompt: 'Describe the supplied source', requestId: randomUUID() };
  const [a, b] = await Promise.all([controller.execute(s.id, input), controller.execute(s.id, input)]);
  assert.equal(a.executionId, b.executionId); assert.equal(listRecords('execution').length, 1);
  await owner.revokeToken(grant.id);
  for (let i = 0; i < 200 && ['queued', 'launching', 'running'].includes(getRecord('execution', a.executionId).state); i++) await new Promise(resolve => setTimeout(resolve, 25));
  const execution = getRecord('execution', a.executionId);
  assert.equal(execution.state, 'finished'); assert.equal(execution.exitCode, 0);
  assert.equal(fs.existsSync(path.join(process.env.BZZY_HOME, 'runtime', `${execution.id}-environment.json`)), false);
});

test('expired approvals are rejected at the API even before runner expiry polling', async () => {
  const s = session(), owner = new BzzyClient(await ensureRuntime());
  await owner.claim(s.id, 'local-owner');
  const question = { id: randomUUID(), sessionId: s.id, kind: 'approval', state: 'pending', expiresAt: Date.now() - 1 };
  putRecord('question', question.id, question);
  await assert.rejects(owner.answer(s.id, { owner: 'local-owner', questionId: question.id, answer: 'yes', requestId: randomUUID() }), error => error.status === 409);
  assert.equal(getRecord('question', question.id).answer, undefined);
});

test('legacy observer credentials remain usable and gain stable revocation IDs at service startup', async () => {
  const s = session(), token = 'fixture-legacy-observer-token';
  putRecord('access-token', digest(token), { sessionId: s.id, permissions: ['observe'], expiresAt: Date.now() + 60000, createdAt: new Date().toISOString() });
  const info = await ensureRuntime(), owner = new BzzyClient(info), observer = new BzzyClient({ url: info.url, token });
  assert.equal((await observer.session(s.id)).session.id, s.id);
  const grant = (await owner.grants()).items.find(item => item.sessionId === s.id);
  assert.ok(grant.id); assert.equal(getRecord('access-token', digest(token)).id, grant.id);
  await owner.revokeToken(grant.id);
  await assert.rejects(observer.session(s.id), error => error.status === 401);
});
