import { servicePlan, installationDoctor, installService, serviceStatus, uninstallService,
  coreHostStatus, startCoreHost, stopCoreHost, restartCoreHost } from './engine/host-service.js';

const usage = 'Usage: bzzy-core service <plan|install [--dry-run]|status|start|stop|restart|uninstall>\nSimple commands: bzzy-core start|status|stop|restart\nCore supervision (Linux root uses systemd system scope; regular users use user scope); no model is started.\nplan/--dry-run print the exact manifest without writing files or loading a service.\ninstall prepares the owned manifest; start enables and starts it; stop pauses work and disables it.\nPrivate state, provider bindings and projects are preserved by uninstall.';
const print = value => console.log(JSON.stringify(value, null, 2));

export async function hostServiceCommand(args) {
  const [command = 'help', ...extra] = args;
  if (command === 'help' && !extra.length) { console.log(usage); return; }
  if (!['plan', 'install', 'status', 'start', 'stop', 'restart', 'uninstall'].includes(command) ||
    extra.length && !(command === 'install' && extra.length === 1 && extra[0] === '--dry-run')) {
    throw Object.assign(new Error(usage), { code: 'SERVICE_USAGE' });
  }
  const plan = servicePlan();
  if (command === 'plan' || extra[0] === '--dry-run') {
    print({ ...plan, dryRun: true, secretsIncluded: false, next: 'Review this plan, then run bzzy-core service install and bzzy-core service start.' }); return;
  }
  if (command === 'install') {
    const doctor = installationDoctor();
    if (!doctor.ready) { print(doctor); process.exitCode = 1; return; }
    print({ ...installService(plan), loadRequested: false, startup: plan.startup, next: 'Run bzzy-core service start to enable this Core service.' }); return;
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
