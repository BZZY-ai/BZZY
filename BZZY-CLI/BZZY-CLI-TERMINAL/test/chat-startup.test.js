import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { root } from '../src/process.js';
import { BUILTINS } from '../src/providers.js';
import { createSession, loadSession, saveSession } from '../src/store.js';
import { prepareTask } from '../src/task.js';
import { runSession } from '../src/controller.js';
import { newGoal } from '../src/goals.js';
import { listRecords } from '../src/database.js';
import { fileInfo } from '../src/evidence.js';
import { runtimeInfo, runtimeRequest } from '../src/runtime.js';
import { identityAlive } from '../src/recovery.js';

const keys = ['BZZY_HOME', 'BZZY_DIRECT', 'BZZY_CODEX_HOME', 'BZZY_CLAUDE_HOME', 'BZZY_CODEX_BIN', 'BZZY_CLAUDE_BIN', 'BZZY_TEST_SCENARIO', 'BZZY_TEST_LOG'];
let dir, work, saved;
test.beforeEach(() => {
  saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  // Unix socket paths must also fit macOS's shorter limit.
  dir = fs.mkdtempSync('/tmp/bz-chat-'); work = fs.realpathSync(dir);
  Object.assign(process.env, { BZZY_HOME: path.join(dir, 'private'), BZZY_DIRECT: '1', BZZY_CODEX_HOME: path.join(dir, 'codex-home'), BZZY_CLAUDE_HOME: path.join(dir, 'claude-home'),
    BZZY_CODEX_BIN: path.join(root, 'test/fixtures/codex.mjs'), BZZY_CLAUDE_BIN: path.join(root, 'test/fixtures/claude.mjs'),
    BZZY_TEST_SCENARIO: 'chat', BZZY_TEST_LOG: path.join(dir, 'backend.jsonl') });
  const file = fs.openSync(path.join(work, 'large.bin'), 'w'); fs.ftruncateSync(file, 21 * 1024 * 1024); fs.closeSync(file);
  fs.writeFileSync(path.join(work, 'source.txt'), 'source');
});
test.afterEach(async () => {
  const info = runtimeInfo();
  if (info && identityAlive(info.identity)) await runtimeRequest(info, 'POST', '/shutdown', {}).catch(() => {});
  for (let i = 0; i < 200 && info && identityAlive(info.identity); i++) await new Promise(resolve => setTimeout(resolve, 10));
  for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  fs.rmSync(dir, { recursive: true, force: true });
});
function ui() {
  return { interactive: false, json: true, events: [], event(type, data) { this.events.push({ type, ...data }); }, newline() {}, async ask() { return ''; }, async approve() { return false; } };
}

for (const id of ['codex', 'claude']) {
  test(`${id} chat replies in a directory containing a file above the evidence limit`, async () => {
    const session = createSession(BUILTINS[id], work); prepareTask(session, {}, 'Hi, who are you?');
    const output = ui();
    assert.equal(await runSession(BUILTINS[id], session, { pet: false }, output, 'Hi, who are you?'), 0);
    assert.ok(output.events.some(event => event.type === 'text'));
    assert.equal(loadSession(session.id).executionState, 'idle');
    assert.equal(loadSession(session.id).startSnapshotId, undefined);
    assert.equal(listRecords('snapshot').length, 0);
    assert.throws(() => fileInfo(path.join(work, 'large.bin')), /20 MiB/, 'explicit evidence capture retains its size limit');
  });

  test(`${id} managed runtime chat reaches the backend despite a large workspace file`, { timeout: 20000 }, async () => {
    const child = spawn(process.execPath, [path.join(root, 'bin/bzzy.js'), 'run', 'Hi, who are you?', '--provider', id, '--json', '--no-pet'],
      { cwd: work, env: { ...process.env, BZZY_DIRECT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.equal(code, 0, stdout + stderr); assert.match(stdout, /"type":"text"/); assert.doesNotMatch(stdout + stderr, /Evidence must|Cannot snapshot/);
  });
}

test('snapshot limits skip incidental files and the goal executes in its original cwd', async () => {
  const session = createSession(BUILTINS.codex, work); session.goal = newGoal('Verify the source'); prepareTask(session, {}, session.goal.objective);
  fs.writeFileSync(path.join(process.env.BZZY_HOME, 'config.json'), JSON.stringify({ snapshotLimits: { maxFileMiB: 20 } }));
  const goalId = session.goal.id, output = ui();
  assert.equal(await runSession(BUILTINS.codex, session, { pet: false }, output, session.goal.objective, { goal: true }), 0);
  assert.ok(output.events.some(event => event.type === 'info' && /snapshot skipped 1 file/.test(event.message)));
  assert.equal(output.events.some(event => event.type === 'error'), false);
  assert.ok(fs.existsSync(process.env.BZZY_TEST_LOG));
  const saved = loadSession(session.id);
  assert.equal(saved.executionState, 'idle'); assert.equal(saved.goal.id, goalId);
  assert.equal(saved.cwd, work); assert.ok(fs.existsSync(path.join(work, '.bzzy')));
  assert.equal(fs.statSync(path.join(work, 'large.bin')).size, 21 * 1024 * 1024);
  const [snapshot] = listRecords('snapshot'); assert.equal(snapshot.sessionId, session.id); assert.ok(snapshot.manifest['source.txt']);
  assert.equal(snapshot.manifest['large.bin'], undefined);
  const requests = fs.readFileSync(process.env.BZZY_TEST_LOG, 'utf8');
  assert.match(requests, /WORKSPACE SNAPSHOT COVERAGE/); assert.match(requests, /large.bin/);
});
