import { modeDefault, getProvider, ensureApiKey } from './providers.js';

export async function chooseSavedCombo(mode, options, ui) {
  const saved = modeDefault(mode), title = mode === 'debate' ? 'Validate' : mode[0].toUpperCase() + mode.slice(1);
  if (!saved || options.parallelCount != null && saved.length !== options.parallelCount) {
    if (options.useDefault) throw new Error(`No matching ${mode === 'debate' ? 'validate' : mode} default saved. Configure the agents, then run /default.`);
    return false;
  }
  if (!options.useDefault) {
    if (ui.interactive === false) return false;
    const answer = await ui.chooseOne(`${title} · Use saved combo?`, { descriptionRows: saved.length, description: saved.map((agent, index) =>
      `Agent ${index + 1}: ${agent.provider} · ${agent.model || 'default model'} · effort ${agent.effort}`).join('\n'), choices: [
      { value: 'yes', label: 'Yes · Use this combo → Goal setup', selected: true }, { value: 'no', label: 'No · Choose agents' },
    ] });
    if (answer == null) return null;
    if (answer !== 'yes') return false;
  }
  for (const agent of saved) {
    const provider = getProvider(agent.provider);
    if (provider.auth === 'api-key') await ensureApiKey(provider, ui);
  }
  return saved;
}
