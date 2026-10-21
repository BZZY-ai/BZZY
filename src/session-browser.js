import { findSession, loadSession, sessions, setSessionAlias } from './store.js';

export function sessionLabel(session) {
  return `${session.alias || 'Unnamed'} · ${session.id.slice(0, 8)} · ${session.provider} · ${session.goal?.status || session.executionState || 'chat'}`;
}

export async function chooseSavedSession(ui) {
  const saved = sessions().filter(session => !session.parentSessionId);
  if (!saved.length) { ui.event('info', { message: 'No saved sessions yet.' }); return null; }
  ui.openTerminal?.();
  const selected = await ui.chooseOne('Saved sessions', {
    hint: '↑/↓ session · Enter/a attach · v view · Esc exit',
    shortcuts: { a: 'attach', v: 'view' },
    descriptionRows: 3,
    choices: saved.map(session => ({ value: session.id, label: sessionLabel(session),
      description: `${session.cwd}\n${session.mode || 'solo'} · ${session.model || 'provider default'}\n${session.goal?.objective || 'Chat session'}` })),
  });
  if (selected == null) return null;
  const id = typeof selected === 'object' ? selected.value : selected;
  return { session: findSession(id), action: typeof selected === 'object' ? selected.action || 'attach' : 'attach' };
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
