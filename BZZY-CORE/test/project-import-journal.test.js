import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { exportSharedProject, importSharedProject, collectProjectState, exportProject, importProject } from '../src/engine/project-bundle.js';
import { createSession, saveSession, loadSession, setSessionAlias } from '../src/engine/store.js';
import { BUILTINS } from '../src/engine/providers.js';
import { appendEvent, getRecord, putRecord, listRecords, database } from '../src/engine/database.js';
import { conversationMessages, conversationCursor } from '../src/engine/conversation.js';
import { initializeProject } from '../src/engine/project.js';
import { remember, recall, memoryHistory } from '../src/engine/memory.js';
import { newGoal } from '../src/engine/goals.js';
import { indexSessionMemory, sessionMemoryStatus } from '../src/engine/session-memory.js';

const sender = 'A'.repeat(43), otherSender = 'B'.repeat(43);
let directory, work, target, sourceHome, recipientHome, previous;
test.beforeEach(() => {
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-project-import-journal-')));
  work = path.join(directory, 'source'); target = path.join(directory, 'target'); fs.mkdirSync(work); fs.mkdirSync(target);
  sourceHome = path.join(directory, 'source-private'); recipientHome = path.join(directory, 'recipient-private');
  previous = { BZZY_HOME: process.env.BZZY_HOME, BZZY_CODEX_HOME: process.env.BZZY_CODEX_HOME };
  source();
});
test.afterEach(() => {
  for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  fs.rmSync(directory, { recursive: true, force: true });
});
const source = () => { process.env.BZZY_HOME = sourceHome; process.env.BZZY_CODEX_HOME = path.join(directory, 'source-codex'); };
const recipient = () => { process.env.BZZY_HOME = recipientHome; process.env.BZZY_CODEX_HOME = path.join(directory, 'recipient-codex'); };
function original() {
  const session = createSession(BUILTINS.codex, work, 'source-model', 'source-chat'); initializeProject(session);
  session.goal = newGoal('Initial source goal'); session.goal.status = 'complete'; saveSession(session);
  fs.writeFileSync(path.join(work, 'source.txt'), 'Original ordinary project content.');
  appendEvent(session.id, 'message.user', { text: 'Original complete user request' });
  appendEvent(session.id, 'text', { text: 'Original complete assistant answer' });
  return session;
}
async function exported(session, name) { source(); return exportSharedProject(session, path.join(directory, name + '.zip')); }
async function imported(file, fingerprint = sender) { recipient(); return importSharedProject(file, target, undefined, { sourceFingerprint: fingerprint }); }
const messages = id => conversationMessages(id, conversationCursor(id)).map(message => message.content);
function counts() { return { sessions: listRecords('session').length, records: database().prepare('SELECT count(*) AS n FROM records').get().n,
  events: database().prepare('SELECT count(*) AS n FROM events').get().n }; }

test('local project archives rebuild native context and derived source cursors rather than importing sender process state', async () => {
  const session = original();
  Object.assign(session, { nativeContext: { epoch: 50, refresh: { state: 'dispatching' } }, nativeContextBudget: { tokens: 32768 },
    nativeBackendReadiness: { phase: 'request-accepted' }, contextEfficiency: { taskStateReads: 50 }, coreSkillsProtocol: 6,
    sessionMemoryRefresh: true, sessionMemorySeen: { generation: 'sender-generation' } }); saveSession(session);
  const kinds = ['native-compaction', 'core.conversation.source', 'core.conversation.pending', 'core.history.maintenance',
    'core.task-state.read', 'core.checkpoint.scope', 'core.checkpoint.request', 'core.workflow.work-unit', 'core.workflow.consultation',
    'core.session.memory', 'core.session.memory.node', 'core.session.memory.history', 'core.session.compactor.job',
    'core.session.compactor.control', 'core.session.compactor.reservation', 'usage.run', 'usage.goal', 'core.assignment.budget-progress'];
  for (const kind of kinds) putRecord(kind, randomUUID(), { sessionId: session.id, scanSeq: 900000, state: 'open' });
  const state = collectProjectState(work, session.id);
  assert.equal(state.records.some(row => kinds.includes(row.kind)), false);
  const archive = await exportProject(session, path.join(directory, 'local-project.zip'));
  // An older sender can still supply source-local cursors/jobs. Recipient
  // filtering must reject them even when the sender did not know this policy.
  const legacy = path.join(directory, 'legacy-runtime-project.zip');
  const patched = spawnSync('python3', ['-I', '-B', '-c', `import json,sys,zipfile,uuid
with zipfile.ZipFile(sys.argv[1]) as source, zipfile.ZipFile(sys.argv[2],'w') as target:
 for item in source.infolist():
  data=source.read(item.filename)
  if item.filename=='bundle.json':
   manifest=json.loads(data)
   for kind in json.loads(sys.argv[3]): manifest['records'].append({'kind':kind,'id':str(uuid.uuid4()),'data':{'sessionId':sys.argv[4],'scanSeq':900000,'state':'running'}})
   for row in manifest['records']:
    if row['kind']=='session': row['data'].setdefault('goal',{})['workerBudgetPolicy']={'version':1,'mode':'adaptive','revision':99}
   data=json.dumps(manifest).encode()
  target.writestr(item,data)
`, archive.path, legacy, JSON.stringify(kinds), session.id], { encoding: 'utf8' });
  assert.equal(patched.status, 0, patched.stderr);
  recipient(); const result = await importProject(legacy, target), restored = result.primarySession;
  assert.notEqual(restored.id, session.id); assert.equal(restored.engineThreadId, null);
  for (const field of ['nativeContext', 'nativeContextBudget', 'nativeBackendReadiness', 'contextEfficiency', 'coreSkillsProtocol', 'sessionMemoryRefresh', 'sessionMemorySeen']) {
    assert.equal(restored[field], undefined, field);
  }
  for (const kind of kinds) assert.equal(listRecords(kind, { sessionId: restored.id }).length, 0, kind);
  assert.equal(restored.goal.workerBudgetPolicy, undefined);
  assert.equal(sessionMemoryStatus(restored).generation, null);
  indexSessionMemory(restored, { force: true });
  assert.equal(sessionMemoryStatus(restored).sourceVersion, 4);
  assert.equal(listRecords('core.session.compactor.job').length, 0);
  assert.equal(listRecords('usage.run').length, 0); assert.equal(listRecords('usage.goal').length, 0);
  assert.ok(messages(restored.id).includes('Original complete assistant answer'));
});

test('authenticated exact archive retries survive restart without duplicate chats, events or local changes', async () => {
  const session = original(), archive = await exported(session, 'first');
  const first = await imported(archive.path), id = first.primarySession.id;
  const local = loadSession(id); local.model = 'recipient-model'; local.goal = newGoal('Recipient private task'); local.goal.status = 'paused'; saveSession(local);
  putRecord('execution', randomUUID(), { sessionId: id, state: 'queued' });
  fs.writeFileSync(path.join(target, 'source.txt'), 'Recipient edited ordinary project content.');
  const before = counts(), second = await imported(archive.path);
  assert.equal(second.alreadyImported, true); assert.equal(second.primarySession.id, id);
  assert.equal(second.primarySession.model, 'recipient-model'); assert.equal(second.primarySession.goal.objective, 'Recipient private task');
  assert.deepEqual(counts(), before); assert.equal(fs.readFileSync(path.join(target, 'source.txt'), 'utf8'), 'Recipient edited ordinary project content.');
  const code = `import { importSharedProject } from ${JSON.stringify(new URL('../src/engine/project-bundle.js', import.meta.url).href)};
const result=await importSharedProject(process.argv[1],process.argv[2],undefined,{sourceFingerprint:process.argv[3]});
process.stdout.write(JSON.stringify({id:result.primarySession.id,alreadyImported:result.alreadyImported}));`;
  const restarted = spawnSync(process.execPath, ['--input-type=module', '-e', code, archive.path, target, sender], { encoding: 'utf8', env: process.env });
  assert.equal(restarted.status, 0, restarted.stderr); assert.deepEqual(JSON.parse(restarted.stdout), { id, alreadyImported: true });
  assert.deepEqual(counts(), before);
});

test('a process interruption after file merge recovers stable IDs on explicit retry, without exporting uncommitted sessions', async () => {
  const session = original(), archive = await exported(session, 'interrupted'); recipient();
  const code = `import { DatabaseSync } from 'node:sqlite';
const prepare=DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare=function(sql){const statement=prepare.call(this,sql);if(sql.startsWith('INSERT INTO records VALUES')){
 const run=statement.run.bind(statement);statement.run=(...args)=>{if(args[0]==='session')process.exit(73);return run(...args);};}return statement;};
const {importSharedProject}=await import(${JSON.stringify(new URL('../src/engine/project-bundle.js', import.meta.url).href)});
await importSharedProject(process.argv[1],process.argv[2],undefined,{sourceFingerprint:process.argv[3]});`;
  const interrupted = spawnSync(process.execPath, ['--input-type=module', '-e', code, archive.path, target, sender], { encoding: 'utf8', env: process.env });
  assert.equal(interrupted.status, 73, interrupted.stderr);
  const pending = listRecords('project-import-pending')[0]; assert.ok(pending);
  assert.equal(listRecords('session').length, 0); assert.equal(listRecords('project-import-source').length, 0);
  assert.equal(fs.existsSync(path.join(recipientHome, 'sessions')), false);
  assert.equal(fs.readFileSync(path.join(target, 'source.txt'), 'utf8'), 'Original ordinary project content.');
  const result = await imported(archive.path);
  assert.equal(result.primarySession.id, pending.ids[session.id]); assert.equal(result.sessions.length, 1);
  assert.equal(listRecords('session').length, 1); assert.equal(listRecords('project-import-pending').length, 0);
  assert.equal(messages(result.primarySession.id).filter(value => value === 'Original complete assistant answer').length, 1);
  assert.equal((await imported(archive.path)).alreadyImported, true);
});

test('new source history and missing files append once while local model, goal and local messages stay unchanged', async () => {
  const session = original(), firstArchive = await exported(session, 'first');
  const first = await imported(firstArchive.path), id = first.primarySession.id;
  const local = loadSession(id); local.model = 'recipient-model'; local.goal = newGoal('Recipient current goal'); local.goal.status = 'paused'; saveSession(local);
  appendEvent(id, 'message.user', { text: 'Recipient own newer request' });
  const localBefore = loadSession(id);
  source();
  session.goal = newGoal('Later source goal'); session.goal.status = 'complete'; session.turns = 2; saveSession(session);
  const newerGoal = session.goal.id;
  appendEvent(session.id, 'message.user', { text: 'Source follow-up request' });
  appendEvent(session.id, 'text', { text: 'Source follow-up answer' });
  fs.writeFileSync(path.join(work, 'new.txt'), 'New missing source file.');
  const secondArchive = await exported(session, 'second'), second = await imported(secondArchive.path);
  assert.equal(second.primarySession.id, id); assert.equal(second.added.sessions, 0); assert.ok(second.added.events >= 2); assert.equal(second.preserved, 1);
  assert.equal(listRecords('session').length, 1); assert.deepEqual(loadSession(id), localBefore);
  assert.equal(messages(id).filter(value => value === 'Source follow-up answer').length, 1);
  assert.ok(messages(id).includes('Recipient own newer request'));
  assert.equal(fs.readFileSync(path.join(target, 'new.txt'), 'utf8'), 'New missing source file.');
  const historic = listRecords('goal-history').find(goal => goal.objective === 'Later source goal');
  assert.ok(historic); assert.notEqual(historic.id, newerGoal); assert.equal(historic.importedHistorical, true);
  assert.ok(listRecords('project-import-record-version').some(row => row.sourceKind === 'session'));
  const before = counts(); assert.equal((await imported(secondArchive.path)).alreadyImported, true); assert.deepEqual(counts(), before);
  // Re-exporting an unchanged snapshot creates a new ZIP timestamp, but source
  // event identities still suppress duplicate history and source sessions.
  const thirdArchive = await exported(session, 'third'), third = await imported(thirdArchive.path);
  assert.equal(third.added.sessions, 0); assert.equal(third.added.events, 0); assert.equal(messages(id).filter(value => value === 'Source follow-up answer').length, 1);
});

test('source history edits, deleted recipient chats and changed recipient files fail before partial context commits', async () => {
  const session = original(), first = await exported(session, 'first'); const result = await imported(first.path);
  const id = result.primarySession.id, before = counts();
  source(); database().prepare("UPDATE events SET data=? WHERE session_id=? AND type='text'").run(JSON.stringify({ text: 'Rewritten old source answer' }), session.id);
  fs.writeFileSync(path.join(work, 'new.txt'), 'Must not appear after a fork conflict.');
  const fork = await exported(session, 'fork');
  await assert.rejects(imported(fork.path), error => error.code === 'IMPORT_CONFLICT' && /history changed/.test(error.message));
  assert.deepEqual(counts(), before); assert.equal(fs.existsSync(path.join(target, 'new.txt')), false);
  source(); database().prepare("UPDATE events SET data=? WHERE session_id=? AND type='text'").run(JSON.stringify({ text: 'Original complete assistant answer' }), session.id);
  fs.writeFileSync(path.join(work, 'source.txt'), 'Source changed existing file.');
  appendEvent(session.id, 'text', { text: 'Cannot append if ordinary project files conflict.' });
  const conflict = await exported(session, 'conflict');
  await assert.rejects(imported(conflict.path), { code: 'IMPORT_CONFLICT' });
  assert.deepEqual(counts(), before); assert.equal(fs.existsSync(path.join(target, 'new.txt')), false);
  assert.equal(fs.readFileSync(path.join(target, 'source.txt'), 'utf8'), 'Original ordinary project content.');
  putRecord('session-deletion', id, { sessionId: id });
  await assert.rejects(imported(first.path), error => error.code === 'IMPORT_CONFLICT' && /deleted/.test(error.message));
  assert.equal(loadSession(id), null);
});

test('newer mutable BZZY metadata remains complete in versioned context without overwriting recipient knowledge files', async () => {
  const session = original();
  fs.writeFileSync(path.join(work, '.bzzy', 'notes.txt'), 'Original source notes.');
  fs.mkdirSync(path.join(work, '.bzzy', 'checkpoints'));
  fs.writeFileSync(path.join(work, '.bzzy', 'checkpoints', `${session.id}.json`), JSON.stringify({ sessionId: session.id, objective: 'Original checkpoint' }));
  const first = await exported(session, 'metadata-first'), result = await imported(first.path), id = result.primarySession.id;
  fs.writeFileSync(path.join(target, '.bzzy', 'notes.txt'), 'Recipient own notes.');
  const ownCheckpoint = path.join(target, '.bzzy', 'checkpoints', `${id}.json`), checkpointBefore = fs.readFileSync(ownCheckpoint, 'utf8');
  source();
  fs.writeFileSync(path.join(work, '.bzzy', 'notes.txt'), 'Source updated notes.');
  fs.writeFileSync(path.join(work, '.bzzy', 'checkpoints', `${session.id}.json`), JSON.stringify({ sessionId: session.id, objective: 'Source updated checkpoint' }));
  const activityId = randomUUID();
  putRecord('activity', activityId, { id: activityId, sessionId: session.id, cwd: work, metadataPath: path.join(work, '.bzzy', 'notes.txt') });
  appendEvent(session.id, 'text', { text: 'New history alongside mutable BZZY metadata.' });
  const second = await exported(session, 'metadata-second'), updated = await imported(second.path);
  assert.equal(updated.primarySession.id, id); assert.ok(updated.added.events >= 1);
  assert.equal(fs.readFileSync(path.join(target, '.bzzy', 'notes.txt'), 'utf8'), 'Recipient own notes.');
  assert.equal(fs.readFileSync(ownCheckpoint, 'utf8'), checkpointBefore);
  const importedActivity = listRecords('activity').find(row => row.importProvenance?.sourceRecordId === activityId);
  assert.ok(importedActivity); assert.match(importedActivity.metadataPath, /versions.*metadata/);
  assert.equal(fs.readFileSync(importedActivity.metadataPath, 'utf8'), 'Source updated notes.');
  const namespace = listRecords('project-import-source')[0];
  const versionDirectories = fs.readdirSync(path.join(target, '.bzzy', 'imports', namespace.bundleId, 'versions'));
  const preserved = versionDirectories.map(version => path.join(target, '.bzzy', 'imports', namespace.bundleId, 'versions', version, 'metadata', 'checkpoints', `${id}.json`))
    .filter(file => fs.existsSync(file));
  assert.equal(preserved.length, 1);
  assert.match(fs.readFileSync(preserved[0], 'utf8'), /Source updated checkpoint/);
  assert.equal(messages(id).filter(value => value.includes('New history alongside mutable BZZY metadata.')).length, 1);
});

test('source namespaces require the authenticated peer and never borrow a manifest identity or another sender receipt', async () => {
  const session = original(), archive = await exported(session, 'first');
  const first = await imported(archive.path), before = counts();
  await assert.rejects(imported(archive.path, 'not-a-fingerprint'), { code: 'IMPORT_CONFLICT' });
  await assert.rejects(imported(archive.path, otherSender), { code: 'IMPORT_CONFLICT' });
  assert.deepEqual(counts(), before); assert.equal(loadSession(first.primarySession.id).id, first.primarySession.id);
  assert.equal(listRecords('project-import-source').length, 1);
});

test('project knowledge originals and revision histories transfer as inconclusive data, with recall rebuilt from originals', async () => {
  const session = original();
  const memory = remember(session, { kind: 'hypothesis', statement: 'Shared project knowledge about the local control.', rationale: 'Preserve this original reasoning summary.', inputs: ['source.txt'] });
  const originalRevision = getRecord('core.memory.revision', `${memory.id}:1`);
  putRecord('core.memory.revision', `${memory.id}:1`, { ...originalRevision, truth: 'confirmed', verificationId: randomUUID() });
  putRecord('core.knowledge.profile', 'owner-private', { target: 'user', content: 'Private owner preference not part of project context.' });
  const archive = await exported(session, 'knowledge'), result = await imported(archive.path), importedSession = result.primarySession;
  const importedMemory = listRecords('memory').find(row => row.statement === memory.statement);
  assert.ok(importedMemory); assert.equal(importedMemory.truth, 'inconclusive'); assert.equal(importedMemory.projectId, importedSession.projectId);
  const revisions = memoryHistory(importedSession, importedMemory.id).items;
  assert.ok(revisions.length); assert.ok(revisions.every(row => row.truth === 'inconclusive' && row.verificationId === undefined));
  assert.ok(recall(target, 'Shared project knowledge', 10, importedSession).some(row => row.statement === memory.statement));
  assert.equal(listRecords('core.knowledge.profile').length, 0);
  assert.equal(listRecords('execution').length, 0); assert.equal(listRecords('run').length, 0);
});

test('import journals stay private even in owner backups and malicious raw archives cannot install receipt authority', async () => {
  const session = original(), kinds = ['project-import-source', 'project-import-pending', 'project-import-archive', 'project-import-record-version',
    'core.session.spending.receipt', 'core.session.spending.cursor', 'core.session.compactor.cost'];
  for (const kind of kinds) putRecord(kind, kind, { sessionId: session.id, root: work, sourceFingerprint: sender, alreadyImported: true });
  assert.ok(collectProjectState(work, session.id).records.every(row => !kinds.includes(row.kind)));
  const archive = await exportProject(session, path.join(directory, 'owner.zip'));
  const modified = path.join(directory, 'injected.zip');
  const script = 'import json,sys,zipfile\nsrc,dst,kinds=sys.argv[1:]\nwith zipfile.ZipFile(src) as z,zipfile.ZipFile(dst,"w") as out:\n for item in z.infolist():\n  data=z.read(item)\n  if item.filename=="bundle.json":\n   m=json.loads(data);m["records"].extend({"kind":kind,"id":kind,"data":{"root":m["sourceRoot"],"sessionId":m["primarySessionId"],"alreadyImported":True}} for kind in json.loads(kinds));data=json.dumps(m).encode()\n  out.writestr(item,data)\n';
  const changed = spawnSync('python3', ['-c', script, archive.path, modified, JSON.stringify(kinds)], { encoding: 'utf8' });
  assert.equal(changed.status, 0, changed.stderr); recipient();
  const result = await importProject(modified, target); assert.equal(result.sessions.length, 1);
  for (const kind of kinds) assert.equal(listRecords(kind).length, 0);
});

test('an already-cancelled receive cannot create a journal, project files or sessions', async () => {
  const session = original(), archive = await exported(session, 'cancelled'); recipient();
  const controller = new AbortController(); controller.abort();
  await assert.rejects(importSharedProject(archive.path, target, undefined, { sourceFingerprint: sender, signal: controller.signal }), { name: 'AbortError' });
  assert.deepEqual(fs.readdirSync(target), []); assert.equal(listRecords('session').length, 0);
  assert.equal(listRecords('project-import-pending').length, 0); assert.equal(listRecords('project-import-source').length, 0);
});
