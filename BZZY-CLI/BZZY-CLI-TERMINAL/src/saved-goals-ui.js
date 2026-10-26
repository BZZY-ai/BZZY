import { home, loadSession } from '@bzzy/core/engine/store.js';
import { listGoalTemplates as listSavedGoals, getSavedGoalTemplate as getSavedGoal, saveGoalTemplate } from '@bzzy/core/engine/goal-templates.js';
import { transferLibraryTab } from './library-ui.js';
import { libraryEntryMenu, prepareLibraryRemoval, removeLibraryEntry } from './library-entry-menu.js';

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
export async function chooseSavedGoal(ui, { sessionId = ui.activeTab || ui.sessionId, transfer = transferLibraryTab } = {}) {
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
    }
    const entries = new Map(page.goals.map(goal => [goal.id, goal]));
    const pageLabel = page.goals.length ? `Saved goals ${offset + 1}–${offset + page.goals.length} of ${page.total}`
      : 'No saved goals yet. Save one manually in the Goals tab or import a code.';
    const selected = await ui.chooseOne('Saved goals', {
      description: `${pageLabel}\nChoose an objective to start a NEW goal in this terminal. Its current model, workflow and permissions apply.`,
      descriptionRows: 6,
      hint: '↑/↓ choose · Enter opens or reuses · Esc back',
      choices: [
        { value: 'back', label: '← Back to chat', selected: true,
          description: `${pageLabel}\nReturn without starting or changing any goal.` },
        { value: 'import', label: 'Import', description: 'Enter a Relay code to install missing saved goals. No goal starts.' },
        { value: 'export', label: 'Export', disabled: !page.total, description: 'Check saved goals and generate an expiring Relay code.' },
        ...page.goals.map(goal => ({ value: goal.id, label: goal.objective.replace(/\s+/gu, ' ').trim(),
          description: `${pageLabel}\n${goal.alias || 'Unnamed terminal'} · ${goal.cwd || 'BZZY Core Library'}\n${goal.objective}` })),
        ...(offset ? [{ value: 'newer', label: '← Newer saved goals', description: pageLabel }] : []),
        ...(page.nextOffset != null ? [{ value: 'older', label: 'Older saved goals →', description: pageLabel }] : []),
      ],
    }, { scope: 'saved-goals', presentation: 'dropdown', detailLimit: 6 });
    check();
    if (selected == null || selected === 'back') return null;
    if (selected === 'import' || selected === 'export') {
      await transfer(selected, 'goal', target.cwd, ui); check(); offset = 0; continue;
    }
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

export function openGoals(ui) {
  ui.openTerminal?.(); ui.goalPreview = null; ui.goalOffset = 0; ui.tui?.setPanel('goals'); return true;
}
export function goalRows(ui) {
  try {
    if (ui.goalPreview) return [{ text: '← Back to goals', action: 'back' }, { text: 'SAVED GOAL', tone: 'accent' }, { text: ui.goalPreview.objective },
      { text: 'Remove saved goal', action: 'remove', buttonGroup: 'manage', buttonIcon: '−' }];
    const page = listSavedGoals({ offset: ui.goalOffset || 0, limit: pageSize });
    ui.goalEntries = new Map(page.goals.map(goal => [goal.id, goal]));
    return [{ text: '← Back to chat', action: 'close' }, { text: 'GOALS · manually saved objectives', tone: 'accent' },
      { text: 'Saved manually. Reuse with /goal.', tone: 'muted' },
      { text: 'Save new goal', action: 'save', buttonGroup: 'save', buttonIcon: '+' },
      ...(ui.sessionId && loadSession(ui.sessionId)?.goal ? [{ text: 'Save current goal', action: 'save-current', buttonGroup: 'save' }] : []),
      { text: 'Import', action: 'import', buttonGroup: 'transfer', buttonIcon: '↓' },
      { text: 'Export', action: 'export', buttonGroup: 'transfer', buttonIcon: '↑', disabled: !page.total },
      ...page.goals.map(goal => ({ text: goal.objective.replace(/\s+/gu, ' ').trim(), action: 'view:' + goal.id,
        menu: libraryEntryMenu(ui, 'goal', goal, '/saved-goals view:' + goal.id) })),
      ...(!page.total ? [{ text: 'No manually saved goals yet.', tone: 'muted' }] : []),
      ...(ui.goalOffset ? [{ text: '← Newer goals', action: 'previous' }] : []),
      ...(page.nextOffset != null ? [{ text: 'Older goals →', action: 'next' }] : [])];
  } catch (error) {
    ui.goalEntries = new Map();
    return [{ text: '← Back to chat', action: 'close' }, { text: error.message, tone: 'warning' }];
  }
}
export async function goalAction(action, ui, { transfer = transferLibraryTab } = {}) {
  const sourceHome = home();
  const context = () => JSON.stringify([home(), ui.sessionId, ui.activeTab, ui.nextSession?.id, ui.sessionId && loadSession(ui.sessionId)?.cwd || ui.tui?.cwd]);
  const before = context();
  const check = () => { if (home() !== sourceHome || ui.closed || ui.coreLifecycleInterrupted || before !== context()) throw unavailable(); };
  try {
    if (action === 'close') ui.tui?.setPanel('chat');
    else if (action === 'back') ui.goalPreview = null;
    else if (action === 'remove') {
      if (!ui.goalPreview) throw unavailable();
      await removeLibraryEntry(ui, prepareLibraryRemoval(ui, libraryEntryMenu(ui, 'goal', ui.goalPreview))); check();
    }
    else if (['save', 'save-current'].includes(action)) {
      const initialValue = action === 'save-current' ? loadSession(ui.sessionId)?.goal?.objective || '' : '';
      const objective = await ui.ask('Save goal · objective text · Esc cancels', { initialValue }); check();
      if (objective?.trim()) { saveGoalTemplate({ objective }); ui.goalPreview = null; ui.event('info', { message: 'Goal saved to Library. No goal was started.' }); }
    } else if (action === 'import' || action === 'export') {
      await transfer(action, 'goal', ui.sessionId && loadSession(ui.sessionId)?.cwd || ui.tui?.cwd || process.cwd(), ui); check();
    } else if (action === 'next' || action === 'previous') ui.goalOffset = Math.max(0, (ui.goalOffset || 0) + (action === 'next' ? pageSize : -pageSize));
    else if (action.startsWith('view:')) {
      const shown = ui.goalEntries?.get(action.slice(5));
      if (!shown) throw unavailable();
      ui.goalPreview = getSavedGoal(shown.id, { revision: shown.revision });
    } else throw new Error('Choose an action from Goals.');
  } catch (error) { ui.event('error', { message: error.message }); }
  finally { if (ui.tui) { ui.tui.bodyCache = null; ui.tui.scroll = 0; ui.tui.goalFocus = 0; ui.tui.goalTopRequested = true; ui.tui.goalEnsureFocus = true; ui.tui.schedule(); } }
  return true;
}
