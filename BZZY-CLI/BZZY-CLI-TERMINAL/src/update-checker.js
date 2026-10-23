import { checkInstallationUpdate, applyInstallationUpdate } from '@bzzy/core/engine/update-check.js';
export { checkInstallationUpdate, applyInstallationUpdate, officialRepository, updateRepository, runUpdateCommand } from '@bzzy/core/engine/update-check.js';
export async function updateCommand(ui) {
  const abort = new AbortController();
  let checked;
  try {
    const answer = await ui.chooseOne('BZZY updates · CLI + Core', checkInstallationUpdate({ signal: AbortSignal.any([abort.signal, AbortSignal.timeout(12000)]) }).then(result => {
      checked = result; ui.updateStatus = result.blocked ? 'Update blocked' : result.available ? 'Update available' : 'Up to date';
      return { description: `BZZY-ai/BZZY · ${result.current.slice(0, 8)} → ${result.target.slice(0, 8)}${result.blocked ? '\n' + result.blocked : '\nUpdates CLI and Core together. Running work is paused; paused work is not replayed.'}`,
        choices: [{ value: 'back', label: 'Back', selected: true }, ...(result.available && !result.blocked ? [{ value: 'install', label: 'Update CLI and Core' }] : [])] };
    }).catch(error => ({ description: error.message, choices: [{ value: 'back', label: 'Back', selected: true }] })));
    if (answer !== 'install') return;
    ui.detached = true; ui.close(); ui.tui = null;
    await applyInstallationUpdate(checked);
    ui.detached = true;
  } finally { abort.abort(); }
}
