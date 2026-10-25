import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openWorkflows, workflowRows, workflowAction, workflowChatLabel } from '../src/workflow-ui.js';
import { createChatSession } from '@bzzy/core/engine/host-commands.js';
import { getProvider } from '@bzzy/core/engine/providers.js';
import { loadSession, saveSession } from '@bzzy/core/engine/store.js';
import { listRecords, getRecord } from '@bzzy/core/engine/database.js';
import { saveWorkflow, getWorkflow, workflowSelection, selectWorkflow, listWorkflows, getGoalWorkflow } from '@bzzy/core/engine/workflows.js';
import { prepareTask } from '@bzzy/core/engine/task.js';
import { newGoal } from '@bzzy/core/engine/goals.js';
import { enqueueExecution } from '@bzzy/core/engine/execution-queue.js';

let directory, previous, session, ui, notices;
const definition = (name = 'response-review', instructions = 'Read all supplied evidence before reasoning about the response.') => ({ name, description: 'A reusable response-review process.', instructions });
const rows = () => workflowRows(ui);
const pick = name => rows().find(row => row.action?.startsWith('select:') && row.text.includes(name)).action;
const view = name => rows().find(row => row.action?.startsWith('view:') && row.text.includes(name)).action;
test.beforeEach(() => {
  previous = process.env.BZZY_HOME; directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-workflow-ui-')));
  process.env.BZZY_HOME = path.join(directory, 'private');
  session = createChatSession(getProvider('codex'), { cwd: directory, model: 'fixture', effort: 'default' }); notices = [];
  ui = { sessionId: session.id, openTerminal() {}, event(type, data) { notices.push({ type, ...data }); },
    tui: { cwd: directory, panel: 'chat', value: 'Retain this draft', cursor: 5, schedule() {}, setPanel(panel) { this.panel = panel; } } };
});
test.afterEach(() => {
  if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
  fs.rmSync(directory, { recursive: true, force: true });
});

test('name rows select immediately, one workflow stays selected, and None clears the durable terminal choice', async () => {
  const first = saveWorkflow(definition(), { cwd: directory }), second = saveWorkflow(definition('second-review'), { scope: 'global' });
  openWorkflows(ui); assert.match(rows().map(row => row.text).join('\n'), /✓ None/);
  assert.ok(rows().filter(row => row.action)[ui.tui.workflowFocus].action.startsWith('none:'));
  await workflowAction(pick(first.name), ui);
  assert.equal(workflowSelection(session.id).selected.id, first.id); assert.equal(ui.workflowPreview, null);
  assert.equal(rows().filter(row => /^✓ /.test(row.text)).length, 1); assert.equal(workflowChatLabel(ui), first.name);
  assert.ok(rows().filter(row => row.action)[ui.tui.workflowFocus].action.startsWith('select:project:' + first.name));
  await workflowAction(pick(second.name), ui); assert.equal(workflowSelection(session.id).selected.id, second.id);
  assert.equal(rows().filter(row => /^✓ /.test(row.text)).length, 1);
  ui.sessionId = null; ui.sessionId = session.id; assert.equal(workflowChatLabel(ui), second.name);
  await workflowAction(rows().find(row => row.action?.startsWith('none:')).action, ui);
  assert.equal(workflowSelection(session.id).selected, null); assert.match(rows().map(row => row.text).join('\n'), /✓ None/);
  assert.equal(listRecords('execution').length, 0); assert.equal(listRecords('run').length, 0);
});

test('create and load retain full workflow text without selecting or starting work', async () => {
  openWorkflows(ui);
  const answers = ['created-review', 'Reusable procedure.', 'First line.\nSecond complete line.']; ui.ask = async () => answers.shift(); ui.chooseOne = async () => 'project';
  await workflowAction('create', ui); assert.match(ui.workflowPreview.instructions, /First line\.\nSecond complete line\./);
  assert.equal(workflowSelection(session.id).selected, null);
  const filename = path.join(directory, 'workflow.txt'), text = 'FIRST_MARKER\n' + 'Inspect the supplied record.\n'.repeat(800) + 'LAST_MARKER'; fs.writeFileSync(filename, text);
  const inputs = [filename, 'loaded-review', 'A complete imported process.']; ui.ask = async () => inputs.shift(); ui.chooseOne = async () => 'global';
  await workflowAction('load', ui); assert.ok(ui.workflowPreview.instructions.includes(text)); assert.equal(ui.workflowPreview.scope, 'global');
  assert.ok(rows().some(row => row.text.includes('FIRST_MARKER') && row.text.includes('LAST_MARKER')));
  assert.equal(workflowSelection(session.id).selected, null); assert.equal(listRecords('execution').length, 0);
});

test('a workflow selected before the first goal is admitted to the same idle terminal session', async () => {
  const workflow = saveWorkflow(definition(), { cwd: directory }); assert.equal(loadSession(session.id).goal, null);
  ui.sessionId = null; ui.ensureWorkflowSession = async () => { ui.sessionId = session.id; return loadSession(session.id); };
  openWorkflows(ui); await workflowAction(pick(workflow.name), ui); assert.equal(ui.sessionId, session.id);
  const first = loadSession(session.id); prepareTask(first, { mode: 'solo' }, 'Inspect the supplied fixture.'); first.goal = newGoal(first.contract.objective); saveSession(first);
  const queued = enqueueExecution(first.id, { prompt: first.goal.objective, options: {}, goal: true }, randomUUID(), { authorize() {} });
  const saved = loadSession(session.id), execution = getRecord('execution', queued.executionId);
  assert.equal(execution.sessionId, session.id); assert.equal(getGoalWorkflow(session.id).workflow.id, workflow.id);
  assert.ok(saved.contract.context.includes(workflow.instructions)); assert.equal(listRecords('session').length, 1); assert.equal(listRecords('run').length, 0);
  const before = saved.contract.context; rows(); await workflowAction('clear', ui);
  assert.equal(loadSession(session.id).contract.context, before); assert.equal(getGoalWorkflow(session.id).workflow.id, workflow.id);
});

test('workflow and selection revision checks reject stale picks without changing the selected workflow', async () => {
  const first = saveWorkflow(definition(), { cwd: directory }), second = saveWorkflow(definition('second-review'), { cwd: directory });
  openWorkflows(ui); const stale = pick(first.name);
  saveWorkflow(definition(first.name, 'A revised process.'), { cwd: directory, expectedRevision: first.revision });
  await workflowAction(stale, ui); assert.equal(workflowSelection(session.id).selected, null);
  rows(); const staleSelection = pick(second.name);
  selectWorkflow(session.id, first.name, { expectedRevision: 0 });
  await workflowAction(staleSelection, ui); assert.equal(workflowSelection(session.id).selected.name, first.name);
  const staleNone = rows().find(row => row.action?.startsWith('none:')).action;
  selectWorkflow(session.id, second.name, { expectedRevision: 1 }); await workflowAction(staleNone, ui);
  assert.equal(workflowSelection(session.id).selected.name, second.name);
  assert.ok(notices.filter(row => row.type === 'error').length >= 3);
});

test('editing and deletion pin reviewed versions, Cancel is default, and unavailable selections can be cleared', async () => {
  const workflow = saveWorkflow(definition(), { cwd: directory }); openWorkflows(ui); await workflowAction(pick(workflow.name), ui);
  await workflowAction(view(workflow.name), ui);
  let choices; ui.chooseOne = async (_title, options) => { choices = options; return 'cancel'; };
  await workflowAction('delete', ui); assert.equal(choices[0].value, 'cancel'); assert.equal(choices[0].selected, true);
  const answers = ['Edited procedure.', 'Revised complete workflow text.']; ui.ask = async () => answers.shift();
  await workflowAction('edit', ui); assert.ok(ui.workflowPreview.instructions.startsWith('Revised complete workflow text.'));
  assert.equal(getWorkflow(workflow.name, { cwd: directory }).revision, 2);
  ui.chooseOne = async () => 'delete'; await workflowAction('delete', ui);
  assert.equal(workflowSelection(session.id).available, false); assert.match(workflowChatLabel(ui), /unavailable/);
  rows(); await workflowAction('clear', ui); assert.equal(workflowSelection(session.id).selected, null);
});

test('Back preserves origins and drafts; context or active worker-tab changes cancel pending edits', async () => {
  const workflow = saveWorkflow(definition(), { cwd: directory });
  for (const origin of ['skills', 'agents', 'chat']) {
    ui.tui.panel = origin; openWorkflows(ui); await workflowAction(view(workflow.name), ui);
    await workflowAction('back', ui); assert.equal(ui.tui.panel, 'workflows'); assert.equal(ui.workflowPreview, null);
    await workflowAction('back', ui); assert.equal(ui.tui.panel, origin);
    assert.equal(ui.tui.value, 'Retain this draft'); assert.equal(ui.tui.cursor, 5);
  }
  openWorkflows(ui); ui.ask = async () => { ui.activeTab = randomUUID(); return 'discarded-workflow'; };
  await workflowAction('create', ui); assert.equal(listWorkflows({ cwd: directory }).total, 1);
  ui.activeTab = randomUUID(); await workflowAction(pick(workflow.name), ui);
  assert.equal(workflowSelection(session.id).selected, null);
  assert.ok(notices.some(row => row.type === 'error' && /root terminal|changed/.test(row.message)));
});

test('captured global actions cannot affect another terminal even after its matching list and revisions are refreshed', async () => {
  const first = saveWorkflow(definition('global-first', 'ORIGINAL_PREVIEW_MARKER'), { scope: 'global' });
  const second = saveWorkflow(definition('global-second'), { scope: 'global' });
  openWorkflows(ui); await workflowAction(pick(first.name), ui);
  const oldSelect = pick(first.name), oldView = view(first.name), oldNone = rows().find(row => row.action?.startsWith('none:')).action;
  await workflowAction(oldView, ui); assert.ok(ui.workflowPreview.instructions.includes('ORIGINAL_PREVIEW_MARKER'));
  const other = createChatSession(getProvider('codex'), { cwd: directory, model: 'fixture', effort: 'default' });
  selectWorkflow(other.id, second.name, { scope: 'global', expectedRevision: 0 });
  ui.sessionId = other.id; openWorkflows(ui);
  assert.equal(ui.workflowPreview, null); assert.ok(!rows().some(row => row.text.includes('ORIGINAL_PREVIEW_MARKER')));
  for (const action of [oldSelect, oldView, oldNone]) {
    openWorkflows(ui); await workflowAction(action, ui);
    assert.equal(workflowSelection(other.id).selected.id, second.id); assert.equal(ui.workflowPreview, null);
  }
  assert.equal(workflowSelection(session.id).selected.id, first.id);
  assert.ok(notices.filter(row => row.type === 'error' && /another terminal or host/.test(row.message)).length >= 3);
});

test('captured actions remain invalid across private hosts with the same session ID and workflow metadata', async () => {
  const workflow = saveWorkflow(definition('global-process'), { scope: 'global' });
  openWorkflows(ui); await workflowAction(pick(workflow.name), ui);
  const oldSelect = pick(workflow.name), oldView = view(workflow.name), oldNone = rows().find(row => row.action?.startsWith('none:')).action;
  const originalHome = process.env.BZZY_HOME;
  process.env.BZZY_HOME = path.join(directory, 'other-private');
  try {
    saveSession({ ...session }); saveWorkflow(definition('global-process'), { scope: 'global' });
    selectWorkflow(session.id, workflow.name, { scope: 'global', expectedRevision: 0 });
    for (const action of [oldSelect, oldView, oldNone]) { openWorkflows(ui); await workflowAction(action, ui); }
    assert.equal(workflowSelection(session.id).revision, 1); assert.equal(workflowSelection(session.id).selected.name, workflow.name);
    assert.equal(ui.workflowPreview, null);
  } finally { process.env.BZZY_HOME = originalHome; }
  assert.equal(workflowSelection(session.id).revision, 1);
});
