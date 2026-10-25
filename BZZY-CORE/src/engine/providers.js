import path from 'node:path';
import { home, readJson, writeJson, lockFile } from './store.js';
import { digest } from './database.js';

export const BUILTINS = {
  codex: { id: 'codex', name: 'ChatGPT / Codex subscription', backend: 'codex', auth: 'subscription' },
  claude: { id: 'claude', name: 'Claude subscription (official Claude Code)', backend: 'claude', auth: 'subscription' },
  deepseek: {
    id: 'deepseek', name: 'DeepSeek', backend: 'codex', auth: 'api-key',
    baseUrl: 'https://api.deepseek.com', envKey: 'DEEPSEEK_API_KEY',
    model: 'deepseek-flash', contextWindow: 1048576,
    reasoningEffort: 'high', supportedEfforts: ['low', 'high', 'max'],
  },
  abliteration: {
    id: 'abliteration', name: 'Abliteration', backend: 'codex', auth: 'api-key',
    baseUrl: 'https://api.abliteration.ai/v1', envKey: 'ABLITERATION_API_KEY',
    model: 'abliterated-model', contextWindow: 262144,
    // Responses-specific defaults, also used for manually entered model IDs.
    // Discovery can override these public capabilities as the API evolves.
    modelCapabilities: {
      'abliterated-model': { contextWindow: 262144, inputModalities: ['text', 'image'],
        supportedEfforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] },
      'abliterated-model-large-flash': { contextWindow: 1048576, inputModalities: ['text', 'image'],
        supportedEfforts: ['none', 'low', 'high', 'max'], defaultEffort: 'high' },
      'abliterated-model-large-v2': { contextWindow: 1000000, inputModalities: ['text'],
        supportedEfforts: ['low', 'high', 'max'], defaultEffort: 'max' },
      'abliterated-model-large': { contextWindow: 1000000, inputModalities: ['text'],
        supportedEfforts: ['none', 'high', 'max'], defaultEffort: 'high' },
    },
  },
  orcarouter: {
    id: 'orcarouter', name: 'OrcaRouter', backend: 'codex', auth: 'api-key',
    baseUrl: 'https://api.orcarouter.ai/v1', envKey: 'ORCAROUTER_API_KEY',
    model: 'orca/orcacyber-zero-1.5', contextWindow: 128000, catalogFocus: 'cyber',
    modelCapabilities: {
      'orca/orcacyber-zero-1.5': { category: 'cyber', contextWindow: 1000000, inputModalities: ['text'],
        supportedEfforts: ['low', 'medium', 'high'] },
      'orca/orcacyber-zero-1.0': { category: 'cyber', contextWindow: 1000000, inputModalities: ['text'],
        supportedEfforts: ['low', 'medium', 'high'] },
      'orca/orcacyber-ultra-1.0': { category: 'cyber', contextWindow: 1048576, inputModalities: ['text'],
        supportedEfforts: ['low', 'medium', 'high'] },
    },
  },
};

export function providerModelCapabilities(provider, model, discovered) {
  const result = { ...(provider.supportedEfforts ? { supportedEfforts: provider.supportedEfforts } : {}),
    ...(provider.contextWindow ? { contextWindow: provider.contextWindow } : {}),
    ...provider.modelCapabilities?.[model || provider.model],
    ...Object.fromEntries(Object.entries(discovered || {}).filter(([, value]) => value !== undefined)) };
  // Callers may normalize a live catalog; never mutate the provider defaults.
  if (result.supportedEfforts) result.supportedEfforts = [...result.supportedEfforts];
  if (result.inputModalities) result.inputModalities = [...result.inputModalities];
  return result;
}

export function config() {
  return readJson(path.join(home(), 'config.json'), { version: 1, defaultProvider: null, providers: {} });
}

export const saveConfig = value => writeJson(path.join(home(), 'config.json'), value);
function editConfig(change) {
  let unlock;
  try { unlock = lockFile(path.join(home(), 'config.json.lock'), 'Model defaults are being updated.'); }
  catch (error) {
    if (error.code === 'BZZY_LOCKED') throw Object.assign(new Error('Defaults changed. Reload before saving.'), { code: 'CONFLICT' });
    throw error;
  }
  try { return change(config()); } finally { unlock(); }
}
export function updateConfig(change) {
  return editConfig(current => {
    const next = change(structuredClone(current));
    if (!next || typeof next !== 'object' || Array.isArray(next)) throw new Error('Invalid host configuration update.');
    saveConfig(next); return next;
  });
}
export function modelDefaultRevision(target) {
  const value = config();
  if (!['solo', 'parallel', 'debate', 'besties', 'delegate'].includes(target)) throw new Error('Unknown default target.');
  return digest(target === 'solo' ? { provider: value.defaultProvider, selection: value.defaultSelection || null } : value[`${target}Default`] || null);
}
function checkDefaultRevision(target, expectedRevision) {
  if (expectedRevision !== undefined && expectedRevision !== modelDefaultRevision(target)) throw Object.assign(new Error('Defaults changed. Reload before saving.'), { code: 'CONFLICT' });
}
export const providers = () => ({ ...BUILTINS, ...config().providers });

export function getProvider(id) {
  const provider = providers()[id];
  if (!provider) throw new Error(`Unknown provider ${JSON.stringify(id)}. Run bzzy providers.`);
  return { ...provider };
}

export function setDefault(id) {
  getProvider(id);
  return editConfig(value => {
    value.defaultProvider = id;
    if (value.defaultSelection?.provider !== id) delete value.defaultSelection;
    saveConfig(value);
  });
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

export function saveDefaultSelection(session, { expectedRevision } = {}) {
  const selection = selectionFromSession(session);
  return editConfig(value => {
    checkDefaultRevision('solo', expectedRevision);
    value.defaultProvider = selection.provider; value.defaultSelection = selection; saveConfig(value);
    return selection;
  });
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

export function saveModeDefault(mode, selections, { expectedRevision } = {}) {
  if (!['parallel', 'debate', 'besties', 'delegate'].includes(mode)) throw new Error('Unknown preset mode.');
  const agents = normalizeParallelDefault(selections);
  if (mode === 'delegate' && agents.length !== 2) throw new Error(`${mode} needs two agents.`);
  return editConfig(value => {
    checkDefaultRevision(mode, expectedRevision);
    value[`${mode}Default`] = agents; saveConfig(value);
    return { mode, agents };
  });
}

export function parallelDefault() {
  return modeDefault('parallel');
}

export function saveParallelDefault(selections) {
  return { parallelAgents: saveModeDefault('parallel', selections).agents };
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
  return editConfig(value => {
    (value.providers ||= {})[id] = {
      id, name: id, backend: 'codex', auth: 'api-key', baseUrl: url.href.replace(/\/$/, ''),
      envKey: options.envKey, model: options.model, contextWindow: options.contextWindow || 128000,
    };
    saveConfig(value);
  });
}

export function saveKey(id, key) {
  if (typeof id !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(id)) throw new Error('Invalid provider ID.');
  if (typeof key !== 'string' || !key.trim() || key.trim().length > 8192 || /\s|[\x00-\x1f\x7f-\x9f]/u.test(key.trim())) throw new Error('API keys must not contain whitespace or control characters and must be at most 8192 characters.');
  const file = path.join(home(), 'credentials.json');
  const value = readJson(file, {});
  value[id] = key.trim();
  writeJson(file, value);
}

// Trusted host settings operations. Return availability, never credential values.
export function credentialStatus(id) {
  const provider = getProvider(id);
  return { environment: Boolean(provider.envKey && process.env[provider.envKey]?.trim()),
    saved: Boolean(readJson(path.join(home(), 'credentials.json'), {})[provider.id]) };
}

export function removeKey(id) {
  const provider = getProvider(id), file = path.join(home(), 'credentials.json');
  const value = readJson(file, {});
  delete value[provider.id];
  writeJson(file, value);
}

export function apiKey(provider) {
  const key = process.env[provider.envKey] || readJson(path.join(home(), 'credentials.json'), {})[provider.id];
  if (!key?.trim()) throw new Error(`No API key for ${provider.id}. Set ${provider.envKey} or run bzzy auth ${provider.id}.`);
  return key;
}
