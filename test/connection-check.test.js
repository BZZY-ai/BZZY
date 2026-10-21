import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { checkConnection, checkConnections, connectionMessage } from '../src/connection-check.js';
import { CodexEngine } from '../src/engines/codex.js';
import { BUILTINS, saveConfig, defaultSelection } from '../src/providers.js';
import { createSession } from '../src/store.js';
import { setup } from '../src/cli.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const keys = ['BZZY_HOME', 'CODEX_HOME', 'BZZY_CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'BZZY_CLAUDE_HOME', 'BZZY_CODEX_BIN', 'BZZY_CLAUDE_BIN', 'BZZY_TEST_LOG', 'BZZY_TEST_CONNECTION_MODE', 'BZZY_TEST_MODEL_MODE', 'DEEPSEEK_API_KEY'];
let saved, dir;
test.beforeEach(() => {
  saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-check-test-'));
  Object.assign(process.env, { BZZY_HOME: path.join(dir, 'bzzy'), CODEX_HOME: path.join(dir, 'codex'), CLAUDE_CONFIG_DIR: path.join(dir, 'claude'),
    BZZY_CODEX_BIN: path.join(root, 'test/fixtures/auth.mjs'), BZZY_CLAUDE_BIN: path.join(root, 'test/fixtures/auth.mjs'), BZZY_TEST_LOG: path.join(dir, 'calls.jsonl') });
  for (const directory of [process.env.CODEX_HOME, process.env.CLAUDE_CONFIG_DIR]) fs.mkdirSync(directory);
  fs.writeFileSync(path.join(process.env.CODEX_HOME, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt' }));
  fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, '.credentials.json'), JSON.stringify({ fixtureAuthMethod: 'claude.ai' }));
});
test.afterEach(() => {
  for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  fs.rmSync(dir, { recursive: true, force: true });
});
const calls = () => fs.readFileSync(process.env.BZZY_TEST_LOG, 'utf8').trim().split('\n').map(JSON.parse);

test('connection checks verify native protocols for both logins without inference or project context', async () => {
  const messages = [];
  const results = await checkConnections({ event(_type, data) { messages.push(data.message); } });
  assert.equal(results.length, 2);
  for (const result of results) {
    assert.equal(result.ok, true); assert.equal(result.authenticated, true); assert.equal(result.connection, true); assert.equal(result.response, null);
  }
  assert.ok(calls().some(call => call.method === 'model/list'));
  assert.ok(!calls().some(call => call.method === 'thread/start' || call.method === 'turn/start' || call.type === 'user'));
  assert.match(messages.join('\n'), /Model reply: not tested/);
});

for (const id of ['codex', 'claude']) {
  test(`${id} live check requires a successful text reply and reports actual usage`, async () => {
    const result = await checkConnection(BUILTINS[id], { live: true, model: 'chosen-model', effort: 'high' });
    assert.equal(result.ok, true, result.error); assert.equal(result.response, true); assert.equal(result.tokens, 7);
    if (id === 'codex') {
      const start = calls().find(call => call.method === 'thread/start');
      assert.equal(start.params.model, 'chosen-model'); assert.equal(start.params.ephemeral, true); assert.equal(start.params.sandbox, 'read-only');
      assert.ok(start.params.cwd.startsWith(os.tmpdir())); assert.equal(fs.existsSync(start.params.cwd), false);
      assert.equal(calls().find(call => call.method === 'turn/start').params.effort, 'high');
    } else {
      const args = calls()[0].args;
      assert.ok(args.includes('--no-session-persistence')); assert.ok(args.includes('--tools')); assert.equal(args[args.indexOf('--tools') + 1], '');
      assert.equal(args[args.indexOf('--model') + 1], 'chosen-model');
    }
  });
  test(`${id} detects missing auth before starting a backend`, async () => {
    fs.rmSync(path.join(id === 'codex' ? process.env.CODEX_HOME : process.env.CLAUDE_CONFIG_DIR, id === 'codex' ? 'auth.json' : '.credentials.json'));
    const result = await checkConnection(BUILTINS[id], { live: true });
    assert.equal(result.ok, false); assert.equal(result.installed, true); assert.equal(result.authenticated, false);
    assert.match(result.error, new RegExp(`bzzy auth ${id}`)); assert.equal(fs.existsSync(process.env.BZZY_TEST_LOG), false);
  });
  test(`${id} fails on empty replies and nonretryable errors, without exposing bearer tokens`, async () => {
    for (const mode of ['empty', 'error']) {
      process.env.BZZY_TEST_CONNECTION_MODE = mode;
      const result = await checkConnection(BUILTINS[id], { live: true });
      assert.equal(result.ok, false); assert.equal(result.connection, true); assert.notEqual(result.response, true);
      assert.match(result.error, mode === 'empty' ? /without a text reply/ : /Rejected model/);
      assert.doesNotMatch(connectionMessage(result), /secret-example/);
    }
  });
  test(`${id} times out initialization and model replies and terminates its child process`, async () => {
    for (const mode of ['init-timeout', 'reply-timeout']) {
      process.env.BZZY_TEST_CONNECTION_MODE = mode;
      const result = await checkConnection(BUILTINS[id], { live: true, timeoutMs: 400 });
      assert.equal(result.ok, false); assert.equal(result.connection, mode === 'reply-timeout'); assert.match(result.error, /Timed out/);
      const pid = calls().filter(call => call.pid).at(-1).pid;
      for (let i = 0; i < 100; i++) {
        try { process.kill(pid, 0); } catch { break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    }
  });
}

test('doctor reports both backends as JSON, and a provider-specific failure returns a nonzero exit code', () => {
  let result = spawnSync(process.execPath, [path.join(root, 'bin/bzzy.js'), 'doctor', '--live', '--json'], { env: process.env, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const checks = result.stdout.trim().split('\n').map(JSON.parse).filter(event => event.check).map(event => event.check);
  assert.equal(checks.length, 2); assert.ok(checks.every(check => check.response && check.tokens === 7));
  process.env.BZZY_TEST_CONNECTION_MODE = 'error';
  result = spawnSync(process.execPath, [path.join(root, 'bin/bzzy.js'), 'doctor', '--live', '--provider', 'codex', '--model', 'chosen-model', '--json'], { env: process.env, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 1, result.stdout + result.stderr); assert.match(result.stdout, /FAIL/); assert.doesNotMatch(result.stdout, /secret-example/);
});

test('a failed setup reply check preserves the previous default and explicit provider-default selection ignores it', async () => {
  saveConfig({ version: 1, providers: {}, defaultProvider: 'codex', defaultSelection: { provider: 'codex', model: 'old-model', effort: 'high' } });
  process.env.BZZY_TEST_CONNECTION_MODE = 'error';
  const ui = { interactive: true, event() {}, async secret() { return ''; }, async chooseOne(_title, choices) { return Array.isArray(await choices) ? 'codex' : { value: '@bzzy-default', effort: 'default' }; } };
  await assert.rejects(setup(ui, { cwd: dir }), /Setup connection check failed/);
  assert.equal(defaultSelection().model, 'old-model');
  assert.equal(calls().find(call => call.method === 'thread/start').params.model, undefined);
});

test('Codex terminal errors reject the operation, while retryable errors remain active', async () => {
  const session = createSession(BUILTINS.codex, dir);
  const events = [];
  const engine = new CodexEngine(BUILTINS.codex, session, {}, { event(type, data) { events.push({ type, ...data }); }, newline() {} });
  let failed;
  engine.operation = { reject(error) { failed = error; } };
  engine.notification('error', { error: { message: 'Reconnecting' }, willRetry: true });
  assert.equal(failed, undefined); assert.match(events.at(-1).message, /Retrying/);
  engine.notification('error', { error: { message: 'Invalid model' }, willRetry: false });
  assert.equal(failed.message, 'Invalid model');
  let resolved = false;
  engine.operation = { pendingStart: false, goal: false, resolve() { resolved = true; } };
  engine.notification('turn/completed', { turn: { id: 'turn', status: 'completed' } });
  assert.equal(resolved, true, 'completion must settle even if the started notification was missed');
});
