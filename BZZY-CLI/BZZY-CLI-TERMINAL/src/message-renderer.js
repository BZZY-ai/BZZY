import { parseMessageBody } from '@bzzy/core/message-format';
import { clean, cellWidth, wrap } from './terminal-format.js';
import { createTerminalTheme, palette } from './terminal-theme.js';

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
// Message colors are part of the cross-client body contract, independent of
// future changes to button, navigation and border colors.
const colors = Object.freeze({ mint: '#00E5CB', amber: '#E4BD7C', coral: '#F28B82', blue: '#8CBDF5', lavender: '#B9A5F5', muted: '#91A6A1' });
const lightColors = Object.freeze({ mint: '#087664', amber: '#805000', coral: '#B4322D', blue: '#235BB0', lavender: '#684196', muted: '#52606D' });
const basicColors = Object.freeze({ mint: 96, amber: 93, coral: 91, blue: 94, lavender: 95, muted: 37 });
const safeText = text => clean(text).replace(/[\u2028\u2029]/g, '\n').replaceAll('\t', '  ');
const elements = node => node.children.filter(child => child.tag !== '#text');
const textOf = runs => runs.map(run => run.text).join('');
const plainStyle = Object.freeze({});

function inlineRuns(node, inherited = plainStyle) {
  const runs = [];
  for (const child of node.children) {
    if (child.tag === '#text') { runs.push({ text: safeText(child.text), style: inherited }); continue; }
    if (child.tag === 'br') { runs.push({ text: '\n', style: inherited }); continue; }
    const style = { ...inherited };
    if (['b', 'strong'].includes(child.tag)) style.bold = true;
    if (['i', 'em'].includes(child.tag)) style.italic = true;
    if (child.tag === 'code') style.code = true;
    if (child.tag === 'span') {
      if (child.attributes.size) style.size = child.attributes.size;
      if (child.attributes.color) style.color = child.attributes.color;
    }
    runs.push(...inlineRuns(child, style));
  }
  return runs;
}

// Wrap decoded text before adding any terminal escape sequences. Segment the
// full string so combining marks and emoji spanning inline runs stay together.
function wrapRuns(runs, width) {
  width = Math.max(1, width);
  const text = textOf(runs), lines = [[]];
  let index = 0, boundary = runs[0]?.text.length || 0, used = 0;
  const push = (value, style) => {
    const line = lines.at(-1), previous = line.at(-1);
    if (previous?.style === style) previous.text += value;
    else line.push({ text: value, style });
  };
  for (const segment of graphemes.segment(text)) {
    while (index < runs.length - 1 && segment.index >= boundary) boundary += runs[++index].text.length;
    const style = runs[index]?.style || plainStyle;
    if (segment.segment === '\n' || segment.segment === '\r\n') { lines.push([]); used = 0; continue; }
    const size = cellWidth(segment.segment);
    if (used + size > width && used) { lines.push([]); used = 0; }
    // A wide scalar cannot fit a one-column terminal. Show a bounded marker,
    // retaining the original Unicode text in history and the clipboard view.
    const value = size > width ? '�' : segment.segment;
    push(value, style); used += Math.min(size, width);
  }
  return lines;
}

function styleText(runs, context) {
  const { theme, background } = context;
  if (!theme.level) return textOf(runs);
  const reset = '\x1b[22;23;24m' + theme.foreground(palette.text);
  return runs.map(({ text, style }) => {
    if (!text) return '';
    const tone = (theme.name === 'white' ? lightColors : colors)[style.color] || (style.size === 'small' ? palette.muted : palette.text);
    const basicTone = basicColors[style.color] && (theme.name === 'white' ? { mint: 36, amber: 33, coral: 31, blue: 34, lavender: 35, muted: 90 }[style.color] : basicColors[style.color]);
    const foreground = theme.level === 1 && basicTone ? `\x1b[${basicTone}m` : theme.foreground(tone);
    const attributes = `${style.bold || style.size === 'large' ? '\x1b[1m' : ''}${style.size === 'small' ? '\x1b[2m' : ''}${style.italic ? '\x1b[3m' : ''}${style.underline ? '\x1b[4m' : ''}`;
    const codeBackground = style.code ? theme.background(palette.surface) : '';
    const restoreBackground = style.code ? background ? theme.background(background) : '\x1b[49m' : '';
    return reset + attributes + foreground + codeBackground + text + reset + restoreBackground;
  }).join('');
}

function styled(text, color, context, extra = {}) { return styleText([{ text, style: { color, ...extra } }], context); }

function textLines(node, context, style = plainStyle, prefix = '') {
  const prefixWidth = cellWidth(prefix);
  if (prefixWidth >= context.width) return wrapRuns([{ text: prefix, style: { color: 'muted' } }, ...inlineRuns(node, style)], context.width).map(line => styleText(line, context));
  const lines = wrapRuns(inlineRuns(node, style), context.width - prefixWidth);
  return lines.map((line, index) => (prefix ? styled(index ? ' '.repeat(prefixWidth) : prefix, 'muted', context) : '') + styleText(line, context));
}

function tableLines(node, context) {
  const rows = elements(node).flatMap(group => group.tag === 'tr' ? [group] : elements(group)).map(elements);
  const cells = rows.map((row, index) => row.map(cell => inlineRuns(cell, index ? plainStyle : { bold: true })));
  const columns = cells[0].length;
  const available = context.width - (columns * 3 + 1);
  if (available < columns) {
    // Native iOS can scroll a wide table. A narrow terminal instead stacks
    // named cells, preserving every row and value within the available width.
    const lines = [];
    const headers = cells[0].map(textOf);
    for (const row of cells.slice(1)) {
      if (lines.length) lines.push('');
      for (let column = 0; column < columns; column++) {
        const content = [{ text: `${headers[column]}: `, style: { bold: true } }, ...row[column]];
        lines.push(...wrapRuns(content, context.width).map(line => styleText(line, context)));
      }
    }
    if (!lines.length) lines.push(...cells[0].flatMap(cell => wrapRuns(cell, context.width).map(line => styleText(line, context))));
    return lines;
  }
  const widths = Array.from({ length: columns }, (_, column) => Math.max(1, Math.min(available,
    Math.max(...cells.flatMap(row => textOf(row[column]).split('\n').map(cellWidth))))));
  let total = widths.reduce((sum, width) => sum + width, 0);
  while (total > available) {
    const widest = widths.indexOf(Math.max(...widths)); widths[widest]--; total--;
  }
  const border = (left, middle, right) => styled(left + widths.map(width => '─'.repeat(width + 2)).join(middle) + right, 'muted', context);
  const lines = [border('┌', '┬', '┐')];
  for (let index = 0; index < cells.length; index++) {
    const wrapped = cells[index].map((cell, column) => wrapRuns(cell, widths[column]));
    const height = Math.max(...wrapped.map(cell => cell.length));
    for (let row = 0; row < height; row++) {
      let line = styled('│ ', 'muted', context);
      for (let column = 0; column < columns; column++) {
        const content = wrapped[column][row] || [];
        line += styleText(content, context) + ' '.repeat(Math.max(0, widths[column] - cellWidth(textOf(content))));
        line += styled(column === columns - 1 ? ' │' : ' │ ', 'muted', context);
      }
      lines.push(line);
    }
    if (!index) lines.push(border('├', '┼', '┤'));
  }
  lines.push(border('└', '┴', '┘'));
  return lines;
}

function blockLines(node, context) {
  if (node.tag === 'p') return textLines(node, context, { size: node.attributes.size || 'normal' });
  if (node.tag === 'h1' || node.tag === 'h2') return textLines(node, context, { bold: true, underline: node.tag === 'h1', size: node.tag === 'h1' ? 'large' : 'normal' });
  if (node.tag === 'blockquote') {
    const width = context.width > 2 ? context.width - 2 : context.width;
    return wrapRuns(inlineRuns(node, { italic: true }), width).map(line => (context.width > 2 ? styled('│ ', 'muted', context) : '') + styleText(line, context));
  }
  if (node.tag === 'hr') return [styled('─'.repeat(context.width), 'muted', context)];
  if (node.tag === 'ul' || node.tag === 'ol') return elements(node).flatMap((item, index) => textLines(item, context, plainStyle, node.tag === 'ol' ? `${index + 1}. ` : '• '));
  if (node.tag === 'pre') {
    if (context.width < 4) return textLines(node, context, { code: true });
    const language = node.attributes.language || 'code';
    const title = wrap(language, Math.max(1, context.width - 3))[0];
    return [styled('╭─ ' + title, 'muted', context),
      ...wrapRuns(inlineRuns(node, { code: true }), context.width - 2).map(line => styled('│ ', 'muted', context) + styleText(line, context)),
      styled('╰' + '─'.repeat(Math.max(1, Math.min(context.width - 1, cellWidth(title) + 2))), 'muted', context)];
  }
  if (node.tag === 'table') return tableLines(node, context);
  return [];
}

/** Render only the validated body tree; terminal SGR is generated locally. */
export function renderMessageContent(parsed, { width = 80, theme = createTerminalTheme(), background } = {}) {
  width = Number.isFinite(width) ? Math.max(1, Math.min(1000, Math.floor(width))) : 80;
  if (!parsed.isFormatted || !parsed.blocks) return { ...parsed, lines: wrap(safeText(parsed.plainText), width) };
  const context = { width, theme, background }, lines = [];
  for (const block of parsed.blocks) {
    if (lines.length) lines.push('');
    lines.push(...blockLines(block, context));
  }
  return { ...parsed, lines };
}

export function renderMessageBody(body, options) { return renderMessageContent(parseMessageBody(body), options); }
