import { chooseProvider, setDefault } from './providers.js';
import { assertModelIdle, chooseModel } from './models.js';
import { changeSessionModel, changeSessionProvider } from './runtime-client.js';

export async function changeConversationProvider(source, argument, ui, connection) {
  if (!source) throw new Error('No conversation selected.');
  if (source.parentSessionId || source.mode === 'parallel') throw new Error('Choose providers before starting a group. Use /models to change the selected agent’s model.');
  assertModelIdle(source);
  const provider = await chooseProvider(source.provider, argument, ui);
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
  if (!source.mode || source.mode === 'solo') setDefault(provider.id);
  return session;
}
