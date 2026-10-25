import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CoreAssistant } from '../src/assistant.js';
import { backgroundModelSettings, configureBackgroundModel } from '../src/engine/background-model.js';
import { remoteDefaults, configureRemoteDefaults } from '../src/engine/remote-settings.js';
import { modelDefaultSettings, configureModelDefault } from '../src/engine/model-defaults.js';
import { database, digest, getRecord, putRecord, listRecords } from '../src/engine/database.js';
import { sessionPermissions } from '../src/engine/session-access.js';
import { createSession, loadSession } from '../src/engine/store.js';
import { getProvider } from '../src/engine/providers.js';

let root, previousHome;
test.beforeEach(() => {
  previousHome = process.env.BZZY_HOME;
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-remote-defaults-')));
  process.env.BZZY_HOME = path.join(root, 'private');
});
test.afterEach(() => {
  if (previousHome === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previousHome;
  fs.rmSync(root, { recursive: true, force: true });
});
function grant() {
  const certificate = { id: 'fixture-phone', synthetic: true }, token = randomUUID();
  const row = { id: randomUUID(), peerId: 'fixture-phone', hostId: 'fixture-host', peerDigest: digest(certificate), resource: 'base-resource',
    sessionId: randomUUID(), token, coreGrantId: randomUUID(), sessionAccess: true, agentAccess: true, shareAccess: true,
    permissions: [...sessionPermissions], expiresAt: Date.now() + 3600000 };
  putRecord('core.relay.pin', row.peerId, { certificate, hostId: row.hostId });
  putRecord('access-token', digest(token), { id: row.coreGrantId, sessionId: row.sessionId, includeChildren: false, permissions: [...sessionPermissions], expiresAt: row.expiresAt });
  putRecord('core.relay.grant', row.id, row); return row;
}
const selection = model => ({ provider: 'codex', model, effort: 'default' });
function saveGUI(target, models) {
  return configureModelDefault(target, models.map(selection), { expectedRevision: modelDefaultSettings(target).revision });
}

test('remote Solo and mode saves cannot overwrite a GUI save occurring just before the config lock is acquired', () => {
  const row = grant();
  for (const [target, remoteTarget, count] of [['solo', 'cli', 1], ['validate', 'debate', 2], ['delegate', 'delegate', 2]]) {
    saveGUI(target, Array(count).fill('initial-model'));
    const shown = remoteDefaults(row), originalLink = fs.linkSync, lock = path.join(process.env.BZZY_HOME, 'config.json.lock');
    let raced = false;
    // Interleave the real GUI setter immediately before the remote setter
    // publishes its lock, after the wire revision has already been checked.
    fs.linkSync = function(source, destination, ...rest) {
      if (!raced && String(destination) === lock) { raced = true; saveGUI(target, Array(count).fill('new-gui-model')); }
      return originalLink.call(this, source, destination, ...rest);
    };
    try {
      assert.throws(() => configureRemoteDefaults(row, { target: remoteTarget, expectedRevision: shown.revision,
        agents: Array.from({ length: count }, () => selection('stale-phone-model')) }, randomUUID()), { code: 'CONFLICT' });
    } finally { fs.linkSync = originalLink; }
    assert.equal(raced, true); assert.ok(modelDefaultSettings(target).agents.every(agent => agent.model === 'new-gui-model'));
  }
  assert.equal(listRecords('execution').length, 0);
});

test('Core remote preparation checks the fingerprint inside its transaction before capturing the coordinator revision', () => {
  const row = grant(), assistant = new CoreAssistant();
  assistant.configure({ source: 'core', ...selection('initial-core') }, { expectedRevision: 0, requestId: randomUUID() });
  const shown = remoteDefaults(row), db = database(), originalExec = db.exec;
  let raced = false;
  // A GUI commit in the gap before the preparation transaction must invalidate
  // the original phone view, rather than becoming its new accepted revision.
  db.exec = function(sql, ...rest) {
    if (!raced && sql === 'BEGIN IMMEDIATE') {
      raced = true;
      assistant.configure({ source: 'core', ...selection('new-gui-core') }, { expectedRevision: 1, requestId: randomUUID() });
    }
    return originalExec.call(this, sql, ...rest);
  };
  try {
    assert.throws(() => configureRemoteDefaults(row, { target: 'core', expectedRevision: shown.revision,
      agents: [selection('stale-phone-core')] }, randomUUID()), { code: 'CONFLICT' });
  } finally { db.exec = originalExec; }
  assert.equal(raced, true); assert.equal(assistant.settings().selection.model, 'new-gui-core'); assert.equal(assistant.settings().revision, 2);
});

test('remote defaults remain idempotent, scoped to the own phone, and independent from live chat and shared background settings', () => {
  const row = grant(), session = createSession(getProvider('codex'), root, 'current-chat');
  const assistant = new CoreAssistant(); assistant.configure({ source: 'core', ...selection('core-model') }, { expectedRevision: 0, requestId: randomUUID() });
  configureBackgroundModel({ source: 'custom', provider: 'deepseek', model: 'background-model', effort: 'low' }, { expectedRevision: 0 });
  const originalChat = loadSession(session.id), originalCore = assistant.settings(), originalBackground = backgroundModelSettings();
  for (const [target, count] of [['cli', 1], ['debate', 3], ['delegate', 2], ['parallel', 2], ['besties', 3]]) {
    const input = { target, expectedRevision: remoteDefaults(row).revision, agents: Array.from({ length: count }, () => selection('phone-default')) }, id = randomUUID();
    const first = configureRemoteDefaults(row, input, id); assert.deepEqual(configureRemoteDefaults(row, input, id), first);
    assert.throws(() => configureRemoteDefaults(row, { ...input, agents: input.agents.map(() => selection('changed-request')) }, id), { code: 'CONFLICT' });
  }
  assert.deepEqual(loadSession(session.id), originalChat); assert.deepEqual(assistant.settings(), originalCore); assert.deepEqual(backgroundModelSettings(), originalBackground);
  assert.equal(listRecords('execution').length, 0);
  assert.throws(() => remoteDefaults({ ...row, relayGrantId: row.id }), { code: 'FORBIDDEN' });
  putRecord('core.relay.grant', row.id, { ...row, revokedAt: new Date().toISOString() });
  assert.throws(() => remoteDefaults(row), { code: 'FORBIDDEN' });
  assert.ok(getRecord('core.background-model', 'default'));
});
