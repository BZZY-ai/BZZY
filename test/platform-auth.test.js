import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { root } from '../src/process.js';
import { subscriptionEnvironment, subscriptionStatus, claudeAuthHomes } from '../src/auth.js';
import { BUILTINS } from '../src/providers.js';
import { checkConnection } from '../src/connection-check.js';
import { createSession } from '../src/store.js';
import { prepareTask } from '../src/task.js';
import { availableModels } from '../src/models.js';
import { ClaudeEngine } from '../src/engines/claude.js';

const keys = ['BZZY_HOME', 'BZZY_CLAUDE_BIN', 'BZZY_CLAUDE_HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR', 'BZZY_TEST_KEYCHAIN', 'BZZY_TEST_LOG'];
let dir, saved;
test.beforeEach(() => {
  saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-platform-auth-')));
  Object.assign(process.env, { BZZY_HOME: path.join(dir, 'private'), BZZY_CLAUDE_BIN: path.join(root, 'test/fixtures/claude-keychain.mjs'),
    BZZY_TEST_KEYCHAIN: path.join(dir, 'fake-keychain'), BZZY_TEST_LOG: path.join(dir, 'calls.jsonl') });
});
test.afterEach(() => {
  for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  fs.rmSync(dir, { recursive: true, force: true });
});
function login() {
  const result = spawnSync(process.execPath, [path.join(root, 'bin/bzzy.js'), 'auth', 'claude', '--json'], { env: process.env, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
}
const calls = () => fs.readFileSync(process.env.BZZY_TEST_LOG, 'utf8').trim().split('\n').map(JSON.parse);

test('auth then doctor reuses the default Keychain identity without setting CLAUDE_CONFIG_DIR', async () => {
  login();
  // Reproduce the former doctor bug: an explicit default path selects another entry.
  assert.equal(subscriptionStatus(BUILTINS.claude, { directory: path.join(os.homedir(), '.claude') }).available, false);
  const result = await checkConnection(BUILTINS.claude, { live: true });
  assert.equal(result.ok, true, result.error); assert.equal(result.response, true);
  assert.equal(calls().at(-1).config, null);
  assert.equal(fs.readdirSync(process.env.BZZY_TEST_KEYCHAIN).length, 1, 'only the original login slot exists');
});

for (const config of ['', 'default', 'custom/']) {
  test(`explicit Claude config identity is preserved exactly: ${JSON.stringify(config)}`, async () => {
    const directory = config === 'default' ? path.join(os.homedir(), '.claude') : config ? path.join(dir, config) + '/' : '';
    process.env.CLAUDE_CONFIG_DIR = directory;
    login();
    assert.equal(subscriptionEnvironment('claude').CLAUDE_CONFIG_DIR, directory);
    const result = await checkConnection(BUILTINS.claude, { live: true });
    assert.equal(result.ok, true, result.error);
    assert.ok(calls().every(call => call.config === directory));
  });
}

test('a BZZY_CLAUDE_HOME override uses the same resolved identity for login and checks', async () => {
  process.env.BZZY_CLAUDE_HOME = path.join(dir, 'profile') + '/';
  process.env.CLAUDE_CONFIG_DIR = path.join(dir, 'other');
  login();
  assert.equal((await checkConnection(BUILTINS.claude, { live: true })).ok, true);
  assert.ok(calls().every(call => call.config === path.resolve(process.env.BZZY_CLAUDE_HOME)));
});

for (const secure of ['', 'separate-profile']) {
  test(`saved sessions preserve the secure-store override ${JSON.stringify(secure)} through model discovery and replies`, async () => {
    process.env.CLAUDE_CONFIG_DIR = path.join(dir, 'config') + '/';
    process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = secure;
    login();
    const original = claudeAuthHomes();
    const session = createSession(BUILTINS.claude, dir);
    prepareTask(session, {}, 'Reply to a greeting');
    assert.equal(session.backendHomes.claudeConfigDir, original.claudeConfigDir);
    assert.equal(session.backendHomes.claudeSecureStorageConfigDir, secure);
    process.env.CLAUDE_CONFIG_DIR = path.join(dir, 'wrong-config');
    process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = 'wrong-account';
    assert.equal((await checkConnection(BUILTINS.claude, { live: true, session })).ok, true);
    assert.equal((await availableModels(session)).source, 'installed backend');
    const events = [];
    const engine = new ClaudeEngine(BUILTINS.claude, session, {}, { event(type, data) { events.push({ type, ...data }); }, newline() {} });
    try { await engine.run('Hi'); } finally { await engine.close(); }
    assert.ok(events.some(event => event.type === 'text' && event.text.includes('BZZY_OK')));
    assert.ok(calls().every(call => call.config === original.claudeConfigDir && call.secure === secure));
  });
}

test('sessions created with unset credential variables keep them unset in a changed runtime environment', async () => {
  login();
  const session = createSession(BUILTINS.claude, dir); prepareTask(session, {}, 'Chat');
  assert.equal(session.backendHomes.claudeConfigDir, null); assert.equal(session.backendHomes.claudeSecureStorageConfigDir, null);
  process.env.CLAUDE_CONFIG_DIR = 'changed-profile'; process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = 'changed-store';
  assert.equal((await checkConnection(BUILTINS.claude, { live: true, session })).ok, true);
});
