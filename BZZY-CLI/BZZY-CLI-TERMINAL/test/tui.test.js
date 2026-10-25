import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UI } from '../src/ui.js';
import { clean, cellWidth, wrap } from '../src/terminal-format.js';
import { eyeMotion } from '../src/mascot.js';
import { RunnerUI } from '../src/runtime-ui.js';
import { events } from '../src/database.js';
import { commandSuggestions } from '../src/terminal-commands.js';
import { palette, palettes, createTerminalTheme } from '../src/terminal-theme.js';

const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
test('CLI and iOS share assistant message boundaries for native, legacy and interleaved streams', () => {
  const fixtures = JSON.parse(fs.readFileSync(new URL('../../../BZZY-CORE/test/fixtures/chat-message-boundaries.json', import.meta.url), 'utf8'));
  for (const fixture of fixtures) {
    const { ui } = terminal();
    try {
      for (const event of fixture.events) ui.event(event.type, event.data);
      assert.deepEqual(ui.tui.entries.filter(entry => ['assistant', 'user'].includes(entry.kind)).map(entry => entry.text), fixture.messages, fixture.name);
    } finally { ui.close(); }
  }
});
test('connection indicators remain independent of busy model work and preserve the chat draft', () => {
  const { ui, output } = terminal();
  try {
    Object.assign(output, { columns: 150, rows: 40 });
    ui.tui.value = 'Keep typing'; ui.tui.cursor = 4; ui.tui.busy = true; ui.tui.state = 'responding';
    ui.connectionStatus = { core: true, relay: false }; ui.tui.render();
    const connected = ui.tui.lastFrame.map(clean).join('\n');
    assert.match(connected, /● BZZY Relay.*CPU/); assert.match(connected, /Core ON.*Relay OFF/);
    assert.ok(ui.tui.lastFrame[0].includes(ui.tui.theme.foreground(palette.danger)));
    ui.connectionStatus = { core: true, relay: true }; ui.tui.render();
    assert.ok(ui.tui.lastFrame[0].includes(ui.tui.theme.foreground(palette.goalSuccess)));
    ui.connectionStatus = null; ui.tui.render();
    assert.match(ui.tui.lastFrame.map(clean).join('\n'), /Core OFF.*Relay OFF/);
    assert.equal(ui.tui.value, 'Keep typing'); assert.equal(ui.tui.cursor, 4);
    assert.equal(ui.tui.entries.length, 0, 'connection checks never become conversation events');
  } finally { ui.close(); }
});
test('DeepSeek balance appears in the top bar only for the DeepSeek API-key provider and opens usage details', async () => {
  const { ui, output } = terminal();
  try {
    Object.assign(output, { columns: 120, rows: 30 });
    ui.tui.provider = 'deepseek';
    ui.accountStatus = { deepseek: { provider: 'deepseek', status: 'available',
      balance: { currency: 'USD', amount: 12.34 }, checkedAt: Date.now(), source: 'provider-api' } };
    ui.tui.render();
    assert.match(ui.tui.lastFrame[0], /\$12\.34/);
    const balance = ui.tui.hitTargets.find(hit => hit.type === 'usage-balance'); assert.ok(balance);
    ui.tui.mouse(0, balance.left, balance.row); await ui.tui.balanceTask;
    assert.match(ui.tui.entries.at(-1).text, /DeepSeek balance: \$12\.34/);

    ui.tui.provider = 'codex'; ui.tui.render();
    assert.doesNotMatch(ui.tui.lastFrame[0], /\$12\.34/);
    assert.equal(ui.tui.hitTargets.some(hit => hit.type === 'usage-balance'), false);
  } finally { ui.close(); }
});
function terminal(options = {}) {
  const input = new PassThrough(); input.isTTY = true; input.isRaw = false; input.setRawMode = value => { input.isRaw = value; };
  const output = new PassThrough(); Object.assign(output, { isTTY: true, rows: 32, columns: 100 });
  let written = ''; output.on('data', chunk => { written += chunk; });
  const ui = new UI({ ...options, input, output, error: output }); ui.setSession(sessionId);
  return { ui, input, output, get written() { return written; } };
}
test('minimal chat uses the full terminal and retains conversation, input, mouse Send and approval controls across sizes', async () => {
  const { ui, output } = terminal({ minimal: true });
  try {
    ui.event('message.user', { text: 'A minimal question' });
    ui.event('text', { text: 'A visible answer', agent: 'Codex' });
    for (const [columns, rows] of [[160, 42], [100, 32], [72, 20]]) {
      Object.assign(output, { columns, rows }); ui.tui.value = 'Unsent draft'; ui.tui.cursor = 12; ui.tui.render();
      const frame = ui.tui.lastFrame.map(clean).join('\n');
      assert.match(frame, /A minimal question/); assert.match(frame, /A visible answer/); assert.match(frame, /Unsent draft/);
      assert.doesNotMatch(frame, /BZZY|Session:|YOLO|Latest|Settings|Your next goal|CPU|Memory/);
      assert.equal(ui.tui.dashboardActive, false); assert.equal(ui.tui.textRegion.top, 2);
      assert.match(frame, /Core Offline.*Relay Offline/);
      const send = ui.tui.hitTargets.find(hit => hit.type === 'confirm'); assert.ok(send); assert.equal(send.row, rows - 1);
      assert.ok(ui.tui.lastFrame.every(line => cellWidth(line) < columns));
    }
    ui.onAnswerApproval = async () => {};
    ui.tui.pendingApproval = { id: 'pending', expiresAt: Date.now() + 60000 };
    ui.tui.render();
    assert.deepEqual(ui.tui.hitTargets.filter(hit => hit.type === 'approval').map(hit => hit.answer), ['yes', 'no']);
  } finally { ui.close(); }
});
test('color commands repaint roles and cached content locally without losing drafts or changing another terminal', async () => {
  const first = terminal({ minimal: true }), second = terminal();
  try {
    first.ui.tui.value = 'Keep this draft'; first.ui.tui.cursor = 7;
    first.ui.event('message.user', { text: 'User question' }); first.ui.event('text', { text: 'Agent answer' });
    for (const name of ['black', 'white', 'blue']) {
      assert.equal(await first.ui.settingsCommand('/color ' + name), true);
      assert.equal(first.ui.tui.theme.name, name); assert.equal(first.ui.colorPalette, name);
      assert.equal(first.ui.tui.value, 'Keep this draft'); assert.equal(first.ui.tui.cursor, 7);
      assert.equal(second.ui.tui.theme.name, 'blue');
      const frame = first.ui.tui.lastFrame.map(clean).join('\n');
      assert.match(frame, /User question/); assert.match(frame, /Agent answer/); assert.match(frame, /Keep this draft/);
      assert.doesNotMatch(frame, /BZZY|Settings|Session:/);
      const theme = createTerminalTheme(first.output, { FORCE_COLOR: '3' }, name);
      const background = palettes[name].background.slice(1).match(/../g).map(value => parseInt(value, 16)).join(';');
      assert.equal(theme.background(palette.background), '\x1b[48;2;' + background + 'm');
      assert.notEqual(theme.foreground(palette.user), theme.foreground(palette.agent));
      assert.notEqual(theme.background(palette.userSurface), theme.background(palette.agentSurface));
      for (const level of ['0', '1', '2', '3']) {
        const fallback = createTerminalTheme(first.output, { FORCE_COLOR: level }, name);
        if (level === '0') assert.equal(fallback.color('plain'), 'plain');
        else assert.notEqual(fallback.foreground(palette.text), fallback.foreground(palette.background));
      }
    }
    await first.ui.settingsCommand('/color orange'); assert.equal(first.ui.colorPalette, 'blue');
    assert.equal(await first.ui.settingsCommand('This is a message'), false);
    assert.ok(commandSuggestions('/col').some(item => item.command === '/color'));
  } finally { first.ui.close(); second.ui.close(); }
});
test('every palette keeps body text, semantic labels and filled action buttons readable', () => {
  const luminance = color => {
    const channels = color.slice(1).match(/../g).map(value => parseInt(value, 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
  };
  const contrast = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
  for (const [name, colors] of Object.entries(palettes)) for (const [foreground, background] of [
    ['text', 'background'], ['muted', 'surface'], ['userText', 'userSurface'], ['agent', 'agentSurface'],
    ['accent', 'selection'], ['background', 'accent'], ['background', 'goalSuccess'], ['background', 'danger'], ['background', 'yolo'],
  ]) assert.ok(contrast(colors[foreground], colors[background]) >= 4.5, `${name}: ${foreground} on ${background}`);
});
test('user and agent turns retain labeled, distinct rails in RGB, basic-color and monochrome terminals', () => {
  const { ui, output } = terminal();
  try {
    for (const level of ['3', '1', '0']) {
      ui.tui.theme = createTerminalTheme(output, { FORCE_COLOR: level }); ui.tui.entryLayouts = new WeakMap();
      const user = ui.tui.entryLayout({ kind: 'user', text: 'Review the café 🐝 and 漢字 layout.', goal: true }, 66).lines;
      const agent = ui.tui.entryLayout({ kind: 'assistant', label: 'Codex', text: 'I checked the layout.\nThe saved history stays intact.' }, 66).lines;
      assert.match(user.map(clean).join('\n'), /YOU · GOAL/); assert.match(agent.map(clean).join('\n'), /AGENT · Codex/);
      assert.match(clean(user[1]), /▎ Review the café/); assert.match(clean(agent[1]), /▎ I checked the layout/);
      assert.doesNotMatch(agent.map(clean).join('\n'), /\[Copy\]/);
      assert.ok([...user, ...agent].every(line => cellWidth(line) <= 66));
      assert.ok(user.map(clean).some(line => line.includes('▎')));
      if (level === '0') assert.doesNotMatch([...user, ...agent].join(''), /\x1b/);
      else {
        assert.ok(user.join('').includes(ui.tui.theme.foreground(palette.user)));
        assert.ok(agent.join('').includes(ui.tui.theme.foreground(palette.agent)));
        assert.notEqual(ui.tui.theme.foreground(palette.user), ui.tui.theme.foreground(palette.agent));
      }
    }
  } finally { ui.close(); }
});
test('prose wraps at word boundaries and cached Unicode streaming matches a fresh layout', () => {
  const { ui } = terminal();
  try {
    const entry = { kind: 'assistant', text: '' };
    const text = 'Review the café 🐝 and 漢字 layout with longer prose.\nAReallyLongTokenWithoutSpaces1234567890 and the next sentence.';
    for (const character of text) {
      entry.text += character;
      assert.deepEqual(ui.tui.entryLayout(entry, 35).lines, ui.tui.entryLayout({ ...entry }, 35).lines);
    }
    const rows = ui.tui.entryLayout({ kind: 'user', text: 'Keep all these words readable when the terminal is compact.' }, 50).lines.map(clean);
    assert.ok(rows.some(line => line.includes('these words')));
  } finally { ui.close(); }
});
test('right-click on a reply body offers Copy response while left-click selection, draft and cancel stay local', async () => {
  const { ui } = terminal(), copied = [];
  ui.clipboard = { async copyText(text) { copied.push(text); return { copied: true, method: 'native' }; } };
  try {
    const answer = ui.ask('bzzy › '); await Promise.resolve(); ui.tui.value = 'My draft'; ui.tui.cursor = 8;
    ui.event('text', { text: 'Complete response body.', itemId: 'copy-context' }); ui.tui.render();
    ui.tui.setPanel('activity'); ui.tui.render(); ui.tui.setPanel('chat'); ui.tui.render();
    assert.doesNotMatch(ui.tui.lastFrame.map(clean).join('\n'), /\[Copy\]|\[c\]/);
    let body = ui.tui.hitTargets.filter(hit => hit.type === 'response').at(-1);
    ui.tui.mouse(0, body.left + 3, body.row); assert.equal(copied.length, 0); assert.ok(ui.tui.textSelection);
    ui.tui.mouse(0, body.left + 3, body.row, true);
    ui.tui.mouse(2, body.left + 3, body.row); ui.tui.render(); assert.equal(ui.tui.selection.scope, 'response-menu');
    assert.equal(copied.length, 0); ui.tui.key('', { name: 'escape' }); assert.equal(ui.tui.value, 'My draft');
    ui.tui.render(); body = ui.tui.hitTargets.filter(hit => hit.type === 'response').at(-1);
    ui.tui.mouse(32, body.left + 3, body.row); ui.tui.key('', { name: 'f10' }); assert.equal(ui.tui.selection.scope, 'response-menu');
    ui.event('text', { text: ' Latest streaming addition.', itemId: 'copy-context' });
    ui.tui.key('', { name: 'return' }); await ui.tui.clipboardTask;
    assert.deepEqual(copied, ['Complete response body. Latest streaming addition.']);
    assert.equal(ui.tui.value, 'My draft'); assert.equal(ui.tui.inputQueue.length, 0); assert.equal(ui.tui.entries.length, 1);
    ui.reader.close(); await answer;
  } finally { ui.close(); }
});
test('a disabled Continue row stays visible and cannot confirm an incomplete parallel selection', async () => {
  const { ui } = terminal();
  try {
    const answer = ui.chooseOne('Parallel · Select agents', { choices: [
      { value: 'agent:0', label: 'Agent 1 · Choose provider and model' },
      { value: 'continue', label: 'Continue · select at least 2 agents', disabled: true, selected: true, description: 'Select at least two agents.' },
    ] });
    await Promise.resolve(); ui.tui.render();
    assert.match(ui.tui.lastFrame.map(clean).join('\n'), /Continue.*select at least 2 agents/);
    ui.tui.key('', { name: 'return' });
    assert.equal(ui.tui.selection.error, 'Select at least two agents.');
    ui.tui.key('', { name: 'up' }); ui.tui.key('', { name: 'return' });
    assert.equal(await answer, 'agent:0');
  } finally { ui.close(); }
});

test('full-screen chat retains streaming replies and keeps the latest user turn fixed above long output', async () => {
  const term = terminal(), { ui } = term;
  try {
    ui.updateSession({ id: sessionId, provider: 'codex', model: 'chosen-model', cwd: '/project', executionState: 'running', usage: { tokens: 1234, available: true } });
    ui.updateSession({ id: sessionId, provider: 'codex', model: 'chosen-model', cwd: '/project', executionState: 'running', usage: { tokens: 1000, available: true }, summary: { usage: { totalTokens: 900 } } });
    assert.equal(ui.tui.tokens, 1234, 'an older polling snapshot must not erase newer streaming usage');
    const answer = ui.ask('bzzy › '); await Promise.resolve();
    ui.event('message.user', { text: 'Validate this ownership finding' });
    for (let index = 0; index < 70; index++) ui.event('text', { text: `Evidence line ${index}.\n`, itemId: 'reply' });
    ui.tui.render();
    assert.equal(ui.tui.pinned, 'Validate this ownership finding');
    assert.match(ui.tui.entries.find(entry => entry.kind === 'assistant').text, /Evidence line 69/);
    const frame = ui.tui.lastFrame.map(clean).join('\n');
    assert.match(frame, /YOU\s+│ Validate this ownership finding/);
    assert.match(frame, /Evidence line 69/); assert.match(frame, /1,234 tokens/); assert.match(frame, /\d{2}:\d{2}:\d{2}/);
    assert.ok(term.written.includes('\x1b[1;')); assert.ok(term.written.includes('\x1b[?1049h'));
    ui.tui.key('n', { name: 'n' }); ui.event('text', { text: 'Still visible.', itemId: 'reply' }); ui.tui.render();
    assert.equal(ui.tui.value, 'n'); assert.match(ui.tui.entries.at(-1).text, /Still visible/);
    Object.assign(term.output, { columns: 80, rows: 24 }); ui.tui.render();
    const smaller = ui.tui.lastFrame.map(clean).join('\n');
    assert.match(smaller, /Validate this ownership finding/); assert.match(smaller, /Still visible/);
    assert.match(smaller, /YOU\s+│ Validate this ownership finding/); assert.match(smaller, /1,234 tokens/);
    ui.tui.key('\r', { name: 'return' }); assert.equal(await answer, 'n');
  } finally { ui.close(); }
  assert.equal(term.input.isRaw, false); assert.ok(term.written.includes('\x1b[?1049l'));
});
test('participant checklist is selectable with space and arrows and can be cancelled', async () => {
  const { ui } = terminal();
  try {
    const choice = ui.chooseMany('Choose debate agents', [{ value: 'codex', label: 'Codex' }, { value: 'claude', label: 'Claude', selected: true }, { value: 'deepseek', label: 'DeepSeek' }]);
    ui.tui.key(' ', { name: 'space' }); ui.tui.key('', { name: 'down' }); ui.tui.key(' ', { name: 'space' }); ui.tui.key('', { name: 'down' }); ui.tui.key(' ', { name: 'space' });
    ui.tui.key('\r', { name: 'return' }); assert.deepEqual(await choice, ['codex', 'deepseek']);
    const cancelled = ui.chooseMany('Choose', [{ value: 'a', label: 'A' }]); ui.tui.key('', { name: 'escape' }); assert.equal(await cancelled, null);
  } finally { ui.close(); }
});

test('the editor accepts typing and submission between prompts without losing or mixing tab input', async () => {
  const { ui } = terminal();
  try {
    ui.tui.key('first draft', {}); ui.tui.key('', { name: 'return' });
    ui.tui.key('next draft', {});
    assert.equal(await ui.ask('bzzy (running) › '), 'first draft');
    assert.equal(ui.tui.value, 'next draft');
    const next = ui.ask('bzzy › '); await Promise.resolve();
    ui.tui.key('', { name: 'return' }); assert.equal(await next, 'next draft');
    ui.setTabs(sessionId, [{ id: 'agent-a', agent: 'A' }, { id: 'agent-b', agent: 'B' }], 'agent-a');
    ui.tui.key('for agent A', {}); ui.tui.key('', { name: 'return' });
    ui.setTabs(sessionId, [{ id: 'agent-a', agent: 'A' }, { id: 'agent-b', agent: 'B' }], 'agent-b');
    const other = ui.ask('bzzy (B) › '); await Promise.resolve();
    ui.tui.key('for agent B', {}); ui.tui.key('', { name: 'return' });
    assert.equal(await other, 'for agent B');
    ui.setTabs(sessionId, [{ id: 'agent-a', agent: 'A' }, { id: 'agent-b', agent: 'B' }], 'agent-a');
    assert.equal(await ui.ask('bzzy (A) › '), 'for agent A');
  } finally { ui.close(); }
});

test('streaming reuses completed message layouts and updates only the response tail', () => {
  const { ui } = terminal();
  try {
    const completed = ui.tui.add('assistant', 'Previous result '.repeat(1000), { label: 'bzzy' });
    const stable = ui.tui.entryLayout(completed, 90);
    ui.event('text', { itemId: 'live', text: '## Progress\n' + 'Testing 👩‍💻 é 漢字 '.repeat(20) });
    const streaming = ui.tui.entries.at(-1);
    for (const delta of ['more', '\n**bold', ' text**', '\n', 'e', '\u0301', ' 👩', '\u200d💻']) {
      ui.tui.entryLayout(streaming, 90);
      ui.event('text', { itemId: 'live', text: delta });
      const incremental = ui.tui.entryLayout(streaming, 90);
      const fresh = ui.tui.entryLayout({ ...streaming }, 90);
      assert.deepEqual(incremental.lines, fresh.lines);
      assert.strictEqual(ui.tui.entryLayout(completed, 90), stable, 'old replies are never reformatted for a new token');
    }
    assert.notStrictEqual(ui.tui.entryLayout(completed, 45), stable, 'resizing recalculates line wraps');
  } finally { ui.close(); }
});
test('weekly quotas stay in the header and Activity shows readable progress without raw tool commands', async () => {
  const { ui, output } = terminal();
  try {
    ui.updateSession({ id: sessionId, provider: 'codex', model: 'fixture-brain', selectedEffort: 'high', executionState: 'idle' });
    ui.accountStatusEnabled = true;
    ui.accountStatus = {
      codex: { status: 'available', weekly: { remainingPercent: 75 }, checkedAt: Date.now() },
      claude: { status: 'available', weekly: { remainingPercent: 65 }, checkedAt: Date.now() },
      deepseek: { status: 'available', balance: { currency: 'USD', amount: 12.34 }, checkedAt: Date.now() },
    };
    ui.event('message.user', { text: 'Visit paypal.com and extract the footer' });
    ui.event('tool', { name: 'shell', detail: 'curl -sSL https://paypal.com/' });
    ui.event('activity', { id: 'footer', summary: 'Checking the footer on paypal.com', details: 'I’m opening paypal.com to locate its footer and extract its text.' });
    ui.tui.setPanel('activity');
    for (const [columns, rows] of [[100, 32], [80, 24]]) {
      Object.assign(output, { columns, rows }); ui.tui.render();
      const frame = ui.tui.lastFrame.map(clean).join('\n');
      assert.match(frame, /Codex 7d: 75% left.*Claude 7d: 65% left.*DeepSeek: \$12.34/);
      assert.match(frame, /Checking the footer/); assert.match(frame, /opening paypal.com/);
      assert.doesNotMatch(frame, /curl -sSL/); assert.match(frame, /╭─ Message/); assert.match(frame, new RegExp(sessionId));
      assert.equal(ui.tui.activities.length, 1);
    }
  } finally { ui.close(); }
});
test('the chat keeps top actions and runtime context while Settings replaces the transcript and composer', async () => {
  const term = terminal(), { ui, output } = term;
  try {
    ui.updateSession({ id: sessionId, provider: 'codex', model: 'chosen-model', selectedEffort: 'high', cwd: '/project',
      executionState: 'idle', usage: { tokens: 1234, available: true } });
    ui.hostMetricsEnabled = true;
    ui.hostMetricsMonitor = { close() {} };
    ui.hostMetrics = { host: { cpuPercent: 12, memory: { totalBytes: 16 * 1024 ** 3, usedBytes: 4 * 1024 ** 3 } }, core: { rssBytes: 80 * 1024 ** 2 } };
    ui.settings = { page: 'main', pageTitle: 'Settings', pageSubtitle: 'Your workspace, connections and defaults', focus: 0, message: '', close() {}, rows: () => [
      { text: 'DeepSeek API key', action: 'deepseek' },
      { text: 'Default BZZY folder', action: 'workspace-root' },
      { text: 'Pair iPhone', action: 'pair' },
      { text: 'BZZY Core', action: 'core' },
    ] };
    for (const [columns, rows] of [[100, 32], [80, 24]]) {
      Object.assign(output, { columns, rows });
      ui.tui.setPanel('chat'); ui.tui.value = 'Keep this draft'; ui.tui.cursor = 5;
      ui.event('message.user', { text: 'Question in the transcript' });
      ui.event('text', { text: 'Answer in the transcript', itemId: 'settings-layout' });
      ui.tui.render();
      const chat = ui.tui.lastFrame.map(clean);
      assert.doesNotMatch(chat[0], /bzzy|◉◉/);
      assert.match(chat[0], /(?:Open Sessions|Sessions).*(?:\+ New Session|\+ New).*CPU\s*12%.*4\.0\/16(?: GB|G).*Skills.*Metrics.*⚙ Settings/);
      assert.match(chat.join('\n'), /chosen-model.*effort high/);
      assert.match(chat.join('\n'), /1,234 tokens.*\d{2}:\d{2}:\d{2}/);
      assert.ok(ui.tui.hitTargets.some(hit => hit.type === 'top-sessions'));
      assert.ok(ui.tui.hitTargets.some(hit => hit.type === 'session-new'));
      assert.ok(ui.tui.hitTargets.some(hit => hit.type === 'top-skills'));
      assert.ok(ui.tui.hitTargets.some(hit => hit.type === 'top-metrics'));
      assert.ok(ui.tui.hitTargets.some(hit => hit.type === 'top-settings'));
      const send = ui.tui.hitTargets.find(hit => hit.type === 'confirm');
      const model = ui.tui.hitTargets.find(hit => hit.command === '/providers');
      const yolo = ui.tui.hitTargets.find(hit => hit.type === 'yolo');
      assert.equal(model.row - send.row, 2, 'the model row has breathing room below input');
      assert.equal(yolo.row - model.row, 2, 'goal status has breathing room below model usage');

      ui.tui.setPanel('settings'); ui.tui.render();
      const settings = ui.tui.lastFrame.map(clean);
      assert.doesNotMatch(settings[0], /bzzy|◉◉/);
      assert.match(settings[0], /Settings.*CPU.*12.*RAM.*4\.0\/16 GB.*Esc · Chat/);
      assert.match(settings.join('\n'), /API key.*Default BZZY folder.*Pair iPhone.*BZZY Core/s);
      assert.doesNotMatch(settings.join('\n'), /Question in the transcript|Answer in the transcript|Ask BZZY to do anything/);
      assert.equal(ui.tui.lastFrame.length, rows);
      assert.ok(ui.tui.hitTargets.some(hit => hit.type === 'settings'));

      ui.tui.setPanel('chat'); ui.tui.render();
      assert.equal(ui.tui.value, 'Keep this draft');
    }
  } finally { ui.close(); }
});
test('agent tabs preserve drafts and retain separate activity and HTTP panels', async () => {
  const { ui } = terminal();
  try {
    ui.setTabs(sessionId, [{ id: 'child-codex', agent: 'codex-1' }, { id: 'child-claude', agent: 'claude-2' }], 'child-codex');
    const answer = ui.ask('bzzy › '); await Promise.resolve(); ui.tui.key('draft', {});
    ui.setTabs(sessionId, [{ id: 'child-codex', agent: 'codex-1' }, { id: 'child-claude', agent: 'claude-2' }], 'child-claude'); assert.equal(ui.tui.value, '');
    ui.setTabs(sessionId, [{ id: 'child-codex', agent: 'codex-1' }], 'child-codex'); assert.equal(ui.tui.value, 'draft');
    ui.event('activity', { id: 'activity', summary: 'Testing approved controls', details: 'Comparing independent evidence.' });
    ui.tui.key('', { name: 'g', ctrl: true }); ui.tui.render(); assert.match(ui.tui.lastFrame.map(clean).join('\n'), /Testing approved controls/);
    ui.event('network.response', { method: 'GET', url: 'https://scope.example/profile', status: 200 });
    ui.tui.key('', { name: 'g', ctrl: true }); ui.tui.render(); assert.match(ui.tui.lastFrame.map(clean).join('\n'), /scope.example/);
    ui.reader.close(); await answer;
  } finally { ui.close(); }
});
test('overview peer replies keep native identity and copy complete interleaved responses without joining distinct turns', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-peer-stream-')), previous = process.env.BZZY_HOME;
  process.env.BZZY_HOME = directory;
  const { ui } = terminal(), copied = [];
  ui.clipboard = { async copyText(text) { copied.push(text); return { copied: true, method: 'native' }; } };
  try {
    const first = new RunnerUI('peer-session-a', { parentSessionId: sessionId, agent: 'codex-1', peer: true });
    const second = new RunnerUI('peer-session-b', { parentSessionId: sessionId, agent: 'codex-2', peer: true });
    first.event('backend', { method: 'turn/started', params: { turn: { id: 'native-turn-a' } } });
    second.event('backend', { method: 'turn/started', params: { turn: { id: 'native-turn-a' } } });
    first.event('text', { text: '**First peer** ', itemId: 'native-answer' });
    second.event('text', { text: '**Second peer** ', itemId: 'native-answer' });
    first.event('text', { text: 'complete answer.', itemId: 'native-answer' });
    second.event('text', { text: 'independent answer.', itemId: 'native-answer' });
    first.newline(); first.event('backend', { method: 'turn/started', params: { turn: { id: 'native-turn-b' } } });
    first.event('text', { text: 'A distinct later reply.', itemId: 'native-answer' });
    const forwarded = events(sessionId).filter(event => event.type === 'peer.text');
    assert.equal(forwarded.length, 5);
    assert.equal(forwarded[0].data.childSessionId, 'peer-session-a');
    assert.equal(forwarded[0].data.itemId, 'native-answer'); assert.equal(forwarded[0].data.turnId, 'native-turn-a');
    for (const event of forwarded) ui.event(event.type, event.data);
    const answers = ui.tui.entries.filter(entry => entry.kind === 'assistant');
    assert.equal(answers.length, 3);
    assert.deepEqual(answers.map(entry => entry.text), ['**First peer** complete answer.', '**Second peer** independent answer.', 'A distinct later reply.']);
    ui.tui.render(); ui.tui.scroll = ui.tui.scrollbar.maximum; ui.tui.render();
    const reply = ui.tui.hitTargets.find(hit => hit.type === 'response' && hit.entry.peerSessionId === 'peer-session-a'); assert.ok(reply);
    ui.tui.mouse(2, reply.left, reply.row); ui.tui.render();
    const copy = ui.tui.hitTargets.find(hit => hit.type === 'choice' && hit.index === 0);
    ui.tui.mouse(0, copy.left, copy.row); await ui.tui.clipboardTask;
    assert.deepEqual(copied, ['**First peer** complete answer.']);
    assert.equal(ui.tui.entries.length, 3, 'copying does not create a chat message');
  } finally {
    ui.close(); if (previous == null) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
test('peer backends without native IDs get stable chunks and distinct tool/turn boundaries', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-peer-fallback-')), previous = process.env.BZZY_HOME;
  process.env.BZZY_HOME = directory;
  const { ui } = terminal();
  try {
    const peer = new RunnerUI('claude-peer', { parentSessionId: sessionId, agent: 'claude-1', peer: true });
    peer.event('text', { text: 'Inspecting ' }); peer.event('text', { text: 'the supplied files.' });
    peer.event('tool', { name: 'Read' });
    peer.event('text', { text: 'Recorded ' }); peer.event('text', { text: 'the evidence.' });
    peer.newline(); peer.event('text', { text: 'A separate follow-up.' });
    const forwarded = events(sessionId).filter(event => event.type === 'peer.text');
    assert.equal(forwarded[0].data.itemId, forwarded[1].data.itemId);
    assert.notEqual(forwarded[1].data.itemId, forwarded[2].data.itemId);
    assert.equal(forwarded[2].data.turnId, forwarded[3].data.turnId);
    assert.notEqual(forwarded[3].data.turnId, forwarded[4].data.turnId);
    for (const event of forwarded) ui.event(event.type, event.data);
    assert.deepEqual(ui.tui.entries.map(entry => entry.text), ['Inspecting the supplied files.', 'Recorded the evidence.', 'A separate follow-up.']);
  } finally {
    ui.close(); if (previous == null) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
test('besties has a shared room for deduplicated messages and evidence reviews while retaining both peer chats', async () => {
  const { ui, output } = terminal(), copied = [];
  const first = { id: 'bestie-one', agent: 'codex-bestie-1-12345678' }, second = { id: 'bestie-two', agent: 'codex-bestie-2-12345678' };
  ui.clipboard = { async copyText(text) { copied.push(text); return { copied: true, method: 'native' }; } };
  try {
    ui.setTabs(sessionId, [first, second]);
    ui.updateSession({ id: sessionId, mode: 'besties', provider: 'codex', model: 'strong-model', executionState: 'running' });
    ui.event('peer.message', { id: 'message-one', seq: 10, groupId: sessionId, from: first.id, to: second.id, text: 'The local parser accepts this candidate. Please inspect my recorded evidence.', evidence: ['evidence-1111'], createdAt: '2026-10-21T10:00:00.000Z' });
    ui.event('peer.sent', { id: 'message-one', seq: 11, groupId: sessionId, from: first.id, to: second.id, text: 'The local parser accepts this candidate. Please inspect my recorded evidence.', evidence: ['evidence-1111'], createdAt: '2026-10-21T10:00:00.000Z' });
    ui.event('peer.review', { id: 'review-one', seq: 12, groupId: sessionId, reviewer: second.id, peerSessionId: first.id, messageId: 'message-one', assessment: 'disputed', rationale: 'The independent control is still missing. This does not establish the claimed boundary failure.', evidence: ['evidence-1111'], createdAt: '2026-10-21T10:01:00.000Z' });
    assert.equal(ui.tui.sharedRoom.length, 2, 'sent and received copies of a message are one room entry');
    const input = ui.ask('bzzy › '); await Promise.resolve(); ui.tui.value = 'preserved draft'; ui.tui.cursor = 15;
    ui.tui.render(); ui.tui.setPanel('room'); assert.equal(ui.tui.panel, 'room'); assert.equal(ui.tui.value, 'preserved draft');
    for (const [columns, rows] of [[100, 32], [80, 24]]) {
      Object.assign(output, { columns, rows }); ui.tui.render();
      const frame = ui.tui.lastFrame.map(clean).join('\n');
      assert.match(frame, /Overview.*codex · 1.*codex · 2/);
      assert.match(frame, /independent control is still missing/); assert.match(frame, /peer judgment/);
      assert.doesNotMatch(frame, /Brain|Hands|Ctrl\+G switch/); assert.match(frame, /\[0 Overview\].*codex · 1.*codex · 2/);
    }
    Object.assign(output, { columns: 100, rows: 32 }); ui.tui.render(); ui.tui.scroll = ui.tui.scrollbar.maximum; ui.tui.render();
    assert.match(ui.tui.lastFrame.map(clean).join('\n'), /codex · 1 → codex · 2/);
    const reply = ui.tui.hitTargets.find(hit => hit.type === 'response'); assert.ok(reply);
    ui.tui.mouse(2, reply.left + 1, reply.row); ui.tui.render();
    const copy = ui.tui.hitTargets.find(hit => hit.type === 'choice' && hit.index === 0);
    ui.tui.mouse(0, copy.left, copy.row); await ui.tui.clipboardTask;
    assert.deepEqual(copied, ['The local parser accepts this candidate. Please inspect my recorded evidence.']);
    ui.tui.setPanel('chat'); ui.tui.key('', { name: 'g', ctrl: true }); assert.equal(ui.tui.panel, 'room');
    ui.tui.setPanel('chat'); ui.tui.value = '/room'; ui.tui.cursor = 5; ui.tui.key('\r', { name: 'return' });
    assert.equal(ui.tui.panel, 'room'); assert.ok(ui.tui.resolveInput, '/room changes the view without sending a model prompt');
    ui.reader.close(); await input;
    ui.updateSession({ id: first.id, mode: 'solo', bestiesSessionId: sessionId, peers: [{ sessionId: first.id, namespace: first.agent }, { sessionId: second.id, namespace: second.agent }], provider: 'codex', executionState: 'idle' });
    assert.ok(ui.tui.panels().includes('room'), 'an attached child conversation retains its group room');
    assert.equal(ui.tui.peerLabel(second.id), 'codex · 2');
  } finally { ui.close(); }
});
test('besties and parallel live usage reuse the fixed counter with honest partial and unknown totals', () => {
  const { ui } = terminal();
  try {
    for (const mode of ['besties', 'parallel']) {
      ui.updateSession({ id: sessionId, mode, provider: 'codex', executionState: 'running' });
      ui.event(mode + '.usage', { totalTokens: 40, complete: false, agents: [{ tokens: 40, available: true }, { tokens: null, available: false }] }); ui.tui.render();
      assert.match(ui.tui.lastFrame.map(clean).join('\n'), /≥40 tokens/);
      ui.event(mode + '.usage', { totalTokens: 90, complete: true, agents: [{ tokens: 40, available: true }, { tokens: 50, available: true }] }); ui.tui.render();
      assert.match(ui.tui.lastFrame.map(clean).join('\n'), /90 tokens/); assert.doesNotMatch(ui.tui.lastFrame.map(clean).join('\n'), /≥90/);
      ui.event(mode + '.usage', { totalTokens: 0, complete: false, agents: [{ tokens: null, available: false }, { tokens: null, available: false }] }); ui.tui.render();
      assert.match(ui.tui.lastFrame.map(clean).join('\n'), /tokens —/); assert.doesNotMatch(ui.tui.lastFrame.map(clean).join('\n'), /0 tokens/);
      ui.updateSession({ id: sessionId, mode, provider: 'codex', executionState: 'running', usage: { tokens: 0, available: true } }); ui.tui.render();
      assert.match(ui.tui.lastFrame.map(clean).join('\n'), /tokens —/, 'a generic snapshot must not turn unavailable peer usage into reported zero');
      ui.updateSession({ id: sessionId, mode, provider: 'codex', executionState: 'idle', summary: { usage: { totalTokens: 130, complete: true, agents: [{ tokens: 80, available: true }, { tokens: 50, available: true }] } } }); ui.tui.render();
      assert.match(ui.tui.lastFrame.map(clean).join('\n'), /130 tokens/);
    }
  } finally { ui.close(); }
});
test('a model picker loads asynchronously, scrolls to the focused model and cancels without losing drafts', async () => {
  const { ui, output } = terminal();
  try {
    Object.assign(output, { columns: 80, rows: 24 });
    ui.tui.value = 'unsent draft'; ui.tui.cursor = 12;
    let load;
    const options = new Promise(resolve => { load = resolve; });
    const chosen = ui.chooseOne('Choose model · codex', options);
    ui.tui.render(); assert.match(ui.tui.lastFrame.map(clean).join('\n'), /Loading available models/);
    load({ choices: Array.from({ length: 30 }, (_, index) => ({ value: `model-${index}`, label: `Model ${index}`, selected: index === 20 })) });
    await Promise.resolve(); ui.tui.render();
    assert.match(ui.tui.lastFrame.map(clean).join('\n'), /Choose model/);
    assert.match(ui.tui.lastFrame.map(clean).join('\n'), /Model 20/);
    assert.match(ui.tui.lastFrame[0], /(?:Open Sessions|Sessions).*(?:\+ New Session|\+ New)/);
    ui.tui.key('', { name: 'down' }); ui.tui.key('\r', { name: 'return' });
    assert.equal(await chosen, 'model-21'); assert.equal(ui.tui.value, 'unsent draft');
    const cancelled = ui.chooseOne('Choose provider', new Promise(() => {}));
    ui.tui.key('', { name: 'escape' }); assert.equal(await cancelled, null);
    assert.equal(ui.tui.value, 'unsent draft');
  } finally { ui.close(); }
});
test('slash suggestions filter, complete without switching agent tabs, and keep local view commands out of agent input', async () => {
  const { ui, input, output } = terminal();
  try {
    const answer = ui.ask('bzzy › '); await Promise.resolve();
    let tabSwitches = 0;
    input.on('keypress', (_text, key) => { if (key.name === 'tab' && !key.bzzyHandled) tabSwitches++; });
    input.write('/mo'); ui.tui.render();
    const frame = ui.tui.lastFrame.map(clean).join('\n');
    assert.ok(frame.includes('/models'));
    for (const command of ['/debate', '/models', '/effort', '/providers', '/default', '/doctor']) assert.ok(commandSuggestions('/').some(item => item.command === command));
    assert.doesNotMatch(frame, /F[123]/);
    ui.tui.key('', { name: 'u', ctrl: true }); input.write('/mod\t');
    assert.equal(ui.tui.value, '/models '); assert.equal(tabSwitches, 0);
    ui.tui.key('', { name: 'u', ctrl: true }); input.write('/http\r');
    assert.equal(ui.tui.panel, 'http'); assert.ok(ui.tui.resolveInput, 'a local panel command leaves the chat prompt open');
    input.write('/do'); ui.tui.key('', { name: 'escape' }); assert.equal(ui.tui.completions().length, 0);
    input.write('c'); assert.equal(ui.tui.completions()[0].command, '/doctor');
    Object.assign(output, { columns: 80, rows: 24 }); ui.event('message.user', { text: 'Keep this question pinned' }); ui.tui.render();
    const smaller = ui.tui.lastFrame.map(clean).join('\n'); assert.match(smaller, /YOU ASKED[\s\S]*Keep this question pinned/);
    ui.tui.key('', { name: 'u', ctrl: true }); input.write('/goal status\r'); assert.equal(await answer, '/goal status');
  } finally { ui.close(); }
});
test('Left and Right adjust only the focused model effort and confirmation returns both settings', async () => {
  const { ui } = terminal();
  try {
    const options = { selectEffort: true, choices: [
      { value: 'brain', label: 'Brain', efforts: ['medium', 'high', 'xhigh'], effort: 'high', selected: true },
      { value: 'light', label: 'Light', efforts: ['low'] }, { value: 'fixed', label: 'Fixed', supportsEffort: false },
    ] };
    const chosen = ui.chooseOne('Choose model · codex', options); await Promise.resolve();
    ui.tui.key('', { name: 'right' }); assert.equal(ui.tui.selection.efforts.get('brain'), 'xhigh');
    ui.tui.key('', { name: 'down' }); ui.tui.key('', { name: 'right' }); assert.equal(ui.tui.selection.efforts.get('light'), 'low');
    ui.tui.key('', { name: 'down' }); ui.tui.key('', { name: 'right' }); assert.equal(ui.tui.selection.efforts.get('fixed'), 'default');
    ui.tui.key('', { name: 'up' }); ui.tui.key('', { name: 'up' }); ui.tui.render();
    assert.match(ui.tui.lastFrame.map(clean).join('\n'), /‹ xhigh ›/);
    ui.tui.key('\r', { name: 'return' }); assert.deepEqual(await chosen, { value: 'brain', effort: 'xhigh' });
    const cancelled = ui.chooseOne('Choose model', options); await Promise.resolve(); ui.tui.key('', { name: 'left' }); ui.tui.key('', { name: 'escape' });
    assert.equal(await cancelled, null); assert.equal(options.choices[0].effort, 'high', 'cancelling does not mutate saved choices');
  } finally { ui.close(); }
});
test('keyboard views, mouse scroll and scrollbar drag never become message text', async () => {
  const term = terminal(), { ui, input } = term;
  const mouse = (button, x, y, released = false) => input.write(`\x1b[<${button};${x};${y}${released ? 'm' : 'M'}`);
  try {
    const answer = ui.ask('bzzy › '); await Promise.resolve(); input.write('unsent draft');
    for (let index = 0; index < 50; index++) ui.event('network.response', { method: 'GET', url: `https://approved.example/request-${index}`, status: 200 });
    ui.tui.render(); ui.tui.key('', { name: 'g', ctrl: true }); ui.tui.key('', { name: 'g', ctrl: true });
    ui.tui.render(); assert.equal(ui.tui.panel, 'http'); assert.equal(ui.tui.value, 'unsent draft');
    const bar = ui.tui.scrollbar; assert.ok(bar.maximum > 0);
    mouse(64, 30, bar.top + 2); ui.tui.render(); assert.ok(ui.tui.scroll > 0);
    const thumb = ui.tui.scrollbar; mouse(0, thumb.column, thumb.thumbTop); mouse(32, thumb.column, thumb.top); mouse(0, thumb.column, thumb.top, true);
    ui.tui.render(); assert.equal(ui.tui.scroll, bar.maximum); assert.match(ui.tui.lastFrame.map(clean).join('\n'), /request-0/);
    assert.equal(ui.tui.scrollDrag, null); assert.equal(ui.tui.value, 'unsent draft');
    ui.setTabs(sessionId, [{ id: 'codex-child', agent: 'codex-1' }]); let selected;
    ui.onSelectTab = id => { selected = id; }; ui.tui.render();
    const tab = ui.tui.hitTargets.find(hit => hit.type === 'tab' && hit.id === 'codex-child'); mouse(0, tab.left + 1, tab.row); assert.equal(selected, 'codex-child');
    ui.reader.close(); await answer;
    const chosen = ui.chooseOne('Choose provider', [{ value: 'codex', label: 'Codex' }, { value: 'claude', label: 'Claude' }]); await Promise.resolve(); ui.tui.render();
    const row = ui.tui.hitTargets.find(hit => hit.type === 'choice' && hit.index === 1); mouse(0, row.left + 1, row.row); ui.tui.render();
    const confirm = ui.tui.hitTargets.find(hit => hit.type === 'confirm'); mouse(0, confirm.left + 1, confirm.row); assert.equal(await chosen, 'claude');
    const secret = ui.secret('Provider API key (hidden): '); await Promise.resolve(); input.write('123:fixture');
    // SGR packets may arrive split across reads; their coordinates must stay out of secrets.
    input.write('\x1b[<64;'); input.write('30;10M'); ui.tui.render();
    assert.equal(ui.tui.value, '123:fixture'); assert.doesNotMatch(ui.tui.lastFrame.map(clean).join('\n'), /123:fixture/);
    input.write('\r'); assert.equal(await secret, '123:fixture'); assert.ok(!ui.tui.history.includes('123:fixture'));
    const cancelledSecret = ui.secret('Provider API key (hidden): '); await Promise.resolve(); input.write('123:discarded');
    input.write('\x1b'); await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await cancelledSecret, null); ui.tui.render();
    assert.equal(ui.tui.value, 'unsent draft'); assert.doesNotMatch(ui.tui.lastFrame.map(clean).join('\n'), /123:discarded/);
  } finally { ui.close(); }
  assert.ok(term.written.includes('\x1b[?1006h')); assert.ok(term.written.includes('\x1b[?1006l'));
});
test('terminal text handles wide characters and strips injected terminal controls', () => {
  assert.equal(cellWidth('你🐝a'), 5); assert.deepEqual(wrap('你🐝a', 4), ['你🐝', 'a']);
  assert.equal(clean('\x1b[2Jhello\x1b]0;bad\x07'), 'hello');
});
test('eye animation paints only changed mascot cells, respects spacing and stops queuing frames under backpressure', async () => {
  const term = terminal(), { ui, output } = term;
  try {
    clearTimeout(ui.tui.timer); clearTimeout(ui.tui.renderTimer); ui.tui.renderTimer = null;
    const answer = ui.ask('bzzy › '); await Promise.resolve();
    ui.event('message.user', { text: 'Keep this prompt visible while the mascot moves' });
    ui.event('text', { text: 'The chat text must stay still.' }); ui.tui.setPanel('activity'); ui.tui.render();
    const before = [...ui.tui.lastFrame], region = ui.tui.eyeRegion, written = term.written.length;
    assert.ok(region.columns >= 19 && region.rows >= 5);
    assert.ok(region.suffixes.every(suffix => suffix.startsWith('   ')), 'the sidebar keeps a gutter beside the mascot');
    assert.ok(region.top >= 2, 'the sidebar keeps padding above the eyes');
    ui.tui.animationTime = 2.2; ui.tui.paintEyes();
    assert.deepEqual(ui.tui.lastFrame.slice(region.top + region.rows - 1), before.slice(region.top + region.rows - 1));
    const painted = term.written.slice(written); assert.ok(painted.length > 0); assert.doesNotMatch(painted, /The chat text|YOU ASKED/);
    for (const cursor of painted.matchAll(/\x1b\[(\d+);(\d+)H/g)) {
      assert.ok(Number(cursor[1]) >= region.top && Number(cursor[1]) < region.top + region.rows);
      assert.ok(Number(cursor[2]) >= region.left && Number(cursor[2]) < region.left + region.columns);
    }
    const pausedAt = term.written.length; ui.tui.outputBlocked = true; ui.tui.animationTime = 3.2; ui.tui.paintEyes();
    assert.equal(term.written.length, pausedAt); output.emit('drain'); assert.equal(ui.tui.outputBlocked, false);
    assert.notDeepEqual(eyeMotion(1), eyeMotion(1 + 1 / 60)); assert.ok(eyeMotion(6.75).open < 0.2);
    ui.reader.close(); await answer;
  } finally { ui.close(); }
});
test('copy mode gives selection to the terminal, freezes rendering, and resumes queued live text without losing drafts', async () => {
  const term = terminal(), { ui, input } = term;
  try {
    const answer = ui.ask('bzzy › '); await Promise.resolve(); input.write('keep this draft');
    ui.event('text', { text: 'Select this reply with your terminal.' }); ui.tui.render();
    assert.equal(ui.tui.hitTargets.some(hit => hit.type === 'copy'), false);
    input.write('\x13');
    assert.equal(ui.tui.copyMode, true); assert.match(ui.tui.lastFrame.map(clean).join('\n'), /COPY MODE/);
    assert.ok(term.written.includes('\x1b[?1000l'));
    const frozenAt = term.written.length;
    ui.event('text', { text: 'A reply arrived during selection.' }); ui.tui.animationTime = 4.1; ui.tui.paintEyes(); ui.tui.render();
    input.write('ignored while selecting'); assert.equal(term.written.length, frozenAt); assert.equal(ui.tui.value, 'keep this draft');
    ui.tui.key('', { name: 'escape' }); ui.tui.render();
    assert.equal(ui.tui.copyMode, false); assert.match(ui.tui.entries.at(-1).text, /A reply arrived during selection/); assert.match(ui.tui.lastFrame.map(clean).join('\n'), /A reply arrived/);
    input.write('\x13'); assert.equal(ui.tui.copyMode, true); input.write('\x13'); assert.equal(ui.tui.copyMode, false);
    ui.reader.close(); await answer;
  } finally { ui.close(); }
});
test('Mac Option+Delete and Ctrl+W delete words, with Unicode and word navigation at the cursor', async () => {
  const { ui, input } = terminal();
  try {
    const answer = ui.ask('bzzy › '); await Promise.resolve(); input.write('alpha beta');
    input.write('\x1b\x7f'); assert.equal(ui.tui.value, 'alpha ');
    input.write('naïve 世界'); input.write('\x17'); assert.equal(ui.tui.value, 'alpha naïve ');
    input.write('\x17'); assert.equal(ui.tui.value, 'alpha ');
    input.write('beta gamma'); ui.tui.key('', { name: 'left', meta: true }); assert.equal(ui.tui.cursor, 'alpha beta '.length);
    input.write('\x1b[3;3~'); assert.equal(ui.tui.value, 'alpha beta ');
    ui.tui.key('', { name: 'home' }); input.write('\x1b[3;3~'); assert.equal(ui.tui.value, ' beta ');
    ui.tui.key('\r', { name: 'return' }); assert.equal(await answer, ' beta ');
  } finally { ui.close(); }
});
test('multiline tool descriptions stay out of the composer and the header always shows the selected effort', async () => {
  const { ui, output } = terminal();
  try {
    const answer = ui.ask('bzzy › '); await Promise.resolve(); ui.tui.key('my unsent message', {});
    ui.updateSession({ provider: 'codex', model: 'gpt-5.6-sol', selectedEffort: 'high', executionState: 'running' });
    ui.event('message.user', { text: 'Visit the supplied website and inspect its footer' });
    ui.event('tool', { name: 'shell', detail: 'curl example\npython\nprint("a long tool invocation")\n'.repeat(30) });
    for (const rows of [32, 24, 18]) {
      Object.assign(output, { columns: 80, rows }); ui.tui.render();
      for (const line of ui.tui.lastFrame) assert.doesNotMatch(clean(line), /[\r\n]/);
      const frame = ui.tui.lastFrame.map(clean).join('\n'); assert.match(frame, /my unsent message/); assert.match(frame, /effort high/);
      assert.match(frame, /\d{2}:\d{2}:\d{2}/);
    }
    ui.reader.close(); await answer;
  } finally { ui.close(); }
});
test('HTTP view restores legacy WebFetch metadata and merges live request/result updates into one row', async () => {
  const { ui } = terminal();
  try {
    ui.event('backend', { method: 'tool.started', params: { id: 'visit', name: 'WebFetch', input: { url: 'https://www.paypal.com/?token=private-value' } } });
    ui.tui.setPanel('http'); ui.tui.render(); const history = ui.tui.lastFrame.map(clean).join('\n');
    assert.match(history, /paypal\.com/); assert.match(history, /Backend-reported visit/); assert.doesNotMatch(history, /private-value/);
    const url = ui.tui.traffic[0].url;
    ui.event('network.backend', { id: 'real-visit', backendCallId: 'visit', url, provenance: 'backend-reported', backendState: 'completed' });
    assert.equal(ui.tui.traffic.length, 1); assert.equal(ui.tui.traffic[0].backendState, 'completed');
    ui.event('network.request', { id: 'observed', url: 'https://approved.example', method: 'GET' });
    ui.event('network.response', { id: 'observed', url: 'https://approved.example', method: 'GET', status: 200 });
    assert.equal(ui.tui.traffic.length, 2); assert.equal(ui.tui.traffic[1].status, 200);
  } finally { ui.close(); }
});
