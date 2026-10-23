import { configuredBesties, applyBestiesSelection } from '@bzzy/core/engine/besties-setup.js';
export { configuredBesties, applyBestiesSelection };
import { config, getProvider } from './providers.js';
import { agentChoice } from './delegation.js';
import { chooseParallel } from './parallel-setup.js';
import { chooseSavedCombo } from './mode-presets.js';

export async function chooseBesties(options, ui) {
  const defaults = configuredBesties(options);
  if (!options.agents && !options.besties && !options.bestiesSelection) defaults.push({ provider: 'deepseek', model: null, effort: 'default' });
  return chooseParallel({ ...options, parallelAgents: defaults }, ui, { name: 'Besties',
    roles: ['Bestie 1', 'Bestie 2', 'Bestie 3'], purpose: 'Choose equal collaborators, each with its own provider, model and effort. Peers share findings and inspect each other’s evidence.' });
}

export async function chooseBestiesWithDefault(options, ui) {
  const saved = options.agents ? false : await chooseSavedCombo('besties', options, ui);
  if (saved !== false) return saved;
  return chooseBesties(options, ui);
}

export function describeBesties(session) {
  const peers = (session.besties || []).map((peer, index) => `Bestie ${index + 1}: ${peer.provider} · ${peer.model || 'provider default'} · effort ${peer.effort || 'default'}`).join('\n');
  return peers + `\n${session.besties?.length || 2} peers collaborate on one durable goal, share findings and inspect one another’s evidence.\n`
    + (session.goal ? 'The saved goal is retained. /goal status shows progress; /goal resume continues unfinished work.'
      : 'Chat normally with the primary model. Start collaborative work with /goal <objective>.');
}
