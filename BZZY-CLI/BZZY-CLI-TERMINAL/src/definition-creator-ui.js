import { captureDefinitionContext, assertDefinitionContext, authorDefinition, saveAuthoredDefinition } from '@bzzy/core/engine/definition-authoring.js';

const fieldFor = kind => kind === 'skill' ? 'skillCreatorDraft' : 'subagentCreatorDraft';
const titleFor = kind => kind === 'skill' ? 'Skill Creator' : 'Agent Creator';
const refresh = ui => { if (ui.tui) { ui.tui.bodyCache = null; ui.tui.schedule(); } };
const label = selection => `${selection.provider} · ${selection.model || 'provider default'} · ${selection.effort} effort`;

export function creatorRows(ui, kind) {
  const running = ui.definitionAuthoring;
  if (running?.kind === kind) return [{ text: titleFor(kind), tone: 'accent' },
    { text: 'Generating with ' + label(running.context.selection), tone: 'muted' },
    { text: 'Esc cancels generation. Review and Save when ready.' }, { text: 'Cancel generation', action: 'creator-cancel' }];
  const draft = ui[fieldFor(kind)];
  if (!draft) return null;
  try { assertDefinitionContext(draft.context, ui.sessionId); }
  catch {
    ui[fieldFor(kind)] = null;
    return [{ text: 'The conversation or selected model changed. Generate a new draft with its current model.', tone: 'warning' },
      { text: 'Back to library', action: 'library' }];
  }
  return [{ text: `${titleFor(kind)} · review`, tone: 'accent' },
    { text: `${draft.definition.name} · ${draft.scope}` }, { text: 'Created with ' + label(draft.context.selection), tone: 'muted' },
    { text: draft.definition.description }, { text: '' }, { text: 'INSTRUCTIONS', tone: 'accent' }, { text: draft.definition.instructions },
    { text: '' },
    ...(kind === 'skill' ? [{ text: 'Save adds an inactive skill to the library. Enable it after review.', tone: 'muted' }]
      : [{ text: 'Saved specialists inherit the invoking chat’s model and permissions.', tone: 'muted' }]),
    { text: 'Save to BZZY', action: 'creator-save', tone: 'accent' },
    { text: 'Discard draft', action: 'library' }];
}

export async function startCreator(ui, kind, { generate = authorDefinition } = {}) {
  if (ui.definitionAuthoring) throw new Error('A creator is already generating a draft.');
  const context = captureDefinitionContext(ui.sessionId), initialCwd = ui.tui?.cwd;
  const check = () => {
    if (ui.tui?.cwd !== initialCwd) throw new Error('The terminal project changed. Reopen the creator.');
    return assertDefinitionContext(context, ui.sessionId);
  };
  const prompt = async (method, ...args) => { check(); const result = await ui[method](...args); check(); return result; };
  const name = (await prompt('ask', `${titleFor(kind)} · name · lowercase words separated by hyphens · Esc cancels`))?.trim();
  if (!name) return;
  const purpose = (await prompt('ask', 'What should it do, and when should BZZY use it? · one-line description'))?.trim();
  if (!purpose) return;
  const details = await prompt('ask', 'Inputs, expected output and preferences · Shift+Enter adds lines · never paste secrets');
  if (details == null) return;
  const scope = await prompt('chooseOne', 'Where should it be available?', [
    { value: 'project', label: 'This project', selected: true },
    { value: 'global', label: 'All projects', description: 'Reusable behavior without private project data.' },
  ]);
  if (!scope) return;
  check();
  const controller = new AbortController(), state = { kind, context };
  const cancel = () => {
    if (ui.definitionAuthoring !== state) return false;
    controller.abort(Object.assign(new Error('Creation cancelled.'), { code: 'DOCUMENT_CANCELLED' }));
    return true;
  };
  ui[fieldFor(kind)] = null; ui.definitionAuthoring = state; ui.cancelDefinitionAuthoring = cancel; refresh(ui);
  try {
    const draft = await generate({ kind, context, input: { name, purpose, details: details.trim() }, scope, signal: controller.signal });
    if (controller.signal.aborted) return;
    check(); ui[fieldFor(kind)] = draft;
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    if (ui.definitionAuthoring === state) ui.definitionAuthoring = null;
    if (ui.cancelDefinitionAuthoring === cancel) delete ui.cancelDefinitionAuthoring;
    refresh(ui);
  }
}

export function saveCreator(ui, kind) {
  const field = fieldFor(kind), draft = ui[field];
  const saved = saveAuthoredDefinition(draft, { sourceId: ui.sessionId });
  ui[field] = null;
  ui.event('info', { message: kind === 'skill' ? `Saved ${saved.name} in ${saved.scope} scope. Review it in the library and enable it when ready.`
    : `Saved ${saved.name}. Use it from the Agents library or ask the chat to invoke it.` });
  return saved;
}

// Explicit owner commands authorize creation and immediate availability. Model
// output remains a document; only Core validates and publishes the definition.
export async function createDefinitionCommand(input, ui, { generate = authorDefinition, publish = saveAuthoredDefinition } = {}) {
  const match = /^\/create-(skill|agent)(?:\s+([\s\S]*))?$/.exec(input.trim());
  if (!match) return false;
  let controller, state, monitor, cancel;
  try {
    if (!ui.interactive || ui.json) throw new Error('Use a private interactive BZZY chat for creation.');
    if (ui.definitionAuthoring) throw new Error('A creator is already generating. Wait or press Esc.');
    const kind = match[1] === 'skill' ? 'skill' : 'subagent';
    const context = captureDefinitionContext(ui.activeTab || ui.sessionId), selectedSession = ui.sessionId,
      selectedTab = ui.activeTab, initialCwd = ui.tui?.cwd;
    const check = () => {
      if (ui.closed || ui.coreLifecycleInterrupted || ui.sessionId !== selectedSession || ui.activeTab !== selectedTab || ui.nextSession || ui.tui?.cwd !== initialCwd) {
        throw new Error('The terminal changed. Reopen the creator in the intended chat.');
      }
      return assertDefinitionContext(context, ui.activeTab || ui.sessionId);
    };
    check();
    const name = (await ui.ask(`${titleFor(kind)} · name · lowercase-with-hyphens · Esc cancels`))?.trim();
    check(); if (!name) return true;
    let requirements = match[2]?.trim();
    if (!requirements) { requirements = (await ui.ask('What should it do? · requirements only; never paste secrets'))?.trim(); check(); }
    if (!requirements) return true;
    controller = new AbortController(); state = { kind, context };
    cancel = () => {
      if (ui.definitionAuthoring !== state) return false;
      controller.abort(Object.assign(new Error('Creation cancelled.'), { code: 'DOCUMENT_CANCELLED' })); return true;
    };
    ui.definitionAuthoring = state; ui.cancelDefinitionAuthoring = cancel;
    monitor = setInterval(() => { try { check(); } catch (error) { controller.abort(error); } }, 100);
    ui.event('info', { message: `Creating ${match[1]} with ${label(context.selection)} · Esc cancels.` }); refresh(ui);
    const draft = await generate({ kind, context, scope: 'global', signal: controller.signal,
      input: { name, purpose: [...requirements.split(/\r?\n/)[0]].slice(0, 160).join(''), details: requirements } });
    if (controller.signal.aborted) return true;
    check();
    if (draft.kind !== kind || draft.scope !== 'global' || draft.definition?.name !== name) throw new Error('The generated definition did not match the request.');
    const saved = publish(draft, { sourceId: context.sessionId, activate: true, signal: controller.signal });
    refresh(ui);
    ui.event('info', { message: `Created ${match[1]} “${saved.name}” · BZZY Core · ON. ${kind === 'skill'
      ? `Use $${saved.name} in chat or let the model discover it.`
      : 'Ask the model to invoke it, or select Use in chat from Agents.'} Available for Library sharing. No task started.` });
    return true;
  } catch (error) {
    if (!controller?.signal.aborted) ui.event('error', { message: ['DEFINITION_AUTHORING', 'INVALID_REQUEST', 'DEFINITION_BUNDLE'].includes(error.code)
      ? error.message : 'Creation did not complete. Check the name, portable requirements and selected provider, then retry. Existing entries were kept.' });
    return true;
  } finally {
    clearInterval(monitor);
    if (state && ui.definitionAuthoring === state) ui.definitionAuthoring = null;
    if (cancel && ui.cancelDefinitionAuthoring === cancel) delete ui.cancelDefinitionAuthoring;
    refresh(ui);
  }
}
