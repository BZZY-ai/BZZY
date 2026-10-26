import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { UI } from '../src/ui.js';
import { clean, cellWidth } from '../src/terminal-format.js';
import { chatHelp, commandSuggestions, privateChatCommand } from '../src/terminal-commands.js';
import { openWorkflows, workflowRows, workflowAction } from '../src/workflow-ui.js';
import { skillsCommand, skillRows } from '../src/skills-ui.js';
import { subagentsCommand, subagentRows } from '../src/subagents-ui.js';
import { createChatSession } from '@bzzy/core/engine/host-commands.js';
import { getProvider } from '@bzzy/core/engine/providers.js';
import { saveWorkflow } from '@bzzy/core/engine/workflows.js';
import { listRecords } from '@bzzy/core/engine/database.js';

let directory, previous, ui, input, output, session;
const body = 'Use only supplied controls and preserve unresolved uncertainty.\n' + 'Retain original scope and source attribution.\n'.repeat(80) + 'FINAL_WORKFLOW_LINE';
const actions = () => workflowRows(ui).filter(row => row.action).map(row => row.action);
test.beforeEach(() => {
  previous = process.env.BZZY_HOME; directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-workflow-navigation-')));
  process.env.BZZY_HOME = path.join(directory, 'private');
  input = new PassThrough(); Object.assign(input, { isTTY: true, setRawMode() {} });
  output = new PassThrough(); Object.assign(output, { isTTY: true, columns: 100, rows: 30 }); output.resume();
  ui = new UI({ input, output, error: output });
  session = createChatSession(getProvider('codex'), { cwd: directory, model: 'fixture-model', effort: 'default' });
  ui.setSession(session.id); ui.updateSession(session);
  ui.hostMetrics = { host: { cpuPercent: 12, memory: { usedBytes: 4 * 1024 ** 3, totalBytes: 16 * 1024 ** 3 } } };
  ui.tui.value = 'Retain the unsent chat draft'; ui.tui.cursor = 7;
});
test.afterEach(() => {
  ui.close(); if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
  fs.rmSync(directory, { recursive: true, force: true });
});
const frame = () => ui.tui.lastFrame.map(clean).join('\n');
function clickBack() {
  ui.tui.render(); const hit = ui.tui.hitTargets.find(item => item.type === 'back'); assert.ok(hit);
  ui.tui.mouse(0, hit.left, hit.row);
}
function assertDraft() { assert.equal(ui.tui.value, 'Retain the unsent chat draft'); assert.equal(ui.tui.cursor, 7); }

test('the singular workflow command is discoverable and all workflow administration stays out of chat command history', { timeout: 5000 }, async () => {
  const suggestions = commandSuggestions('/workfl');
  for (const name of ['/workflow']) {
    assert.ok(suggestions.some(row => row.command === name));
    assert.equal(privateChatCommand(name), true); assert.equal(privateChatCommand(name + ' load private-location.txt'), true);
  }
  assert.equal(commandSuggestions('/workflows').length, 0);
  assert.equal(privateChatCommand('/workflows'), false);
  assert.equal(privateChatCommand('/workflow-example'), false); assert.match(chatHelp, /future goals/);
  const answer = ui.ask('bzzy › '); await Promise.resolve(); ui.tui.finish('/workflow load private-location.txt');
  assert.equal(ui.tui.history.length, 0); return answer;
});

test('workflow rows keep terminal branding, model, host metrics and safe geometry without a Send control', () => {
  saveWorkflow({ name: 'response-process', description: 'Review supplied responses.', instructions: body }, { cwd: directory });
  for (const columns of [40, 80, 140]) {
    output.columns = columns; ui.tui.setPanel('chat'); ui.tui.render();
    const originalHeader = clean(ui.tui.lastFrame[0]);
    openWorkflows(ui); ui.tui.render();
    assert.equal(clean(ui.tui.lastFrame[0]), originalHeader, 'Opening Workflows preserves the current terminal header.');
    assert.ok(ui.tui.lastFrame.every(line => cellWidth(clean(line)) <= columns - 1));
    assert.match(frame(), /fixture/);
    if (columns >= 80) { assert.match(frame(), /Sessions/); assert.match(frame(), /fixture-model/); assert.match(frame(), /CPU\s*12%/); }
    assert.ok(ui.tui.hitTargets.some(hit => hit.type === 'workflow-action'));
    assert.ok(!ui.tui.hitTargets.some(hit => hit.type === 'confirm'));
    assert.equal(ui.tui.canCompose(), false); assertDraft();
  }
  ui.minimal = true; ui.tui.render(); assert.ok(!ui.tui.hitTargets.some(hit => hit.type === 'confirm')); assertDraft();
  assert.equal(listRecords('execution').length, 0); assert.equal(listRecords('assignment').length, 0);
});

test('the selected workflow name stays visible and clickable in ordinary chat, including minimal layout, and None clears it', async () => {
  saveWorkflow({ name: 'response-process', instructions: body }, { cwd: directory }); openWorkflows(ui);
  await workflowAction(actions().find(action => action.startsWith('select:')), ui);
  ui.tui.setPanel('chat');
  const dispatched = []; ui.tui.localCommand = command => dispatched.push(command);
  for (const minimal of [false, true]) {
    ui.minimal = minimal; ui.tui.render(); assert.match(frame(), /Workflow: response-process/);
    const hit = ui.tui.hitTargets.find(item => item.type === 'workflow-open'); assert.ok(hit);
    ui.tui.mouse(0, hit.left, hit.row); assert.equal(dispatched.shift(), '/workflow'); assertDraft();
  }
  openWorkflows(ui); await workflowAction(actions().find(action => action.startsWith('none:')), ui);
  ui.tui.setPanel('chat'); ui.tui.render(); assert.doesNotMatch(frame(), /Workflow: response-process/); assertDraft();
  assert.equal(listRecords('execution').length, 0);
});

test('mouse and keyboard activate only workflow actions while arrows retain the chat draft', () => {
  saveWorkflow({ name: 'response-process', instructions: body }, { cwd: directory }); openWorkflows(ui);
  const dispatched = []; ui.tui.localCommand = command => dispatched.push(command);
  const rows = actions(), start = ui.tui.workflowFocus || 0;
  ui.tui.key('', { name: 'down' }); assert.equal(ui.tui.workflowFocus, (start + 1) % rows.length);
  ui.tui.key('', { name: 'return' }); assert.equal(dispatched.shift(), '/workflow ' + rows[ui.tui.workflowFocus]);
  ui.tui.render(); const hit = ui.tui.hitTargets.find(item => item.type === 'workflow-action' && item.action.startsWith('view:'));
  assert.ok(hit); ui.tui.mouse(0, hit.left, hit.row); assert.equal(dispatched.shift(), '/workflow ' + hit.action);
  ui.tui.key('x', { name: 'x' }); assertDraft(); assert.equal(ui.tui.inputQueue.length, 0);
});

test('Skills and Agents open the workflow library and Back returns to the originating library before chat', async () => {
  for (const [name, command, rows] of [['skills', skillsCommand, skillRows], ['agents', subagentsCommand, subagentRows]]) {
    await command('/' + name, ui);
    assert.ok(!rows(ui).some(row => row.action === 'workflows'));
    await command('/' + name + ' workflows', ui); assert.equal(ui.tui.panel, 'workflows');
    clickBack(); await Promise.resolve(); assert.equal(ui.tui.panel, name); assertDraft();
    ui.tui.setPanel('chat');
  }
  openWorkflows(ui, { origin: 'chat' }); input.write('\x1b[27u'); await Promise.resolve();
  assert.equal(ui.tui.panel, 'chat'); assertDraft(); assert.equal(ui.tui.inputQueue.length, 0);
});

test('opening Workflows from skill import restores the directory draft before restoring the unsent chat', async () => {
  await skillsCommand('/skills tab:import', ui);
  ui.tui.value = '/private/tmp/synthetic skills directory'; ui.tui.cursor = 12;
  await skillsCommand('/skills workflows', ui); assert.equal(ui.tui.panel, 'workflows'); assertDraft();
  clickBack(); await Promise.resolve(); assert.equal(ui.tui.panel, 'skills');
  assert.equal(ui.tui.value, '/private/tmp/synthetic skills directory');
  ui.tui.setPanel('chat'); assertDraft(); assert.equal(ui.tui.inputQueue.length, 0);
});

test('workflow detail Back and Escape preserve the full saved text and cancel nested input before leaving the library', async () => {
  const workflow = saveWorkflow({ name: 'response-process', instructions: body }, { cwd: directory }); openWorkflows(ui, { origin: 'agents' });
  const action = actions().find(item => item.startsWith('view:'));
  await workflowAction(action, ui); assert.equal(ui.workflowPreview.version, workflow.version);
  assert.ok(workflowRows(ui).some(row => row.text === workflow.instructions));
  ui.tui.render(); ui.tui.key('', { name: 'end' }); ui.tui.render(); assert.match(frame(), /FINAL_WORKFLOW_LINE|reusable behavior|Use for future goals|Back to/);
  clickBack(); await Promise.resolve(); assert.equal(ui.tui.panel, 'workflows'); assert.equal(ui.workflowPreview, null);
  await workflowAction(action, ui); input.write('\x1b[27u'); await Promise.resolve();
  assert.equal(ui.tui.panel, 'workflows'); assert.equal(ui.workflowPreview, null);
  const answer = ui.ask('Workflow name'); await Promise.resolve(); input.write('discard-this-name');
  input.write('\x1b[27u'); assert.equal(await answer, null); assert.equal(ui.tui.panel, 'workflows'); assertDraft();
  input.write('\x1b[27u'); await Promise.resolve(); assert.equal(ui.tui.panel, 'agents'); assertDraft();
  assert.equal(ui.tui.inputQueue.length, 0); assert.equal(listRecords('execution').length, 0);
});
