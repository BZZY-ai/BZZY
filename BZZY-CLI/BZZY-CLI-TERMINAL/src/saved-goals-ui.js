import { home, loadSession } from '@bzzy/core/engine/store.js';
import { listSavedGoals, getSavedGoal } from '@bzzy/core/engine/saved-goals.js';

const pageSize = 20;
const unavailable = () => new Error('The terminal or host changed. Reopen /goal before choosing a saved goal.');
function targetSession(id) {
  const session = id && loadSession(id);
  if (!session || session.parentSessionId || session.parallelSessionId || session.canvasParentId || session.assignmentId || session.role
    || session.purpose && session.purpose !== 'terminal') {
    throw new Error('Open a root terminal chat before choosing a saved goal.');
  }
  return session;
}

// Local-owner navigation only. Reuse returns the objective as data; the caller
// submits it through ordinary new-goal admission, including replacement checks.
export async function chooseSavedGoal(ui, { sessionId = ui.activeTab || ui.sessionId } = {}) {
  const sourceHome = home(), target = targetSession(sessionId);
  const initial = { sessionId: ui.sessionId, activeTab: ui.activeTab, cwd: target.cwd,
    nextSession: ui.nextSession?.id };
  const check = () => {
    if (home() !== sourceHome || ui.sessionId !== initial.sessionId || ui.activeTab !== initial.activeTab
      || ui.nextSession?.id !== initial.nextSession || ui.closed || ui.coreLifecycleInterrupted) throw unavailable();
    const current = targetSession(sessionId);
    if (current.cwd !== initial.cwd) throw unavailable();
  };
  ui.openTerminal?.();
  let offset = 0;
  while (true) {
    check();
    const page = listSavedGoals({ offset, limit: pageSize });
    if (!page.goals.length) {
      // A concurrent deletion may remove the last page while it is open.
      if (offset && page.total) { offset = Math.max(0, Math.floor((page.total - 1) / pageSize) * pageSize); continue; }
      const message = 'No saved goals yet. Start one with /goal <objective>; Core keeps it for reuse.';
      ui.tui?.notice(message); ui.event('info', { message }); return null;
    }
    const entries = new Map(page.goals.map(goal => [goal.id, goal]));
    const pageLabel = `Saved goals ${offset + 1}–${offset + page.goals.length} of ${page.total}`;
    const selected = await ui.chooseOne('Saved goals', {
      description: `${pageLabel}\nChoose an objective to start a NEW goal in this terminal. Its current model, workflow and permissions apply.`,
      descriptionRows: 6,
      hint: '↑/↓ choose · Enter starts a new goal · Esc back',
      choices: [
        { value: 'back', label: '← Back to chat', selected: true,
          description: `${pageLabel}\nReturn without starting or changing any goal.` },
        ...page.goals.map(goal => ({ value: goal.id, label: goal.objective.replace(/\s+/gu, ' ').trim(),
          description: `${pageLabel}\n${goal.alias || 'Unnamed terminal'} · ${goal.cwd || 'BZZY Core Library'}\n${goal.objective}` })),
        ...(offset ? [{ value: 'newer', label: '← Newer saved goals', description: pageLabel }] : []),
        ...(page.nextOffset != null ? [{ value: 'older', label: 'Older saved goals →', description: pageLabel }] : []),
      ],
    }, { scope: 'saved-goals', presentation: 'dropdown', detailLimit: 6 });
    check();
    if (selected == null || selected === 'back') return null;
    if (selected === 'newer' && offset) { offset = Math.max(0, offset - pageSize); continue; }
    if (selected === 'older' && page.nextOffset != null) { offset = page.nextOffset; continue; }
    const shown = entries.get(selected);
    if (!shown) throw new Error('Choose a saved goal from the current list. Reopen /goal to refresh.');
    const current = getSavedGoal(shown.id, { revision: shown.revision });
    if (current.id !== shown.id || current.objective !== shown.objective || current.sessionId !== shown.sessionId) {
      throw new Error('This saved goal changed. Reopen /goal before reusing it.');
    }
    return current;
  }
}
