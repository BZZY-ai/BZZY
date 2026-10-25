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
