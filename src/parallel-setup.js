import { chooseProvider } from './providers.js';
import { chooseModel } from './models.js';
import { agentChoice } from './delegation.js';

export function configuredParallel(options = {}) {
  const selections = options.parallelAgents;
  if (selections) {
    if (!Array.isArray(selections) || selections.length < 2 || selections.length > 3) throw new Error('Parallel mode needs 2 or 3 agents.');
    return selections.map(selection => ({ ...agentChoice(selection.provider, selection.model), ...selection }));
  }
  const names = options.agents ? String(options.agents).split(',').map(value => value.trim()).filter(Boolean) : ['codex', 'claude', 'deepseek'].slice(0, options.parallelCount || 3);
  if (names.length < 2 || names.length > 3) throw new Error('Parallel mode needs 2 or 3 agents. Use --parallel 2, --parallel 3, or --agents A,B[,C].');
  if (options.parallelCount != null && names.length !== options.parallelCount) throw new Error('--parallel count must match the number of entries in --agents.');
  return names.map((name, index) => ({ ...agentChoice(name, index === 0 ? options.model : undefined), effort: index === 0 ? options.effort || 'default' : 'default' }));
}

export async function chooseParallel(options, ui) {
  const defaults = configuredParallel(options), choices = [];
  for (const [index, prior] of defaults.entries()) {
    const role = `Agent ${index + 1} · ${index + 1}/${defaults.length}`;
    const description = 'Choose this independent agent’s provider, model and effort. Every agent receives the same /goal in its own chat and workspace.';
    const provider = await chooseProvider(prior.provider, '', ui, { title: `${role} · Choose provider`, description });
    if (!provider) return null;
    const candidate = { provider: provider.id, backend: provider.backend, cwd: options.cwd,
      model: prior.provider === provider.id ? prior.model || provider.model || null : provider.model || null, selectedEffort: prior.effort };
    const model = await chooseModel(candidate, '', ui, { title: `${role} · Choose model · ${provider.id}`, description: description + ' Use ←/→ to choose effort.' });
    if (!model) return null;
    choices.push({ provider: provider.id, ...model, effort: model.effort || 'default' });
  }
  return choices;
}

export function applyParallelSelection(session, selections) {
  if (!selections) return session;
  session.mode = 'parallel'; session.parallelAgents = configuredParallel({ parallelAgents: selections });
  session.selectedEffort = session.parallelAgents[0].effort || 'default'; session.modelCapabilities = session.parallelAgents[0].capabilities;
  return session;
}
