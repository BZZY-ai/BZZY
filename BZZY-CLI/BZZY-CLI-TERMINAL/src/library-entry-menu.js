import { randomUUID } from 'node:crypto';
import { home, loadSession } from '@bzzy/core/engine/store.js';
import { inspectSkill, deleteSkill } from '@bzzy/core/engine/skills.js';
import { getSubagentDefinition, deleteSubagentDefinition } from '@bzzy/core/engine/subagent-definitions.js';
import { getWorkflow, deleteWorkflow } from '@bzzy/core/engine/workflows.js';
import { getSavedGoalTemplate, deleteGoalTemplate } from '@bzzy/core/engine/goal-templates.js';

const cwdFor = ui => ui.sessionId && loadSession(ui.sessionId)?.cwd || ui.tui?.cwd || process.cwd();
const context = ui => JSON.stringify([home(), ui.sessionId, ui.activeTab, ui.nextSession?.id, cwdFor(ui), ui.tui?.cwd, ui.tui?.panel, ui.skillScope]);
const fail = () => { throw new Error('This Library entry or terminal changed. Reopen its menu before removing it.'); };
const panels = { skill: 'skills', agent: 'agents', workflow: 'workflows', goal: 'goals' };

export function libraryEntryMenu(ui, kind, entry, openAction) {
  const fields = ['id', 'name', 'objective', 'scope', 'revision', 'version'];
  return { kind, context: context(ui), entry: Object.fromEntries(fields.filter(field => entry[field] !== undefined).map(field => [field, entry[field]])), openAction };
}
export function assertLibraryMenu(ui, menu) {
  // Check the host before reading a session from a different private database.
  if (!menu || !Object.hasOwn(panels, menu.kind) || home() !== JSON.parse(menu.context)[0] || ui.closed || ui.coreLifecycleInterrupted || context(ui) !== menu.context) fail();
}
export function prepareLibraryRemoval(ui, menu) {
  assertLibraryMenu(ui, menu);
  const request = { id: randomUUID(), menu: structuredClone(menu) };
  ui.libraryRemovalRequest = request;
  return request.id;
}
function currentEntry(ui, menu) {
  assertLibraryMenu(ui, menu);
  const shown = menu.entry;
  if (menu.kind === 'goal') return getSavedGoalTemplate(shown.id, { revision: shown.revision });
  const cwd = cwdFor(ui), options = { scope: shown.scope, cwd, projectRoot: cwd };
  const current = menu.kind === 'skill' ? inspectSkill(shown.id, options)
    : menu.kind === 'agent' ? getSubagentDefinition(shown.name, options) : getWorkflow(shown.name, options);
  if (current.id !== shown.id || current.revision !== shown.revision || current.version !== shown.version || current.scope !== shown.scope) fail();
  return current;
}

export async function removeLibraryEntry(ui, requestId) {
  const request = ui.libraryRemovalRequest;
  if (!request || request.id !== requestId) fail();
  delete ui.libraryRemovalRequest;
  const menu = request.menu, shown = currentEntry(ui, menu);
  const description = menu.kind === 'goal' ? 'Remove this saved objective from Library. Running goals, chat history and evidence stay intact.'
    : menu.kind === 'workflow' ? `Remove this ${shown.scope} workflow. Existing goals keep their pinned instructions. If selected, choose None or another workflow before starting a new goal.`
      : `Remove this ${shown.scope} ${menu.kind} from future discovery. Loaded instructions, existing invocations, history and source files are retained.`;
  const answer = await ui.chooseOne(`Remove ${shown.name || 'saved goal'}?`, { description: menu.kind === 'goal' ? `Saved goal ${shown.id.slice(-12)}\n${shown.objective}\n\n${description}` : description, choices: [
    { value: 'cancel', label: 'Cancel', selected: true }, { value: 'remove', label: 'Remove from Library' },
  ] }, { scope: 'library-removal', presentation: 'dropdown' });
  if (answer !== 'remove') return false;
  currentEntry(ui, menu);
  const cwd = cwdFor(ui), options = { scope: shown.scope, cwd, projectRoot: cwd, expectedRevision: shown.revision };
  if (menu.kind === 'skill') deleteSkill(shown.id, shown.revision, options);
  else if (menu.kind === 'agent') deleteSubagentDefinition(shown.name, options);
  else if (menu.kind === 'workflow') deleteWorkflow(shown.name, options);
  else deleteGoalTemplate(shown.id, { revision: shown.revision });
  const prefix = { skill: 'skill', agent: 'subagent', workflow: 'workflow', goal: 'goal' }[menu.kind];
  ui[prefix + 'Preview'] = null; ui[prefix + 'Offset'] = 0;
  if (menu.kind === 'skill') ui.skillHistoryState = null;
  if (menu.kind === 'workflow') ui.workflowPreviewContext = null;
  if (ui.tui) {
    const key = { skill: 'skill', agent: 'agent', workflow: 'workflow', goal: 'goal' }[menu.kind];
    ui.tui.bodyCache = null; ui.tui[key + 'Focus'] = 0; ui.tui[key + 'TopRequested'] = true; ui.tui[key + 'EnsureFocus'] = true; ui.tui.schedule();
  }
  ui.event('info', { message: `Removed ${shown.name || 'saved goal'} from Library. Chat history and evidence were retained.` });
  return true;
}
