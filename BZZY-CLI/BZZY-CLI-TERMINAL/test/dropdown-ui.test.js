import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { UI } from '../src/ui.js';
import { clean, cellWidth } from '../src/terminal-format.js';
import { createTerminalTheme } from '../src/terminal-theme.js';
import { chooseEffort } from '../src/model-controls.js';
import { sliceCells } from '../src/terminal-surface.js';

function terminal(t, columns = 120, rows = 36) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-dropdown-')), previous = process.env.BZZY_HOME;
  process.env.BZZY_HOME = directory;
  const input = new PassThrough(); input.isTTY = true; input.setRawMode = () => {};
  const output = new PassThrough(); Object.assign(output, { isTTY: true, columns, rows }); output.resume();
  const ui = new UI({ input, output, error: output });
  ui.setSession('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  ui.tui.theme = createTerminalTheme(output, { FORCE_COLOR: '3' });
  ui.updateSession({ id: ui.sessionId, alias: 'COOL Project', cwd: directory, provider: 'codex', model: 'Current model', selectedEffort: 'high', executionState: 'idle' });
  ui.event('message.user', { text: 'Keep this conversation open.' });
  ui.event('text', { text: 'The saved conversation remains under the dropdown.' });
  ui.tui.value = 'an unsent draft'; ui.tui.cursor = 15;
  let disposed = false;
  const dispose = () => { if (disposed) return; disposed = true; ui.close(); if (previous == null) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous; fs.rmSync(directory, { recursive: true, force: true }); };
  t.after(dispose);
  return { ui, input, output, tui: ui.tui, dispose };
}
const models = () => Array.from({ length: 45 }, (_, index) => ({ value: `model-${index}`, label: `${index % 2 ? 'Claude' : 'Codex'} · Model ${index}`, selected: index === 20 }));
const openModels = ui => ui.chooseOne('Choose model', { choices: models() }, { presentation: 'dropdown', kind: 'model', scope: 'chat' });

test('floating model dropdowns retain chat, fit compact/wide frames and dismiss without clicking through', async t => {
  for (const [columns, rows] of [[80, 24], [100, 28], [120, 36], [160, 44]]) {
    const { ui, tui, dispose } = terminal(t, columns, rows);
    tui.render(); const body = tui.entries.slice(), draft = tui.value, background = tui.lastFrame.slice();
    const result = openModels(ui); await Promise.resolve(); tui.render();
    const popup = tui.popupRegion;
    assert.ok(popup.left >= 1 && popup.right < columns && popup.top >= 1 && popup.bottom <= rows);
    assert.ok(tui.lastFrame.every(line => cellWidth(line) <= columns - 1));
    assert.deepEqual(tui.entries, body); assert.equal(tui.value, draft);
    assert.equal(tui.lastFrame[0], background[0], 'opening a dropdown preserves the existing frame above it');
    assert.equal(tui.hitTargets.some(hit => hit.type === 'panel'), false, 'the popup must own mouse input');
    tui.mouse(0, 1, 1); assert.equal(await result, null);
    assert.equal(tui.panel, 'chat'); assert.equal(tui.value, draft);
    dispose();
  }
});

test('model search, hover, mouse wheel and one-click selection never enter chat input', async t => {
  const { ui, tui, input } = terminal(t);
  const result = openModels(ui); await Promise.resolve(); tui.render();
  tui.mouse(65, tui.popupRegion.left + 2, tui.popupRegion.top + 4); assert.ok(tui.selection.focus > 20);
  input.write('Model 27'); tui.render();
  const choices = tui.hitTargets.filter(hit => hit.type === 'choice');
  assert.equal(choices.length, 1); assert.equal(choices[0].index, 27);
  const hit = choices[0], before = tui.lastFrame[hit.row - 1];
  input.write(`\x1b[<35;${hit.left + 2};${hit.row}M`); tui.render();
  assert.notEqual(tui.lastFrame[hit.row - 1], before, 'hover must visibly change the row');
  input.write(`\x1b[<0;${hit.left + 2};${hit.row}M`);
  assert.equal(await result, 'model-27'); assert.equal(tui.value, 'an unsent draft');
  assert.equal(tui.entries.filter(entry => entry.kind === 'user').length, 1);
});

test('effort dropdowns list only the selected model capabilities and support direct mouse selection', async t => {
  const { ui, tui } = terminal(t);
  const session = { provider: 'codex', model: 'reasoning', selectedEffort: 'medium', modelCapabilities: { supportsEffort: true, supportedEfforts: ['medium', 'high'] } };
  const selected = chooseEffort(session, ui); await new Promise(resolve => setImmediate(resolve)); tui.render();
  assert.equal(tui.selection.kind, 'effort');
  assert.deepEqual(tui.selection.choices.map(choice => choice.value), ['default', 'medium', 'high']);
  const high = tui.hitTargets.find(hit => hit.type === 'choice' && hit.index === 2); tui.mouse(0, high.left + 2, high.row);
  assert.equal((await selected).effort, 'high');
  const fixed = chooseEffort({ ...session, model: 'fixed', modelCapabilities: { supportsEffort: false } }, ui); await new Promise(resolve => setImmediate(resolve)); tui.render();
  assert.deepEqual(tui.selection.choices.map(choice => choice.value), ['default']);
  tui.key('', { name: 'escape' }); assert.equal(await fixed, null);
});

test('Experiential effort dropdown opens without credentials and mouse selection applies a manual level', async t => {
  const { ui, tui, input } = terminal(t);
  const selected = chooseEffort({ provider: 'experiential', model: 'unverified-model', selectedEffort: 'default',
    modelCapabilities: { supportsEffort: false, supportedEfforts: [] } }, ui);
  await new Promise(resolve => setImmediate(resolve)); tui.render();
  assert.deepEqual(tui.selection.choices.map(choice => choice.value), ['default', 'none', 'minimal', 'low', 'medium', 'high', 'max']);
  assert.match(tui.selection.description, /Requested effort/);
  const max = tui.hitTargets.find(hit => hit.type === 'choice' && hit.index === 6); assert.ok(max);
  input.write(`\x1b[<0;${max.left + 2};${max.row}M`);
  assert.equal((await selected).effort, 'max'); assert.equal(tui.value, 'an unsent draft');
  assert.equal(tui.entries.filter(entry => entry.kind === 'user').length, 1);
});

test('Send, top Settings and Back controls react to actual SGR clicks', async t => {
  const { ui, tui, input } = terminal(t);
  const click = hit => { assert.ok(hit); input.write(`\x1b[<0;${hit.left + 1};${hit.row}M`); };
  const answer = ui.ask('bzzy › '); await Promise.resolve(); tui.render();
  const send = tui.hitTargets.find(hit => hit.type === 'confirm'); click(send);
  assert.equal(await answer, 'an unsent draft'); tui.render();
  assert.ok(tui.pressedTarget, 'a clicked action retains a brief pressed state');
  const next = ui.ask('bzzy › '); await Promise.resolve(); tui.render();
  click(tui.hitTargets.find(hit => hit.type === 'top-settings'));
  assert.equal(await next, '/settings');
  ui.openSettings(); tui.render();
  click(tui.hitTargets.find(hit => hit.type === 'settings-back')); assert.equal(tui.panel, 'chat');
  const help = ui.ask('bzzy › '); await Promise.resolve(); tui.render();
  click(tui.hitTargets.find(hit => hit.type === 'model-control' && hit.command === '/help'));
  assert.equal(await help, '/help');
});

test('top navigation hides New Session without submitting or clearing the current draft', async t => {
  const { ui, tui } = terminal(t);
  const next = ui.ask('bzzy › '); await Promise.resolve();
  tui.value = 'draft survives'; tui.cursor = 14; tui.render();
  assert.equal(tui.hitTargets.some(hit => hit.type === 'session-new'), false);
  assert.doesNotMatch(clean(tui.lastFrame[0]), /\+ New/);
  ui.reader.close(); assert.equal(await next, null);
  assert.equal(tui.value, 'draft survives');
  assert.equal(tui.inputQueue.length, 0);
});

test('top Skills opens Core/project skills and Metrics is a local escapable view', async t => {
  const { ui, tui, input } = terminal(t), skills = ui.ask('bzzy › '); await Promise.resolve();
  tui.value = 'keep this draft'; tui.cursor = 5; tui.render();
  const skill = tui.hitTargets.find(hit => hit.type === 'top-skills'); assert.ok(skill);
  input.write(`\x1b[<0;${skill.left + 1};${skill.row}M`);
  assert.equal(await skills, '/skills'); assert.equal(tui.value, 'keep this draft');
  await ui.settingsCommand('/skills'); tui.render();
  assert.match(tui.lastFrame.map(clean).join('\n'), /SKILLS.*Import.*Export.*THIS CHAT \/ PROJECT.*BZZY CORE \/ GLOBAL/s);
  await ui.settingsCommand('/skills tab:import'); tui.render();
  assert.match(tui.lastFrame.map(clean).join('\n'), /CODEX SKILLS DIRECTORY[\s\S]*Save directory[\s\S]*Refresh/);
  tui.key('\x1b', { sequence: '\x1b', meta: true }); assert.equal(tui.panel, 'chat');

  const metrics = ui.ask('bzzy › '); await Promise.resolve(); tui.render();
  const metric = tui.hitTargets.find(hit => hit.type === 'top-metrics'); assert.ok(metric);
  input.write(`\x1b[<0;${metric.left + 1};${metric.row}M`);
  assert.equal(tui.panel, 'metrics'); assert.equal(tui.value, 'keep this draft');
  tui.render(); assert.doesNotMatch(tui.lastFrame.map(clean).join('\n'), /No metrics records yet/);
  assert.equal(tui.hitTargets.some(hit => hit.type === 'confirm'), false);
  tui.key('\x1b[27u', { sequence: '\x1b[27u' }); assert.equal(tui.panel, 'chat');
  ui.reader.close(); assert.equal(await metrics, null);
});

test('raw Escape fallback exits Skills when the terminal keypress parser omits it', async t => {
  const { ui, input, tui } = terminal(t);
  await ui.settingsCommand('/skills'); tui.render();
  assert.equal(tui.panel, 'skills');
  input.removeListener('keypress', tui.onKey);
  input.write('\x1b');
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(tui.panel, 'chat');
  await ui.settingsCommand('/skills'); assert.equal(tui.panel, 'skills');
  input.write('\x1b['); await new Promise(resolve => setTimeout(resolve, 10));
  input.write('27;1:1u'); await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(tui.panel, 'chat');
});

test('disabled model controls give feedback without dispatching a command', async t => {
  const { ui, tui } = terminal(t);
  const answer = ui.ask('bzzy › '); await Promise.resolve(); tui.modelSelectionRequired = true; tui.render();
  const effort = tui.hitTargets.find(hit => hit.command === '/effort' && hit.disabled);
  assert.ok(effort); tui.mouse(0, effort.left + 1, effort.row);
  assert.match(tui.actionNotice.message, /Select a model first/); assert.ok(tui.resolveInput);
  assert.equal(tui.hitTargets.some(hit => hit.command === '/default'), false, 'normal chat defaults live in full-screen Settings');
  tui.finish(null); assert.equal(await answer, null);
});

test('popup composition preserves styled Unicode and never splits a wide glyph', () => {
  const value = '\x1b[38;2;36;223;255m你🐝abc\x1b[0m';
  assert.equal(clean(sliceCells(value, 0, 4)), '你🐝');
  assert.equal(clean(sliceCells(value, 1, 5)), ' 🐝a');
  assert.match(sliceCells(value, 4, 7), /38;2;36;223;255m/);
});

test('inline rename has mouse Save/Cancel controls and does not consume the chat draft', async t => {
  const { ui, tui } = terminal(t);
  const answer = ui.ask('bzzy › '); await Promise.resolve(); tui.render();
  const alias = tui.hitTargets.find(hit => hit.type === 'alias');
  tui.mouse(0, alias.left + 1, alias.row); tui.mouse(0, alias.left + 1, alias.row);
  tui.aliasEdit.value = 'Renamed project'; tui.render();
  const save = tui.hitTargets.find(hit => hit.type === 'alias-save'); tui.mouse(0, save.left + 1, save.row);
  assert.equal(await answer, '/alias Renamed project'); assert.equal(tui.value, 'an unsent draft');
});

test('mouse cancellation keeps hidden input and private transfers outside durable chat and frame caches', async t => {
  const { ui, tui, input } = terminal(t);
  const secret = ui.secret('Private key input'); await Promise.resolve(); input.write('fixture-only-value'); tui.render();
  const cancel = tui.hitTargets.find(hit => hit.type === 'cancel'); input.write(`\x1b[<0;${cancel.left};${cancel.row}M`);
  assert.equal(await secret, null); assert.equal(tui.value, 'an unsent draft');
  let cancelled = false; ui.privateView = { title: 'Share', lines: ['temporary-private-fixture'], onCancel: () => { cancelled = true; } }; tui.render();
  const control = tui.hitTargets.find(hit => hit.type === 'private-cancel'); input.write(`\x1b[<0;${control.left};${control.row}M`);
  assert.equal(cancelled, true); assert.deepEqual(tui.lastFrame, []); assert.equal(tui.entries.some(entry => /fixture-only-value|temporary-private-fixture/.test(entry.text)), false);
});
