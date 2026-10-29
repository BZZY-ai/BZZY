import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSession, saveSession } from '../src/engine/store.js';
import { getProvider } from '../src/engine/providers.js';
import { initializeProject } from '../src/engine/project.js';
import { getRecord, listRecords, events, putRecord } from '../src/engine/database.js';
import { recordActivity, closeOpenActivities } from '../src/engine/activity.js';
import { sessionMemoryDocument, exportSessionMemoryDocument } from '../src/engine/session-memory-document.js';

let root, prior, session;
test.beforeEach(() => {
  prior = process.env.BZZY_HOME; root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-memory-view-')));
  process.env.BZZY_HOME = path.join(root, 'private'); const cwd = path.join(root, 'project'); fs.mkdirSync(cwd);
  session = createSession(getProvider('codex'), cwd, 'fixture-model'); initializeProject(session); saveSession(session);
});
test.afterEach(() => { if (prior === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = prior; fs.rmSync(root, { recursive: true, force: true }); });

test('repeated inferred activity coalesces project writes while preserving every Core call and outcome', () => {
  const records = [];
  for (let index = 0; index < 30; index++) records.push(recordActivity(session, { summary: 'Reviewing the relevant files', details: 'Inspecting the current workspace.', status: 'running' }, null,
    { provenance: 'host-inferred', source: 'native-tool', toolCallId: `call-${index}` }));
  recordActivity(session, { ...records[0], status: 'completed' }, null, { provenance: 'host-inferred', source: 'native-tool', toolCallId: 'call-0' });
  assert.equal(listRecords('activity').length, 30); assert.equal(events(session.id, 0, 100).filter(item => item.type === 'activity').length, 31);
  let aggregate = listRecords('core.activity.coalesced')[0]; assert.equal(aggregate.count, 30); assert.equal(aggregate.statuses.completed, 1);
  const ledger = path.join(session.cwd, '.bzzy', 'ledger');
  const lines = () => fs.readdirSync(ledger).flatMap(file => fs.readFileSync(path.join(ledger, file), 'utf8').trim().split('\n')).map(line => JSON.parse(line));
  assert.equal(lines().filter(item => item.kind === 'activities').length, 1);
  closeOpenActivities(session);
  aggregate = getRecord('core.activity.coalesced', aggregate.id); assert.equal(aggregate.closed, true);
  assert.equal(lines().filter(item => item.kind === 'activities').length, 2);
  assert.equal(getRecord('activity', records[0].id).toolCallId, 'call-0');
});
test('a generated session view is stable, scoped, and refuses to replace user edits or follow links', () => {
  const before = listRecords('execution').length, view = sessionMemoryDocument(session);
  assert.equal(sessionMemoryDocument(session).revision, view.revision);
  assert.match(view.markdown, /Generated read-only navigation/); assert.equal(listRecords('execution').length, before);
  const receipt = exportSessionMemoryDocument(session, { expectedRevision: view.revision });
  assert.equal(fs.readFileSync(receipt.path, 'utf8'), view.markdown);
  fs.appendFileSync(receipt.path, '\nAn owner proposal.');
  assert.throws(() => exportSessionMemoryDocument(session, { expectedRevision: view.revision }), { code: 'MEMORY_VIEW_EDITED' });
  fs.unlinkSync(receipt.path); fs.symlinkSync(path.join(root, 'outside'), receipt.path);
  fs.writeFileSync(path.join(root, 'outside'), 'untouched');
  assert.throws(() => exportSessionMemoryDocument(session, { expectedRevision: view.revision }), { code: 'MEMORY_SCOPE' });
  assert.equal(fs.readFileSync(path.join(root, 'outside'), 'utf8'), 'untouched');
  const child = { ...session, id: 'foreign', parentSessionId: session.id }; putRecord('session', child.id, child);
  assert.throws(() => sessionMemoryDocument(child), { code: 'MEMORY_SCOPE' });
});

test('export preserves edits made while the new view is being written', () => {
  const view = sessionMemoryDocument(session), receipt = exportSessionMemoryDocument(session, { expectedRevision: view.revision });
  const sync = fs.fsyncSync;
  try {
    fs.fsyncSync = fd => { sync(fd); fs.appendFileSync(receipt.path, '\nConcurrent owner proposal.'); };
    assert.throws(() => exportSessionMemoryDocument(session, { expectedRevision: view.revision }), { code: 'MEMORY_VIEW_EDITED' });
  } finally { fs.fsyncSync = sync; }
  assert.match(fs.readFileSync(receipt.path, 'utf8'), /Concurrent owner proposal/);
});
