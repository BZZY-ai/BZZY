import { config, getProvider } from './providers.js';
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

export function applyParallelSelection(session, selections) {
  if (!selections) return session;
  session.mode = 'parallel'; session.parallelAgents = configuredParallel({ parallelAgents: selections });
  session.selectedEffort = session.parallelAgents[0].effort || 'default'; session.modelCapabilities = session.parallelAgents[0].capabilities;
  return session;
}

export function configuredDebate(options = {}) {
  const choices = options.debateAgents || [agentChoice(options.supervisor || options.provider || 'codex', options.supervisorModel || options.model),
    ...(options.participants || ['claude', 'deepseek']).map(value => typeof value === 'string' ? agentChoice(value) : value)];
  if (!Array.isArray(choices) || choices.length < 2 || choices.length > 3) throw new Error('Debate needs 2 or 3 agents total: a main agent and one or two challengers.');
  return choices.map((choice, index) => ({ ...agentChoice(choice.provider, choice.model), ...choice, effort: choice.effort || (index === 0 ? options.effort : null) || 'default' }));
}

export function applyDebateSelection(session, choices) {
  if (!choices) return session;
  session.mode = 'debate'; session.debateAgents = configuredDebate({ debateAgents: choices });
  const first = session.debateAgents[0];
  Object.assign(session, { provider: first.provider, backend: getProvider(first.provider).backend, model: first.model,
    selectedEffort: first.effort, modelCapabilities: first.capabilities });
  return session;
}

export function configuredBesties(options = {}) {
  const supplied = options.besties || options.bestiesSelection;
  if (supplied) {
    if (!Array.isArray(supplied) || supplied.length < 2 || supplied.length > 3) throw new Error('Besties needs 2 or 3 chosen agents.');
    return supplied.map(selection => ({ ...agentChoice(selection.provider, selection.model), ...selection }));
  }
  const names = options.agents ? String(options.agents).split(',').map(value => value.trim()).filter(Boolean)
    : [options.provider || config().defaultProvider || 'codex', 'claude'];
  if (names.length < 2 || names.length > 3) throw new Error('Besties needs 2 or 3 agents. Use --agents codex:MODEL,claude:MODEL[,deepseek:MODEL]; the same provider can appear twice.');
  return names.map((name, index) => ({ ...agentChoice(name, index === 0 ? options.model : undefined), effort: index === 0 ? options.effort || 'default' : 'default' }));
}

export function applyBestiesSelection(session, choices) {
  if (!choices) return session;
  const selected = configuredBesties({ besties: choices }), first = selected[0];
  session.mode = 'besties'; session.besties = selected.map(choice => ({ ...choice }));
  session.provider = first.provider; session.backend = getProvider(first.provider).backend; session.model = first.model;
  session.selectedEffort = first.effort || 'default'; session.modelCapabilities = first.capabilities;
  return session;
}

export function applyDelegationSelection(session, selection) {
  if (!selection) return session;
  session.mode = 'delegate';
  session.selectedEffort = selection.supervisor.effort;
  session.modelCapabilities = selection.supervisor.capabilities;
  session.executor = { ...selection.executor };
  return session;
}
