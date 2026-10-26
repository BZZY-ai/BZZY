import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { UI } from '../src/ui.js';
import { createChatSession } from '@bzzy/core/engine/host-commands.js';
import { getProvider } from '@bzzy/core/engine/providers.js';
import { saveWorkflow, workflowSelection } from '@bzzy/core/engine/workflows.js';
import { listRecords } from '@bzzy/core/engine/database.js';
import { clean } from '../src/terminal-format.js';

let directory, previous, ui, session;
test.beforeEach(() => {
  previous = process.env.BZZY_HOME;
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-workflow-command-')));
  process.env.BZZY_HOME = path.join(directory, 'private');
  const input = new PassThrough(); Object.assign(input, { isTTY: true, setRawMode() {} });
  const output = new PassThrough(); Object.assign(output, { isTTY: true, columns: 100, rows: 38 }); output.resume();
  ui = new UI({ input, output, error: output });
  session = createChatSession(getProvider('codex'), { cwd: directory, model: 'offline-model', effort: 'default' });
  ui.setSession(session.id); ui.updateSession(session);
  ui.tui.value = 'Keep this unsent draft'; ui.tui.cursor = 8;
});
test.afterEach(() => {
  ui.close();
  if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
  fs.rmSync(directory, { recursive: true, force: true });
});

test('actual workflow commands, picker clicks and loaded label stay in client controls without sending model work', { timeout: 5000 }, async () => {
  const definition = saveWorkflow({ name: 'response-review', description: 'Review supplied evidence.', instructions: 'Inspect the complete supplied response and retain uncertainty.' }, { cwd: directory });
  assert.equal(await ui.settingsCommand('/workflow library'), true); assert.equal(ui.tui.panel, 'workflows');
  let input = ui.ask('bzzy › '); await Promise.resolve(); ui.tui.render();
  let hit = ui.tui.hitTargets.find(row => row.type === 'workflow-action' && row.action.startsWith('select:'));
  assert.ok(hit); ui.tui.mouse(0, hit.left, hit.row);
  let command = await input; assert.match(command, /^\/workflow select:/);
  assert.equal(await ui.settingsCommand(command), true);
  assert.equal(workflowSelection(session.id).selected.id, definition.id);
  ui.tui.key('', { name: 'escape' }); ui.tui.render(); assert.equal(ui.tui.panel, 'chat');
  assert.match(ui.tui.lastFrame.map(clean).join('\n'), /Workflow: response-review/);
  input = ui.ask('bzzy › '); await Promise.resolve(); ui.tui.render();
  hit = ui.tui.hitTargets.find(row => row.type === 'workflow-open'); assert.ok(hit);
  ui.tui.mouse(0, hit.left, hit.row); command = await input; assert.equal(command, '/workflow');
  const picker = ui.settingsCommand(command); await Promise.resolve(); await Promise.resolve(); ui.tui.render();
  assert.equal(ui.tui.selection.scope, 'workflow-picker');
  ui.tui.key('', { name: 'up' }); ui.tui.key('', { name: 'return' });
  assert.equal(await picker, true); assert.equal(workflowSelection(session.id).selected, null);
  assert.equal(await ui.settingsCommand('/workflows'), false);
  assert.equal(await ui.settingsCommand('/workflow unknown-action'), true);
  assert.equal(await ui.settingsCommand('/workflow-example'), false);
  assert.equal(ui.tui.value, 'Keep this unsent draft'); assert.equal(ui.tui.cursor, 8);
  assert.equal(ui.tui.history.length, 0); assert.equal(listRecords('execution').length, 0); assert.equal(listRecords('run').length, 0);
});

test('workflow Back returns to chat if Core stops while a source library is open', async () => {
  ui.tui.setPanel('agents');
  assert.equal(await ui.settingsCommand('/workflow library'), true); assert.equal(ui.tui.panel, 'workflows');
  ui.coreLifecycleInterrupted = true;
  ui.tui.key('', { name: 'escape' }); assert.equal(ui.tui.panel, 'chat');
  assert.equal(ui.tui.value, 'Keep this unsent draft'); assert.equal(ui.tui.cursor, 8);
});

test('saved workflow row commands cannot act on another terminal even after its picker refreshes', async () => {
  const definition = saveWorkflow({ name: 'global-review', instructions: 'ORIGINAL_WORKFLOW_PREVIEW: use the supplied control.' }, { scope: 'global' });
  await ui.settingsCommand('/workflow library'); ui.tui.render();
  const oldPick = ui.tui.hitTargets.find(row => row.type === 'workflow-action' && row.action.startsWith('select:'));
  const oldView = ui.tui.hitTargets.find(row => row.type === 'workflow-action' && row.action.startsWith('view:'));
  assert.ok(oldPick); assert.ok(oldView);
  await ui.settingsCommand('/workflow ' + oldView.action); assert.equal(ui.workflowPreview.id, definition.id);
  const neighbor = createChatSession(getProvider('codex'), { cwd: directory, model: 'offline-model', effort: 'default' });
  ui.setSession(neighbor.id); ui.updateSession(neighbor);
  await ui.settingsCommand('/workflow library'); assert.equal(ui.workflowPreview, null);
  await ui.settingsCommand('/workflow ' + oldPick.action);
  assert.equal(workflowSelection(neighbor.id).selected, null);
  await ui.settingsCommand('/workflow ' + oldView.action); assert.equal(ui.workflowPreview, null);
  assert.equal(workflowSelection(session.id).selected, null); assert.equal(listRecords('execution').length, 0);
});
