import { config, getProvider } from './providers.js';
import { agentChoice } from './delegation.js';
import { chooseParallel } from './parallel-setup.js';
import { chooseSavedCombo } from './mode-presets.js';

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

export function applyBestiesSelection(session, choices) {
  if (!choices) return session;
  const selected = configuredBesties({ besties: choices }), first = selected[0];
  session.mode = 'besties'; session.besties = selected.map(choice => ({ ...choice }));
  session.provider = first.provider; session.backend = getProvider(first.provider).backend; session.model = first.model;
  session.selectedEffort = first.effort || 'default'; session.modelCapabilities = first.capabilities;
  return session;
}

export function describeBesties(session) {
  const peers = (session.besties || []).map((peer, index) => `Bestie ${index + 1}: ${peer.provider} · ${peer.model || 'provider default'} · effort ${peer.effort || 'default'}`).join('\n');
  return peers + `\n${session.besties?.length || 2} peers collaborate on one durable goal, share findings and inspect one another’s evidence.\n`
    + (session.goal ? 'The saved goal is retained. /goal status shows progress; /goal resume continues unfinished work.'
      : 'Chat normally with the primary model. Start collaborative work with /goal <objective>.');
}
