import { CoreAssistant } from '../assistant.js';
import { providerSelection } from '../conversations.js';
import { requireUpdateGrant } from './update-access.js';
import { config, defaultSelection, modeDefault, saveDefaultSelection, saveModeDefault } from './providers.js';
import { digest, reserveRequest } from './database.js';
import { object, fail } from '../validation.js';

const modes = ['debate', 'parallel', 'besties', 'delegate'];
const publicSelection = selection => selection ? { provider: selection.provider, model: selection.model, effort: selection.effort } : null;
export function remoteDefaults(row) {
  requireUpdateGrant(row);
  const assistant = new CoreAssistant().settings();
  const defaults = { cli: publicSelection(defaultSelection()), core: assistant.selection,
    ...Object.fromEntries(modes.map(mode => [mode, modeDefault(mode)?.map(publicSelection) || null])) };
  // Includes the legacy default provider so a concurrent CLI edit also conflicts.
  return { revision: digest({ defaults, provider: config().defaultProvider, coreRevision: assistant.revision }), defaults };
}
export function configureRemoteDefaults(row, input, requestId) {
  requireUpdateGrant(row); object(input, ['target', 'expectedRevision', 'agents']);
  if (!['cli', 'core', ...modes].includes(input.target) || typeof input.expectedRevision !== 'string'
    || !Array.isArray(input.agents) || input.agents.length < 1 || input.agents.length > 3) fail('INVALID_REQUEST', 'Choose a default and its model selections.');
  const agents = input.agents.map(providerSelection);
  if (['cli', 'core'].includes(input.target) ? agents.length !== 1 : input.target === 'delegate' ? agents.length !== 2 : agents.length < 2) fail('INVALID_REQUEST', 'Invalid number of agents.');
  const scope = `remote-defaults:${row.peerId}:${row.id}`;
  // CoreAssistant owns its independent durable revision/idempotency contract.
  if (input.target === 'core') {
    const current = remoteDefaults(row);
    // Use a separate receipt to retain the original revision for deliberate retries.
    const reservation = reserveRequest(scope + ':prepare', requestId, input, () => {
      if (current.revision !== input.expectedRevision) fail('CONFLICT', 'Defaults changed. Reload before saving.', 409);
      return { revision: new CoreAssistant().settings().revision };
    });
    new CoreAssistant().configure({ source: 'core', ...agents[0] }, { expectedRevision: reservation.revision, requestId: `${row.id.slice(0, 32)}.${requestId}` });
    return remoteDefaults(row);
  }
  return reserveRequest(scope, requestId, input, () => {
    requireUpdateGrant(row);
    if (remoteDefaults(row).revision !== input.expectedRevision) fail('CONFLICT', 'Defaults changed. Reload before saving.', 409);
    if (input.target === 'cli') saveDefaultSelection({ ...agents[0], selectedEffort: agents[0].effort });
    else saveModeDefault(input.target, agents);
    return remoteDefaults(row);
  });
}
