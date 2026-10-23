import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createSession, saveSession, loadSession, sessions, findSession, setSessionAlias, sessionPath } from '../src/store.js';
import { BUILTINS } from '../src/providers.js';
import { chooseSavedSession, promptSessionAlias } from '../src/session-browser.js';
import { parseArgs } from '../src/cli.js';
import { appendEvent, events, listRecords } from '../src/database.js';
import { root } from '../src/process.js';
import { runtimeInfo, runtimeRequest } from '../src/runtime.js';
import { identityAlive } from '../src/recovery.js';

let directory, work, elsewhere, previous;
test.beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-sessions-'));
  work = path.join(directory, 'original-project'); elsewhere = path.join(directory, 'another-directory');
  fs.mkdirSync(work); fs.mkdirSync(elsewhere);
  const keys = ['BZZY_HOME', 'BZZY_CODEX_HOME', 'BZZY_CODEX_BIN', 'BZZY_TEST_LOG', 'BZZY_DIRECT'];
  previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { BZZY_HOME: path.join(directory, 'private'), BZZY_CODEX_HOME: path.join(directory, 'codex'),
    BZZY_CODEX_BIN: path.join(root, 'test/fixtures/codex.mjs'), BZZY_TEST_LOG: path.join(directory, 'backend.jsonl') });
  delete process.env.BZZY_DIRECT;
});
test.afterEach(async () => {
  const info = runtimeInfo();
  if (info && identityAlive(info.identity)) await runtimeRequest(info, 'POST', '/shutdown', {}).catch(() => {});
  for (let index = 0; index < 100 && info && identityAlive(info.identity); index++) await new Promise(resolve => setTimeout(resolve, 20));
  for (const [key, value] of Object.entries(previous)) if (value == null) delete process.env[key]; else process.env[key] = value;
  fs.rmSync(directory, { recursive: true, force: true });
});

test('aliases identify the original session and its directory without changing its history', () => {
  const original = createSession(BUILTINS.codex, work, 'chosen-model', 'trabajo_01');
  appendEvent(original.id, 'text', { text: 'Previous findings', itemId: 'answer' });
  assert.equal(parseArgs(['--alias', ' trabajo_01 ']).options.alias, 'trabajo_01');
  for (const alias of ['', ' ', 'x'.repeat(81), 'bad\nname', 'bad\x1bname']) assert.throws(() => parseArgs([`--alias=${alias}`]));
  assert.equal(findSession('trabajo_01', elsewhere).id, original.id);
  assert.equal(findSession(original.id.slice(0, 8)).cwd, work);
  const renamed = setSessionAlias(original.id, 'trabajo_02');
  assert.equal(renamed.cwd, work); assert.equal(findSession('trabajo_02').id, original.id);
  assert.throws(() => findSession('trabajo_01'), /No matching/);
  assert.ok(events(original.id).some(event => event.type === 'text' && event.data.text === 'Previous findings'));
  assert.equal(JSON.parse(fs.readFileSync(sessionPath(original.id), 'utf8')).alias, 'trabajo_02');
  createSession(BUILTINS.codex, elsewhere, null, 'trabajo_02');
  assert.throws(() => findSession('trabajo_02'), /ambiguous/);
  assert.equal(findSession(original.id).cwd, work);
});

test('a runner saving an older snapshot cannot erase a new alias or its directory', () => {
  const stale = createSession(BUILTINS.codex, work, null, 'old-name');
  setSessionAlias(stale.id, 'new-name');
  stale.turns = 5; stale.executionState = 'running'; saveSession(stale);
  assert.equal(loadSession(stale.id).alias, 'new-name');
  assert.equal(loadSession(stale.id).turns, 5); assert.equal(loadSession(stale.id).cwd, work);
});

test('/alias prompts, supports an inline name, and cancels without renaming', async () => {
  const session = createSession(BUILTINS.codex, work);
  const ui = { event() {}, updateSession() {}, async ask(prompt) { assert.match(prompt, /Session alias/); return 'trabajo_01'; } };
  assert.equal((await promptSessionAlias(session.id, '', ui)).alias, 'trabajo_01');
  ui.ask = async () => { throw new Error('Inline aliases must not prompt'); };
  assert.equal((await promptSessionAlias(session.id, 'trabajo_02', ui)).alias, 'trabajo_02');
  ui.ask = async () => null;
  assert.equal((await promptSessionAlias(session.id, '', ui)).alias, 'trabajo_02');
  await assert.rejects(promptSessionAlias(session.id, 'denied', ui, () => { throw new Error('Input ownership changed'); }), /ownership/);
  assert.equal(loadSession(session.id).alias, 'trabajo_02');
});

test('session picker shows names and saved directories, with direct attach, view and cancel', async () => {
  const session = createSession(BUILTINS.codex, work, null, 'trabajo_01');
  const child = createSession(BUILTINS.codex, work); child.parentSessionId = session.id; saveSession(child);
  let answer = session.id;
  const ui = { event() {}, async chooseOne(title, picker) {
    assert.equal(title, 'Saved sessions'); assert.equal(picker.choices.length, 1);
    assert.match(picker.choices[0].label, /trabajo_01/); assert.ok(picker.choices[0].description.includes(work));
    assert.deepEqual(picker.shortcuts, { a: 'attach', v: 'view' }); return answer;
  } };
  assert.equal((await chooseSavedSession(ui)).action, 'attach');
  answer = { value: session.id, action: 'view' };
  const selected = await chooseSavedSession(ui);
  assert.equal(selected.action, 'view'); assert.equal(selected.session.cwd, work);
  answer = null; assert.equal(await chooseSavedSession(ui), null);
});

test('noninteractive sessions output includes the alias and saved directory', () => {
  const session = createSession(BUILTINS.codex, work, null, 'trabajo_01');
  const result = spawnSync(process.execPath, [path.join(root, 'bin/bzzy.js'), 'sessions', '--json'], { cwd: elsewhere, env: process.env, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  const item = result.stdout.trim().split('\n').map(JSON.parse).find(item => item.session?.id === session.id);
  assert.equal(item.session.alias, 'trabajo_01'); assert.equal(item.session.cwd, work);
  assert.match(item.message, /trabajo_01/);
});

test('--alias persists on the direct task creation path, including request IDs', () => {
  const result = spawnSync(process.execPath, [path.join(root, 'bin/bzzy.js'), 'run', 'Hello', '--provider', 'codex', '--alias', 'trabajo_01', '--request-id', 'named-task', '--json', '--no-pet'],
    { cwd: work, env: { ...process.env, BZZY_DIRECT: '1' }, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const session = findSession('trabajo_01'); assert.equal(session.cwd, work);
  assert.equal(sessions().length, 1);
});

const ptyAvailable = process.platform === 'linux' && spawnSync('script', ['--version'], { stdio: 'ignore' }).status === 0;
for (const action of ['attach', 'view', 'new']) {
  test(`terminal ${action}: alias restores the project directory from another directory`, { skip: !ptyAvailable, timeout: 20000 }, async () => {
    let original;
    if (action !== 'new') {
      original = createSession(BUILTINS.codex, work, null, 'trabajo_01');
      appendEvent(original.id, 'text', { text: 'saved-history-marker', itemId: 'saved-answer' });
      const latest = createSession(BUILTINS.codex, elsewhere, null, 'another-session');
      // Keep the target below another row so the real terminal must navigate down.
      saveSession(latest);
      appendEvent(latest.id, 'text', { text: 'other-history-marker', itemId: 'other-answer' });
    }
    const command = [process.execPath, path.join(root, 'bin/bzzy.js'), ...(action === 'new' ? ['--provider', 'codex', '--alias', 'trabajo_01'] : ['sessions']), '--no-pet'];
    const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
    const child = spawn('script', ['-qefc', command.map(quote).join(' '), '/dev/null'], { cwd: action === 'new' ? work : elsewhere,
      env: { ...process.env, TERM: 'xterm-256color' }, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    const done = new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
    async function until(check) {
      for (let attempt = 0; attempt < 500; attempt++) {
        if (check()) return; assert.equal(child.exitCode, null, output.slice(-2500));
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error('Missing terminal state: ' + output.slice(-2500));
    }
    try {
      if (action !== 'new') {
        await until(() => output.includes('Saved sessions') && output.includes('another-session') && output.includes('trabajo_01'));
        child.stdin.write('\x1b[B' + (action === 'view' ? 'v' : '\r'));
        await until(() => output.includes('saved-history-marker'));
        assert.ok(!output.includes('other-history-marker'));
      } else await until(() => output.includes('Your next goal starts here.'));
      if (action === 'attach' || action === 'new') {
        child.stdin.write('/alias\r');
        await until(() => output.includes('Session alias [trabajo_01]'));
        child.stdin.write('renamed-project\r');
        await until(() => output.includes('Session alias: renamed-project'));
        if (action === 'attach') {
          child.stdin.write('/export shared-project.zip\r');
          await until(() => output.includes('Exported:') && fs.existsSync(path.join(work, 'shared-project.zip')));
          child.stdin.write('Hello from another directory\r');
          await until(() => output.includes('First pass.'));
        }
      } else {
        child.stdin.write('/alias denied\r');
        await until(() => output.includes('read-only view'));
      }
      child.stdin.write('/exit\r'); assert.equal(await done, 0, output.slice(-2500));
      const session = findSession(action === 'view' ? 'trabajo_01' : 'renamed-project');
      assert.equal(session.cwd, work);
      if (original) assert.equal(session.id, original.id);
      if (action === 'attach') {
        const execution = listRecords('execution').find(job => job.sessionId === session.id);
        assert.equal(execution.options.cwd, work);
        const log = fs.readFileSync(process.env.BZZY_TEST_LOG, 'utf8').trim().split('\n').map(JSON.parse);
        assert.ok(log.some(item => item.method === 'thread/start' && item.params.cwd === work));
      }
      if (action === 'view') assert.equal(listRecords('execution').length, 0, 'view never executes the session');
    } finally {
      if (child.exitCode == null) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
      await done.catch(() => {});
    }
  });
}
