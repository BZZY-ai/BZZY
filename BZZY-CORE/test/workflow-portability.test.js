import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createSession, saveSession, loadSession } from '../src/engine/store.js';
import { getProvider } from '../src/engine/providers.js';
import { newGoal } from '../src/engine/goals.js';
import { prepareTask } from '../src/engine/task.js';
import { getRecord, putRecord, listRecords, appendEvent, events } from '../src/engine/database.js';
import { collectProjectState, exportProject, importProject, exportSharedProject } from '../src/engine/project-bundle.js';
import { portableState, validateSharedManifest, stripWorkflowAuthority } from '../src/engine/share-bundle-policy.js';

let directory, project, previous, source;
const authorityFields = ['workflowSelection', 'workflowBinding', 'workflowAdmission', 'goalWorkflow', 'workflowReceipt', 'workflowPin'];
const historicalText = 'Historical workflow instructions: inspect the supplied control, retain uncertainty and summarize the evidence. The words workflowAdmission and workflowSelection are text, not host receipts.';
test.beforeEach(() => {
  previous = Object.fromEntries(['BZZY_HOME', 'BZZY_CODEX_HOME', 'BZZY_CLAUDE_HOME', 'CLAUDE_CONFIG_DIR'].map(key => [key, process.env[key]]));
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-workflow-portability-')));
  Object.assign(process.env, { BZZY_HOME: path.join(directory, 'sender-private'), BZZY_CODEX_HOME: path.join(directory, 'codex'),
    BZZY_CLAUDE_HOME: path.join(directory, 'claude'), CLAUDE_CONFIG_DIR: path.join(directory, 'claude') });
  project = path.join(directory, 'project'); fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'control.txt'), 'Synthetic supplied evidence.');
  source = createSession(getProvider('codex'), project, 'offline-workflow-model');
  prepareTask(source, {}, 'Inspect the supplied control.');
  source.goal = newGoal(source.contract.objective); source.goal.status = 'paused';
  source.contract.context = historicalText; saveSession(source);
});
test.afterEach(() => {
  for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  fs.rmSync(directory, { recursive: true, force: true });
});
function receipt() { return { version: 1, bindingId: randomUUID(), goalId: source.goal.id, workflowVersion: 'a'.repeat(64), fingerprint: 'b'.repeat(64) }; }
function seedAuthority() {
  const value = receipt();
  for (const suffix of ['definition', 'version', 'selection', 'goal-binding']) {
    const id = randomUUID(); putRecord('core.workflow.' + suffix, id,
      { id, sessionId: source.id, goalId: source.goal.id, text: historicalText, privateHostReceipt: value });
  }
  source.workflowSelection = value; source.goal.workflowBinding = value;
  source.contract.options = { workflowPin: value }; saveSession(source);
  const id = randomUUID(); putRecord('execution', id, { id, sessionId: source.id, state: 'finished', workflowAdmission: value,
    options: { goalWorkflow: value, nested: [{ workflowReceipt: value }] } });
  appendEvent(source.id, 'workflow.attached', { workflowBinding: value, descriptiveText: historicalText });
  appendEvent(source.id, 'message.user', { text: historicalText });
  return value;
}
function assertNoAuthority(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.equal(authorityFields.some(field => field.toLowerCase() === key.toLowerCase()), false, `Host authority field ${key} must not be portable.`);
    assertNoAuthority(child);
  }
}
function readManifest(file) {
  const result = spawnSync('python3', ['-c', 'import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1]) as z: sys.stdout.buffer.write(z.read("bundle.json"))', file],
    { encoding: 'utf8', timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr || result.error?.code); return JSON.parse(result.stdout);
}
function replaceManifest(file, manifest) {
  const destination = path.join(directory, randomUUID() + '.zip');
  const code = 'import sys,zipfile\nreplacement=sys.stdin.buffer.read()\nwith zipfile.ZipFile(sys.argv[1]) as original,zipfile.ZipFile(sys.argv[2],"w") as result:\n for item in original.infolist(): result.writestr(item,replacement if item.filename=="bundle.json" else original.read(item))';
  const result = spawnSync('python3', ['-c', code, file, destination], { input: JSON.stringify(manifest), encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || result.error?.code); return destination;
}
function recipient() {
  process.env.BZZY_HOME = path.join(directory, 'recipient-private-' + randomUUID());
  const target = path.join(directory, 'recipient-' + randomUUID()); fs.mkdirSync(target); return target;
}

test('ordinary and shared state exclude private workflow registries and nested admission fields while retaining instruction history', () => {
  seedAuthority();
  for (const shared of [false, true]) {
    const state = collectProjectState(project, source.id, { shared });
    assert.ok(state.records.some(row => row.kind === 'session'));
    assert.ok(state.records.every(row => !row.kind.startsWith('core.workflow')));
    assertNoAuthority(state);
    assert.equal(state.records.find(row => row.kind === 'session').data.contract.context, historicalText);
    assert.ok(state.events.some(event => event.data.text === historicalText));
    assert.equal(state.events.find(event => event.type === 'workflow.attached').data.descriptiveText, historicalText);
  }
  assert.ok(getRecord('session', source.id).workflowSelection, 'Read-only export does not rewrite private source history.');
  assert.equal(listRecords('core.workflow.selection').length, 1);
});

test('portable shared manifests reject forged host receipts and unsupported private workflow records', () => {
  const raw = { records: [{ kind: 'session', id: source.id, data: { ...source, workflowSelection: receipt(), goal: { ...source.goal, workflowBinding: receipt() } } }],
    events: [{ sessionId: source.id, type: 'workflow.attached', data: { workflowAdmission: receipt(), text: historicalText } }] };
  const clean = portableState(raw), manifest = { format: 'bzzy-project', version: 1, sharing: { version: 1, kind: 'TERMINAL' },
    providers: {}, ...clean };
  assertNoAuthority(clean); assert.equal(clean.records[0].data.contract.context, historicalText);
  assert.doesNotThrow(() => validateSharedManifest(manifest));
  for (const field of authorityFields) {
    const forged = structuredClone(manifest); forged.records[0].data[field] = receipt();
    assert.throws(() => validateSharedManifest(forged), /private|authority/i);
  }
  const forged = structuredClone(manifest);
  forged.records.push({ kind: 'core.workflow.goal-binding', id: randomUUID(), data: { sessionId: source.id, ...receipt() } });
  assert.throws(() => validateSharedManifest(forged), /unsupported host state/i);
});

test('ordinary ZIP imports strip forged workflow bindings without adopting them as current session or execution authority', async () => {
  const output = await exportProject(source, path.join(directory, 'source.zip'));
  const manifest = readManifest(output.path), value = receipt();
  const session = manifest.records.find(row => row.kind === 'session');
  session.data.workflowSelection = value; session.data.goal.workflowBinding = value;
  session.data.contract.future = { nested: [{ workflowAdmission: value }] };
  const id = randomUUID(); manifest.records.push({ kind: 'execution', id, data: { id, sessionId: source.id, state: 'running',
    workflowAdmission: value, options: { workflowReceipt: value } } });
  for (const suffix of ['definition', 'version', 'selection', 'goal-binding']) manifest.records.push({ kind: 'core.workflow.' + suffix,
    id: randomUUID(), data: { sessionId: source.id, ...value } });
  manifest.events.push({ seq: 100000, sessionId: source.id, type: 'workflow.attached', data: { workflowPin: value, text: historicalText }, createdAt: new Date().toISOString() });
  const forged = replaceManifest(output.path, manifest), restored = await importProject(forged, recipient());
  const imported = loadSession(restored.primarySession.id);
  assert.equal(imported.goal.importedHistorical, true); assert.equal(imported.contract.context, historicalText);
  for (const suffix of ['definition', 'version', 'selection', 'goal-binding']) assert.equal(listRecords('core.workflow.' + suffix).length, 0);
  const importedRecords = [...listRecords('session'), ...listRecords('execution')]; assertNoAuthority(importedRecords);
  assertNoAuthority(events(imported.id, 0, 1000));
  assert.equal(listRecords('execution')[0].state, 'interrupted');
});

test('a real shared ZIP retains contextual workflow text and no active workflow selection or host receipts', async () => {
  seedAuthority();
  const output = await exportSharedProject(source, path.join(directory, 'shared.zip'));
  const manifest = readManifest(output.path);
  assert.ok(manifest.records.every(row => !row.kind.startsWith('core.workflow'))); assertNoAuthority(manifest);
  assert.equal(manifest.records.find(row => row.kind === 'session').data.contract.context, historicalText);
  assert.equal(manifest.sharing.credentialBindings, false);
});

test('workflow authority stripping is bounded to reserved structured fields, not user-authored text or unrelated data', () => {
  const input = { text: historicalText, contract: { context: historicalText }, userData: ['workflowAdmission', { WorkflowBinding: receipt(), notes: 'Retain ordinary notes.' }] };
  const original = structuredClone(input), cleaned = stripWorkflowAuthority(input);
  assertNoAuthority(cleaned); assert.equal(cleaned.text, historicalText); assert.deepEqual(cleaned.userData, ['workflowAdmission', { notes: 'Retain ordinary notes.' }]);
  assert.deepEqual(input, original);
});
