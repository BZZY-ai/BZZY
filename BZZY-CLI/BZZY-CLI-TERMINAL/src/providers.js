import path from 'node:path';
import { home, readJson, writeJson } from './store.js';

export const BUILTINS = {
  codex: { id: 'codex', name: 'ChatGPT / Codex subscription', backend: 'codex', auth: 'subscription' },
  claude: { id: 'claude', name: 'Claude subscription (official Claude Code)', backend: 'claude', auth: 'subscription' },
  deepseek: {
    id: 'deepseek', name: 'DeepSeek', backend: 'codex', auth: 'api-key',
    baseUrl: 'https://api.deepseek.com', envKey: 'DEEPSEEK_API_KEY',
    model: 'deepseek-flash', contextWindow: 1048576,
    reasoningEffort: 'high', supportedEfforts: ['low', 'high', 'max'],
  },
};

export function config() {
  return readJson(path.join(home(), 'config.json'), { version: 1, defaultProvider: null, providers: {} });
}

export const saveConfig = value => writeJson(path.join(home(), 'config.json'), value);
export const providers = () => ({ ...BUILTINS, ...config().providers });

export function getProvider(id) {
  const provider = providers()[id];
  if (!provider) throw new Error(`Unknown provider ${JSON.stringify(id)}. Run bzzy providers.`);
  return { ...provider };
}

export function setDefault(id) {
  getProvider(id);
  const value = config();
  value.defaultProvider = id;
  if (value.defaultSelection?.provider !== id) delete value.defaultSelection;
  saveConfig(value);
}

export function defaultSelection(providerId) {
  const value = config(), selection = value.defaultSelection;
  if (!selection || providerId && selection.provider !== providerId) return null;
  try { getProvider(selection.provider); } catch { return null; }
  const model = selection.model == null ? null : typeof selection.model === 'string' && selection.model.length <= 200 && !/[\s\x00-\x1f\x7f-\x9f]/u.test(selection.model) ? selection.model : null;
  const effort = typeof selection.effort === 'string' && /^(?:default|[a-z][a-z0-9_-]{0,23})$/.test(selection.effort) ? selection.effort : 'default';
  const capabilities = selection.capabilities && typeof selection.capabilities === 'object' && !Array.isArray(selection.capabilities) ? selection.capabilities : null;
  return { provider: selection.provider, model, effort, capabilities };
}

export function saveDefaultSelection(session) {
  const selection = selectionFromSession(session);
  const value = config(); value.defaultProvider = selection.provider; value.defaultSelection = selection; saveConfig(value);
  return selection;
}

export function selectionFromSession(session) {
  const provider = getProvider(session.provider);
  const effort = session.selectedEffort === 'default' ? 'default' : session.selectedEffort || session.reasoningEffort || 'default';
  if (typeof effort !== 'string' || !/^(?:default|[a-z][a-z0-9_-]{0,23})$/.test(effort)) throw new Error('The current reasoning effort cannot be saved as a default.');
  const model = session.model || session.resolvedModel || provider.model || null;
  if (model != null && (typeof model !== 'string' || model.length > 200 || /[\s\x00-\x1f\x7f-\x9f]/u.test(model))) throw new Error('The current model cannot be saved as a default.');
  const selection = { provider: provider.id, model, effort, capabilities: session.modelCapabilities || null };
  return selection;
}

function normalizeParallelDefault(selections) {
  if (!Array.isArray(selections) || selections.length < 2 || selections.length > 3) throw new Error('A parallel default needs 2 or 3 agents.');
  return selections.map(selection => selectionFromSession({ provider: selection.provider, model: selection.model,
    selectedEffort: selection.effort, modelCapabilities: selection.capabilities }));
}

export function modeDefault(mode) {
  if (!['parallel', 'debate', 'besties', 'delegate'].includes(mode)) throw new Error('Unknown preset mode.');
  try {
    const selected = normalizeParallelDefault(config()[`${mode}Default`]);
    if (mode === 'delegate' && selected.length !== 2) return null;
    return selected;
  } catch { return null; }
}

export function saveModeDefault(mode, selections) {
  if (!['parallel', 'debate', 'besties', 'delegate'].includes(mode)) throw new Error('Unknown preset mode.');
  const agents = normalizeParallelDefault(selections);
  if (mode === 'delegate' && agents.length !== 2) throw new Error(`${mode} needs two agents.`);
  const value = config(); value[`${mode}Default`] = agents; saveConfig(value);
  return { mode, agents };
}

export function parallelDefault() {
  return modeDefault('parallel');
}

export function saveParallelDefault(selections) {
  const parallelAgents = normalizeParallelDefault(selections);
  const value = config(); value.parallelDefault = parallelAgents; saveConfig(value);
  return { parallelAgents };
}

export function addProvider(id, options) {
  if (!/^[a-z][a-z0-9_-]{0,39}$/.test(id) || Object.hasOwn(BUILTINS, id)) throw new Error('Choose a new provider ID using letters, numbers, _ or -.');
  const url = new URL(options.baseUrl);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('Provider URL must use HTTPS, or HTTP on localhost.');
  }
  if (url.username || url.password || url.search || url.hash) throw new Error('Provider URL must not contain credentials, query parameters, or a fragment.');
  if (!/^[A-Z][A-Z0-9_]*$/.test(options.envKey || '')) throw new Error('Supply an environment variable name such as MY_API_KEY.');
  if (!options.model?.trim()) throw new Error('Supply --model for this provider.');
  const value = config();
  value.providers[id] = {
    id, name: id, backend: 'codex', auth: 'api-key', baseUrl: url.href.replace(/\/$/, ''),
    envKey: options.envKey, model: options.model, contextWindow: options.contextWindow || 128000,
  };
  saveConfig(value);
}

export function saveKey(id, key) {
  const file = path.join(home(), 'credentials.json');
  const value = readJson(file, {});
  value[id] = key;
  writeJson(file, value);
}

export function apiKey(provider) {
  const key = process.env[provider.envKey] || readJson(path.join(home(), 'credentials.json'), {})[provider.id];
  if (!key?.trim()) throw new Error(`No API key for ${provider.id}. Set ${provider.envKey} or run bzzy auth ${provider.id}.`);
  return key;
}

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
