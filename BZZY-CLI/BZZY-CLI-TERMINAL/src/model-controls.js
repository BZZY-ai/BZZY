import { providers, getProvider, providerEffortPolicy, providerEffortCapabilities, config, updateConfig, selectionFromSession } from './providers.js';
import { availableModels, normalizeModel, modelEffortCapabilities } from './models.js';

export function savedModelCombinations() {
  const entries = config().terminalModelCombinations;
  return (Array.isArray(entries) ? entries : []).filter(item => item && typeof item.name === 'string' && item.name.length <= 80
    && typeof item.provider === 'string' && Object.hasOwn(providers(), item.provider)
    && (item.model == null || typeof item.model === 'string' && item.model.length <= 200 && !/[\s\x00-\x1f]/u.test(item.model))
    && typeof item.effort === 'string' && /^[a-z][a-z0-9_-]{0,23}$/.test(item.effort)).slice(0, 50);
}

// Uses Core's locked private configuration writer. Presets contain selection
// identifiers only; account bindings and credentials never enter this list.
export async function chooseSavedModel(current, ui, { allowSelection = true } = {}) {
  while (true) {
    const saved = savedModelCombinations();
    const selected = await ui.chooseOne('Saved model combinations', [
      ...saved.map((item, index) => ({ value: String(index), label: item.name, disabled: !allowSelection, description: `${item.provider} · ${item.model || 'Provider default'} · ${item.effort}` })),
      { value: '@save', label: '＋ Save current combination', disabled: current.modelSelectionRequired, description: 'Give this provider, model and effort a reusable name.' },
      { value: '@configure', label: 'Choose another provider / model…', disabled: !allowSelection, description: allowSelection ? '' : 'Pause the response before switching. Saving stays available.' },
      ...(saved.length ? [{ value: '@remove', label: 'Remove saved combination…' }] : []),
    ], { presentation: 'dropdown', kind: 'model', scope: 'chat' });
    if (selected == null) return null;
    if (selected === '@configure' && allowSelection) return chooseUnifiedModel(current, ui);
    if (selected === '@save') {
      const label = await ui.ask('Save combination as · Esc cancels', { initialValue: `${current.provider} ${current.model || 'default'} ${current.selectedEffort || 'default'}` });
      if (label == null) continue;
      const name = label.trim();
      if (!name || name.length > 80 || /[\x00-\x1f\x7f-\x9f]/u.test(name)) throw new Error('Use a name of 1–80 printable characters.');
      const { provider, model, effort } = selectionFromSession(current);
      updateConfig(value => {
        const rows = Array.isArray(value.terminalModelCombinations) ? value.terminalModelCombinations : [];
        if (rows.some(item => item.name === name)) throw new Error('A combination already has that name. Remove it first or choose another name.');
        if (rows.length >= 50) throw new Error('Remove a saved combination before adding another.');
        value.terminalModelCombinations = [...rows, { name, provider, model, effort }]; return value;
      });
      continue;
    }
    if (selected === '@remove') {
      const name = await ui.chooseOne('Remove saved combination', saved.map(item => ({ value: item.name, label: item.name })), { presentation: 'dropdown' });
      if (name) updateConfig(value => { value.terminalModelCombinations = (value.terminalModelCombinations || []).filter(item => item.name !== name); return value; });
      continue;
    }
    const item = saved[Number(selected)];
    if (allowSelection && item && String(Number(selected)) === selected) return { provider: item.provider, model: item.model, effort: item.effort, capabilities: null };
  }
}

// Catalogs belong to Core. No model/provider list is hardcoded into the TUI.
export async function chooseUnifiedModel(current, ui, { title = 'Choose model', scope = 'chat', anchor } = {}) {
  const abort = new AbortController();
  const selections = new Map();
  try {
    const choices = Promise.allSettled(Object.values(providers()).map(async provider => {
      const catalog = await availableModels({ ...current, provider: provider.id, backend: provider.backend, engineHome: provider.id === current.provider ? current.engineHome : null }, { signal: abort.signal });
      const models = [...catalog.models];
      if (current.provider === provider.id && current.model && !models.some(model => model.id === current.model)) models.unshift({ id: current.model, name: current.model,
        ...(current.modelCapabilities ? { capabilities: structuredClone(current.modelCapabilities) } : {}) });
      const entries = [{ id: null, name: 'Provider default', capabilities: null }, ...models], effortPolicy = providerEffortPolicy(provider);
      return entries.map(model => {
        const value = JSON.stringify([provider.id, model.id]);
        selections.set(value, { provider: provider.id, model: model.id ?? provider.model ?? null, capabilities: model.capabilities || null });
        return { value, label: `${provider.name} · ${model.name || model.id}`, description: model.description || catalog.description,
          selected: current.provider === provider.id && !current.modelSelectionRequired && (current.model || null) === model.id,
          supportsEffort: effortPolicy ? true : model.capabilities?.supportsEffort, efforts: effortPolicy?.levels || model.capabilities?.supportedEfforts || [],
          effort: current.provider === provider.id && current.model === model.id ? current.selectedEffort || 'default' : 'default' };
      });
    })).then(results => ({ choices: [...results.flatMap(result => result.status === 'fulfilled' ? result.value : []), { value: '@custom', label: 'Enter provider and model…' }],
      description: 'Choose a model. Its supported reasoning levels appear in the adjacent Effort dropdown.' }));
    const chosen = await ui.chooseOne(title, choices, { presentation: 'dropdown', kind: 'model', scope, anchor });
    if (!chosen) return null;
    const value = typeof chosen === 'object' ? chosen.value : chosen;
    if (value === '@custom') {
      const selectedProvider = await ui.chooseOne('Provider', Object.values(providers()).map(provider => ({ value: provider.id, label: provider.name })), { presentation: 'dropdown', kind: 'model', scope });
      if (!selectedProvider) return null;
      const input = (await ui.ask('Model ID · Esc cancels'))?.trim();
      if (!input) return null;
      return { provider: getProvider(selectedProvider).id, model: normalizeModel(getProvider(selectedProvider), input), effort: 'default', capabilities: null };
    }
    const selected = selections.get(value);
    if (!selected) throw new Error('Choose a model from the current Core catalog.');
    const previous = selected.provider === current.provider && selected.model === current.model ? current.selectedEffort || current.effort || 'default' : 'default';
    const effort = typeof chosen === 'object' ? chosen.effort || previous : previous;
    const provider = getProvider(selected.provider), capabilities = providerEffortPolicy(provider)
      ? providerEffortCapabilities(provider, selected.model, selected.capabilities) : selected.capabilities;
    if (effort !== 'default' && (capabilities?.supportsEffort === false || !capabilities?.supportedEfforts?.includes(effort))) throw new Error('Choose an effort supported by this model.');
    return { ...selected, effort };
  } finally { abort.abort(); }
}

export async function chooseEffort(session, ui, { scope = 'chat', anchor } = {}) {
  if (session.modelSelectionRequired) throw new Error('Select a model before choosing its effort.');
  const abort = new AbortController(); let capabilities;
  try {
    const choices = (async () => {
      capabilities = await modelEffortCapabilities(session, { signal: abort.signal });
      const efforts = capabilities?.supportsEffort === false ? [] : capabilities?.supportedEfforts || [];
      return { description: providerEffortPolicy(getProvider(session.provider))?.description || (capabilities?.supportsEffort === false ? 'This model does not support adjustable reasoning effort.' : 'Only reasoning levels supported by the selected model are listed.'),
        choices: [...new Set(['default', ...efforts])].map(value => ({ value, label: value === 'default' ? 'Default · model decides' : value[0].toUpperCase() + value.slice(1), selected: value === (session.selectedEffort || 'default') })) };
    })();
    const effort = await ui.chooseOne('Reasoning effort', choices, { presentation: 'dropdown', kind: 'effort', scope, anchor });
    if (effort && effort !== 'default' && (capabilities?.supportsEffort === false || !capabilities?.supportedEfforts?.includes(effort))) throw new Error('Choose an effort supported by this model.');
    return effort ? { model: session.model, effort, capabilities: capabilities || null } : null;
  } finally { abort.abort(); }
}
