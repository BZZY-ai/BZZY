import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest, getRecord, putRecord, removeRecord } from './database.js';
import { home } from './files.js';
import { loadSession, lockFile, sessionDeleted } from './store.js';
import { assertSessionIdle } from './models.js';

const conflict = message => { throw Object.assign(new Error(message), { code: 'IMPORT_CONFLICT' }); };
const fingerprint = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const recordKey = row => `${row.kind}:${row.id}`;
const eventDigest = event => digest({ seq: event.seq, sessionId: event.sessionId, type: event.type, data: event.data, createdAt: event.createdAt });

// Only a peer authenticated by the transfer layer may identify a source across
// archives. A manifest's own identity claims never establish that namespace.
export function openProjectImport(manifest, root, sourceFingerprint, archiveSha256) {
  if (sourceFingerprint === undefined) return null;
  if (!fingerprint(sourceFingerprint) || !/^[a-f0-9]{64}$/.test(archiveSha256)) conflict('The trusted project sender or archive identity is invalid.');
  const id = digest([root, sourceFingerprint, manifest.sourceRoot]);
  const unlock = lockFile(path.join(home(), 'project-imports', `${id}.lock`), 'Another import from this source is already in progress.');
  try {
    const pin = fs.statSync(root, { bigint: true }), location = `${pin.dev}:${pin.ino}`;
    const previous = getRecord('project-import-source', id);
    const pending = getRecord('project-import-pending', id);
    if (previous && (previous.root !== root || previous.location !== location || previous.sourceFingerprint !== sourceFingerprint)) conflict('The imported project directory changed. Choose a new destination.');
    if (pending && (pending.root !== root || pending.location !== location || pending.sourceFingerprint !== sourceFingerprint ||
      pending.previousDigest !== digest(previous))) conflict('The interrupted import no longer matches this destination. Choose a new directory.');
    const receipt = getRecord('project-import-archive', digest([id, archiveSha256]));
    if (previous) for (const sessionId of previous.sessionIds) {
      const session = loadSession(sessionId);
      if (!session || sessionDeleted(sessionId)) conflict('A previously imported chat was deleted. Import into a new directory to create another copy.');
    }
    if (receipt) {
      const sessions = receipt.sessionIds.map(id => loadSession(id));
      if (sessions.some(session => !session)) conflict('A previously imported chat was deleted. Import into a new directory to create another copy.');
      return { id, unlock, alreadyImported: true, result: { cwd: root, sessions, primarySession: loadSession(receipt.primarySessionId),
        alreadyImported: true, added: { sessions: 0, records: 0, events: 0 }, preserved: receipt.sessionIds.length } };
    }
    if (previous) for (const sessionId of previous.sessionIds) {
      try { assertSessionIdle(loadSession(sessionId)); }
      catch (error) { throw Object.assign(error, { code: 'IMPORT_ACTIVE' }); }
    }
    const events = new Map(manifest.events.map(event => [String(event.seq), event]));
    if (events.size !== manifest.events.length) conflict('The source history contains duplicate event identities.');
    for (const [sequence, expected] of Object.entries({ ...(previous?.eventDigests || {}), ...(pending?.eventDigests || {}) })) {
      const current = events.get(sequence);
      if (!current || eventDigest(current) !== expected) conflict('The source history changed or omitted previously imported messages. Nothing was merged.');
    }
    return { id, unlock, root, location, sourceFingerprint, archiveSha256, previous,
      bundleId: previous?.bundleId || pending?.bundleId || randomUUID(), projectId: previous?.projectId || pending?.projectId || randomUUID(),
      importedAt: previous?.importedAt || pending?.importedAt || new Date().toISOString(), ids: new Map(Object.entries(pending?.ids || previous?.ids || {})),
      knownRecords: new Set(Object.keys(previous?.recordDigests || {})),
      recordDigests: { ...(previous?.recordDigests || {}) }, eventDigests: { ...(previous?.eventDigests || {}) },
      newEvents: manifest.events.filter(event => !Object.hasOwn(previous?.eventDigests || {}, String(event.seq))) };
  } catch (error) { unlock(); throw error; }
}

export function knownImportedRecord(journal, row) { return Boolean(journal?.knownRecords.has(recordKey(row))); }

// Publish the stable identity plan before touching the recipient project. A
// process interruption can leave copied files, but an explicit retry reuses the
// same names and IDs instead of conflicting with its own half-finished copy.
export function prepareProjectImport(journal, manifest) {
  if (!journal) return;
  const current = getRecord('project-import-source', journal.id);
  if (digest(current) !== digest(journal.previous)) conflict('Another import changed this source. Retry the reviewed import.');
  putRecord('project-import-pending', journal.id, { root: journal.root, location: journal.location,
    sourceFingerprint: journal.sourceFingerprint, previousDigest: digest(journal.previous), bundleId: journal.bundleId,
    projectId: journal.projectId, importedAt: journal.importedAt, ids: Object.fromEntries(journal.ids),
    eventDigests: Object.fromEntries(manifest.events.map(event => [String(event.seq), eventDigest(event)])),
    updatedAt: new Date().toISOString() });
}

export function commitProjectImport(journal, manifest, records, imported, primarySession, db) {
  if (!journal) return;
  const current = getRecord('project-import-source', journal.id);
  if (digest(current) !== digest(journal.previous)) conflict('Another import changed this source. Retry the reviewed import.');
  const pin = fs.statSync(journal.root, { bigint: true });
  if (`${pin.dev}:${pin.ino}` !== journal.location) conflict('The project directory changed during import.');
  for (const row of manifest.records) journal.recordDigests[recordKey(row)] = digest(row);
  for (const event of manifest.events) journal.eventDigests[String(event.seq)] = eventDigest(event);
  for (const [index, row] of manifest.records.entries()) {
    if (row.kind !== 'session' || !knownImportedRecord(journal, row)) continue;
    const record = records[index], goal = record?.data.goal;
    if (!goal || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(goal.id || '') ||
      loadSession(record.id)?.goal?.id === goal.id || getRecord('goal-history', goal.id)) continue;
    putRecord('goal-history', goal.id, { ...goal, sessionId: record.id, importedHistorical: true,
      importProvenance: { sourceRecordId: row.data.goal.id, bundleId: journal.bundleId,
        importedAt: new Date().toISOString(), observation: 'imported-history' } }, db);
    // A later source archive may supersede this same goal into its ordinary
    // goal-history table. Treat that as the same history, never a new object.
    journal.recordDigests[`goal-history:${row.data.goal.id}`] ||= digest({ historicalGoal: row.data.goal });
  }
  const sessionIds = [...new Set([...(journal.previous?.sessionIds || []), ...imported.map(row => row.id)])];
  const primarySessionId = journal.previous?.primarySessionId || primarySession?.id || imported.find(row => !row.data.parentSessionId)?.id || null;
  const source = { id: journal.id, root: journal.root, location: journal.location, sourceFingerprint: journal.sourceFingerprint,
    sourceRoot: manifest.sourceRoot, bundleId: journal.bundleId, projectId: journal.projectId, importedAt: journal.importedAt,
    ids: Object.fromEntries(journal.ids), recordDigests: journal.recordDigests, eventDigests: journal.eventDigests,
    sessionIds, primarySessionId, updatedAt: new Date().toISOString() };
  putRecord('project-import-source', journal.id, source, db);
  putRecord('project-import-archive', digest([journal.id, journal.archiveSha256]), { sourceId: journal.id,
    archiveSha256: journal.archiveSha256, sessionIds, primarySessionId, importedAt: source.updatedAt }, db);
  removeRecord('project-import-pending', journal.id);
  // Changed mutable source records remain inspectable historical snapshots; they
  // never overwrite a recipient session, goal, evidence receipt or local work.
  for (const [index, row] of manifest.records.entries()) if (knownImportedRecord(journal, row) &&
    journal.previous.recordDigests[recordKey(row)] !== digest(row)) {
    putRecord('project-import-record-version', digest([journal.id, row.kind, row.id, digest(row)]), {
      sourceId: journal.id, archiveSha256: journal.archiveSha256, sourceKind: row.kind, sourceRecordId: row.id,
      importedAt: source.updatedAt, observation: 'imported-history', data: records[index]?.data,
    }, db);
  }
}
