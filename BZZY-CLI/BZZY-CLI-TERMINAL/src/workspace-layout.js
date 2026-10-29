import { canControlSession } from './session-controls.js';
import { clean, cellWidth, clip } from './terminal-format.js';
import { palette } from './terminal-theme.js';
import { fillSurface } from './terminal-surface.js';
import { namedTerminalSessions } from './session-browser.js';
import { costLabel, deepseekSpendingVisible } from './session-cost-format.js';
import { hostMetricsRows } from './host-metrics.js';
import { accountStatusLabels } from './account-status.js';
import { workspaceHeader, workspaceNavigation, sectionHeading, outlinedRow, padSurface } from './workspace-header.js';

export function workspaceGeometry(width, height, options = {}) {
  const minimumCenter = Math.min(46, width);
  const compact = options.minimal || options.chromeOnly || height < 22;
  let left = options.hideLeft === true || compact || width < 78 ? 0 : Math.max(20, Math.min(32, options.left || Math.floor(width * .23)));
  let right = !options.chromeOnly && options.hideRight !== true && (options.showRight || !compact && width >= 116 && height >= 26)
    ? Math.max(26, Math.min(54, options.right || Math.floor(width * .25))) : 0;
  if (right && width - right - 1 < minimumCenter) right = 0;
  if (left && right && width - left - right - 2 < minimumCenter) { if (options.showRight) left = 0; else right = 0; }
  if (left && width - left - 1 < minimumCenter) left = 0;
  return { width, height, left, right, center: width - left - right - (left ? 1 : 0) - (right ? 1 : 0), x: left ? left + 1 : 0, y: 2, bodyHeight: Math.max(1, height - 2) };
}
const fit = padSurface;
const smallTokens = value => Number.isFinite(value) ? Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value) : '—';
const sessionTime = value => {
  const date = new Date(value); if (!Number.isFinite(date.getTime())) return '';
  return date.toDateString() === new Date().toDateString() ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
};
export function workspaceChrome(tui, geometry) {
  const { width, height, left, right, bodyHeight, x } = geometry, theme = tui.theme, c = theme.color, hits = [], regions = [];
  const chrome = workspaceHeader(tui, width), header = chrome.lines; hits.push(...chrome.hits);
  const sidebar = [];
  if (left) {
    const put = (text = '', tone = palette.text, bold = false, hit) => {
      if (hit) hits.push({ ...hit, row: sidebar.length + 3, left: 2, right: left - 1 });
      sidebar.push(outlinedRow(text, left, theme, { tone }));
    };
    sidebar.push(sectionHeading('NAVIGATION', left, theme));
    for (const [label, panel] of workspaceNavigation) {
      const selected = tui.panel === panel;
      const row = sidebar.length + 3;
      sidebar.push(outlinedRow(` ${selected ? '›' : ' '} ${label}`, left, theme, { selected }));
      hits.push({ type: `top-${panel}`, row, left: 1, right: left });
    }
    sidebar.push(sectionHeading('MODEL', left, theme, palette.agent));
    const savedRow = sidebar.length + 3;
    sidebar.push(outlinedRow(' ' + clip(tui.modelSelectionRequired ? 'Select / save model ▾' : tui.model + ' ▾', left - 3), left, theme, { tone: palette.main }));
    hits.push({ type: 'model-control', command: '/providers @saved', disabled: tui.busy || !canControlSession(tui.ui), row: savedRow, left: 2, right: left - 1 });
    const modelDisabled = tui.busy || !canControlSession(tui.ui);
    put(` Provider  ${tui.provider || 'Select'} ▾`, palette.agent, false, { type: 'model-control', command: '/providers @provider', disabled: modelDisabled });
    if (bodyHeight >= 24) put(` Model     ${tui.model} ▾`, palette.main, true, { type: 'model-control', command: '/models', disabled: modelDisabled });
    put(` Effort    ${(tui.effort || 'default').replace(/^effort /, '')} ▾`, palette.agent, false, { type: 'model-control', command: '/effort', disabled: modelDisabled || tui.modelSelectionRequired });
    if (bodyHeight >= 29) {
      const cap = tui.modelCapabilities || {};
      put(` Context   ${cap.contextWindow ? smallTokens(cap.contextWindow) : 'unavailable'}`, palette.muted);
      // Pricing is shown only when the catalog actually supplies a rate.
      const price = cap.pricing || {};
      put(` In / Out  ${price.input != null ? price.input : '—'} / ${price.output != null ? price.output : '—'}`, palette.muted);
    }
    const usageRow = sidebar.length + 3; sidebar.push(sectionHeading('USAGE', left, theme, palette.accent, '↗'));
    hits.push({ type: 'top-metrics', row: usageRow, left: 1, right: left });
    put(` ${tui.tokenLabel()}`, palette.success, true, { type: 'top-metrics' });
    const usage = tui.compactorUsage;
    const compactor = usage?.available && Number.isSafeInteger(usage.tokens) && usage.tokens >= 0 ? (usage.complete ? '' : '≥') + usage.tokens.toLocaleString() : '—';
    put(` Compactor  ${compactor}`, palette.agent, false, { type: 'top-metrics' });
    if (deepseekSpendingVisible(tui)) {
      if (bodyHeight >= 27) put(` Estimate ≈ ${costLabel(tui.spending?.total?.estimatedUsd)}`, palette.muted, false, { type: 'top-metrics' });
      const balance = accountStatusLabels(tui.ui.accountStatus).find(item => item.label === 'DeepSeek');
      if (balance && bodyHeight >= 24) put(` Balance ${balance.value} · provider`, palette.muted, false, { type: 'usage-balance' });
    }
    const sessionHeader = sidebar.length + 3;
    sidebar.push(sectionHeading('SESSIONS', left, theme, palette.accent, '+'));
    hits.push({ type: 'top-sessions', row: sessionHeader, left: 1, right: left - 4 }, { type: 'session-new', row: sessionHeader, left: left - 4, right: left });
    if (!tui.recentCache || Date.now() - tui.recentCache.at > 2000) tui.recentCache = { at: Date.now(), sessions: namedTerminalSessions() };
    const saved = tui.recentCache.sessions, footerRows = 3, visible = Math.max(0, bodyHeight - sidebar.length - footerRows - (bodyHeight >= 22 ? 1 : 0));
    tui.sidebarMaximum = Math.max(0, saved.length - visible); tui.sidebarOffset = Math.min(tui.sidebarMaximum, tui.sidebarOffset || 0);
    const regionTop = sidebar.length + 3;
    for (const session of saved.slice(tui.sidebarOffset, tui.sidebarOffset + visible)) {
      const selected = session.id === tui.ui.sessionId, stamp = sessionTime(session.updatedAt || session.createdAt), active = session.id === tui.ui.sessionId && tui.busy || ['running', 'waiting_for_input', 'verifying'].includes(session.executionState);
      const label = ` ${active ? '●' : '·'} ` + clip(session.alias, Math.max(1, left - stamp.length - 6));
      const row = label + ' '.repeat(Math.max(1, left - cellWidth(label) - stamp.length - 2)) + stamp;
      hits.push({ type: 'saved-session', id: session.id, row: sidebar.length + 3, left: 1, right: left });
      sidebar.push(outlinedRow(row, left, theme, { selected, tone: active ? palette.success : palette.text }));
    }
    if (!saved.length && visible) put(' Name a chat with /alias', palette.muted);
    while (sidebar.length < bodyHeight - footerRows - 1) put();
    if (sidebar.length < bodyHeight - footerRows) put(` ${saved.length} saved · scroll ↕`, palette.muted);
    regions.push({ kind: 'sessions', left: 1, right: left, top: regionTop, bottom: bodyHeight - footerRows + 2 });
    const hostRow = sidebar.length + 3;
    sidebar.push(sectionHeading('HOST USAGE', left, theme, palette.accent, '↗'));
    hits.push({ type: 'top-metrics', row: hostRow, left: 1, right: left });
    for (const row of hostMetricsRows(tui.ui.hostMetrics, left - 2)) put(' ' + row, palette.success, false, { type: 'top-metrics' });
  }
  for (let i = hits.length - 1; i >= 0; i--) if (hits[i].row > height) hits.splice(i, 1);
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
      const size = heights[index], top = activity.length + 3, collapsed = monitor.collapsed.has(kind), title = kind === 'agents' ? 'AGENTS / SKILLS' : kind === 'http' ? 'HTTP PROBE' : 'CODE';
      const contentWidth = right - 2;
      let label = `${collapsed ? '▸' : '▾'} ${title}`;
      if (kind === 'http') label += ` · ${monitor.requests(tui.traffic).length}`;

      const headerText = c(clip(label, right - 4), kind === 'agents' ? palette.agent : palette.tool, true);
      activity.push(sectionHeading(clean(headerText), right, theme, kind === 'agents' ? palette.agent : palette.accent, '↗'));
      hits.push({ type: 'monitor-toggle', kind, row: top, left: monitorLeft, right: width - 3 }, { type: 'monitor-expand', kind, row: top, left: width - 2, right: width });
      if (collapsed) { activity.push(c('└' + '─'.repeat(right - 2) + '┘', palette.border)); continue; }
      let sub = kind === 'agents' ? 'TIME  AGENT / SKILL'
        : kind === 'http' ? `METHOD STATUS · ${monitor.httpFilter || 'all'} ▾`
          : monitor.files.get(monitor.activeFile)?.path || 'Recent files ▾';
      activity.push(outlinedRow(' ' + sub, right, theme, { tone: kind === 'code' ? palette.accent : palette.muted }));
      hits.push({ type: 'monitor-menu', kind, row: top + 1, left: monitorLeft, right: width });
      const file = kind === 'code' && monitor.files.get(monitor.activeFile);
      if (file && size >= 5) activity.push(outlinedRow(' ' + `${tui.actors.for(file.actorSessionId, tui.ui.sessionId).name} · ${file.language || 'source'} · ${file.phase}`, right, theme, { tone: palette.muted }));
      const metadataRows = file && size >= 5 ? 1 : 0;
      const layout = monitor.rows(kind, contentWidth, tui), rows = Math.max(0, size - 3 - metadataRows);
      const maximum = Math.max(0, layout.lines.length - rows); monitor.maxima[kind] = maximum;
      monitor.offsets[kind] = Math.min(maximum, monitor.offsets[kind]);
      const start = kind === 'agents' ? monitor.offsets[kind] : Math.max(0, layout.lines.length - rows - monitor.offsets[kind]);
      for (let i = 0; i < rows; i++) {
        const line = layout.lines[start + i] || '', mark = maximum ? i === Math.round((rows - 1) * start / maximum) ? '┃' : '│' : ' ';
        activity.push(c('│', palette.border) + fit(line, right - 2, theme) + c(mark === ' ' ? '│' : mark, palette.border));
      }
      for (const hit of layout.hits) if (hit.row >= start && hit.row < start + rows) hits.push({ ...hit, row: top + 2 + metadataRows + hit.row - start, left: monitorLeft + hit.left, right: Math.min(width - 1, monitorLeft + hit.right) });
      const footer = kind === 'agents' ? 'Newest first · scroll ↕' : monitor.offsets[kind] ? '↓ Latest · scroll ↕' : kind === 'code' ? `[Follow ${monitor.followCode ? 'ON' : 'OFF'}] · ↓ Latest` : 'Live · scroll ↕';
      const tail = clip(' ' + footer + ' ', right - 4);
      activity.push(c('└─', palette.border) + c(tail, monitor.offsets[kind] ? palette.accent : palette.muted) + c('─'.repeat(Math.max(0, right - cellWidth(tail) - 3)) + '┘', palette.border));
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
