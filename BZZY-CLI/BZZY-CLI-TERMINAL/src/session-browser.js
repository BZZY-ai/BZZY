import { terminalSession } from '@bzzy/core';
import { loadSession, sessions, setSessionAlias } from './store.js';

export function sessionLabel(session) {
  return typeof session.alias === 'string' ? session.alias.trim() : '';
}

const timestamp = value => typeof value === 'number' ? (Number.isFinite(value) ? value : null)
  : typeof value === 'string' && value.trim() && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
export function namedTerminalSessions(source = sessions()) {
  const activity = session => timestamp(session.updatedAt) ?? timestamp(session.createdAt) ?? 0;
  return source.filter(session => terminalSession(session) && sessionLabel(session))
    .sort((a, b) => activity(b) - activity(a) || a.id.localeCompare(b.id));
}

// Navigation enters the same local command loop as /sessions; it never submits
// a prompt or replaces a private/modal input reader.
export function queueSessionBrowser(ui) {
  const tui = ui.tui;
  if (!tui || tui.selection || tui.promptDraft || tui.hidden || ui.privateView) return false;
  if (tui.resolveInput && !/^bzzy\b/.test(tui.question || '')) return false;
  const sessionId = ui.activeTab || ui.sessionId;
  const drafts = ui.sessionBrowserDrafts ||= new Map();
  if (!drafts.has(sessionId)) drafts.set(sessionId, tui.settingsDraft || { value: tui.value, cursor: tui.cursor });
  if (tui.resolveInput) tui.finish('/sessions');
  else {
    if (!tui.inputQueue.some(item => item.sessionId === sessionId && item.text === '/sessions')) tui.inputQueue.push({ sessionId, text: '/sessions' });
  }
  return true;
}

export async function chooseSavedSession(ui) {
  try {
    const saved = namedTerminalSessions();
    if (!saved.length) { ui.event('info', { message: 'No named terminal sessions yet. Use /alias NAME to name a chat.' }); return null; }
    ui.openTerminal?.();
    const aliases = new Map();
    for (const session of saved) aliases.set(sessionLabel(session), (aliases.get(sessionLabel(session)) || 0) + 1);
    const selected = await ui.chooseOne('Sessions', {
      hint: '↑/↓ select · Enter open · Esc back',
      descriptionRows: 1,
      choices: saved.map(session => ({ value: session.id, label: sessionLabel(session),
        ...(aliases.get(sessionLabel(session)) > 1 ? { description: session.cwd } : {}) })),
    });
    if (selected == null) return null;
    const id = typeof selected === 'object' ? selected.value : selected;
    const session = saved.some(item => item.id === id) && loadSession(id);
    if (!session || !namedTerminalSessions([session]).length) { ui.event('info', { message: 'This named terminal is no longer available. Open Sessions to refresh.' }); return null; }
    return { session, action: 'attach' };
  } finally {
    ui.tui?.setPanel('chat');
    const sessionId = ui.activeTab || ui.sessionId, draft = ui.sessionBrowserDrafts?.get(sessionId);
    ui.sessionBrowserDrafts?.delete(sessionId);
    if (draft && ui.tui) Object.assign(ui.tui, { value: draft.value, cursor: draft.cursor });
  }
}

export async function promptSessionAlias(id, argument, ui, authorize) {
  const current = loadSession(id);
  if (!current) throw new Error('No conversation selected.');
  const entered = argument || await ui.ask(`Session alias${current.alias ? ` [${current.alias}]` : ''}: `);
  if (entered == null || !entered.trim()) return current;
  const session = setSessionAlias(id, entered, authorize);
  ui.updateSession?.(session);
  ui.event('info', { message: `Session alias: ${session.alias}\nWorking directory: ${session.cwd}` });
  return session;
}
