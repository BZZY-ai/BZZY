import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createSession, saveSession } from '../src/engine/store.js';
import { getProvider } from '../src/engine/providers.js';
import { initializeProject } from '../src/engine/project.js';
import { database, putRecord, appendEvent, digest } from '../src/engine/database.js';
import { knowledgeDatabase } from '../src/engine/knowledge-index.js';
import { createSkill, setSkillEnabled, importSkill } from '../src/engine/skills.js';
import { exportFullSessionDebug, exportFullSessionDebugInWorker } from '../src/engine/session-full-debug.js';
import { exportSessionDebug } from '../src/engine/session-debug.js';

let directory, previous, parent;
test.beforeEach(() => {
  previous = { BZZY_HOME: process.env.BZZY_HOME, FULL_DEBUG_TOKEN: process.env.FULL_DEBUG_TOKEN };
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-full-debug-')));
  process.env.BZZY_HOME = path.join(directory, 'private'); delete process.env.FULL_DEBUG_TOKEN;
  const project = path.join(directory, 'project'); fs.mkdirSync(project);
  parent = createSession(getProvider('deepseek'), project, 'offline-deepseek', 'complete-session');
  initializeProject(parent); parent.executionState = 'running'; saveSession(parent);
});
test.afterEach(() => {
  for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  fs.rmSync(directory, { recursive: true, force: true });
});
function contents(file) {
  const result = spawnSync('python3', ['-c', 'import sys,json,zipfile,base64\nwith zipfile.ZipFile(sys.argv[1]) as z: print(json.dumps({n:base64.b64encode(z.read(n)).decode() for n in z.namelist()}))', file], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  return Object.fromEntries(Object.entries(JSON.parse(result.stdout)).map(([name, data]) => [name, Buffer.from(data, 'base64')]));
}
const rows = buffer => buffer.toString().trim().split('\n').filter(Boolean).map(JSON.parse);
const state = () => ({ records: database().prepare('SELECT * FROM records ORDER BY kind,id').all(), events: database().prepare('SELECT * FROM events ORDER BY seq').all() });

test('worker export reports safe real progress while the caller remains responsive during capture', async () => {
  for (let index = 0; index < 500; index++) appendEvent(parent.id, 'diagnostic.fixture', { index, text: 'Offline capture fixture. '.repeat(600) });
  fs.writeFileSync(path.join(parent.cwd, 'private-looking-file-name.txt'), 'Retained fixture file.');
  const before = state(), updates = [], timerPhases = []; let phase, callbackThrew = false;
  const timer = setInterval(() => { if (phase) timerPhases.push(phase); }, 1);
  let result;
  try {
    result = await exportFullSessionDebugInWorker(parent.id, { at: new Date(2026, 9, 26), onProgress: value => {
      updates.push(value); phase = value.phase;
      if (phase === 'workspace' && !callbackThrew) { callbackThrew = true; throw new Error('UI display failed; capture must continue.'); }
    } });
  } finally { clearInterval(timer); }
  assert.ok(timerPhases.some(value => ['overview', 'history', 'workspace', 'resources'].includes(value)), 'Caller timers must run during synchronous source capture, not just ZIP packaging.');
  assert.equal(callbackThrew, true);
  assert.equal(updates.at(-1).phase, 'complete');
  assert.equal(updates.at(-1).records, result.records); assert.equal(updates.at(-1).events, result.savedEvents);
  assert.equal(updates.at(-1).files, result.files); assert.equal(updates.at(-1).exclusions, result.exclusions);
  assert.ok(updates.at(-1).packagedFiles > 0); assert.ok(updates.at(-1).packagedBytes > 0);
  assert.ok(updates.some(value => value.phase === 'history' && value.records > 0));
  assert.ok(updates.some(value => value.phase === 'packaging' && value.packagedBytes > 0));
  const fields = new Set(['phase', 'elapsedMs', 'records', 'events', 'files', 'bytes', 'exclusions', 'packagedFiles', 'packagedBytes']);
  for (const update of updates) {
    assert.ok(Object.keys(update).every(key => fields.has(key)));
    for (const [key, value] of Object.entries(update)) if (key !== 'phase') assert.ok(Number.isSafeInteger(value) && value >= 0);
  }
  assert.doesNotMatch(JSON.stringify(updates), /private-looking-file-name|Offline capture fixture|project|sessionId/);
  assert.deepEqual(state(), before);
  const files = contents(result.outputPath); assert.equal(rows(files['session/events.jsonl']).filter(row => row.type === 'diagnostic.fixture').length, 500);
  assert.deepEqual(fs.readdirSync(path.join(process.env.BZZY_HOME, 'debug-exports')), []);
});

test('worker export failures keep safe phase diagnostics and never publish a completed result', async () => {
  const updates = [];
  await assert.rejects(exportFullSessionDebugInWorker(parent.id, { output: 'private-token=DO_NOT_SHOW/debug.zip', onProgress: value => updates.push(value) }),
    error => error.code === 'SESSION_DEBUG_MISSING' && error.exportPhase === 'packaging' && !error.message.includes('DO_NOT_SHOW'));
  assert.ok(updates.some(value => value.phase === 'packaging'));
  assert.ok(!updates.some(value => value.phase === 'complete'));
  assert.deepEqual(fs.readdirSync(path.join(process.env.BZZY_HOME, 'debug-exports')), []);
  await assert.rejects(exportFullSessionDebugInWorker(randomUUID()), error => error.code === 'SESSION_DEBUG_SESSION' && error.exportPhase === 'session');
});

test('full ZIP preserves long chat, memory, learning, notes, ledgers, evidence and derived sessions without changing the running session', async () => {
  const long = 'x'.repeat(90000) + 'END_OF_COMPLETE_DATA';
  fs.writeFileSync(path.join(parent.cwd, '.bzzy', 'NOTES.md'), long);
  fs.mkdirSync(path.join(parent.cwd, '.bzzy', 'ledger')); fs.writeFileSync(path.join(parent.cwd, '.bzzy', 'ledger', 'day.jsonl'), JSON.stringify({ sessionId: parent.id, record: { details: long } }) + '\n');
  fs.writeFileSync(path.join(parent.cwd, 'script.sh'), '#!/bin/sh\ntouch SHOULD_NEVER_EXECUTE\n');
  putRecord('core.session.memory.node', 'node-full', { id: 'node-full', sessionId: parent.id, summary: long, fields: Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`field${i}`, i])) });
  putRecord('core.session.compactor.job', 'node-full', { id: 'node-full', sessionId: parent.id, state: 'paused', reason: 'foreground_work' });
  const jobId = randomUUID();
  putRecord('core.learning.job', jobId, { id: jobId, sessionId: parent.id, projectId: parent.projectId, state: 'complete', sourceId: `${parent.id}:1` });
  for (const kind of ['core.learning.packet', 'core.episode', 'core.episode.progress', 'core.skill.feedback', 'core.skill.outcome', 'core.skill.update', 'core.resolution', 'core.retrieval.metric']) {
    putRecord(kind, 'capture-' + kind, { id: 'capture-' + kind, sessionId: parent.id, projectId: parent.projectId,
      jobId, details: 'NEW_MEMORY_LOOP_DIAGNOSTIC', coverage: { sourceCutoff: 123, omittedItems: 2 } });
  }
  for (const kind of ['core.project.facts', 'core.retrieval.settings']) {
    putRecord(kind, parent.projectId, { projectId: parent.projectId, revision: 1, details: 'CURRENT_PROJECT_PROJECTION' });
    putRecord(kind, 'unrelated-project', { projectId: 'unrelated-project', details: 'FOREIGN_PROJECT_PROJECTION' });
  }
  putRecord('core.learning.output', jobId, { jobId, material: long, proposals: Array.from({ length: 300 }, (_, i) => `proposal${i}`) });
  putRecord('core.learning.reservation', 'reservation', { jobId, day: '2026-10-26', tokensUsed: 12 });
  putRecord('core.learning.usage', '2026-10-26', { day: '2026-10-26', tokensUsed: 900 });
  const review = createSession(getProvider('codex'), parent.cwd, 'offline-compactor');
  review.documentSourceSessionId = parent.id; review.role = 'learning-review'; review.purpose = 'document'; saveSession(review);
  appendEvent(review.id, 'text', { text: 'COMPACTOR_REVIEW_OUTPUT' });
  const other = createSession(getProvider('deepseek'), parent.cwd, 'other'); appendEvent(other.id, 'text', { text: 'UNRELATED_RAW_CHAT' });
  appendEvent(parent.id, 'message.user', { text: 'ORIGINAL_USER_INSTRUCTIONS' });
  appendEvent(parent.id, 'text', { text: long.slice(0, 45000) }); appendEvent(parent.id, 'text', { text: long.slice(45000) });
  appendEvent(parent.id, 'custom.future.event', { customDiagnostic: long });
  const evidence = path.join(process.env.BZZY_HOME, 'artifacts', 'evidence.bin'); fs.mkdirSync(path.dirname(evidence), { recursive: true }); fs.writeFileSync(evidence, Buffer.from([137, 80, 78, 71, 0, 255, 100]));
  putRecord('artifact', 'evidence', { id: 'evidence', sessionId: parent.id, path: evidence, sha256: digest(fs.readFileSync(evidence)) });
  let method = createSkill({ name: 'full-method', description: 'Inspect the local supplied fixture.', instructions: 'FULL_METHOD_INSTRUCTIONS' }, { scope: 'global' });
  method = setSkillEnabled(method.name, true, method.revision, { scope: 'global' });
  const skillSource = path.join(directory, 'binary-skill'); fs.mkdirSync(skillSource); fs.mkdirSync(path.join(skillSource, 'assets'));
  fs.writeFileSync(path.join(skillSource, 'SKILL.md'), '---\nname: image-method\ndescription: Inspect the supplied diagram.\n---\nUse assets/diagram.png as reference.');
  fs.writeFileSync(path.join(skillSource, 'assets', 'diagram.png'), Buffer.from([137, 80, 78, 71, 0, 255, 200]));
  importSkill(skillSource, { scope: 'global' });
  const index = knowledgeDatabase(); index.prepare('INSERT INTO knowledge_documents VALUES (?,?,?,?,?,?,?,?)').run('key', parent.projectId, parent.id, 'memory', 'source', long, JSON.stringify({ statement: long }), new Date().toISOString());
  const before = state(), result = await exportFullSessionDebug(parent.id, { at: new Date(2026, 9, 26) });
  assert.equal(path.basename(result.outputPath), 'complete-session_full_debug_26102026.zip'); assert.equal(result.full, true); assert.deepEqual(state(), before);
  const files = contents(result.outputPath), manifest = JSON.parse(files['manifest.json']);
  assert.equal(manifest.complete, true); assert.ok(manifest.sessionIds.includes(review.id)); assert.ok(!manifest.sessionIds.includes(other.id));
  assert.equal(files['workspace/.bzzy/NOTES.md'].toString(), long);
  assert.equal(JSON.parse(files['workspace/.bzzy/ledger/day.jsonl']).record.details, long);
  const records = rows(files['session/records.jsonl']);
  assert.equal(records.find(row => row.kind === 'core.session.memory.node').data.summary, long);
  assert.equal(Object.keys(records.find(row => row.kind === 'core.session.memory.node').data.fields).length, 300);
  assert.equal(records.find(row => row.kind === 'core.learning.output').data.proposals.length, 300);
  assert.equal(records.find(row => row.kind === 'core.learning.output').data.material, long);
  assert.ok(records.some(row => row.kind === 'core.learning.usage' && row.data.tokensUsed === 900));
  for (const kind of ['core.learning.packet', 'core.episode', 'core.episode.progress', 'core.skill.feedback', 'core.skill.outcome', 'core.skill.update', 'core.resolution', 'core.retrieval.metric']) {
    assert.ok(records.some(row => row.kind === kind && row.data.details === 'NEW_MEMORY_LOOP_DIAGNOSTIC'), kind);
  }
  assert.ok(records.some(row => row.kind === 'core.project.facts' && row.data.projectId === parent.projectId));
  assert.ok(records.some(row => row.kind === 'core.retrieval.settings' && row.data.projectId === parent.projectId));
  assert.doesNotMatch(JSON.stringify(records), /FOREIGN_PROJECT_PROJECTION/);
  assert.ok(rows(files['session/messages.jsonl']).some(row => row.text === long));
  assert.ok(rows(files['session/messages.jsonl']).some(row => row.text === 'COMPACTOR_REVIEW_OUTPUT'));
  assert.ok(rows(files['session/events.jsonl']).some(row => row.type === 'custom.future.event' && row.data.customDiagnostic === long));
  assert.ok(rows(files['memory/knowledge-index.jsonl']).some(row => row.body === long));
  assert.ok(Object.keys(files).some(name => name.includes('execution-files/artifacts/evidence.bin')));
  assert.ok(Object.entries(files).some(([name, bytes]) => name.startsWith('library/skills/') && name.endsWith('/SKILL.md') && bytes.toString().includes('FULL_METHOD_INSTRUCTIONS')));
  assert.ok(Object.entries(files).some(([name, bytes]) => name.startsWith('library/skills/') && name.endsWith('/assets/diagram.png') && bytes.equals(Buffer.from([137, 80, 78, 71, 0, 255, 200]))));
  assert.ok(files['GUIDE_TO_BZZY_DEBUGGER.txt'].toString().includes('DEBUG LEARNING AND SKILL PUBLICATION'));
  assert.ok(!Buffer.concat(Object.values(files)).toString().includes('UNRELATED_RAW_CHAT'));
  assert.equal(fs.existsSync(path.join(parent.cwd, 'SHOULD_NEVER_EXECUTE')), false);
  assert.deepEqual(fs.readdirSync(path.join(process.env.BZZY_HOME, 'debug-exports')), []);
});

test('full streams scrub split credentials, private envelopes, HAR headers, auth files and escaping links', async () => {
  const synthetic = 'synthetic_full_debug_binding_1234567890'; process.env.FULL_DEBUG_TOKEN = synthetic;
  appendEvent(parent.id, 'text', { text: 'SAFE_PREFIX ' + synthetic.slice(0, 15) }); appendEvent(parent.id, 'text', { text: synthetic.slice(15) + ' SAFE_SUFFIX' });
  appendEvent(parent.id, 'backend', { method: 'turn/completed', params: { turn: { id: 't', status: 'completed', items: [{ type: 'reasoning', text: 'PRIVATE_REASONING_VALUE' }] } } });
  appendEvent(parent.id, 'backend', { method: 'item/completed', params: { item: { type: 'commandExecution', command: 'cat ~/.aws/credentials', aggregatedOutput: 'BARE_AUTH_FILE_OUTPUT' } } });
  putRecord('core.binding', 'owner', { sessionId: parent.id, token: 'OWNER_BINDING_PRIVATE' });
  fs.writeFileSync(path.join(parent.cwd, '.env'), 'PRIVATE_ENV_VALUE');
  fs.writeFileSync(path.join(parent.cwd, '.bzzy', 'credentials.json'), '{"secret":"PRIVATE_AUTH_STORE"}');
  fs.writeFileSync(path.join(parent.cwd, 'capture.har'), JSON.stringify({ headers: [{ name: 'Cookie', value: 'PRIVATE_HAR_COOKIE' }] }));
  fs.writeFileSync(path.join(parent.cwd, 'packet.bin'), Buffer.concat([Buffer.from([255, 0]), Buffer.from('Cookie: sid=PRIVATE_BINARY_COOKIE')]));
  const external = path.join(directory, 'outside.txt'); fs.writeFileSync(external, 'ESCAPING_LINK_VALUE'); fs.symlinkSync(external, path.join(parent.cwd, 'escape'));
  const files = contents((await exportFullSessionDebug(parent.id)).outputPath), text = Buffer.concat(Object.values(files)).toString();
  for (const value of [synthetic, synthetic.slice(0, 15), synthetic.slice(15), 'PRIVATE_REASONING_VALUE', 'BARE_AUTH_FILE_OUTPUT', 'OWNER_BINDING_PRIVATE', 'PRIVATE_ENV_VALUE', 'PRIVATE_AUTH_STORE', 'PRIVATE_HAR_COOKIE', 'PRIVATE_BINARY_COOKIE', 'ESCAPING_LINK_VALUE']) assert.ok(!text.includes(value), value);
  const messages = rows(files['session/messages.jsonl']); assert.ok(messages.some(row => row.text.includes('SAFE_PREFIX') && row.text.includes('SAFE_SUFFIX') && row.text.includes('[redacted]')));
  const manifest = JSON.parse(files['manifest.json']); assert.ok(manifest.exclusions.some(row => row.path.endsWith('/.env'))); assert.ok(manifest.exclusions.some(row => row.path.endsWith('/escape')));
});

test('full ZIP default collisions are numbered and explicit destinations/symlinks are never overwritten', async () => {
  const current = path.join(directory, 'current'); fs.mkdirSync(current); const at = new Date(2026, 9, 26);
  const first = await exportFullSessionDebug(parent.id, { cwd: current, at }), original = fs.readFileSync(first.outputPath);
  const second = await exportFullSessionDebug(parent.id, { cwd: current, at }); assert.match(second.outputPath, /_26102026_2\.zip$/);
  await assert.rejects(exportFullSessionDebug(parent.id, { cwd: current, output: path.basename(first.outputPath) }), /already exists/);
  fs.symlinkSync(first.outputPath, path.join(current, 'link.zip')); await assert.rejects(exportFullSessionDebug(parent.id, { cwd: current, output: 'link.zip' }), /already exists/);
  assert.deepEqual(fs.readFileSync(first.outputPath), original);
  await assert.rejects(exportFullSessionDebug(parent.id, { cwd: current, output: 'bad.md' }), /\.zip/);
});

test('valid multibyte aliases keep export filenames within filesystem byte limits', async () => {
  parent.alias = '名'.repeat(80); saveSession(parent);
  const before = state(), regular = exportSessionDebug(parent.id), full = await exportFullSessionDebug(parent.id);
  for (const result of [regular, full]) {
    assert.ok(Buffer.byteLength(path.basename(result.outputPath)) <= 255);
    assert.ok(fs.statSync(result.outputPath).isFile());
  }
  assert.deepEqual(state(), before);
});

test('large optional project files are listed as omissions while complete history and smaller files remain exportable', async () => {
  const large = path.join(parent.cwd, 'large.bin'); fs.closeSync(fs.openSync(large, 'wx')); fs.truncateSync(large, 65 * 1024 * 1024);
  fs.writeFileSync(path.join(parent.cwd, 'small.txt'), 'SMALL_INPUT_RETAINED');
  appendEvent(parent.id, 'text', { text: 'COMPLETE_SAVED_HISTORY' }); const before = state();
  const result = await exportFullSessionDebug(parent.id), files = contents(result.outputPath), manifest = JSON.parse(files['manifest.json']);
  assert.equal(manifest.complete, true);
  assert.equal(files['workspace/large.bin'], undefined);
  assert.equal(files['workspace/small.txt'].toString(), 'SMALL_INPUT_RETAINED');
  assert.ok(rows(files['session/messages.jsonl']).some(row => row.text === 'COMPLETE_SAVED_HISTORY'));
  assert.deepEqual(manifest.exclusions.find(row => row.path === 'workspace/large.bin'),
    { path: 'workspace/large.bin', reason: 'source_file_size_limit', sourceBytes: 65 * 1024 * 1024, limitBytes: 64 * 1024 * 1024 });
  assert.equal(fs.statSync(large).size, 65 * 1024 * 1024); assert.deepEqual(state(), before);
  assert.deepEqual(fs.readdirSync(path.join(process.env.BZZY_HOME, 'debug-exports')), []);
  assert.deepEqual(fs.readFileSync(fileURLToPath(new URL('../../GUIDE_TO_BZZY_DEBUGGER.txt', import.meta.url))), fs.readFileSync(fileURLToPath(new URL('../docs/GUIDE_TO_BZZY_DEBUGGER.txt', import.meta.url))));
});

test('optional context exhaustion keeps memory history and prioritizes notes, artifacts and skills over bulk files', async t => {
  const note = 'PRIORITY_NOTE', evidence = 'PRIORITY_EVIDENCE';
  fs.writeFileSync(path.join(parent.cwd, '.bzzy', 'NOTES.md'), note);
  const artifact = path.join(process.env.BZZY_HOME, 'artifacts', 'selected.txt'); fs.mkdirSync(path.dirname(artifact), { recursive: true }); fs.writeFileSync(artifact, evidence);
  putRecord('artifact', 'priority', { id: 'priority', sessionId: parent.id, path: artifact, sha256: digest(evidence) });
  let skill = createSkill({ name: 'priority-method', description: 'Inspect supplied data.', instructions: 'PRIORITY_SKILL' }, { scope: 'global' });
  skill = setSkillEnabled(skill.name, true, skill.revision, { scope: 'global' });
  const bulk = path.join(parent.cwd, 'aaa-bulk.txt'); fs.writeFileSync(bulk, 'x'.repeat(16384));
  appendEvent(parent.id, 'text', { text: 'COMPLETE_HISTORY_BEFORE_CONTEXT_LIMIT' });
  putRecord('core.session.memory.node', 'preserved-node', { sessionId: parent.id, summary: 'COMPLETE_MEMORY_BEFORE_CONTEXT_LIMIT' });
  const opened = [], open = fs.openSync;
  t.mock.method(fs, 'openSync', (file, ...args) => { opened.push(String(file)); return open(file, ...args); });
  const before = state(), result = await exportFullSessionDebug(parent.id, { maxContextBytes: 4096 });
  const files = contents(result.outputPath), manifest = JSON.parse(files['manifest.json']);
  assert.equal(result.contextLimited, true); assert.equal(manifest.contextLimited, true); assert.equal(manifest.complete, true);
  assert.equal(result.contextCapture.limitBytes, 4096); assert.ok(result.contextCapture.capturedBytes <= 4096);
  assert.equal(files['workspace/.bzzy/NOTES.md'].toString(), note);
  assert.equal(files['execution-files/artifacts/selected.txt'].toString(), evidence);
  assert.ok(Object.entries(files).some(([name, data]) => name.startsWith('library/skills/') && name.endsWith('/SKILL.md') && data.toString().includes('PRIORITY_SKILL')));
  assert.ok(rows(files['session/messages.jsonl']).some(row => row.text === 'COMPLETE_HISTORY_BEFORE_CONTEXT_LIMIT'));
  assert.ok(rows(files['session/records.jsonl']).some(row => row.kind === 'core.session.memory.node' && row.data.summary === 'COMPLETE_MEMORY_BEFORE_CONTEXT_LIMIT'));
  assert.equal(files['workspace/aaa-bulk.txt'], undefined); assert.ok(!opened.includes(bulk), 'Over-budget source is skipped before opening its payload.');
  assert.ok(manifest.exclusions.some(row => row.path === 'workspace/aaa-bulk.txt' && row.reason === 'context_byte_budget' && row.sourceBytes === 16384));
  assert.deepEqual(state(), before); assert.equal(fs.readFileSync(bulk).length, 16384);
});

test('redaction/formatting expansion is checked after transformation without failing the archive', async t => {
  const source = JSON.stringify(Array(1000).fill(0)), filename = path.join(parent.cwd, 'expands.json'); fs.writeFileSync(filename, source);
  let opened = false; const open = fs.openSync;
  t.mock.method(fs, 'openSync', (file, ...args) => { if (file === filename) opened = true; return open(file, ...args); });
  const result = await exportFullSessionDebug(parent.id, { maxContextBytes: 4096 }), files = contents(result.outputPath), manifest = JSON.parse(files['manifest.json']);
  assert.equal(opened, true); assert.equal(result.contextLimited, true); assert.equal(files['workspace/expands.json'], undefined);
  const omitted = manifest.exclusions.find(row => row.path === 'workspace/expands.json');
  assert.equal(omitted.reason, 'context_byte_budget'); assert.equal(omitted.sourceBytes, Buffer.byteLength(source));
  assert.ok(omitted.exportedBytes > 4096); assert.ok(files['session/records.jsonl']);
});

test('worker forwards an empty optional budget while retaining complete scoped diagnostics and subtree omissions', async () => {
  fs.writeFileSync(path.join(parent.cwd, 'unvisited.txt'), 'OPTIONAL_SOURCE');
  appendEvent(parent.id, 'text', { text: 'MANDATORY_HISTORY' });
  const result = await exportFullSessionDebugInWorker(parent.id, { maxContextBytes: 0 }), files = contents(result.outputPath), manifest = JSON.parse(files['manifest.json']);
  assert.equal(result.contextLimited, true); assert.equal(result.contextCapture.capturedBytes, 0);
  assert.equal(result.contextCapture.omittedPathsComplete, false); assert.ok(result.contextCapture.omittedSubtrees > 0);
  assert.ok(manifest.exclusions.some(row => row.path === 'workspace' && row.subtree && row.remainingDescendantsOnly));
  assert.ok(rows(files['session/messages.jsonl']).some(row => row.text === 'MANDATORY_HISTORY'));
  assert.equal(files['workspace/unvisited.txt'], undefined); assert.ok(files['GUIDE_TO_BZZY_DEBUGGER.txt']);
});

test('many empty optional files cannot exhaust reserved manifest space or silently drop omission coverage', async () => {
  const bulk = path.join(parent.cwd, 'bulk'); fs.mkdirSync(bulk);
  for (let index = 0; index < 5000; index++) fs.writeFileSync(path.join(bulk, `${String(index).padStart(5, '0')}-${'a'.repeat(200)}.txt`), '');
  appendEvent(parent.id, 'text', { text: 'HISTORY_WITH_MANY_EMPTY_CONTEXT_FILES' });
  const result = await exportFullSessionDebug(parent.id), files = contents(result.outputPath), manifest = JSON.parse(files['manifest.json']);
  assert.equal(result.contextLimited, true); assert.equal(result.contextCapture.metadataBytes, result.contextCapture.metadataLimitBytes);
  assert.equal(result.contextCapture.omittedPathsComplete, false);
  assert.ok(manifest.exclusions.some(row => row.path === 'optional-context' && row.reason === 'context_manifest_budget' && row.subtree));
  assert.ok(Object.keys(files).filter(name => name.startsWith('workspace/bulk/')).length < 5000);
  assert.ok(rows(files['session/messages.jsonl']).some(row => row.text === 'HISTORY_WITH_MANY_EMPTY_CONTEXT_FILES'));
  assert.ok(Buffer.byteLength(files['manifest.json']) < result.contextCapture.manifestReserveBytes);
});

test('future events and incomplete records retain their valid JSON payloads without crashing or mutating history', async () => {
  for (const data of [null, false, 17, 'visible diagnostic', ['first', 'second']]) appendEvent(parent.id, 'custom.future.event', data);
  appendEvent(parent.id, 'backend', null); appendEvent(parent.id, 'text', null);
  putRecord('checkpoint', parent.id, null); putRecord('future.private.kind', 'irrelevant', null);
  const before = state(), files = contents((await exportFullSessionDebug(parent.id)).outputPath);
  assert.deepEqual(rows(files['session/events.jsonl']).filter(row => row.type === 'custom.future.event').map(row => row.data),
    [null, false, 17, 'visible diagnostic', ['first', 'second']]);
  assert.ok(rows(files['session/events.jsonl']).some(row => row.type === 'backend' && row.data === null));
  assert.ok(rows(files['session/records.jsonl']).some(row => row.kind === 'checkpoint' && row.id === parent.id && row.data === null));
  assert.deepEqual(state(), before);
});

test('unreadable and disappearing optional directories are omitted without inventing their contents', async t => {
  const blocked = path.join(parent.cwd, 'unreadable'), vanished = path.join(parent.cwd, 'vanished');
  fs.mkdirSync(blocked); fs.mkdirSync(vanished); fs.writeFileSync(path.join(blocked, 'hidden.txt'), 'UNREAD_CAPTURE');
  const readdir = fs.readdirSync, realpath = fs.realpathSync;
  t.mock.method(fs, 'readdirSync', (file, ...args) => {
    if (file === blocked) throw Object.assign(new Error('private source detail'), { code: 'EACCES' });
    return readdir(file, ...args);
  });
  t.mock.method(fs, 'realpathSync', (file, ...args) => {
    if (file === vanished) throw Object.assign(new Error('private vanished detail'), { code: 'ENOENT' });
    return realpath(file, ...args);
  });
  const files = contents((await exportFullSessionDebug(parent.id)).outputPath), manifest = JSON.parse(files['manifest.json']);
  assert.ok(manifest.exclusions.some(row => row.path === 'workspace/unreadable' && row.reason === 'unreadable_source'));
  assert.ok(manifest.exclusions.some(row => row.path === 'workspace/vanished' && row.reason === 'missing_source'));
  assert.doesNotMatch(Buffer.concat(Object.values(files)).toString(), /UNREAD_CAPTURE|private source detail|private vanished detail/);
});

test('mandatory history size limits publish no clipped ZIP and retain the saved original message', async () => {
  appendEvent(parent.id, 'text', { text: 'x'.repeat(64 * 1024 * 1024 + 1) });
  await assert.rejects(exportFullSessionDebug(parent.id), error => error.code === 'SESSION_DEBUG_SIZE' && error.exportPhase === 'history');
  assert.ok(!fs.readdirSync(parent.cwd).some(name => name.endsWith('.zip')));
  assert.deepEqual(fs.readdirSync(path.join(process.env.BZZY_HOME, 'debug-exports')), []);
  assert.ok(database().prepare("SELECT length(data) AS bytes FROM events WHERE session_id=? AND type='text'").get(parent.id).bytes > 64 * 1024 * 1024);
});

test('staging disk failures remain fatal during optional capture and manifest writing without exposing private details', async t => {
  fs.writeFileSync(path.join(parent.cwd, 'small.txt'), 'saved source'); const before = state();
  for (const [suffix, phase] of [[path.join('workspace', 'small.txt'), 'workspace'], ['manifest.json', 'manifest']]) {
    const write = fs.writeFileSync;
    t.mock.method(fs, 'writeFileSync', (file, ...args) => {
      if (String(file).endsWith(path.sep + suffix)) throw Object.assign(new Error('private-token=DO_NOT_DISPLAY'), { code: 'ENOSPC' });
      return write(file, ...args);
    });
    await assert.rejects(exportFullSessionDebug(parent.id), error => error.code === 'SESSION_DEBUG_SPACE' && error.exportPhase === phase && !error.message.includes('DO_NOT_DISPLAY'));
    t.mock.restoreAll();
    assert.ok(!fs.readdirSync(parent.cwd).some(name => name.endsWith('.zip')));
    assert.deepEqual(fs.readdirSync(path.join(process.env.BZZY_HOME, 'debug-exports')), []);
    assert.deepEqual(state(), before);
  }
});

test('missing Python is distinguished from output permissions without exposing subprocess details', async () => {
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = path.join(directory, 'missing-tools');
    await assert.rejects(exportFullSessionDebug(parent.id), error => error.code === 'SESSION_DEBUG_PYTHON' && error.exportPhase === 'packaging');
  } finally { process.env.PATH = previousPath; }
  assert.ok(!fs.readdirSync(parent.cwd).some(name => name.endsWith('.zip')));
  assert.deepEqual(fs.readdirSync(path.join(process.env.BZZY_HOME, 'debug-exports')), []);
});

test('ZIP destination failures retain a safe phase and cause without publishing subprocess stderr', async () => {
  await assert.rejects(exportFullSessionDebug(parent.id, { output: 'private-token=DO_NOT_SHOW/debug.zip' }),
    error => error.code === 'SESSION_DEBUG_MISSING' && error.exportPhase === 'packaging' && !error.message.includes('DO_NOT_SHOW'));
  assert.deepEqual(fs.readdirSync(path.join(process.env.BZZY_HOME, 'debug-exports')), []);
});

test('a stream flush failure closes its descriptor and removes private incomplete staging', async t => {
  const open = fs.openSync, flush = fs.fsyncSync, close = fs.closeSync; let target, closed = false;
  t.mock.method(fs, 'openSync', (file, ...args) => {
    const descriptor = open(file, ...args);
    if (String(file).endsWith(path.join('session', 'records.jsonl'))) target = descriptor;
    return descriptor;
  });
  t.mock.method(fs, 'fsyncSync', descriptor => {
    if (descriptor === target) throw Object.assign(new Error('private flush detail'), { code: 'ENOSPC' });
    return flush(descriptor);
  });
  t.mock.method(fs, 'closeSync', descriptor => { if (descriptor === target) closed = true; return close(descriptor); });
  await assert.rejects(exportFullSessionDebug(parent.id), error => error.code === 'SESSION_DEBUG_SPACE' && error.exportPhase === 'history');
  assert.equal(closed, true);
  assert.deepEqual(fs.readdirSync(path.join(process.env.BZZY_HOME, 'debug-exports')), []);
});

test('a later stream-open failure closes the stream already opened for the history capture', async t => {
  const open = fs.openSync, close = fs.closeSync; let target, closed = false;
  t.mock.method(fs, 'openSync', (file, ...args) => {
    if (String(file).endsWith(path.join('session', 'messages.jsonl'))) throw Object.assign(new Error('private open detail'), { code: 'EMFILE' });
    const descriptor = open(file, ...args);
    if (String(file).endsWith(path.join('session', 'events.jsonl'))) target = descriptor;
    return descriptor;
  });
  t.mock.method(fs, 'closeSync', descriptor => { if (descriptor === target) closed = true; return close(descriptor); });
  await assert.rejects(exportFullSessionDebug(parent.id), error => error.code === 'SESSION_DEBUG_OPEN_FILES' && error.exportPhase === 'history');
  assert.equal(closed, true);
  assert.deepEqual(fs.readdirSync(path.join(process.env.BZZY_HOME, 'debug-exports')), []);
});
