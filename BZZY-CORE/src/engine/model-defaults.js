import { object, fail } from '../validation.js';
import { defaultSelection, modeDefault, getProvider, providerModelCapabilities, selectionFromSession,
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
  object(value, ['supportsEffort', 'supportedEfforts', 'defaultEffort', 'contextWindow', 'inputModalities', 'category']);
  if (value.supportsEffort !== undefined && typeof value.supportsEffort !== 'boolean' ||
      value.contextWindow !== undefined && (!Number.isSafeInteger(value.contextWindow) || value.contextWindow < 1 || value.contextWindow > 1000000000) ||
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
  const supported = providerModelCapabilities(getProvider(selection.provider), selection.model, capabilities || {});
  if (selection.effort !== 'default' && (supported.supportsEffort === false || supported.supportedEfforts?.length && !supported.supportedEfforts.includes(selection.effort))) {
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
