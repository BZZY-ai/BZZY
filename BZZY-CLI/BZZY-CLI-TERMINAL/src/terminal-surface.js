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

export function fillSurface(text, width, theme, background, foreground, bold = false) {
  return theme.background(background) + theme.color(text + ' '.repeat(Math.max(0, width - cellWidth(text))), foreground, bold)
    + theme.background(palette.background);
}
