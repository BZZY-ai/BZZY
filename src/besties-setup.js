import { config, chooseProvider, getProvider } from './providers.js';
import { chooseModel } from './models.js';
import { agentChoice } from './delegation.js';

export function configuredBesties(options = {}) {
  const supplied = options.besties || options.bestiesSelection;
  if (supplied) {
    if (!Array.isArray(supplied) || supplied.length !== 2) throw new Error('Besties needs exactly two chosen agents.');
    return supplied.map(selection => ({ ...agentChoice(selection.provider, selection.model), ...selection }));
  }
  const names = options.agents ? String(options.agents).split(',').map(value => value.trim()).filter(Boolean)
    : [options.provider || config().defaultProvider || 'codex', 'claude'];
  if (names.length !== 2) throw new Error('Besties needs exactly two agents. Use --agents codex:MODEL,claude:MODEL; the same provider can appear twice.');
  return names.map((name, index) => ({ ...agentChoice(name, index === 0 ? options.model : undefined), effort: index === 0 ? options.effort || 'default' : 'default' }));
}

export async function chooseBesties(options, ui) {
  const defaults = configuredBesties(options), choices = [];
  for (let index = 0; index < 2; index++) {
    const role = `Bestie ${index + 1} · ${index + 1}/2`;
    const description = 'Choose a strong peer to pursue one shared goal, exchange findings, challenge assumptions and inspect the other peer’s evidence. Both peers retain their own model and effort.';
    const provider = await chooseProvider(defaults[index].provider, '', ui, { title: `${role} · Choose provider`, description });
    if (!provider) return null;
    const candidate = { provider: provider.id, backend: provider.backend, cwd: options.cwd,
      model: provider.id === defaults[index].provider ? defaults[index].model || provider.model || null : provider.model || null,
      selectedEffort: defaults[index].effort };
    const model = await chooseModel(candidate, '', ui, { title: `${role} · Choose model · ${provider.id}`, description: description + ' Use ←/→ to choose effort.' });
    if (!model) return null;
    choices.push({ provider: provider.id, ...model, effort: model.effort || 'default' });
  }
  return choices;
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
  return peers + '\nTwo peers collaborate on one durable goal, share findings and inspect one another’s evidence.\n'
    + (session.goal ? 'The saved goal is retained. /goal status shows progress; /goal resume continues unfinished work.'
      : 'Chat normally with the primary model. Start collaborative work with /goal <objective>.');
}
