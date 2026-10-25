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
    roles: ['Main agent', 'Checker 2', 'Checker 3'], purpose: 'Each agent independently checks the original goal. The first model also supplies a fresh final reviewer when every check supports it.' });
}
