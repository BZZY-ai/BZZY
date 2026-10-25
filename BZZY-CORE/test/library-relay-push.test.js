import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture, pair } from '../../BZZY-RELAY/test/helpers.js';
import { CorePushWorker } from '../src/push/worker.js';
import { registerDeviceNotifications } from '../src/push/registration.js';
import { getRecord, putRecord, listRecords, digest } from '../src/engine/database.js';
import { sessionPermissions } from '../src/engine/session-access.js';
import { createSkill } from '../src/engine/skills.js';
import { saveSubagentDefinition } from '../src/engine/subagent-definitions.js';

const token = 'ab'.repeat(32), configuration = { environment: 'sandbox', fingerprint: 'fixture' };
const definition = name => ({ name, description: 'Inspect only the supplied HTTP response.', instructions: 'PRIVATE_FIXTURE_WORKFLOW: compare authorized response controls.' });

test('actual Core library payloads cross authenticated Relay validation and deliver once to the bound offline phone', async t => {
  const previous = process.env.BZZY_HOME, directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-core-library-push-')));
  process.env.BZZY_HOME = path.join(directory, 'private'); fs.mkdirSync(process.env.BZZY_HOME, { mode: 0o700 });
  t.after(() => { if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous; fs.rmSync(directory, { recursive: true, force: true }); });
  const sends = [], requests = [];
  const f = await fixture(t, { server: { push: { configurationLoader: () => configuration,
    clientFactory: () => ({ send: async value => { sends.push(value); }, close() {} }) } } });
  const host = await f.client({ host: true }), phone = await f.client(), { grant } = await pair(host, phone);
  await phone.request('push.register', { enabled: true, deviceToken: token, environment: 'sandbox', grantIds: [grant.id] });
  const sessionId = randomUUID(), accessToken = randomUUID(), coreGrantId = randomUUID(), coreGrant = { id: grant.id,
    resource: grant.spec.resource, sessionId, hostId: grant.hostId, peerId: grant.recipientId, peerDigest: digest(phone.identity.certificate),
    relayUrl: host.url, sessionAccess: true, agentAccess: true, shareAccess: true, permissions: [...sessionPermissions], token: accessToken,
    coreGrantId, expiresAt: grant.expiresAt };
  putRecord('session', sessionId, { id: sessionId, cwd: directory, provider: 'codex', alias: 'Synthetic terminal' });
  putRecord('access-token', digest(accessToken), { id: coreGrantId, sessionId, expiresAt: grant.expiresAt, includeChildren: false, permissions: [...sessionPermissions] });
  putRecord('core.relay.pin', grant.recipientId, { hostId: grant.hostId, certificate: phone.identity.certificate });
  putRecord('core.relay.grant', grant.id, coreGrant);
  registerDeviceNotifications(coreGrant, { enabled: true, deviceToken: token, environment: 'sandbox', scope: 'authorized', relayPush: true, hostHints: true });
  await phone.close();
  const worker = new CorePushWorker({ configurationLoader: () => null, hostID: () => grant.hostId,
    relaySend: async (_binding, request) => {
      requests.push(request);
      return host.request('push.enqueue', { grantId: grant.id, notificationId: request.id, occurredAt: request.occurredAt,
        environment: 'sandbox', payload: request.payload });
    } });
  t.after(() => worker.close());
  createSkill(definition('response-check'), { scope: 'global' });
  saveSubagentDefinition(definition('response-reviewer'), { scope: 'global' });
  await worker.tick(); assert.equal(requests.length, 2);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM push_queue').get().n, 2);
  for (const delivery of listRecords('core.push.delivery')) putRecord('core.push.delivery', delivery.id, { ...delivery, nextAttemptAt: 0 });
  await worker.tick(); assert.equal(requests.length, 4);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM push_queue').get().n, 2, 'Lost/queued receipts retain the exact IDs and payloads.');
  for (let index = 0; index < 50 && sends.length < 2; index++) await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(sends.length, 2); assert.ok(sends.every(value => value.token === token));
  assert.deepEqual(sends.map(value => value.payload.aps.alert.title).sort(), ['Agent created - response-reviewer', 'Skill created - response-check']);
  assert.ok(sends.every(value => value.payload.aps.alert.body === definition('method').description));
  assert.ok(sends.every(value => value.payload.bzzy.destination === 'terminal' && value.payload.bzzy.sessionId === undefined && value.payload.bzzy.resource === undefined));
  assert.equal(JSON.stringify(requests).includes('PRIVATE_FIXTURE_WORKFLOW'), false);
  assert.equal(JSON.stringify(f.audit).includes(token), false);
  assert.equal(getRecord('core.relay.grant', grant.id).token, accessToken);
});
