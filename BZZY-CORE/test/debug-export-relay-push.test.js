import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture, pair } from '../../BZZY-RELAY/test/helpers.js';
import { CorePushWorker } from '../src/push/worker.js';
import { registerDeviceNotifications } from '../src/push/registration.js';
import { putRecord, digest } from '../src/engine/database.js';
import { sessionPermissions } from '../src/engine/session-access.js';
import { finishDebugExportJob, debugExportJobKind } from '../src/engine/debug-export-jobs.js';
import { debugExportFailure } from '../src/engine/debug-export-errors.js';

test('real export outcome payloads cross authenticated Relay validation and reach the bound offline phone once', async t => {
  const previous = process.env.BZZY_HOME, directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-export-push-')));
  process.env.BZZY_HOME = path.join(directory, 'private'); fs.mkdirSync(process.env.BZZY_HOME, { mode: 0o700 });
  t.after(() => { if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous; fs.rmSync(directory, { recursive: true, force: true }); });
  const sends = [], configuration = { environment: 'sandbox', fingerprint: 'fixture' }, token = 'ab'.repeat(32);
  const f = await fixture(t, { server: { push: { configurationLoader: () => configuration,
    clientFactory: () => ({ send: async value => { sends.push(value); }, close() {} }) } } });
  const host = await f.client({ host: true }), phone = await f.client(), { grant } = await pair(host, phone);
  await phone.request('push.register', { enabled: true, deviceToken: token, environment: 'sandbox', grantIds: [grant.id] });
  const sessionId = randomUUID(), accessToken = randomUUID(), coreGrantId = randomUUID(), row = { id: grant.id,
    resource: grant.spec.resource, sessionId, hostId: grant.hostId, peerId: grant.recipientId, peerDigest: digest(phone.identity.certificate),
    relayUrl: host.url, sessionAccess: true, agentAccess: true, shareAccess: true, permissions: [...sessionPermissions], token: accessToken,
    coreGrantId, expiresAt: grant.expiresAt };
  putRecord('session', sessionId, { id: sessionId, cwd: directory, provider: 'deepseek', alias: 'export-fixture' });
  putRecord('access-token', digest(accessToken), { id: coreGrantId, sessionId, expiresAt: grant.expiresAt, includeChildren: false, permissions: [...sessionPermissions] });
  putRecord('core.relay.pin', grant.recipientId, { hostId: grant.hostId, certificate: phone.identity.certificate }); putRecord('core.relay.grant', grant.id, row);
  registerDeviceNotifications(row, { enabled: true, deviceToken: token, environment: 'sandbox', scope: 'authorized', relayPush: true, hostHints: true });
  await phone.close();
  for (const error of [null, debugExportFailure('SESSION_DEBUG_SPACE')]) {
    const id = randomUUID(); putRecord(debugExportJobKind, id, { id, sessionId, state: 'running', createdAt: new Date().toISOString() });
    finishDebugExportJob(id, error ? { error } : { result: { outputPath: '/PRIVATE_EXPORT_PATH/result.zip', bytes: 123 } });
  }
  const sender = new CorePushWorker({ configurationLoader: () => null, hostID: () => grant.hostId,
    relaySend: (_binding, request) => host.request('push.enqueue', { grantId: grant.id, notificationId: request.id, occurredAt: request.occurredAt,
      environment: 'sandbox', payload: request.payload }) });
  t.after(() => sender.close());
  await sender.tick();
  for (let index = 0; index < 100 && sends.length < 2; index++) await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(sends.length, 2); assert.ok(sends.every(value => value.token === token && value.payload.bzzy.sessionId === sessionId));
  assert.deepEqual(sends.map(value => value.payload.aps.alert.title).sort(), ['Full debug export failed - export-fixture', 'Full debug export ready - export-fixture']);
  assert.doesNotMatch(JSON.stringify(sends), /PRIVATE_EXPORT_PATH/); assert.equal(JSON.stringify(f.audit).includes(token), false);
});
