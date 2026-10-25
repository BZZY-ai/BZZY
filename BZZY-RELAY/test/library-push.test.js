import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, pair } from './helpers.js';

const token = 'ab'.repeat(32);

test('library-only screen hints retain strict title, route, metadata and legacy goal validation', async t => {
  const f = await fixture(t), host = await f.client({ host: true }), phone = await f.client(), { grant } = await pair(host, phone);
  await phone.request('push.register', { enabled: true, deviceToken: token, environment: 'sandbox', grantIds: [grant.id] });
  let sequence = 0;
  const payload = (title = 'Agent created - response-reviewer', destination = 'agents', extra = {}) => ({
    aps: { alert: { title, body: 'Inspect the supplied response.' }, sound: 'default', category: 'BZZY_UPDATE', 'thread-id': 'library-thread' },
    bzzy: { v: 1, eventId: 'library-created', hostId: grant.hostId, destination, ...extra },
  });
  const enqueue = value => host.request('push.enqueue', { grantId: grant.id, notificationId: 'library-' + sequence++, environment: 'sandbox', occurredAt: Date.now(), payload: value });
  assert.equal((await enqueue(payload())).state, 'queued');
  assert.equal((await enqueue(payload('Skill created - response-check', 'terminal'))).state, 'queued');
  assert.equal((await enqueue(payload('Agent created - scoped', 'agents', { resource: grant.spec.resource, sessionId: randomUUID(), agentId: randomUUID() }))).state, 'queued');
  const rejects = [
    payload('Goal achieved', 'terminal'), payload('Input needed', 'terminal'), payload('BZZY update available', 'terminal'),
    payload('Skill created - method', 'updates'), payload('Agent created - method', 'https://example.test'),
    payload('Agent created - method', 'agents', { command: 'execute' }), payload('Arbitrary model text', 'terminal'),
    payload('Agent created - method', 'agents', { sessionId: randomUUID() }), payload('Agent created - method', 'agents', { resource: grant.spec.resource }),
    payload('Agent created - method', 'agents', { agentId: randomUUID() }), payload('Skill created - ' + 'x'.repeat(101), 'terminal'),
  ];
  for (const value of rejects) await assert.rejects(enqueue(value), error => ['INVALID_PUSH', 'INVALID_ID', 'INVALID_MESSAGE'].includes(error.code));
  assert.equal((await enqueue(payload('BZZY update available', 'updates'))).state, 'queued');
  assert.equal((await enqueue(payload('Goal achieved - legacy', 'terminal', { resource: grant.spec.resource, sessionId: randomUUID() }))).state, 'queued');
});
