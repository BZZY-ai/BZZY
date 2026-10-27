import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { exportSharedProject, importSharedProject } from '../src/engine/project-bundle.js';
import { createSession, saveSession } from '../src/engine/store.js';
import { BUILTINS, saveKey } from '../src/engine/providers.js';
import { appendEvent, putRecord, listRecords, getRecord } from '../src/engine/database.js';
import { conversationMessages, conversationCursor } from '../src/engine/conversation.js';
import { captureEvidence, readArtifact } from '../src/engine/evidence.js';
import { newGoal } from '../src/engine/goals.js';
import { enqueueExecution } from '../src/engine/execution-queue.js';

let directory, work, target, saved;
test.beforeEach(() => {
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-shared-project-')));
  work = path.join(directory, 'nasa'); target = path.join(directory, 'recipient');
  fs.mkdirSync(work); fs.mkdirSync(target);
  saved = Object.fromEntries(['BZZY_HOME', 'BZZY_CODEX_HOME'].map(key => [key, process.env[key]]));
  process.env.BZZY_HOME = path.join(directory, 'private'); process.env.BZZY_CODEX_HOME = path.join(directory, 'provider');
});
test.afterEach(() => {
  for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  fs.rmSync(directory, { recursive: true, force: true });
});
function original() {
  const session = createSession(BUILTINS.codex, work, 'local-preference', 'nasa');
  session.goal = newGoal('Check launch conditions'); session.goal.status = 'paused'; saveSession(session);
  fs.writeFileSync(path.join(work, 'source.js'), 'export const mission = "nasa";\n');
  fs.mkdirSync(path.join(work, '.bzzy')); fs.writeFileSync(path.join(work, '.bzzy', 'notes.txt'), 'Hypothesis: inspect the launch conditions.');
  appendEvent(session.id, 'message.user', { text: 'Keep the full project and this chat.' });
  appendEvent(session.id, 'text', { text: '<message version="1"><p>Canonical response.</p></message>' });
  putRecord('memory', randomUUID(), { sessionId: session.id, cwd: work, statement: 'Persistent launch context' });
  putRecord('core.binding', randomUUID(), { sessionId: session.id, secret: 'never share local authorization' });
  putRecord('access-token', randomUUID(), { sessionId: session.id, token: 'never share a host token' });
  return session;
}
test('complete-context shares restore files, notes, full chats and evidence with new IDs and paused work', async () => {
  const session = original(), evidence = captureEvidence(session, 'source.js', 'source');
  fs.writeFileSync(path.join(work, '.env'), 'API_KEY=excluded-file-secret');
  fs.writeFileSync(path.join(work, '.npmrc'), '//registry/:_authToken=excluded');
  fs.mkdirSync(path.join(work, '.git')); fs.writeFileSync(path.join(work, '.git', 'config'), 'private git credentials');
  fs.symlinkSync('source.js', path.join(work, 'source-link'));
  const childDirectory = path.join(process.env.BZZY_HOME, 'workers', randomUUID()); fs.mkdirSync(childDirectory, { recursive: true });
  fs.writeFileSync(path.join(childDirectory, 'finding.txt'), 'Child evidence');
  const child = createSession(BUILTINS.codex, childDirectory); child.parentSessionId = session.id; saveSession(child);
  const zip = await exportSharedProject(session, path.join(directory, 'share.zip'));
  assert.ok(zip.excluded.includes('workspace/.env')); assert.ok(zip.excluded.includes('workspace/.npmrc'));
  const result = await importSharedProject(zip.path, target), imported = result.primarySession;
  assert.equal(result.sessions.length, 2); assert.notEqual(imported.id, session.id);
  assert.equal(imported.cwd, target); assert.equal(imported.executionState, 'idle'); assert.equal(imported.goal.status, 'paused');
  assert.equal(imported.engineThreadId, null); assert.equal(imported.importedUntrusted, true);
  assert.equal(fs.readFileSync(path.join(target, '.bzzy', 'notes.txt'), 'utf8'), 'Hypothesis: inspect the launch conditions.');
  assert.equal(fs.readlinkSync(path.join(target, 'source-link')), 'source.js');
  assert.equal(fs.existsSync(path.join(target, '.env')), false); assert.equal(fs.existsSync(path.join(target, '.npmrc')), false); assert.equal(fs.existsSync(path.join(target, '.git')), false);
  const messages = conversationMessages(imported.id, conversationCursor(imported.id));
  assert.ok(messages.some(message => message.content.includes('full project and this chat')));
  assert.ok(messages.some(message => message.content.includes('Canonical response')));
  const importedEvidence = listRecords('artifact').find(item => item.sessionId === imported.id);
  assert.notEqual(importedEvidence.id, evidence.id); assert.match(readArtifact(importedEvidence.id).content, /mission/);
  assert.equal(listRecords('core.binding').length, 1); assert.equal(listRecords('access-token').length, 1);
  const importedWorker = result.sessions.find(item => item.parentSessionId === imported.id);
  assert.equal(fs.readFileSync(path.join(importedWorker.cwd, 'finding.txt'), 'utf8'), 'Child evidence');
  assert.equal(listRecords('execution').length, 0);
});
test('sharing blocks embedded account credentials, escaping links, hardlinks and private roots', async () => {
  const session = original(); saveKey('deepseek', 'fixture-actual-private-key-123456');
  fs.writeFileSync(path.join(work, 'unexpected.txt'), 'fixture-actual-private-key-123456');
  await assert.rejects(exportSharedProject(session, path.join(directory, 'blocked.zip')), /credential/);
  assert.equal(fs.existsSync(path.join(directory, 'blocked.zip')), false);
  fs.rmSync(path.join(work, 'unexpected.txt'));
  fs.symlinkSync('../private', path.join(work, 'escape'));
  await assert.rejects(exportSharedProject(session, path.join(directory, 'blocked.zip')), /symbolic link/);
  fs.rmSync(path.join(work, 'escape'));
  fs.linkSync(path.join(work, 'source.js'), path.join(work, 'linked'));
  await assert.rejects(exportSharedProject(session, path.join(directory, 'blocked.zip')), /hard-linked/);
  await assert.rejects(exportSharedProject(directory, path.join(directory, 'private.zip')), /private Core/);
});
test('network import rejects altered files, injected host authorization and conflicts before materializing', async () => {
  const session = original(), zip = await exportSharedProject(session, path.join(directory, 'share.zip'));
  const script = 'import json,zipfile,sys\nsrc,dst,mode=sys.argv[1:]\nwith zipfile.ZipFile(src) as z,zipfile.ZipFile(dst,"w") as o:\n for i in z.infolist():\n  data=z.read(i)\n  if mode=="file" and i.filename=="workspace/source.js": data=b"tampered"\n  if mode=="state" and i.filename=="bundle.json":\n   m=json.loads(data);m["records"].append({"kind":"core.binding","id":"host-authority","data":{"token":"injected"}});data=json.dumps(m).encode()\n  o.writestr(i,data)\n';
  for (const mode of ['file', 'state']) {
    const altered = path.join(directory, `${mode}.zip`);
    const result = spawnSync('python3', ['-c', script, zip.path, altered, mode], { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr);
    await assert.rejects(importSharedProject(altered, target), /integrity|unsupported host state/);
    assert.deepEqual(fs.readdirSync(target), []); assert.equal(getRecord('core.binding', 'host-authority'), null);
  }
  fs.writeFileSync(path.join(target, 'source.js'), 'existing recipient work');
  await assert.rejects(importSharedProject(zip.path, target), /overwrite/);
  assert.equal(fs.readFileSync(path.join(target, 'source.js'), 'utf8'), 'existing recipient work');
  assert.equal(listRecords('session').length, 1);
});

test('shared imports deny home/private destinations and shell startup files never materialize', async () => {
  const session = original(); fs.writeFileSync(path.join(work, '.zshrc'), 'echo untrusted shell startup');
  const zip = await exportSharedProject(session, path.join(directory, 'share.zip'));
  assert.ok(zip.excluded.includes('workspace/.zshrc'));
  for (const location of [os.homedir(), '/', process.env.BZZY_HOME, directory]) {
    await assert.rejects(importSharedProject(zip.path, location), /ordinary project|private bzzy/);
  }
  await importSharedProject(zip.path, target);
  assert.equal(fs.existsSync(path.join(target, '.zshrc')), false);
});

test('imported completion is historical and cannot emit new verified goal alerts until explicit local goal execution', async () => {
  const session = original(); session.goal.status = 'complete'; putRecord('session', session.id, session);
  const zip = await exportSharedProject(session, path.join(directory, 'share.zip'));
  const { primarySession } = await importSharedProject(zip.path, target);
  assert.equal(primarySession.goal.status, 'complete'); assert.equal(primarySession.goal.importedHistorical, true);
  const before = listRecords('outbox').length;
  saveSession({ ...primarySession, alias: 'Renamed imported session' });
  assert.equal(listRecords('outbox').length, before, 'history metadata changes must not claim a newly verified goal');
  enqueueExecution(primarySession.id, { prompt: 'Explicitly recheck this goal', goal: true, options: {} }, randomUUID(), { authorize() {} });
  assert.equal(getRecord('session', primarySession.id).goal.importedHistorical, undefined);
  assert.equal(getRecord('session', primarySession.id).goal.status, 'active');
});

test('portable projects omit sender native context and runtime receipts while retaining ordinary historical diagnostics', async () => {
  const session = original(), runtimeFields = ['nativeContext', 'nativeContextBudget', 'nativeBackendReadiness', 'contextEfficiency',
    'coreSkillsProtocol', 'sessionMemoryRefresh', 'sessionMemorySeen'];
  for (const field of runtimeFields) session[field] = { marker: `sender-${field}` };
  saveSession(session);
  const runtimeKinds = ['native-compaction', 'core.conversation.source', 'core.conversation.pending', 'core.history.maintenance',
    'core.task-state.read', 'core.checkpoint.scope', 'core.checkpoint.request', 'core.workflow.work-unit', 'core.workflow.consultation'];
  for (const kind of runtimeKinds) putRecord(kind, randomUUID(), { sessionId: session.id, state: 'open', marker: 'sender-runtime-only' });
  appendEvent(session.id, 'diagnostic.context', { outcome: 'pending', reason: 'Historical diagnostic, never recipient authority.' });
  const zip = await exportSharedProject(session, path.join(directory, 'native-state-share.zip'));
  const manifest = spawnSync('python3', ['-c', 'import json,sys,zipfile\nwith zipfile.ZipFile(sys.argv[1]) as z: print(z.read("bundle.json").decode())', zip.path], { encoding: 'utf8' });
  assert.equal(manifest.status, 0, manifest.stderr);
  const decoded = JSON.parse(manifest.stdout), sharedSession = decoded.records.find(row => row.kind === 'session').data;
  for (const field of runtimeFields) assert.equal(sharedSession[field], undefined, field);
  assert.equal(decoded.records.some(row => runtimeKinds.includes(row.kind)), false);
  assert.ok(decoded.events.some(event => event.type === 'diagnostic.context'));
  const { primarySession } = await importSharedProject(zip.path, target);
  for (const field of runtimeFields) assert.equal(primarySession[field], undefined, field);
  for (const kind of runtimeKinds) assert.equal(listRecords(kind, { sessionId: primarySession.id }).length, 0, kind);
});

test('shared import rejects injected native runtime snapshots before creating recipient state', async () => {
  const session = original(), zip = await exportSharedProject(session, path.join(directory, 'clean-share.zip'));
  const altered = path.join(directory, 'native-injected.zip');
  const script = 'import json,zipfile,sys\nwith zipfile.ZipFile(sys.argv[1]) as z,zipfile.ZipFile(sys.argv[2],"w") as o:\n for i in z.infolist():\n  data=z.read(i)\n  if i.filename=="bundle.json":\n   m=json.loads(data)\n   next(r for r in m["records"] if r["kind"]=="session")["data"]["nativeContext"]={"epoch":99,"refresh":{"state":"dispatching"}}\n   data=json.dumps(m).encode()\n  o.writestr(i,data)\n';
  const result = spawnSync('python3', ['-c', script, zip.path, altered], { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr);
  await assert.rejects(importSharedProject(altered, target), /runtime authority/);
  assert.deepEqual(fs.readdirSync(target), []); assert.equal(listRecords('session').length, 1);
});
