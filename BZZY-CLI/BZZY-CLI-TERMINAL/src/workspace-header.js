import fs from 'node:fs';
import { cellWidth, clip } from './terminal-format.js';
import { palette } from './terminal-theme.js';
import { fillSurface, sliceCells } from './terminal-surface.js';
import { mascotCells, mascotLine } from './mascot.js';
import { hostMetricsCompact } from './host-metrics.js';
import { canControlSession } from './session-controls.js';

export const terminalVersion = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
export const workspaceNavigation = [['Chat', 'chat'], ['Agents', 'agents'], ['Skills', 'skills'], ['Workflows', 'workflows'], ['Goals', 'goals'], ['Metrics', 'metrics'], ['Settings', 'settings']];
const eyeSamples = new Map();
export const padSurface = (text, width, theme, surface = palette.background) => {
  const value = sliceCells(text, 0, width);
  return theme.background(surface) + value + ' '.repeat(Math.max(0, width - cellWidth(value))) + theme.background(palette.background);
};

// Every terminal scene uses this header, including restored chats, setup,
// private transfer screens and small/minimal terminals. Sizing changes which
// controls fit, never which generation of frontend is rendered.
export function workspaceHeader(tui, width, { privateMode = false, controls = '' } = {}) {
  const c = tui.theme.color, hits = [], tiny = width < 56, eyeWidth = width >= 78 && !tui.ui.minimal ? 8 : 0;
  if (eyeWidth && !eyeSamples.has(eyeWidth)) eyeSamples.set(eyeWidth, mascotCells(0, { columns: eyeWidth, rows: 2, compact: true }));
  const eyes = eyeWidth ? eyeSamples.get(eyeWidth).map(cells => mascotLine(cells, tui.theme)) : ['', ''];
  const coreOn = tui.ui.connectionStatus?.core === true, relayOn = coreOn && tui.ui.connectionStatus?.relay === true;
  const dot = online => c('●', online ? palette.success : palette.danger, true);
  const status = dot(coreOn) + c(tiny ? 'C ' : width < 100 ? ' Core  ' : ' BZZY Core  ', palette.muted)
    + dot(relayOn) + c(tiny ? 'R' : ' Relay', palette.muted);
  const brand = eyes[0] + c(tiny ? ' BZZY ' : ` BZZY ${terminalVersion} `, palette.accent, true);
  let line = brand;
  const control = (label, hit, tone = palette.accent) => {
    const column = cellWidth(line) + 1;
    line += c(label, tone, true);
    hits.push({ ...hit, row: 1, left: column, right: column + cellWidth(label) - 1 });
  };
  if (!privateMode && !tui.hidden && !tui.promptDraft) {
    control(tiny ? ' ≡ ' : ' Nav ▾ ', { type: 'workspace-toggle', side: 'left' });
    if (cellWidth(line) + cellWidth(status) + 10 < width) control(tiny ? ' Chats ' : ' Sessions ▾ ', { type: 'top-sessions' });
    if (cellWidth(line) + cellWidth(status) + 7 < width) control(' Live ↗ ', { type: 'workspace-toggle', side: 'right' }, palette.tool);
  }
  const controlLeft = controls ? Math.max(1, width - cellWidth(controls) + 1) : null;
  const tail = controls ? status + ' ' + c(controls, palette.accent, true) : status;
  const top = cellWidth(line) + cellWidth(tail) < width ? line + ' '.repeat(width - cellWidth(line) - cellWidth(tail)) + tail
    : line + ' ' + tail;
  const metrics = hostMetricsCompact(tui.ui.hostMetrics).replace(/\sGB/g, 'G');
  const usage = width < 56 && Number.isFinite(tui.tokens) ? Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(tui.tokens) + ' tok' : tui.tokenLabel(), effort = (tui.effort || 'default').replace(/^effort /, '');
  const metricText = width >= 68 ? metrics : width >= 40 ? metrics.replace('CPU ', 'CPU').replace(/ · RAM .*/, ' RAM' + (tui.ui.hostMetrics?.host?.memory?.totalBytes > 0 ? Math.round(100 * tui.ui.hostMetrics.host.memory.usedBytes / tui.ui.hostMetrics.host.memory.totalBytes) + '%' : '—')) : '';
  const tailMeta = [usage, ...(width >= 100 ? [tui.elapsedClock()] : []), metricText].filter(Boolean).join(' · ');
  const maximumModel = Math.max(6, width - eyeWidth - cellWidth(tailMeta) - 6);
  const model = clip((tui.model || 'Select model') + (width >= 68 ? ' · effort ' + effort : ''), maximumModel);
  const modelText = ' ' + model + ' ▾';
  const second = eyes[1] + c(modelText, palette.main, true) + ' '.repeat(Math.max(1, width - eyeWidth - cellWidth(modelText) - cellWidth(tailMeta))) + c(tailMeta, palette.muted);
  if (!privateMode && !tui.hidden && !tui.promptDraft) hits.push({ type: 'model-control', command: '/providers @saved', disabled: tui.busy || !canControlSession(tui.ui), row: 2, left: eyeWidth + 2, right: Math.min(width, eyeWidth + cellWidth(modelText)) });
  if (!privateMode && !tui.hidden && !tui.promptDraft && model.includes('effort ')) {
    const start = model.indexOf('effort ');
    hits.push({ type: 'model-control', command: '/effort', disabled: tui.busy || !canControlSession(tui.ui) || tui.modelSelectionRequired, row: 2, left: eyeWidth + 2 + start, right: Math.min(width, eyeWidth + cellWidth(modelText)) });
  }
  return { lines: [padSurface(top, width, tui.theme), padSurface(second, width, tui.theme)], hits, controlLeft };
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
