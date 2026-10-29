import { BzzyCore, terminalSession } from '@bzzy/core';
import { randomUUID } from 'node:crypto';
import { newConversation } from '@bzzy/core/engine/host-commands.js';
import { loadSession, sessions, setSessionAlias } from './store.js';
import { shareTerminal } from './share-ui.js';

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

export async function chooseSavedSession(ui, { excludeId } = {}) {
  try {
    while (true) {
      const saved = namedTerminalSessions().filter(session => session.id !== excludeId);
      if (!saved.length) {
        const message = excludeId ? 'No other named terminal sessions. Name another chat with /alias NAME.' : 'No named terminal sessions yet. Use /alias NAME to name a chat.';
        ui.tui?.notice(message); ui.event('info', { message }); return null;
      }
      ui.openTerminal?.();
      const aliases = new Map();
      for (const session of saved) aliases.set(sessionLabel(session), (aliases.get(sessionLabel(session)) || 0) + 1);
      const selected = await ui.chooseOne('Sessions', {
        choices: saved.map(session => ({ value: session.id, label: sessionLabel(session),
          ...(aliases.get(sessionLabel(session)) > 1 ? { description: session.cwd } : {}) })),
      }, {
        scope: 'sessions',
        presentation: 'dropdown',
        anchor: ui.tui?.topSessionAnchor,
        hint: 'Enter open · Right-click / F10 actions · Esc back',
        descriptionRows: 1,
      });
      if (selected == null) return null;
      const id = typeof selected === 'object' ? selected.value : selected;
      const session = saved.some(item => item.id === id) && loadSession(id);
      if (!session || !namedTerminalSessions([session]).length) { ui.event('info', { message: 'This named terminal is no longer available. Open Sessions to refresh.' }); return null; }
      if (selected.action === 'rename') { await renameSavedSession(ui, id); continue; }
      if (selected.action === 'share') { await shareSavedSession(ui, id); return null; }
      if (selected.action === 'delete') {
        try { await deleteSavedSession(ui, id); }
        catch (error) { ui.event('error', { message: error.message }); }
        if (ui.nextSession) return null;
        continue;
      }
      return { session, action: 'attach' };
    }
  } finally {
    if (ui.tui) ui.tui.topSessionAnchor = null;
    ui.tui?.setPanel('chat');
    const sessionId = ui.activeTab || ui.sessionId, draft = ui.sessionBrowserDrafts?.get(sessionId);
    ui.sessionBrowserDrafts?.delete(sessionId);
    if (draft && ui.tui) Object.assign(ui.tui, { value: draft.value, cursor: draft.cursor });
  }
}

export async function renameSavedSession(ui, id) {
  if (ui.sessionMode === 'VIEW') throw new Error('Attach with control before renaming a terminal.');
  const source = loadSession(id);
  if (!source || !namedTerminalSessions([source]).length) throw new Error('Choose an existing named terminal.');
  const alias = await ui.ask('Rename saved terminal · Esc cancels', { initialValue: source.alias });
  if (alias == null || !alias.trim()) return;
  const updated = setSessionAlias(id, alias);
  if (id === ui.sessionId) ui.updateSession?.(updated);
  if (ui.tui) { ui.tui.recentCache = null; ui.tui.schedule(); }
}

// This local frontend action never removes files itself. Core owns the durable
// tombstone, runtime/grant checks and idempotent deletion acceptance.
export async function deleteSavedSession(ui, id, {
  remove = (sessionId, options) => new BzzyCore().deleteConversation(sessionId, options),
  fresh = previous => newConversation(previous, { cwd: previous.cwd }),
} = {}) {
  if (/VIEW/.test(ui.sessionMode || '') && !ui.permissionConnection?.acquire) throw new Error('This is a read-only view. Attach with control to delete a chat.');
  const source = loadSession(id);
  if (!source || !namedTerminalSessions([source]).length) throw new Error('Choose an existing named terminal.');
  const alias = sessionLabel(source);
  const selected = await ui.chooseOne(`Delete chat “${alias}”?`, {
    warning: `“${alias}”\nRemove saved chat. Project files are kept.`,
    descriptionRows: 6,
    choices: [
      { value: 'cancel', label: 'Cancel · Keep chat', selected: true },
      { value: 'delete', label: 'Delete chat', tone: 'danger' },
    ],
  }, { kind: 'approval', scope: 'session-delete', presentation: 'context', minimumWidth: 62, detailLimit: 6 });
  if (selected !== 'delete') return null;
  const requests = ui.sessionDeleteRequests ||= new Map();
  const requestId = requests.get(id) || randomUUID(); requests.set(id, requestId);
  ui.tui?.notice('Deleting chat…');
  let result;
  try { result = await remove(id, { requestId }); }
  catch (error) {
    if (!['UNCERTAIN', 'CORE_MAINTENANCE', 'ECONNRESET', 'UND_ERR_SOCKET', 'AbortError', 'TimeoutError'].includes(error.code || error.name)) requests.delete(id);
    throw error;
  }
  if (result?.state !== 'deleted' || result.sessionId !== id || !Array.isArray(result.deletedSessionIds) || !result.deletedSessionIds.includes(id)) throw new Error('Core did not confirm chat deletion.');
  requests.delete(id);
  forgetDeletedConversation(ui, source, result.deletedSessionIds, { fresh });
  return result;
}

// Shared by the confirmed local action and a live reader learning that another
// client deleted its conversation. This only changes frontend navigation/state.
export function forgetDeletedConversation(ui, source, ids = [source.id], {
  fresh = previous => newConversation(previous, { cwd: previous.cwd }),
} = {}) {
  const deleted = new Set(ids);
  const currentDeleted = deleted.has(ui.sessionId);
  for (const sessionId of deleted) {
    ui.cursors?.delete(sessionId); ui.cursors?.delete(`${sessionId}:shared-room`);
    ui.sessionBrowserDrafts?.delete(sessionId); ui.sessionPermissionStates?.delete(sessionId);
    ui.tui?.drafts.delete(sessionId);
  }
  if (ui.tui) {
    ui.tui.recentCache = null;
    ui.tui.inputQueue = ui.tui.inputQueue.filter(item => !deleted.has(item.sessionId));
    if (currentDeleted) { ui.tui.value = ''; ui.tui.cursor = 0; ui.clearHistory?.(); }
    ui.tui.schedule();
  }
  if (currentDeleted) {
    ui.pendingChatInputs = [];
    ui.nextSession = fresh(source);
  }
  ui.tui?.notice(`Deleted chat · ${sessionLabel(source) || 'Conversation'}`);
}

// A host-only client action. Loading context for sharing never attaches to a
// session, takes its input lease or replays model work.
export async function shareSavedSession(ui, id, { share = shareTerminal } = {}) {
  if (ui.sessionMode === 'VIEW') throw new Error('Attach with control before sharing a terminal.');
  const session = loadSession(id);
  if (!session || !namedTerminalSessions([session]).length) throw new Error('Choose an existing named terminal.');
  return share(session, ui);
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
