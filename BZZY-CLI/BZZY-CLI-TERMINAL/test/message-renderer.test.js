import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { renderMessageBody } from '../src/message-renderer.js';
import { createTerminalTheme } from '../src/terminal-theme.js';
import { clean, cellWidth } from '../src/terminal-format.js';
import { UI } from '../src/ui.js';

const message = content => `<message version="1">${content}</message>`;
const theme = level => createTerminalTheme({ isTTY: true }, level ? { FORCE_COLOR: String(level) } : { NO_COLOR: '1' });
const plain = rendered => rendered.lines.map(clean);

test('rich terminal blocks preserve semantic structure and inherited inline styles', () => {
  const body = message('<h1>Report</h1><h2>Details</h2><p size="small">Note <span size="large" color="mint"><b>Ready <i>now</i></b></span></p><ul><li>One</li><li>Two</li></ul><ol><li>First</li><li>Second</li></ol><blockquote>Quoted <b>evidence</b></blockquote><hr/><pre language="swift"><code>if count &lt; 3 {\n    print("Safe")\n}</code></pre>');
  const rendered = renderMessageBody(body, { width: 40, theme: theme(3) });
  assert.equal(rendered.body, body);
  assert.equal(rendered.isFormatted, true);
  const text = plain(rendered).join('\n'), styled = rendered.lines.join('\n');
  assert.match(text, /^Report\n\nDetails\n\nNote Ready now/);
  assert.match(text, /• One\n• Two/); assert.match(text, /1\. First\n2\. Second/);
  assert.match(text, /│ Quoted evidence/); assert.match(text, /╭─ swift\n│ if count < 3 \{\n│     print\("Safe"\)/);
  assert.match(styled, /\x1b\[1m/); assert.match(styled, /\x1b\[2m/);
  assert.match(styled, /\x1b\[3m/); assert.match(styled, /\x1b\[4m/);
  assert.match(styled, /\x1b\[38;2;0;229;203m/);
  assert.ok(rendered.lines.every(line => cellWidth(line) <= 40));
});

test('all named colors adapt to truecolor, 256-color, basic terminals and NO_COLOR', () => {
  const names = ['mint', 'amber', 'coral', 'blue', 'lavender', 'muted'];
  const body = message(`<p>${names.map(name => `<span color="${name}">${name}</span>`).join(' ')}</p>`);
  const truecolor = renderMessageBody(body, { theme: theme(3) }).lines.join('\n');
  for (const rgb of ['0;229;203', '228;189;124', '242;139;130', '140;189;245', '185;165;245', '145;166;161']) assert.ok(truecolor.includes(`\x1b[38;2;${rgb}m`), rgb);
  const indexed = renderMessageBody(body, { theme: theme(2) }).lines.join('\n');
  assert.match(indexed, /\x1b\[38;5;\d+m/); assert.doesNotMatch(indexed, /38;2;/);
  const basic = renderMessageBody(body, { theme: theme(1) }).lines.join('\n');
  for (const code of [96, 93, 91, 94, 95, 37]) assert.ok(basic.includes(`\x1b[${code}m`), code);
  const monochrome = renderMessageBody(body, { theme: theme(0) }).lines.join('\n');
  assert.equal(monochrome, names.join(' ')); assert.doesNotMatch(monochrome, /\x1b/);
});

test('tables align and wrap every Unicode cell within the terminal width', () => {
  const body = message('<table><thead><tr><th>Service</th><th>Status</th></tr></thead><tbody><tr><td><b>漢字 cloud 🐝</b></td><td><span color="coral">Needs review</span><br/>Pending</td></tr><tr><td>Music</td><td>Ready</td></tr></tbody></table>');
  for (const width of [80, 26, 18]) {
    const rendered = renderMessageBody(body, { width, theme: theme(3) });
    const widths = rendered.lines.map(cellWidth);
    assert.ok(widths.every(size => size <= width), `${width}: ${widths}`);
    assert.ok(widths.every(size => size === widths[0]), `${width}: table borders/cells align`);
    const text = plain(rendered).join('\n');
    assert.match(text, /┌.*┬.*┐/); assert.match(text, /├.*┼.*┤/); assert.match(text, /└.*┴.*┘/);
    assert.match(text, /Music/); assert.match(text, /Ready/);
    assert.ok(rendered.lines.join('\n').includes('\x1b[38;2;242;139;130m'));
  }
});

test('a very narrow terminal stacks wide tables without dropping values or overflowing', () => {
  const body = message('<table><tr><th>A</th><th>B</th><th>C</th><th>D</th><th>E</th><th>F</th></tr><tr><td>V1</td><td>V2</td><td>V3</td><td>V4</td><td>V5</td><td>V6</td></tr></table>');
  const rendered = renderMessageBody(body, { width: 12, theme: theme(0) });
  assert.deepEqual(rendered.lines, ['A: V1', 'B: V2', 'C: V3', 'D: V4', 'E: V5', 'F: V6']);
  assert.ok(rendered.lines.every(line => cellWidth(line) <= 12));
});

test('wrapping preserves inline styles and full Unicode graphemes', () => {
  const body = message('<p><b>A 👩‍💻 é B C</b> <i>tail</i></p>');
  const rendered = renderMessageBody(body, { width: 6, theme: theme(3) });
  assert.ok(plain(rendered).join('').includes('A 👩‍💻 é B C tail'));
  assert.ok(rendered.lines.every(line => cellWidth(line) <= 6));
  assert.ok(rendered.lines.slice(0, 2).every(line => line.includes('\x1b[1m')));
  assert.match(rendered.lines.join('\n'), /\x1b\[3m/);
  const narrow = renderMessageBody(message('<p>🐝</p>'), { width: 1, theme: theme(0) });
  assert.equal(cellWidth(narrow.lines[0]), 1); assert.equal(narrow.plainText, '🐝');
});

test('monochrome keeps code, tables, lists and headings readable without any ANSI', () => {
  const body = message('<h1>Title</h1><p><b>Bold</b> <i>italic</i> <span color="coral">Failure</span></p><ul><li>Review</li></ul><pre language="sh"><code>printf \'**literal**\'</code></pre>');
  const rendered = renderMessageBody(body, { width: 32, theme: theme(0) });
  const text = rendered.lines.join('\n');
  assert.doesNotMatch(text, /\x1b/); assert.match(text, /Title/); assert.match(text, /• Review/);
  assert.match(text, /\*\*literal\*\*/); assert.match(text, /╭─ sh/);
});

test('terminal controls from plain, invalid markup and escaped external content stay inert', () => {
  const hostile = '\x1b]52;c;c2VjcmV0\x07\x1b[2Jvisible';
  for (const body of [hostile, message(`<p>${hostile}</p>`), message('<p>&#27;[2Jvisible</p>')]) {
    const rendered = renderMessageBody(body, { theme: theme(3) });
    assert.equal(rendered.isFormatted, false);
    assert.doesNotMatch(rendered.lines.join('\n'), /\x1b/);
    assert.equal(rendered.body, body);
  }
  const safe = renderMessageBody(message('<p>&lt;script&gt;literal &amp; harmless&lt;/script&gt;</p>'), { theme: theme(3) });
  assert.equal(plain(safe).join('\n'), '<script>literal & harmless</script>');
});

test('stdout rich streaming uses the same styled renderer as full-screen chat', () => {
  const input = new PassThrough(), output = new PassThrough(); Object.assign(output, { columns: 40, isTTY: false });
  let written = ''; output.on('data', chunk => { written += chunk; });
  const ui = new UI({ input, output, error: output }); ui.messageTheme = theme(3);
  const body = message('<h1>Report</h1><p><b>Ready</b> <i>now</i> <span color="mint">Verified</span></p>');
  try {
    ui.event('text', { itemId: 'rich', text: body.slice(0, 35) }); assert.equal(written, '');
    ui.event('text', { itemId: 'rich', text: body.slice(35) });
    assert.equal(written, renderMessageBody(body, { width: 40, theme: theme(3) }).lines.join('\n'));
    assert.match(written, /\x1b\[1m/); assert.match(written, /\x1b\[3m/); assert.match(written, /38;2;0;229;203/);
  } finally { ui.close(); }
});

test('full-screen chat retains locally generated inline colors and emphasis through final layout', () => {
  const input = new PassThrough(); Object.assign(input, { isTTY: true, isRaw: false, setRawMode(value) { this.isRaw = value; } });
  const output = new PassThrough(); Object.assign(output, { isTTY: true, rows: 32, columns: 80 }); output.resume();
  const ui = new UI({ input, output, error: output, pet: false });
  try {
    ui.setSession('format-session'); ui.tui.theme = theme(3);
    const body = message('<h1>Report</h1><p><b>Ready</b> <i>now</i> <span color="mint">Verified</span></p>');
    ui.event('text', { itemId: 'styled', text: body }); ui.tui.render();
    const entry = ui.tui.entries.at(-1), layout = ui.tui.entryLayout(entry, 76);
    assert.equal(entry.text, body);
    const styled = layout.lines.join('\n'), frame = ui.tui.lastFrame.join('\n');
    for (const text of [styled, frame]) {
      assert.match(text, /\x1b\[1m/); assert.match(text, /\x1b\[3m/);
      assert.match(text, /\x1b\[38;2;0;229;203m/);
      assert.doesNotMatch(clean(text), /<message|<span/);
    }
    assert.ok(layout.lines.every(line => cellWidth(line) <= 76));
  } finally { ui.close(); }
});
