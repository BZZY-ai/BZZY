import { configuredDebate, applyDebateSelection } from '@bzzy/core/engine/debate-setup.js';
export { configuredDebate, applyDebateSelection };
import { getProvider } from './providers.js';
import { agentChoice } from './delegation.js';
import { chooseParallel } from './parallel-setup.js';
import { chooseSavedCombo } from './mode-presets.js';

export async function chooseDebate(options, ui) {
  const saved = options.participants ? false : await chooseSavedCombo('debate', options, ui);
  if (saved !== false) return saved;
  return chooseParallel({ ...options, parallelAgents: configuredDebate(options) }, ui, { name: 'Validate',
    roles: ['Main agent', 'Challenger 1', 'Challenger 2'], purpose: 'The main agent answers independent challenges. Choose each agent’s provider, model and effort before entering the goal.' });
}
