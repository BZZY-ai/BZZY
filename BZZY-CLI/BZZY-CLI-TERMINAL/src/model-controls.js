import { providers, getProvider } from './providers.js';
import { availableModels, normalizeModel } from './models.js';

// Catalogs belong to Core. No model/provider list is hardcoded into the TUI.
export async function chooseUnifiedModel(current, ui, { title = 'Choose model' } = {}) {
  const abort = new AbortController();
  const selections = new Map();
  try {
    const choices = Promise.allSettled(Object.values(providers()).map(async provider => {
      const catalog = await availableModels({ ...current, provider: provider.id, backend: provider.backend, engineHome: provider.id === current.provider ? current.engineHome : null }, { signal: abort.signal });
      const models = [...catalog.models];
      if (current.provider === provider.id && current.model && !models.some(model => model.id === current.model)) models.unshift({ id: current.model, name: current.model });
      const entries = [{ id: null, name: 'Provider default', capabilities: null }, ...models];
      return entries.map(model => {
        const value = JSON.stringify([provider.id, model.id]);
        selections.set(value, { provider: provider.id, model: model.id ?? provider.model ?? null, capabilities: model.capabilities || null });
        return { value, label: `${provider.name} · ${model.name || model.id}`, description: model.description || catalog.description,
          selected: current.provider === provider.id && !current.modelSelectionRequired && (current.model || null) === model.id,
          supportsEffort: model.capabilities?.supportsEffort, efforts: model.capabilities?.supportedEfforts || [],
          effort: current.provider === provider.id && current.model === model.id ? current.selectedEffort || 'default' : 'default' };
      });
    })).then(results => ({ selectEffort: true, choices: [...results.flatMap(result => result.status === 'fulfilled' ? result.value : []), { value: '@custom', label: 'Enter provider and model…' }],
      description: 'Choose a model from any Core provider. Effort applies to the next turn; Save keeps the CLI default.' }));
    const chosen = await ui.chooseOne(title, choices);
    if (!chosen) return null;
    const value = typeof chosen === 'object' ? chosen.value : chosen;
    if (value === '@custom') {
      const selectedProvider = await ui.chooseOne('Provider', Object.values(providers()).map(provider => ({ value: provider.id, label: provider.name })));
      if (!selectedProvider) return null;
      const input = (await ui.ask('Model ID · Esc cancels'))?.trim();
      if (!input) return null;
      return { provider: getProvider(selectedProvider).id, model: normalizeModel(getProvider(selectedProvider), input), effort: 'default', capabilities: null };
    }
    const selected = selections.get(value);
    if (!selected) throw new Error('Choose a model from the current Core catalog.');
    const effort = chosen.effort || 'default';
    if (effort !== 'default' && (selected.capabilities?.supportsEffort === false || !selected.capabilities?.supportedEfforts?.includes(effort))) throw new Error('Choose an effort supported by this model.');
    return { ...selected, effort };
  } finally { abort.abort(); }
}

export async function chooseEffort(session, ui) {
  if (session.modelSelectionRequired) throw new Error('Select a model before choosing its effort.');
  let capabilities = session.modelCapabilities;
  if (!capabilities) {
    const catalog = await availableModels(session);
    capabilities = catalog.models.find(model => model.id === (session.model || session.resolvedModel))?.capabilities;
  }
  const efforts = capabilities?.supportsEffort === false ? [] : capabilities?.supportedEfforts || [];
  const effort = await ui.chooseOne('Reasoning effort', ['default', ...new Set(efforts)].map(value => ({ value, label: value, selected: value === (session.selectedEffort || 'default') })));
  return effort ? { model: session.model, effort, capabilities: capabilities || null } : null;
}
