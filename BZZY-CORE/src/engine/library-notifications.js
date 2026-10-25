import { database, getRecord, putRecord, digest, now, transaction } from './database.js';
import { notificationPreview } from './notification-preview.js';
import { sharedSecrets } from './share-bundle-policy.js';

const registries = { skill: 'core.skill', specialist: 'core.subagent.definition', agent: 'core.agent' };
export const libraryNotificationTypes = new Set(['library.skill_created', 'library.agent_created']);
const fingerprint = (kind, row) => digest({ kind, id: row.id, name: row.name, description: row.description || '',
  version: row.version || null, createdAt: row.createdAt || null, scope: row.scope || null, projectId: row.projectId || null,
  generation: kind === 'skill' ? getRecord('core.skill.deleted', row.id)?.revision || 0 : row.revision });
const live = row => row && !row.deletedAt && !row.archivedAt;

// Host registry mutations call this inside their transaction. Models cannot
// enqueue arbitrary announcements, and drafts never pass through this path.
export function recordLibraryCreation(kind, id, { sourceSessionId } = {}, db = database()) {
  if (!registries[kind]) throw new Error('Unknown library creation kind.');
  const publish = connection => {
    const row = getRecord(registries[kind], id);
    if (!live(row)) return null;
    const signature = fingerprint(kind, row), deleted = kind === 'skill' && getRecord('core.skill.deleted', id);
    const key = digest({ kind, id, signature, revision: row.revision, createdAt: row.updatedAt || row.createdAt, previousDeletion: deleted?.deletedAt || null });
    const previous = getRecord('outbox', key);
    if (previous) return previous.event;
    let name = '', description = '';
    try { const secrets = sharedSecrets(); name = notificationPreview(row.name, 64, secrets); description = notificationPreview(row.description, 180, secrets); } catch {}
    const source = sourceSessionId || row.provenance?.sourceSessionId || (kind === 'agent' ? row.sessionId : null);
    const sourceRow = source && getRecord('session', source);
    const event = { version: 1, id: key, type: kind === 'skill' ? 'library.skill_created' : 'library.agent_created',
      occurredAt: now(), definitionKind: kind, definitionId: id, definitionFingerprint: signature,
      name, description, ...(sourceRow && !getRecord('session-deletion', source) ? { sessionId: source } : {}) };
    putRecord('core.library.creation', key, { id: key, kind, definitionId: id, fingerprint: signature, eventFingerprint: digest(event) }, connection);
    putRecord('outbox', key, { event, deliveries: {} }, connection); return event;
  };
  return db.isTransaction ? publish(db) : transaction(publish);
}

export function currentLibraryCreation(event) {
  if (!libraryNotificationTypes.has(event?.type) || !registries[event.definitionKind]) return null;
  const receipt = getRecord('core.library.creation', event.id), row = getRecord(registries[event.definitionKind], event.definitionId);
  if (!receipt || !live(row) || receipt.kind !== event.definitionKind || receipt.definitionId !== row.id ||
      receipt.eventFingerprint !== digest(event) || receipt.fingerprint !== event.definitionFingerprint || fingerprint(event.definitionKind, row) !== event.definitionFingerprint ||
      event.type !== (event.definitionKind === 'skill' ? 'library.skill_created' : 'library.agent_created')) return null;
  return row;
}

export function libraryCreationAlert(event, secrets = []) {
  const label = event.type === 'library.skill_created' ? 'Skill created' : 'Agent created';
  const name = notificationPreview(event.name, 64, secrets), description = notificationPreview(event.description, 180, secrets);
  return { title: name ? `${label} - ${name}` : label,
    body: description || (event.type === 'library.skill_created' ? 'A new skill is available in Library.' : 'A new agent definition is available.') };
}
