import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { codexHome, claudeHome, subscriptionEnvironment, subscriptionStatus } from '../src/auth.js';
import { codexLaunch, CodexEngine } from '../src/engines/codex.js';
import { claudeEnvironment, ClaudeEngine } from '../src/engines/claude.js';
import { BUILTINS } from '../src/providers.js';
import { writeJson } from '../src/files.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const keys = ['BZZY_HOME', 'CODEX_HOME', 'BZZY_CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'BZZY_CLAUDE_HOME', 'BZZY_CODEX_BIN', 'BZZY_CLAUDE_BIN', 'BZZY_TEST_AUTH_CALLS', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'ANTHROPIC_API_KEY'];
let dir, saved;
test.beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-auth-'));
  saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { BZZY_HOME: path.join(dir, 'bzzy'), CODEX_HOME: path.join(dir, 'native-codex'), CLAUDE_CONFIG_DIR: path.join(dir, 'native-claude'),
    BZZY_CODEX_BIN: path.join(root, 'test/fixtures/auth.mjs'), BZZY_CLAUDE_BIN: path.join(root, 'test/fixtures/auth.mjs'), BZZY_TEST_AUTH_CALLS: path.join(dir, 'calls.jsonl') });
  delete process.env.BZZY_CODEX_HOME; delete process.env.BZZY_CLAUDE_HOME;
  writeJson(path.join(process.env.CODEX_HOME, 'auth.json'), { auth_mode: 'chatgpt', tokens: { access_token: 'fixture-only-never-a-real-token' } });
  writeJson(path.join(process.env.CLAUDE_CONFIG_DIR, '.credentials.json'), { fixtureAuthMethod: 'claude.ai', token: 'fixture-only-never-a-real-token' });
});
test.afterEach(() => { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value; fs.rmSync(dir, { recursive: true, force: true }); });

test('native login stores are the defaults, with explicit home overrides and a separate API store', () => {
  assert.equal(codexHome(), process.env.CODEX_HOME); assert.equal(claudeHome(), process.env.CLAUDE_CONFIG_DIR);
  assert.equal(codexHome(BUILTINS.deepseek), path.join(process.env.BZZY_HOME, 'codex-api'));
  delete process.env.CODEX_HOME; delete process.env.CLAUDE_CONFIG_DIR;
  assert.equal(codexHome(), path.join(os.homedir(), '.codex')); assert.equal(claudeHome(), path.join(os.homedir(), '.claude'));
  process.env.BZZY_CODEX_HOME = path.join(dir, 'explicit-codex'); process.env.BZZY_CLAUDE_HOME = path.join(dir, 'explicit-claude');
  assert.equal(codexHome(), process.env.BZZY_CODEX_HOME);
  assert.equal(claudeEnvironment().CLAUDE_CONFIG_DIR, process.env.BZZY_CLAUDE_HOME);
});

test('official CLI status checks reuse subscription credentials without copying or exposing them', () => {
  const before = fs.readFileSync(path.join(process.env.CODEX_HOME, 'auth.json'), 'utf8');
  assert.deepEqual(subscriptionStatus(BUILTINS.codex), { available: true });
  assert.deepEqual(subscriptionStatus(BUILTINS.claude), { available: true });
  assert.equal(fs.readFileSync(path.join(process.env.CODEX_HOME, 'auth.json'), 'utf8'), before);
  assert.equal(fs.existsSync(path.join(process.env.BZZY_HOME, 'auth.json')), false);
  assert.doesNotMatch(fs.readFileSync(process.env.BZZY_TEST_AUTH_CALLS, 'utf8'), /fixture-only-never-a-real-token/);
});

test('an API-key login is not mistaken for a subscription login', () => {
  writeJson(path.join(process.env.CODEX_HOME, 'auth.json'), { auth_mode: 'apikey' });
  writeJson(path.join(process.env.CLAUDE_CONFIG_DIR, '.credentials.json'), { fixtureAuthMethod: 'api_key' });
  assert.equal(subscriptionStatus(BUILTINS.codex).available, false);
  assert.equal(subscriptionStatus(BUILTINS.claude).available, false);
});

test('subscription execution stops before inference when only API-key logins are present', async () => {
  writeJson(path.join(process.env.CODEX_HOME, 'auth.json'), { auth_mode: 'apikey' });
  writeJson(path.join(process.env.CLAUDE_CONFIG_DIR, '.credentials.json'), { fixtureAuthMethod: 'api_key' });
  await assert.rejects(new CodexEngine(BUILTINS.codex, { id: 'fixture-session' }, {}, {}).open(), /subscription authentication/);
  await assert.rejects(new ClaudeEngine(BUILTINS.claude, {}, {}, {}).run('Do not run inference'), /subscription authentication/);
  const calls = fs.readFileSync(process.env.BZZY_TEST_AUTH_CALLS, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.ok(calls.every(call => call.args.includes('status')));
});

test('subscription launch keeps its native history store and clears inherited API routing', () => {
  process.env.OPENAI_API_KEY = 'unwanted-api-key'; process.env.OPENAI_BASE_URL = 'https://unwanted.example'; process.env.ANTHROPIC_API_KEY = 'unwanted-api-key';
  const session = { id: 'fixture-session' }, launch = codexLaunch(BUILTINS.codex, session);
  assert.equal(launch.env.CODEX_HOME, process.env.CODEX_HOME); assert.equal(launch.env.OPENAI_API_KEY, undefined); assert.equal(launch.env.OPENAI_BASE_URL, undefined);
  assert.ok(launch.args.includes('model_provider="openai"')); assert.equal(subscriptionEnvironment('claude').ANTHROPIC_API_KEY, undefined);
  const original = session.engineHome; process.env.CODEX_HOME = path.join(dir, 'another-store');
  assert.equal(codexLaunch(BUILTINS.codex, session).env.CODEX_HOME, original);
});

test('first-time setup reuses each existing login without launching browser authentication', () => {
  for (const provider of ['codex', 'claude']) {
    const result = spawnSync(process.execPath, [path.join(root, 'bin/bzzy.js'), 'setup', '--provider', provider, '--json'], { env: process.env, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stdout + result.stderr); assert.match(result.stdout, /Using the existing/);
    assert.doesNotMatch(result.stdout + result.stderr, /fixture-only-never-a-real-token/);
  }
  const calls = fs.readFileSync(process.env.BZZY_TEST_AUTH_CALLS, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(calls.map(call => call.args), [['login', 'status'], ['auth', 'status', '--json']]);
});
