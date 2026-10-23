import { configuredParallel, applyParallelSelection } from '@bzzy/core/engine/parallel-setup.js';
export { configuredParallel, applyParallelSelection };
import { chooseProvider } from './providers.js';
import { chooseSavedCombo } from './mode-presets.js';
import { chooseModel } from './models.js';
import { agentChoice } from './delegation.js';

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
