import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { CoreAgents } from '../src/agents.js';
import { CoreAgentImports } from '../src/agent-imports.js';
import { CoreWorkspaces } from '../src/workspaces.js';
import { appendEvent, events, getRecord, listRecords, putRecord, digest } from '../src/engine/database.js';
import { createSession } from '../src/engine/store.js';
import { BUILTINS } from '../src/engine/providers.js';
import { importSharedProject, exportSharedProject } from '../src/engine/project-bundle.js';

let directory, previous;
test.beforeEach(() => { directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-agent-portable-')));
  previous = process.env.BZZY_HOME; process.env.BZZY_HOME = path.join(directory, 'source-private'); });
test.afterEach(() => { if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
  fs.rmSync(directory, { recursive: true, force: true }); });
function setup(name) {
  new CoreWorkspaces().configure({ path: path.join(directory, name), create: true }, { requestId: randomUUID(), expectedRevision: 0 });
  return new CoreAgents();
}
async function source() {
  const agents = setup('source-root'), agent = agents.create({ name: 'Payment helper', instructions: 'Keep complete payment notes. Never borrow account bindings.',
    provider: 'codex', model: 'source-model', effort: 'default' }, { requestId: randomUUID() });
  fs.mkdirSync(path.join(agent.cwd, '.bzzy')); fs.writeFileSync(path.join(agent.cwd, '.bzzy/notes.txt'), 'Full approved private notes.');
  fs.writeFileSync(path.join(agent.cwd, 'script.py'), 'print("portable behavior")\n');
  fs.writeFileSync(path.join(agent.cwd, '.env'), 'API_KEY=must-never-export-this-private-binding');
  const child = createSession(BUILTINS.codex, agent.cwd);
  putRecord('session', child.id, { ...child, parentSessionId: agent.sessionId, agentId: agent.id, purpose: 'worker', projectRoot: agent.cwd });
  const session = getRecord('session', agent.sessionId);
  putRecord('session', session.id, { ...session, goal: { id: randomUUID(), objective: 'Historical objective.', status: 'active', verdict: 'verified' } });
  const raw = '<message version="1"><p><b>Complete Agent history</b></p></message>';
  appendEvent(agent.sessionId, 'text', { text: raw }); appendEvent(child.id, 'message.user', { text: 'All child context.' });
  const memory = randomUUID(); putRecord('memory', memory, { id: memory, sessionId: agent.sessionId, text: 'Persistent remembered result.' });
  const zip = path.join(directory, 'agent.zip'); await agents.exportArchive(agent.sessionId, zip);
  return { agents, agent, child, raw, zip };
}
test('typed Agent full context gets new managed identity, own model and inactive full session tree', async () => {
  const exported = await source();
  const terminal = path.join(directory, 'terminal'); fs.mkdirSync(terminal);
  await assert.rejects(importSharedProject(exported.zip, terminal), { code: 'IMPORT_INVALID' });
  assert.deepEqual(fs.readdirSync(terminal), []);
  process.env.BZZY_HOME = path.join(directory, 'recipient-private'); const recipient = setup('recipient-root');
  const importId = randomUUID(), imported = await recipient.importArchive(exported.zip,
    { provider: 'claude', model: 'recipient-model', effort: 'default', name: 'My payment helper' }, { importId });
  assert.notEqual(imported.id, exported.agent.id); assert.notEqual(imported.sessionId, exported.agent.sessionId);
  assert.equal(imported.name, 'My payment helper'); assert.equal(imported.provider, 'claude'); assert.equal(imported.model, 'recipient-model');
  assert.ok(imported.cwd.startsWith(path.join(directory, 'recipient-root/Agents') + path.sep));
  assert.equal(fs.readFileSync(path.join(imported.cwd, '.bzzy/notes.txt'), 'utf8'), 'Full approved private notes.');
  assert.equal(fs.existsSync(path.join(imported.cwd, '.env')), false);
  assert.equal(listRecords('session').length, 2); assert.equal(listRecords('execution').length, 0); assert.equal(listRecords('core.agent').length, 1);
  for (const row of listRecords('session')) {
    assert.equal(row.agentId, imported.id); assert.equal(row.provider, 'claude'); assert.equal(row.model, 'recipient-model');
    assert.equal(row.backend, 'claude'); assert.equal(row.executionState, 'idle'); assert.equal(row.engineThreadId, null); assert.equal(row.importedUntrusted, true);
  }
  const primary = getRecord('session', imported.sessionId); assert.equal(primary.goal.status, 'paused'); assert.equal(primary.goal.importedHistorical, true);
  assert.ok(events(imported.sessionId).some(event => event.data.text === exported.raw));
  const child = listRecords('session').find(row => row.parentSessionId === imported.sessionId);
  assert.ok(events(child.id).some(event => event.data.text === 'All child context.'));
  assert.equal(listRecords('memory')[0].text, 'Persistent remembered result.');
  assert.deepEqual(await recipient.importArchive(exported.zip, { provider: 'claude', model: 'recipient-model', effort: 'default' }, { importId }), imported);
  const manifest = JSON.parse(fs.readFileSync(path.join(primary.importedContext.directory, 'bundle.json')));
  assert.equal(manifest.sharing.kind, 'AGENT'); assert.equal(manifest.sourceRoot, '/BZZY-PORTABLE/PROJECT');
  assert.doesNotMatch(JSON.stringify(manifest), /must-never-export|source-private|source-root/);
});
test('sharing an original Agent again never follows provenance into an imported copy', async () => {
  const exported = await source();
  const imported = await exported.agents.importArchive(exported.zip, { provider: 'claude', model: 'own-model', effort: 'default' });
  appendEvent(imported.sessionId, 'text', { text: 'Unrelated imported-copy private discussion.' });
  await exported.agents.exportArchive(exported.agent.sessionId, path.join(directory, 'again.zip'));
  process.env.BZZY_HOME = path.join(directory, 'recipient-private'); const recipient = setup('recipient-root');
  const restored = await recipient.importArchive(path.join(directory, 'again.zip'), { provider: 'codex', model: 'own-model', effort: 'default' });
  assert.equal(listRecords('session').length, 2);
  assert.ok(events(restored.sessionId).some(event => event.data.text === exported.raw));
  assert.ok(!events(restored.sessionId).some(event => event.data.text === 'Unrelated imported-copy private discussion.'));
  assert.equal(listRecords('memory').length, 1);
});
test('Agent evidence from an equivalent noncanonical private path remains complete and relocates safely', async () => {
  const exported = await source(), id = randomUUID(), artifactDirectory = path.join(process.env.BZZY_HOME, 'artifacts', id);
  fs.mkdirSync(artifactDirectory, { recursive: true }); fs.writeFileSync(path.join(artifactDirectory, 'proof.txt'), 'Complete native execution evidence.');
  const alias = process.env.BZZY_HOME + '/artifacts/../artifacts/' + id + '/proof.txt';
  putRecord('artifact', id, { id, sessionId: exported.agent.sessionId, path: alias, sha256: digest(fs.readFileSync(alias)), label: 'native-evidence' });
  const zip = path.join(directory, 'with-evidence.zip'); await exported.agents.exportArchive(exported.agent.sessionId, zip);
  process.env.BZZY_HOME = path.join(directory, 'recipient-private'); const recipient = setup('recipient-root');
  const imported = await recipient.importArchive(zip, { provider: 'claude', model: 'own-model', effort: 'default' });
  const artifact = listRecords('artifact')[0];
  assert.ok(artifact.path.startsWith(imported.cwd + path.sep));
  assert.equal(fs.readFileSync(artifact.path, 'utf8'), 'Complete native execution evidence.');
  assert.equal(artifact.sha256, digest(fs.readFileSync(artifact.path))); assert.equal(listRecords('execution').length, 0);
});
test('Agent imports reject terminal packages, missing selection, changed root and cancel with no partial Agent', async () => {
  const exported = await source(), terminal = path.join(directory, 'terminal'); fs.mkdirSync(terminal);
  const terminalSession = createSession(BUILTINS.codex, terminal), terminalZip = path.join(directory, 'terminal.zip'); await exportSharedProject(terminalSession, terminalZip);
  process.env.BZZY_HOME = path.join(directory, 'recipient-private'); const recipient = setup('recipient-root');
  const selection = { provider: 'codex', model: 'own-model', effort: 'default' };
  await assert.rejects(recipient.importArchive(terminalZip, selection), { code: 'IMPORT_INVALID' });
  await assert.rejects(recipient.importArchive(exported.zip, { provider: 'codex' }), { code: 'INVALID_REQUEST' });
  const abort = new AbortController(); abort.abort(); await assert.rejects(recipient.importArchive(exported.zip, selection, { signal: abort.signal }));
  let checks = 0;
  await assert.rejects(recipient.importArchive(exported.zip, selection, { authorize: () => { if (++checks === 3) throw Object.assign(new Error('revoked'), { code: 'FORBIDDEN' }); } }), { code: 'FORBIDDEN' });
  assert.equal(listRecords('session').length, 0); assert.equal(listRecords('core.agent').length, 0);
  assert.deepEqual(fs.readdirSync(path.join(directory, 'recipient-root/Agents')), []);
});
test('ephemeral receive jobs are exact device scoped, never save codes, and cancel without a model run', async () => {
  const exported = await source(); process.env.BZZY_HOME = path.join(directory, 'recipient-private'); const agents = setup('recipient-root');
  const binding = { id: randomUUID(), hostId: 'host', peerId: 'phone', resource: randomUUID(), relayUrl: 'relay' };
  const sourceFingerprint = randomBytes(32).toString('base64url'), recipientFingerprint = randomBytes(32).toString('base64url');
  const code = 'BZZY-AGENT-' + randomBytes(32).toString('base64url'); let finish;
  const controller = new CoreAgentImports({ agents, importer: async options => { options.onIdentity({ recipientFingerprint });
    await new Promise((resolve, reject) => { finish = resolve; options.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }); });
    options.onProgress({ received: 100, total: 100 }); return options.importArchive(exported.zip); } });
  const options = { binding, authorize: () => {} }, input = { code, expectedSenderFingerprint: sourceFingerprint, provider: 'claude', model: 'own-model', effort: 'default' };
  const receipt = controller.start(input, options); await delay(10);
  assert.equal(controller.status(receipt.importId, options).state, 'awaitingApproval');
  assert.equal(controller.status(receipt.importId, options).recipientFingerprint, recipientFingerprint);
  assert.throws(() => controller.status(receipt.importId, { binding: { ...binding, peerId: 'other' }, authorize: () => {} }), { code: 'FORBIDDEN' });
  assert.doesNotMatch(JSON.stringify(listRecords('core.agent')), new RegExp(code));
  await controller.cancel(receipt.importId, options); assert.equal(controller.status(receipt.importId, options).state, 'cancelled');
  assert.equal(listRecords('session').length, 0);
  const completed = controller.start(input, options); await delay(10); finish();
  for (let i = 0; i < 100 && controller.status(completed.importId, options).state !== 'complete'; i++) await delay(10);
  const status = controller.status(completed.importId, options); assert.equal(status.state, 'complete'); assert.equal(status.agent.provider, 'claude');
  assert.equal(listRecords('execution').length, 0); assert.doesNotMatch(JSON.stringify(listRecords('core.agent')), new RegExp(code));
  await controller.close();
});
test('revocation and managed-root changes abort pending imports and never materialize a registered Agent', async () => {
  const exported = await source(); process.env.BZZY_HOME = path.join(directory, 'recipient-private'); const agents = setup('recipient-root');
  const binding = { id: randomUUID(), hostId: 'host', peerId: 'phone', resource: randomUUID(), relayUrl: 'relay' };
  let allowed = true;
  const authorize = () => { if (!allowed) throw Object.assign(new Error('revoked'), { code: 'FORBIDDEN' }); };
  const importer = async options => { options.onIdentity({ recipientFingerprint: randomBytes(32).toString('base64url') });
    await delay(300, undefined, { signal: options.signal }); return options.importArchive(exported.zip); };
  const controller = new CoreAgentImports({ agents, importer });
  const input = { code: 'BZZY-AGENT-' + randomBytes(32).toString('base64url'), expectedSenderFingerprint: randomBytes(32).toString('base64url'),
    provider: 'codex', model: 'own-model', effort: 'default' };
  const options = { binding, authorize }, revoked = controller.start(input, options); await delay(10); allowed = false;
  await delay(350); allowed = true; assert.equal(controller.status(revoked.importId, options).state, 'cancelled');
  const moved = controller.start(input, options); await delay(10);
  new CoreWorkspaces().configure({ path: path.join(directory, 'replacement-root'), create: true }, { requestId: randomUUID(), expectedRevision: 1 });
  await delay(350); assert.equal(controller.status(moved.importId, options).state, 'cancelled');
  assert.equal(listRecords('core.agent').length, 0); assert.equal(listRecords('session').length, 0); assert.equal(listRecords('execution').length, 0);
  await controller.close();
});
test('a completed registry commit wins a late transfer/cancellation response failure', async () => {
  const exported = await source(); process.env.BZZY_HOME = path.join(directory, 'recipient-private'); const agents = setup('recipient-root');
  const binding = { id: randomUUID(), hostId: 'host', peerId: 'phone', resource: randomUUID(), relayUrl: 'relay' };
  const controller = new CoreAgentImports({ agents, importer: async options => {
    options.onIdentity({ recipientFingerprint: randomBytes(32).toString('base64url') });
    await options.importArchive(exported.zip);
    throw Object.assign(new Error('late response unavailable'), { code: 'TRANSFER_UNAVAILABLE' });
  } });
  const options = { binding, authorize: () => {} }, receipt = controller.start({ code: 'BZZY-AGENT-' + randomBytes(32).toString('base64url'),
    expectedSenderFingerprint: randomBytes(32).toString('base64url'), provider: 'claude', model: 'own-model', effort: 'default' }, options);
  for (let i = 0; i < 200 && controller.status(receipt.importId, options).state !== 'complete'; i++) await delay(10);
  const status = controller.status(receipt.importId, options);
  assert.equal(status.state, 'complete'); assert.equal(status.agent.importId, receipt.importId); assert.equal(status.errorCode, undefined);
  assert.equal(listRecords('core.agent').length, 1); assert.equal(listRecords('execution').length, 0);
  await assert.rejects(controller.cancel(receipt.importId, options), { code: 'CONFLICT' });
  await controller.close();
});
