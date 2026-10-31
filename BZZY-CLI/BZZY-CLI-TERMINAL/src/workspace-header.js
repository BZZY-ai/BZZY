import fs from 'node:fs';
import { cellWidth, clip } from './terminal-format.js';
import { palette } from './terminal-theme.js';
import { fillSurface, sliceCells } from './terminal-surface.js';
import { mascotCells, mascotLine } from './mascot.js';

export const terminalVersion = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
export const workspaceNavigation = [['Chat', 'chat'], ['Agents', 'agents'], ['Skills', 'skills'], ['Workflows', 'workflows'], ['Goals', 'goals'], ['Metrics', 'metrics'], ['Settings', 'settings']];
const eyeSamples = new Map();
const pathText = (value, available) => cellWidth(value) <= available ? value : available < 6 ? clip(value, available)
  : sliceCells(value, 0, 1) + '…' + sliceCells(value, cellWidth(value) - available + 2, cellWidth(value));
export const padSurface = (text, width, theme, surface = palette.background) => {
  const value = sliceCells(text, 0, width);
  return theme.background(surface) + value + theme.background(surface) + theme.foreground(palette.text) + ' '.repeat(Math.max(0, width - cellWidth(value))) + theme.background(palette.background);
};

// Every terminal scene uses this header, including restored chats, setup,
// private transfer screens and small/minimal terminals. Sizing changes which
// controls fit, never which generation of frontend is rendered.
export function workspaceHeader(tui, width, { privateMode = false, controls = '' } = {}) {
  const c = tui.theme.color, hits = [], tiny = width < 56, eyeWidth = width >= 78 && !tui.ui.minimal ? 8 : 0, eyeRows = privateMode ? 2 : 1;
  const eyeKey = eyeWidth + ':' + eyeRows, divider = c(' │ ', palette.border);
  if (eyeWidth && !eyeSamples.has(eyeKey)) eyeSamples.set(eyeKey, mascotCells(0, { columns: eyeWidth, rows: eyeRows, compact: true }));
  const eyes = eyeWidth ? eyeSamples.get(eyeKey).map(cells => mascotLine(cells, tui.theme)) : ['', ''];
  const coreOn = tui.ui.connectionStatus?.core === true, relayOn = coreOn && tui.ui.connectionStatus?.relay === true;
  const dot = online => c('●', online ? palette.success : palette.danger, true);
  const clock = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const status = dot(coreOn) + c(tiny ? 'C ' : width < 100 ? ' Core  ' : ' BZZY Core  ', coreOn ? palette.text : palette.muted)
    + dot(relayOn) + c(tiny ? 'R' : ' Relay', relayOn ? palette.text : palette.muted) + c(' ' + clock, palette.text, !tiny);
  let brand = eyes[0] + c(' BZZY', palette.accent, true) + (tiny ? ' ' : c(` ${terminalVersion} `, palette.muted));
  const tagline = c(' THE LIVING HIVE ', palette.accent);
  if (!privateMode && tui.ui.sessionId && width - cellWidth(brand + tagline + status) >= 72) brand += tagline;
  let line = brand;
  const control = (label, value, hit) => {
    const column = cellWidth(line) + 1, text = c(label, palette.muted) + c(value, palette.text);
    line += text;
    hits.push({ ...hit, row: 1, left: column, right: column + cellWidth(text) - 1 });
  };
  if (!privateMode && tui.ui.sessionId) {
    const available = Math.max(0, width - cellWidth(brand) - cellWidth(status) - 7);
    const dirWidth = Math.floor(available / 2), memoryWidth = available - dirWidth;
    // Both paths come from the saved session binding, including external memory
    // directories. Clipping affects presentation only; clicking copies the path.
    const cwd = tui.ui.sessionWorkingDirectory, memory = tui.ui.sessionProjectLocation?.path;
    if (dirWidth >= 6) {
      line += c('│ ', palette.border);
      control('dir ', pathText(cwd || '—', Math.max(1, dirWidth - 5)), { type: 'working-directory', path: cwd });
    }
    if (memoryWidth >= 8) {
      line += divider;
      control('.bzzy ', pathText(memory || '—', Math.max(1, memoryWidth - 9)), { type: 'session-project-path' });
    }
  }
  const controlLeft = controls ? Math.max(1, width - cellWidth(controls) + 1) : null;
  const tail = controls ? status + ' ' + c(controls, palette.accent, true) : status;
  const top = cellWidth(line) + cellWidth(tail) < width ? line + ' '.repeat(width - cellWidth(line) - cellWidth(tail)) + tail
    : line + ' ' + tail;
  const lines = [padSurface(top, width, tui.theme, palette.surface)];
  if (privateMode) lines.push(padSurface(eyes[1] || '', width, tui.theme, palette.surface));
  return { lines, hits, controlLeft };
}

// Title rule shared by panels, boxes and full-width scenes. The cells are
// head + marker + title + note + " " + rule + tail + end, exactly `width` wide.
function titleRule(title, width, theme, { head, end, marker = '⬡', tone = palette.accent, suffix = '', note = '' }) {
  const c = theme.color, mark = marker ? marker + ' ' : '', tail = suffix ? ' ' + suffix + ' ' : '';
  const fixed = cellWidth(head + mark + tail + end) + 1;
  const name = clip(title, Math.max(1, width - fixed - 1));
  const extra = note ? clip(' ' + note, Math.max(0, width - fixed - cellWidth(name) - 1)) : '';
  const rule = Math.max(0, width - fixed - cellWidth(name + extra));
  return c(head, palette.border) + c(mark, palette.accent, true) + c(name, tone, true) + c(extra, palette.muted)
    + c(' ' + '─'.repeat(rule), palette.border) + c(tail, palette.accent, true) + c(end, palette.border);
}

// A standalone section rule for full-width scenes: ─ ⬡ TITLE ──────── suffix ─
export function sectionHeading(title, width, theme, tone = palette.accent, suffix = '') {
  return titleRule(title, width, theme, { head: '─ ', end: '─', tone, suffix });
}

// The top edge of a closed box: ╭─⬡ TITLE ──────── suffix ╮
export function boxTop(title, width, theme, { tone = palette.accent, suffix = '', marker = '⬡' } = {}) {
  return titleRule(title, width, theme, { head: '╭─', end: '╮', tone, suffix, marker });
}

// Workspace panels are closed boxes whose inner edge is the shared column
// separator. A rule meeting that separator turns it into a junction glyph.
export function frameJunction({ left = false, right = false, up = true, down = true } = {}) {
  const key = (left ? 'l' : '') + (right ? 'r' : '') + (up ? 'u' : '') + (down ? 'd' : '');
  return { lrud: '┼', lud: '┤', rud: '├', lrd: '┬', lru: '┴', ld: '╮', rd: '╭', lu: '╯', ru: '╰', lr: '─', l: '─', r: '─' }[key] || '│';
}

// Panel heading rule. `edge` is the outer border glyph; a left panel's rule
// runs into the separator, a right panel's rule starts from it. A suffix
// button keeps its historical cell three columns from the panel's end.
export function panelHeading(title, width, theme, { edge = '├', side = 'left', marker = '⬡', tone = palette.accent, suffix = '', note = '', surface = palette.surface } = {}) {
  const head = side === 'left' ? edge + '─' : '─', end = side === 'left' ? '─' : edge;
  return theme.background(surface) + titleRule(title, width, theme, { head, end, marker, tone, suffix, note });
}

// One interior panel row; `side` names the panel's own outer border. Content
// keeps the historical cells (2 … width-1) so click targets stay aligned.
export function panelRow(content, width, theme, { side = 'left', edge, edgeTone, selected = false, tone = palette.text, surface = palette.surface, fill, raw = false, bold = false } = {}) {
  const inner = Math.max(1, width - 2), background = selected ? palette.selection : fill || surface;
  const body = raw ? theme.background(background) + sliceCells(content, 0, inner) + theme.background(background) + ' '.repeat(Math.max(0, inner - cellWidth(content)))
    : fillSurface(clip(content, inner), inner, theme, background, selected ? palette.accent : tone, selected || bold, background);
  const border = theme.color(edge ?? (selected ? '┃' : '│'), edgeTone || (selected ? palette.accent : palette.border), selected);
  return side === 'left'
    ? theme.background(surface) + border + body + theme.background(selected ? palette.selection : surface) + ' ' + theme.background(surface)
    : theme.background(surface) + ' ' + body + theme.background(surface) + border;
}
