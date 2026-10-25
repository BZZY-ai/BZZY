import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getRecord, putRecord, listRecords, digest, transaction } from '../src/engine/database.js';
import { createSkill, stageSkillCandidate, setSkillEnabled, deleteSkill } from '../src/engine/skills.js';
import { saveSubagentDefinition, deleteSubagentDefinition } from '../src/engine/subagent-definitions.js';
import { recordLibraryCreation, currentLibraryCreation } from '../src/engine/library-notifications.js';
import { sessionPermissions } from '../src/engine/session-access.js';
import { registerDeviceNotifications, revokeDeviceNotifications } from '../src/push/registration.js';
import { CorePushWorker } from '../src/push/worker.js';
import { CoreAgents } from '../src/agents.js';
import { CoreWorkspaces } from '../src/workspaces.js';

let directory, previous;
const hostId = 'H'.repeat(43), token = 'ab'.repeat(32);
test.beforeEach(() => {
  previous = process.env.BZZY_HOME;
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-library-alerts-')));
  process.env.BZZY_HOME = path.join(directory, 'private'); fs.mkdirSync(process.env.BZZY_HOME, { mode: 0o700 });
});
test.afterEach(() => {
  if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
  fs.rmSync(directory, { recursive: true, force: true });
});
const events = () => listRecords('outbox').filter(row => row.event.type.startsWith('library.'));
const definition = (name = 'response-check') => ({ name, description: 'Check the supplied HTTP response.', instructions: 'Inspect only the supplied response and report the observed status.' });
function phone({ full = true, deviceToken = token, enabled = true, relayPush = false } = {}) {
  const id = randomUUID(), peerId = randomUUID(), sessionId = randomUUID(), accessToken = randomUUID(), coreGrantId = randomUUID();
  const cwd = path.join(directory, sessionId); fs.mkdirSync(cwd);
  putRecord('session', sessionId, { id: sessionId, cwd, provider: 'codex', alias: 'Fixture', createdAt: new Date().toISOString() });
  const certificate = { id: peerId, fixture: true }, permissions = full ? [...sessionPermissions] : ['observe'];
  const row = { id, resource: randomUUID(), sessionId, hostId, peerId, peerDigest: digest(certificate), relayUrl: 'wss://relay.example/v1/socket',
    sessionAccess: true, agentAccess: full, shareAccess: full, permissions, token: accessToken, coreGrantId, expiresAt: Date.now() + 3600000 };
  putRecord('access-token', digest(accessToken), { id: coreGrantId, sessionId, expiresAt: row.expiresAt, includeChildren: false, permissions });
  putRecord('core.relay.pin', peerId, { hostId, certificate }); putRecord('core.relay.grant', id, row);
  registerDeviceNotifications(row, { enabled, deviceToken, environment: 'sandbox', scope: 'authorized', relayPush, hostHints: true });
  return row;
}
function sender(sends, options = {}) {
  return new CorePushWorker({ configurationLoader: () => ({ fingerprint: 'fixture', environment: 'sandbox' }), hostID: () => hostId,
    clientFactory: () => ({ send: async value => { sends.push(value); return { accepted: true, apnsId: value.id }; }, close() {} }), ...options });
}

test('committed skill and specialist creations send concise iOS-compatible alerts exactly once', async () => {
  phone(); const skill = createSkill(definition(), { scope: 'global' });
  saveSubagentDefinition({ ...definition('header-reviewer'), instructions: 'PRIVATE_FIXTURE_INSTRUCTIONS: inspect only supplied headers.' }, { scope: 'global' });
  const sends = [], worker = sender(sends);
  try {
    await worker.tick(); await worker.tick(); assert.equal(sends.length, 2);
    assert.deepEqual(sends.map(item => item.payload.aps.alert.title).sort(), ['Agent created - header-reviewer', 'Skill created - response-check']);
    assert.ok(sends.every(item => item.payload.aps.alert.body === definition().description));
    assert.ok(!JSON.stringify(sends).includes('PRIVATE_FIXTURE_INSTRUCTIONS'));
    for (const sent of sends) {
      assert.ok(Object.keys(sent.payload.bzzy).every(key => ['v', 'eventId', 'hostId', 'destination', 'resource', 'sessionId', 'agentId'].includes(key)));
      assert.equal(sent.payload.bzzy.destination, 'terminal'); assert.equal(sent.payload.bzzy.hostId, hostId);
      assert.equal(sent.payload.bzzy.sessionId, undefined);
    }
    assert.equal(events().length, 2);
    assert.equal(recordLibraryCreation('skill', skill.id).id, events().find(row => row.event.type === 'library.skill_created').event.id);
  } finally { worker.close(); }
});

test('drafts, existing revisions, toggles, failed saves and rolled-back creations do not announce new skills', () => {
  stageSkillCandidate(definition('draft-check'), { scope: 'global', requestId: 'draft-fixture' }); assert.equal(events().length, 0);
  const skill = createSkill(definition(), { scope: 'global' }); assert.equal(events().length, 1);
  setSkillEnabled(skill.id, true, skill.revision, { scope: 'global' }); assert.equal(events().length, 1);
  assert.throws(() => createSkill(definition(), { scope: 'global' })); assert.equal(events().length, 1);
  assert.throws(() => transaction(() => {
    createSkill(definition('rolled-back'), { scope: 'global' }); throw new Error('Synthetic rollback');
  }), /Synthetic rollback/);
  assert.equal(events().length, 1); assert.equal(listRecords('core.library.creation').length, 1);
});

test('library alerts require the full own-phone grant and respect disabled or revoked registrations', async () => {
  const owner = phone(); phone({ full: false, deviceToken: 'cd'.repeat(32) });
  phone({ enabled: false, deviceToken: 'ef'.repeat(32) }); const revoked = phone({ deviceToken: '12'.repeat(32) });
  revokeDeviceNotifications(revoked, {});
  createSkill(definition(), { scope: 'global' });
  const sends = [], worker = sender(sends);
  try { await worker.tick(); assert.equal(sends.length, 1); assert.equal(sends[0].token, token); }
  finally { worker.close(); }
  assert.ok(getRecord('core.relay.grant', owner.id));
});

test('removed definitions and altered event receipts cannot produce stale or forged creation alerts', async () => {
  phone(); const a = saveSubagentDefinition(definition('removed-agent'), { scope: 'global' });
  deleteSubagentDefinition(a.name, { scope: 'global', expectedRevision: a.revision });
  createSkill(definition(), { scope: 'global' });
  const event = events().find(row => row.event.type === 'library.skill_created');
  putRecord('outbox', event.event.id, { ...event, event: { ...event.event, description: 'A forged replacement description.' } });
  assert.equal(currentLibraryCreation(event.event)?.name, 'response-check');
  const sends = [], worker = sender(sends);
  try { await worker.tick(); assert.equal(sends.length, 0); } finally { worker.close(); }
});

test('persistent agent creation is idempotent and notification previews exclude its private instructions', async () => {
  phone(); const root = path.join(directory, 'workspace'); fs.mkdirSync(root);
  new CoreWorkspaces().configure({ path: root }, { requestId: randomUUID(), expectedRevision: 0 });
  const agents = new CoreAgents(), requestId = randomUUID(), input = { name: 'Review assistant', instructions: 'PRIVATE_FIXTURE_AGENT_TASK', provider: 'codex', model: 'default', effort: 'default' };
  const first = agents.create(input, { requestId }), again = agents.create(input, { requestId });
  assert.equal(first.id, again.id); assert.equal(events().length, 1);
  const sends = [], worker = sender(sends);
  try {
    await worker.tick(); assert.equal(sends.length, 1); assert.equal(sends[0].payload.bzzy.destination, 'agents');
    assert.equal(sends[0].payload.bzzy.agentId, first.id); assert.equal(sends[0].payload.bzzy.sessionId, first.sessionId);
    assert.equal(sends[0].payload.aps.alert.title, 'Agent created - Review assistant');
    assert.ok(!JSON.stringify(sends).includes(input.instructions));
  } finally { worker.close(); }
});

test('deleting and recreating the same skill never revives its earlier queued creation alert', async () => {
  phone(); const old = createSkill(definition(), { scope: 'global' }), originalEvent = events()[0].event;
  deleteSkill(old.id, old.revision, { scope: 'global' });
  const replacement = createSkill(definition(), { scope: 'global' });
  assert.ok(replacement.revision > old.revision); assert.equal(currentLibraryCreation(originalEvent), null);
  const sends = [], worker = sender(sends);
  try { await worker.tick(); assert.equal(sends.length, 1); } finally { worker.close(); }
});

test('Relay library delivery reuses its durable notification ID across retries', async () => {
  phone({ relayPush: true }); createSkill(definition(), { scope: 'global' });
  const requests = [], worker = sender([], { relaySend: async (binding, request) => { requests.push(request); return { state: 'queued', providerConfigured: true }; } });
  try {
    await worker.tick(); assert.equal(requests.length, 1);
    const delivery = listRecords('core.push.delivery')[0]; putRecord('core.push.delivery', delivery.id, { ...delivery, nextAttemptAt: 0 });
    await worker.tick(); assert.equal(requests.length, 2); assert.equal(requests[0].id, requests[1].id);
    assert.deepEqual(requests[0].payload, requests[1].payload);
  } finally { worker.close(); }
});
