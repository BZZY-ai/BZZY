import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { UI } from '../src/ui.js';
import { clean } from '../src/terminal-format.js';
import { MESSAGE_FORMAT_LIMITS } from '@bzzy/core/message-format';

const message = text => `<message version="1">${text}</message>`;
const table = message('<p><b>Summary</b></p><table><tr><th>Item</th><th>Status</th></tr><tr><td>Review</td><td><span color="amber">Pending</span></td></tr></table>');
const tableDisplay = 'Summary\n\n┌────────┬─────────┐\n│ Item   │ Status  │\n├────────┼─────────┤\n│ Review │ Pending │\n└────────┴─────────┘';

function terminal({ tty = false, json = false } = {}) {
  const input = new PassThrough(); Object.assign(input, { isTTY: tty, isRaw: false, setRawMode(value) { this.isRaw = value; } });
  const output = new PassThrough(); Object.assign(output, { isTTY: tty, rows: 32, columns: 100 });
  let written = ''; output.on('data', chunk => { written += chunk; });
  const ui = new UI({ input, output, error: output, json, pet: false });
  if (tty) ui.setSession('test-session');
  return { ui, output, get written() { return written; } };
}

test('plain terminal output keeps ordinary text immediate and JSON bodies unmodified', () => {
  const plain = terminal(), json = terminal({ json: true });
  try {
    plain.ui.event('text', { itemId: 'plain', text: 'Hello ' });
    assert.equal(plain.written, 'Hello ');
    plain.ui.event('text', { itemId: 'plain', text: '**BZZY**' });
    assert.equal(plain.written, 'Hello **BZZY**');
    json.ui.event('text', { itemId: 'rich', text: table });
    assert.deepEqual(JSON.parse(json.written), { type: 'text', itemId: 'rich', text: table });
  } finally { plain.ui.close(); json.ui.close(); }
});

test('plain terminal buffers a possible markup root across chunks and hidden events', () => {
  const term = terminal();
  try {
    term.ui.event('text', { itemId: 'rich', text: ' <m' });
    term.ui.event('usage.updated', { tokens: 1 });
    term.ui.event('backend', { method: 'item/agentMessage/delta' });
    assert.equal(term.written, '');
    term.ui.event('text', { itemId: 'rich', text: table.slice(2, 50) });
    assert.equal(term.written, '');
    term.ui.event('text', { itemId: 'rich', text: table.slice(50) });
    assert.equal(term.written, tableDisplay);
    term.ui.newline();
    assert.equal(term.written, tableDisplay + '\n');
  } finally { term.ui.close(); }
});

test('plain terminal flushes incomplete/malformed markup as safe text at boundaries', () => {
  for (const body of ['<message version="1"><p>incomplete', message('<script>not executed</script>'), message('<p onclick="run()">not executed</p>')]) {
    const term = terminal();
    try {
      term.ui.event('text', { itemId: 'bad', text: body });
      term.ui.event('tool', { name: 'test-tool' });
      assert.equal(term.written, `${body}\n  · test-tool\n`);
    } finally { term.ui.close(); }
  }
  const term = terminal();
  term.ui.event('text', { text: '<m' }); term.ui.close();
  assert.equal(term.written, '<m\n');
});

test('ordinary less-than prefixes and interleaved peer replies retain their content', () => {
  const term = terminal();
  try {
    term.ui.event('text', { itemId: 'math', text: '<' });
    assert.equal(term.written, '');
    term.ui.event('text', { itemId: 'math', text: ' 3 is a comparison.' });
    assert.equal(term.written, '< 3 is a comparison.');
    term.ui.newline();
    const a = message('<p>Alpha</p>'), b = message('<p>Beta</p>');
    term.ui.event('peer.text', { childSessionId: 'a', agent: 'A', itemId: 'a', text: a.slice(0, 20) });
    term.ui.event('peer.text', { childSessionId: 'b', agent: 'B', itemId: 'b', text: b });
    term.ui.event('peer.text', { childSessionId: 'a', agent: 'A', itemId: 'a', text: a.slice(20) });
    assert.match(term.written, /\[B\] Beta\n\[A\] Alpha$/);
    assert.doesNotMatch(term.written, /<message/);
  } finally { term.ui.close(); }
});

test('providers without response IDs can begin another rich reply after a turn boundary', () => {
  const term = terminal();
  try {
    term.ui.event('text', { text: 'An ordinary first turn.' }); term.ui.newline();
    term.ui.event('text', { text: message('<p>A rich second turn.</p>') }); term.ui.newline();
    assert.equal(term.written, 'An ordinary first turn.\nA rich second turn.\n');
  } finally { term.ui.close(); }
});

test('rich stream buffers are bounded and oversized trailing chunks stay suppressed', () => {
  const term = terminal();
  try {
    const body = '<message version="1"><p>' + 'x'.repeat(MESSAGE_FORMAT_LIMITS.bytes);
    term.ui.event('text', { itemId: 'large', text: body });
    assert.equal(Buffer.byteLength(term.written), MESSAGE_FORMAT_LIMITS.bytes);
    term.ui.event('text', { itemId: 'large', text: '</p></message>extra' });
    assert.equal(Buffer.byteLength(term.written), MESSAGE_FORMAT_LIMITS.bytes);
    assert.equal([...term.ui.messageStreams.values()][0].buffer, '');
  } finally { term.ui.close(); }
});

test('TUI projects valid markup at rendering/copy boundaries and retains original body', async () => {
  const term = terminal({ tty: true }), { ui } = term;
  const copied = []; ui.clipboard = { async copyText(text) { copied.push(text); return { copied: true, method: 'native' }; } };
  try {
    ui.event('text', { itemId: 'rich', turnId: 'one', text: table.slice(0, 32) });
    const entry = ui.tui.entries.at(-1);
    const provisional = ui.tui.entryLayout(entry, 90).lines.map(clean).join('\n');
    assert.match(provisional, /<message/);
    ui.event('text', { itemId: 'rich', turnId: 'one', text: table.slice(32) });
    ui.tui.render();
    const frame = ui.tui.entryLayout(entry, 90).lines.map(clean).join('\n');
    assert.equal(entry.text, table);
    assert.match(frame, /Summary/); assert.match(frame, /│ Item +│ Status/); assert.match(frame, /│ Review │ Pending/);
    assert.doesNotMatch(frame, /<message|<table|<span/);
    const reply = ui.tui.hitTargets.find(hit => hit.type === 'response'); assert.ok(reply);
    ui.tui.mouse(2, reply.left, reply.row); ui.tui.render();
    const copy = ui.tui.hitTargets.find(hit => hit.type === 'choice' && hit.index === 0);
    ui.tui.mouse(0, copy.left, copy.row); await ui.tui.clipboardTask;
    assert.deepEqual(copied, ['Summary\n\nItem · Status\nReview · Pending']);
    assert.equal(entry.text, table);
  } finally { ui.close(); }
});

test('TUI preserves code literals, malformed fallbacks and original terminal controls', () => {
  const { ui } = terminal({ tty: true });
  try {
    const body = message('<pre language="text"><code>**literal**\n# heading</code></pre>');
    const rich = ui.tui.add('assistant', body);
    const rendered = ui.tui.entryLayout(rich, 90).lines.map(clean).join('\n');
    assert.match(rendered, /\*\*literal\*\*/); assert.match(rendered, /# heading/);
    const malformed = message('<p size="giant">Fallback</p>');
    assert.match(ui.tui.entryLayout(ui.tui.add('assistant', malformed), 90).lines.map(clean).join('\n'), /<message/);
    const raw = '\x1b[31mUntrusted\x1b[0m';
    const entry = ui.tui.add('assistant', raw);
    assert.equal(entry.text, raw);
    assert.ok(ui.tui.entryLayout(entry, 90).lines.every(line => !line.includes('\x1b[31m')));
  } finally { ui.close(); }
});

test('execution indicators remain a terminal-owned UI hook', () => {
  const { ui } = terminal();
  try {
    const indicator = ui.executionIndicator(false);
    assert.equal(indicator.ui, ui); assert.equal(indicator.enabled, false);
    indicator.start(); assert.equal(indicator.timer, null); indicator.stop();
  } finally { ui.close(); }
});
