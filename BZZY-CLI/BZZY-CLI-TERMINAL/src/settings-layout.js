import { cellWidth, clip, wrapProse as wrap } from './terminal-format.js';
import { palette } from './terminal-theme.js';
import { fillSurface } from './terminal-surface.js';

export function settingsActions(rows) {
  return rows.flatMap((row, rowIndex) => row.modelTable
    ? row.modelTable.cells.flatMap((cell, column) => cell.action ? [{ ...cell, rowIndex, column, table: true, navigationRow: `row:${rowIndex}` }] : [])
    : row.action ? [{ ...row, rowIndex, column: 0, table: false, navigationRow: row.inline ? `inline:${row.inline}` : `row:${rowIndex}` }] : []);
}

export function navigateSettings(rows, focus, key, { shift = false, column = 0 } = {}) {
  const actions = settingsActions(rows);
  if (!actions.length) return { focus: 0, column };
  focus = Math.max(0, Math.min(focus, actions.length - 1));
  const current = actions[focus], delta = ['up', 'left'].includes(key) || key === 'tab' && shift ? -1 : 1;
  if (key === 'tab' || !rows.some(row => row.modelTable) || !current.table && ['left', 'right'].includes(key)) {
    const next = (focus + delta + actions.length) % actions.length;
    return { focus: next, column: actions[next].table ? actions[next].column : column };
  }
  if (current.table && ['left', 'right'].includes(key)) {
    const siblings = actions.map((action, index) => ({ ...action, index })).filter(action => action.navigationRow === current.navigationRow);
    const at = siblings.findIndex(action => action.index === focus), next = siblings[Math.max(0, Math.min(siblings.length - 1, at + delta))];
    return { focus: next.index, column: next.column };
  }
  column = current.table ? current.column : column;
  const navigationRows = [...new Set(actions.map(action => action.navigationRow))];
  const nextRow = navigationRows[(navigationRows.indexOf(current.navigationRow) + delta + navigationRows.length) % navigationRows.length];
  const candidates = actions.map((action, index) => ({ ...action, index })).filter(action => action.navigationRow === nextRow);
  const next = candidates.reduce((best, action) => Math.abs(action.column - column) < Math.abs(best.column - column) ? action : best);
  return { focus: next.index, column };
}

export function settingsLayout(settings, width, theme, { spaced = true } = {}) {
  const rows = settings.rows(), actions = settingsActions(rows), lines = [], hits = [];
  settings.focus = Math.max(0, Math.min(settings.focus, actions.length - 1));
  let actionIndex = 0, focusRow = 0;
  const size = Math.max(12, width - 4), margin = '  ';
  const tableWide = width >= 74, payload = size - 9;
  const columns = [Math.min(22, Math.max(12, Math.floor(payload * 0.25))), Math.min(20, Math.max(12, Math.floor(payload * 0.2))), 0, size >= 110 ? 14 : 10];
  columns[2] = payload - columns[0] - columns[1] - columns[3];
  let tableHeader = false;
  const addGap = () => { if (spaced && lines.length && lines.at(-1) !== '') lines.push(''); };
  const addHit = (row, left, right, index) => {
    if (!row.action) return;
    if (index === settings.focus) focusRow = lines.length;
    hits.push({ type: 'settings', action: row.action, row: lines.length, left, right });
  };
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if ((row.modelGroup || row.modelTable) && !tableHeader) {
      if (tableWide) {
        lines.push(margin + ['Role', 'Provider', 'Model', 'Effort'].map((label, at) => theme.color(label.padEnd(columns[at]), palette.muted, true)).join(theme.color(' │ ', palette.border)));
        lines.push(margin + theme.color(columns.map(span => '─'.repeat(span)).join('─┼─'), palette.border));
      }
      tableHeader = true;
    }
    if (row.modelGroup) {
      addGap();
      const group = row.modelGroup, state = group.dirty ? ' · Unsaved changes' : group.configured === false ? ' · Not configured' : '';
      lines.push(margin + theme.color(clip((group.label || row.text) + state, size), group.dirty ? palette.warning : palette.accent, true));
      continue;
    }
    if (row.modelTable) {
      const fields = row.modelTable.cells, label = row.modelTable.label || row.text;
      if (!tableWide) lines.push(margin + theme.color(clip(label, size), palette.text, true));
      const role = clip(label, columns[0]);
      let line = margin + theme.color(role + ' '.repeat(Math.max(0, columns[0] - cellWidth(role))), palette.text), left = 3 + columns[0];
      for (const [at, cell] of fields.entries()) {
        const focused = cell.action && actionIndex === settings.focus;
        const span = tableWide ? columns[at + 1] : size;
        if (tableWide) { line += theme.color(' │ ', palette.border); left += 3; }
        const caption = (tableWide ? '' : ['Provider', 'Model', 'Effort'][at] + ' · ') + cell.text;
        const suffix = cell.action && !/[▾▼]$/.test(caption) ? ' ▾' : '';
        addHit(cell, tableWide ? left : 3, tableWide ? left + span - 1 : size + 2, actionIndex);
        if (cell.action) actionIndex++;
        const rendered = fillSurface(clip(' ' + caption + suffix, span), span, theme, focused ? palette.selection : palette.surface,
          settings.busy || !cell.action ? palette.muted : focused ? palette.accent : palette[cell.tone] || palette.text, Boolean(focused));
        if (tableWide) { line += rendered; left += span; }
        else lines.push(margin + rendered);
      }
      if (tableWide) lines.push(line); else addGap();
      continue;
    }
    if (row.inline) {
      const group = [row];
      while (rows[index + 1]?.inline === row.inline) group.push(rows[++index]);
      const modelPair = group.length === 2 && row.inline.startsWith('agent-');
      const gap = 1, available = size - gap * (group.length - 1);
      const sizes = modelPair ? [Math.floor(available * 0.69), available - Math.floor(available * 0.69)]
        : group.map((_item, at) => Math.floor(available / group.length) + (at < available % group.length ? 1 : 0));
      let line = margin, left = 3;
      for (const [at, item] of group.entries()) {
        const focused = actionIndex === settings.focus, span = sizes[at];
        addHit(item, left, left + span - 1, actionIndex++);
        const value = item.value || item.text;
        line += fillSurface(clip(' ' + (modelPair ? `${at === 0 ? 'Model' : 'Effort'} · ${value}` : value) + ' ', span), span, theme,
          focused ? palette.selection : palette.elevated, settings.busy ? palette.muted : focused ? palette.accent : palette.text, focused);
        if (at < group.length - 1) line += ' ';
        left += span + gap;
      }
      lines.push(line); addGap(); continue;
    }
    const focused = row.action && actionIndex === settings.focus;
    if (row.card) {
      const tone = focused ? palette.accent : palette.border, background = focused ? palette.selection : palette.surface;
      const title = clip(`${row.icon || '◇'}  ${row.text}`, Math.max(1, size - 7));
      const header = '╭─ ' + title + ' ' + '─'.repeat(Math.max(0, size - cellWidth(title) - 7)) + ' ›╮';
      const detail = clip(row.value ? row.detail + ' · ' + row.value : row.detail || '', size - 4);
      for (const [at, text] of [
        header,
        '│ ' + detail + ' '.repeat(Math.max(0, size - cellWidth(detail) - 4)) + ' │',
        '╰' + '─'.repeat(size - 2) + '╯',
      ].entries()) {
        addHit(row, 3, size + 2, actionIndex);
        lines.push(margin + fillSurface(text, size, theme, background, at === 0 ? focused ? palette.accent : palette.text : at === 1 ? palette.muted : tone, at === 0));
      }
      actionIndex++; addGap(); continue;
    }
    if (row.action || row.control) {
      const primary = row.primary || row.action === 'core-save';
      let label = row.value ? row.text + '  ' + row.value : row.text;
      if (row.action === 'back') label = '← Back';
      addHit(row, 3, size + 2, actionIndex);
      if (row.action) actionIndex++;
      lines.push(margin + fillSurface(clip(' ' + (focused && !primary ? '› ' : '') + label, size), size, theme,
        primary ? palette.accent : focused ? palette.selection : palette.surface,
        primary ? palette.background : settings.busy ? palette.muted : focused ? palette.accent : palette.text, primary || focused));
      if (row.detail) for (const line of wrap(row.detail, size - 2)) lines.push(margin + theme.color(' ' + line, palette.muted));
      addGap();
    } else if (row.section) {
      addGap(); lines.push(margin + theme.color(clip(row.text.toUpperCase(), size), palette.muted, true));
    } else if (row.text) {
      for (const line of wrap(row.text, size)) lines.push(margin + theme.color(line, palette[row.tone] || palette.muted));
      addGap();
    } else if (lines.length && lines.at(-1) !== '') lines.push('');
  }
  while (lines.at(-1) === '') lines.pop();
  return { lines, hits, focusRow, focusAction: actions[settings.focus]?.action };
}
