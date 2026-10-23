import { cellWidth, clip, wrapProse as wrap } from './terminal-format.js';
import { palette } from './terminal-theme.js';
import { fillSurface } from './terminal-surface.js';

export function settingsLayout(settings, width, theme) {
  const rows = settings.rows(), actions = rows.filter(row => row.action), lines = [], hits = [];
  settings.focus = Math.max(0, Math.min(settings.focus, actions.length - 1));
  let actionIndex = 0, focusRow = 0;
  const size = Math.max(12, width - 4), margin = '  ';
  const addHit = (row, left, right, index) => {
    if (!row.action) return;
    if (index === settings.focus) focusRow = lines.length;
    hits.push({ type: 'settings', action: row.action, row: lines.length, left, right });
  };
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
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
        line += fillSurface(clip(' ' + (modelPair && at === 1 ? '⚙ ' : '') + value + ' ', span), span, theme,
          focused ? palette.selection : palette.elevated, settings.busy ? palette.muted : focused ? palette.accent : palette.text, focused);
        if (at < group.length - 1) line += ' ';
        left += span + gap;
      }
      lines.push(line); continue;
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
      actionIndex++; continue;
    }
    if (row.action || row.control) {
      const primary = row.primary || row.action === 'core-save';
      let label = row.value ? row.text + '  ' + row.value : row.text;
      if (row.action === 'back') label = '‹ Back';
      addHit(row, 3, size + 2, actionIndex);
      if (row.action) actionIndex++;
      lines.push(margin + fillSurface(clip(' ' + (focused && !primary ? '› ' : '') + label, size), size, theme,
        primary ? palette.accent : focused ? palette.selection : palette.surface,
        primary ? palette.background : settings.busy ? palette.muted : focused ? palette.accent : palette.text, primary || focused));
      if (row.detail) for (const line of wrap(row.detail, size - 2)) lines.push(margin + theme.color(' ' + line, palette.muted));
    } else if (row.section) {
      lines.push(''); lines.push(margin + theme.color(clip(row.text.toUpperCase(), size), palette.muted, true));
    } else if (row.text) {
      for (const line of wrap(row.text, size)) lines.push(margin + theme.color(line, palette[row.tone] || palette.muted));
    } else if (lines.length && lines.at(-1) !== '') lines.push('');
  }
  return { lines, hits, focusRow };
}
