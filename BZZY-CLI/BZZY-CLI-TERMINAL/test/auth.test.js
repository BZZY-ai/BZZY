import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { codexHome, claudeHome, subscriptionEnvironment, subscriptionStatus } from '../src/auth.js';
import { codexLaunch, CodexEngine } from '../src/engines/codex.js';
import { claudeEnvironment, ClaudeEngine } from '../src/engines/claude.js';
import { BUILTINS, config, apiKey, defaultSelection, saveConfig } from '../src/providers.js';
import { sessions } from '../src/store.js';
import { setup } from '../src/cli.js';
import { writeJson } from '../src/files.js';
import { runtimeInfo, runtimeRequest } from '../src/runtime.js';
import { identityAlive } from '../src/recovery.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const keys = ['BZZY_HOME', 'CODEX_HOME', 'BZZY_CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'BZZY_CLAUDE_HOME', 'BZZY_CODEX_BIN', 'BZZY_CLAUDE_BIN', 'BZZY_TEST_AUTH_CALLS', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY'];
let dir, saved;
test.beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-auth-'));
  saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { BZZY_HOME: path.join(dir, 'bzzy'), CODEX_HOME: path.join(dir, 'native-codex'), CLAUDE_CONFIG_DIR: path.join(dir, 'native-claude'),
    BZZY_CODEX_BIN: path.join(root, 'test/fixtures/auth.mjs'), BZZY_CLAUDE_BIN: path.join(root, 'test/fixtures/auth.mjs'), BZZY_TEST_AUTH_CALLS: path.join(dir, 'calls.jsonl') });
  delete process.env.BZZY_CODEX_HOME; delete process.env.BZZY_CLAUDE_HOME;
  delete process.env.DEEPSEEK_API_KEY;
  writeJson(path.join(process.env.CODEX_HOME, 'auth.json'), { auth_mode: 'chatgpt', tokens: { access_token: 'fixture-only-never-a-real-token' } });
  writeJson(path.join(process.env.CLAUDE_CONFIG_DIR, '.credentials.json'), { fixtureAuthMethod: 'claude.ai', token: 'fixture-only-never-a-real-token' });
});
test.afterEach(async () => {
  const info = runtimeInfo();
  if (info && identityAlive(info.identity)) await runtimeRequest(info, 'POST', '/shutdown', {}).catch(() => {});
  for (let index = 0; index < 100 && info && identityAlive(info.identity); index++) await new Promise(resolve => setTimeout(resolve, 20));
  for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  fs.rmSync(dir, { recursive: true, force: true });
});

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

test('interactive setup validates both subscriptions and allows skipping DeepSeek', async () => {
  const seen = [], titles = [], options = { cwd: dir }; let prompts = 0;
  const ui = { interactive: true, openTerminal() {}, event(_type, data) { seen.push(data.message); },
    async secret(prompt) { prompts++; assert.match(prompt, /DeepSeek.*optional.*Enter to skip/); return ''; },
    async chooseOne(title, items) {
      titles.push(title); const choices = await items;
      if (Array.isArray(choices)) { assert.ok(choices.find(choice => choice.value === 'codex').selected); return 'claude'; }
      assert.equal(choices.selectEffort, true);
      assert.ok(choices.choices.find(choice => choice.value === 'sonnet').efforts.includes('high'));
      return { value: 'sonnet', effort: 'high' };
    } };
  const selected = await setup(ui, options);
  assert.equal(selected.id, 'claude'); assert.equal(config().defaultProvider, 'claude');
  assert.deepEqual(titles, ['Choose provider', 'Choose model · claude']);
  assert.equal(defaultSelection().model, 'sonnet'); assert.equal(defaultSelection().effort, 'high');
  assert.equal(options.provider, 'claude'); assert.equal(options.model, 'sonnet'); assert.equal(options.effort, 'high');
  assert.deepEqual(options.launchDefault, defaultSelection());
  assert.equal(sessions().length, 0, 'setup selects models without creating a conversation');
  assert.equal(prompts, 1); assert.throws(() => apiKey(BUILTINS.deepseek), /No API key/);
  assert.match(seen.join('\n'), /Codex \/ ChatGPT.*Validated/); assert.match(seen.join('\n'), /Claude.*Validated/);
  assert.doesNotMatch(seen.join('\n'), /fixture-only-never-a-real-token/);
  const calls = fs.readFileSync(process.env.BZZY_TEST_AUTH_CALLS, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(calls.every(call => call.args.includes('status')), 'detected subscriptions never launch sign-in');
});

test('interactive setup saves an optional DeepSeek key privately and reuses it on later setup', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ data: [{ id: 'deepseek-flash' }] })));
  let prompts = 0;
  const ui = { interactive: true, event() {}, async secret() { prompts++; return 'fixture-deepseek-key'; },
    async chooseOne(_title, items) { const choices = await items; return Array.isArray(choices) ? 'deepseek' : choices.choices[0].value; } };
  await setup(ui, {});
  assert.equal(config().defaultProvider, 'deepseek'); assert.equal(apiKey(BUILTINS.deepseek), 'fixture-deepseek-key');
  assert.equal(fs.statSync(path.join(process.env.BZZY_HOME, 'credentials.json')).mode & 0o777, 0o600);
  assert.doesNotMatch(fs.readFileSync(path.join(process.env.BZZY_HOME, 'config.json'), 'utf8'), /fixture-deepseek-key/);
  await setup(ui, {}); assert.equal(prompts, 1);
});

test('setup never labels API logins as validated subscriptions and rejects malformed optional keys', async () => {
  writeJson(path.join(process.env.CODEX_HOME, 'auth.json'), { auth_mode: 'apikey' });
  const seen = [];
  const ui = { interactive: true, event(_type, data) { seen.push(data.message); }, async secret() { return ''; }, async chooseOne(_title, choices) {
    choices = await choices;
    if (!Array.isArray(choices)) return choices.choices[0].value;
    assert.ok(choices.find(choice => choice.value === 'claude').selected); return 'claude';
  } };
  await setup(ui, {});
  assert.match(seen.join('\n'), /Codex \/ ChatGPT.*Not signed in/); assert.match(seen.join('\n'), /Claude.*Validated/);
  ui.secret = async () => 'invalid key';
  await assert.rejects(setup(ui, {}), /whitespace/);
  assert.throws(() => apiKey(BUILTINS.deepseek), /No API key/);
});

test('cancelling setup at provider or model selection preserves the saved default', async () => {
  const original = { version: 1, providers: {}, defaultProvider: 'codex', defaultSelection: { provider: 'codex', model: 'previous-model', effort: 'high' } };
  saveConfig(original);
  const ui = { interactive: true, event() {}, async secret() { return ''; }, async chooseOne() { return null; } };
  await assert.rejects(setup(ui, {}), /Setup cancelled/);
  assert.deepEqual(config(), original);
  ui.chooseOne = async (_title, choices) => Array.isArray(await choices) ? 'claude' : null;
  await assert.rejects(setup(ui, {}), /Setup cancelled/);
  assert.deepEqual(config(), original);
});

const ptyAvailable = process.platform === 'linux' && spawnSync('script', ['--version'], { stdio: 'ignore' }).status === 0;
for (const { key, chat = false } of [{ key: '' }, { key: 'fixture-pty-deepseek-key' }, { key: '', chat: true }]) {
  const title = chat ? 'first-run chat keeps the selected model and effort'
    : `setup terminal validates subscriptions and ${key ? 'saves a hidden DeepSeek key' : 'skips DeepSeek on Enter'}`;
  test(title, { skip: !ptyAvailable, timeout: 15000 }, async () => {
    const server = http.createServer((_request, response) => {
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ data: [{ id: 'deepseek-flash' }] }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    saveConfig({ version: 1, defaultProvider: null, providers: { deepseek: { ...BUILTINS.deepseek, baseUrl: `http://127.0.0.1:${server.address().port}` } } });
    const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
    const command = [process.execPath, path.join(root, 'bin/bzzy.js'), ...(chat ? [] : ['setup']), '--no-pet'];
    const child = spawn('script', ['-qefc', command.map(quote).join(' '), '/dev/null'], { cwd: dir, env: { ...process.env, TERM: 'xterm-256color' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    const done = new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
    async function until(check) {
      for (let attempt = 0; attempt < 300; attempt++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
      throw new Error('Setup prompt did not appear: ' + stderr + stdout.slice(-2000));
    }
    try {
      await until(() => /DeepSeek API key.*optional/.test(stdout));
      assert.match(stdout, /Codex \/ ChatGPT.*Validated/); assert.match(stdout, /Claude.*Validated/);
      child.stdin.write(key + '\r');
      await until(() => stdout.includes('Choose provider'));
      child.stdin.write((chat ? '' : key ? '\x1b[B\x1b[B' : '\x1b[B') + '\r');
      const provider = chat ? 'codex' : key ? 'deepseek' : 'claude';
      await until(() => stdout.includes(`Choose model · ${provider}`) && stdout.includes(chat ? 'Brain model' : key ? 'deepseek-flash' : 'Sonnet'));
      const afterModel = stdout.length;
      child.stdin.write(chat ? '\x1b[B\x1b[C\x1b[C\r' : '\r');
      if (chat) {
        await until(() => stdout.slice(afterModel).includes('What should BZZY work on?'));
        child.stdin.write('/exit\r');
      }
      assert.equal(await done, 0, stderr);
      if (chat) {
        const [session] = sessions();
        assert.equal(session.provider, 'codex'); assert.equal(session.model, 'fixture-brain'); assert.equal(session.selectedEffort, 'high');
        assert.deepEqual(session.modelCapabilities, defaultSelection().capabilities);
      }
      assert.equal(config().defaultProvider, provider);
      assert.equal(defaultSelection().model, chat ? 'fixture-brain' : key ? 'deepseek-flash' : null);
      if (key) { assert.equal(apiKey(BUILTINS.deepseek), key); assert.ok(!stdout.includes(key)); }
      else assert.throws(() => apiKey(BUILTINS.deepseek), /No API key/);
    } finally {
      if (child.exitCode == null) child.kill('SIGTERM'); await done.catch(() => {});
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    }
  });
}
