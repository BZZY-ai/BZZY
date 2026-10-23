import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CoreUpdates } from '../src/engine/updates.js';
import { getRecord, putRecord, listRecords, digest } from '../src/engine/database.js';
import { sessionPermissions } from '../src/engine/session-access.js';
import { authorizedUpdateGrant } from '../src/engine/update-access.js';
import { validateRequest, permissionFor } from '../src/relay/protocol.js';
let directory, previous;
test.beforeEach(() => { previous = process.env.BZZY_HOME; directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-watch-update-')); process.env.BZZY_HOME = directory; });
test.afterEach(() => { if (previous == null) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous; fs.rmSync(directory, { recursive: true, force: true }); });
function grant() {
 const certificate = { id: 'phone', fixture: true }, token = randomUUID();
 const row = { id: randomUUID(), peerId: 'phone', hostId: 'host', peerDigest: digest(certificate), resource: 'base-resource', sessionId: randomUUID(), token, coreGrantId: randomUUID(),
  sessionAccess: true, agentAccess: true, shareAccess: true, permissions: [...sessionPermissions], expiresAt: Date.now() + 3600000 };
 putRecord('core.relay.pin', row.peerId, { certificate, hostId: row.hostId });
 putRecord('access-token', digest(token), { id: row.coreGrantId, sessionId: row.sessionId, includeChildren: false, permissions: [...sessionPermissions], expiresAt: row.expiresAt });
 putRecord('core.relay.grant', row.id, row); return row;
}
function service(extra = {}) { return new CoreUpdates({ directory: () => '/fixture/install', checker: async () => ({ current: 'a'.repeat(40), target: 'b'.repeat(40), available: true, blocked: null }), ...extra }); }

test('Core watches the canonical revision and enqueues only one update notification per target', async () => {
 let time = Date.now(), checks = 0;
 const row = grant(), updates = service({ clock: () => time, checker: async () => { checks++; return { current: 'a'.repeat(40), target: 'b'.repeat(40), available: true }; } });
 try {
  await updates.checkNow(row); assert.equal(updates.status(row).available, true); assert.equal(updates.status(row).remoteUpdatesEnabled, false);
  await updates.checkNow(row); assert.equal(checks, 1, 'manual checks have a cooldown');
  time += 61000; await updates.checkNow(row); assert.equal(checks, 2); assert.equal(listRecords('outbox').length, 1);
  assert.equal(listRecords('outbox')[0].event.type, 'system.update_available');
  assert.equal(listRecords('core.update.job').length, 0, 'watching never installs');
 } finally { updates.close(); }
});

test('only the fully authorized base phone can opt into installation; sessions, Agents, expired grants and observers cannot', async () => {
 const row = grant(), updates = service();
 try {
  assert.ok(authorizedUpdateGrant(row.id));
  for (const changed of [{ ...row, resource: 'other-context' }, { ...row, relayGrantId: row.id }]) assert.throws(() => updates.status(changed), { code: 'FORBIDDEN' });
  for (const patch of [{ sessionAccess: false }, { shareAccess: false }, { agentAccess: false }, { permissions: ['observe'] }, { expiresAt: 1 }, { revokedAt: new Date().toISOString() }]) {
   putRecord('core.relay.grant', row.id, { ...row, ...patch }); assert.throws(() => updates.configure(row, { remoteUpdatesEnabled: true }), { code: 'FORBIDDEN' });
  }
  putRecord('core.relay.grant', row.id, row); await updates.checkNow(row);
  assert.throws(() => updates.requestInstall(row, { target: 'b'.repeat(40) }, 'request'), { code: 'FORBIDDEN' });
  assert.throws(() => updates.configure(row, { url: 'https://arbitrary.invalid' }), { code: 'INVALID_REQUEST' });
  updates.configure(row, { remoteUpdatesEnabled: true }); assert.equal(updates.status(row).canInstall, true);
  const shown = JSON.stringify(updates.status(row)); assert.ok(!shown.includes(row.token)); assert.ok(!shown.includes('/fixture/install'));
 } finally { updates.close(); }
});

test('remote update acceptance is durable and idempotent, rejects stale revisions and rechecks revocation before launching', async () => {
 const row = grant(), launched = [], updates = service({ launch: job => launched.push(job.id) });
 try {
  await updates.checkNow(row); updates.configure(row, { remoteUpdatesEnabled: true });
  assert.throws(() => updates.requestInstall(row, { target: 'c'.repeat(40) }, 'bad-target'), { code: 'CONFLICT' });
  const first = updates.requestInstall(row, { target: 'b'.repeat(40) }, 'same-request');
  assert.deepEqual(updates.requestInstall(row, { target: 'b'.repeat(40) }, 'same-request'), first);
  assert.equal(listRecords('core.update.job').length, 1);
  assert.throws(() => updates.requestInstall(row, { target: 'b'.repeat(40) }, 'second-request'), { code: 'CONFLICT' });
  putRecord('core.relay.grant', row.id, { ...row, revokedAt: new Date().toISOString() }); updates.launch(first.jobId);
  assert.equal(launched.length, 0); assert.equal(getRecord('core.update.job', first.jobId).state, 'failed');
 } finally { updates.close(); }
});

test('the encrypted protocol accepts only fixed update operations and a pinned target', () => {
 const frame = (op, params) => ({ v: 1, protocol: 'bzzy-core', type: 'request', id: 'request', resource: 'resource', op, params });
 assert.equal(permissionFor(validateRequest(frame('updates.install', { target: 'b'.repeat(40) }))), 'execute');
 assert.throws(() => validateRequest(frame('updates.install', { target: 'b'.repeat(40), command: 'arbitrary' })), { code: 'INVALID_REQUEST' });
 assert.throws(() => validateRequest(frame('updates.check', { url: 'https://other.invalid' })), { code: 'INVALID_REQUEST' });
});
