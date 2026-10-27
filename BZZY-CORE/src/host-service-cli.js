import { servicePlan, installationDoctor, installService, serviceStatus, uninstallService,
  coreHostStatus, startCoreHost, stopCoreHost, restartCoreHost } from './engine/host-service.js';
import { authorizeRootExecution, assertRootExecutable } from './engine/root-execution.js';

const usage = 'Usage: bzzy-core service <plan|install [--dry-run] [--allow-root]|status|start|stop|restart|uninstall>\nSimple commands: bzzy-core start|status|stop|restart\nSupervision of the existing Core engine; no model is started. Linux root execution requires explicit --allow-root installation.\nplan/--dry-run print the exact manifest without writing files or loading a service.\ninstall prepares the owned manifest; start enables and starts it; stop pauses work and disables it.\nPrivate state, provider bindings and projects are preserved by uninstall.';
const print = value => console.log(JSON.stringify(value, null, 2));

export async function hostServiceCommand(args) {
  const [command = 'help', ...extra] = args;
  if (command === 'help' && !extra.length) { console.log(usage); return; }
  if (!['plan', 'install', 'status', 'start', 'stop', 'restart', 'uninstall'].includes(command) ||
    new Set(extra).size !== extra.length || extra.length && !(command === 'install' && extra.every(value => ['--dry-run', '--allow-root'].includes(value)))) {
    throw Object.assign(new Error(usage), { code: 'SERVICE_USAGE' });
  }
  const allowRoot = extra.includes('--allow-root'), dryRun = command === 'plan' || extra.includes('--dry-run');
  if (allowRoot && (process.platform !== 'linux' || process.getuid?.() !== 0)) throw Object.assign(new Error('--allow-root is available only to the root account on Linux.'), { code: 'SERVICE_NON_ROOT_REQUIRED' });
  if (command === 'install' && !dryRun) {
    const doctor = installationDoctor();
    if (!doctor.ready) { print(doctor); process.exitCode = 1; return; }
  }
  const plan = servicePlan(allowRoot ? { rootExecution: true } : {});
  if (dryRun) {
    print({ ...plan, dryRun: true, secretsIncluded: false, next: 'Review this plan, then run bzzy-core service install and bzzy-core service start.' }); return;
  }
  if (command === 'install') {
    if (allowRoot) { assertRootExecutable(plan.node); assertRootExecutable(plan.entry); authorizeRootExecution(); }
    print({ ...installService(plan), loadRequested: false, startup: plan.startup, next: 'Run bzzy-core start to enable this service.' }); return;
  }
  if (command === 'uninstall') { await stopCoreHost({ plan }); print(uninstallService(plan)); return; }
  await coreLifecycleCommand(command, [], { plan });
}

export async function coreLifecycleCommand(command, args, options = {}) {
  if (args.length || !['start', 'status', 'stop', 'restart'].includes(command)) throw Object.assign(new Error('Usage: bzzy-core start|status|stop|restart'), { code: 'SERVICE_USAGE' });
  const operation = { start: startCoreHost, status: coreHostStatus, stop: stopCoreHost, restart: restartCoreHost }[command];
  const result = await operation(options); console.log(JSON.stringify(result)); return result;
}

export function doctorCommand(args) {
  if (args.length) throw Object.assign(new Error('Usage: bzzy-core doctor'), { code: 'SERVICE_USAGE' });
  const result = installationDoctor(); print(result);
  if (!result.ready) process.exitCode = 1;
}
