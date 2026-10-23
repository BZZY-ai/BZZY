export * from '@bzzy/core/engine/providers.js';
import { apiKey, saveKey, providers, getProvider } from '@bzzy/core/engine/providers.js';

export async function ensureApiKey(provider, ui, { optional = false } = {}) {
  try { return apiKey(provider); }
  catch (error) {
    if (!ui.interactive) throw error;
    const key = (await ui.secret(`${provider.name} API key (${optional ? 'optional; Enter to skip; hidden' : 'hidden'}): `))?.trim();
    if (!key && optional) return null;
    if (!key) throw new Error('API key setup cancelled.');
    if (/\s|[\x00-\x1f\x7f]/.test(key)) throw new Error('API keys must not contain whitespace or control characters.');
    saveKey(provider.id, key);
    ui.event('info', { message: `${provider.name} API key saved locally with owner-only permissions.` });
    return key;
  }
}

export async function chooseProvider(current, argument, ui, { title = 'Choose provider', description } = {}) {
  const entries = Object.values(providers());
  const selected = argument || await ui.chooseOne(title, entries.map(provider => ({
    value: provider.id, label: provider.id === 'codex' ? 'Codex · ChatGPT subscription' : provider.id === 'claude' ? 'Claude · Claude subscription' : provider.name,
    selected: provider.id === current,
    description: description || (provider.auth === 'subscription' ? 'Use the existing subscription login. Your conversation carries over to the selected provider.'
      : 'Use your API key, with a setup prompt if needed. Your conversation carries over to the selected provider.'),
  })));
  if (selected == null) return null;
  const provider = getProvider(selected);
  if (provider.auth === 'api-key') await ensureApiKey(provider, ui);
  return provider;
}
