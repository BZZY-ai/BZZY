import { cellWidth, clean, clip } from './terminal-format.js';
import { palette } from './terminal-theme.js';
import { fillSurface } from './terminal-surface.js';
import { canControlSession } from './session-controls.js';
import { workflowChatLabel } from './workflow-ui.js';

function crop(text, cells) {
  let used = 0, result = '';
  for (const char of text) { if (used >= cells) result += char; used += cellWidth(char); }
  return result;
}
// The composer is a rounded box inset one cell from the workspace separators:
//  ╭─⬡ Message · 00:00:00 ───── [↓ Latest] ╮
//  │ ❯ draft…                     Send ↑  │
//  ╰──────────────────────────────────────╯
export function workspaceComposer(tui, width, height, completions) {
  const { color: c, background: bg } = tui.theme, lines = [], hits = [], edge = text => c(text, palette.accent);
  const page = bg(palette.background), field = bg(palette.surface);
  const button = (text, type, options = {}) => {
    const left = cellWidth(lines.at(-1) || '') + 1;
    lines[lines.length - 1] += fillSurface(text, cellWidth(text), tui.theme, options.fill || palette.elevated, options.tone || palette.accent, true) + ' ';
    hits.push({ type, row: lines.length - 1, left, right: left + cellWidth(text) - 1, ...options });
  };
  if (tui.pendingApproval && (!tui.pendingApproval.expiresAt || tui.pendingApproval.expiresAt > Date.now())) {
    lines.push(page + '  ');
    const disabled = !tui.ui.canAnswerApproval() || tui.approvalSubmitting;
    for (const [text, answer, tone, fill] of [[' ✓ Approve once ', 'yes', palette.background, palette.success], [' ✕ Deny ', 'no', palette.danger, palette.elevated]]) {
      if (cellWidth(lines.at(-1)) + cellWidth(text) + 1 > width) break;
      if (disabled) lines[lines.length - 1] += c(text, palette.muted) + ' ';
      else button(text, 'approval', { answer, tone, fill });
    }
  }
  if (!tui.promptDraft && height >= 20) lines.push(...tui.executionActivity(width).slice(0, height >= 30 ? 2 : 1));
  if (completions.length) {
    lines.push(c(clip('  ' + tui.completionHint(completions), width), palette.muted));
    const count = height < 24 ? 2 : 4, start = Math.max(0, Math.min(tui.completionFocus - 1, completions.length - count));
    for (let index = start; index < Math.min(completions.length, start + count); index++) {
      const item = completions[index], focused = index === tui.completionFocus;
      hits.push({ type: 'command', choice: item, row: lines.length, left: 2, right: width - 1 });
      const command = clip(' ' + (focused ? '❯ ' : '  ') + item.command, Math.max(1, width - 2));
      const detail = clip('  ' + item.description, Math.max(0, width - 2 - cellWidth(command)));
      lines.push(page + ' ' + fillSurface(command, cellWidth(command), tui.theme, focused ? palette.selection : palette.surface, focused ? palette.accent : palette.text, focused, focused ? palette.selection : palette.surface)
        + fillSurface(detail, Math.max(0, width - 2 - cellWidth(command)), tui.theme, focused ? palette.selection : palette.surface, palette.muted, false) + page + ' ');
    }
  }
  const backgroundTop = lines.length, box = Math.max(4, width - 2);
  const name = tui.promptDraft ? clean(tui.question || 'Confirm') : tui.panel === 'skills' ? 'Codex skills directory' : tui.panel === 'room' ? 'Message all agents' : 'Message';
  const meta = tui.promptDraft || tui.panel === 'skills' ? '' : ' · ' + tui.elapsedClock();
  const back = tui.promptDraft ? ' [← Back] ' : tui.scroll ? ' [↓ Latest] ' : '';
  const room = Math.max(1, box - cellWidth(back) - 4), title = clip(' ' + name, room), note = clip(meta + ' ', Math.max(0, room - cellWidth(title)));
  let top = page + ' ' + edge('╭─') + c('⬡', palette.accent) + c(title, palette.accent, true) + c(note, palette.muted)
    + edge('─'.repeat(Math.max(0, box - cellWidth(title + note) - cellWidth(back) - 4)));
  if (back) {
    const left = width - cellWidth(back) - 1;
    hits.push({ type: tui.promptDraft ? 'back' : 'latest', back: Boolean(tui.promptDraft), row: lines.length, left, right: width - 2 });
    top += c(back, palette.accent, true);
  }
  lines.push(top + edge('╮') + page + ' ');
  const hasSubmit = Boolean(tui.resolveInput || tui.ui.sessionId) && (tui.promptDraft || canControlSession(tui.ui));
  const send = tui.promptDraft ? ' Confirm ' : tui.panel === 'skills' && tui.ui.skillView === 'import' ? ' Save & refresh ' : width < 38 ? ' ↑ ' : ' Send ↑ ';
  const inputWidth = Math.max(1, width - 8 - (hasSubmit ? cellWidth(send) + 1 : 0));
  const value = tui.hidden ? '•'.repeat([...tui.value].length) : tui.value.replaceAll('\n', ' ↵ ');
  const before = tui.hidden ? '•'.repeat(tui.cursor) : [...tui.value].slice(0, tui.cursor).join('').replaceAll('\n', ' ↵ ');
  const offset = Math.max(0, cellWidth(before) - inputWidth + 1);
  const placeholder = !canControlSession(tui.ui) ? 'Read-only session' : tui.promptDraft ? 'Enter a value…' : 'Type a message…';
  const text = value ? clip(crop(value, offset), inputWidth, '') : clip(placeholder, inputWidth);
  let input = page + ' ' + edge('│') + field + ' ' + c('❯ ', palette.accent, true) + c(text, value ? palette.text : palette.muted) + ' '.repeat(Math.max(0, inputWidth - cellWidth(text)));
  if (hasSubmit) {
    const left = 6 + inputWidth + 1;
    hits.push({ type: 'confirm', row: lines.length, left, right: left + cellWidth(send) - 1 });
    input += field + ' ' + fillSurface(send, cellWidth(send), tui.theme, value ? palette.accent : palette.selection, value ? palette.background : palette.accent, true, palette.surface);
  }
  lines.push(input + field + ' ' + page + edge('│') + ' ');
  const inputIndex = lines.length - 1;
  lines.push(page + ' ' + edge('╰' + '─'.repeat(Math.max(0, box - 2)) + '╯') + page + ' ');
  if (!tui.promptDraft && height >= 12) {
    const yolo = tui.ui.yoloEnabled?.() ? ' [YOLO] ' : '';
    const badge = tui.goalBadgeLayout(width, { showEmpty: false, reserved: cellWidth(yolo) });
    if (badge.line || yolo) {
      const left = width - cellWidth(yolo) + 1;
      if (yolo) hits.push({ type: 'yolo', row: lines.length, left, right: width });
      lines.push(page + badge.line
        + ' '.repeat(Math.max(0, width - cellWidth(badge.line) - cellWidth(yolo)))
        + c(yolo, palette.warning, true) + page, ...badge.extra);
    }
  }
  if (tui.copyMode) lines.push(c(clip('  COPY MODE · Esc returns', width), palette.warning));
  if (!tui.promptDraft && tui.panel === 'chat' && height >= 14) {
    const name = workflowChatLabel(tui.ui);
    if (name !== 'None' && name !== 'Unavailable') {
      hits.push({ type: 'workflow-open', row: lines.length, left: 2, right: width });
      lines.push(page + c('  ⬡ ', palette.agent) + c(clip('Workflow: ' + name, Math.max(1, width - 5)), palette.agent, true) + page);
    }
  }
  return { lines, hits, inputIndex, textLeft: 6, offset, backgroundTop, backgroundBottom: inputIndex };
}

export function workspacePanelFooter(tui, width) {
  const label = ' [← Chat] ', more = ' [Actions ⋯] ', pill = (text, tone) => fillSurface(text, cellWidth(text), tui.theme, palette.elevated, tone, true);
  return { lines: [cellWidth(label + more) + 2 <= width ? ' ' + pill(label, palette.accent) + ' ' + pill(more, palette.accent) : tui.theme.color(clip(label + more, width), palette.accent)], hits: cellWidth(label + more) + 2 <= width ? [
    { type: 'top-chat', row: 0, left: 2, right: 1 + cellWidth(label) },
    { type: 'workspace-actions', row: 0, left: cellWidth(label) + 3, right: Math.min(width, cellWidth(label + more) + 2) },
  ] : [
    { type: 'top-chat', row: 0, left: 2, right: Math.min(width, cellWidth(label)) },
    { type: 'workspace-actions', row: 0, left: cellWidth(label) + 1, right: Math.min(width, cellWidth(label + more)) },
  ], inputIndex: -1, textLeft: 0, offset: 0, backgroundTop: -2, backgroundBottom: -2 };
}
