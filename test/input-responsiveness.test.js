import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { root } from '../src/process.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const ptyAvailable = process.platform === 'linux' && spawnSync('script', ['--version'], { stdio: 'ignore' }).status === 0;

test('typing during a goal replacement survives cancellation, streaming and the return to chat', { skip: !ptyAvailable, timeout: 25000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-input-'));
  const home = path.join(directory, 'private');
  fs.writeFileSync(path.join(directory, 'source.txt'), 'Supplied local evidence');
  const env = { ...process.env, BZZY_HOME: home, BZZY_DIRECT: '0', BZZY_CODEX_HOME: path.join(directory, 'codex'),
    BZZY_CODEX_BIN: path.join(root, 'test/fixtures/advanced-agent.mjs'), BZZY_TEST_ADVANCED: 'slow',
    BZZY_TEST_LOG: path.join(directory, 'backend.jsonl'), TERM: 'xterm-256color' };
  const command = [process.execPath, path.join(root, 'bin/bzzy.js'), '--goal', 'Original objective', '--provider', 'codex', '--no-pet', '--yolo']
    .map(value => `'${value.replaceAll("'", "'\\''")}'`).join(' ');
  const child = spawn('script', ['-qefc', command, '/dev/null'], { cwd: directory, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const done = new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
  const records = kind => {
    const file = path.join(home, 'bzzy.sqlite'); if (!fs.existsSync(file)) return [];
    const db = new DatabaseSync(file, { readOnly: true });
    try { db.exec('PRAGMA busy_timeout=1000'); return db.prepare('SELECT data FROM records WHERE kind=?').all(kind).map(row => JSON.parse(row.data)); }
    catch (error) { if (error.errcode === 5 || /no such table/.test(error.message)) return []; throw error; }
    finally { db.close(); }
  };
  async function until(check, label) {
    for (let attempt = 0; attempt < 600; attempt++) {
      if (check()) return;
      assert.equal(child.exitCode, null, `Exited before ${label}: ${output.slice(-2000)}`);
      await delay(20);
    }
    throw new Error(`Missing ${label}: ${output.slice(-3000)}`);
  }
  try {
    await until(() => records('session')[0]?.engineThreadId && output.includes('Send'), 'running goal and editor');
    const original = records('session')[0];
    child.stdin.write('/goal Replacement objective\rTyping through the goal transition');
    await until(() => records('session')[0]?.goal.objective === 'Replacement objective', 'replacement goal');
    await until(() => output.includes('Typing through the goal transition'), 'draft rendered during work');
    await until(() => records('session')[0]?.goal.status === 'complete' && records('execution').every(job => !['queued', 'launching', 'running'].includes(job.state)), 'replacement completion');
    const after = records('session')[0];
    assert.equal(after.engineThreadId, original.engineThreadId); assert.notEqual(after.goal.id, original.goal.id);
    assert.equal(records('goal-history').find(goal => goal.id === original.goal.id)?.supersededBy, after.goal.id);
    child.stdin.write('\r');
    await until(() => records('execution').some(job => !job.goal && job.prompt === 'Typing through the goal transition' && job.state === 'finished'), 'the preserved draft sent as a follow-up');
    assert.equal(records('session')[0].goal.id, after.goal.id);
    child.stdin.write('/exit\r'); assert.equal(await done, 0, output.slice(-2000));
  } finally {
    if (child.exitCode == null) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
    await done.catch(() => {});
    const stop = spawn(process.execPath, [path.join(root, 'bin/bzzy.js'), 'service', 'stop', '--json'], { cwd: directory, env, stdio: 'ignore' });
    await new Promise(resolve => stop.once('close', resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
