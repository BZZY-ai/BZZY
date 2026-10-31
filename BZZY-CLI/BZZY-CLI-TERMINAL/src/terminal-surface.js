import { cellWidth } from './terminal-format.js';
import { palette } from './terminal-theme.js';

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
// Keep SGR styling when compositing terminal surfaces. Never split a wide glyph
// or strip the colors from the rest of a chat line when a popup covers it.
export function sliceCells(value, start, end) {
  let column = 0, styles = '', result = '', begun = false, colored = false;
  for (const token of String(value).match(/\x1b\[[0-9;:]*m|[^\x1b]+/g) || []) {
    if (token.startsWith('\x1b')) {
      colored = true;
      if (begun) result += token;
      if (token === '\x1b[0m') styles = token; else styles += token;
      continue;
    }
    for (const { segment } of graphemes.segment(token)) {
      const size = cellWidth(segment), next = column + size;
      if (next > start && column < end) {
        if (!begun) { result += styles; begun = true; }
        result += column < start || next > end ? ' '.repeat(Math.max(0, Math.min(next, end) - Math.max(column, start))) : segment;
      }
      column = next;
      if (column >= end) return result + (colored ? '\x1b[0m' : '');
    }
  }
  return result + (colored ? '\x1b[0m' : '');
}

export function replaceCells(line, left, replacement, width, theme, background) {
  const prefix = sliceCells(line, 0, left), size = cellWidth(replacement);
  const suffix = sliceCells(line, left + size, width);
  const restore = theme.background(background) + theme.foreground(palette.text);
  return prefix + ' '.repeat(Math.max(0, left - cellWidth(prefix))) + replacement + restore + suffix;
}

const plainState = Object.freeze({ bold: false, dim: false, italic: false, underline: false, inverse: false, fg: '39', bg: '49' });
function applySgr(state, params) {
  const codes = params === '' ? [0] : params.split(';').map(Number);
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    if (!Number.isInteger(code)) return false;
    if (code === 0) Object.assign(state, plainState);
    else if (code === 1) state.bold = true; else if (code === 2) state.dim = true;
    else if (code === 22) { state.bold = false; state.dim = false; }
    else if (code === 3 || code === 23) state.italic = code === 3;
    else if (code === 4 || code === 24) state.underline = code === 4;
    else if (code === 7 || code === 27) state.inverse = code === 7;
    else if (code === 39 || code >= 30 && code <= 37 || code >= 90 && code <= 97) state.fg = String(code);
    else if (code === 49 || code >= 40 && code <= 47 || code >= 100 && code <= 107) state.bg = String(code);
    else if ((code === 38 || code === 48) && codes[i + 1] === 5 && Number.isInteger(codes[i + 2])) { state[code === 38 ? 'fg' : 'bg'] = `${code};5;${codes[i + 2]}`; i += 2; }
    else if ((code === 38 || code === 48) && codes[i + 1] === 2 && codes.slice(i + 2, i + 5).filter(Number.isInteger).length === 3) { state[code === 38 ? 'fg' : 'bg'] = `${code};2;${codes.slice(i + 2, i + 5).join(';')}`; i += 4; }
    else return false;
  }
  return true;
}
const isPlain = state => Object.keys(plainState).every(key => state[key] === plainState[key]);
function sgrChange(current, next) {
  if (!current) return '\x1b[0m' + (isPlain(next) ? '' : sgrChange(plainState, next));
  if (isPlain(next)) return isPlain(current) ? '' : '\x1b[0m';
  const same = key => current[key] === next[key];
  let out = '', bold = current.bold, dim = current.dim;
  if (bold && !next.bold || dim && !next.dim) { out += '\x1b[22m'; bold = dim = false; }
  if (next.bold && !bold) out += '\x1b[1m';
  if (next.dim && !dim) out += '\x1b[2m';
  if (!same('italic')) out += next.italic ? '\x1b[3m' : '\x1b[23m';
  if (!same('underline')) out += next.underline ? '\x1b[4m' : '\x1b[24m';
  if (!same('inverse')) out += next.inverse ? '\x1b[7m' : '\x1b[27m';
  if (!same('fg')) out += `\x1b[${next.fg}m`;
  if (!same('bg')) out += `\x1b[${next.bg}m`;
  return out;
}
// Output-only compaction of a painted frame: every cell keeps the attributes it
// had, but SGR codes that cannot change what the terminal paints are dropped.
// Bytes pass through verbatim until a full reset makes the terminal state
// known. Other control sequences keep their order; erase sequences first get
// the pending attributes because terminals fill erased cells with the active
// background. Frames using any SGR code this does not model are left as-is.
export function compactSgr(value) {
  let out = '', current = null, pending = null, dirty = false;
  const flush = () => { if (dirty) { out += sgrChange(current, pending); current = { ...pending }; dirty = false; } };
  for (const [token, params] of String(value).matchAll(/\x1b\[([0-9;]*)m|\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-~]|[^\x1b]+|\x1b/g)) {
    if (params !== undefined) {
      if (current) { if (!applySgr(pending, params)) return value; dirty = true; continue; }
      out += token;
      if (params === '' || params === '0' || params.startsWith('0;')) {
        current = { ...plainState };
        if (!applySgr(current, params)) return value;
        pending = { ...current };
      }
      continue;
    }
    if (/^\x1b\[[0-?]*[ -/]*m$/.test(token)) return value;
    if (!current) { out += token; continue; }
    if (token[0] !== '\x1b') { flush(); out += token; continue; }
    if (/^\x1b\[[0-9;]*[HfABCDGd]$|^\x1b\[\?(?:25|2004|1000|1002|1003|1006)[hl]$/.test(token)) { out += token; continue; }
    flush(); out += token;
    if (!/^\x1b\[[0-9;]*[KJ]$/.test(token)) { current = pending = null; dirty = false; }
  }
  flush();
  return out;
}

export function fillSurface(text, width, theme, background, foreground, bold = false, restore = palette.background) {
  return theme.background(background) + theme.color(text + ' '.repeat(Math.max(0, width - cellWidth(text))), foreground, bold)
    + theme.background(restore);
}
