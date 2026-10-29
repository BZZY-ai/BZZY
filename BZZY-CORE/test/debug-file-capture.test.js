import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { captureDebugFile } from '../src/engine/debug-file-capture.js';

let directory, source, destination;
test.beforeEach(() => {
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-debug-file-')));
  source = path.join(directory, 'source'); destination = path.join(directory, 'captured');
});
test.afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));
const hash = data => createHash('sha256').update(data).digest('hex');
const capture = options => captureDebugFile(source, destination, { sourceRoot: directory, ...options });
const cleanScratch = () => assert.ok(!fs.readdirSync(directory).some(name => name.startsWith('.file-capture-')));

test('disk capture preserves binary bytes and source/export hashes without echoing source paths', async () => {
  const input = Buffer.concat([Buffer.from([0, 255, 137, 80, 78, 71]), Buffer.alloc(2 * 1024 * 1024, 1)]);
  fs.writeFileSync(source, input);
  const updates = [], result = await capture({ onProgress: value => updates.push(value) });
  assert.equal(result.encoding, 'binary'); assert.equal(result.sourceBytes, input.length); assert.equal(result.bytes, input.length);
  assert.equal(result.sourceSha256, hash(input)); assert.equal(result.sha256, hash(input)); assert.equal(result.redacted, false);
  assert.deepEqual(fs.readFileSync(destination), input); assert.equal(fs.statSync(destination).mode & 0o777, 0o600);
  assert.ok(updates.length > 0); assert.ok(updates.every(value => Object.keys(value).join() === 'inspectedBytes' && Number.isSafeInteger(value.inspectedBytes)));
  cleanScratch();
});

test('text redaction handles credentials, multiline bindings and reasoning across disk read boundaries', async () => {
  const secret = 'synthetic_disk_capture_secret_123456789';
  const input = 'x'.repeat(1024 * 1024 - 10) + secret + '\npassword="PRIVATE_FIRST\n' + 'z'.repeat(1024 * 1024) + 'PRIVATE_LAST"\n' +
    '<analysis>' + 'z'.repeat(1024 * 1024) + 'PRIVATE_REASONING</analysis>\n' +
    'Authorization: Bearer PRIVATE_HEADER\nACCESS_TOKEN="PRIVATE_ENV"\n--password=PRIVATE_FLAG\n' +
    'Cookie: first=PRIVATE_COOKIE, second=PRIVATE_COOKIE_TWO\n' +
    'password\u00a0=\u00a0PRIVATE_UNICODE_SPACE\n' +
    '-----BEGIN PRIVATE KEY-----\nPRIVATE_PEM\n-----END PRIVATE KEY-----\n' +
    'https://user:PRIVATE_URL@example.test/path\n' + directory + '/safe-path\nSAFE_END';
  fs.writeFileSync(source, input);
  const result = await capture({ secrets: [secret], roots: [directory] }), output = fs.readFileSync(destination, 'utf8');
  assert.equal(result.encoding, 'utf8'); assert.equal(result.sourceSha256, hash(input)); assert.equal(result.sha256, hash(output));
  for (const value of [secret, 'PRIVATE_FIRST', 'PRIVATE_LAST', 'PRIVATE_REASONING', 'PRIVATE_HEADER', 'PRIVATE_ENV', 'PRIVATE_FLAG',
    'PRIVATE_COOKIE', 'PRIVATE_UNICODE_SPACE', 'PRIVATE_PEM', 'PRIVATE_URL', directory]) assert.ok(!output.includes(value), value);
  assert.match(output, /\[omitted: private-reasoning\]/); assert.match(output, /\[project\]\/safe-path/); assert.ok(output.endsWith('SAFE_END'));
  cleanScratch();
});

test('JSON projection redacts fields, escaped bindings and reasoning regardless of object field order', async () => {
  const input = {
    safe: 'RETAIN_ME', token: 'Bearer PRIVATE_AUTH then PRIVATE_TAIL', nested: { API_KEY: 'PRIVATE_KEY' },
    headers: [{ value: 'PRIVATE_COOKIE', name: 'Cookie' }, { name: 'Accept', value: 'application/json' }],
    envelope: { text: 'PRIVATE_REASONING', type: 'analysis' },
    trailingField: { 'password\u2029': 'PRIVATE_TRAILING_FIELD' },
    trailingHeader: { value: 'PRIVATE_TRAILING_HEADER', name: 'Cookie\r\n' },
    trailingEnvelope: { text: 'PRIVATE_TRAILING_REASONING', type: 'thinking\u2028' },
    notes: [{ type: 'note', text: 'Readable note' }],
    privateAddress: 'private@example.test',
  };
  fs.writeFileSync(source, JSON.stringify(input).replace('"token"', '"to\\u006ben"'));
  const result = await capture({ name: 'capture.har' }), text = fs.readFileSync(destination, 'utf8'), value = JSON.parse(text);
  for (const secret of ['PRIVATE_AUTH', 'PRIVATE_TAIL', 'PRIVATE_KEY', 'PRIVATE_COOKIE', 'PRIVATE_REASONING',
    'PRIVATE_TRAILING_FIELD', 'PRIVATE_TRAILING_HEADER', 'PRIVATE_TRAILING_REASONING', 'private@example.test']) assert.ok(!text.includes(secret), secret);
  assert.equal(value.safe, input.safe); assert.equal(value.token, '[redacted]'); assert.equal(value.nested.API_KEY, '[redacted]');
  assert.equal(value.headers[0].value, '[redacted]'); assert.deepEqual(value.headers[1], input.headers[1]);
  assert.deepEqual(value.envelope, { omitted: 'private-reasoning' }); assert.deepEqual(value.notes, input.notes);
  assert.equal(result.redacted, true); cleanScratch();
});

test('large JSON strings decode escaped credentials before scrubbing and stay valid JSON', async () => {
  const secret = 'synthetic_escaped_binding_1234567890';
  const text = 'x'.repeat(400000) + secret + '\n' + '<reasoning>PRIVATE_HUGE_REASONING</reasoning>\n' + '終'.repeat(100000) + '\ud800';
  fs.writeFileSync(source, JSON.stringify({ safe: 'SAFE', body: text }).replace(secret, '\\u0073' + secret.slice(1)));
  const result = await capture({ name: 'large.json', secrets: [secret] });
  assert.equal(result.redacted, true);
  const value = JSON.parse(fs.readFileSync(destination, 'utf8'));
  assert.ok(!value.body.includes(secret)); assert.ok(!value.body.includes('PRIVATE_HUGE_REASONING'));
  assert.ok(value.body.startsWith('x'.repeat(400000))); assert.ok(value.body.endsWith('終'.repeat(100000) + '\ud800')); assert.equal(value.safe, 'SAFE');
  cleanScratch();
});

test('JSONL preserves records and duplicate private headers never expose earlier values', async () => {
  fs.writeFileSync(source, '{"value":"PRIVATE_FIRST","name":"Cookie","value":"Bearer PRIVATE_SECOND then PRIVATE_TAIL"}\n\n{"note":"SAFE"}\n');
  const result = await capture({ name: 'ledger.jsonl' }), output = fs.readFileSync(destination, 'utf8');
  assert.equal(result.encoding, 'jsonl'); assert.doesNotMatch(output, /PRIVATE_/);
  assert.deepEqual(output.split('\n').filter(Boolean).map(JSON.parse), [{ value: '[redacted]', name: 'Cookie' }, { note: 'SAFE' }]); cleanScratch();
});

test('the final scan rejects a known binding spanning JSONL record boundaries', async () => {
  fs.writeFileSync(source, '{"text":"first-part"}\n{"text":"second-part"}\n');
  assert.deepEqual(await capture({ name: 'ledger.jsonl', secrets: ['first-part"}\n{"text":"second-part'] }), { omitted: 'credential_content' });
  assert.equal(fs.existsSync(destination), false); cleanScratch();
});

test('malformed structured sources, opaque containers and credential-bearing binaries are explicit omissions', async () => {
  for (const [input, options, expected] of [
    ['{"safe":true,"token":', { name: 'bad.json' }, 'unparseable_structured_data'],
    ['{"safe":true,}', { name: 'bad.json' }, 'unparseable_structured_data'],
    ['[true,]', { name: 'bad.json' }, 'unparseable_structured_data'],
    [Buffer.from([80, 75, 3, 4, 0, 0]), {}, 'opaque_archive_or_database'],
    [Buffer.from('\0Cookie: PRIVATE_BINARY'), {}, 'credential_in_binary'],
    [Buffer.from([0, ...Buffer.from('password'), 160, 61, 160, ...Buffer.from('PRIVATE_BINARY_NBSP')]), {}, 'credential_in_binary'],
  ]) {
    fs.writeFileSync(source, input);
    assert.deepEqual(await capture(options), { omitted: expected }); assert.equal(fs.existsSync(destination), false); cleanScratch();
  }
  fs.writeFileSync(source, '[ordinary text, not JSON]\nSAFE_END');
  assert.equal((await capture({ name: 'notes.txt' })).encoding, 'utf8'); assert.match(fs.readFileSync(destination, 'utf8'), /SAFE_END/);
});

test('source changes, symlinks and outside-root paths cannot publish uninspected content', async () => {
  fs.writeFileSync(source, 'SAFE_SOURCE');
  let changed = false;
  const result = await capture({ onProgress: () => { if (!changed) { changed = true; fs.appendFileSync(source, 'LATE'); } } });
  // The snapshot may already be sealed before the first progress delivery. It
  // must either reject the changed source or preserve exactly the sealed bytes.
  if (result.omitted) assert.equal(result.omitted, 'changed_or_unreadable_source');
  else { assert.equal(result.sourceSha256, hash('SAFE_SOURCE')); assert.equal(fs.readFileSync(destination, 'utf8'), 'SAFE_SOURCE'); fs.unlinkSync(destination); }
  fs.unlinkSync(source); fs.symlinkSync(path.join(directory, 'private-missing'), source);
  assert.equal((await capture()).omitted, 'changed_or_unreadable_source');
  assert.equal((await capture({ sourceRoot: path.join(directory, 'other') })).omitted, 'outside_capture_root');
  assert.equal(fs.existsSync(destination), false); cleanScratch();
});

test('existing outputs and Python failures remain safe errors and private scratch is removed', async () => {
  fs.writeFileSync(source, 'SAFE'); fs.writeFileSync(destination, 'KEEP');
  await assert.rejects(capture(), error => error.code === 'EEXIST'); assert.equal(fs.readFileSync(destination, 'utf8'), 'KEEP'); cleanScratch();
  const previous = process.env.PATH;
  try { process.env.PATH = path.join(directory, 'private-password=DO_NOT_ECHO'); await assert.rejects(capture(), error => error.code === 'SESSION_DEBUG_PYTHON' && !error.message.includes('DO_NOT_ECHO')); }
  finally { process.env.PATH = previous; }
  cleanScratch();
});

test('project Python modules and startup hooks cannot execute during diagnostic capture', async () => {
  const previous = process.env.PYTHONPATH, marker = path.join(directory, 'SHOULD_NEVER_EXECUTE');
  const modules = path.join(directory, 'modules'); fs.mkdirSync(modules);
  fs.writeFileSync(path.join(modules, 'sitecustomize.py'), `open(${JSON.stringify(marker)}, 'w').write('executed')\n`);
  fs.writeFileSync(source, 'SAFE');
  try {
    process.env.PYTHONPATH = modules;
    assert.equal((await capture()).sourceSha256, hash('SAFE'));
    assert.equal(fs.existsSync(marker), false);
  } finally { if (previous === undefined) delete process.env.PYTHONPATH; else process.env.PYTHONPATH = previous; }
  cleanScratch();
});
