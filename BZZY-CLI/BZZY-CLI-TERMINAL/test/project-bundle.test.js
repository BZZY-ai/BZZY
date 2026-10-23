import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { exportProject, importProject } from '../src/project-bundle.js';
import { createSession, saveSession, loadSession, sessions } from '../src/store.js';
import { BUILTINS, saveKey } from '../src/providers.js';
import { appendEvent, getRecord, putRecord, listRecords } from '../src/database.js';
import { captureEvidence, snapshotWorkspace, readArtifact } from '../src/evidence.js';
import { initializeProject, issue } from '../src/project.js';
import { remember, checkpoint, recall } from '../src/memory.js';
import { newGoal } from '../src/goals.js';
import { conversationMessages, conversationCursor, conversationPrompt } from '../src/conversation.js';
import { parseArgs } from '../src/cli.js';
import { root } from '../src/process.js';

let directory, work, target, previous;
test.beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-bundle-'));
  work = path.join(directory, 'original'); target = path.join(directory, 'restored'); fs.mkdirSync(work); fs.mkdirSync(target);
  previous = Object.fromEntries(['BZZY_HOME', 'BZZY_CODEX_HOME', 'BZZY_CODEX_BIN', 'BZZY_TEST_LOG'].map(key => [key, process.env[key]]));
  Object.assign(process.env, { BZZY_HOME: path.join(directory, 'private'), BZZY_CODEX_HOME: path.join(directory, 'native'), BZZY_CODEX_BIN: path.join(root, 'test/fixtures/codex.mjs'), BZZY_TEST_LOG: path.join(directory, 'backend.jsonl') });
});
test.afterEach(() => {
  for (const [key, value] of Object.entries(previous)) if (value == null) delete process.env[key]; else process.env[key] = value;
  fs.rmSync(directory, { recursive: true, force: true });
});

function original() {
  fs.writeFileSync(path.join(work, 'source.txt'), 'original evidence');
  const session = createSession(BUILTINS.codex, work, 'chosen-model', 'trabajo_01');
  session.goal = newGoal('Validate the supplied finding'); session.goal.status = 'complete';
  session.engineThreadId = randomUUID(); session.engineHome = process.env.BZZY_CODEX_HOME;
  session.backendHomes = { codex: process.env.BZZY_CODEX_HOME }; saveSession(session); initializeProject(session);
  appendEvent(session.id, 'message.user', { text: 'Remember all original controls and test boundaries.', kind: 'goal' });
  appendEvent(session.id, 'text', { text: 'The original finding was independently verified.', itemId: 'answer' });
  const evidence = captureEvidence(session, 'source.txt', 'control');
  remember(session, { kind: 'hypothesis', statement: 'A candidate control assumption', inputs: ['source.txt'] });
  issue(session, { title: 'Check negative control', status: 'disproved', evidence: [evidence.id] });
  checkpoint(session, { completedWork: ['Checked both controls'], evidence: [evidence.id] });
  snapshotWorkspace(session);
  return { session, evidence };
}

test('full project bundles round-trip hidden files, context, native transcripts and independent session IDs', async () => {
  const { session, evidence } = original();
  fs.mkdirSync(path.join(work, '.git')); fs.writeFileSync(path.join(work, '.git', 'HEAD'), 'fixture git metadata');
  fs.writeFileSync(path.join(work, '.env'), 'PROJECT_FIXTURE=preserved');
  fs.mkdirSync(path.join(work, 'node_modules', 'fixture'), { recursive: true }); fs.writeFileSync(path.join(work, 'node_modules', 'fixture', 'index.js'), 'export default 1;');
  fs.mkdirSync(path.join(work, 'empty')); fs.writeFileSync(path.join(work, 'script.sh'), '#!/bin/sh\ntrue\n', { mode: 0o755 });
  fs.symlinkSync(path.join(work, 'source.txt'), path.join(work, 'evidence-link'));
  const native = path.join(session.engineHome, 'sessions', '2026'); fs.mkdirSync(native, { recursive: true });
  fs.writeFileSync(path.join(native, `rollout-${session.engineThreadId}.jsonl`), '{"type":"fixture-native-history"}\n');
  fs.writeFileSync(path.join(session.engineHome, 'auth.json'), 'fixture-global-login-must-stay-local');
  saveKey('deepseek', 'fixture-global-key-must-stay-local');
  const unrelated = createSession(BUILTINS.codex, target, null, 'unrelated');
  appendEvent(unrelated.id, 'text', { text: 'UNRELATED_HISTORY' });
  const workerPath = path.join(process.env.BZZY_HOME, 'workers', randomUUID()); fs.mkdirSync(workerPath, { recursive: true });
  fs.writeFileSync(path.join(workerPath, 'worker.txt'), 'independent worker result');
  const worker = createSession(BUILTINS.codex, workerPath); Object.assign(worker, { parentSessionId: session.id, projectRoot: work, role: 'executor' }); saveSession(worker);
  const traffic = 'fixture-native-traffic-id'; putRecord('traffic', traffic, { id: traffic, sessionId: session.id, url: 'https://example.test/control' });
  const exported = await exportProject(session);
  assert.equal(exported.sessions, 2); assert.equal(fs.statSync(exported.path).mode & 0o777, 0o600);
  const restored = await importProject(exported.path, target);
  assert.equal(restored.sessions.length, 2); const imported = restored.primarySession;
  assert.notEqual(imported.id, session.id); assert.equal(imported.alias, 'trabajo_01-imported'); assert.equal(imported.cwd, target);
  assert.equal(loadSession(session.id).cwd, work); assert.equal(loadSession(unrelated.id).alias, 'unrelated');
  for (const relative of ['source.txt', '.env', '.git/HEAD', 'node_modules/fixture/index.js', 'script.sh']) assert.equal(fs.readFileSync(path.join(target, relative), 'utf8'), fs.readFileSync(path.join(work, relative), 'utf8'));
  assert.ok(fs.statSync(path.join(target, 'empty')).isDirectory()); assert.equal(fs.statSync(path.join(target, 'script.sh')).mode & 0o777, 0o755);
  assert.equal(fs.readlinkSync(path.join(target, 'evidence-link')), path.join(target, 'source.txt'));
  assert.equal(imported.engineThreadId, null); assert.equal(imported.conversationHandoff.pending, true);
  const history = conversationMessages(imported.id, conversationCursor(imported.id));
  assert.ok(history.some(message => message.content.includes('original finding'))); assert.ok(!history.some(message => message.content.includes('UNRELATED_HISTORY')));
  assert.match(conversationPrompt(imported, 'Continue'), /after importing the project/);
  const importedEvidence = listRecords('artifact').find(item => item.sessionId === imported.id);
  assert.notEqual(importedEvidence.id, evidence.id); assert.equal(readArtifact(importedEvidence.id).content, 'original evidence');
  assert.ok(importedEvidence.path.startsWith(target + path.sep));
  assert.equal(recall(target)[0].statement, 'A candidate control assumption');
  assert.deepEqual(getRecord('checkpoint', imported.id).completedWork, ['Checked both controls']);
  const importedWorker = restored.sessions.find(item => item.parentSessionId === imported.id);
  assert.equal(fs.readFileSync(path.join(importedWorker.cwd, 'worker.txt'), 'utf8'), 'independent worker result');
  const packed = fs.readFileSync(path.join(imported.importedContext.directory, 'bundle.json'), 'utf8');
  assert.ok(!packed.includes('fixture-global-key-must-stay-local')); assert.ok(!packed.includes('fixture-global-login-must-stay-local'));
  assert.equal(fs.readFileSync(path.join(imported.importedContext.nativeDirectory, session.id, 'sessions', '2026', `rollout-${session.engineThreadId}.jsonl`), 'utf8'), '{"type":"fixture-native-history"}\n');
  assert.ok(!fs.existsSync(path.join(target, path.basename(exported.path))), 'the archive excludes itself');
  assert.equal(listRecords('traffic').filter(item => item.url === 'https://example.test/control').length, 2);
});

test('import conflicts leave existing files and session records unchanged', async () => {
  const { session } = original(), exported = await exportProject(session, path.join(directory, 'bundle.zip'));
  fs.writeFileSync(path.join(target, 'source.txt'), 'colleague work'); const before = sessions().map(item => item.id);
  await assert.rejects(importProject(exported.path, target), /overwrite/);
  assert.equal(fs.readFileSync(path.join(target, 'source.txt'), 'utf8'), 'colleague work');
  assert.deepEqual(sessions().map(item => item.id), before); assert.deepEqual(fs.readdirSync(target), ['source.txt']);
});

test('an imported project can be exported again with its evidence and generated files intact', async () => {
  const { session } = original();
  const exported = await exportProject(session, path.join(directory, 'first.zip'));
  const first = await importProject(exported.path, target);
  const repacked = await exportProject(first.primarySession, path.join(directory, 'second.zip'));
  const secondTarget = path.join(directory, 'second-import'); fs.mkdirSync(secondTarget);
  const second = await importProject(repacked.path, secondTarget);
  const evidence = listRecords('artifact').find(item => item.sessionId === second.primarySession.id);
  assert.equal(readArtifact(evidence.id).content, 'original evidence');
  assert.equal(second.primarySession.cwd, secondTarget);
  assert.equal(recall(secondTarget)[0].statement, 'A candidate control assumption');
});

test('export refuses active project runs and never replaces an existing archive', async () => {
  const { session } = original();
  const file = path.join(directory, 'existing.zip'); fs.writeFileSync(file, 'existing file');
  await assert.rejects(exportProject(session, file), /already exists/); assert.equal(fs.readFileSync(file, 'utf8'), 'existing file');
  putRecord('execution', randomUUID(), { sessionId: session.id, state: 'queued' });
  await assert.rejects(exportProject(session, path.join(directory, 'active.zip')), /Pause/);
  assert.ok(!fs.existsSync(path.join(directory, 'active.zip')));
});

for (const malicious of ['traversal', 'symlink']) {
  test(`import rejects ZIP ${malicious} before writing into the project`, async () => {
    const zip = path.join(directory, 'malicious.zip');
    const script = `import zipfile,sys,stat\nz=zipfile.ZipFile(sys.argv[1],'w')\nz.writestr('bundle.json','{}')\n${malicious === 'traversal' ? "z.writestr('workspace/../../escaped','bad')" : "i=zipfile.ZipInfo('workspace/link'); i.create_system=3; i.external_attr=(stat.S_IFLNK|0o777)<<16; z.writestr(i,'../../'); z.writestr('workspace/link/escaped','bad')"}\nz.close()`;
    const result = spawnSync('python3', ['-c', script, zip], { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr);
    await assert.rejects(importProject(zip, target), /entry|symbolic link/);
    assert.deepEqual(fs.readdirSync(target), []); assert.ok(!fs.existsSync(path.join(directory, 'escaped')));
  });
}

test('CLI import restores into its current directory without executing agents', async () => {
  const { session } = original(), exported = await exportProject(session, path.join(directory, 'project.zip'));
  assert.equal(parseArgs(['--import', exported.path]).options.importFile, exported.path);
  const result = spawnSync(process.execPath, [path.join(root, 'bin/bzzy.js'), '--import', exported.path, '--json'], { cwd: target, env: process.env, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stdout + result.stderr); assert.match(result.stdout, /Imported into/);
  const imported = sessions().find(item => item.cwd === target); assert.ok(imported); assert.notEqual(imported.id, session.id);
  assert.equal(listRecords('execution').length, 0); assert.equal(fs.readFileSync(path.join(target, 'source.txt'), 'utf8'), 'original evidence');
});
