import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { inflateSync, crc32 } from 'node:zlib';
import { UI } from '../src/ui.js';
import { clean, cellWidth } from '../src/terminal-format.js';
import { createTerminalTheme } from '../src/terminal-theme.js';
import { characterPNG, CanvasGraphics, supportsCanvasGraphics } from '../src/canvas-graphics.js';

function fixture() {
  const input = new PassThrough(); Object.assign(input, { isTTY: true, setRawMode() {} });
  const output = new PassThrough(); Object.assign(output, { isTTY: true, rows: 40, columns: 120 });
  let written = ''; output.on('data', data => { written += data; });
  const ui = new UI({ canvas: true, input, output, error: output }); ui.openTerminal();
  ui.tui.theme = createTerminalTheme(output, { FORCE_COLOR: '3' });
  ui.canvasView = { canvas: { nodes: [{ id: 'b', appearance: 2, selection: { model: 'fixture-model', effort: 'high' } }], groups: [] },
    alias: 'canvas-alias', focus: 'b', bindings: new Map([['b', { sessionId: 's', role: 'SOLO' }]]),
    snapshots: new Map([['s', { session: { model: 'fixture-model' } }]]), bubbles: new Map(), exchanges: new Map(), drawer: false };
  return { ui, tui: ui.tui, output, get written() { return written; } };
}
const next = () => new Promise(resolve => setImmediate(resolve));
const frame = tui => tui.lastFrame.map(clean).join('\n');

test('goal, name and private prompts are canvas dialogs; mouse cancel and confirm preserve the draft', async () => {
  const { ui, tui, output } = fixture();
  try {
    tui.value = 'An unsent chat draft'; tui.cursor = 5;
    const goal = ui.ask('Goal · what should this BZZY achieve?'); await next(); tui.render();
    assert.equal(tui.canvasOverlay.kind, 'prompt'); assert.match(frame(tui), /canvas-alias.*\n/s); assert.match(frame(tui), /Set goal/);
    assert.doesNotMatch(frame(tui), /Session:|Your next goal starts here|CHAT  ACTIVITY/);
    tui.value = 'A new objective'; tui.cursor = 4; tui.render();
    const confirm = tui.hitTargets.find(hit => hit.type === 'confirm'); tui.mouse(0, confirm.left, confirm.row);
    assert.equal(await goal, 'A new objective'); assert.equal(tui.value, 'An unsent chat draft'); assert.equal(tui.cursor, 5);
    const name = ui.ask('Chat name · Esc cancels'); await next(); tui.render();
    const close = tui.hitTargets.find(hit => hit.type === 'canvas-close'); tui.mouse(0, close.left, close.row);
    assert.equal(await name, null); assert.equal(tui.value, 'An unsent chat draft'); tui.render(); assert.equal(tui.canvasOverlay, null);
    const secret = ui.secret('API key'); await next(); tui.value = 'private-fixture-value'; tui.cursor = 21; tui.render();
    assert.match(frame(tui), /Private input/); assert.doesNotMatch(frame(tui), /private-fixture-value/); assert.equal(tui.textRegion, null);
    tui.key('', { name: 'escape' }); assert.equal(await secret, null);
    for (const [columns, rows] of [[80, 24], [48, 20], [24, 12]]) {
      Object.assign(output, { columns, rows }); const pending = ui.ask('Goal · enter an objective'); await next(); tui.render();
      assert.equal(tui.lastFrame.length, rows); assert.ok(tui.lastFrame.every(line => cellWidth(line) < columns));
      assert.ok(tui.composerRow <= rows && tui.composerRow > 0); tui.finish(null); await pending;
    }
  } finally { ui.close(); }
});

test('settings and Core controls stay in canvas windows; clicking all card rows opens their real action', async () => {
  const { ui, tui } = fixture(); let action;
  ui.settings = { page: 'main', pageTitle: 'Settings', pageSubtitle: 'Configure this host', focus: 0, close() {}, back() { return false; }, focusAction(value) { action = value; },
    rows: () => [['deepseek', 'DeepSeek API key'], ['folder', 'Default BZZY folder'], ['pair', 'Pair iPhone'], ['core', 'BZZY Core']].map(([action, text]) => ({ action, text, detail: 'This description also opens the setting.', card: true })) };
  try {
    const pending = ui.ask('bzzy › '); await next(); tui.setPanel('settings'); tui.render();
    assert.equal(tui.canvasOverlay.kind, 'settings'); assert.match(frame(tui), /canvas-alias/); assert.match(frame(tui), /BZZY Core/);
    const rows = tui.hitTargets.filter(hit => hit.type === 'settings' && hit.action === 'core'); assert.equal(rows.length, 3);
    const description = rows[1]; tui.mouse(0, description.left + 4, description.row);
    assert.equal(await pending, '/settings core'); assert.equal(action, 'core');
    ui.settings.page = 'core'; ui.settings.pageTitle = 'BZZY Core';
    ui.settings.rows = () => [{ text: 'Core online' }, { text: 'Start', action: 'start', control: true }, { text: 'Stop', action: 'stop', control: true }];
    tui.render(); assert.equal(tui.canvasOverlay.kind, 'settings'); assert.match(frame(tui), /Core online/); assert.doesNotMatch(frame(tui), /Session:|Your next goal/);
    const close = tui.hitTargets.find(hit => hit.type === 'canvas-close'); tui.mouse(0, close.left, close.row); tui.render();
    assert.equal(tui.panel, 'chat'); assert.equal(tui.canvasOverlay, null);
    ui.settingsOnly = true; const standalone = ui.ask('bzzy settings › '); await next(); tui.setPanel('settings'); tui.render();
    const exit = tui.hitTargets.find(hit => hit.type === 'canvas-close'); tui.mouse(0, exit.left, exit.row);
    assert.equal(await standalone, null, 'standalone and stopped-Core Settings can close instead of exposing an inactive canvas');
  } finally { ui.close(); }
});

test('conversation is a drawer with canonical content, bounded copy/scroll and close; Escape dismisses completion first', async () => {
  const { ui, tui, output } = fixture();
  try {
    ui.sessionId = 's'; ui.canvasView.drawer = true;
    ui.event('message.user', { text: 'My question' }); ui.event('text', { text: 'A recorded answer', itemId: 'reply' });
    const pending = ui.ask('bzzy › '); await next(); tui.render();
    assert.equal(tui.canvasOverlay.kind, 'conversation'); assert.match(frame(tui), /canvas-alias/); assert.match(frame(tui), /Conversation · fixture-model/); assert.match(frame(tui), /A recorded answer/);
    assert.doesNotMatch(frame(tui), /Session:|Your next goal starts here/);
    assert.ok(tui.canvasOverlay.left >= 34, 'wide terminals retain a visible character beside the drawer');
    assert.ok(tui.textRegion.left > tui.canvasOverlay.left); assert.ok(tui.textRegion.right < tui.canvasOverlay.right);
    assert.ok(tui.hitTargets.some(hit => hit.type === 'response')); assert.ok(tui.hitTargets.some(hit => hit.type === 'yolo'));
    Object.assign(ui.canvasView.snapshots.get('s').session, { mode: 'delegate', model: 'brain-model', selectedEffort: 'high', executor: { model: 'hands-model', effort: 'low' } }); tui.render();
    assert.match(frame(tui), /BRAIN brain-model · high/); assert.match(frame(tui), /HANDS hands-model · low/);
    ui.event('text', { text: '\n' + 'Recorded detail\n'.repeat(40), itemId: 'long-reply' }); tui.render();
    assert.ok(tui.scrollbar.maximum > 0);
    tui.mouse(0, tui.scrollbar.column, tui.scrollbar.thumbTop); assert.notEqual(tui.scrollDrag, null);
    tui.mouse(32, 1, 1); tui.mouse(0, 1, 1, true); assert.equal(tui.scrollDrag, null, 'releasing outside the drawer ends a scrollbar drag');
    tui.value = '/go'; tui.cursor = 3; tui.completionDismissed = false; tui.key('', { name: 'escape' });
    assert.ok(tui.resolveInput); assert.equal(tui.completionDismissed, true);
    tui.render(); const close = tui.hitTargets.find(hit => hit.type === 'canvas-close'); tui.mouse(0, close.left, close.row); assert.equal(await pending, '/canvas back');
    for (const [columns, rows] of [[80, 24], [48, 20]]) { Object.assign(output, { columns, rows }); tui.render(); assert.ok(tui.lastFrame.every(line => cellWidth(line) < columns)); }
  } finally { ui.close(); }
});

test('native image support is conservative; PNGs are high resolution and independently decodable', () => {
  const output = { isTTY: true };
  for (const env of [{ TERM_PROGRAM: 'ghostty' }, { TERM_PROGRAM: 'WarpTerminal' }, { TERM: 'xterm-kitty' }, { TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.6.9' }]) assert.equal(supportsCanvasGraphics(output, env), true);
  for (const env of [{ TERM_PROGRAM: 'Apple_Terminal' }, { TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.5.1' }, { TERM_PROGRAM: 'ghostty', TMUX: 'fixture' }, { TERM_PROGRAM: 'ghostty', NO_COLOR: '1' }]) assert.equal(supportsCanvasGraphics(output, env), false);
  const theme = createTerminalTheme(output, { FORCE_COLOR: '3' }), png = characterPNG(2, 'working', theme);
  assert.equal(png.readUInt32BE(16), 224); assert.equal(png.readUInt32BE(20), 192);
  const data = []; let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset), tag = png.toString('ascii', offset + 4, offset + 8), contents = png.subarray(offset + 8, offset + 8 + length);
    assert.equal(crc32(png.subarray(offset + 4, offset + 8 + length)), png.readUInt32BE(offset + 8 + length));
    if (tag === 'IDAT') data.push(contents); offset += 12 + length;
  }
  const pixels = inflateSync(Buffer.concat(data)); assert.equal(pixels.length, (224 * 3 + 1) * 192);
  assert.notDeepEqual(png, characterPNG(2, 'achieved', theme));
});

test('graphics use silent direct chunks, cache unchanged frames, and remove only their own placements before dialogs', () => {
  const output = { isTTY: true, columns: 120, rows: 40 }, graphics = new CanvasGraphics(output, { TERM_PROGRAM: 'ghostty' });
  const theme = createTerminalTheme(output, { FORCE_COLOR: '3' });
  const plans = [{ id: 'one', appearance: 0, state: 'idle', theme, seconds: 0, animate: false, left: 3, top: 8, columns: 28, rows: 12 },
    { id: 'two', appearance: 0, state: 'idle', theme, seconds: 0, animate: false, left: 70, top: 8, columns: 28, rows: 12 }];
  const first = graphics.prepare(plans); assert.match(first.after, /a=t,f=100,t=d/); assert.doesNotMatch(first.after, /a=q|t=f|t=s/);
  for (const packet of first.after.matchAll(/\x1b_G([^;]*);([^\x1b]*)\x1b\\/g)) { assert.match(packet[1], /q=2/); assert.ok(packet[2].length <= 4096); }
  assert.equal(graphics.cache.size, 1); assert.equal(graphics.placements.size, 2);
  assert.deepEqual(graphics.prepare(plans), { before: '', after: '' });
  const dialog = graphics.prepare(plans, [{ left: 65, right: 115, top: 6, bottom: 30 }]); assert.match(dialog.before, /a=d,d=i,i=\d+,p=\d+,q=2/);
  assert.equal(graphics.placements.size, 1); assert.ok(graphics.placements.has('one'));
  const fragments = graphics.prepare([plans[0]], [{ left: 10, right: 15, top: 10, bottom: 16 }]);
  assert.equal(graphics.placements.size, 4, 'a popup clips artwork instead of degrading or painting through it');
  assert.match(fragments.after, /a=p,[^;]*x=\d+,y=\d+,w=\d+,h=\d+/);
  const cleanup = graphics.clear(); assert.match(cleanup, /a=d,d=I,i=\d+,q=2/); assert.doesNotMatch(cleanup, /d=A|d=a/);
});

test('canvas compositor removes graphics before private pairing views and never caches private content', async () => {
  const f = fixture(), { ui, tui, output } = f;
  tui.canvasGraphics = new CanvasGraphics(output, { TERM_PROGRAM: 'WarpTerminal' });
  try {
    tui.render(); assert.ok(tui.canvasGraphics.placements.size);
    const offset = f.written.length;
    ui.privateView = { title: 'Private sharing', lines: ['private-fixture-code'], onCancel() {} }; tui.render();
    const privateFrame = f.written.slice(offset);
    assert.match(privateFrame, /a=d,d=I/); assert.ok(privateFrame.indexOf('a=d,d=I') < privateFrame.indexOf('Private sharing'));
    assert.equal(tui.lastFrame.length, 0); assert.equal(tui.paintedFrame, null); assert.equal(tui.textRegion, null); assert.equal(tui.canvasGraphics.placements.size, 0);
    ui.privateView = null;
    Object.assign(output, { columns: 80, rows: 24 });
    ui.settings = { qrView: true, warning: false, message: '', qrLines: () => Array(15).fill('\x1b[30;47m' + '▄'.repeat(30) + '\x1b[0m'), close() {} };
    tui.panel = 'settings'; const start = f.written.length; tui.render();
    const qrFrame = f.written.slice(start);
    assert.equal((qrFrame.match(/▄{30}/g) || []).length, 15, 'the complete QR survives compact canvas layout');
    assert.equal(tui.privateFrame, true); assert.equal(tui.lastFrame.length, 0); assert.doesNotMatch(qrFrame, /a=p,/);
    ui.settings.qrView = false; tui.panel = 'chat'; tui.render(); assert.equal(tui.privateFrame, false); assert.match(frame(tui), /canvas-alias/);
  } finally { ui.privateView = null; ui.close(); }
});
