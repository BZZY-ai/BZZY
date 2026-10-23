import { checkInstallationUpdate, applyInstallationUpdate } from '@bzzy/core/engine/update-check.js';
import { writeUpdateHandoff, discardUpdateHandoff, updateLaunchTarget } from './update-handoff.js';
import { coreHostStatus } from '@bzzy/core/engine/host-service.js';
export { checkInstallationUpdate, applyInstallationUpdate, officialRepository, updateRepository, runUpdateCommand } from '@bzzy/core/engine/update-check.js';
export async function updateCommand(ui, { check = checkInstallationUpdate, apply = applyInstallationUpdate, hostStatus = coreHostStatus } = {}) {
  const abort = new AbortController();
  let checked;
  try {
    const answer = await ui.chooseOne('BZZY updates · CLI + Core', check({ signal: AbortSignal.any([abort.signal, AbortSignal.timeout(12000)]) }).then(result => {
      checked = result; ui.updateStatus = result.blocked ? 'Update blocked' : result.available ? 'Update available' : 'Up to date';
      return { description: `BZZY-ai/BZZY · ${result.current.slice(0, 8)} → ${result.target.slice(0, 8)}${result.blocked ? '\n' + result.blocked : '\nUpdates both products in this terminal. Your chat and draft reopen; running work stays paused.'}`,
        choices: [{ value: 'back', label: 'Back', selected: true }, ...(result.available && !result.blocked ? [{ value: 'install', label: 'Update CLI and Core' }] : [])] };
    }).catch(error => ({ description: error.message, choices: [{ value: 'back', label: 'Back', selected: true }] })));
    if (answer !== 'install') return;
    if (typeof process.execve !== 'function') throw new Error('This Node runtime cannot reload the CLI in place.');
    updateLaunchTarget(checked);
    const file = writeUpdateHandoff(ui, { coreStopped: Boolean((await hostStatus()).operatorStopped) });
    ui.coreLifecycleInterrupted = true; ui.updateInProgress = true;
    ui.hostMetricsMonitor?.close(); ui.accountMonitor?.close(); ui.hostMetrics = null;
    const installation = apply(checked, { inherit: false });
    const progress = ui.chooseOne('Updating BZZY · CLI + Core', installation.then(() => ({ description: 'Installed. Reloading this terminal…', choices: [] })),
      { locked: true, loadingLabel: 'Installing CLI and Core… Your chat and draft are saved.', hint: 'Work stays paused. This terminal reloads automatically.' });
    try {
      await installation;
      ui.updateRestart = { file, check: checked, target: updateLaunchTarget(checked) }; ui.detached = true;
      ui.updateStatus = 'Updated · reloading';
    } catch (error) {
      discardUpdateHandoff(file); ui.updateStatus = 'Update failed';
      ui.event('error', { message: error.message });
    } finally {
      ui.updateInProgress = false;
      ui.tui?.finishSelection('finished', true);
      await progress;
    }
  } finally { abort.abort(); }
}
