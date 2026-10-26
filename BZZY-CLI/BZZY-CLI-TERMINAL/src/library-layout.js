import { clean, cellWidth, clip, wrap } from './terminal-format.js';
import { palette } from './terminal-theme.js';
import { fillSurface } from './terminal-surface.js';

export function libraryActions(rows) {
  return rows.flatMap(row => row.segments ? row.segments.filter(segment => segment.action && !segment.disabled).map(segment => segment.action)
    : row.action && !row.disabled ? [row.action] : []);
}

// Shared terminal presentation; actions and revision/context pins stay owned by
// each existing menu. Only painted button cells are clickable, including wraps.
export function libraryLayout(rows, width, theme, { panel, focus = 0 } = {}) {
  const lines = [], hits = [], usable = Math.max(1, width - 4);
  let actionIndex = 0, focusRow = 0;
  const gap = () => { if (lines.length && clean(lines.at(-1)).trim()) lines.push(''); };
  const paintButton = (row, column, target) => {
    const selected = !row.disabled && actionIndex++ === focus;
    const icon = row.buttonIcon ? row.buttonIcon + ' ' : '';
    const text = `[ ${clip(icon + (row.buttonLabel || row.text), Math.max(1, usable - 4))} ]`;
    const size = cellWidth(text);
    if (column && column + 4 + size > width - 2) { lines.push(target.line); target.line = ''; column = 0; }
    if (!column) { target.line = '  '; column = 2; } else { target.line += '    '; column += 4; }
    if (selected) focusRow = lines.length;
    if (!row.disabled) hits.push({ type: panel + '-action', action: row.action, row: lines.length, left: column + 1, right: column + size });
    target.line += fillSurface(text, size, theme, selected ? palette.accent : palette.elevated,
      row.disabled ? palette.muted : selected ? palette.background : palette.accent, true);
    return column + size;
  };
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (!row.text && !row.action && !row.segments) { gap(); continue; }
    if (row.buttonGroup) {
      gap(); let column = 0; const target = { line: '' };
      const group = row.buttonGroup;
      do { column = paintButton(rows[index], column, target); index++; } while (index < rows.length && rows[index].buttonGroup === group);
      index--; if (target.line) lines.push(target.line); gap(); continue;
    }
    if (row.segments) {
      let column = 0, rendered = '';
      for (const segment of row.segments) {
        const selected = segment.action && !segment.disabled && actionIndex++ === focus;
        const text = clip(segment.text, Math.max(0, width - column)), size = cellWidth(text);
        if (selected) focusRow = lines.length;
        if (segment.action && !segment.disabled && size) hits.push({ type: panel + '-action', action: segment.action,
          row: lines.length, left: column + 1, right: column + size });
        rendered += selected ? fillSurface(text, size, theme, palette.selection, palette.accent, true)
          : theme.color(text, palette[segment.tone] || palette.text, segment.tone === 'accent');
        column += size;
      }
      lines.push(rendered); continue;
    }
    const selected = row.action && !row.disabled && actionIndex++ === focus;
    if (row.tone === 'accent' && !row.action && row.text) gap();
    if (selected) focusRow = lines.length;
    const wrapped = wrap((selected ? '› ' : '  ') + row.text, usable);
    for (const line of wrapped) {
      if (row.action && !row.disabled) hits.push({ type: panel + '-action', action: row.action, row: lines.length, left: 3, right: width - 2 });
      const tone = row.disabled ? palette.muted : palette[row.tone] || palette.text;
      lines.push('  ' + (selected ? fillSurface(line, usable, theme, palette.selection, palette.accent, true) : theme.color(line, tone, row.tone === 'accent')));
    }
  }
  return { lines, hits, focusRow };
}
