import { home, loadSession } from '@bzzy/core/engine/store.js';
import { createHash } from 'node:crypto';
import { libraryEntryMenu } from './library-entry-menu.js';
import { transferLibraryTab } from './library-ui.js';
import { listWorkflows, getWorkflow, saveWorkflow, importWorkflow, deleteWorkflow, workflowSelection, selectWorkflow, getGoalWorkflow } from '@bzzy/core/engine/workflows.js';

const sessionFor = ui => ui.sessionId && loadSession(ui.sessionId);
const cwdFor = ui => sessionFor(ui)?.cwd || ui.tui?.cwd || process.cwd();
const context = ui => JSON.stringify([home(), ui.sessionId || null, ui.activeTab || null, cwdFor(ui), ui.nextSession?.id || null]);
const contextToken = ui => createHash('sha256').update(context(ui)).digest('hex');
const check = (ui, expected) => { if (ui.closed || ui.coreLifecycleInterrupted || home() !== JSON.parse(expected)[0] || context(ui) !== expected) throw new Error('The terminal conversation or project changed. Reopen Workflows before acting.'); };
const refresh = ui => {
  if (!ui.tui) return;
  const actions = workflowRows(ui).filter(row => row.action), current = ui.workflowPreview ? -1 : actions.findIndex(row => /^✓ /.test(row.text));
  ui.tui.bodyCache = null; ui.tui.scroll = 0; ui.tui.workflowFocus = Math.max(0, current);
  ui.tui.workflowTopRequested = true; ui.tui.workflowEnsureFocus = true; ui.tui.schedule();
};
const selection = ui => ui.workflowSelectionState = ui.sessionId ? workflowSelection(ui.sessionId) : { sessionId: null, revision: 0, selected: null, available: true };
const backLabel = ui => ui.workflowReturnPanel === 'skills' ? '← Back to Skills' : ui.workflowReturnPanel === 'agents' ? '← Back to Agents' : '← Back to chat';
const clearPreview = ui => { ui.workflowPreview = null; ui.workflowPreviewContext = null; };
const scopes = [{ value: 'project', label: 'This project', selected: true }, { value: 'global', label: 'BZZY Core · all projects' }];
async function prompt(ui, method, ...args) { const before = context(ui), result = await ui[method](...args); check(ui, before); return result; }
function preview(ui, row) { ui.workflowPreview = row; ui.workflowPreviewContext = context(ui); ui.workflowPreviewSelection = selection(ui); ui.workflowAdminContext = context(ui); }
export function workflowChatLabel(ui) {
  try { const state = selection(ui); return state.selected ? `${state.selected.name}${state.available ? '' : ' · unavailable'}` : 'None'; }
  catch { ui.workflowSelectionState = null; return 'Unavailable'; }
}

export async function chooseWorkflow(ui) {
  const before = context(ui), shownSelection = selection(ui), entries = new Map();
  let offset = 0;
  do {
    const page = listWorkflows({ cwd: cwdFor(ui), offset, limit: 100 });
    for (const row of page.workflows) entries.set(row.id, row);
    offset = page.nextOffset;
  } while (offset !== null);
  const chosen = await prompt(ui, 'chooseOne', 'Workflow', {
    description: 'Choose one workflow for future goals in this terminal. Selecting starts no model work.',
    choices: [{ value: 'none', label: 'None', selected: !shownSelection.selected },
      ...[...entries.values()].map(row => ({ value: row.id, label: row.name, description: `${row.scope === 'global' ? 'BZZY Core' : 'This project'} · ${row.description}`,
        selected: shownSelection.available && shownSelection.selected?.id === row.id }))],
  }, { presentation: 'dropdown', kind: 'workflow', scope: 'workflow-picker' });
  if (chosen == null) return true;
  check(ui, before);
  const shown = entries.get(chosen);
  if (chosen !== 'none' && !shown) throw new Error('Choose a workflow from the current list.');
  if (shown) {
    const current = getWorkflow(shown.name, { cwd: cwdFor(ui), scope: shown.scope });
    if (current.id !== shown.id || current.version !== shown.version || current.revision !== shown.revision) throw new Error('Workflow changed. Reopen /workflow before selecting it.');
  }
  if (!ui.sessionId && chosen === 'none') return true;
  const id = await ensureSession(ui), current = selection(ui);
  selectWorkflow(id, shown?.name || null, { ...(shown ? { scope: shown.scope, expectedWorkflowRevision: shown.revision } : {}),
    expectedRevision: shownSelection.sessionId ? shownSelection.revision : current.revision });
  ui.event('info', { message: shown ? `${shown.name} selected for future /goal requests in this terminal.` : 'Workflow set to None for future goals.' });
  ui.tui?.schedule(); return true;
}

export function openWorkflows(ui, { origin = ui.tui?.panel || 'chat' } = {}) {
  ui.openTerminal?.();
  if (!ui.tui) { ui.event('error', { message: 'Open the interactive terminal to manage workflows.' }); return false; }
  const current = context(ui), changed = ui.workflowAdminContext && ui.workflowAdminContext !== current;
  if (ui.tui.panel !== 'workflows') ui.workflowReturnPanel = ['skills', 'agents'].includes(origin) ? origin : 'chat';
  if (ui.tui.panel !== 'workflows' || changed) {
    clearPreview(ui); ui.workflowOffset = 0; ui.workflowLibraryContext = null;
    ui.workflowLibraryEntries = null; ui.workflowShownSelection = null; ui.workflowPreviewSelection = null;
  }
  ui.workflowAdminContext = current; ui.tui.setPanel('workflows'); refresh(ui); return true;
}
export function closeWorkflows(ui) {
  if (ui.workflowPreview) { clearPreview(ui); refresh(ui); }
  else ui.tui?.setPanel(!ui.coreLifecycleInterrupted && ['skills', 'agents'].includes(ui.workflowReturnPanel) ? ui.workflowReturnPanel : 'chat');
  return true;
}

export function workflowRows(ui) {
  try {
    const current = context(ui), token = createHash('sha256').update(current).digest('hex');
    if (ui.workflowAdminContext && ui.workflowAdminContext !== current) { clearPreview(ui); ui.workflowOffset = 0; ui.workflowAdminContext = current; }
    const state = selection(ui), session = sessionFor(ui), goal = session?.goal && getGoalWorkflow(session.id, session.goal.id);
    if (ui.workflowPreview) {
      const shown = ui.workflowPreview;
      return [{ text: '← Back to workflows', action: 'back' }, { text: `${shown.name} · ${shown.scope} · revision ${shown.revision}`, tone: 'accent' },
        { text: shown.description }, { text: `Version ${shown.version.slice(0, 12)}`, tone: 'muted' },
        { text: 'Selecting applies to future new goals. Existing goals keep their saved instructions.', tone: 'muted' },
        { text: 'INSTRUCTIONS', tone: 'accent' }, { text: shown.instructions }, { text: '' },
        { text: 'Use for future goals in this terminal', action: 'use', tone: 'accent' }, { text: 'Edit workflow', action: 'edit' },
        { text: 'Delete workflow', action: 'delete', tone: 'warning' }, { text: backLabel(ui), action: 'close' }];
    }
    const page = listWorkflows({ cwd: cwdFor(ui), offset: ui.workflowOffset || 0, limit: 20 });
    ui.workflowLibraryContext = current; ui.workflowLibraryEntries = new Map(page.workflows.map(row => [`${row.scope}:${row.name}`, { ...row }])); ui.workflowShownSelection = state;
    return [{ text: backLabel(ui), action: 'close' }, { text: 'WORKFLOWS · reusable goal pre-prompts', tone: 'accent' },
      { text: `Selected for this terminal: ${state.selected ? `${state.selected.name} · ${state.selected.scope}${state.available ? '' : ' · unavailable'}` : 'None'}`, tone: state.available ? 'accent' : 'warning' },
      ...(!state.available ? [{ text: state.reason, tone: 'warning' }] : []),
      ...(goal?.workflow ? [{ text: `Current goal keeps ${goal.workflow.name} · ${goal.workflow.version.slice(0, 8)}`, tone: 'muted' }] : []),
      { text: 'One workflow per terminal. /goal loads its full instructions.', tone: 'muted' },
      { text: 'Import', action: 'import', buttonGroup: 'transfer', buttonIcon: '↓' }, { text: 'Export', action: 'export', buttonGroup: 'transfer', buttonIcon: '↑' },
      { text: 'Create workflow', action: 'create', buttonGroup: 'create', buttonIcon: '+' },
      { text: 'Load workflow from a text file', action: 'load', buttonLabel: 'Load file', buttonGroup: 'create' }, { text: '' },
      { text: `${state.selected ? '  ' : '✓ '}None · no workflow`, action: `none:${state.revision}:${token}`, tone: 'accent' },
      ...page.workflows.flatMap(row => {
        const action = `view:${row.scope}:${row.name}:${row.revision}:${token}`, menu = libraryEntryMenu(ui, 'workflow', row, '/workflow ' + action);
        return [{ text: `${state.available && state.selected?.id === row.id ? '✓ ' : '  '}${row.name} · ${row.scope}`, action: `select:${row.scope}:${row.name}:${row.revision}:${state.revision}:${token}`, tone: 'accent', menu },
          { text: `  Inspect / edit ${row.name}`, action, menu }];
      }),
      ...(!page.workflows.length ? [{ text: 'No workflows saved for this project. Create one or load reusable text.', tone: 'muted' }] : []),
      ...(ui.workflowOffset ? [{ text: 'Previous workflows', action: 'previous' }] : []), ...(page.nextOffset != null ? [{ text: 'More workflows', action: 'next' }] : [])];
  } catch (error) { return [{ text: error.message, tone: 'warning' }, { text: backLabel(ui), action: 'close' }]; }
}

async function ensureSession(ui) {
  const originalHome = home(), cwd = cwdFor(ui);
  if (ui.activeTab && ui.activeTab !== ui.sessionId) throw new Error('Select the root terminal chat before choosing its workflow.');
  if (typeof ui.ensureWorkflowSession !== 'function') {
    if (ui.sessionId) return ui.sessionId;
    throw new Error('Open a terminal chat before selecting a workflow.');
  }
  const result = await ui.ensureWorkflowSession(), id = typeof result === 'string' ? result : result?.id;
  if (home() !== originalHome || !id || ui.sessionId !== id || cwdFor(ui) !== cwd) throw new Error('Workflow selection must belong to this same terminal. Reopen Workflows.');
  ui.workflowAdminContext = context(ui); return id;
}
async function edit(ui, existing) {
  const name = existing?.name || (await prompt(ui, 'ask', 'Workflow name · lowercase words separated by hyphens · Esc cancels'))?.trim(); if (!name) return;
  const description = await prompt(ui, 'ask', 'Workflow description · when should it apply?', { initialValue: existing?.description || '' }); if (description == null) return;
  const instructions = await prompt(ui, 'ask', 'Full workflow instructions · Shift+Enter adds lines · use account references, never credentials', { initialValue: existing?.instructions || '' }); if (instructions == null || !instructions.trim()) return;
  const scope = existing?.scope || await prompt(ui, 'chooseOne', 'Where should this workflow be available?', scopes); if (!scope) return;
  const saved = saveWorkflow({ name, description: description.trim(), instructions }, { cwd: cwdFor(ui), scope, expectedRevision: existing?.revision || 0 });
  preview(ui, saved); ui.event('info', { message: `Saved ${saved.name}. Select it to apply to future goals in this terminal.` });
}

export async function workflowAction(action, ui, { transfer = transferLibraryTab } = {}) {
  if (!ui.tui && !openWorkflows(ui)) return false;
  const initial = context(ui);
  try {
    if (/^(select|view|none):/.test(action) && action.split(':').at(-1) !== contextToken(ui)) throw new Error('This workflow action belongs to another terminal or host context. Refresh Workflows before acting.');
    if (ui.activeTab && ui.activeTab !== ui.sessionId && !['back', 'close'].includes(action)) throw new Error('Select the root terminal chat before managing its workflows.');
    if (['', 'library', 'refresh'].includes(action)) { clearPreview(ui); ui.workflowAdminContext = initial; }
    else if (action === 'back') closeWorkflows(ui);
    else if (action === 'close') { clearPreview(ui); closeWorkflows(ui); }
    else if (action === 'import' || action === 'export') {
      await transfer(action, 'workflow', cwdFor(ui), ui); check(ui, initial); clearPreview(ui);
    }
    else if (action === 'create') await edit(ui);
    else if (action === 'load') {
      const file = (await prompt(ui, 'ask', 'Workflow text file · UTF-8, up to 128 KiB · Esc cancels'))?.trim(); if (!file) return true;
      const name = (await prompt(ui, 'ask', 'Name for the loaded workflow · lowercase-hyphenated'))?.trim(); if (!name) return true;
      const description = await prompt(ui, 'ask', 'Workflow description · when should it apply?'); if (description == null) return true;
      const scope = await prompt(ui, 'chooseOne', 'Where should this workflow be available?', scopes); if (!scope) return true;
      preview(ui, importWorkflow(file, { name, description: description.trim(), cwd: cwdFor(ui), scope, expectedRevision: 0 }));
      ui.event('info', { message: 'Workflow loaded. Review the full instructions and choose Use for future goals.' });
    } else if (action === 'next' || action === 'previous') { clearPreview(ui); ui.workflowOffset = Math.max(0, (ui.workflowOffset || 0) + (action === 'next' ? 20 : -20)); }
    else if (action.startsWith('select:')) {
      const [, scope, name, revision, selectionRevision] = action.split(':'), shown = ui.workflowLibraryEntries?.get(`${scope}:${name}`), prior = ui.workflowShownSelection;
      if (ui.workflowLibraryContext !== initial || !shown || shown.revision !== Number(revision) || prior?.revision !== Number(selectionRevision)) throw new Error('The workflow list or selection changed. Refresh before selecting.');
      const id = await ensureSession(ui), current = selection(ui);
      selectWorkflow(id, shown.name, { scope: shown.scope, expectedRevision: prior?.sessionId ? prior.revision : current.revision, expectedWorkflowRevision: shown.revision });
      ui.event('info', { message: `${shown.name} selected for future /goal requests in this terminal. Selecting starts no model work.` });
    }
    else if (action.startsWith('view:')) {
      const [, scope, name, revision] = action.split(':'), shown = ui.workflowLibraryEntries?.get(`${scope}:${name}`);
      if (ui.workflowLibraryContext !== initial || !shown || shown.revision !== Number(revision)) throw new Error('The workflow library changed. Refresh before opening this entry.');
      const current = getWorkflow(name, { cwd: cwdFor(ui), scope });
      if (current.id !== shown.id || current.version !== shown.version || current.revision !== shown.revision) throw new Error('Workflow changed. Refresh the library before opening it.');
      preview(ui, current);
    } else if (action === 'clear' || action.startsWith('none:')) {
      const shown = ui.workflowShownSelection || ui.workflowPreviewSelection;
      if (ui.workflowAdminContext !== initial || shown?.sessionId && shown.sessionId !== ui.sessionId) throw new Error('The terminal selection changed. Refresh Workflows before clearing it.');
      if (action.startsWith('none:') && shown?.revision !== Number(action.split(':')[1])) throw new Error('Workflow selection changed. Refresh before clearing it.');
      const id = await ensureSession(ui), current = selection(ui);
      selectWorkflow(id, null, { expectedRevision: shown?.sessionId ? shown.revision : current.revision }); clearPreview(ui);
      ui.event('info', { message: 'Workflow selection cleared for future goals. The existing goal is unchanged.' });
    } else if (['use', 'edit', 'delete'].includes(action)) {
      const shown = ui.workflowPreview;
      if (!shown || ui.workflowPreviewContext !== initial) throw new Error('Open the current workflow before acting.');
      const options = { cwd: cwdFor(ui), scope: shown.scope }, current = getWorkflow(shown.name, options);
      if (current.id !== shown.id || current.revision !== shown.revision || current.version !== shown.version) throw new Error('Workflow changed. Reload it before acting.');
      if (action === 'edit') await edit(ui, shown);
      else if (action === 'delete') {
        const answer = await prompt(ui, 'chooseOne', `Delete ${shown.name}? Existing goals keep their saved version.`, [{ value: 'cancel', label: 'Cancel', selected: true }, { value: 'delete', label: 'Delete workflow' }]);
        if (answer === 'delete') { deleteWorkflow(shown.name, { ...options, expectedRevision: shown.revision }); clearPreview(ui); }
      } else {
        const previous = ui.workflowPreviewSelection, id = await ensureSession(ui), currentSelection = selection(ui);
        selectWorkflow(id, shown.name, { scope: shown.scope, expectedRevision: previous?.sessionId ? previous.revision : currentSelection.revision, expectedWorkflowRevision: shown.revision });
        clearPreview(ui); ui.event('info', { message: `${shown.name} selected for future /goal requests in this terminal. Selecting starts no model work.` });
      }
    } else throw new Error('Choose an action from Workflows.');
  } catch (error) { ui.event('error', { message: error.message }); }
  finally { refresh(ui); }
  return true;
}
