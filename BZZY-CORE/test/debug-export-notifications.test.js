import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getRecord, putRecord, listRecords, digest } from '../src/engine/database.js';
import { finishDebugExportJob, currentDebugExportOutcome, debugExportJobKind, reconcileDebugExportJobs } from '../src/engine/debug-export-jobs.js';
import { debugExportFailure } from '../src/engine/debug-export-errors.js';
import { sessionPermissions } from '../src/engine/session-access.js';
import { registerDeviceNotifications, revokeDeviceNotifications } from '../src/push/registration.js';
import { CorePushWorker } from '../src/push/worker.js';
import { submitBackgroundJob, finishBackgroundJob, currentBackgroundOutcome } from '../src/engine/background-jobs.js';

let directory, previous;
const hostId = 'H'.repeat(43), token = 'ab'.repeat(32);
test.beforeEach(() => {
  previous = process.env.BZZY_HOME;
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-export-alerts-')));
  process.env.BZZY_HOME = path.join(directory, 'private'); fs.mkdirSync(process.env.BZZY_HOME, { mode: 0o700 });
});
test.afterEach(() => { if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous; fs.rmSync(directory, { recursive: true, force: true }); });
function phone({ full = true, deviceToken = token, enabled = true, relayPush = false, sessionId = randomUUID() } = {}) {
  const id = randomUUID(), peerId = randomUUID(), accessToken = randomUUID(), coreGrantId = randomUUID();
  putRecord('session', sessionId, { id: sessionId, cwd: directory, provider: 'deepseek', alias: 'fake-program-session', createdAt: new Date().toISOString() });
  const certificate = { id: peerId, fixture: true }, permissions = full ? [...sessionPermissions] : ['observe'];
  const row = { id, resource: randomUUID(), sessionId, hostId, peerId, peerDigest: digest(certificate), relayUrl: 'wss://relay.example/v1/socket',
    sessionAccess: true, agentAccess: full, shareAccess: full, permissions, token: accessToken, coreGrantId, expiresAt: Date.now() + 3600000 };
  putRecord('access-token', digest(accessToken), { id: coreGrantId, sessionId, expiresAt: row.expiresAt, includeChildren: false, permissions });
  putRecord('core.relay.pin', peerId, { hostId, certificate }); putRecord('core.relay.grant', id, row);
  registerDeviceNotifications(row, { enabled, deviceToken, environment: 'sandbox', scope: 'authorized', relayPush, hostHints: true });
  return row;
}
function outcome(sessionId, error) {
  const id = randomUUID(); putRecord(debugExportJobKind, id, { id, sessionId, state: 'running', createdAt: new Date().toISOString() });
  return finishDebugExportJob(id, error ? { error } : { result: { full: true, outputPath: '/PRIVATE_EXPORT_LOCATION/private.zip', bytes: 123 } });
}
function worker(sends, options = {}) {
  return new CorePushWorker({ configurationLoader: () => ({ fingerprint: 'fixture', environment: 'sandbox' }), hostID: () => hostId,
    clientFactory: () => ({ send: async value => { sends.push(value); return { accepted: true, apnsId: value.id }; }, close() {} }), ...options });
}

test('script alerts are opt-in, name the script and reach only the fully approved phone without logs or paths', async () => {
  phone({ relayPush: true }); phone({ full: false, deviceToken: 'cd'.repeat(32) });
  const file = path.join(directory, 'check-results.py'); fs.writeFileSync(file, 'print("private output")');
  const silent = submitBackgroundJob({ script: file, cwd: directory }, randomUUID()); finishBackgroundJob(silent.id, 'completed', { exitCode: 0 });
  assert.equal(listRecords('outbox').length, 0);
  const ready = submitBackgroundJob({ script: file, cwd: directory, notify: true }, randomUUID()); finishBackgroundJob(ready.id, 'completed', { exitCode: 0 });
  const failed = submitBackgroundJob({ script: file, cwd: directory, notify: true }, randomUUID()); finishBackgroundJob(failed.id, 'failed', { exitCode: 9, message: 'PRIVATE_RAW_LOG' });
  assert.equal(listRecords('outbox').length, 2); assert.ok(listRecords('outbox').every(row => currentBackgroundOutcome(row.event)));
  const sends = [], sender = worker([], { relaySend: async (registration, value) => { sends.push(value); return { state: 'sent' }; } });
  try { await sender.tick(); await sender.tick(); } finally { sender.close(); }
  assert.equal(sends.length, 2);
  assert.deepEqual(sends.map(value => value.payload.aps.alert.title).sort(), ['Completed check-results.py', 'Failed check-results.py']);
  assert.ok(sends.every(value => value.payload.bzzy.destination === 'terminal' && !value.payload.bzzy.sessionId));
  assert.doesNotMatch(JSON.stringify(sends), /PRIVATE_RAW_LOG|private output/); assert.equal(JSON.stringify(sends).includes(directory), false);
});

test('job notification names containing credential markers are replaced and forged outcomes are rejected', async () => {
  phone(); const file = path.join(directory, 'api_key=fixture-private.py'); fs.writeFileSync(file, 'pass');
  // Filenames with obvious credential assignments are rejected before persistence.
  assert.throws(() => submitBackgroundJob({ script: file, cwd: directory, notify: true }, randomUUID()), /Credentials/);
  const safe = path.join(directory, 'token-report.py'); fs.writeFileSync(safe, 'pass');
  const job = submitBackgroundJob({ script: safe, cwd: directory, notify: true }, randomUUID()); finishBackgroundJob(job.id, 'completed', { exitCode: 0 });
  const record = listRecords('outbox')[0]; assert.equal(currentBackgroundOutcome(record.event).notificationName, 'script');
  putRecord('outbox', record.event.id, { ...record, event: { ...record.event, type: 'job.failed' } });
  const sends = [], sender = worker(sends); try { await sender.tick(); } finally { sender.close(); }
  assert.equal(sends.length, 0);
});

test('success and failure queue one scoped alert and use existing iOS terminal routing without host paths', async () => {
  const grant = phone(), ready = outcome(grant.sessionId), failed = outcome(grant.sessionId, debugExportFailure('SESSION_DEBUG_SPACE'));
  finishDebugExportJob(ready.id, { result: ready.result }); finishDebugExportJob(failed.id, { error: debugExportFailure('SESSION_DEBUG_SPACE') });
  const events = listRecords('outbox'); assert.equal(events.length, 2); assert.ok(events.every(row => currentDebugExportOutcome(row.event)));
  const sends = [], sender = worker(sends);
  try { await sender.tick(); await sender.tick(); } finally { sender.close(); }
  assert.equal(sends.length, 2);
  assert.deepEqual(sends.map(value => value.payload.aps.alert.title).sort(), ['Full debug export failed - fake-program-session', 'Full debug export ready - fake-program-session']);
  assert.ok(sends.some(value => /available space/.test(value.payload.aps.alert.body)));
  assert.ok(sends.every(value => value.payload.bzzy.destination === 'terminal' && value.payload.bzzy.sessionId === grant.sessionId));
  assert.doesNotMatch(JSON.stringify(sends), /PRIVATE_EXPORT_LOCATION|private\.zip/);
  assert.ok(sends.every(value => Object.keys(value.payload.bzzy).every(key => ['v', 'eventId', 'hostId', 'destination', 'resource', 'sessionId'].includes(key))));
});

test('export alerts respect own-phone approval, disabled/revoked registrations and deleted-session scope', async () => {
  const owner = phone(); phone({ full: false, deviceToken: 'cd'.repeat(32) }); phone({ enabled: false, deviceToken: 'ef'.repeat(32) });
  const revoked = phone({ deviceToken: '12'.repeat(32) }); revokeDeviceNotifications(revoked, {});
  outcome(owner.sessionId);
  const sends = [], sender = worker(sends);
  try {
    await sender.tick(); assert.equal(sends.length, 1); assert.equal(sends[0].token, token);
    const job = outcome(owner.sessionId); putRecord('session-deletion', owner.sessionId, { deletedAt: new Date().toISOString() });
    await sender.tick(); assert.equal(sends.length, 1); assert.ok(getRecord(debugExportJobKind, job.id));
  } finally { sender.close(); }
});

test('outbox mutations cannot forge an export result and unknown worker errors are sanitized', async () => {
  const grant = phone(); const job = outcome(grant.sessionId, new Error('PRIVATE_FIXTURE_BINDING do not disclose'));
  assert.equal(job.error.code, 'SESSION_DEBUG_FAILED'); assert.doesNotMatch(JSON.stringify(job), /PRIVATE_FIXTURE_BINDING/);
  const record = listRecords('outbox')[0]; putRecord('outbox', record.event.id, { ...record, event: { ...record.event, type: 'debug.export.completed' } });
  const sends = [], sender = worker(sends);
  try { await sender.tick(); assert.equal(sends.length, 0); } finally { sender.close(); }
});

test('a crashed export is marked interrupted and notified once without replaying the export', () => {
  const grant = phone(), id = randomUUID(), createdAt = new Date(Date.now() - 30_000).toISOString();
  putRecord(debugExportJobKind, id, { id, sessionId: grant.sessionId, state: 'running', createdAt,
    identity: { pid: 2147483647, start: 'nonexistent-fixture' } });
  reconcileDebugExportJobs(); reconcileDebugExportJobs();
  assert.equal(getRecord(debugExportJobKind, id).state, 'failed'); assert.equal(getRecord(debugExportJobKind, id).error.code, 'SESSION_DEBUG_INTERRUPTED');
  assert.equal(listRecords('outbox').length, 1); assert.equal(fs.existsSync(path.join(directory, 'debug.zip')), false);
});

test('Relay retries retain the same event ID and pinned payload', async () => {
  const grant = phone({ relayPush: true }); outcome(grant.sessionId);
  const requests = [], sender = worker([], { relaySend: async (_binding, request) => { requests.push(request); return { state: 'queued', providerConfigured: true }; } });
  try {
    await sender.tick(); const receipt = listRecords('core.push.delivery')[0];
    putRecord('core.push.delivery', receipt.id, { ...receipt, nextAttemptAt: 0 });
    await sender.tick(); assert.equal(requests.length, 2); assert.equal(requests[0].id, requests[1].id); assert.deepEqual(requests[0].payload, requests[1].payload);
  } finally { sender.close(); }
});
