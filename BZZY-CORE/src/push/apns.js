import path from 'node:path';
import { home } from '../engine/files.js';
import { loadAPNsConfigurationFile } from '@bzzy/relay/apns';
export { APNsClient, PushError, deviceToken } from '@bzzy/relay/apns';

// Private owner configuration stays local; never accepted by a Core RPC.
export const loadAPNsConfiguration = options => loadAPNsConfigurationFile(path.join(home(), 'push', 'apns.json'), options);
