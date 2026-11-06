import { object, fail } from '../validation.js';
import { defaultSelection, modeDefault, getProvider, providerEffortCapabilities, selectionFromSession,
  saveDefaultSelection, saveModeDefault, modelDefaultRevision } from './providers.js';

const targetName = target => {
  const normalized = target === 'validate' ? 'debate' : target;
  if (!['solo', 'debate', 'delegate', 'parallel', 'besties'].includes(normalized)) fail('INVALID_REQUEST', 'Choose a model default group.');
  return normalized;
};
const publicTarget = target => target === 'debate' ? 'validate' : target;
const effortName = value => typeof value === 'string' && /^(?:default|[a-z][a-z0-9_-]{0,23})$/.test(value);
function publicCapabilities(value) {
  if (value == null) return null;
  object(value, ['supportsEffort', 'supportedEfforts', 'defaultEffort', 'contextWindow', 'maxInputTokens', 'maxOutputTokens', 'inputModalities', 'category']);
  // Discovered capabilities legitimately carry maxInputTokens/maxOutputTokens (e.g.
  // DeepSeek V4.1 Flash reports a 393K output cap), so a delegate/default row must not
  // be rejected for carrying them. Still an allowlist: unknown fields (e.g. a private
  // apiKey) are rejected by object() above.
  const badTokens = field => value[field] !== undefined && (!Number.isSafeInteger(value[field]) || value[field] < 1 || value[field] > 1000000000);
  if (value.supportsEffort !== undefined && typeof value.supportsEffort !== 'boolean' ||
      badTokens('contextWindow') || badTokens('maxInputTokens') || badTokens('maxOutputTokens') ||
      value.supportedEfforts !== undefined && (!Array.isArray(value.supportedEfforts) || value.supportedEfforts.length > 24 || value.supportedEfforts.some(level => !effortName(level))) ||
      value.defaultEffort !== undefined && !effortName(value.defaultEffort) ||
      value.inputModalities !== undefined && (!Array.isArray(value.inputModalities) || value.inputModalities.length > 16 || value.inputModalities.some(item => typeof item !== 'string' || !/^[a-z][a-z0-9_-]{0,23}$/.test(item))) ||
      value.category !== undefined && (typeof value.category !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(value.category))) fail('INVALID_REQUEST', 'Invalid model capabilities.');
  return structuredClone(value);
}
function checkedSelection(input) {
  object(input, ['provider', 'model', 'effort', 'capabilities']);
  if (typeof input.provider !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(input.provider) ||
      input.model != null && (typeof input.model !== 'string' || !/^[^\s\x00-\x1f\x7f-\x9f]{1,200}$/u.test(input.model)) ||
      input.effort !== undefined && !effortName(input.effort)) fail('INVALID_REQUEST', 'Choose a valid provider, model and effort.');
  const capabilities = publicCapabilities(input.capabilities);
  const selection = selectionFromSession({ provider: input.provider, model: input.model,
    selectedEffort: input.effort ?? 'default', modelCapabilities: capabilities });
  const supported = providerEffortCapabilities(getProvider(selection.provider), selection.model, capabilities || {});
  // A provider/model's curated efforts (e.g. deepseek's "max") stay valid even when
  // the row carries a live-catalog capability set that omits them — a discovery read
  // may ADD efforts but must not silently drop a declared one here, which would make
  // a default save reject an effort the solo model-change path accepts. Discovered
  // and curated sets are unioned; an effort outside both (e.g. deepseek "medium") is
  // still rejected.
  const curated = providerEffortCapabilities(getProvider(selection.provider), selection.model, {});
  const allowedEfforts = new Set([...(supported.supportedEfforts || []), ...(curated.supportedEfforts || [])]);
  const unsupported = allowedEfforts.size ? !allowedEfforts.has(selection.effort)
    : supported.supportsEffort === false && curated.supportsEffort === false;
  if (selection.effort !== 'default' && unsupported) {
    fail('INVALID_REQUEST', 'Choose an effort supported by this model.');
  }
  return selection;
}

// Privileged local configuration, never a model tool. Reads start no inference.
export function modelDefaultSettings(target) {
  const normalized = targetName(target);
  return { target: publicTarget(normalized), revision: modelDefaultRevision(normalized),
    agents: normalized === 'solo' ? [defaultSelection()].filter(Boolean) : modeDefault(normalized) || [] };
}

export function configureModelDefault(target, inputs, { expectedRevision } = {}) {
  const normalized = targetName(target);
  if (typeof expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(expectedRevision) || !Array.isArray(inputs) ||
      (normalized === 'solo' ? inputs.length !== 1 : normalized === 'delegate' ? inputs.length !== 2 : inputs.length < 2 || inputs.length > 3)) {
    fail('INVALID_REQUEST', 'Use the displayed revision and complete model selections for this group.');
  }
  const agents = inputs.map(checkedSelection);
  if (normalized === 'solo') saveDefaultSelection({ ...agents[0], selectedEffort: agents[0].effort, modelCapabilities: agents[0].capabilities }, { expectedRevision });
  else saveModeDefault(normalized, agents, { expectedRevision });
  return modelDefaultSettings(normalized);
}
