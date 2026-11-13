import { checkInstallationUpdate, applyInstallationUpdate } from '@bzzy/core/engine/update-check.js';
import { writeUpdateHandoff, discardUpdateHandoff, updateLaunchTarget } from './update-handoff.js';
import { coreHostStatus } from '@bzzy/core/engine/host-service.js';
export { checkInstallationUpdate, applyInstallationUpdate, officialRepository, updateRepository, runUpdateCommand } from '@bzzy/core/engine/update-check.js';

// Launch-time auto-update: before an interactive `bzzy` opens, see whether the
// installation is behind BZZY-ai/BZZY and, if so, install the update and reload
// this launcher with the user's original arguments so the session continues on
// the new code. It is best-effort and fail-open — any check/apply error (no
// network, a slow remote, a non-updatable or dirty checkout, the update lock
// held) just lets the current version launch normally. Set BZZY_AUTO_UPDATE=0
// to opt out. BZZY_AUTO_UPDATED guards against re-checking after the reload.
export async function autoUpdateOnLaunch(argv = [], { check = checkInstallationUpdate, apply = applyInstallationUpdate,
  target = updateLaunchTarget, exec = process.execve, out = process.stderr, signal } = {}) {
  if (process.env.BZZY_AUTO_UPDATED) return false;
  if (/^(0|false|off|no)$/i.test(process.env.BZZY_AUTO_UPDATE || '')) return false;
  if (typeof exec !== 'function') return false;
  let checked;
  try { checked = await check({ signal: signal || AbortSignal.timeout(12000) }); }
  catch { return false; }
  if (!checked?.available || checked.blocked) return false;
  out.write(`bzzy: update available (${checked.current.slice(0, 8)} → ${checked.target.slice(0, 8)}). Updating CLI and Core…\n`);
  try { await apply(checked, { inherit: true }); }
  catch (error) { out.write(`bzzy: auto-update did not complete (${error.message}). Continuing on the current version; run bzzy --update to retry.\n`); return false; }
  let launcher;
  try { launcher = target(checked); }
  catch (error) { out.write(`bzzy: updated — run bzzy again to use the new version (${error.message}).\n`); return true; }
  // execve replaces this process; the loop guard prevents the reloaded launch
  // from re-checking. On the rare reload failure, tell the user to rerun.
  try { exec(launcher.file, [...launcher.args, ...argv], { ...process.env, BZZY_AUTO_UPDATED: checked.target }); }
  catch (error) { out.write(`bzzy: updated, but could not reload automatically (${error.message}). Run bzzy again.\n`); return true; }
  return true;
}
export async function updateCommand(ui, { check = checkInstallationUpdate, apply = applyInstallationUpdate, hostStatus = coreHostStatus } = {}) {
  const abort = new AbortController();
  let checked;
  try {
    const answer = await ui.chooseOne('BZZY updates · CLI + Core', check({ signal: abort.signal }).then(result => {
      checked = result; ui.updateStatus = result.blocked ? 'Update blocked' : result.available ? 'Update available' : 'Up to date';
      return { description: `BZZY-ai/BZZY · ${result.current.slice(0, 8)} → ${result.target.slice(0, 8)}${result.blocked ? '\n' + result.blocked : '\nUpdates both products in this terminal. Your chat and draft reopen; active goals keep running.'}`,
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
      { locked: true, loadingLabel: 'Installing CLI and Core… Your chat and draft are saved.', hint: 'Active goals continue. This terminal reattaches automatically.' });
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
