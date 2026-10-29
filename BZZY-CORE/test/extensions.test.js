import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSession, saveSession } from '../src/engine/store.js';
import { events, listRecords, putRecord } from '../src/engine/database.js';
import { saveExtension, normalizeExtension, getExtension, deleteExtension, setExtensionEnabled, readExtension, saveExtensionSecrets, runExtensionAction, extensionTool } from '../src/engine/extensions.js';
import { publicExtensionAddress, extensionURL } from '../src/engine/extension-network.js';
import { ToolHost, taskTools } from '../src/engine/tools.js';
import { authoringHelp } from '../src/engine/authoring-guides.js';
import { previewLibraryExport, buildLibraryArchive, previewLibraryImport, importLibraryBundle, readDefinitionBundleFile, discardDefinitionBundleReview } from '../src/engine/definition-bundle.js';
import { collectProjectState } from '../src/engine/project-bundle.js';
const guide = fs.readFileSync(new URL('../assets/authoring/extensions.md', import.meta.url), 'utf8');
const example = marker => JSON.parse(guide.match(new RegExp('<!-- bzzy-example:' + marker + ' -->\\s*```json\\n([\\s\\S]*?)\\n```'))[1]);
let directory, previous, cwd, session;
test.beforeEach(() => {
  previous = process.env.BZZY_HOME; directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-extensions-')));
  process.env.BZZY_HOME = path.join(directory, 'private'); cwd = path.join(directory, 'project'); fs.mkdirSync(cwd);
  session = createSession({ id: 'codex', backend: 'codex' }, cwd);
});
test.afterEach(() => { if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous; fs.rmSync(directory, { recursive: true, force: true }); });
function installed(http = false) { const d = example('extension'); if (http) { d.actions.push(example('http-action')); d.elements.push({ id: 'refresh-button', type: 'button', label: 'Refresh', action: 'refresh' }); } return saveExtension(d); }
const args = (v, action, requestId) => ({ version: v.version, revision: v.revision, action, requestId });

test('documented examples validate and unknown executable/schema fields are rejected', () => {
  assert.ok(authoringHelp(['--help-extensions']).includes(guide.trim()));
  assert.throws(() => authoringHelp(['--help-extensions', 'install']), { code: 'AUTHORING_HELP_USAGE' });
  const d = example('extension'); assert.deepEqual(normalizeExtension(d), d);
  for (const mutate of [d => { d.script = 'run.js'; }, d => { d.elements[4].value = 'private'; }, d => { d.elements[1].type = 'html'; }, d => { d.actions[0].ai = true; }]) { const bad = structuredClone(d); mutate(bad); assert.throws(() => normalizeExtension(bad)); }
  installed(true);
});
test('chat tools read controls, set ordinary fields and click idempotently with revision protection', async () => {
  installed(); const host = new ToolHost(session, { event() {} }, { goalMode: false });
  assert.ok(taskTools(session).some(t => t.name === 'interact_extension'));
  const v = await host.call('read_extension', { id: 'sample-board' });
  const changed = await host.call('interact_extension', { id: v.id, operation: 'set', version: v.version, revision: v.revision, values: { query: 'ordinary query' } });
  await assert.rejects(host.call('interact_extension', { id: v.id, operation: 'set', version: v.version, revision: 0, values: { query: 'stale' } }), { code: 'CONFLICT' });
  const input = { id: v.id, operation: 'click', ...args(changed, 'preview', 'preview-1') }, result = await host.call('interact_extension', input);
  assert.equal(result.elements.find(e => e.id === 'preview-text').value, 'ordinary query');
  assert.equal((await host.call('interact_extension', input)).revision, result.revision);
  await assert.rejects(host.call('interact_extension', { ...input, values: { query: 'new' } }), { code: 'CONFLICT' });
  assert.equal(listRecords('extension.request').length, 1); assert.doesNotMatch(JSON.stringify(events(session.id, 0, 1000)), /ordinary query/);
});
test('private credentials are injected only in broker, reflected secrets redacted, table data paged and session isolated', async () => {
  installed(true); const v = readExtension(session, 'sample-board'), secret = 'fixtureonly-extension-private-credential';
  saveExtensionSecrets(session, v.id, { version: v.version, installationId: v.installationId, secrets: { 'token-input': secret } });
  let calls = 0; const input = args(v, 'refresh', 'read-1');
  const result = await runExtensionAction(session, v.id, input, { request: async (url, headers) => { calls++; assert.equal(headers.Authorization, 'Bearer ' + secret); assert.equal(url.origin, 'https://api.example.com'); return { data: Array.from({ length: 240 }, (_, i) => ({ name: 'item-' + i, state: i ? 'active' : secret })) }; } });
  assert.equal(calls, 1); const table = result.elements.find(e => e.id === 'results'); assert.equal(table.total, 240); assert.equal(table.rows[0].state, '[private]');
  assert.equal(readExtension(session, v.id, { offset: 200, limit: 100 }).elements.find(e => e.id === 'results').rows[0].name, 'item-200');
  await runExtensionAction(session, v.id, input, { request: () => { throw new Error('no replay'); } });
  assert.doesNotMatch(JSON.stringify([result, ...listRecords('extension.state'), ...listRecords('extension.request')]), new RegExp(secret));
  assert.equal(fs.statSync(path.join(process.env.BZZY_HOME, 'credentials.extensions.json')).mode & 0o777, 0o600);
  const other = createSession({ id: 'codex', backend: 'codex' }, cwd); assert.equal(readExtension(other, v.id).elements.find(e => e.type === 'secret').configured, false);
});
test('models cannot bind/save credentials or borrow extension access as workers, persistent Agents or forged sessions', async () => {
  installed(true); const v = readExtension(session, 'sample-board');
  assert.throws(() => extensionTool(session, 'interact_extension', { id: v.id, operation: 'set', version: v.version, revision: 0, values: { 'token-input': 'MUST-NOT-LOG-THIS' } }), { code: 'FORBIDDEN' });
  await assert.rejects(extensionTool(session, 'interact_extension', { id: v.id, operation: 'click', ...args(v, 'save', 'save-1') }), { code: 'FORBIDDEN' });
  for (const child of [{ ...session, role: 'executor' }, { ...session, parentSessionId: session.id }, { ...session, purpose: 'agent', agentId: 'one' }, { ...session, cwd: '/forged' }]) { try { assert.equal(taskTools(child).some(t => t.name === 'read_extension'), false); } catch (error) { assert.equal(error.code, 'FORBIDDEN'); } assert.throws(() => readExtension(child, v.id), { code: 'FORBIDDEN' }); }
  const host = new ToolHost(session, { event() {} }); await assert.rejects(host.call('interact_extension', { id: v.id, operation: 'set', secrets: { token: 'MUST-NOT-LOG-THIS' } }));
  assert.doesNotMatch(JSON.stringify(events(session.id, 0, 1000)), /MUST-NOT-LOG-THIS/);
  session.policy = { ...session.policy, network: 'disabled' }; saveSession(session);
  await assert.rejects(runExtensionAction(session, v.id, args(v, 'refresh', 'denied')), { code: 'FORBIDDEN' });
});
test('disable withholds an in-flight result and pending requests are never replayed', async () => {
  let item = installed(true), release, called; const reached = new Promise(resolve => { called = resolve; });
  saveExtensionSecrets(session, item.id, { version: item.version, installationId: item.installationId, secrets: { 'token-input': 'fixture-private-binding' } });
  const v = readExtension(session, item.id), input = args(v, 'refresh', 'in-flight');
  const pending = runExtensionAction(session, item.id, input, { request: () => { called(); return new Promise(resolve => { release = resolve; }); } }); await reached;
  await assert.rejects(runExtensionAction(session, item.id, input), { code: 'UNCERTAIN' }); item = setExtensionEnabled(item.id, false, item.revision);
  release({ data: [{ name: 'withheld' }] }); await assert.rejects(pending, { code: 'EXTENSION_ACTION_FAILED' });
  assert.throws(() => readExtension(session, item.id)); item = setExtensionEnabled(item.id, true, item.revision);
  assert.equal(readExtension(session, item.id).elements.find(e => e.id === 'results').total, 0);
  putRecord('run', session.id, { id: 'stopped-run', state: 'stopped' }); await assert.rejects(new ToolHost(session, { event() {} }, { runId: 'stopped-run' }).call('read_extension', { id: item.id }), { code: 'FORBIDDEN' });
});
test('replacement and remove/reinstall cannot inherit private bindings', () => {
  let item = installed(); saveExtensionSecrets(session, item.id, { version: item.version, installationId: item.installationId, secrets: { 'token-input': 'fixture-private-binding' } });
  item = setExtensionEnabled(item.id, false, item.revision); item = setExtensionEnabled(item.id, true, item.revision); assert.equal(readExtension(session, item.id).elements.find(e => e.type === 'secret').configured, true);
  const oldInstallationId = item.installationId;
  deleteExtension(item.id, item.revision); item = saveExtension(item.definition);
  assert.throws(() => saveExtensionSecrets(session, item.id, { version: item.version, installationId: oldInstallationId, secrets: { 'token-input': 'stale-private-input' } }), { code: 'CONFLICT' }); assert.equal(readExtension(session, item.id).elements.find(e => e.type === 'secret').configured, false);
  const changed = structuredClone(item.definition); changed.title = 'Updated Board'; item = saveExtension(changed, { expectedRevision: item.revision }); assert.equal(readExtension(session, item.id).revision, 0);
});
test('public HTTPS validation rejects private, translated and loopback destinations', () => {
  for (const url of ['http://api.example.com', 'https://127.0.0.1', 'https://[::1]', 'https://a.local', 'https://example.com:8443', 'https://a:b@example.com', 'https://example.com/?key=x']) assert.throws(() => extensionURL(url));
  for (const a of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.0.1', '100.64.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', '2001:db8::1', '2002::1']) assert.equal(publicExtensionAddress(a), false, a);
  for (const a of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(publicExtensionAddress(a), true);
});
test('extension Relay Library archive round trip exports definitions only and never transfers private bindings', () => {
  const item = installed(true); saveExtensionSecrets(session, item.id, { version: item.version, installationId: item.installationId, secrets: { 'token-input': 'PRIVATE-EXTENSION-ACCOUNT' } });
  const review = previewLibraryExport({ cwd, kinds: ['extension'] });
  try {
    assert.equal(review.entries[0].kind, 'extension'); const body = readDefinitionBundleFile(review, { cwd, entryIndex: 0, file: 'definition.json' }); assert.match(body.text, /bzzy-extension/); assert.doesNotMatch(body.text, /PRIVATE-EXTENSION/);
    const folder = path.join(process.env.BZZY_HOME, 'relay/shares', randomUUID()); fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    const file = path.join(folder, 'project.zip'); buildLibraryArchive(file, { cwd, expectedDigest: review.sourceDigest, kinds: ['extension'] });
    assert.equal(collectProjectState(cwd).records.some(r => /^(extension\.|core\.extension)/.test(r.kind)), false);
    process.env.BZZY_HOME = path.join(directory, 'receiver'); const imported = previewLibraryImport(file, { cwd }), result = importLibraryBundle(imported, { cwd, enable: true }); assert.equal(result.extensions.length, 1); assert.equal(getExtension(item.id).enabled, true);
    const receiver = createSession({ id: 'codex', backend: 'codex' }, cwd); assert.equal(readExtension(receiver, item.id).elements.find(e => e.type === 'secret').configured, false);
    const repeat = previewLibraryImport(file, { cwd }); assert.equal(repeat.conflicts.length, 1); assert.deepEqual(importLibraryBundle(repeat, { cwd, enable: true }), result);
  } finally { discardDefinitionBundleReview(review); }
});

test('model views remain bounded and can focus an omitted element without losing ID discovery', () => {
  const d = { format: 'bzzy-extension', version: 1, id: 'large-board', title: 'Large Board', description: 'Bounded text fixture.',
    elements: Array.from({ length: 5 }, (_, i) => ({ id: 'field-' + i, type: 'text', text: 'a'.repeat(12000) })), actions: [] };
  saveExtension(d); const view = extensionTool(session, 'read_extension', { id: d.id });
  assert.ok(Buffer.byteLength(JSON.stringify(view)) <= 65536); assert.deepEqual(view.elementIds, d.elements.map(e => e.id));
  const last = extensionTool(session, 'read_extension', { id: d.id, elementId: 'field-4' }); assert.equal(last.elements.length, 1); assert.equal(last.elements[0].value.length, 12000);
});
