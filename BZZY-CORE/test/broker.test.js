import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BzzyCore, createToolBroker, filesystemIntegration } from '../src/index.js';
import { getRecord, putRecord, events } from '../src/engine/database.js';

let directory, workspace, previousHome, session, admin, scope, grant;
const principal = { userId: 'owner', workspaceId: 'project', agentId: 'auditor' };
const expiresAt = () => Date.now() + 60000;
const mailbox = {
  id: 'mailbox', description: 'Test read-only account adapter; no external network calls.', capabilities: ['mail.read', 'mail.headers'],
  authentication: { required: true, scopes: ['mail.read'] }, rateLimit: { calls: 5, intervalSeconds: 60 }, errors: ['UNAVAILABLE'],
  tools: [{ name: 'read', description: 'Read a permitted message summary.', capability: 'mail.read', effect: 'read',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false } }],
};
test.beforeEach(() => {
  previousHome = process.env.BZZY_HOME; directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-broker-'));
  process.env.BZZY_HOME = path.join(directory, 'private'); workspace = path.join(directory, 'project'); fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'source.txt'), 'Evidence from the project.');
  session = new BzzyCore().createConversation({ provider: 'codex', cwd: workspace }, { requestId: randomUUID() });
  admin = createToolBroker().admin;
  scope = admin.scope({ principal, sessionId: session.id });
});
test.afterEach(() => {
  if (previousHome === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previousHome;
  fs.rmSync(directory, { recursive: true, force: true });
});
const allowFiles = () => grant = admin.grant({ principal, integrationId: 'filesystem', capabilities: ['filesystem.read'], roots: [{ id: 'project', path: workspace }], expiresAt: expiresAt() });
const invokeFile = (file = 'source.txt', extra = {}) => scope.invoke('filesystem.read_file', { root: 'project', path: file, ...extra });
function accountBroker(adapter = async () => ({ summary: 'Permitted message summary' })) {
  const owner = createToolBroker({ integrations: [mailbox] }).admin;
  const binding = owner.bind({ principal, integrationId: 'mailbox', capabilities: ['mail.read'], expiresAt: Date.now() + 120000 }, adapter);
  const permission = owner.grant({ principal, integrationId: 'mailbox', capabilities: ['mail.read'], bindingId: binding.id, expiresAt: expiresAt() });
  return { owner, binding, permission, tools: owner.scope({ principal, sessionId: session.id }) };
}

test('the model-facing tool surface has no permission, account or principal mutation methods', () => {
  assert.deepEqual(Object.keys(scope).sort(), ['catalog', 'instructions', 'invoke']);
  assert.equal(scope.catalog().length, 0); assert.match(scope.instructions, /Never\s+grant your own permissions/);
  assert.ok(Object.isFrozen(scope));
});

test('capabilities are denied until explicitly granted; reads include bounded host provenance', async () => {
  await assert.rejects(invokeFile(), { code: 'FORBIDDEN' });
  allowFiles();
  const result = await invokeFile('source.txt', { offset: 0, limit: 8 });
  assert.equal(result.data.content, 'Evidence'); assert.equal(result.data.nextOffset, 8); assert.equal(result.data.truncated, true);
  assert.equal(result.data.provenance, 'host-observed-file-slice'); assert.equal(result.data.sha256.length, 64);
  assert.equal(result.provenance.type, 'host-tool-observation');
  assert.equal(scope.catalog()[0].name, 'filesystem.read_file');
});

test('traversal, absolute paths, symlinks, hardlinks, secret files and runtime storage are denied', async () => {
  allowFiles();
  fs.writeFileSync(path.join(directory, 'outside.txt'), 'synthetic-private-value');
  fs.symlinkSync(path.join(directory, 'outside.txt'), path.join(workspace, 'alias.txt'));
  fs.symlinkSync(directory, path.join(workspace, 'outside-directory'));
  fs.linkSync(path.join(directory, 'outside.txt'), path.join(workspace, 'hardlink.txt'));
  for (const name of ['.env', '.env.local', 'credentials.json', 'auth.json', 'client.pem', 'login.db']) fs.writeFileSync(path.join(workspace, name), 'synthetic-private-value');
  for (const file of ['../outside.txt', path.join(directory, 'outside.txt'), 'alias.txt', 'outside-directory/outside.txt', 'hardlink.txt', '.env', '.env.local', 'credentials.json', 'auth.json', 'client.pem', 'login.db']) {
    await assert.rejects(invokeFile(file), { code: 'FORBIDDEN' }, file);
  }
  fs.symlinkSync(process.env.BZZY_HOME, path.join(workspace, 'private-store'));
  await assert.rejects(invokeFile('private-store/bzzy.sqlite'), { code: 'FORBIDDEN' });
  assert.throws(() => admin.grant({ principal, integrationId: 'filesystem', capabilities: ['filesystem.read'], roots: [{ id: 'private', path: process.env.BZZY_HOME }], expiresAt: expiresAt() }), { code: 'FORBIDDEN' });
});

test('a replaced approved directory cannot inherit the old root grant', async () => {
  allowFiles();
  fs.renameSync(workspace, `${workspace}-old`); fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'source.txt'), 'Replacement');
  await assert.rejects(invokeFile(), { code: 'FORBIDDEN' });
});

test('read-only schemas reject writes, extra input, oversized reads and unknown roots', async () => {
  allowFiles();
  await assert.rejects(scope.invoke('filesystem.write_file', { root: 'project', path: 'source.txt', content: 'write' }), { code: 'NOT_FOUND' });
  await assert.rejects(invokeFile('source.txt', { permission: 'write' }), { code: 'INVALID_REQUEST' });
  await assert.rejects(invokeFile('source.txt', { limit: 16385 }), { code: 'INVALID_REQUEST' });
  await assert.rejects(scope.invoke('filesystem.read_file', { root: 'other', path: 'source.txt' }), { code: 'FORBIDDEN' });
  assert.equal(fs.readFileSync(path.join(workspace, 'source.txt'), 'utf8'), 'Evidence from the project.');
});

test('schema allowlists cannot be bypassed with inherited object property names', async () => {
  allowFiles();
  for (const key of ['__proto__', 'constructor', 'toString']) {
    const args = JSON.parse(`{"root":"project","path":"source.txt","${key}":"synthetic-private-value"}`);
    await assert.rejects(scope.invoke('filesystem.read_file', args), { code: 'INVALID_REQUEST' });
  }
  const { tools } = accountBroker(async () => JSON.parse('{"summary":"Allowed","__proto__":"synthetic-private-value"}'));
  await assert.rejects(tools.invoke('mailbox.read', {}), { code: 'INVALID_TOOL_RESULT' });
});

test('separately authorized project roots remain usable without broadening either grant', async () => {
  allowFiles();
  const other = path.join(directory, 'other-project'); fs.mkdirSync(other); fs.writeFileSync(path.join(other, 'source.txt'), 'Other permitted project.');
  admin.grant({ principal, integrationId: 'filesystem', capabilities: ['filesystem.read'], roots: [{ id: 'other', path: other }], expiresAt: expiresAt() });
  assert.equal((await invokeFile()).data.content, 'Evidence from the project.');
  assert.equal((await scope.invoke('filesystem.read_file', { root: 'other', path: 'source.txt' })).data.content, 'Other permitted project.');
});

test('revocation and expiration affect already-created scopes immediately', async () => {
  allowFiles(); await invokeFile(); admin.revokeGrant(grant.id);
  await assert.rejects(invokeFile(), { code: 'FORBIDDEN' });
  allowFiles(); const stored = getRecord('core.permission', grant.id);
  putRecord('core.permission', grant.id, { ...stored, expiresAt: Date.now() - 1 });
  await assert.rejects(invokeFile(), { code: 'FORBIDDEN' });
});

test('another user, workspace or agent cannot use a private binding', () => {
  const { owner, binding } = accountBroker();
  for (const key of ['userId', 'workspaceId', 'agentId']) {
    assert.throws(() => owner.grant({ principal: { ...principal, [key]: 'other' }, integrationId: 'mailbox', capabilities: ['mail.read'], bindingId: binding.id, expiresAt: expiresAt() }), { code: 'FORBIDDEN' });
  }
  assert.throws(() => owner.grant({ principal, integrationId: 'mailbox', capabilities: ['mail.headers'], bindingId: binding.id, expiresAt: expiresAt() }), { code: 'FORBIDDEN' });
  assert.throws(() => owner.scope({ principal: { ...principal, agentId: 'other' }, sessionId: session.id }), { code: 'FORBIDDEN' });
});

test('private adapters receive no raw credential fields from the broker; audit contains no arguments or results', async () => {
  const { tools } = accountBroker(async (_tool, args, context) => {
    assert.deepEqual(args, {}); assert.equal(context.credentials, undefined); assert.equal(context.binding, undefined);
    return { summary: 'Private execution content' };
  });
  assert.equal((await tools.invoke('mailbox.read', {})).data.summary, 'Private execution content');
  const audit = JSON.stringify(events(session.id).filter(event => event.type === 'tool.decision'));
  assert.doesNotMatch(audit, /Private execution content|synthetic-private-value|authorization|password/);
});

test('host adapter errors and undeclared output never disclose credential values', async () => {
  const { tools } = accountBroker(async () => { throw new Error('Bearer synthetic-private-value'); });
  await assert.rejects(tools.invoke('mailbox.read', {}), error => error.code === 'TOOL_FAILED' && !error.message.includes('synthetic-private-value'));
  const other = accountBroker(async () => ({ summary: 'Safe', accessToken: 'synthetic-private-value' }));
  await assert.rejects(other.tools.invoke('mailbox.read', {}), { code: 'INVALID_TOOL_RESULT' });
  assert.doesNotMatch(JSON.stringify(events(session.id)), /synthetic-private-value/);
});

test('binding revocation during an adapter call prevents returning its result', async () => {
  let revoke;
  const { owner, binding, tools } = accountBroker(async () => { revoke(); return { summary: 'Revoked content' }; });
  revoke = () => owner.revokeBinding(binding.id);
  await assert.rejects(tools.invoke('mailbox.read', {}), { code: 'FORBIDDEN' });
});

test('cancellation stops waiting for an unresponsive adapter', async () => {
  const abort = new AbortController();
  const { tools } = accountBroker(async (_tool, _args, context) => {
    assert.ok(context.signal instanceof AbortSignal);
    abort.abort();
    return new Promise(() => {});
  });
  await assert.rejects(tools.invoke('mailbox.read', {}, { signal: abort.signal }), { code: 'CANCELLED' });
});

test('an undeclared tool ID is not copied into the audit stream', async () => {
  await assert.rejects(scope.invoke('synthetic-private-value.read', {}), { code: 'NOT_FOUND' });
  const audit = events(session.id).filter(event => event.type === 'tool.decision');
  assert.equal(audit.at(-1).data.tool, 'unknown');
  assert.doesNotMatch(JSON.stringify(audit), /synthetic-private-value/);
});

test('a restart does not silently reuse an account or substitute another principal’s adapter', async () => {
  const { binding } = accountBroker();
  const restarted = createToolBroker({ integrations: [mailbox] }).admin;
  const tools = restarted.scope({ principal, sessionId: session.id });
  await assert.rejects(tools.invoke('mailbox.read', {}), { code: 'AUTHORIZATION_REQUIRED' });
  assert.equal(tools.catalog().length, 0);
  restarted.attachBinding(binding.id, async () => ({ summary: 'Securely reconnected account' }));
  assert.equal((await tools.invoke('mailbox.read', {})).data.summary, 'Securely reconnected account');
});

test('call limits apply to the principal across repeated scopes', async () => {
  const { owner, tools } = accountBroker();
  for (let index = 0; index < 5; index++) await tools.invoke('mailbox.read', {});
  await assert.rejects(owner.scope({ principal, sessionId: session.id }).invoke('mailbox.read', {}), { code: 'RATE_LIMITED' });
});

test('registry rejects declared side effects; scoped tools cannot register integrations', () => {
  const unsafe = structuredClone(mailbox); unsafe.tools[0].effect = 'write';
  assert.throws(() => createToolBroker({ integrations: [unsafe] }), { code: 'INVALID_INTEGRATION' });
  assert.equal(admin.integrations()[0].id, filesystemIntegration.id);
  assert.throws(() => admin.bind({ principal, integrationId: 'mailbox', capabilities: ['mail.read'], accountAddress: 'synthetic-private-value', expiresAt: expiresAt() }, () => {}), { code: 'INVALID_REQUEST' });
});
