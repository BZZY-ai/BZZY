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
export function workspaceComposer(tui, width, height, completions) {
  const { color: c } = tui.theme, lines = [], hits = [], edge = text => c(text, palette.border);
  const button = (text, type, options = {}) => {
    const left = cellWidth(lines.at(-1) || '') + 1;
    lines[lines.length - 1] += c(text, options.tone || palette.accent, true);
    hits.push({ type, row: lines.length - 1, left, right: left + cellWidth(text) - 1, ...options });
  };
  if (tui.pendingApproval && (!tui.pendingApproval.expiresAt || tui.pendingApproval.expiresAt > Date.now())) {
    lines.push('');
    const disabled = !tui.ui.canAnswerApproval() || tui.approvalSubmitting;
    for (const [text, answer, tone] of [[' [Approve once] ', 'yes', palette.success], [' [Deny] ', 'no', palette.danger]]) {
      if (cellWidth(lines.at(-1)) + cellWidth(text) > width) break;
      if (disabled) lines[lines.length - 1] += c(text, palette.muted);
      else button(text, 'approval', { answer, tone });
    }
  }
  if (!tui.promptDraft && height >= 20) lines.push(...tui.executionActivity(width).slice(0, height >= 30 ? 2 : 1));
  if (completions.length) {
    lines.push(c(clip(tui.completionHint(completions), width), palette.muted));
    const count = height < 24 ? 2 : 4, start = Math.max(0, Math.min(tui.completionFocus - 1, completions.length - count));
    for (let index = start; index < Math.min(completions.length, start + count); index++) {
      const item = completions[index];
      hits.push({ type: 'command', choice: item, row: lines.length, left: 2, right: width - 1 });
      lines.push(fillSurface(clip(' ' + (index === tui.completionFocus ? '› ' : '  ') + item.command + '  ' + item.description, width), width, tui.theme,
        index === tui.completionFocus ? palette.selection : palette.background, index === tui.completionFocus ? palette.accent : palette.muted));
    }
  }
  const backgroundTop = lines.length;
  const title = tui.promptDraft ? clean(tui.question || 'Confirm') : tui.panel === 'skills' ? 'Codex skills directory' : (tui.panel === 'room' ? 'Message all agents' : 'Message') + ' · ' + tui.elapsedClock();
  const back = tui.promptDraft ? ' [← Back] ' : '';
  const caption = clip(' ' + title + ' ', Math.max(1, width - cellWidth(back) - 3));
  let top = edge('┌─') + c(caption, palette.accent) + edge('─'.repeat(Math.max(0, width - cellWidth(caption) - cellWidth(back) - 3)));
  if (back) { const left = width - cellWidth(back); hits.push({ type: 'back', back: true, row: lines.length, left, right: width - 1 }); top += c(back, palette.accent); }
  lines.push(top + edge('┐'));
  const hasSubmit = Boolean(tui.resolveInput || tui.ui.sessionId) && (tui.promptDraft || canControlSession(tui.ui));
  const send = tui.promptDraft ? ' Confirm ' : tui.panel === 'skills' && tui.ui.skillView === 'import' ? ' Save & refresh ' : width < 38 ? ' ↑ ' : ' Send ↑ ';
  const inputWidth = Math.max(1, width - 6 - (hasSubmit ? cellWidth(send) + 1 : 0));
  const value = tui.hidden ? '•'.repeat([...tui.value].length) : tui.value.replaceAll('\n', ' ↵ ');
  const before = tui.hidden ? '•'.repeat(tui.cursor) : [...tui.value].slice(0, tui.cursor).join('').replaceAll('\n', ' ↵ ');
  const offset = Math.max(0, cellWidth(before) - inputWidth + 1);
  const placeholder = !canControlSession(tui.ui) ? 'Read-only session' : tui.promptDraft ? 'Enter a value…' : 'Type a message…';
  const text = value ? clip(crop(value, offset), inputWidth, '') : clip(placeholder, inputWidth);
  let input = edge('│ ') + c('› ', palette.accent, true) + c(text, value ? palette.text : palette.muted) + ' '.repeat(Math.max(0, inputWidth - cellWidth(text)));
  if (hasSubmit) {
    const left = 5 + inputWidth + 1;
    hits.push({ type: 'confirm', row: lines.length, left, right: left + cellWidth(send) - 1 });
    input += ' ' + fillSurface(send, cellWidth(send), tui.theme, value ? palette.accent : palette.selection, value ? palette.background : palette.accent, true);
  }
  lines.push(input + edge(' │'));
  const inputIndex = lines.length - 1;
  lines.push(edge('└' + '─'.repeat(Math.max(0, width - 2)) + '┘'));
  if (!tui.promptDraft && height >= 14) {
    lines.push('');
    const controls = [[' Paste ', 'paste'], [' Model ▾ ', 'workspace-models'], [' Effort ▾ ', 'model-control', '/effort'], [' Tools ', 'tools'], [tui.scroll ? ' ↓ Latest ' : ' ↓ Live ', 'latest'], ...(tui.busy ? [[' Pause ', 'model-control', '/pause']] : [])];
    const more = ' ⋯ ';
    for (const [text, type, command] of controls) {
      if (cellWidth(lines.at(-1)) + cellWidth(text) + cellWidth(more) > width) break;
      button(text, type, { command, disabled: command === '/effort' && (tui.busy || tui.modelSelectionRequired || !canControlSession(tui.ui)), tone: type === 'latest' && tui.scroll ? palette.accent : palette.muted });
    }
    button(more, 'workspace-actions');
  }
  if (!tui.promptDraft && height >= 12) {
    const badge = tui.goalBadgeLayout(width, { showEmpty: false });
    if (badge.line) lines.push(badge.line, ...badge.extra);
  }
  if (tui.copyMode) lines.push(c(clip(' COPY MODE · Esc returns', width), palette.warning));
  if (!tui.promptDraft && tui.panel === 'chat' && height >= 18) {
    const name = workflowChatLabel(tui.ui);
    if (name !== 'None' && name !== 'Unavailable') {
      hits.push({ type: 'workflow-open', row: lines.length, left: 2, right: width });
      lines.push(c(clip(' Workflow: ' + name, width), palette.agent));
    }
  }
  return { lines, hits, inputIndex, textLeft: 5, offset, backgroundTop, backgroundBottom: inputIndex };
}

export function workspacePanelFooter(tui, width) {
  const label = ' [← Chat] ', more = ' [Actions ⋯] ';
  return { lines: [tui.theme.color(clip(label + more, width), palette.accent)], hits: [
    { type: 'top-chat', row: 0, left: 2, right: Math.min(width, cellWidth(label)) },
    { type: 'workspace-actions', row: 0, left: cellWidth(label) + 1, right: Math.min(width, cellWidth(label + more)) },
  ], inputIndex: -1, textLeft: 0, offset: 0, backgroundTop: -2, backgroundBottom: -2 };
}
