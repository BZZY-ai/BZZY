import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { root } from '../src/process.js';

test('--whoami prints a detailed text reference before setup without starting backends or creating state', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-whoami-'));
  const home = path.join(directory, 'fresh-private');
  try {
    const result = spawnSync(process.execPath, [path.join(root, 'bin/bzzy.js'), '--whoami'], { cwd: directory, encoding: 'utf8', timeout: 5000,
      env: { ...process.env, BZZY_HOME: home, BZZY_CODEX_BIN: path.join(directory, 'no-codex'), BZZY_CLAUDE_BIN: path.join(directory, 'no-claude'),
        DEEPSEEK_API_KEY: 'whoami-api-secret-sentinel', BZZY_TELEGRAM_BOT_TOKEN: 'whoami-bot-secret-sentinel' } });
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
    assert.match(result.stdout, /^# bzzy 0\.2\.0/);
    for (const mode of ['--parallel', '--validate', '--delegate', '--besties', '--default']) assert.ok(result.stdout.includes(mode));
    for (const topic of ['bzzy.sqlite', 'credentials.json', 'goal-history', 'defaultSelection', 'parallelDefault', 'debateDefault', 'bestiesDefault',
      'delegateDefault', 'HH:MM:SS', 'awaiting_review', 'BRAIN', 'HANDS', 'BzzyClient', '/v1/sessions/ID/events', 'Idempotency-Key',
      'read-only', 'context-file', 'sandbox-exec', 'WHOAMI.md']) assert.ok(result.stdout.includes(topic), `Missing ${topic}`);
    assert.ok(result.stdout.includes(JSON.stringify(home))); assert.ok(result.stdout.includes(JSON.stringify(directory)));
    assert.ok(result.stdout.length > 20000, 'the output is a full integration reference');
    assert.doesNotMatch(result.stdout, /whoami-api-secret-sentinel|whoami-bot-secret-sentinel|\x1b/);
    assert.equal(fs.existsSync(home), false, 'reference discovery must not initialize state or launch a service');
    assert.deepEqual(fs.readdirSync(directory), []);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('--whoami ignores credential/config contents and remains text with --json', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-whoami-private-'));
  try {
    const secret = 'private-token-never-in-reference';
    fs.writeFileSync(path.join(directory, 'credentials.json'), secret);
    fs.writeFileSync(path.join(directory, 'config.json'), '{invalid-config');
    fs.mkdirSync(path.join(directory, 'runtime'));
    fs.writeFileSync(path.join(directory, 'runtime/service.json'), secret);
    const before = fs.readdirSync(directory).sort();
    const result = spawnSync(process.execPath, [path.join(root, 'bin/bzzy.js'), '--whoami', '--json'], {
      cwd: directory, encoding: 'utf8', timeout: 5000, env: { ...process.env, BZZY_HOME: directory },
    });
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
    assert.match(result.stdout, /^# bzzy/); assert.ok(!result.stdout.includes(secret));
    assert.deepEqual(fs.readdirSync(directory).sort(), before);
    assert.equal(fs.readFileSync(path.join(directory, 'credentials.json'), 'utf8'), secret);
    assert.equal(fs.readFileSync(path.join(directory, 'config.json'), 'utf8'), '{invalid-config');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
