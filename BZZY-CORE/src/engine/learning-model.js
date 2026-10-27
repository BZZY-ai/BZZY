import { getProvider, providerEffortCapabilities, providerModelCapabilities } from './providers.js';
import { backgroundModelSettings } from './background-model.js';
import { digest } from './database.js';

const fail = message => { throw Object.assign(new Error(message), { code: 'INVALID_LEARNING' }); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
export function learningProviderFingerprint(id) {
  const provider = getProvider(id);
  // Public dispatch identity only. Account bindings and authentication material
  // remain in the provider adapter and are never copied into historical jobs.
  return digest({ id: provider.id, backend: provider.backend, auth: provider.auth,
    baseUrl: provider.baseUrl || null, envKey: provider.envKey || null, defaultModel: provider.model || null });
}
export function normalizeLearningModelRoute(value = { source: 'source' }) {
  if (!plain(value) || !['source', 'background', 'custom'].includes(value.source) ||
    Object.keys(value).some(key => !['source', 'provider', 'model', 'effort'].includes(key))) fail('Choose the source, shared background, or an explicit learning model.');
  if (value.source !== 'custom') {
    if (Object.keys(value).length !== 1) fail('Inherited learning model routes cannot include provider overrides.');
    return { source: value.source };
  }
  return { source: 'custom', ...validateSelection(value) };
}
function validateSelection(value) {
  let provider;
  try { provider = getProvider(value.provider); } catch { fail('Choose an installed learning provider.'); }
  const model = value.model ?? provider.model ?? null, effort = value.effort ?? 'default';
  if (model !== null && (typeof model !== 'string' || !/^[^\s\x00-\x1f\x7f-\x9f]{1,200}$/u.test(model))) fail('Invalid learning model name.');
  if (typeof effort !== 'string' || !/^(?:default|[a-z][a-z0-9_-]{0,23})$/.test(effort)) fail('Invalid learning model effort.');
  const supported = providerEffortCapabilities(provider, model).supportedEfforts;
  if (effort !== 'default' && supported?.length && !supported.includes(effort)) fail('This learning model does not support the selected effort.');
  return { provider: provider.id, model, effort };
}
export function resolveLearningModel(session, settings) {
  const route = normalizeLearningModelRoute(settings.modelRoute);
  let selection, metadata = {};
  if (route.source === 'background') {
    const background = backgroundModelSettings();
    selection = background.configured ? validateSelection(background.selection) : null;
    metadata = { backgroundModelRevision: background.revision, coordinatorRevision: background.coordinatorRevision };
  } else selection = validateSelection(route.source === 'custom' ? route : { provider: session.provider, model: session.model, effort: session.selectedEffort || 'default' });
  const capabilities = selection ? providerModelCapabilities(getProvider(selection.provider), selection.model,
    route.source === 'source' ? session.modelCapabilities : undefined) : null;
  return { selection, selectionSource: route.source, modelSettingsRevision: settings.revision,
    providerFingerprint: selection ? learningProviderFingerprint(selection.provider) : null, ...metadata,
    selectionResolution: !selection ? 'unconfigured' : selection.model ? 'explicit-model' : 'backend-default-unresolved',
    modelCapabilities: capabilities ? {
      ...(Number.isSafeInteger(capabilities.contextWindow) && capabilities.contextWindow > 0 ? { contextWindow: capabilities.contextWindow } : {}),
      ...(Array.isArray(capabilities.supportedEfforts) ? { supportedEfforts: capabilities.supportedEfforts.filter(value => typeof value === 'string').slice(0, 12) } : {}),
    } : null };
}
