import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { UI } from '../src/ui.js';
import { settingsLayout, settingsActions, navigateSettings } from '../src/settings-layout.js';
import { createTerminalTheme } from '../src/terminal-theme.js';
import { clean, cellWidth } from '../src/terminal-format.js';

const role = (name, id) => ({ text: name, modelTable: { group: 'fixture', label: name, cells: ['provider', 'model', 'effort'].map((key, index) => ({
  text: ['A provider', 'A long Unicode model 🐝你', 'high'][index], key, action: `${id}:${key}`,
})) } });
const rows = [
  { text: 'Solo', modelGroup: { label: 'Solo', configured: true } }, role('Chat 🐝', 'solo'), role('Coordinator', 'core'),
  { text: 'Save', action: 'save', inline: 'controls' }, { text: 'Discard', action: 'discard', inline: 'controls' },
  { text: 'Delegate', modelGroup: { label: 'Delegate', dirty: true } }, role('Brain', 'brain'), role('Executor', 'executor'),
];
function terminal(t, columns = 80, height = 24) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-settings-render-')), previous = process.env.BZZY_HOME;
  process.env.BZZY_HOME = directory;
  const input = new PassThrough(); Object.assign(input, { isTTY: true, setRawMode() {} });
  const output = new PassThrough(); Object.assign(output, { isTTY: true, columns, rows: height }); output.resume();
  const ui = new UI({ input, output, error: output }); ui.setSession('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  ui.updateSession({ id: ui.sessionId, alias: 'Default models', cwd: directory, provider: 'codex', model: 'Active chat model', selectedEffort: 'high' });
  ui.tui.value = 'preserve the active draft'; ui.tui.cursor = 7;
  t.after(() => { ui.close(); if (previous == null) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous; fs.rmSync(directory, { recursive: true, force: true }); });
  return { ui, tui: ui.tui, input, output };
}
const click = (input, hit) => { assert.ok(hit); input.write(`\x1b[<0;${hit.left};${hit.row}M`); };

test('table has aligned independent Provider, Model and Effort columns at normal terminal widths', () => {
  for (const width of [77, 97, 137, 157]) {
    const settings = { focus: 1, rows: () => rows }, theme = createTerminalTheme({ isTTY: true }, { FORCE_COLOR: '3' });
    const layout = settingsLayout(settings, width, theme), header = layout.lines.map(clean).find(line => /Role.*Provider.*Model.*Effort/.test(line));
    assert.ok(header); assert.ok(layout.lines.every(line => cellWidth(line) <= width));
    for (const [field, title] of [['provider', 'Provider'], ['model', 'Model'], ['effort', 'Effort']]) {
      const hits = layout.hits.filter(hit => hit.action.endsWith(':' + field));
      assert.equal(hits.length, 4); assert.equal(new Set(hits.map(hit => hit.left)).size, 1);
      assert.equal(hits[0].left, header.indexOf(title) + 1);
    }
    const selected = layout.hits.find(hit => hit.action === 'solo:model');
    assert.equal(layout.focusRow, selected.row); assert.equal(layout.focusAction, 'solo:model');
  }
});

test('narrow layouts stack labeled cells without losing actions or Unicode bounds', () => {
  const settings = { focus: 2, rows: () => rows }, theme = createTerminalTheme({ isTTY: false }, {});
  for (const width of [30, 47, 65]) {
    const layout = settingsLayout(settings, width, theme), text = layout.lines.map(clean).join('\n');
    assert.match(text, /Provider ·/); assert.match(text, /Model ·/); assert.match(text, /Effort ·/);
    assert.ok(layout.lines.every(line => cellWidth(line) <= width));
    const first = layout.hits.filter(hit => hit.action.startsWith('solo:'));
    assert.equal(new Set(first.map(hit => hit.row)).size, 3); assert.equal(layout.focusRow, first[2].row);
  }
});

test('arrow navigation preserves the selected column across role rows and group controls', () => {
  const actions = settingsActions(rows), selected = focus => actions[focus].action;
  let state = navigateSettings(rows, 0, 'right'); assert.equal(selected(state.focus), 'solo:model');
  state = navigateSettings(rows, state.focus, 'down', state); assert.equal(selected(state.focus), 'core:model');
  state = navigateSettings(rows, state.focus, 'down', state); assert.equal(selected(state.focus), 'save');
  state = navigateSettings(rows, state.focus, 'down', state); assert.equal(selected(state.focus), 'brain:model');
  state = navigateSettings(rows, state.focus, 'right', state); assert.equal(selected(state.focus), 'brain:effort');
  state = navigateSettings(rows, state.focus, 'down', state); assert.equal(selected(state.focus), 'executor:effort');
  state = navigateSettings(rows, state.focus, 'up', state); assert.equal(selected(state.focus), 'brain:effort');
  state = navigateSettings(rows, state.focus, 'tab', { ...state, shift: true }); assert.equal(selected(state.focus), 'brain:model');
});

test('actual keys and clicks select the intended default cell without changing the active model', async t => {
  const { ui, tui, input, output } = terminal(t);
  await ui.settingsCommand('/settings default-models');
  const readActions = () => settingsActions(ui.settings.rows());
  const focus = () => readActions()[ui.settings.focus].action;
  tui.render(); assert.equal(focus(), 'defaults:provider:solo:0');
  input.write('\x1b[C'); assert.equal(focus(), 'defaults:model:solo:0');
  input.write('\x1b[C'); assert.equal(focus(), 'defaults:effort:solo:0');
  input.write('\x1b[B'); assert.match(focus(), /^defaults:(save|reload):solo$/);
  input.write('\x1b[B'); assert.equal(focus(), 'defaults:effort:core:0'); tui.render();
  const answer = ui.ask('bzzy › '); await Promise.resolve();
  const hit = tui.hitTargets.find(hit => hit.type === 'settings' && hit.action === 'defaults:model:core:0'); click(input, hit);
  assert.equal(await answer, '/settings defaults:model:core:0');
  assert.equal(tui.model, 'Active chat model'); assert.equal(tui.inputQueue.length, 0);
  for (const columns of [40, 80, 120]) {
    output.columns = columns; tui.render(); assert.ok(tui.lastFrame.every(line => cellWidth(line) <= columns - 1));
    assert.ok(tui.hitTargets.some(hit => hit.type === 'back' && hit.row <= tui.sceneHeaderLength), 'Back stays above the scrolling table');
  }
  output.columns = 80; tui.render(); const frame = tui.lastFrame.map(clean).join('\n');
  assert.match(frame, /Active chat model/); assert.match(frame, /tokens.*00:00:00/); assert.match(frame, /CPU/);
});

test('main Settings keeps all four rows visible at 80 by 24', t => {
  const { ui, tui } = terminal(t); ui.openSettings(); tui.render();
  for (const action of ['deepseek', 'workspace-root', 'pair', 'core'])
    assert.ok(tui.hitTargets.some(hit => hit.type === 'settings' && hit.action === action && hit.row <= 24), action);
  assert.match(tui.lastFrame.map(clean).join('\n'), /DeepSeek API key/);
});
