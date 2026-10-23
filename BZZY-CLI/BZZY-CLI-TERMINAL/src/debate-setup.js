import { getProvider } from './providers.js';
import { agentChoice } from './delegation.js';
import { chooseParallel } from './parallel-setup.js';
import { chooseSavedCombo } from './mode-presets.js';

export function configuredDebate(options = {}) {
  const choices = options.debateAgents || [agentChoice(options.supervisor || options.provider || 'codex', options.supervisorModel || options.model),
    ...(options.participants || ['claude', 'deepseek']).map(value => typeof value === 'string' ? agentChoice(value) : value)];
  if (!Array.isArray(choices) || choices.length < 2 || choices.length > 3) throw new Error('Debate needs 2 or 3 agents total: a main agent and one or two challengers.');
  return choices.map((choice, index) => ({ ...agentChoice(choice.provider, choice.model), ...choice, effort: choice.effort || (index === 0 ? options.effort : null) || 'default' }));
}

export async function chooseDebate(options, ui) {
  const saved = options.participants ? false : await chooseSavedCombo('debate', options, ui);
  if (saved !== false) return saved;
  return chooseParallel({ ...options, parallelAgents: configuredDebate(options) }, ui, { name: 'Debate',
    roles: ['Main agent', 'Challenger 1', 'Challenger 2'], purpose: 'The main agent answers independent challenges. Choose each agent’s provider, model and effort before entering the goal.' });
}

export function applyDebateSelection(session, choices) {
  if (!choices) return session;
  session.mode = 'debate'; session.debateAgents = configuredDebate({ debateAgents: choices });
  const first = session.debateAgents[0];
  Object.assign(session, { provider: first.provider, backend: getProvider(first.provider).backend, model: first.model,
    selectedEffort: first.effort, modelCapabilities: first.capabilities });
  return session;
}
