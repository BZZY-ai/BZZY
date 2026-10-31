import test from 'node:test';
import assert from 'node:assert/strict';
import { compactSgr } from '../src/terminal-surface.js';

// A small screen model: cells keep their character and every SGR attribute;
// erasing a line fills it with the active background.
function paint(bytes, rows = 4, cols = 24) {
  const plain = { bold: false, dim: false, italic: false, underline: false, inverse: false, fg: '39', bg: '49' };
  let attrs = { ...plain }, saved = null, row = 0, column = 0;
  const grid = Array.from({ length: rows }, () => Array(cols).fill(' |49'));
  for (const [token, params] of bytes.matchAll(/\x1b\[([0-9;]*)m|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-~]|[^\x1b]/g)) {
    if (params !== undefined) {
      const codes = params === '' ? [0] : params.split(';').map(Number);
      for (let i = 0; i < codes.length; i++) {
        const code = codes[i];
        if (code === 0) attrs = { ...plain };
        else if (code === 1) attrs.bold = true; else if (code === 2) attrs.dim = true; else if (code === 22) attrs.bold = attrs.dim = false;
        else if (code === 3 || code === 23) attrs.italic = code === 3;
        else if (code === 4 || code === 24) attrs.underline = code === 4;
        else if (code === 7 || code === 27) attrs.inverse = code === 7;
        else if (code === 38 || code === 48) { const span = codes[i + 1] === 5 ? 2 : 4; attrs[code === 38 ? 'fg' : 'bg'] = codes.slice(i, i + span + 1).join(';'); i += span; }
        else if (code === 39 || code >= 30 && code <= 37 || code >= 90 && code <= 97) attrs.fg = String(code);
        else attrs.bg = String(code);
      }
    } else if (/^\x1b\[\d+;\d+H$/.test(token)) [row, column] = token.slice(2, -1).split(';').map(value => Number(value) - 1);
    else if (token === '\x1b[2K') grid[row].fill(' |' + attrs.bg);
    else if (token === '\x1b7') saved = { row, column, attrs: { ...attrs } };
    else if (token === '\x1b8') ({ row, column } = saved, attrs = { ...saved.attrs });
    else if (token[0] !== '\x1b') grid[row][column++] = token + '|' + JSON.stringify(attrs);
  }
  return grid.map(line => line.join(','));
}

test('compacted frames paint every cell with the same character and attributes in fewer bytes', () => {
  const rgb = (base, value) => `\x1b[${base};2;${value}m`;
  const frames = [
    `\x1b[0m\x1b[?25l\x1b[1;1H${rgb(48, '10;13;18')}${rgb(38, '230;234;240')}\x1b[2K${rgb(48, '14;18;25')}\x1b[1m${rgb(38, '255;178;36')}NAV\x1b[22m${rgb(38, '230;234;240')}${rgb(48, '14;18;25')} x${rgb(38, '230;234;240')}y\x1b[0m`
      + `\x1b[2;1H${rgb(48, '10;13;18')}${rgb(38, '230;234;240')}\x1b[2K\x1b[2mdim\x1b[1mboth\x1b[22mnone\x1b[7minv\x1b[27m\x1b[38;5;214mi\x1b[93mb\x1b[39m.\x1b[0m\x1b[2;4H\x1b[?25h`,
    `\x1b7\x1b[?25l\x1b[3;1H${rgb(48, '0;0;0')}\x1b[2Kab${rgb(48, '255;178;36')}\x1b[38;2;0;0;0mSEL\x1b[27m${rgb(48, '0;0;0')}cd\x1b[0m\x1b8`,
    '\x1b[1;1H\x1b[47m    \x1b[0m\x1b[4mu\x1b[24m\x1b[3mi\x1b[23m\x1b[44m\x1b[2K\x1b[0m',
  ];
  for (const frame of frames) assert.deepEqual(paint(compactSgr(frame)), paint(frame));
  assert.ok(compactSgr(frames[0]).length < frames[0].length, 'redundant color changes are dropped');
  const unknownStart = `\x1b[1;1H${rgb(38, '1;2;3')}${rgb(38, '1;2;3')}a\x1b[0m`;
  assert.ok(compactSgr(unknownStart).startsWith(`\x1b[1;1H${rgb(38, '1;2;3')}${rgb(38, '1;2;3')}a`), 'bytes before the first reset stay verbatim');
});

test('frames using SGR forms the compactor does not model pass through unchanged', () => {
  for (const frame of ['\x1b[5mblink\x1b[0m', '\x1b[38:2::1:2:3mcolon\x1b[0m', 'plain text']) assert.equal(compactSgr(frame), frame);
});
