import { providers, getProvider, providerEffortPolicy, providerEffortCapabilities } from './providers.js';
import { availableModels, normalizeModel, modelEffortCapabilities } from './models.js';

// Catalogs belong to Core. No model/provider list is hardcoded into the TUI.
export async function chooseUnifiedModel(current, ui, { title = 'Choose model', scope = 'chat', anchor } = {}) {
  const abort = new AbortController();
  const selections = new Map();
  try {
    const choices = Promise.allSettled(Object.values(providers()).map(async provider => {
      const catalog = await availableModels({ ...current, provider: provider.id, backend: provider.backend, engineHome: provider.id === current.provider ? current.engineHome : null }, { signal: abort.signal });
      const models = [...catalog.models];
      if (current.provider === provider.id && current.model && !models.some(model => model.id === current.model)) models.unshift({ id: current.model, name: current.model });
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
