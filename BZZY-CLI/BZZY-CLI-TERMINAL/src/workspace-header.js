import fs from 'node:fs';
import { cellWidth, clip } from './terminal-format.js';
import { palette } from './terminal-theme.js';
import { fillSurface, sliceCells } from './terminal-surface.js';
import { mascotCells, mascotLine } from './mascot.js';

export const terminalVersion = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
export const workspaceNavigation = [['Chat', 'chat'], ['Agents', 'agents'], ['Skills', 'skills'], ['Workflows', 'workflows'], ['Goals', 'goals'], ['Metrics', 'metrics'], ['Settings', 'settings']];
const eyeSamples = new Map();
const pathLabel = (label, path, width) => {
  const prefix = ' ' + label + ' ', value = path || '—', available = Math.max(1, width - cellWidth(prefix));
  const text = cellWidth(value) <= available ? value : available < 6 ? clip(value, available)
    : sliceCells(value, 0, 1) + '…' + sliceCells(value, cellWidth(value) - available + 2, cellWidth(value));
  return clip(prefix + text, width);
};
export const padSurface = (text, width, theme, surface = palette.background) => {
  const value = sliceCells(text, 0, width);
  return theme.background(surface) + value + theme.background(surface) + theme.foreground(palette.text) + ' '.repeat(Math.max(0, width - cellWidth(value))) + theme.background(palette.background);
};

// Every terminal scene uses this header, including restored chats, setup,
// private transfer screens and small/minimal terminals. Sizing changes which
// controls fit, never which generation of frontend is rendered.
export function workspaceHeader(tui, width, { privateMode = false, controls = '' } = {}) {
  const c = tui.theme.color, hits = [], tiny = width < 56, eyeWidth = width >= 78 && !tui.ui.minimal ? 8 : 0, eyeRows = privateMode ? 2 : 1;
  const eyeKey = eyeWidth + ':' + eyeRows;
  if (eyeWidth && !eyeSamples.has(eyeKey)) eyeSamples.set(eyeKey, mascotCells(0, { columns: eyeWidth, rows: eyeRows, compact: true }));
  const eyes = eyeWidth ? eyeSamples.get(eyeKey).map(cells => mascotLine(cells, tui.theme)) : ['', ''];
  const coreOn = tui.ui.connectionStatus?.core === true, relayOn = coreOn && tui.ui.connectionStatus?.relay === true;
  const dot = online => c('●', online ? palette.success : palette.danger, true);
  const status = dot(coreOn) + c(tiny ? 'C ' : width < 100 ? ' Core  ' : ' BZZY Core  ', palette.muted)
    + dot(relayOn) + c(tiny ? 'R' : ' Relay', palette.muted);
  const brand = eyes[0] + c(tiny ? ' BZZY ' : ` BZZY ${terminalVersion} `, palette.accent, true);
  let line = brand;
  const control = (label, hit, tone = palette.muted) => {
    const column = cellWidth(line) + 1;
    line += c(label, tone);
    hits.push({ ...hit, row: 1, left: column, right: column + cellWidth(label) - 1 });
  };
  if (!privateMode && tui.ui.sessionId) {
    const available = Math.max(0, width - cellWidth(brand) - cellWidth(status) - 4);
    const dirWidth = Math.floor(available / 2), memoryWidth = available - dirWidth;
    // Both paths come from the saved session binding, including external memory
    // directories. Clipping affects presentation only; clicking copies the path.
    const cwd = tui.ui.sessionWorkingDirectory, memory = tui.ui.sessionProjectLocation?.path;
    if (dirWidth >= 6) control(pathLabel('dir', cwd, dirWidth), { type: 'working-directory', path: cwd });
    if (memoryWidth >= 8) {
      line += c(' │', palette.border);
      control(pathLabel('.bzzy', memory, memoryWidth), { type: 'session-project-path' });
    }
  }
  const controlLeft = controls ? Math.max(1, width - cellWidth(controls) + 1) : null;
  const tail = controls ? status + ' ' + c(controls, palette.accent, true) : status;
  const top = cellWidth(line) + cellWidth(tail) < width ? line + ' '.repeat(width - cellWidth(line) - cellWidth(tail)) + tail
    : line + ' ' + tail;
  const lines = [padSurface(top, width, tui.theme)];
  if (privateMode) lines.push(padSurface(eyes[1] || '', width, tui.theme));
  return { lines, hits, controlLeft };
}

export function sectionHeading(title, width, theme, tone = palette.accent, suffix = '') {
  const tail = suffix ? ' ' + suffix + ' ' : '';
  const label = clip('─ ' + title + ' ', Math.max(0, width - cellWidth(tail) - 2));
  return theme.color('┌' + label + '─'.repeat(Math.max(0, width - cellWidth(label) - cellWidth(tail) - 2)) + tail + '┐', tone);
}
export function outlinedRow(label, width, theme, { selected = false, tone = palette.text } = {}) {
  return theme.color('│', selected ? palette.accent : palette.border)
    + fillSurface(clip(label, Math.max(1, width - 2)), Math.max(1, width - 2), theme, selected ? palette.selection : palette.surface, selected ? palette.accent : tone, selected)
    + theme.color('│', selected ? palette.accent : palette.border);
}
