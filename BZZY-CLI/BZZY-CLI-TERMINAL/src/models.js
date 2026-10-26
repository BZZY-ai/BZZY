export * from '@bzzy/core/engine/models.js';
import { availableModels, normalizeModel } from '@bzzy/core/engine/models.js';
import { getProvider, ensureApiKey, providerEffortPolicy, providerEffortCapabilities } from './providers.js';
const DEFAULT = '@bzzy-default', CUSTOM = '@bzzy-custom';

export async function chooseModel(session, argument, ui, { title, description } = {}) {
  const provider = getProvider(session.provider);
  if (provider.auth === 'api-key') await ensureApiKey(provider, ui);
  if (argument) return { model: normalizeModel(provider, argument), capabilities: null, effort: null };
  const abort = new AbortController(); let catalog;
  try {
    const choices = availableModels(session, { signal: abort.signal }).then(result => {
      catalog = result;
      const selected = session.model || null, current = selected || session.resolvedModel;
      const models = [...result.models], effortPolicy = providerEffortPolicy(provider);
      if (current && !models.some(model => model.id === current)) models.unshift({ id: current, name: current, description: 'Current model · availability not verified by the catalog.' });
      return { selectEffort: true, warning: result.source === 'manual' ? result.description : current && !result.models.some(model => model.id === current)
        ? 'The current model is not listed by this CLI. Choose a listed model or the provider default, or retain the custom ID if your provider supports it.' : null,
        description: description || 'Selection applies to the next message in this conversation.', choices: [
        { value: DEFAULT, label: 'Provider default' + (provider.model ? ' · ' + provider.model : ''), description: 'Use the provider’s configured default model.', selected: !selected },
        ...models.map(model => ({ value: model.id, label: model.name && model.name !== model.id ? `${model.name} · ${model.id}` : model.id, description: model.description, selected: selected === model.id,
          efforts: effortPolicy?.levels || (model.capabilities?.supportsEffort === false ? [] : [...new Set(model.capabilities?.supportedEfforts || [])]), supportsEffort: effortPolicy ? true : model.capabilities?.supportsEffort,
          defaultEffort: effortPolicy ? undefined : model.capabilities?.defaultEffort, effort: selected === model.id && (effortPolicy?.levels || model.capabilities?.supportedEfforts)?.includes(session.selectedEffort) ? session.selectedEffort : 'default' })),
        { value: CUSTOM, label: 'Enter a model ID…', description: result.description || 'Enter any model ID supported by this provider.' },
      ] };
    });
    const choice = await ui.chooseOne(title || 'Choose model · ' + provider.id, choices, { presentation: 'dropdown', kind: 'model' });
    if (choice == null) return null;
    const selected = typeof choice === 'object' ? choice.value : choice;
    const effort = typeof choice === 'object' ? choice.effort || 'default' : null;
    if (selected === CUSTOM) {
      const input = (await ui.ask('Model ID (or default): '))?.trim();
      return input ? { model: normalizeModel(provider, input), capabilities: null, effort: null } : null;
    }
    if (selected === DEFAULT) return { model: normalizeModel(provider, null), capabilities: null, effort };
    const capabilities = catalog.models.find(model => model.id === selected)?.capabilities || null;
    const effortCapabilities = providerEffortPolicy(provider) ? providerEffortCapabilities(provider, selected, capabilities) : capabilities;
    if (effort && effort !== 'default' && (effortCapabilities?.supportsEffort === false || !effortCapabilities?.supportedEfforts?.includes(effort))) throw new Error('Choose a reasoning effort supported by this model.');
    return { model: normalizeModel(provider, selected), capabilities, effort };
  } finally { abort.abort(); }
}
