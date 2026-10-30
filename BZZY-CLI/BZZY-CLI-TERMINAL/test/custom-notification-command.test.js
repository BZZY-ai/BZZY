import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { parseArgs } from '../src/cli.js';
import { runtimeInfo, runtimeRequest } from '../src/runtime.js';
import { identityAlive } from '../src/process-identity.js';
import { putRecord, listRecords, digest } from '../src/database.js';
import { sessionPermissions } from '@bzzy/core/engine/session-access.js';
import { registerDeviceNotifications } from '../../../BZZY-CORE/src/push/registration.js';

let directory, previous;
test.beforeEach(() => {
  previous = process.env.BZZY_HOME; directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bc-notify-')));
  process.env.BZZY_HOME = path.join(directory, 'private');
});
test.afterEach(async () => {
  const info = runtimeInfo();
  if (info && identityAlive(info.identity)) await runtimeRequest(info, 'POST', '/shutdown', {}).catch(() => {});
  for (let i = 0; info && identityAlive(info.identity) && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 20));
  if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
  fs.rmSync(directory, { recursive: true, force: true });
});
function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [new URL('../bin/bzzy.js', import.meta.url).pathname, ...args], { cwd: directory, env: { ...process.env, BZZY_DIRECT: '0' }, stdio: ['ignore','pipe','pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Notification command did not return')); }, 15000);
    child.on('error', reject); child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}
test('custom notification parsing supports JSON/request IDs and rejects mixed execution', () => {
  assert.equal(parseArgs(['--custom-notification', 'hey', '--json', '--request-id', 'once']).options.customNotification, 'hey');
  for (const args of [['--custom-notification'], ['--custom-notification', 'hey', '--goal', 'work'], ['--custom-notification', 'hey', '--background', 'a.py'], ['--custom-notification', 'hey', '--detach'], ['--custom-notification', 'hey', 'chat']]) assert.throws(() => parseArgs(args));
});
test('real CLI reports queued JSON, handles errors without raw text and creates no model execution', async () => {
  const absent = await run(['--custom-notification', 'hey', '--json']);
  assert.equal(absent.code, 1, absent.stderr); assert.equal(JSON.parse(absent.stderr).code, 'PUSH_REGISTRATION_REQUIRED');
  const sessionId = randomUUID(), coreGrantId = randomUUID(), accessToken = randomUUID(), peerId = randomUUID(), hostId = 'H'.repeat(43), certificate = { id: peerId };
  const grant = { id: randomUUID(), sessionId, resource: randomUUID(), hostId, peerId, peerDigest: digest(certificate), relayUrl: 'wss://relay.example/v1/socket',
    sessionAccess: true, agentAccess: true, shareAccess: true, permissions: [...sessionPermissions], token: accessToken, coreGrantId, expiresAt: Date.now() + 3600000 };
  putRecord('session', sessionId, { id: sessionId, cwd: directory, provider: 'codex', alias: 'Fixture' });
  putRecord('access-token', digest(accessToken), { id: coreGrantId, sessionId, expiresAt: grant.expiresAt, includeChildren: false, permissions: [...sessionPermissions] });
  putRecord('core.relay.pin', peerId, { hostId, certificate }); putRecord('core.relay.grant', grant.id, grant);
  registerDeviceNotifications(grant, { enabled: true, deviceToken: 'ab'.repeat(32), environment: 'sandbox', scope: 'authorized', relayPush: true, hostHints: true });
  const args = ['--custom-notification', 'hey', '--json', '--request-id', 'once'];
  const first = await run(args), repeat = await run(args);
  assert.equal(first.code, 0, first.stderr); assert.equal(repeat.code, 0, repeat.stderr);
  assert.deepEqual(JSON.parse(first.stdout), JSON.parse(repeat.stdout)); assert.equal(JSON.parse(first.stdout).state, 'queued');
  const invalid = await run(['--custom-notification', 'password=private-fixture', '--json']);
  assert.equal(invalid.code, 1); assert.equal(JSON.parse(invalid.stderr).code, 'INVALID_NOTIFICATION');
  assert.doesNotMatch(invalid.stdout + invalid.stderr, /private-fixture/);
  const conflict = await run(['--custom-notification', 'different', '--json', '--request-id', 'once']);
  assert.equal(conflict.code, 1); assert.equal(JSON.parse(conflict.stderr).code, 'CONFLICT');
  assert.equal(listRecords('core.notification.custom').length, 1); assert.equal(listRecords('execution').length, 0); assert.equal(listRecords('run').length, 0);
  const listed = await run(['notifications', 'list', '--json']); assert.equal(listed.code, 0, listed.stderr);
});
