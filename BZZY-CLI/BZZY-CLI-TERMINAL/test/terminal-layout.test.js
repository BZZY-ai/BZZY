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
    for (const panel of ['activity', 'http', 'room']) {
      ui.tui.setPanel(panel); ui.tui.render();
      const frame = ui.tui.lastFrame.map(clean).join('\n');
      assert.doesNotMatch(frame, /[\u2800-\u28ff]|CHAT ACTIVITY HTTP SESSIONS|Effort:.*Save|bzzy\s+\/\s+/u);
      assert.ok(ui.tui.hitTargets.some(hit => hit.type === 'top-skills'), 'Every normal panel keeps the current terminal bar');
    }
    assert.doesNotMatch(screen.written, /\x1b_G/, 'The terminal uses text and brand eyes without native image transport');
  } finally { ui.close(); }
});

test('private Import and generated-code screens keep a compact header at every size without caching private values', async () => {
  const screen = terminal(), { ui, output } = screen;
  const code = 'BZZY-LIBRARY-' + 'x'.repeat(43), fingerprint = 'y'.repeat(43);
  try {
    ui.updateSession({ id: ui.sessionId, provider: 'deepseek', model: 'transfer-model', selectedEffort: 'high', executionState: 'idle', usage: { tokens: 1234, available: true } });
    ui.connectionStatus = { core: true, relay: true };
    ui.hostMetrics = { host: { cpuPercent: 12, memory: { usedBytes: 4 * 1024 ** 3, totalBytes: 16 * 1024 ** 3 } } };
    let written = ''; ui.tui.writeFrame = frame => { written = frame; };
    for (const minimal of [false, true]) for (const [columns, rows] of [[50, 20], [80, 24], [150, 42]]) {
      ui.minimal = minimal; Object.assign(output, { columns, rows });
      for (const title of ['Import skills', 'Export skills', 'Import agents', 'Export agents']) {
        ui.tui.value = 'Keep the draft'; ui.tui.cursor = 5;
        ui.privateView = { title, lines: ['Sender fingerprint: ' + fingerprint, code], qr: [] };
        const answer = ui.ask(title + ' · Esc goes back'); await Promise.resolve();
        ui.tui.render(); const frame = clean(written);
        assert.match(frame, /bzzy/); assert.match(frame, /Core ON.*Relay ON/);
        assert.match(frame, /transfer-model/); assert.ok(frame.includes(title)); assert.ok(frame.includes(code.slice(0, 25)));
        assert.doesNotMatch(frame, /[\u2800-\u28ff]|CHAT ACTIVITY HTTP SESSIONS|Effort:.*Save|bzzy\s+\/\s+/u);
        if (columns >= 80) { assert.match(frame, /1,234 tokens/); assert.match(frame, /CPU 12%/); }
        assert.equal(ui.tui.lastFrame.length, 0); assert.equal(ui.tui.textRegion, null);
        assert.ok(!JSON.stringify(ui.tui.entries).includes(code)); assert.ok(!JSON.stringify(ui.tui.history).includes(code));
        const back = ui.tui.hitTargets.find(hit => hit.type === 'private-cancel'); assert.ok(back);
        ui.tui.mouse(0, back.left, back.row); assert.equal(await answer, null);
        assert.equal(ui.tui.value, 'Keep the draft'); assert.equal(ui.tui.cursor, 5);
        ui.privateView = null; ui.tui.render(); assert.ok(!clean(written).includes(code));
      }
    }
  } finally { ui.reader?.close(); ui.privateView = null; ui.close(); }
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
