import { applyDelegationSelection } from '@bzzy/core/engine/delegation-setup.js';
export { applyDelegationSelection };
import { config, chooseProvider } from './providers.js';
import { chooseModel } from './models.js';
import { agentChoice } from './delegation.js';

// Finish both selections before creating a conversation or starting any work.
export async function chooseDelegation(options, ui) {
  const defaults = [
    agentChoice(options.supervisor || options.provider || config().defaultProvider || 'codex', options.supervisorModel || options.model),
    agentChoice(options.executor || 'deepseek', options.executorModel),
  ];
  const choices = [];
  for (const [index, role] of ['Supervisor', 'Executor'].entries()) {
    const step = `${role} · ${index + 1}/2`;
    const description = index === 0 ? 'Brain: choose a strong model to plan the assessment, assign routine work, verify evidence and decide when the goal is satisfied.'
      : 'Hands: choose a less expensive model for bounded inspection, tests and evidence collection. The brain reviews its work; you give one overall goal.';
    const provider = await chooseProvider(defaults[index].provider, '', ui, { title: step + ' · Choose provider', description });
    if (!provider) return null;
    const candidate = { provider: provider.id, backend: provider.backend, cwd: options.cwd,
      model: provider.id === defaults[index].provider ? defaults[index].model || provider.model || null : provider.model || null,
      selectedEffort: index === 0 ? options.effort : null };
    const model = await chooseModel(candidate, '', ui, { title: step + ' · Choose model · ' + provider.id, description: description + ' Use ←/→ to choose effort.' });
    if (!model) return null;
    choices.push({ provider: provider.id, ...model, effort: model.effort || 'default' });
  }
  return { supervisor: choices[0], executor: choices[1] };
}

export function describeDelegation(session) {
  const format = choice => `${choice.provider} · ${choice.model || 'provider default'} · effort ${choice.effort || 'default'}`;
  const next = session.goal ? 'Your saved goal is retained. /goal status shows progress; /goal resume continues unfinished work.'
    : 'Chat normally, or start supervised work with /goal <objective>, for example: /goal Solve this CTF using the supplied files.';
  return `Brain · supervisor: ${format({ provider: session.provider, model: session.model, effort: session.selectedEffort })}\nHands · executor: ${format(session.executor)}\nThe brain plans, assigns bounded work and reviews the evidence. You do not need to create assignments.\n${next}`;
}
