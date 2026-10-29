import fs from 'node:fs';
import { clean, cellWidth, clip } from './terminal-format.js';
import { palette } from './terminal-theme.js';
import { fillSurface, sliceCells } from './terminal-surface.js';
import { mascotCells, mascotLine } from './mascot.js';
import { hostMetricsCompact } from './host-metrics.js';
import { namedTerminalSessions } from './session-browser.js';
import { costLabel, deepseekSpendingVisible } from './session-cost-format.js';
import { accountStatusLabels } from './account-status.js';

const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const navigation = [['Chat', 'chat'], ['Agents', 'agents'], ['Skills', 'skills'], ['Workflows', 'workflows'], ['Goals', 'goals'], ['Metrics', 'metrics'], ['Settings', 'settings']];
export function workspaceGeometry(width, height, options = {}) {
  if (width < 110 || height < 22) return null;
  const left = options.hideLeft ? 0 : Math.max(23, Math.min(36, options.left || 27));
  const right = options.hideRight || width < (left ? 150 : 110) ? 0 : Math.max(28, Math.min(60, options.right || 36, width - left - 54));
  return { width, height, left, right, center: width - left - right - (left ? 1 : 0) - (right ? 1 : 0), x: left ? left + 1 : 0, y: 2, bodyHeight: height - 2 };
}
const fit = (text, width, theme, surface = palette.background) => {
  const clipped = sliceCells(text, 0, width);
  return theme.background(surface) + clipped + ' '.repeat(Math.max(0, width - cellWidth(clipped))) + theme.background(palette.background);
};
const smallTokens = value => Number.isFinite(value) ? Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value) : '—';
const sessionTime = value => {
  const date = new Date(value); if (!Number.isFinite(date.getTime())) return '';
  return date.toDateString() === new Date().toDateString() ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
};
export function workspaceChrome(tui, geometry) {
  const { width, height, left, right, bodyHeight, x } = geometry, theme = tui.theme, c = theme.color, hits = [], regions = [];
  const eyes = mascotCells(0, { columns: 12, rows: 2, compact: true }).map(cells => mascotLine(cells, theme));
  const controls = [[' Nav ', 'left'], [' Live ', 'right']];
  let top = eyes[0] + c(` BZZY ${version} `, palette.accent, true);
  for (const [label, side] of controls) {
    const start = cellWidth(top); top += c(label, palette.accent);
    hits.push({ type: 'workspace-toggle', side, row: 1, left: start + 1, right: start + cellWidth(label) });
  }
  const relayOn = tui.ui.connectionStatus?.core === true && tui.ui.connectionStatus?.relay === true;
  const status = c('●', tui.ui.connectionStatus?.core === true ? palette.success : palette.danger) + c(' BZZY Core  ', palette.muted) + c('●', relayOn ? palette.success : palette.danger) + c(' BZZY Relay', palette.muted) + c('  ' + hostMetricsCompact(tui.ui.hostMetrics), palette.muted);
  top += ' '.repeat(Math.max(1, width - cellWidth(top) - cellWidth(status))) + status;
  const meta = ` ${tui.model} · ${(tui.effort || 'default').replace(/^effort /, '')} · ${tui.tokenLabel()} · ${tui.elapsedClock()}`;
  const second = eyes[1] + c(clip(meta, Math.max(1, width - 12)), palette.muted);
  const header = [fit(top, width, theme), fit(second, width, theme)];
  const sidebar = [];
  if (left) {
    const put = (text = '', tone = palette.text, bold = false, hit) => {
      if (hit) hits.push({ ...hit, row: sidebar.length + 3, left: 2, right: left - 1 });
      sidebar.push(fillSurface(clip(text, left), left, theme, palette.surface, tone, bold));
    };
    put(' NAVIGATION', palette.muted);
    for (const [label, panel] of navigation) {
      const selected = tui.panel === panel;
      const row = sidebar.length + 3;
      sidebar.push(fillSurface(` ${selected ? '▸' : ' '} ${label}`, left, theme, selected ? palette.selection : palette.surface, selected ? palette.accent : palette.text, selected));
      hits.push({ type: `top-${panel}`, row, left: 1, right: left });
    }
    put('─'.repeat(left), palette.border);
    put(' MODEL · configure ▾', palette.agent, true, { type: 'model-control', command: '/providers', disabled: tui.busy || tui.ui.sessionMode === 'VIEW' });
    put(' ◇ Saved combinations ▾', palette.main, true, { type: 'model-control', command: '/providers @saved', disabled: tui.busy || tui.ui.sessionMode === 'VIEW' });
    const modelDisabled = tui.busy || tui.ui.sessionMode === 'VIEW';
    put(` Provider  ${tui.provider || 'Select'} ▾`, palette.agent, false, { type: 'model-control', command: '/providers @provider', disabled: modelDisabled });
    put(` Model     ${tui.model} ▾`, palette.main, true, { type: 'model-control', command: '/models', disabled: modelDisabled });
    put(` Effort    ${(tui.effort || 'default').replace(/^effort /, '')} ▾`, palette.agent, false, { type: 'model-control', command: '/effort', disabled: modelDisabled || tui.modelSelectionRequired });
    if (bodyHeight >= 29) {
      const cap = tui.modelCapabilities || {};
      put(` Context   ${cap.contextWindow ? smallTokens(cap.contextWindow) : 'unavailable'}`, palette.muted);
      // Pricing is shown only when the catalog actually supplies a rate.
      const price = cap.pricing || {};
      put(` In / Out  ${price.input != null ? price.input : '—'} / ${price.output != null ? price.output : '—'}`, palette.muted);
    }
    put('─'.repeat(left), palette.border);
    put(' USAGE · session ↗', palette.accent, true, { type: 'top-metrics' });
    put(` ${tui.tokenLabel()}`, palette.text, true, { type: 'top-metrics' });
    if (deepseekSpendingVisible(tui)) {
      if (bodyHeight >= 27) put(` Estimate ≈ ${costLabel(tui.spending?.total?.estimatedUsd)}`, palette.muted, false, { type: 'top-metrics' });
      const balance = accountStatusLabels(tui.ui.accountStatus).find(item => item.label === 'DeepSeek');
      if (balance && bodyHeight >= 24) put(` Balance ${balance.value} · provider`, palette.muted, false, { type: 'usage-balance' });
    }
    const sessionHeader = sidebar.length + 3;
    put('─'.repeat(left), palette.border);
    put(' SESSIONS' + ' '.repeat(Math.max(0, left - 12)) + ' + ', palette.accent, true, { type: 'top-sessions' });
    hits.push({ type: 'session-new', row: sessionHeader + 1, left: left - 4, right: left });
    if (!tui.recentCache || Date.now() - tui.recentCache.at > 2000) tui.recentCache = { at: Date.now(), sessions: namedTerminalSessions() };
    const saved = tui.recentCache.sessions, visible = Math.max(0, bodyHeight - sidebar.length - 1);
    tui.sidebarMaximum = Math.max(0, saved.length - visible); tui.sidebarOffset = Math.min(tui.sidebarMaximum, tui.sidebarOffset || 0);
    const regionTop = sidebar.length + 3;
    for (const session of saved.slice(tui.sidebarOffset, tui.sidebarOffset + visible)) {
      const selected = session.id === tui.ui.sessionId, stamp = sessionTime(session.updatedAt || session.createdAt), active = session.id === tui.ui.sessionId && tui.busy || ['running', 'waiting_for_input', 'verifying'].includes(session.executionState);
      const label = ` ${active ? '●' : '·'} ` + clip(session.alias, Math.max(1, left - stamp.length - 5));
      const row = label + ' '.repeat(Math.max(1, left - cellWidth(label) - stamp.length - 1)) + stamp;
      hits.push({ type: 'saved-session', id: session.id, row: sidebar.length + 3, left: 1, right: left });
      sidebar.push(fillSurface(row, left, theme, selected ? palette.selection : palette.surface, selected ? palette.accent : active ? palette.success : palette.text, selected));
    }
    if (!saved.length && visible) put(' Name a chat with /alias', palette.muted);
    while (sidebar.length < bodyHeight - 1) put();
    if (sidebar.length < bodyHeight) put(` ${saved.length} saved · scroll ↕`, palette.muted);
    regions.push({ kind: 'sessions', left: 1, right: left, top: regionTop, bottom: height });
  }
  const activity = [], monitor = tui.monitor;
  if (right) {
    const monitorLeft = width - right + 1;
    const weights = tui.workspaceOptions.weights || [1, 1, 1];
    const kinds = ['agents', 'http', 'code'], collapsedCount = kinds.filter(kind => monitor.collapsed.has(kind)).length;
    const open = kinds.length - collapsedCount, extra = Math.max(0, bodyHeight - kinds.length * 2);
    const sum = kinds.reduce((total, kind, index) => total + (monitor.collapsed.has(kind) ? 0 : weights[index]), 0);
    const heights = kinds.map((kind, index) => 2 + (monitor.collapsed.has(kind) ? 0 : Math.floor(extra * weights[index] / (sum || 1))));
    if (open) heights[kinds.findLastIndex(kind => !monitor.collapsed.has(kind))] += bodyHeight - heights.reduce((a, b) => a + b, 0);
    for (const [index, kind] of kinds.entries()) {
      const size = heights[index], top = activity.length + 3, collapsed = monitor.collapsed.has(kind), title = kind === 'agents' ? 'AGENTS' : kind === 'http' ? 'HTTP PROBE' : 'CODE';
      const contentWidth = right - 2;
      let label = `${collapsed ? '▸' : '▾'} ${title}`;
      if (kind === 'http') label += ` · ${monitor.requests(tui.traffic).length}`;
      if (kind === 'agents') label += monitor.agentFilter ? ' · filtered' : ` · ${tui.activeAgentCount()} active`;
      const headerText = c(clip(label, right - 4), kind === 'agents' ? palette.agent : palette.tool, true);
      activity.push(fit(headerText + ' '.repeat(Math.max(0, right - 2 - cellWidth(headerText))) + c('↗ ', palette.accent), right, theme, palette.surface));
      hits.push({ type: 'monitor-toggle', kind, row: top, left: monitorLeft, right: width - 3 }, { type: 'monitor-expand', kind, row: top, left: width - 2, right: width });
      if (collapsed) { activity.push(fit(c('─'.repeat(right), palette.border), right, theme)); continue; }
      let sub = kind === 'agents' ? monitor.agentFilter ? 'All agents · click to reset' : 'Chronological activity · All'
        : kind === 'http' ? `METHOD STATUS · ${monitor.httpFilter || 'all'} ▾`
          : monitor.files.get(monitor.activeFile)?.path || 'Recent files ▾';
      activity.push(fit(c(clip(sub, right - 1), kind === 'code' ? palette.accent : palette.muted), right, theme));
      hits.push({ type: 'monitor-menu', kind, row: top + 1, left: monitorLeft, right: width });
      const file = kind === 'code' && monitor.files.get(monitor.activeFile);
      if (file && size >= 5) activity.push(fit(c(clip(`${tui.actors.for(file.actorSessionId, tui.ui.sessionId).name} · ${file.language || 'source'} · ${file.phase}`, right), palette.muted), right, theme));
      const metadataRows = file && size >= 5 ? 1 : 0;
      const layout = monitor.rows(kind, contentWidth, tui), rows = Math.max(0, size - 3 - metadataRows);
      const maximum = Math.max(0, layout.lines.length - rows); monitor.maxima[kind] = maximum;
      monitor.offsets[kind] = Math.min(maximum, monitor.offsets[kind]);
      const start = Math.max(0, layout.lines.length - rows - monitor.offsets[kind]);
      for (let i = 0; i < rows; i++) {
        const line = layout.lines[start + i] || '', mark = maximum ? i === Math.round((rows - 1) * start / maximum) ? '┃' : '│' : ' ';
        activity.push(fit(line, right - 1, theme) + c(mark, palette.border));
      }
      for (const hit of layout.hits) if (hit.row >= start && hit.row < start + rows) hits.push({ ...hit, row: top + 2 + metadataRows + hit.row - start, left: monitorLeft + hit.left - 1, right: Math.min(width, monitorLeft + hit.right - 1) });
      const footer = monitor.offsets[kind] ? '↓ Latest · scroll ↕' : kind === 'code' ? `[Follow ${monitor.followCode ? 'ON' : 'OFF'}] · ↓ Latest` : 'Live · scroll ↕';
      activity.push(fit(c(clip(footer, right - 1), monitor.offsets[kind] ? palette.accent : palette.muted), right, theme));
      hits.push({ type: 'monitor-latest', kind, row: top + size - 1, left: monitorLeft, right: width - 2 });
      if (kind === 'code') hits.push({ type: 'monitor-follow', kind, row: top + size - 1, left: monitorLeft, right: monitorLeft + 11 });
      regions.push({ kind, left: monitorLeft, right: width, top: top + 1, bottom: top + size - 1 });
      if (index < 2) regions.push({ kind: 'height', index, left: width - 1, right: width, top: top + size - 1, bottom: top + size - 1 });
    }
  }
  const lines = header;
  for (let row = 0; row < bodyHeight; row++) lines.push((left ? fit(sidebar[row] || '', left, theme, palette.surface) + c('│', palette.border) : '')
    + fit(tui.lastFrame[row] || '', geometry.center, theme) + (right ? c('│', palette.border) + fit(activity[row] || '', right, theme) : ''));
  if (left) regions.push({ kind: 'width', side: 'left', left: left + 1, right: left + 1, top: 3, bottom: height });
  if (right) regions.push({ kind: 'width', side: 'right', left: width - right, right: width - right, top: 3, bottom: height });
  return { lines, hits, regions, x };
}
