import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSession, saveSession, loadSession } from '../src/engine/store.js';
import { getProvider } from '../src/engine/providers.js';
import { getRecord, putRecord, listRecords } from '../src/engine/database.js';
import { saveWorkflow, getWorkflow, listWorkflows, deleteWorkflow, importWorkflow, selectWorkflow, workflowSelection } from '../src/engine/workflows.js';

let previous, directory, project, other, session;
const definition = (instructions = 'Inspect the supplied fixture, preserve evidence and report uncertainty.') => ({ name: 'evidence-first', description: 'A reusable evidence review.', instructions });
test.beforeEach(() => {
  previous = process.env.BZZY_HOME; directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-workflows-')));
  process.env.BZZY_HOME = path.join(directory, 'private'); project = path.join(directory, 'project'); other = path.join(directory, 'other');
  fs.mkdirSync(project); fs.mkdirSync(other); session = createSession(getProvider('codex'), project, 'offline-model'); saveSession(session);
});
test.afterEach(() => { if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous; fs.rmSync(directory, { recursive: true, force: true }); });

test('workflow registry preserves scope, immutable versions and revision-pinned changes without starting work', () => {
  const global = saveWorkflow(definition(), { scope: 'global' });
  const local = saveWorkflow(definition('Use the current project fixture only.'), { cwd: project });
  assert.equal(getWorkflow(local.name, { cwd: project }).id, local.id); assert.equal(getWorkflow(global.name, { cwd: other }).id, global.id);
  assert.equal(listWorkflows({ cwd: project }).total, 1); assert.equal(listWorkflows({ cwd: project }).workflows[0].instructions, undefined);
  assert.throws(() => saveWorkflow(definition(), { cwd: project }), { code: 'CONFLICT' });
  const edited = saveWorkflow(definition('An explicitly edited process.'), { cwd: project, expectedRevision: local.revision });
  assert.notEqual(edited.version, local.version); assert.equal(listRecords('core.workflow.version').length, 3);
  assert.throws(() => deleteWorkflow(local.name, { cwd: project, expectedRevision: local.revision }), { code: 'CONFLICT' });
  deleteWorkflow(local.name, { cwd: project, expectedRevision: edited.revision });
  assert.throws(() => getWorkflow(local.name, { cwd: project }), { code: 'NOT_FOUND' });
  assert.equal(listWorkflows({ cwd: project }).total, 0, 'A deleted local override cannot silently select a global workflow.');
  assert.equal(listRecords('execution').length, 0); assert.equal(listRecords('run').length, 0);
});

test('workflow imports preserve a complete long UTF-8 body and reject links, private stores and malformed text', () => {
  const body = 'FIRST_WORKFLOW_SENTINEL\n' + 'A bounded reusable observation. '.repeat(700) + '\nLAST_WORKFLOW_SENTINEL 🙂';
  const file = path.join(project, 'workflow.md'); fs.writeFileSync(file, body);
  const imported = importWorkflow(file, { cwd: project, name: 'long-process', description: 'Read the whole procedure.' });
  assert.ok(imported.instructions.includes(body)); assert.match(imported.instructions, /Build reusable behavior separately/);
  const symbolic = path.join(project, 'linked.md'); fs.symlinkSync(file, symbolic);
  assert.throws(() => importWorkflow(symbolic, { cwd: project, name: 'symbolic' }));
  const hard = path.join(project, 'hard.md'); fs.linkSync(file, hard);
  assert.throws(() => importWorkflow(hard, { cwd: project, name: 'hard' })); fs.unlinkSync(hard);
  const privateDirectory = path.join(directory, '.ssh'); fs.mkdirSync(privateDirectory); fs.writeFileSync(path.join(privateDirectory, 'workflow.txt'), body);
  const parentAlias = path.join(project, 'aliased'); fs.symlinkSync(privateDirectory, parentAlias);
  assert.throws(() => importWorkflow(path.join(parentAlias, 'workflow.txt'), { cwd: project, name: 'private' }));
  fs.writeFileSync(file, Buffer.from([0xff, 0xfe, 0xff])); assert.throws(() => importWorkflow(file, { cwd: project, name: 'invalid-utf' }));
  fs.writeFileSync(file, 'x'.repeat(128 * 1024 + 1)); assert.throws(() => importWorkflow(file, { cwd: project, name: 'too-large' }));
});

test('workflow definitions reject executable configuration, private bindings and control-byte instructions', () => {
  for (const input of [
    { ...definition(), provider: 'codex' }, { ...definition(), policy: { mode: 'read-only' } }, { ...definition(), argv: ['command'] },
    { ...definition(), accountBindings: ['private'] }, definition('password=not-a-real-fixture-password'),
    definition('Use private-person@example.test'), definition('Bad\0text'), definition('Bad\x1b[31mtext'), definition(''),
  ]) assert.throws(() => saveWorkflow(input, { scope: 'global' }), { code: 'INVALID_WORKFLOW' });
  assert.equal(listWorkflows({ scope: 'global' }).total, 0);
});

test('per-terminal selections survive stale session saves, alias/model changes and same-directory neighbors', () => {
  const workflow = saveWorkflow(definition(), { cwd: project }), stale = structuredClone(session);
  const neighbor = createSession(getProvider('codex'), project, 'neighbor-model'); saveSession(neighbor);
  assert.equal(workflowSelection(session).selected, null);
  const selected = selectWorkflow(session, workflow.name, { expectedRevision: 0, expectedWorkflowRevision: workflow.revision });
  assert.equal(selected.selected.id, workflow.id); assert.equal(selected.revision, 1);
  stale.alias = 'Renamed terminal'; stale.model = 'another-model'; saveSession(stale);
  assert.equal(workflowSelection(loadSession(session.id)).selected.id, workflow.id); assert.equal(workflowSelection(neighbor).selected, null);
  assert.equal(getRecord('session', session.id).workflowSelection, undefined);
  assert.throws(() => selectWorkflow(session, null, { expectedRevision: 0 }), { code: 'CONFLICT' });
  const edited = saveWorkflow(definition('Updated future procedure.'), { cwd: project, expectedRevision: workflow.revision });
  assert.equal(workflowSelection(session).selected.version, edited.version);
  assert.throws(() => selectWorkflow(session, workflow.name, { expectedRevision: 1, expectedWorkflowRevision: workflow.revision }), { code: 'CONFLICT' });
  deleteWorkflow(workflow.name, { cwd: project, expectedRevision: edited.revision }); assert.equal(workflowSelection(session).available, false);
  assert.equal(selectWorkflow(session, null, { expectedRevision: 1 }).selected, null);
});

test('selection resolves actual saved scope and cannot load worker or foreign project contexts', () => {
  const workflow = saveWorkflow(definition(), { cwd: other });
  assert.throws(() => selectWorkflow({ ...session, cwd: other }, workflow.name, { expectedRevision: 0 }), { code: 'NOT_FOUND' });
  const worker = createSession(getProvider('codex'), project, 'worker'); worker.parentSessionId = session.id; saveSession(worker);
  assert.throws(() => workflowSelection(worker), { code: 'WORKFLOW_SESSION_UNAVAILABLE' }); assert.equal(listRecords('execution').length, 0);
});

test('changed current definition bodies cannot retain an older version identity', () => {
  const workflow = saveWorkflow(definition(), { cwd: project }); selectWorkflow(session, workflow.name, { expectedRevision: 0 });
  putRecord('core.workflow.definition', workflow.id, { ...workflow, instructions: 'A changed unversioned procedure.' });
  assert.equal(workflowSelection(session).available, false);
  assert.throws(() => getWorkflow(workflow.name, { cwd: project }), { code: 'WORKFLOW_PIN_INVALID' });
});

test('workflow admission preserves approved account references and rejects any text needing mission redaction', () => {
  const text = 'Use API_KEY=<approved-private-host-reference> through the private gateway. Preserve the final control.\n' +
    'Use access_token=${AUTHORIZED_ACCOUNT} and password="[redacted]" as references only. Keep every subsequent step.';
  const workflow = saveWorkflow(definition(text), { cwd: project }); assert.ok(workflow.instructions.includes(text));
  for (const instructions of [
    'Use API_KEY=<literal-private-value> and preserve the control.',
    'Use API_KEY=<approved-private-host-reference> followed by PASSWORD=private-value.',
    'Bearer fixture-private-auth-material',
  ]) assert.throws(() => saveWorkflow({ ...definition(instructions), name: 'rejected-process' }, { cwd: project }), { code: 'INVALID_WORKFLOW' });
  assert.equal(listWorkflows({ cwd: project }).total, 1, 'Rejected instructions are not silently altered or saved.');
});
