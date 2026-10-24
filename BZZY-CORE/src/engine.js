// Core owns the single shared execution engine and database.
export { BzzyClient } from './engine/api-client.js';
export { home, writeJson, sessionPath, loadSession, normalizeSessionAlias, sessionDeleted } from './engine/store.js';
export { database, transaction, getRecord, putRecord, listRecords, appendEvent, reserveRequest, digest, now } from './engine/database.js';
export { getProvider, providers, config, defaultSelection } from './engine/providers.js';
export { schemaErrors, validateSchema } from './engine/contracts.js';
export { generationSecurityPolicy } from './engine/instructions.js';
export { createSessionAccess, revokeSessionAccess, sessionPermissions, activeAccess } from './engine/session-access.js';
export { lockFile } from './engine/store.js';

export function requireNode() {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('BZZY Core requires Node.js 24 or newer.');
}

export const runtime = () => import('./engine/runtime.js');
