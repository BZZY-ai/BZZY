import { listSubagentDefinitions, getSubagentDefinition, saveSubagentDefinition, deleteSubagentDefinition, setSubagentEnabled } from '@bzzy/core/engine/subagent-definitions.js';
import { home, loadSession } from '@bzzy/core/engine/store.js';
import { listSubagentRuns, subagentStatus } from '@bzzy/core/engine/subagents.js';
import { compactAssignmentStatus } from '@bzzy/core/engine/assignment-views.js';
import { chooseProvider } from './providers.js';
import { chooseModel } from './models.js';
import { creatorRows, startCreator, saveCreator } from './definition-creator-ui.js';
import { bundleLibraryRows, definitionBundleRows, definitionBundleAction, cancelDefinitionBundle } from './definition-bundle-ui.js';
import { libraryToggleRow } from './library-toggle-ui.js';
import { openWorkflows } from './workflow-ui.js';

const definitionFields = ['name', 'description', 'instructions', 'provider', 'model', 'effort', 'policy', 'limits'];
const cwdFor = ui => (ui.sessionId && loadSession(ui.sessionId)?.cwd) || ui.tui?.cwd || process.cwd();
const contextKey = ui => JSON.stringify([home(), ui.sessionId || null, cwdFor(ui)]);
const reset = ui => { cancelDefinitionBundle(ui, 'agents'); ui.subagentCreatorDraft = null; ui.subagentPreview = null; ui.subagentOffset = 0; ui.subagentView = 'library'; ui.subagentRunId = null; ui.subagentRunOffset = 0; };
const selectionLabel = agent => agent.provider || agent.model || agent.effort
  ? `${agent.provider || 'current provider'} · ${agent.model || 'provider default'} · ${agent.effort || 'default effort'}`
  : 'Inherit the invoking chat’s provider, model and effort';

async function prompt(ui, method, ...args) {
  const context = contextKey(ui), result = await ui[method](...args);
  if (contextKey(ui) !== context) throw new Error('Conversation changed. Reopen Agents for this project.');
  return result;
}

export function subagentRows(ui) {
  const context = contextKey(ui);
  if (ui.subagentAdminContext && ui.subagentAdminContext !== context) reset(ui);
  const bundle = definitionBundleRows(ui, 'agents');
  if (bundle) return bundle;
  const creator = creatorRows(ui, 'subagent');
  if (creator) return creator;
  const parent = ui.sessionId && loadSession(ui.sessionId);
  if (ui.subagentView === 'runs' && parent) {
    const page = listSubagentRuns(parent, { offset: ui.subagentRunOffset || 0, limit: 10 });
    const rows = [{ text: 'INVOCATIONS IN THIS CHAT', tone: 'accent' },
      { text: 'Worker reports are claims until their evidence has been reviewed.', tone: 'muted' }, { text: '' }];
    for (const run of page.items) rows.push({ text: `${run.name} · ${run.round?.state || run.closure || 'unknown'} · round ${run.currentRound}`,
      action: 'run:' + run.id, tone: 'accent' },
    { text: run.round?.summary || run.round?.reason || run.round?.error || 'Waiting for a worker report.', tone: 'muted' });
    if (!page.items.length) rows.push({ text: 'No specialist invocations in this chat yet.', tone: 'muted' });
    if (ui.subagentRunOffset) rows.push({ text: 'Previous invocations', action: 'runs-previous' });
    if (page.nextOffset != null) rows.push({ text: 'More invocations', action: 'runs-next' });
    return [...rows, { text: 'Back to agents', action: 'library' }];
  }
  if (ui.subagentView === 'run' && parent && ui.subagentRunId) {
    try {
      const job = subagentStatus(parent, ui.subagentRunId), run = compactAssignmentStatus(job), round = run.round;
      return [{ text: `${job.subagentDefinition.name} · revision ${job.subagentDefinition.revision}`, tone: 'accent' },
        { text: `State: ${round?.state || 'unknown'} · review: ${run.closure} · round ${run.currentRound}` },
        { text: selectionLabel(run.selection || {}), tone: 'muted' },
        { text: job.contract.objective }, { text: '' },
        { text: round?.summary || round?.reason || round?.error || 'No worker report yet.' },
        ...(round?.report?.uncertainties || []).map(value => ({ text: 'Uncertainty: ' + value, tone: 'muted' })),
        ...(round?.artifacts || []).map(item => ({ text: `${item.label} · ${item.id}`, tone: 'muted' })),
        { text: '' }, { text: 'Worker claims do not establish verified completion.', tone: 'muted' },
        { text: 'Back to invocations', action: 'runs' }, { text: 'Back to agents', action: 'library' }];
    } catch {
      return [{ text: 'This invocation is no longer available in this chat.', tone: 'muted' }, { text: 'Back to agents', action: 'library' }];
    }
  }
  if (ui.subagentPreview) {
    const shown = ui.subagentPreview;
    return [{ text: `${shown.name} · ${shown.scope} · revision ${shown.revision}`, tone: 'accent' },
      { text: shown.description }, { text: selectionLabel(shown), tone: 'muted' },
      { text: '' }, { text: 'INSTRUCTIONS', tone: 'accent' }, { text: shown.instructions },
      ...(shown.policy ? [{ text: 'Permission limits: ' + JSON.stringify(shown.policy), tone: 'muted' }] : []),
      ...(shown.limits ? [{ text: 'Execution limits: ' + JSON.stringify(shown.limits), tone: 'muted' }] : []),
      { text: '' }, { text: shown.enabled !== false ? 'ON · available to models' : 'OFF · unavailable to models', tone: shown.enabled !== false ? 'accent' : 'muted' },
      { text: shown.enabled !== false ? 'Turn OFF for all models' : 'Turn ON for all models', action: 'toggle', tone: 'accent' },
      { text: 'Use in chat', ...(shown.enabled !== false ? { action: 'use', tone: 'accent' } : { tone: 'muted' }) },
      { text: 'Edit specialist', action: 'edit' }, { text: 'Delete specialist', action: 'delete' },
      { text: 'Back to agents', action: 'library' }];
  }
  const page = listSubagentDefinitions({ cwd: cwdFor(ui), offset: ui.subagentOffset || 0, limit: 20 });
  const rows = [{ text: 'AGENTS · reusable specialists', tone: 'accent' },
    { text: 'Use these specialists from any supported chat model or goal.', tone: 'muted' },
    { text: 'Click ON/OFF · ↑/↓ or Tab select · Space toggles · Enter opens', tone: 'muted' },
    { text: 'Workflows / pre-prompts', action: 'workflows', tone: 'accent' },
    { text: 'Agent Creator · use current model', action: 'creator', tone: 'accent' },
    { text: 'Create specialist manually', action: 'create' },
    ...bundleLibraryRows(),
    ...(parent ? [{ text: 'View invocations in this chat', action: 'runs' }] : []), { text: '' }];
  ui.subagentLibraryContext = context;
  ui.subagentLibraryEntries = new Map(page.subagents.map(agent => [`${agent.scope}:${agent.name}`, { ...agent }]));
  for (const agent of page.subagents) {
    rows.push(libraryToggleRow({ name: agent.name, scope: agent.scope, enabled: agent.enabled !== false,
      viewAction: `view:${agent.scope}:${agent.name}`,
      toggleAction: `toggle-row:${agent.scope}:${agent.name}:${agent.revision}:${agent.enabled !== false ? '1' : '0'}` }, ui.tui?.output?.columns || 80),
      { text: agent.description }, { text: selectionLabel(agent), tone: 'muted' }, { text: '' });
  }
  if (!page.subagents.length) rows.push({ text: 'No specialists created yet.', tone: 'muted' },
    { text: 'For example: an HTTP response analyst, XSS tester or IDOR reviewer.', tone: 'muted' });
  if (ui.subagentOffset) rows.push({ text: 'Previous page', action: 'previous' });
  if (page.nextOffset != null) rows.push({ text: 'Next page', action: 'next' });
  return rows;
}

async function editDefinition(ui, existing) {
  const name = existing?.name || (await prompt(ui, 'ask', 'Specialist name · lowercase words separated by hyphens · Esc cancels'))?.trim();
  if (!name) return;
  const description = (await prompt(ui, 'ask', 'When should BZZY use this specialist?', { initialValue: existing?.description || '' }))?.trim();
  if (!description) return;
  const instructions = (await prompt(ui, 'ask', 'Specialist instructions · Shift+Enter adds lines · use account references, never secrets', { initialValue: existing?.instructions || '' }))?.trim();
  if (!instructions) return;
  const scope = existing?.scope || await prompt(ui, 'chooseOne', 'Where should this specialist be available?', [
    { value: 'project', label: 'This project', selected: true },
    { value: 'global', label: 'All projects', description: 'Store generic reusable instructions without private project data.' },
  ]);
  if (!scope) return;
  const modelMode = await prompt(ui, 'chooseOne', 'Model for this specialist', [
    { value: 'inherit', label: 'Use the invoking chat’s model', description: 'Works across supported providers and model changes.', selected: !existing?.provider && !existing?.model && !existing?.effort },
    { value: 'fixed', label: 'Choose a provider and model', selected: Boolean(existing?.provider || existing?.model || existing?.effort) },
  ]);
  if (!modelMode) return;
  const input = Object.fromEntries(definitionFields.filter(field => existing?.[field] !== undefined).map(field => [field, existing[field]]));
  Object.assign(input, { name, description, instructions });
  delete input.provider; delete input.model; delete input.effort;
  if (modelMode === 'fixed') {
    const session = ui.sessionId && loadSession(ui.sessionId);
    const provider = await prompt(ui, 'chooseProvider', existing?.provider || session?.provider || 'codex', '', ui,
      { title: 'Specialist provider' });
    if (!provider) return;
    const selection = await prompt(ui, 'chooseModel', { provider: provider.id, cwd: cwdFor(ui),
      model: existing?.provider === provider.id ? existing.model : null,
      selectedEffort: existing?.effort }, '', ui, { title: 'Specialist model' });
    if (!selection) return;
    input.provider = provider.id;
    if (selection.model) input.model = selection.model;
    if (selection.effort) input.effort = selection.effort;
  }
  const saved = saveSubagentDefinition(input, { cwd: cwdFor(ui), scope, expectedRevision: existing?.revision || 0 });
  ui.subagentPreview = saved;
  ui.event('info', { message: `Saved ${saved.name}. It is available to supported models; saving starts no execution.` });
}

export async function subagentsCommand(text, ui, { generateDefinition, bundleApi } = {}) {
  const match = /^\/(?:agents|subagents)(?:\s+(.*))?$/.exec(text.trim());
  if (!match) return false;
  ui.openTerminal();
  if (!ui.tui) { ui.event('error', { message: 'Open the interactive terminal to manage specialists, or use bzzy subagents.' }); return true; }
  const context = contextKey(ui);
  if (ui.subagentAdminContext && ui.subagentAdminContext !== context) reset(ui);
  ui.tui.setPanel('agents');
  const action = match[1]?.trim() || '';
  const originalProviderPicker = ui.chooseProvider, originalModelPicker = ui.chooseModel;
  ui.chooseProvider ||= chooseProvider; ui.chooseModel ||= chooseModel;
  try {
    if (action === 'workflows') await openWorkflows(ui, { origin: 'agents' });
    else if (action.startsWith('bundle-')) {
      if (['bundle-export', 'bundle-import'].includes(action)) reset(ui);
      await definitionBundleAction(action, ui, 'agents', { api: bundleApi });
    }
    else if (!action || action === 'library') reset(ui);
    else if (action === 'create') await editDefinition(ui);
    else if (action === 'creator') { reset(ui); await startCreator(ui, 'subagent', { generate: generateDefinition }); }
    else if (action === 'creator-cancel') ui.cancelDefinitionAuthoring?.();
    else if (action === 'creator-save') ui.subagentPreview = saveCreator(ui, 'subagent');
    else if (action === 'runs') { ui.subagentView = 'runs'; ui.subagentRunId = null; ui.subagentRunOffset = 0; }
    else if (action.startsWith('run:')) { ui.subagentRunId = action.slice(4); ui.subagentView = 'run'; }
    else if (action === 'runs-next' || action === 'runs-previous') ui.subagentRunOffset = Math.max(0, (ui.subagentRunOffset || 0) + (action === 'runs-next' ? 10 : -10));
    else if (action === 'next' || action === 'previous') ui.subagentOffset = Math.max(0, (ui.subagentOffset || 0) + (action === 'next' ? 20 : -20));
    else if (action.startsWith('toggle-row:')) {
      const [scope, name, revision, enabled] = action.slice(11).split(':'), shown = ui.subagentLibraryEntries?.get(`${scope}:${name}`);
      if (ui.subagentLibraryContext !== contextKey(ui) || !shown || shown.revision !== Number(revision) || String(shown.enabled !== false ? 1 : 0) !== enabled)
        throw new Error('The library changed. Refresh the specialist before toggling it.');
      const current = getSubagentDefinition(name, { cwd: cwdFor(ui), scope });
      if (current.id !== shown.id || current.revision !== shown.revision || current.version !== shown.version || (current.enabled !== false) !== (shown.enabled !== false))
        throw new Error('Specialist changed. Refresh the library before toggling it.');
      const saved = setSubagentEnabled(name, shown.enabled === false, { cwd: cwdFor(ui), scope, expectedRevision: shown.revision });
      ui.event('info', { message: `${name} is ${saved.enabled ? 'ON · available to models' : 'OFF · unavailable to models'} in ${scope} scope.` });
    }
    else if (action.startsWith('view:')) {
      const [, scope, name] = action.split(':');
      ui.subagentView = 'library';
      ui.subagentPreview = getSubagentDefinition(name, { cwd: cwdFor(ui), scope });
    } else if (['edit', 'delete', 'use', 'toggle'].includes(action)) {
      const shown = ui.subagentPreview;
      if (!shown) throw new Error('Choose a specialist from Agents first.');
      const current = getSubagentDefinition(shown.name, { cwd: cwdFor(ui), scope: shown.scope });
      if (current.id !== shown.id || current.revision !== shown.revision) throw new Error('This specialist changed. Reopen it before acting.');
      if (action === 'edit') await editDefinition(ui, shown);
      else if (action === 'toggle') ui.subagentPreview = setSubagentEnabled(shown.name, shown.enabled === false, { cwd: cwdFor(ui), scope: shown.scope, expectedRevision: shown.revision });
      else if (action === 'delete') {
        const answer = await prompt(ui, 'chooseOne', `Delete ${shown.name}?`, [
          { value: 'cancel', label: 'Cancel', selected: true }, { value: 'delete', label: 'Delete specialist' },
        ]);
        if (answer === 'delete') { deleteSubagentDefinition(shown.name, { cwd: cwdFor(ui), scope: shown.scope, expectedRevision: shown.revision }); reset(ui); }
      } else {
        if (shown.enabled === false) throw new Error('Turn this specialist ON before using it in chat.');
        const task = (await prompt(ui, 'ask', `Task for ${shown.name} · draft only, press Send when ready`))?.trim();
        if (task) {
          ui.tui.setPanel('chat');
          const request = `Use subagent ${shown.name} for this task: ${task}`;
          ui.tui.value = ui.tui.value.trim() ? ui.tui.value + '\n\n' + request : request;
          ui.tui.cursor = [...ui.tui.value].length;
        }
      }
    } else throw new Error('Choose an action from Agents, or use /agents to open the library.');
  } catch (error) { ui.event('error', { message: error.message }); }
  finally {
    if (originalProviderPicker === undefined) delete ui.chooseProvider;
    if (originalModelPicker === undefined) delete ui.chooseModel;
    ui.subagentAdminContext = contextKey(ui);
    ui.tui.bodyCache = null;
    if (!action.startsWith('toggle-row:')) { ui.tui.scroll = 0; ui.tui.agentFocus = 0; ui.tui.agentTopRequested = true; }
    ui.tui.schedule();
  }
  return true;
}
