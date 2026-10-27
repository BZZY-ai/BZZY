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
import { exportFullSessionDebug } from '../src/engine/session-full-debug.js';

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

test('full ZIP preserves long chat, memory, learning, notes, ledgers, evidence and derived sessions without changing the running session', async () => {
  const long = 'x'.repeat(90000) + 'END_OF_COMPLETE_DATA';
  fs.writeFileSync(path.join(parent.cwd, '.bzzy', 'NOTES.md'), long);
  fs.mkdirSync(path.join(parent.cwd, '.bzzy', 'ledger')); fs.writeFileSync(path.join(parent.cwd, '.bzzy', 'ledger', 'day.jsonl'), JSON.stringify({ sessionId: parent.id, record: { details: long } }) + '\n');
  fs.writeFileSync(path.join(parent.cwd, 'script.sh'), '#!/bin/sh\ntouch SHOULD_NEVER_EXECUTE\n');
  putRecord('core.session.memory.node', 'node-full', { id: 'node-full', sessionId: parent.id, summary: long, fields: Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`field${i}`, i])) });
  putRecord('core.session.compactor.job', 'node-full', { id: 'node-full', sessionId: parent.id, state: 'paused', reason: 'foreground_work' });
  const jobId = randomUUID();
  putRecord('core.learning.job', jobId, { id: jobId, sessionId: parent.id, projectId: parent.projectId, state: 'complete', sourceId: `${parent.id}:1` });
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

test('oversized full capture fails rather than publishing a clipped archive; the read-first guides stay identical', async () => {
  const large = path.join(parent.cwd, 'large.bin'); fs.closeSync(fs.openSync(large, 'wx')); fs.truncateSync(large, 65 * 1024 * 1024);
  await assert.rejects(exportFullSessionDebug(parent.id), /size limit/);
  assert.ok(!fs.readdirSync(parent.cwd).some(name => name.endsWith('.zip'))); assert.deepEqual(fs.readdirSync(path.join(process.env.BZZY_HOME, 'debug-exports')), []);
  assert.deepEqual(fs.readFileSync(fileURLToPath(new URL('../../GUIDE_TO_BZZY_DEBUGGER.txt', import.meta.url))), fs.readFileSync(fileURLToPath(new URL('../docs/GUIDE_TO_BZZY_DEBUGGER.txt', import.meta.url))));
});
