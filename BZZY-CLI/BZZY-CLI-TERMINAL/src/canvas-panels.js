import { renderCanvas, canvasStatus } from './canvas-view.js';
import { palette } from './terminal-theme.js';
import { clip, clean, cellWidth, wrap } from './terminal-format.js';
import { fillSurface, replaceCells, sliceCells } from './terminal-surface.js';
import { settingsLayout } from './settings-layout.js';

function window(tui, lines, rect, title) {
  const { left, top, width, height } = rect, theme = tui.theme, color = theme.color;
  const put = (x, y, text) => { if (y >= 0 && y < lines.length) lines[y] = replaceCells(lines[y] || '', x, sliceCells(text, 0, width - (x - left)), (tui.output.columns || 80) - 1, theme, palette.background); };
  for (let row = 0; row < height; row++) put(left, top + row, fillSurface('│' + ' '.repeat(Math.max(0, width - 2)) + '│', width, theme, palette.surface, palette.border));
  put(left, top, fillSurface('╭' + '─'.repeat(width - 2) + '╮', width, theme, palette.elevated, palette.border));
  put(left + 2, top, fillSurface(' ' + clip(title, width - 16) + ' ', Math.max(1, width - 13), theme, palette.elevated, palette.text, true));
  put(left + width - 10, top, fillSurface(' Close × ', 9, theme, palette.elevated, palette.accent));
  put(left, top + height - 1, fillSurface('╰' + '─'.repeat(width - 2) + '╯', width, theme, palette.surface, palette.border));
  tui.hitTargets = [{ type: 'canvas-close', row: top + 1, left: left + width - 9, right: left + width - 1 }];
  tui.canvasOverlay = { ...rect, right: left + width, bottom: top + height };
  return put;
}

function prompt(tui, lines, width, height, minimumTop) {
  const theme = tui.theme, size = Math.max(14, Math.min(70, width - 4));
  const question = clean(tui.question || 'Enter a value').replace(/\s*· Esc cancels$/, '');
  const questionLines = wrap(question, size - 6, 3, true);
  const rows = Math.min(height - minimumTop - 1, Math.max(7, questionLines.length + 6));
  const rect = { left: Math.max(0, Math.floor((width - size) / 2)), top: Math.max(minimumTop, Math.floor((height - rows) / 2)), width: size, height: rows };
  const title = /goal/i.test(question) ? 'Set goal' : /name/i.test(question) ? 'Chat name' : tui.hidden ? 'Private input' : 'Input';
  const put = window(tui, lines, rect, title), x = rect.left + 2;
  questionLines.slice(0, Math.max(1, rows - 5)).forEach((line, i) => put(x, rect.top + (rows < 8 ? 1 : 2) + i, theme.color(clip(line, size - 4), palette.text)));
  const inputRow = rect.top + rows - 4, inputWidth = size - 6;
  const before = tui.hidden ? '•'.repeat(tui.cursor) : [...tui.value].slice(0, tui.cursor).join('').replaceAll('\n', ' ↵ ');
  const value = tui.hidden ? '•'.repeat([...tui.value].length) : clean(tui.value).replaceAll('\n', ' ↵ ');
  const offset = Math.max(0, cellWidth(before) - inputWidth + 1);
  put(x, inputRow, fillSurface('› ' + sliceCells(value || 'Type here…', offset, offset + inputWidth), size - 4, theme, palette.elevated, value ? palette.text : palette.muted));
  const buttonWidth = size < 34 ? 7 : 14, buttonLeft = rect.left + size - buttonWidth - 3;
  put(x, rect.top + rows - 2, theme.color(size < 34 ? ' Esc ' : ' Esc cancel ', palette.muted));
  put(buttonLeft, rect.top + rows - 2, fillSurface(size < 34 ? ' OK ↵ ' : ' Confirm ↵ ', buttonWidth, theme, palette.selection, palette.accent, true));
  tui.hitTargets.push({ type: 'cancel', row: rect.top + rows - 1, left: x + 1, right: Math.min(buttonLeft, x + 12) },
    { type: 'confirm', row: rect.top + rows - 1, left: buttonLeft + 1, right: buttonLeft + buttonWidth });
  tui.composerLeft = x; tui.composerRow = inputRow + 1; tui.composerOffset = offset;
  tui.textRegion = null; tui.scrollbar = null;
}

function goalInput(tui, lines, width) {
  const theme = tui.theme, row = tui.canvasGoalRow - 1, start = width < 40 ? 1 : 7;
  const button = width < 40 ? ' Go ↵ ' : ' Start goal ↵ ', buttonLeft = width - button.length - 1;
  const inputWidth = Math.max(1, buttonLeft - start - 3);
  const before = [...tui.value].slice(0, tui.cursor).join('').replaceAll('\n', ' ↵ '), value = clean(tui.value).replaceAll('\n', ' ↵ ');
  const offset = Math.max(0, cellWidth(before) - inputWidth + 1);
  let line = theme.color(width < 40 ? ' ' : ' Goal  ', palette.accent, true);
  line = replaceCells(line, start, fillSurface('› ' + sliceCells(value || 'What should this BZZY achieve?', offset, offset + inputWidth), inputWidth + 2, theme, palette.elevated, value ? palette.text : palette.muted), width, theme, palette.background);
  lines[row] = replaceCells(line, buttonLeft, fillSurface(button, button.length, theme, palette.selection, palette.accent, true), width, theme, palette.background);
  tui.hitTargets = [{ type: 'confirm', row: row + 1, left: buttonLeft + 1, right: buttonLeft + button.length }];
  tui.canvasOverlay = { left: 0, top: row, width, height: 1, right: width, bottom: row + 1 };
  tui.composerLeft = start; tui.composerRow = row + 1; tui.composerOffset = offset;
  tui.textRegion = null; tui.scrollbar = null;
}

function settings(tui, lines, width, height, minimumTop) {
  const settings = tui.ui.settings, theme = tui.theme, size = Math.max(14, Math.min(78, width - 4));
  const layout = settingsLayout(settings, size - 2, theme);
  const subtitle = wrap(settings.pageSubtitle || '', size - 6, 2, true);
  const messages = settings.message ? wrap(settings.message, size - 6, 2, true) : [];
  const rows = Math.max(6, Math.min(height - minimumTop - 1, layout.lines.length + subtitle.length + messages.length + 5));
  const rect = { left: Math.max(0, Math.floor((width - size) / 2)), top: minimumTop, width: size, height: rows };
  const put = window(tui, lines, rect, settings.pageTitle || 'Settings');
  subtitle.forEach((line, i) => put(rect.left + 3, rect.top + 1 + i, theme.color(line, palette.muted)));
  const first = rect.top + 1 + subtitle.length, bodyHeight = Math.max(1, rows - subtitle.length - messages.length - 4);
  tui.settingsMaximum = Math.max(0, layout.lines.length - bodyHeight);
  tui.settingsOffset = Math.max(0, Math.min(tui.settingsOffset || 0, tui.settingsMaximum));
  if (tui.settingsEnsureFocus) {
    if (layout.focusRow < tui.settingsOffset) tui.settingsOffset = layout.focusRow;
    if (layout.focusRow >= tui.settingsOffset + bodyHeight) tui.settingsOffset = layout.focusRow - bodyHeight + 1;
    tui.settingsEnsureFocus = false;
  }
  layout.lines.slice(tui.settingsOffset, tui.settingsOffset + bodyHeight).forEach((line, i) => put(rect.left + 1, first + i, line));
  for (const hit of layout.hits) if (hit.row >= tui.settingsOffset && hit.row < tui.settingsOffset + bodyHeight) tui.hitTargets.push({ ...hit, row: first + hit.row - tui.settingsOffset + 1, left: hit.left + rect.left + 1, right: Math.min(rect.left + size - 1, hit.right + rect.left + 1) });
  messages.forEach((line, i) => put(rect.left + 3, rect.top + rows - messages.length - 3 + i, theme.color(line, settings.warning ? palette.warning : palette.accent)));
  const back = settings.page !== 'main' ? '‹ Back' : '‹ Canvas';
  put(rect.left + 3, rect.top + rows - 2, theme.color(clip(back + '   ·   ↑/↓ choose · Enter open', size - 6), palette.muted));
  tui.hitTargets.push({ type: 'settings-back', row: rect.top + rows - 1, left: rect.left + 3, right: rect.left + 12 });
  tui.textRegion = null; tui.scrollbar = null;
}

function conversation(tui, lines, rect) {
  const theme = tui.theme, view = tui.ui.canvasView;
  const node = view.canvas?.nodes.find(node => node.id === view.focus), binding = view.bindings?.get(view.focus);
  const title = view.historyThread ? 'Work history · read-only' : 'Conversation · ' + (binding?.selection?.model || node?.selection?.model || tui.model || 'BZZY');
  const put = window(tui, lines, rect, title), x = rect.left + 1, size = rect.width - 2;
  let column = x + 1;
  for (const [label, panel] of [['Chat', 'chat'], ['Activity', 'activity'], ['HTTP', 'http'], ['Skills', 'skills']]) {
    const text = ` ${label} `; if (column + text.length > rect.left + rect.width - 2) break;
    put(column, rect.top + 1, theme.color(text, tui.panel === panel ? palette.accent : palette.muted, tui.panel === panel));
    tui.hitTargets.push({ type: 'canvas-pane', panel, row: rect.top + 2, left: column + 1, right: column + text.length }); column += text.length + 1;
  }
  const control = view.snapshots?.get(binding?.controlId || binding?.sessionId)?.session;
  const roles = control?.mode === 'delegate' && control.executor ? [
    ['BRAIN', control.resolvedModel || control.model, control.selectedEffort], ['HANDS', control.executor.model, control.executor.effort],
  ] : [];
  roles.forEach(([role, model, effort], index) => {
    const suffix = ' · ' + (effort || 'default');
    put(x + 1, rect.top + 2 + index, theme.color(role + ' ' + clip(model || 'provider default', Math.max(1, size - suffix.length - 9)) + suffix, palette.accent, true));
  });
  const composer = tui.panel !== 'skills', inputRow = rect.top + rect.height - 2;
  let footerRow = inputRow - 1;
  const completions = composer ? tui.completions().slice(0, rect.height < 16 ? 1 : 3) : [];
  for (let i = completions.length - 1; i >= 0; i--) {
    const item = completions[i]; put(x, footerRow, theme.color(clip(' ' + item.command + ' · ' + item.description, size), i === tui.completionFocus ? palette.accent : palette.muted));
    tui.hitTargets.push({ type: 'command', choice: item, row: footerRow + 1, left: x + 1, right: x + size }); footerRow--;
  }
  if (tui.pendingApproval && (!tui.pendingApproval.expiresAt || tui.pendingApproval.expiresAt > Date.now())) {
    const disabled = tui.ui.sessionMode === 'VIEW' || !tui.ui.onAnswerApproval || tui.approvalSubmitting;
    let left = x + 1;
    for (const [label, answer, tone] of [[' Approve once ', 'yes', palette.goalSuccess], [' Deny ', 'no', palette.danger]]) {
      put(left, footerRow, fillSurface(label, label.length, theme, disabled ? palette.surface : tone, disabled ? palette.muted : palette.background, true));
      if (!disabled) tui.hitTargets.push({ type: 'approval', answer, row: footerRow + 1, left: left + 1, right: left + label.length }); left += label.length + 1;
    }
    footerRow--;
  }
  const snapshot = view.snapshots?.get(binding?.sessionId), status = canvasStatus(snapshot, binding);
  const permission = view.historyThread ? '' : tui.ui.yoloEnabled?.() ? ' YOLO ON ' : ' YOLO OFF ';
  put(x + 1, footerRow, theme.color(clip(view.historyThread ? 'Recorded conversation · opening never resumes work' : status.label + ' · Esc returns to canvas', size - permission.length - 3), status.tone));
  if (permission) {
    const left = x + size - permission.length;
    put(left, footerRow, theme.color(permission, tui.ui.yoloEnabled?.() ? palette.yolo : palette.muted));
    tui.hitTargets.push({ type: 'yolo', row: footerRow + 1, left: left + 1, right: left + permission.length });
  }
  const bodyTop = rect.top + 3 + roles.length, bodyHeight = Math.max(0, footerRow - bodyTop), contentWidth = Math.max(1, size - 1);
  const key = `canvas:${contentWidth}:${tui.panel}:${tui.showTools}:${tui.contentRevision || 0}:${tui.panel === 'skills' ? Date.now() : ''}`;
  let body;
  if (tui.bodyCache?.key === key) { body = tui.bodyCache.lines; tui.contentHits = tui.bodyCache.hits; }
  else { body = tui.content(contentWidth); tui.bodyCache = { key, lines: body, hits: tui.contentHits }; }
  if (!body.length) body = [theme.color('  No messages yet.', palette.muted)];
  if (tui.panel === 'skills' && (tui.skillTopRequested || tui.skillEnsureFocus)) {
    tui.scroll = Math.max(0, body.length - bodyHeight - (tui.skillTopRequested ? 0 : tui.skillFocusRow || 0));
    tui.skillTopRequested = false; tui.skillEnsureFocus = false;
  }
  const maximum = Math.max(0, body.length - bodyHeight); tui.scroll = Math.min(tui.scroll, maximum);
  const end = Math.max(0, body.length - tui.scroll), start = Math.max(0, end - bodyHeight);
  body.slice(start, end).forEach((line, i) => put(x, bodyTop + i, sliceCells(line, 0, contentWidth)));
  for (const hit of tui.contentHits || []) if (hit.row >= start && hit.row < end) tui.hitTargets.push({ ...hit, row: bodyTop + hit.row - start + 1, left: hit.left + x, right: Math.min(rect.left + rect.width - 2, hit.right + x) });
  const thumbHeight = Math.max(1, Math.round(bodyHeight * bodyHeight / Math.max(1, body.length))), thumbOffset = maximum ? Math.round((1 - tui.scroll / maximum) * (bodyHeight - thumbHeight)) : 0;
  if (maximum) for (let row = 0; row < bodyHeight; row++) put(x + size - 1, bodyTop + row, theme.color(row >= thumbOffset && row < thumbOffset + thumbHeight ? '┃' : '│', row >= thumbOffset && row < thumbOffset + thumbHeight ? palette.accent : palette.border));
  tui.scrollbar = bodyHeight ? { column: x + size, top: bodyTop + 1, height: bodyHeight, maximum, thumbHeight, thumbTop: bodyTop + thumbOffset + 1 } : null;
  tui.textRegion = bodyHeight ? { top: bodyTop + 1, bottom: bodyTop + bodyHeight, left: x + 1, right: x + contentWidth } : null;
  if (composer) {
    const before = [...tui.value].slice(0, tui.cursor).join('').replaceAll('\n', ' ↵ '), inputWidth = Math.max(1, size - 12);
    const offset = Math.max(0, cellWidth(before) - inputWidth + 1), value = clean(tui.value).replaceAll('\n', ' ↵ ');
    put(x, inputRow, fillSurface('› ' + sliceCells(value || (tui.ui.sessionMode === 'VIEW' ? 'Read-only history' : 'Message or /goal…'), offset, offset + inputWidth), size, theme, palette.elevated, value ? palette.text : palette.muted));
    const canSend = tui.ui.sessionMode !== 'VIEW';
    put(x + size - 9, inputRow, fillSurface(canSend ? ' Send ↵ ' : ' View ', 9, theme, palette.selection, canSend ? palette.accent : palette.muted));
    if (canSend) tui.hitTargets.push({ type: 'confirm', row: inputRow + 1, left: x + size - 8, right: x + size });
    tui.composerRow = inputRow + 1; tui.composerLeft = x; tui.composerOffset = offset;
  }
}

// Canvas owns the entire surface. Prompts, settings and conversations are local
// windows; only --minimal enters the transcript frontend. Private QR/code views
// retain their uncached renderer and complete quiet zones.
export function renderCanvasShell(tui, width, height) {
  tui.privateFrame = false;
  tui.canvasOverlay = null;
  if (tui.ui.privateView || tui.panel === 'settings' && tui.ui.settings?.qrView) {
    const header = tui.persistentHeader;
    tui.persistentHeader = (w, h, options = {}) => header.call(tui, w, h, { ...options, compact: true });
    try { if (tui.ui.privateView) tui.renderPrivateView(width, height); else tui.renderSettingsQR(width, height); }
    finally { tui.persistentHeader = header; }
    return;
  }
  const overlay = tui.promptDraft ? 'prompt' : tui.panel === 'settings' ? 'settings' : tui.ui.canvasView.drawer || tui.panel !== 'chat' ? 'conversation' : null;
  if (overlay || tui.renderingPicker) tui.canvasFrozenAt ??= tui.animationTime;
  else tui.canvasFrozenAt = null;
  const sideWidth = overlay === 'conversation' && width >= 112 ? Math.min(88, Math.round(width * .65)) : null;
  tui.canvasNativeStage = tui.canvasGraphics.enabled;
  renderCanvas(tui, width, height, { stageWidth: sideWidth ? width - sideWidth - 3 : width });
  tui.canvasHitTargets = tui.hitTargets.slice(); tui.canvasOverlay = null;
  if (!overlay) {
    if (tui.renderingPicker) tui.lastFrame[height - 1] = tui.theme.color(' Esc close menu · ↑/↓ choose · Enter open', palette.muted);
    return;
  }
  const lines = tui.lastFrame.slice(), minimumTop = Math.min(tui.sceneHeaderLength + 1, Math.max(1, height - 8));
  if (overlay === 'prompt' && tui.ui.canvasView.editingGoal) goalInput(tui, lines, width);
  else if (overlay === 'prompt') prompt(tui, lines, width, height, minimumTop);
  else if (overlay === 'settings') settings(tui, lines, width, height, minimumTop);
  else {
    const size = sideWidth || Math.max(14, width - 4);
    conversation(tui, lines, { left: sideWidth ? width - size : Math.max(0, Math.floor((width - size) / 2)), top: Math.min(minimumTop, height - 6), width: size, height: Math.max(6, height - minimumTop - 1) });
  }
  tui.canvasOverlay.kind = overlay;
  lines[height - 1] = tui.theme.color(' ' + clip(overlay === 'prompt' ? tui.ui.canvasView.editingGoal ? 'Esc cancel · Enter starts goal' : 'Esc cancel · Enter confirm' : overlay === 'settings' ? 'Esc back · ↑/↓ choose · Enter open' : 'Esc close conversation · Work continues in Core', width - 2), palette.muted);
  tui.lastFrame = lines;
}
