import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { getGmailSettings, setGmailSettings, clearGmailSettings, readGmail, checkGmailConnection } from '../src/engine/gmail-account.js';
import { writeJson } from '../src/engine/files.js';
import { lockFile } from '../src/engine/store.js';
import { saveKey, removeKey, apiKey, credentialStatus, getProvider } from '../src/engine/providers.js';
import { retireTelegram } from '../src/engine/migrations.js';
import { sharedSecrets } from '../src/engine/share-bundle-policy.js';

const address = 'mailbox@example.invalid', secret = 'abcdefghijklmnop';
const aliases = ['fixture+1@example.invalid', 'fixture+2@example.invalid'];
const helperPath = fileURLToPath(new URL('../src/engine/gmail-imap.py', import.meta.url));
let directory, vault, previousEnvironment;
test.beforeEach(() => {
  previousEnvironment = { ...process.env };
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-gmail-account-')));
  process.env.BZZY_HOME = path.join(directory, 'private');
  vault = path.join(process.env.BZZY_HOME, 'credentials.json');
});
test.afterEach(() => {
  for (const key of Object.keys(process.env)) if (!Object.hasOwn(previousEnvironment, key)) delete process.env[key];
  Object.assign(process.env, previousEnvironment);
  fs.rmSync(directory, { recursive: true, force: true });
});
const save = () => setGmailSettings({ address, appPassword: 'abcd efgh ijkl mnop' }, { expectedRevision: 0 });
const envelope = result => ({ stdout: JSON.stringify({ ok: true, result }) });
const headers = (overrides = {}) => ({ uid: '7', from: 'Sender <sender@example.invalid>', to: aliases[0], subject: 'A fixture message', date: 'Tue, 27 Oct 2026 12:00:00 +0000', messageId: '<fixture@example.invalid>', ...overrides });
const base = { folder: 'INBOX', uidValidity: '42', readOnly: true };
const listed = (overrides = {}) => ({ ...base, messages: [headers()], ...overrides });
const read = (overrides = {}) => ({ ...base, ...headers(), body: 'A fixture message body.', bodyTruncated: false,
  links: [{ text: 'Fixture link', url: 'https://example.invalid/fixture' }], attachments: [{ filename: 'fixture.txt', contentType: 'text/plain' }], ...overrides });
const listInput = { operation: 'list' }, readInput = { operation: 'read', uid: '7', uidValidity: '42' };
const readVault = () => JSON.parse(fs.readFileSync(vault, 'utf8'));
function safeFailure(code, forbidden = []) { return error => error.code === code && forbidden.every(value => !JSON.stringify(error).includes(value) && !error.message.includes(value)); }

test('local owner settings preserve provider entries and return metadata without connecting or disclosing the password', () => {
  assert.deepEqual(getGmailSettings(), { configured: false, address: '', revision: 0 });
  const providers = { deepseek: 'fixture-provider-secret-1234', custom: 'another-provider-secret-1234' };
  writeJson(vault, providers);
  process.env.PATH = '/fixture/no-python-or-network';
  assert.deepEqual(save(), { configured: true, address, revision: 1 });
  assert.deepEqual(getGmailSettings(), { configured: true, address, revision: 1 });
  assert.equal(fs.statSync(vault).mode & 0o777, 0o600);
  assert.equal(fs.statSync(vault).nlink, 1);
  const saved = readVault();
  assert.deepEqual(saved, { ...providers, __gmail__: { version: 1, address, appPassword: secret, enabled: true, revision: 1 } });
  assert.ok(sharedSecrets().includes(secret));
  assert.ok(!JSON.stringify(getGmailSettings()).includes(secret));
  const returned = getGmailSettings(); returned.address = 'changed@example.invalid';
  assert.equal(getGmailSettings().address, address);
});

test('save and clear compare revisions and retain a monotonic credential-free tombstone', () => {
  save();
  assert.throws(() => setGmailSettings({ address, appPassword: secret }, { expectedRevision: 0 }), { code: 'GMAIL_SETTINGS_STALE' });
  assert.throws(() => clearGmailSettings({ expectedRevision: 0 }), { code: 'GMAIL_SETTINGS_STALE' });
  assert.deepEqual(clearGmailSettings({ expectedRevision: 1 }), { configured: false, address: '', revision: 2 });
  assert.deepEqual(readVault().__gmail__, { version: 1, address: '', enabled: false, revision: 2 });
  assert.ok(!fs.readFileSync(vault, 'utf8').includes(secret));
  assert.equal(setGmailSettings({ address, appPassword: secret }, { expectedRevision: 2 }).revision, 3);
  assert.equal(clearGmailSettings({ expectedRevision: 3 }).revision, 4);
  assert.equal(clearGmailSettings({ expectedRevision: 4 }).revision, 5);
});

test('provider reads never echo a malformed shared vault and environment keys retain their safe short circuit', () => {
  save(); delete process.env.DEEPSEEK_API_KEY; const provider = getProvider('deepseek');
  for (const damaged of [`{"__gmail__":{"appPassword":"${secret}",`, '[]', 'null',
    JSON.stringify({ deepseek: { appPassword: secret } }), JSON.stringify({ deepseek: null }), JSON.stringify({ deepseek: 123 })]) {
    fs.writeFileSync(vault, damaged);
    for (const action of [() => credentialStatus('deepseek'), () => apiKey(provider)]) {
      assert.throws(action, safeFailure('CREDENTIALS_UNAVAILABLE', [secret, directory, 'appPassword', 'Unexpected', '.trim']));
      assert.equal(fs.readFileSync(vault, 'utf8'), damaged);
    }
    process.env.DEEPSEEK_API_KEY = 'fixture-environment-provider-key';
    assert.equal(apiKey(provider), 'fixture-environment-provider-key');
    delete process.env.DEEPSEEK_API_KEY;
  }
});

test('all credential writers use the same process lock and provider writes cannot resurrect a revoked Gmail binding', { timeout: 15_000 }, async () => {
  save(); saveKey('deepseek', 'fixture-provider-before');
  const childEnvironment = { BZZY_HOME: process.env.BZZY_HOME, HOME: directory, PATH: process.env.PATH || '', ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}) };
  const providerModule = new URL('../src/engine/providers.js', import.meta.url).href;
  const operation = `import { saveKey, removeKey } from ${JSON.stringify(providerModule)};
    try { if (process.argv[1] === 'save') saveKey('deepseek', 'fixture-provider-after'); else removeKey('deepseek'); process.stdout.write('DONE\\n'); }
    catch (error) { process.stdout.write(JSON.stringify({ code: error.code }) + '\\n'); process.exitCode = 2; }`;
  const unlock = lockFile(`${vault}.lock`);
  try {
    for (const action of ['save', 'remove']) {
      const blocked = spawnSync(process.execPath, ['--input-type=module', '-e', operation, action], { env: childEnvironment, encoding: 'utf8', timeout: 5000 });
      assert.equal(blocked.status, 2); assert.equal(blocked.stderr, ''); assert.deepEqual(JSON.parse(blocked.stdout), { code: 'CONFLICT' });
    }
    const original = readVault(); original.telegramBotToken = 'fixture-legacy-token'; writeJson(vault, original);
    await assert.rejects(retireTelegram(), safeFailure('CREDENTIALS_UNAVAILABLE', [directory, secret]));
    assert.equal(readVault().__gmail__.revision, 1);
  } finally { unlock(); }
  await retireTelegram(); assert.equal(readVault().telegramBotToken, undefined);
  for (const action of ['save', 'remove']) {
    setGmailSettings({ address, appPassword: secret }); saveKey('deepseek', 'fixture-provider-before');
    // Pause a real second process after it reads the vault, exercising the
    // exact read/modify/write interval that formerly allowed resurrection.
    const pause = `import fs from 'node:fs'; import path from 'node:path';
      import { saveKey, removeKey } from ${JSON.stringify(providerModule)};
      const originalRead = fs.readFileSync;
      fs.readFileSync = function(file, ...args) {
        const value = originalRead.call(this, file, ...args);
        if (file === path.join(process.env.BZZY_HOME, 'credentials.json')) {
          process.stdout.write('READ\\n'); fs.readSync(0, Buffer.alloc(1), 0, 1, null);
        }
        return value;
      };
      try { if (process.argv[1] === 'save') saveKey('deepseek', 'fixture-provider-after'); else removeKey('deepseek'); process.stdout.write('DONE\\n'); }
      catch (error) { process.stdout.write(JSON.stringify({ code: error.code }) + '\\n'); process.exitCode = 2; }`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', pause, action], { env: childEnvironment, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', stderr = '', ready;
    const readStarted = new Promise(resolve => { ready = resolve; });
    child.stdout.on('data', data => { output += data.toString(); if (output.includes('READ\n')) ready(); });
    child.stderr.on('data', data => { stderr += data.toString(); });
    const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => { ready(); resolve(code); }); });
    try {
      await readStarted; assert.match(output, /^READ\n/);
      assert.throws(clearGmailSettings, safeFailure('GMAIL_SETTINGS_INVALID', [directory, secret]));
      child.stdin.end('1'); assert.equal(await exited, 0); assert.equal(stderr, ''); assert.equal(output, 'READ\nDONE\n');
      const cleared = clearGmailSettings(); assert.equal(cleared.configured, false);
      const tombstone = readVault().__gmail__;
      saveKey('deepseek', 'fixture-provider-after-clear'); removeKey('deepseek');
      assert.deepEqual(readVault().__gmail__, tombstone); assert.equal(getGmailSettings().configured, false);
      assert.ok(!fs.readFileSync(vault, 'utf8').includes(secret));
    } finally { child.stdin.end(); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
  }
});

test('invalid settings and malformed vaults fail safely without overwriting other credentials', () => {
  save(); const before = fs.readFileSync(vault, 'utf8');
  for (const input of [null, [], {}, { address }, { address: 'Display Name <mailbox@example.invalid>', appPassword: secret },
    { address: 'bad..local@example.invalid', appPassword: secret }, { address, appPassword: '' }, { address, appPassword: '   ' },
    { address, appPassword: 'contains\tcontrol' }, { address, appPassword: 'é'.repeat(16) }, { address, appPassword: 'x'.repeat(129) },
    { address, appPassword: secret, host: 'imap.example.invalid' }]) {
    assert.throws(() => setGmailSettings(input), { code: 'GMAIL_SETTINGS_INVALID' });
    assert.equal(fs.readFileSync(vault, 'utf8'), before);
  }
  for (const options of [null, [], { password: secret }, { expectedRevision: -1 }, { expectedRevision: '1' }]) {
    const code = options?.expectedRevision !== undefined && !Object.hasOwn(options, 'password') ? 'GMAIL_SETTINGS_STALE' : 'GMAIL_SETTINGS_INVALID';
    assert.throws(() => clearGmailSettings(options), { code });
    assert.equal(fs.readFileSync(vault, 'utf8'), before);
  }
  const record = readVault().__gmail__;
  for (const damaged of ['{"password":"never-echo-damaged-vault",', '[]', 'null', JSON.stringify({ __gmail__: null }),
    ...[{ version: 2 }, { revision: 0 }, { revision: 1.5 }, { enabled: 'yes' }, { address: '' }, { appPassword: 'not canonical spaces' },
      { privatePath: '/never/echo/this/path' }].map(change => JSON.stringify({ __gmail__: { ...record, ...change } }))]) {
    fs.writeFileSync(vault, damaged);
    for (const action of [getGmailSettings, () => setGmailSettings({ address, appPassword: secret }), clearGmailSettings]) {
      assert.throws(action, safeFailure('GMAIL_SETTINGS_INVALID', ['never-echo-damaged-vault', '/never/echo/this/path', directory, secret]));
      assert.equal(fs.readFileSync(vault, 'utf8'), damaged);
    }
  }
});

test('vaults must be private regular owner files with one link and no symlink', () => {
  save();
  fs.chmodSync(vault, 0o644);
  assert.throws(getGmailSettings, { code: 'GMAIL_SETTINGS_INVALID' });
  assert.throws(() => setGmailSettings({ address, appPassword: secret }), { code: 'GMAIL_SETTINGS_INVALID' });
  fs.chmodSync(vault, 0o600);
  const hardlink = path.join(directory, 'another-link'); fs.linkSync(vault, hardlink);
  assert.throws(getGmailSettings, { code: 'GMAIL_SETTINGS_INVALID' });
  assert.throws(clearGmailSettings, { code: 'GMAIL_SETTINGS_INVALID' });
  fs.unlinkSync(hardlink);
  const original = path.join(directory, 'original'); fs.renameSync(vault, original); fs.symlinkSync(original, vault);
  assert.throws(getGmailSettings, { code: 'GMAIL_SETTINGS_INVALID' });
  assert.throws(clearGmailSettings, { code: 'GMAIL_SETTINGS_INVALID' });
  fs.unlinkSync(vault); fs.mkdirSync(vault);
  assert.throws(getGmailSettings, { code: 'GMAIL_SETTINGS_INVALID' });
});

test('the fixed private helper receives credentials only on stdin with isolated cwd, environment and resource bounds', async () => {
  save();
  writeJson(path.join(process.env.BZZY_HOME, 'config.json'), { providers: { custom: { envKey: 'CUSTOM_CREDENTIAL' } }, executionEnvironment: { allow: ['VISIBLE_PUBLIC'] } });
  Object.assign(process.env, { OPENAI_API_KEY: 'fixture-openai-secret', CUSTOM_CREDENTIAL: 'fixture-custom-secret',
    GMAIL_APP_PASSWORD: 'fixture-env-mail-secret', PYTHONPATH: '/fixture/import-hook', PYTHONSTARTUP: '/fixture/startup-hook',
    NODE_OPTIONS: '--fixture-hook', VISIBLE_PUBLIC: 'fixture-public-configuration' });
  let calls = 0;
  const result = await readGmail({ operation: 'list', last: 25, search: 'to:fixture@example.invalid' }, { recipientAliases: aliases, run: async (executable, args, options) => {
    calls++;
    assert.equal(executable, 'python3'); assert.deepEqual(args, ['-I', '-B', helperPath]);
    assert.ok(path.isAbsolute(args[2]));
    assert.equal(options.cwd, path.join(process.env.BZZY_HOME, 'runtime', 'gmail'));
    assert.notEqual(options.cwd, process.cwd()); assert.equal(fs.statSync(options.cwd).mode & 0o777, 0o700);
    assert.equal(options.timeout, 30_000); assert.equal(options.maxBuffer, 512 * 1024); assert.ok(options.signal instanceof AbortSignal);
    for (const key of ['OPENAI_API_KEY', 'CUSTOM_CREDENTIAL', 'GMAIL_APP_PASSWORD', 'PYTHONPATH', 'PYTHONSTARTUP', 'NODE_OPTIONS', 'VISIBLE_PUBLIC']) assert.equal(options.env[key], undefined);
    const invocation = JSON.stringify({ executable, args, cwd: options.cwd, env: options.env });
    for (const value of [secret, address, 'fixture-openai-secret', 'fixture-custom-secret', 'fixture-env-mail-secret']) assert.ok(!invocation.includes(value));
    assert.deepEqual(JSON.parse(options.input), { operation: 'list', folder: 'INBOX', last: 25, search: 'to:fixture@example.invalid', address, appPassword: secret, recipientAliases: aliases });
    return envelope(listed());
  } });
  assert.equal(calls, 1); assert.deepEqual(result, listed());
  const files = fs.readdirSync(path.join(process.env.BZZY_HOME, 'runtime', 'gmail')); assert.deepEqual(files, []);
});

test('read and connection check project only the supported bounded data', async () => {
  save();
  assert.deepEqual(await readGmail(readInput, { run: async (_executable, _args, options) => {
    assert.deepEqual(JSON.parse(options.input), { ...readInput, folder: 'INBOX', maxChars: 12000, address, appPassword: secret });
    return envelope(read());
  } }), read());
  assert.deepEqual(await checkGmailConnection({ run: async (_executable, _args, options) => {
    assert.deepEqual(JSON.parse(options.input), { operation: 'check', folder: 'INBOX', address, appPassword: secret });
    return envelope(base);
  } }), base);
  const scrubbed = await readGmail(readInput, { run: async () => envelope(read({ body: `A returned fixture ${secret} is withheld.` })) });
  assert.equal(scrubbed.body, 'A returned fixture [REDACTED] is withheld.');
  const unicode = read({ body: '😀'.repeat(12000), subject: '😀'.repeat(2048) });
  assert.deepEqual(await readGmail(readInput, { run: async () => envelope(unicode) }), unicode);
});

test('private helper working directories cannot follow workspace symlinks and missing Python fails without private paths', async () => {
  save(); const workspace = path.join(directory, 'project'); fs.mkdirSync(workspace);
  const runtime = path.join(process.env.BZZY_HOME, 'runtime'); fs.symlinkSync(workspace, runtime);
  let calls = 0;
  await assert.rejects(readGmail(listInput, { run: async () => { calls++; return envelope(listed()); } }), { code: 'GMAIL_SETTINGS_INVALID' });
  assert.equal(calls, 0); assert.deepEqual(fs.readdirSync(workspace), []);
  fs.unlinkSync(runtime); process.env.PATH = path.join(directory, 'no-executable');
  await assert.rejects(readGmail(listInput), safeFailure('GMAIL_HELPER_UNAVAILABLE', [secret, address, directory, helperPath]));
});

test('model input cannot supply credentials, recipient scope, destinations, executables or write operations', async () => {
  save(); let calls = 0; const options = { run: async () => { calls++; return envelope(listed()); } };
  for (const input of [null, [], {}, { operation: 'check' }, { operation: 'send' }, { operation: 'delete', uid: '7' },
    ...['address', 'appPassword', 'password', 'credentials', 'host', 'port', 'path', 'script', 'executable', 'env', 'recipientAliases', 'signal', 'run']
      .map(key => ({ ...listInput, [key]: key === 'recipientAliases' ? aliases : 'private-or-override-fixture' })),
    { ...listInput, uid: '7' }, { ...readInput, last: 2 }, { ...listInput, last: 0 }, { ...listInput, last: 26 },
    { ...listInput, last: true }, { ...listInput, search: 'x'.repeat(1001) }, { ...listInput, search: 'newline\nquery' },
    { ...listInput, folder: '' }, { ...listInput, folder: 'INBOX\r\nLOGOUT' }, { ...listInput, folder: 'x'.repeat(241) },
    { ...readInput, uid: 7 }, { ...readInput, uid: '0' }, { ...readInput, uid: '4294967296' },
    { ...readInput, uidValidity: undefined }, { ...readInput, maxChars: 0 }, { ...readInput, maxChars: 16001 }]) {
    await assert.rejects(readGmail(input, options), { code: 'GMAIL_INVALID_REQUEST' });
  }
  for (const internal of [{ ...options, host: 'elsewhere' }, { ...options, signal: {} }, { run: 'python3' },
    { ...options, recipientAliases: ['not-an-address'] }, { ...options, recipientAliases: [aliases[0], aliases[0]] }]) {
    await assert.rejects(readGmail(listInput, internal), { code: 'GMAIL_INVALID_REQUEST' });
  }
  assert.equal(calls, 0);
});

test('disabled, missing and revoked bindings cannot start a request', async () => {
  let calls = 0; const run = async () => { calls++; return envelope(listed()); };
  await assert.rejects(readGmail(listInput, { run }), { code: 'GMAIL_NOT_CONFIGURED' });
  save(); const saved = readVault(); saved.__gmail__.enabled = false; writeJson(vault, saved);
  assert.deepEqual(getGmailSettings(), { configured: false, address: '', revision: 1 });
  await assert.rejects(readGmail(listInput, { run }), { code: 'GMAIL_NOT_CONFIGURED' });
  setGmailSettings({ address, appPassword: secret }, { expectedRevision: 1 });
  const pending = readGmail(listInput, { run });
  clearGmailSettings({ expectedRevision: 2 });
  await assert.rejects(pending, { code: 'GMAIL_ACCOUNT_CHANGED' });
  assert.equal(calls, 0);
});

test('results are withheld when authorization is revoked, disabled or replaced during fetch', async () => {
  for (const change of [() => clearGmailSettings(), () => setGmailSettings({ address, appPassword: 'differentfixture' }),
    () => { const value = readVault(); value.__gmail__.enabled = false; writeJson(vault, value); }]) {
    setGmailSettings({ address, appPassword: secret });
    await assert.rejects(readGmail(listInput, { run: async () => { change(); return envelope(listed()); } }), { code: 'GMAIL_ACCOUNT_CHANGED' });
  }
});

test('helper errors and malformed results expose only fixed enum messages', async () => {
  save();
  for (const code of ['INVALID_REQUEST', 'AUTH_FAILED', 'FOLDER_UNAVAILABLE', 'UIDVALIDITY_CHANGED', 'MESSAGE_NOT_FOUND',
    'MESSAGE_TOO_LARGE', 'RECIPIENT_NOT_ALLOWED', 'CONNECTION_FAILED', 'TIMEOUT', 'PROTOCOL_ERROR', 'RESPONSE_TOO_LARGE']) {
    await assert.rejects(readGmail(listInput, { run: async () => ({ stdout: JSON.stringify({ ok: false, error: { code, message: `${secret} ${directory} raw-server-response` } }) }) }),
      safeFailure(`GMAIL_${code}`, [secret, directory, 'raw-server-response']));
  }
  for (const output of [{ stdout: '{"private":"never-echo-helper-fragment",' }, { stdout: JSON.stringify({ ok: false, error: { code: secret, message: secret } }) },
    envelope(listed({ appPassword: secret })), envelope(listed({ readOnly: false })), envelope(listed({ folder: 'Other' })), envelope(listed({ uidValidity: 42 })),
    envelope(listed({ messages: [headers({ uid: '0' })] })), envelope(listed({ messages: [headers(), headers()] })),
    envelope({}), { stdout: JSON.stringify({ ok: true, result: listed(), stderr: secret }) }]) {
    await assert.rejects(readGmail(listInput, { run: async () => output }), safeFailure('GMAIL_PROTOCOL_ERROR', [secret, directory, 'never-echo-helper-fragment']));
  }
  for (const result of [read({ uid: '8' }), read({ uidValidity: '43' }), read({ body: 'x'.repeat(12001) }), read({ links: [{ text: 'unsafe', url: 'file:///private' }] }),
    read({ attachments: [{ filename: 'fixture.txt', contentType: 'text/plain', data: secret }] })]) {
    await assert.rejects(readGmail(readInput, { run: async () => envelope(result) }), { code: 'GMAIL_PROTOCOL_ERROR' });
  }
  await assert.rejects(readGmail(listInput, { run: async () => ({ stdout: 'x'.repeat(512 * 1024 + 1) }) }), { code: 'GMAIL_RESPONSE_TOO_LARGE' });
  for (const error of [new Error(`${secret} ${directory}`), Object.assign(new Error(secret), { code: 'ENOENT' }), Object.assign(new Error(secret), { code: 'AUTH_FAILED' })]) {
    await assert.rejects(readGmail(listInput, { run: async () => { throw error; } }), safeFailure('GMAIL_CONNECTION_FAILED', [secret, directory]));
  }
});

test('cancellation is bounded even when a fake helper ignores the signal and no abort reason escapes', async () => {
  save();
  const before = new AbortController(); before.abort(new Error(secret)); let calls = 0;
  await assert.rejects(readGmail(listInput, { signal: before.signal, run: async () => { calls++; return envelope(listed()); } }), safeFailure('GMAIL_CANCELLED', [secret]));
  assert.equal(calls, 0);
  const controller = new AbortController();
  const result = readGmail(listInput, { signal: controller.signal, run: async (_executable, _args, options) => {
    calls++; assert.ok(!options.signal.aborted);
    controller.abort(new Error(`${secret} ${directory}`));
    return new Promise(() => {});
  } });
  await assert.rejects(result, safeFailure('GMAIL_CANCELLED', [secret, directory]));
  assert.equal(calls, 1);
});
