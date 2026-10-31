import { canControlSession } from './session-controls.js';
import { cellWidth, clip } from './terminal-format.js';
import { palette } from './terminal-theme.js';
import { fillSurface } from './terminal-surface.js';
import { namedTerminalSessions } from './session-browser.js';
import { costLabel, deepseekSpendingVisible } from './session-cost-format.js';
import { hostMetricsMeters } from './host-metrics.js';
import { accountStatusLabels } from './account-status.js';
import { workspaceHeader, workspaceNavigation, panelHeading, panelRow, frameJunction, padSurface } from './workspace-header.js';

export function workspaceGeometry(width, height, options = {}) {
  const minimumCenter = Math.min(46, width);
  const compact = options.minimal || options.chromeOnly || height < 22;
  let left = options.hideLeft === true || compact || width < 78 ? 0 : Math.max(20, Math.min(32, options.left || Math.floor(width * .23)));
  let right = !options.chromeOnly && options.hideRight !== true && (options.showRight || !compact && width >= 116 && height >= 26)
    ? Math.max(26, Math.min(54, options.right || Math.floor(width * .25))) : 0;
  if (right && width - right - 1 < minimumCenter) right = 0;
  if (left && right && width - left - right - 2 < minimumCenter) { if (options.showRight) left = 0; else right = 0; }
  if (left && width - left - 1 < minimumCenter) left = 0;
  return { width, height, left, right, center: width - left - right - (left ? 1 : 0) - (right ? 1 : 0), x: left ? left + 1 : 0, y: 1, bodyHeight: Math.max(1, height - 1) };
}
const fit = padSurface;
const sessionTime = value => {
  const date = new Date(value); if (!Number.isFinite(date.getTime())) return '';
  return date.toDateString() === new Date().toDateString() ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
};
// A host meter as exactly `size` cells: LABEL ▬▬▬──── value. Load decides the
// bar color; an unavailable sample keeps an empty track and its dash.
function meterText({ label, value, ratio }, size, theme) {
  const c = theme.color, bar = Math.max(0, size - label.length - value.length - 2);
  const filled = ratio == null ? 0 : Math.round(bar * ratio);
  const tone = ratio == null ? palette.muted : ratio >= 0.85 ? palette.danger : ratio >= 0.6 ? palette.warning : palette.success;
  const text = c(label, palette.muted, true) + ' ' + (bar ? c('▬'.repeat(filled), tone) + c('─'.repeat(bar - filled), palette.border) + ' ' : '') + c(value, palette.text);
  return text + ' '.repeat(Math.max(0, size - cellWidth(text)));
}

export function workspaceChrome(tui, geometry) {
  const { width, height, left, right, bodyHeight, x, y } = geometry, theme = tui.theme, c = theme.color, hits = [], regions = [];
  const chrome = workspaceHeader(tui, width), header = chrome.lines; hits.push(...chrome.hits);
  // Each side panel is a closed box; `rules` marks rows whose border rule meets
  // the shared separator, which then paints the matching junction glyph.
  const sidebar = [], sidebarRules = [];
  if (left) {
    const inner = left - 2;
    const row = (content = '', options = {}) => { sidebar.push(panelRow(content, left, theme, options)); sidebarRules.push(false); };
    const heading = (title, options = {}) => { sidebar.push(panelHeading(title, left, theme, { edge: sidebar.length ? '├' : '╭', ...options })); sidebarRules.push(true); };
    const put = (text = '', tone = palette.text, bold = false, hit) => {
      if (hit) hits.push({ ...hit, row: sidebar.length + y + 1, left: 2, right: left - 1 });
      row(text, { tone, bold });
    };
    // Values align in one column only when the sidebar is wide enough to keep them readable.
    const field = (label, value, tone = palette.text, { size = inner >= 26 ? 10 : 0, tail = '', bold = false } = {}) => {
      const name = ' ' + label + ' '.repeat(Math.max(1, size - label.length - 1)), room = Math.max(1, inner - cellWidth(name) - cellWidth(tail));
      const shown = clip(value, room);
      return c(name, palette.muted) + c(shown, tone, bold) + ' '.repeat(Math.max(0, room - cellWidth(shown))) + c(tail, palette.muted);
    };
    heading('NAVIGATION', { suffix: '⋯' });
    hits.push({ type: 'workspace-toggle', side: 'left', row: y + 1, left: 1, right: left - 4 },
      { type: 'workspace-actions', row: y + 1, left: left - 3, right: left });
    for (const [label, panel] of workspaceNavigation) {
      const selected = tui.panel === panel;
      hits.push({ type: `top-${panel}`, row: sidebar.length + y + 1, left: 1, right: left });
      row(c(` ${selected ? '❯' : ' '} `, palette.accent, true) + c(label, selected ? palette.accent : palette.text, selected), { raw: true, selected });
    }
    heading('MODEL');
    const savedRow = sidebar.length + y + 1;
    const modelDisabled = tui.busy || !canControlSession(tui.ui), saveDisabled = !canControlSession(tui.ui) || tui.modelSelectionRequired;
    // Split button cells must match the model-control and model-save targets below.
    const dropWidth = Math.max(1, inner - 3), drop = ' ' + clip(tui.modelSelectionRequired ? 'Select model' : tui.model, Math.max(1, dropWidth - 3));
    row(fillSurface(drop + ' '.repeat(Math.max(0, dropWidth - cellWidth(drop) - 2)) + ' ▾', dropWidth, theme, palette.elevated, tui.modelSelectionRequired ? palette.warning : palette.text, true, palette.surface)
      + fillSurface(' + ', 3, theme, palette.selection, saveDisabled ? palette.muted : palette.accent, true, palette.surface), { raw: true });
    hits.push({ type: 'model-control', command: '/providers @saved', disabled: modelDisabled, row: savedRow, left: 2, right: left - 4 },
      { type: 'model-save', disabled: saveDisabled, row: savedRow, left: left - 3, right: left - 1 });
    const control = (name, value, tone, hit, bold = false) => {
      hits.push({ ...hit, type: 'model-control', row: sidebar.length + y + 1, left: 2, right: left - 1 });
      row(field(name, value, tone, { tail: ' ▾', bold }), { raw: true });
    };
    control('Provider', tui.provider || 'Select', palette.text, { command: '/providers @provider', disabled: modelDisabled });
    control('Model', tui.model, palette.text, { command: '/models', disabled: modelDisabled }, true);
    control('Effort', (tui.effort || 'default').replace(/^effort /, ''), palette.accent, { command: '/effort', disabled: modelDisabled || tui.modelSelectionRequired });
    const usageRow = sidebar.length + y + 1; heading('USAGE', { suffix: '⇗' });
    hits.push({ type: 'top-metrics', row: usageRow, left: 1, right: left });
    const tokens = tui.tokenLabel(), counted = /^(≥?[\d,]+)( tokens)$/.exec(tokens);
    hits.push({ type: 'top-metrics', row: sidebar.length + y + 1, left: 2, right: left - 1 });
    row(counted ? c(' ' + counted[1], palette.success, true) + c(counted[2], palette.muted) : c(' ' + tokens, palette.muted), { raw: true });
    const usage = tui.compactorUsage;
    const compactor = usage?.available && Number.isSafeInteger(usage.tokens) && usage.tokens >= 0 ? (usage.complete ? '' : '≥') + usage.tokens.toLocaleString() : '—';
    const metric = (name, value, tone, hit) => {
      hits.push({ ...hit, row: sidebar.length + y + 1, left: 2, right: left - 1 });
      row(c(' ' + name + ' ', palette.muted) + c(clip(value, Math.max(1, inner - name.length - 2)), tone), { raw: true });
    };
    metric('Compactor', compactor, palette.agent, { type: 'top-metrics' });
    if (deepseekSpendingVisible(tui)) {
      if (bodyHeight >= 27) metric('Estimate', '≈ ' + costLabel(tui.spending?.total?.estimatedUsd), palette.text, { type: 'top-metrics' });
      const balance = accountStatusLabels(tui.ui.accountStatus).find(item => item.label === 'DeepSeek');
      if (balance && bodyHeight >= 24) metric('Balance', `${balance.value} · provider`, palette.text, { type: 'usage-balance' });
    }
    if (!tui.recentCache || Date.now() - tui.recentCache.at > 2000) tui.recentCache = { at: Date.now(), sessions: namedTerminalSessions() };
    const saved = tui.recentCache.sessions, sessionHeader = sidebar.length + y + 1;
    heading('SESSIONS', { suffix: '+', note: saved.length ? `(${saved.length})` : '' });
    hits.push({ type: 'top-sessions', row: sessionHeader, left: 1, right: left - 4 }, { type: 'session-new', row: sessionHeader, left: left - 4, right: left });
    const footerRows = 3, visible = Math.max(0, bodyHeight - sidebar.length - footerRows - (bodyHeight >= 22 ? 1 : 0));
    tui.sidebarMaximum = Math.max(0, saved.length - visible); tui.sidebarOffset = Math.min(tui.sidebarMaximum, tui.sidebarOffset || 0);
    const regionTop = sidebar.length + y + 1;
    for (const session of saved.slice(tui.sidebarOffset, tui.sidebarOffset + visible)) {
      const selected = session.id === tui.ui.sessionId, stamp = sessionTime(session.updatedAt || session.createdAt), active = session.id === tui.ui.sessionId && tui.busy || ['running', 'waiting_for_input', 'verifying'].includes(session.executionState);
      const name = clip(session.alias, Math.max(1, left - stamp.length - 6)), gap = Math.max(1, inner - cellWidth(name) - stamp.length - 3);
      hits.push({ type: 'saved-session', id: session.id, row: sidebar.length + y + 1, left: 1, right: left });
      row(' ' + c(active ? '●' : '·', active ? palette.success : palette.muted, active) + ' ' + c(name, selected ? palette.accent : active ? palette.success : palette.text, selected)
        + ' '.repeat(gap) + c(stamp, selected ? palette.accent : palette.muted), { raw: true, selected });
    }
    if (!saved.length && visible) put(' Name a chat with /alias', palette.muted);
    while (sidebar.length < bodyHeight - footerRows - 1) put();
    if (sidebar.length < bodyHeight - footerRows) put(` ${saved.length} saved · scroll ⇕`, palette.muted);
    regions.push({ kind: 'sessions', left: 1, right: left, top: regionTop, bottom: bodyHeight - footerRows + y });
    const hostRow = sidebar.length + y + 1;
    heading('HOST USAGE', { suffix: '⇗' });
    hits.push({ type: 'top-metrics', row: hostRow, left: 1, right: left });
    for (const meter of hostMetricsMeters(tui.ui.hostMetrics)) {
      hits.push({ type: 'top-metrics', row: sidebar.length + y + 1, left: 2, right: left - 1 });
      // The last row closes the box, carrying the final meter in its rule.
      if (sidebar.length === bodyHeight - 1) {
        sidebar.push(theme.background(palette.surface) + c('╰─', palette.border) + ' ' + meterText(meter, left - 5, theme) + theme.background(palette.surface) + ' ' + c('─', palette.border));
        sidebarRules.push(true);
      } else row(' ' + meterText(meter, inner - 1, theme), { raw: true });
    }
  }
  for (let i = hits.length - 1; i >= 0; i--) if (hits[i].row > height) hits.splice(i, 1);
  const activity = [], activityRules = [], monitor = tui.monitor;
  if (right) {
    const monitorLeft = width - right + 1;
    const weights = tui.workspaceOptions.weights || [1, 1, 1];
    const kinds = ['agents', 'http', 'code'], collapsedCount = kinds.filter(kind => monitor.collapsed.has(kind)).length;
    const open = kinds.length - collapsedCount, extra = Math.max(0, bodyHeight - kinds.length * 2);
    const sum = kinds.reduce((total, kind, index) => total + (monitor.collapsed.has(kind) ? 0 : weights[index]), 0);
    const heights = kinds.map((kind, index) => 2 + (monitor.collapsed.has(kind) ? 0 : Math.floor(extra * weights[index] / (sum || 1))));
    if (open) heights[kinds.findLastIndex(kind => !monitor.collapsed.has(kind))] += bodyHeight - heights.reduce((a, b) => a + b, 0);
    const push = (line, rule = false) => { activity.push(line); activityRules.push(rule); };
    const bottom = (text = '', tone = palette.muted) => {
      const tail = text ? clip(' ' + text + ' ', right - 4) : '';
      return theme.background(palette.surface) + c('─', palette.border) + c(tail, tone) + c('─'.repeat(Math.max(0, right - cellWidth(tail) - 2)) + '╯', palette.border);
    };
    for (const [index, kind] of kinds.entries()) {
      const size = heights[index], top = activity.length + y + 1, collapsed = monitor.collapsed.has(kind), title = kind === 'agents' ? 'AGENTS / SKILLS' : kind === 'http' ? 'HTTP PROBE' : 'CODE';
      const contentWidth = right - 2, last = index === kinds.length - 1;
      push(panelHeading(title, right, theme, { side: 'right', edge: index ? '┤' : '╮', marker: collapsed ? '▸' : '▾', tone: kind === 'agents' ? palette.agent : palette.accent,
        suffix: '⇗', note: kind === 'http' ? `· ${monitor.requests(tui.traffic).length}` : '' }), true);
      hits.push({ type: 'monitor-toggle', kind, row: top, left: monitorLeft, right: width - 3 }, { type: 'monitor-expand', kind, row: top, left: width - 2, right: width });
      if (collapsed) { if (last) push(bottom(), true); else push(panelRow('', right, theme, { side: 'right' })); continue; }
      const sub = kind === 'agents' ? 'TIME  AGENT / SKILL'
        : kind === 'http' ? `METHOD STATUS · ${monitor.httpFilter || 'all'}`
          : `TIME  COMMAND · ${monitor.commands.size}`;
      push(panelRow(c(' ' + sub, palette.muted, true) + (kind === 'agents' ? '' : c(' ▾', palette.accent, true)), right, theme, { side: 'right', raw: true, fill: palette.elevated }));
      hits.push({ type: 'monitor-menu', kind, row: top + 1, left: monitorLeft, right: width });
      const metadataRows = 0;
      const layout = monitor.rows(kind, contentWidth, tui), rows = Math.max(0, size - 3 - metadataRows);
      const maximum = Math.max(0, layout.lines.length - rows); monitor.maxima[kind] = maximum;
      monitor.offsets[kind] = Math.min(maximum, monitor.offsets[kind]);
      const start = kind !== 'http' ? monitor.offsets[kind] : Math.max(0, layout.lines.length - rows - monitor.offsets[kind]);
      for (let i = 0; i < rows; i++) {
        const thumb = maximum && i === Math.round((rows - 1) * start / maximum);
        push(panelRow(layout.lines[start + i] || '', right, theme, { side: 'right', raw: true, edge: thumb ? '┃' : '│', edgeTone: thumb ? palette.accent : palette.border }));
      }
      for (const hit of layout.hits) if (hit.row >= start && hit.row < start + rows) hits.push({ ...hit, row: top + 2 + metadataRows + hit.row - start, left: monitorLeft + hit.left, right: Math.min(width - 1, monitorLeft + hit.right) });
      const footer = kind !== 'http' ? 'Newest first · scroll ⇕' : monitor.offsets[kind] ? '↓ Latest · scroll ⇕' : 'scroll ⇕';
      const tone = monitor.offsets[kind] ? palette.accent : palette.muted;
      if (last) push(bottom(footer, tone), true);
      else push(panelRow(c(' ' + footer, tone), right, theme, { side: 'right', raw: true }));
      hits.push({ type: 'monitor-latest', kind, row: top + size - 1, left: monitorLeft, right: width - 2 });
      regions.push({ kind, left: monitorLeft, right: width, top: top + 1, bottom: top + size - 1 });
      if (index < 2) regions.push({ kind: 'height', index, left: width - 1, right: width, top: top + size - 1, bottom: top + size - 1 });
    }
  }
  const lines = header, edge = glyph => theme.background(palette.surface) + c(glyph, palette.border);
  for (let row = 0; row < bodyHeight; row++) {
    const up = row > 0, down = row < bodyHeight - 1;
    lines.push((left ? fit(sidebar[row] || '', left, theme, palette.surface) + edge(frameJunction({ left: sidebarRules[row], up, down })) : '')
      + fit(tui.lastFrame[row] || '', geometry.center, theme)
      + (right ? edge(frameJunction({ right: activityRules[row], up, down })) + fit(activity[row] || '', right, theme, palette.surface) : ''));
  }
  if (left) regions.push({ kind: 'width', side: 'left', left: left + 1, right: left + 1, top: y + 1, bottom: height });
  if (right) regions.push({ kind: 'width', side: 'right', left: width - right, right: width - right, top: y + 1, bottom: height });
  return { lines, hits, regions, x };
}
