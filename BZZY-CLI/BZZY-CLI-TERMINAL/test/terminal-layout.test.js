import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { UI } from '../src/ui.js';
import { clean, cellWidth } from '../src/terminal-format.js';

function terminal() {
  const input = new PassThrough(); Object.assign(input, { isTTY: true, setRawMode() {} });
  const output = new PassThrough(); Object.assign(output, { isTTY: true, rows: 40, columns: 120 });
  let written = ''; output.on('data', chunk => { written += chunk; });
  const ui = new UI({ input, output, error: output });
  ui.setSession('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  Object.assign(ui.tui, { provider: 'codex', model: 'terminal-fixture', alias: 'Original terminal', cwd: '/synthetic/project' });
  return { ui, output, get written() { return written; } };
}

test('terminal chat retains branding, menus, history and composer across compact and wide sizes without native character images', () => {
  const screen = terminal(), { ui, output } = screen;
  try {
    ui.event('message.user', { text: 'Original user request' }); ui.event('text', { text: 'Preserved assistant answer.' });
    for (const [columns, rows] of [[150, 42], [100, 32], [72, 24]]) {
      Object.assign(output, { columns, rows }); ui.tui.value = 'Keep this unsent draft'; ui.tui.cursor = 9; ui.tui.render();
      const frame = ui.tui.lastFrame.map(clean).join('\n');
      assert.match(frame, /bzzy/); assert.match(frame, /terminal-fixture/);
      assert.match(frame, /Original user request/); assert.match(frame, /Preserved assistant answer/); assert.match(frame, /Keep this unsent draft/);
      for (const type of ['top-sessions', 'top-skills', 'top-agents', 'top-settings', 'model-control', 'confirm']) {
        assert.ok(ui.tui.hitTargets.some(hit => hit.type === type), `${type} remains accessible at ${columns} columns`);
      }
      assert.ok(ui.tui.lastFrame.every(line => cellWidth(line) < columns));
      assert.doesNotMatch(frame, /Right-click \/ F10|Esc returns to the canvas|Connect models/);
    }
    ui.tui.setPanel('activity'); ui.tui.render();
    assert.ok(ui.tui.eyeRegion, 'The existing terminal brand eyes remain visible on the activity header');
    assert.match(ui.tui.lastFrame.map(clean).join('\n'), /bzzy/);
    assert.doesNotMatch(screen.written, /\x1b_G/, 'The terminal uses text and brand eyes without native image transport');
  } finally { ui.close(); }
});

test('terminal prompts restore the active chat draft and normal response context menus remain available', async () => {
  const { ui } = terminal();
  try {
    ui.tui.value = 'Unsent original draft'; ui.tui.cursor = 7;
    const pending = ui.ask('Name this skill'); await Promise.resolve(); await Promise.resolve();
    ui.tui.value = 'Abandoned prompt'; ui.tui.cursor = 3; ui.tui.key('', { name: 'escape' });
    assert.equal(await pending, null); assert.equal(ui.tui.value, 'Unsent original draft'); assert.equal(ui.tui.cursor, 7);
    ui.event('text', { text: 'A complete original reply for copying.' }); ui.tui.render();
    const response = ui.tui.hitTargets.find(hit => hit.type === 'response'); assert.ok(response);
    ui.tui.mouse(2, response.left, response.row); assert.equal(ui.tui.selection.scope, 'response-menu');
    ui.tui.key('', { name: 'escape' }); assert.equal(ui.tui.selection, null);
    assert.equal(ui.tui.value, 'Unsent original draft');
  } finally { ui.close(); }
});
