import path from 'node:path';
import { home, readJson } from './files.js';
import { lockFile } from './store.js';
import { identityAlive } from './process-identity.js';

const file = (directory = home()) => path.join(directory, 'runtime', 'control-maintenance.lock');
export const coreMaintenanceActive = directory => identityAlive(readJson(file(directory), {})?.identity);
export const beginCoreMaintenance = directory => lockFile(file(directory), 'Core control is already restarting or updating; active executions continue.');
export function assertCoreAvailable(directory) {
  if (coreMaintenanceActive(directory)) throw Object.assign(new Error('Core control is updating or restarting. Active goals continue; reconnect shortly.'), { code: 'CORE_MAINTENANCE' });
}
