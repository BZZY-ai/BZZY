const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
function graphemeWidth(segment) {
  const point = segment.codePointAt(0);
  if (/^[\p{Mark}\u200d\ufe0f]+$/u.test(segment)) return 0;
  return /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(segment) || point >= 0x1100 && (point <= 0x115f || point >= 0x2e80 && point <= 0xa4cf || point >= 0xac00 && point <= 0xd7a3 || point >= 0xf900 && point <= 0xfaff || point >= 0xfe10 && point <= 0xfe6f || point >= 0xff00 && point <= 0xff60 || point >= 0x20000) ? 2 : 1;
}
export function clean(value) {
  return String(value ?? '').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}
export function cellWidth(value) {
  const text = clean(value);
  if (/^[\x20-\x7e]*$/.test(text)) return text.length;
  let width = 0;
  for (const { segment } of graphemes.segment(text)) {
    width += graphemeWidth(segment);
  }
  return width;
}
export function clip(value, width, ellipsis = '…') {
  const text = clean(value).replace(/[\r\n\u2028\u2029]/g, ' ').replaceAll('\t', '  ');
  if (cellWidth(text) <= width) return text;
  let result = '', used = 0; const suffixWidth = cellWidth(ellipsis);
  for (const { segment } of graphemes.segment(text)) {
    const size = graphemeWidth(segment); if (used + size > width - suffixWidth) break;
    result += segment; used += size;
  }
  return result + (width > 0 ? ellipsis : '');
}
export function wrap(value, width, limit = Infinity) {
  width = Math.max(1, Math.floor(width));
  const lines = [];
  for (const paragraph of clean(value).replaceAll('\t', '  ').split('\n')) {
    if (/^[\x20-\x7e]*$/.test(paragraph)) {
      if (!paragraph) lines.push('');
      else for (let start = 0; start < paragraph.length; start += width) {
        lines.push(paragraph.slice(start, start + width)); if (lines.length >= limit) return lines;
      }
      if (lines.length >= limit) return lines;
      continue;
    }
    let line = '', used = 0;
    for (const { segment } of graphemes.segment(paragraph)) {
      const size = graphemeWidth(segment);
      if (used + size > width && line) { lines.push(line); if (lines.length >= limit) return lines; line = ''; used = 0; }
      line += segment; used += size;
    }
    lines.push(line);
    if (lines.length >= limit) return lines;
  }
  return lines;
}
export const color = (text, code, bold = false) => `\x1b[${bold ? '1;' : ''}38;5;${code}m${text}\x1b[22;39m`;
export { duration } from '@bzzy/core/engine/format-duration.js';
