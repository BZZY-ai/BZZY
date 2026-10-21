import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = fileURLToPath(new URL('../', import.meta.url));
const ptyAvailable = process.platform === 'linux' && spawnSync('script', ['--version'], { stdio: 'ignore' }).status === 0;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

for (const [provider, direct, expectedStatus = 'complete', resume = false] of [
  ['codex', false], ['claude', false], ['deepseek', false], ['codex', true],
  ['deepseek', false, 'awaiting_review'], ['codex', true, 'awaiting_review'], ['deepseek', false, 'awaiting_review', true],
]) {
  test(`${provider} ${direct ? 'direct' : 'managed'}: ${resume ? 'resumed' : 'startup'} goal ${expectedStatus} keeps its chat open`, { skip: !ptyAvailable, timeout: 30000 }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-goal-chat-'));
    const home = path.join(directory, 'private');
    const env = { ...process.env, BZZY_HOME: home, BZZY_DIRECT: direct ? '1' : '0',
      BZZY_CODEX_HOME: path.join(directory, 'codex'), BZZY_CLAUDE_HOME: path.join(directory, 'claude'),
      BZZY_CODEX_BIN: path.join(root, 'test/fixtures/advanced-agent.mjs'), BZZY_CLAUDE_BIN: path.join(root, 'test/fixtures/advanced-agent.mjs'),
      BZZY_TEST_LOG: path.join(directory, 'backend.jsonl'), BZZY_TEST_ADVANCED: 'observation-cleanup', DEEPSEEK_API_KEY: 'fixture-only-key', TERM: 'xterm-256color' };
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ version: 1, providers: {
      deepseek: { id: 'deepseek', name: 'DeepSeek', backend: 'codex', auth: 'api-key', baseUrl: 'http://127.0.0.1:9', envKey: 'DEEPSEEK_API_KEY' },
    } }));
    const command = [process.execPath, path.join(root, 'bin/bzzy.js'), '--goal', 'Inspect the supplied task', '--provider', provider, '--request-id', 'startup-goal', '--no-pet', '--yolo'];
    if (expectedStatus === 'awaiting_review') {
      fs.writeFileSync(path.join(directory, 'contract.json'), JSON.stringify({ artifacts: [{ path: 'required-but-missing.txt' }], limits: { maxRetries: 0 } }));
      command.push('--contract', path.join(directory, 'contract.json'));
    }
    if (resume) {
      const seeded = spawnSync(command[0], [...command.slice(1), '--json'], { cwd: directory, env, encoding: 'utf8', timeout: 15000 });
      assert.equal(seeded.status, 2, seeded.stderr);
      const [file] = fs.readdirSync(path.join(home, 'sessions')).filter(name => name.endsWith('.json'));
      const session = JSON.parse(fs.readFileSync(path.join(home, 'sessions', file), 'utf8'));
      command.splice(2, command.length - 2, '--resume', session.id, '--no-pet', '--yolo');
    }
    const child = spawn('script', ['-qefc', command.map(quote).join(' '), '/dev/null'], { cwd: directory, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    const sessions = () => {
      const folder = path.join(home, 'sessions');
      return fs.existsSync(folder) ? fs.readdirSync(folder).filter(name => name.endsWith('.json')).map(name => JSON.parse(fs.readFileSync(path.join(folder, name), 'utf8'))) : [];
    };
    const idle = () => {
      if (sessions()[0]?.executionState !== 'idle') return false;
      const db = new DatabaseSync(path.join(home, 'bzzy.sqlite'), { readOnly: true });
      try { return db.prepare("SELECT data FROM records WHERE kind='execution'").all().every(row => !['queued', 'launching', 'running'].includes(JSON.parse(row.data).state)); }
      finally { db.close(); }
    };
    async function until(check, label) {
      for (let attempt = 0; attempt < 600; attempt++) {
        if (check()) return;
        assert.equal(child.exitCode, null, `CLI exited before ${label}: ${stderr} ${stdout.slice(-2000)}`);
        await delay(20);
      }
      throw new Error(`Timed out waiting for ${label}: ${stderr} ${JSON.stringify(sessions())} ${stdout.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').slice(-10000)}`);
    }
    try {
      await until(() => sessions()[0]?.goal?.status === expectedStatus && stdout.includes('/providers · /models'), 'chat after goal execution');
      const initial = sessions()[0];
      if (expectedStatus === 'complete') {
        assert.equal(initial.goal.turns, 1, 'cleaned observation evidence must not cause repeated goal turns');
        assert.equal(initial.acceptance.passed, true);
        assert.equal(initial.acceptance.requirements[0].stale, false);
        assert.doesNotMatch(stdout, /Completion assessment found unmet requirements/);
      } else {
        assert.equal(initial.acceptance.passed, false);
        assert.equal(initial.acceptance.artifacts[0].passed, false);
      }
      child.stdin.write('Explain the result\r');
      await until(() => sessions()[0]?.turns > initial.turns && idle(), 'follow-up reply');
      const continued = sessions()[0];
      assert.equal(sessions().length, 1);
      assert.equal(continued.id, initial.id);
      assert.equal(continued.engineThreadId, initial.engineThreadId);
      assert.equal(continued.goal.id, initial.goal.id);
      assert.equal(continued.goal.status, expectedStatus);
      if (expectedStatus === 'awaiting_review') fs.writeFileSync(path.join(directory, 'required-but-missing.txt'), 'Required output now exists.');
      child.stdin.write('/goal Verify a second task\r');
      await until(() => sessions()[0]?.goal?.id !== initial.goal.id && sessions()[0]?.goal?.status === 'complete' && idle(), 'second goal execution');
      child.stdin.write('/exit\r');
      assert.equal(await done, 0, stderr + stdout.slice(-2000));
    } finally {
      if (child.exitCode == null) child.kill('SIGKILL');
      await done.catch(() => {});
      const stop = spawn(process.execPath, [path.join(root, 'bin/bzzy.js'), 'service', 'stop', '--json'], { cwd: directory, env, stdio: 'ignore' });
      await new Promise(resolve => stop.once('close', resolve));
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}
