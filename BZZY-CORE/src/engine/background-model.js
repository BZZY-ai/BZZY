import { CoreAssistant } from '../assistant.js';
import { providerSelection } from '../conversations.js';
import { object, fail } from '../validation.js';
import { database, getRecord, putRecord, reserveRequest, transaction, now } from './database.js';

const KIND = 'core.background-model', ID = 'default';
const atomic = operation => database().isTransaction ? operation(database()) : transaction(operation);

// Trusted local owner setup only. This selection grants no tools, account
// bindings or execution rights, and is never exposed as a model tool.
export function backgroundModelSettings() {
  const saved = getRecord(KIND, ID) || { source: 'core', revision: 0 };
  if (!['core', 'custom'].includes(saved.source) || !Number.isSafeInteger(saved.revision) || saved.revision < 0) {
    fail('INVALID_SETTINGS', 'The shared compactor and consensus model settings are invalid.');
  }
  if (saved.source === 'custom') {
    const selection = providerSelection(saved.selection);
    return { source: 'custom', revision: saved.revision, configured: true, selection, coordinatorRevision: null };
  }
  const coordinator = new CoreAssistant().settings();
  return { source: 'core', revision: saved.revision, configured: coordinator.configured,
    selection: coordinator.selection, coordinatorRevision: coordinator.revision };
}

export function configureBackgroundModel(input, { expectedRevision, requestId } = {}) {
  object(input, ['source', 'provider', 'model', 'effort']);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) fail('INVALID_REQUEST', 'Use the displayed shared background model revision.');
  if (!['core', 'custom'].includes(input.source) || input.source === 'core' && Object.keys(input).length !== 1) {
    fail('INVALID_REQUEST', 'Inherit Core or choose an explicit shared compactor and consensus model.');
  }
  const apply = db => {
    const previous = getRecord(KIND, ID);
    if ((previous?.revision || 0) !== expectedRevision) fail('CONFLICT', 'Shared background model settings changed. Reload before editing.', 409);
    const selection = input.source === 'custom' ? providerSelection({ provider: input.provider, model: input.model, effort: input.effort }) : null;
    putRecord(KIND, ID, { source: input.source, revision: expectedRevision + 1,
      ...(selection ? { selection } : {}), updatedAt: now() }, db);
    return backgroundModelSettings();
  };
  return requestId === undefined ? atomic(apply) : reserveRequest('core:background-model:configure', requestId, { input, expectedRevision }, apply);
}
