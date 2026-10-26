import { randomUUID } from 'node:crypto';
import { CoreAssistant } from '@bzzy/core';
import { modelDefaultSettings, configureModelDefault } from '@bzzy/core/engine/model-defaults.js';
import { backgroundModelSettings, configureBackgroundModel } from '@bzzy/core/engine/background-model.js';
import { providers, getProvider, providerModelCapabilities, providerEffortCapabilities, providerEffortPolicy } from '@bzzy/core/engine/providers.js';
import { availableModels, normalizeModel } from '@bzzy/core/engine/models.js';
import { home } from '@bzzy/core/engine/files.js';
import { chooseEffort } from './model-controls.js';

export const defaultModelGroups = Object.freeze({
  solo: { title: 'Solo', roles: ['Chat'] },
  core: { title: 'BZZY Core', roles: ['Coordinator'] },
  validate: { title: 'Validate', roles: ['Main', 'Reviewer 1', 'Reviewer 2'], count: true },
  delegate: { title: 'Delegate', roles: ['Brain', 'Executor'] },
  parallel: { title: 'Parallel', roles: ['Agent 1', 'Agent 2', 'Agent 3'], count: true },
  besties: { title: 'Besties', roles: ['Bestie 1', 'Bestie 2', 'Bestie 3'], count: true },
  background: { title: 'Consensus & Compactor', roles: ['Shared model'] },
});
const fail = code => { throw Object.assign(new Error(code), { code }); };
const clone = value => structuredClone(value);
const publicSelection = value => value ? { provider: value.provider, model: value.model ?? null, effort: value.effort || 'default',
  ...(value.capabilities ? { capabilities: clone(value.capabilities) } : {}) } : null;
const effortCapabilities = selection => {
  const provider = getProvider(selection.provider);
  if (providerEffortPolicy(provider)) return providerEffortCapabilities(provider, selection.model, selection.capabilities);
  const accepted = providerModelCapabilities(provider, selection.model), discovered = selection.capabilities || {};
  const capabilities = { ...accepted, ...discovered };
  if (accepted.supportsEffort === false || discovered.supportsEffort === false) return { ...capabilities, supportsEffort: false, supportedEfforts: [] };
  if (accepted.supportedEfforts?.length) {
    capabilities.supportedEfforts = Array.isArray(discovered.supportedEfforts)
      ? discovered.supportedEfforts.filter(value => accepted.supportedEfforts.includes(value)) : [...accepted.supportedEfforts];
    if (!capabilities.supportedEfforts.length) capabilities.supportsEffort = false;
  }
  if (Array.isArray(discovered.supportedEfforts) && !discovered.supportedEfforts.length) capabilities.supportsEffort = false;
  return capabilities;
};

// A settings model picker lists only the selected provider. It uses Core's
// existing catalog and never prompts for credentials or sends model work.
export async function chooseDefaultModel(current, ui, { title, scope } = {}) {
  const provider = getProvider(current.provider), abort = new AbortController();
  let catalog;
  try {
    const choices = availableModels(current, { signal: abort.signal }).then(found => {
      catalog = found;
      const models = [...found.models];
      if (current.model && !models.some(item => item.id === current.model)) models.unshift({ id: current.model, name: current.model });
      return { description: found.description || 'Choose a model for this saved default.', choices: [
        { value: '@default', label: 'Provider default' + (provider.model ? ' · ' + provider.model : ''), selected: current.model == null || current.model === provider.model },
        ...models.map(item => ({ value: item.id, label: item.name && item.name !== item.id ? `${item.name} · ${item.id}` : item.id,
          description: item.description, selected: current.model === item.id })),
        { value: '@custom', label: 'Enter a model ID…' },
      ] };
    });
    const selected = await ui.chooseOne(title || 'Default model', choices, { presentation: 'dropdown', kind: 'model', scope });
    if (selected == null) return null;
    const value = typeof selected === 'object' ? selected.value : selected;
    if (value === '@custom') {
      const input = (await ui.ask('Model ID · Esc cancels'))?.trim();
      return input ? { provider: provider.id, model: normalizeModel(provider, input), effort: 'default', capabilities: null } : null;
    }
    if (value === '@default') return { provider: provider.id, model: provider.model || null, effort: 'default', capabilities: providerModelCapabilities(provider, provider.model) };
    const model = catalog?.models.find(item => item.id === value);
    if (!model && value !== current.model) fail('DEFAULT_MODEL_REQUIRED');
    return { provider: provider.id, model: normalizeModel(provider, value), effort: 'default', capabilities: model?.capabilities || current.modelCapabilities || null };
  } finally { abort.abort(); }
}

export class DefaultModels {
  constructor(ui, { read, save, modelPicker = chooseDefaultModel, effortPicker = chooseEffort, isCurrent = () => true } = {}) {
    this.ui = ui; this.hostHome = home(); this.assistant = new CoreAssistant(); this.drafts = new Map(); this.epoch = 0;
    this.modelPicker = modelPicker; this.effortPicker = effortPicker; this.isCurrent = isCurrent;
    this.read = read || (target => target === 'core' ? this.assistant.settings() : target === 'background' ? backgroundModelSettings() : modelDefaultSettings(target));
    this.save = save || ((target, draft) => target === 'core'
      ? this.assistant.configure({ source: 'core', ...this.credentialsFree(draft.agents[0]) }, { expectedRevision: draft.revision, requestId: randomUUID() })
      : target === 'background' ? configureBackgroundModel(draft.source === 'core' ? { source: 'core' }
        : { source: 'custom', ...this.credentialsFree(draft.agents[0]) }, { expectedRevision: draft.revision, requestId: randomUUID() })
        : configureModelDefault(target, draft.agents.slice(0, draft.count), { expectedRevision: draft.revision }));
  }
  credentialsFree(selection) { return { provider: selection.provider, model: selection.model, effort: selection.effort }; }
  load(target) {
    const saved = this.read(target), info = defaultModelGroups[target];
    const agents = target === 'core' || target === 'background' ? [publicSelection(saved.selection)] : (saved.agents || []).map(publicSelection);
    const count = info.count || target === 'delegate' ? agents.length || 2 : 1;
    while (agents.length < count) agents.push(null);
    return { revision: saved.revision, count, agents, source: target === 'background' ? saved.source : undefined, dirty: false };
  }
  open() {
    this.epoch++;
    for (const target of Object.keys(defaultModelGroups)) if (!this.drafts.get(target)?.dirty) this.drafts.set(target, this.load(target));
  }
  leave() { this.epoch++; }
  active(epoch) { if (epoch !== this.epoch || home() !== this.hostHome || !this.isCurrent()) fail('DEFAULTS_STALE_CONTEXT'); }
  rows() {
    if (!this.drafts.size) this.open();
    const rows = [];
    for (const [target, info] of Object.entries(defaultModelGroups)) {
      const draft = this.drafts.get(target);
      const inherits = target === 'background' && draft.source === 'core';
      const agents = inherits ? [publicSelection(this.read('core').selection)] : draft.agents;
      rows.push({ text: info.title, modelGroup: { label: info.title, dirty: draft.dirty, configured: agents.slice(0, draft.count).every(Boolean) } });
      if (info.count) rows.push({ text: 'Agents', value: String(draft.count) + ' ▾', action: `defaults:count:${target}`, control: true });
      if (target === 'background') rows.push({ text: 'Source', value: draft.source === 'core' ? 'Use BZZY Core ▾' : 'Custom shared model ▾', action: 'defaults:source:background', control: true });
      for (let index = 0; index < draft.count; index++) {
        const selected = agents[index], prefix = `defaults`;
        rows.push({ text: info.roles[index], modelTable: { group: target, label: info.roles[index], cells: [
          { key: 'provider', text: selected?.provider || 'Choose provider', action: `${prefix}:provider:${target}:${index}` },
          { key: 'model', text: selected ? selected.model || 'Provider default' : 'Choose model', action: `${prefix}:model:${target}:${index}` },
          { key: 'effort', text: selected?.effort || 'default', action: `${prefix}:effort:${target}:${index}` },
        ] } });
      }
      rows.push({ text: 'Save ' + info.title, action: `defaults:save:${target}`, inline: `default-controls:${target}`, control: true, tone: 'accent' },
        { text: draft.dirty ? 'Discard edits' : 'Reload', action: `defaults:reload:${target}`, inline: `default-controls:${target}`, control: true, tone: 'muted' }, { text: '' });
    }
    rows.push({ text: 'Defaults apply to new work. Existing chats keep their selected models.', tone: 'muted' });
    return rows;
  }
  async run(action) {
    const match = /^defaults:(provider|model|effort|count|source|save|reload):([a-z]+)(?::([0-2]))?$/.exec(action);
    if (!match || !defaultModelGroups[match[2]]) return;
    const [, field, target] = match, index = Number(match[3] || 0), epoch = this.epoch;
    this.active(epoch);
    const draft = this.drafts.get(target), info = defaultModelGroups[target];
    if (!draft || index >= draft.count) fail('DEFAULT_MODEL_REQUIRED');
    if (field === 'reload') { this.drafts.set(target, this.load(target)); return; }
    if (field === 'save') {
      if (!(target === 'background' && draft.source === 'core') && draft.agents.slice(0, draft.count).some(item => !item)) fail('MODE_INCOMPLETE');
      this.save(target, draft); this.drafts.set(target, this.load(target));
      return `${info.title} defaults saved. Existing chats keep their selected models.`;
    }
    const prompt = async (method, ...args) => { this.active(epoch); const result = await method(...args); this.active(epoch); return result; };
    if (field === 'count') {
      if (!info.count) return;
      const selected = await prompt(this.ui.chooseOne.bind(this.ui), info.title + ' · number of agents', [2, 3].map(count => ({ value: String(count), label: `${count} agents`, selected: count === draft.count })),
        { presentation: 'dropdown', kind: 'count', scope: `defaults:${target}:count` });
      if (selected == null) return;
      if (!['2', '3'].includes(selected)) fail('MODE_COUNT_INVALID');
      draft.count = Number(selected); while (draft.agents.length < draft.count) draft.agents.push(null); draft.dirty = true; return;
    }
    if (field === 'source') {
      if (target !== 'background') return;
      const selected = await prompt(this.ui.chooseOne.bind(this.ui), 'Consensus & Compactor · source', [
        { value: 'core', label: 'Use BZZY Core', selected: draft.source === 'core' },
        { value: 'custom', label: 'Use a custom shared model', selected: draft.source === 'custom' },
      ], { presentation: 'dropdown', scope: 'defaults:background:source' });
      if (selected == null) return;
      if (!['core', 'custom'].includes(selected)) fail('DEFAULT_MODEL_REQUIRED');
      draft.source = selected; draft.dirty = true; return;
    }
    const inherits = target === 'background' && draft.source === 'core';
    const prior = inherits ? publicSelection(this.read('core').selection) : draft.agents[index];
    let selected;
    if (field === 'provider') {
      const providerId = await prompt(this.ui.chooseOne.bind(this.ui), `${info.title} · ${info.roles[index]} · provider`,
        Object.values(providers()).map(provider => ({ value: provider.id, label: provider.name, selected: provider.id === prior?.provider })),
        { presentation: 'dropdown', kind: 'provider', scope: `defaults:${target}:${index}` });
      if (providerId == null) return;
      if (providerId === prior?.provider) return;
      const provider = getProvider(providerId);
      selected = { provider: provider.id, model: provider.model || null, effort: 'default', capabilities: providerModelCapabilities(provider, provider.model) };
    } else {
      if (!prior) fail('DEFAULT_MODEL_REQUIRED');
      const current = { ...prior, cwd: this.ui.tui?.cwd || process.cwd(), selectedEffort: prior.effort,
        modelCapabilities: ['core', 'background'].includes(target) ? effortCapabilities(prior) : prior.capabilities };
      selected = field === 'model'
        ? await prompt(this.modelPicker, current, this.ui, { title: `${info.title} · ${info.roles[index]} · model`, scope: `defaults:${target}:${index}` })
        : await prompt(this.effortPicker, current, this.ui, { scope: `defaults:${target}:${index}` });
      if (!selected) return;
      if (selected.provider && selected.provider !== prior.provider) fail('DEFAULT_MODEL_REQUIRED');
      selected = { ...prior, ...selected, provider: prior.provider };
      if (field === 'model') {
        const capabilities = ['core', 'background'].includes(target) ? effortCapabilities(selected)
          : providerEffortCapabilities(getProvider(selected.provider), selected.model, selected.capabilities || {});
        const retained = prior.effort === 'default' || capabilities.supportsEffort !== false && capabilities.supportedEfforts?.includes(prior.effort);
        selected.effort = selected.model === prior.model && retained ? prior.effort : 'default';
      }
      if (field === 'effort' && ['core', 'background'].includes(target) && selected.effort !== 'default') {
        const refreshed = effortCapabilities(selected);
        if (refreshed.supportsEffort === false || refreshed.supportedEfforts?.length && !refreshed.supportedEfforts.includes(selected.effort)) fail('INVALID_REQUEST');
      }
    }
    draft.agents[index] = publicSelection(selected); draft.dirty = true;
    if (target === 'background') draft.source = 'custom';
  }
}
