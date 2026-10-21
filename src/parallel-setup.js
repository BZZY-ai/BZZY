import { chooseProvider } from './providers.js';
import { chooseSavedCombo } from './mode-presets.js';
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

export async function chooseParallelWithDefault(options, ui) {
  const saved = options.agents ? false : await chooseSavedCombo('parallel', options, ui);
  if (saved !== false) return saved;
  return chooseParallel(options, ui);
}

export async function chooseParallel(options, ui, { name = 'Parallel', roles, purpose = 'Each agent gets its own chat and independently pursues the same goal.' } = {}) {
  const defaults = configuredParallel(options), choices = [];
  const agentLabel = index => roles?.[index] || `Agent ${index + 1}`;
  while (true) {
    const count = choices.filter(Boolean).length;
    const menu = defaults.map((prior, index) => ({
      value: `agent:${index}`, selected: count < 2 && index === defaults.findIndex((_entry, position) => !choices[position]),
      label: choices[index] ? `✓ ${agentLabel(index)} · ${choices[index].provider} · ${choices[index].model || 'default model'} · ${choices[index].effort}` : `${agentLabel(index)} · Choose provider and model${index === 2 ? ' (optional)' : ''}`,
      description: choices[index] ? 'Change this agent’s provider, model or effort.' : purpose,
    }));
    menu.push({ value: 'continue', label: count >= 2 ? `Continue with ${count} agents → Goal setup` : 'Continue · select at least 2 agents',
      disabled: count < 2, selected: count >= 2, description: 'Select at least two agents. A third agent is optional and continues automatically.' });
    const action = await ui.chooseOne(`${name} · Select agents`, { choices: menu,
      description: `${count} agents selected. Continue with two, or configure a third to advance automatically.` });
    if (action == null) return null;
    if (action === 'continue') { if (count >= 2) return choices.filter(Boolean); continue; }
    const index = Number(/^agent:(\d+)$/.exec(action)?.[1]);
    if (!Number.isInteger(index) || !defaults[index]) continue;
    const prior = choices[index] || defaults[index];
    const role = `${agentLabel(index)} · ${index + 1}/${defaults.length}`;
    const description = purpose;
    const provider = await chooseProvider(prior.provider, '', ui, { title: `${role} · Choose provider`, description });
    if (!provider) return null;
    const candidate = { provider: provider.id, backend: provider.backend, cwd: options.cwd,
      model: prior.provider === provider.id ? prior.model || provider.model || null : provider.model || null, selectedEffort: prior.effort };
    const model = await chooseModel(candidate, '', ui, { title: `${role} · Choose model · ${provider.id}`, description: description + ' Use ←/→ to choose effort.' });
    if (!model) return null;
    choices[index] = { provider: provider.id, ...model, effort: model.effort || 'default' };
    if (choices.filter(Boolean).length === 3) return choices;
  }
}

export async function chooseParallelGoal(selections, ui, { name = 'Parallel', description = 'Each gets its own chat tab.' } = {}) {
  ui.event('info', { message: `${name} · Goal setup\n` + selections.map((agent, index) => `Agent ${index + 1}: ${agent.provider} · ${agent.model || 'default model'} · effort ${agent.effort}`).join('\n')
    + `\nEnter one goal for these agents. ${description} Esc cancels.` });
  while (true) {
    const input = await ui.ask(`${name} goal › `);
    if (input == null) return null;
    const objective = input.trim().replace(/^\/goal(?:\s+|$)/, '').trim();
    if (objective) return objective;
    ui.event('info', { message: 'Enter a goal to start parallel work, or press Esc to cancel.' });
  }
}

export function applyParallelSelection(session, selections) {
  if (!selections) return session;
  session.mode = 'parallel'; session.parallelAgents = configuredParallel({ parallelAgents: selections });
  session.selectedEffort = session.parallelAgents[0].effort || 'default'; session.modelCapabilities = session.parallelAgents[0].capabilities;
  return session;
}
