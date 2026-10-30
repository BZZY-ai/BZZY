import { chooseUnifiedModel, chooseSavedModel } from './model-controls.js';
import { chooseProvider } from './providers.js';
import { assertModelIdle, chooseModel, modelEffortCapabilities } from './models.js';
import { changeSessionModel, changeSessionProvider, changeSessionSelection } from './runtime-client.js';

export async function changeConversationProvider(source, argument, ui, connection) {
  if (!source) throw new Error('No conversation selected.');
  if (source.parentSessionId || source.mode === 'parallel') throw new Error('Choose providers before starting a group. Use /models to change the selected agent’s model.');
  assertModelIdle(source);
  if (!argument || argument === '@saved') {
    const selected = await (argument === '@saved' ? chooseSavedModel(source, ui, { selectionOnly: true }) : chooseUnifiedModel(source, ui));
    if (!selected) return null;
    if (argument === '@saved') {
      const capabilities = await modelEffortCapabilities({ ...source, provider: selected.provider, model: selected.model,
        modelCapabilities: source.provider === selected.provider && source.model === selected.model ? source.modelCapabilities : null });
      if (selected.effort !== 'default' && (capabilities.supportsEffort === false || capabilities.supportedEfforts?.length && !capabilities.supportedEfforts.includes(selected.effort))) throw new Error('This saved effort is no longer supported. Configure the model again.');
      selected.capabilities = capabilities;
    }
    const provider = (await import('./providers.js')).getProvider(selected.provider);
    if (provider.auth === 'api-key') await (await import('./providers.js')).ensureApiKey(provider, ui);
    return provider.id === source.provider ? changeSessionSelection(source.id, selected, ui, connection) : changeSessionProvider(source, provider, selected, ui, connection);
  }
  const provider = await chooseProvider(source.provider, argument === '@provider' ? '' : argument, ui);
  if (!provider) return null;
  if (provider.id === source.provider) return changeSessionModel(source.id, '', ui, connection);
  const candidate = { provider: provider.id, backend: provider.backend, cwd: source.cwd, model: provider.model || null, backendHomes: source.backendHomes };
  let selected;
  try {
    ui.updateSession?.({ ...source, ...candidate, selectedEffort: null, reasoningEffort: null, resolvedModel: null, goal: null });
    selected = await chooseModel(candidate, '', ui);
  } finally { ui.updateSession?.(source); }
  if (!selected) return null;
  const session = await changeSessionProvider(source, provider, selected, ui, connection);
  return session;
}
