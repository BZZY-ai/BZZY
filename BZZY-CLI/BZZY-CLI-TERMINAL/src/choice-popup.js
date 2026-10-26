import { cellWidth, clip, wrapProse as wrap } from './terminal-format.js';
import { palette } from './terminal-theme.js';
import { fillSurface } from './terminal-surface.js';

export function visibleChoices(picker) {
  const query = (picker.query || '').trim().toLocaleLowerCase();
  return picker.choices.map((choice, index) => ({ choice, index }))
    .filter(({ choice }) => !query || `${choice.label} ${choice.description || ''}`.toLocaleLowerCase().includes(query));
}

export function choicePopup(picker, { width, height, anchor, minimumTop = 0, theme }) {
  const dropdown = ['dropdown', 'context'].includes(picker.presentation), searchable = picker.kind === 'model';
  const desiredWidth = Math.max(36, Number.isFinite(picker.minimumWidth) ? picker.minimumWidth : 0, ...picker.choices.map(choice => cellWidth(choice.label) + 8));
  const size = Math.max(16, Math.min(width - 2, dropdown ? Math.min(62, desiredWidth) : Math.min(76, width - 6)));
  const inner = size - 2, filtered = visibleChoices(picker), found = filtered.findIndex(item => item.index === picker.focus);
  if (found < 0 && filtered.length) picker.focus = filtered[0].index;
  const focused = picker.choices[picker.focus];
  const details = picker.error || picker.warning || focused?.description || picker.description || '';
  const detailLimit = Math.max(1, Math.min(8, picker.detailLimit || 3));
  const detailLines = details ? wrap(details, inner - 4, Math.min(detailLimit, picker.descriptionRows || 2)) : [];
  const maxHeight = Math.max(7, Math.min(dropdown ? 20 : 25, height - (dropdown ? 0 : minimumTop) - 1));
  const reserved = 6 + (searchable ? 2 : 0) + (picker.columnHeader ? 1 : 0) + detailLines.length + (dropdown ? 0 : 2);
  const rows = Math.max(1, Math.min(filtered.length || 1, maxHeight - reserved));
  const position = Math.max(0, filtered.findIndex(item => item.index === picker.focus));
  const offset = Math.max(0, Math.min(position - Math.floor(rows / 2), filtered.length - rows));
  const lines = [], hits = [], edge = text => theme.color(text, palette.border);
  const put = (text = '', tone = palette.text, bold = false, background = palette.surface) => lines.push(edge('│') + fillSurface(clip(text, inner), inner, theme, background, tone, bold) + edge('│'));
  lines.push(edge('╭' + '─'.repeat(inner) + '╮'));
  const locked = picker.locked && picker.loading;
  const close = locked ? '   ' : ' ← Back ', title = ' ' + clip(picker.title, Math.max(1, inner - cellWidth(close) - 2));
  put(title + ' '.repeat(Math.max(0, inner - cellWidth(title) - cellWidth(close))) + close, palette.accent, true);
  if (!locked) hits.push({ type: 'cancel', back: true, row: 1, left: size - cellWidth(close) - 1, right: size - 2 });
  if (searchable) {
    put(' / ' + (picker.query || 'Search models and providers…'), picker.query ? palette.text : palette.muted);
    hits.push({ type: 'picker-search', row: lines.length - 1, left: 2, right: size - 3 });
    lines.push(edge('├' + '─'.repeat(inner) + '┤'));
  } else put();
  if (picker.columnHeader) put('   ' + picker.columnHeader, palette.muted);
  if (picker.loading) put(' ' + (picker.loadingLabel || 'Loading choices…'), palette.accent);
  else if (!filtered.length) put(' No matching models.', palette.muted);
  else for (const { choice, index } of filtered.slice(offset, offset + rows)) {
    const focused = index === picker.focus, selected = picker.single ? choice.selected : picker.selected.has(choice.value);
    let tail = picker.single ? selected ? ' ✓' : '' : selected ? ' [x]' : ' [ ]';
    if (picker.selectEffort && choice.efforts?.length) tail = ` ‹ ${picker.efforts.get(choice.value)} ›`;
    const label = ` ${focused ? '›' : ' '} ${clip(choice.label, inner - cellWidth(tail) - 5)}`;
    const tone = picker.kind === 'approval' && palette[choice.tone];
    put(label + ' '.repeat(Math.max(0, inner - cellWidth(label + tail) - 1)) + tail + ' ', choice.disabled ? palette.muted : tone && focused ? palette.background : tone || (focused ? palette.accent : palette.text), focused, focused ? tone || palette.selection : palette.surface);
    hits.push({ type: 'choice', index, row: lines.length - 1, left: 1, right: size - 2, disabled: choice.disabled });
    if (tail.startsWith(' ‹')) {
      hits.push({ type: 'effort', index, direction: 'left', row: lines.length - 1, left: size - cellWidth(tail) - 1, right: size - cellWidth(tail) + 1 },
        { type: 'effort', index, direction: 'right', row: lines.length - 1, left: size - 4, right: size - 2 });
    }
  }
  lines.push(edge('├' + '─'.repeat(inner) + '┤'));
  for (const line of detailLines) put(' ' + line, picker.error || picker.warning ? palette.warning : palette.muted);
  if (picker.selectEffort && focused?.efforts?.length) put(' Effort: ' + picker.efforts.get(focused.value) + ' · ←/→ changes', palette.accent);
  const count = filtered.length ? `${position + 1}/${filtered.length}` : '';
  put(' ' + clip((dropdown ? 'Click select · ↑↓ · Esc' : picker.hint || (picker.single ? '↑↓ choose · Enter confirm · Esc cancel' : 'Space selects · Enter confirms')) + (count ? '  ' + count : ''), inner - 1), palette.muted);
  if (!dropdown && !locked) {
    const confirm = ` [ ${picker.confirmLabel || 'Confirm'} ] `;
    put(confirm + '  [ ← Back ]', palette.accent, true);
    const cancelLeft = cellWidth(confirm) + 3;
    hits.push({ type: 'confirm', row: lines.length - 1, left: 2, right: cellWidth(confirm) },
      { type: 'cancel', back: true, row: lines.length - 1, left: cancelLeft, right: cancelLeft + 10 });
  }
  lines.push(edge('╰' + '─'.repeat(inner) + '╯'));
  // Keep a dropdown attached to its control, including on small terminals and
  // near the bottom of Settings. Other choices use a centered dialog.
  const left = Math.max(1, Math.min(width - size, dropdown && anchor ? anchor.left - 1 : Math.floor((width - size) / 2)));
  let top = dropdown && anchor ? anchor.row : Math.max(minimumTop, Math.floor((height + minimumTop - lines.length) / 2));
  if (top + lines.length > height - 1) top = dropdown && anchor && anchor.row - lines.length > 0 ? anchor.row - lines.length - 1 : height - lines.length - 1;
  top = Math.max(0, top);
  return { lines: lines.slice(0, height), left, top, width: size, hits: hits.map(hit => ({ ...hit, row: top + hit.row + 1, left: left + hit.left + 1, right: Math.min(width, left + hit.right + 1) })) };
}
