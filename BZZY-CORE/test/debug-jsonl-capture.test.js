import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { captureDebugJsonl } from '../src/engine/debug-jsonl-capture.js';
import { diagnosticRedactor } from '../src/engine/diagnostic-redaction.js';

let directory, source, destination;
test.beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-debug-jsonl-'));
  source = path.join(directory, 'source.jsonl'); destination = path.join(directory, 'capture.jsonl');
});
test.afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));
const hash = data => createHash('sha256').update(data).digest('hex');
const redactor = secrets => diagnosticRedactor({ secrets, maxString: Infinity, maxItems: Infinity, maxDepth: Infinity, maxFields: Infinity });

test('large logical JSONL values cross read boundaries without leaking split credentials or private envelopes', () => {
  const secret = 'synthetic_ledger_binding_1234567890';
  const input = Buffer.from([
    JSON.stringify({ text: 'x'.repeat(65513) + secret + '終'.repeat(50000), email: 'private@example.test' }),
    JSON.stringify({ text: 'Visible before <analysis>private reasoning\ncontinued</analysis> after', nested: { token: 'PRIVATE_FIELD' } }),
    JSON.stringify({ text: 'password = "MULTILINE\nBINDING"\nVisible tail' }),
    JSON.stringify({ type: 'thinking', text: 'PRIVATE_ENVELOPE' }), '',
    JSON.stringify({ final: 'LAST_RECORD_WITHOUT_NEWLINE' }),
  ].join('\r\n'));
  fs.writeFileSync(source, input);
  const progress = [], { scrub } = redactor([secret]); let validated = false;
  const result = captureDebugJsonl(source, destination, { scrub, secrets: [secret],
    validateSource: () => { validated = true; }, onProgress: value => progress.push(value) });
  const output = fs.readFileSync(destination), text = output.toString();
  assert.equal(validated, true); assert.ok(progress.length > 2);
  for (const privateValue of [secret, 'PRIVATE_FIELD', 'PRIVATE_ENVELOPE', 'private reasoning', 'MULTILINE', 'BINDING', 'private@example.test'])
    assert.ok(!text.includes(privateValue), privateValue);
  const rows = text.split('\n').filter(Boolean).map(JSON.parse);
  assert.match(rows[0].text, /\[redacted\]/); assert.ok(rows[0].text.endsWith('終'.repeat(50000)));
  assert.match(rows[1].text, /Visible before .* after/); assert.match(rows[2].text, /Visible tail/);
  assert.deepEqual(rows[3], { omitted: 'private-reasoning' });
  assert.equal(rows[4].final, 'LAST_RECORD_WITHOUT_NEWLINE'); assert.ok(!text.endsWith('\n'));
  assert.equal(result.bytes, output.length); assert.equal(result.sourceBytes, input.length);
  assert.equal(result.sha256, hash(output)); assert.equal(result.sourceSha256, hash(input));
  assert.equal(result.redacted, true); assert.equal(fs.statSync(destination).mode & 0o777, 0o600);
});

test('a known binding spanning JSONL records is rejected before publication', () => {
  const secret = 'first-part"}\n{"text":"second-part';
  fs.writeFileSync(source, '{"text":"first-part"}\n{"text":"second-part"}\n');
  assert.throws(() => captureDebugJsonl(source, destination, { ...redactor([secret]), secrets: [secret] }), /credential/);
  assert.equal(fs.existsSync(destination), false);
});

test('oversized records, malformed structured data and invalid UTF-8 never leave a partial capture', () => {
  for (const [data, options, check] of [
    ['{"text":"' + 'a'.repeat(100) + '"}\n', { maxRecordBytes: 64 }, error => error.code === 'SESSION_DEBUG_SOURCE_SIZE'],
    ['{"valid":true}\n{broken}', {}, error => error instanceof SyntaxError],
    [Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125]), {}, /unparseable_structured_data/],
  ]) {
    fs.writeFileSync(source, data);
    assert.throws(() => captureDebugJsonl(source, destination, { ...redactor([]), ...options }), check);
    assert.equal(fs.existsSync(destination), false);
  }
});

test('changed sources and links are rejected while existing destinations are preserved', () => {
  fs.writeFileSync(source, '{"safe":"value"}\n');
  let changed = false;
  assert.throws(() => captureDebugJsonl(source, destination, { ...redactor([]), onProgress: () => {
    if (!changed) { changed = true; fs.appendFileSync(source, '{"late":true}\n'); }
  } }), /changed_or_unreadable_source/);
  assert.equal(fs.existsSync(destination), false);
  const link = path.join(directory, 'link.jsonl'); fs.symlinkSync(source, link);
  assert.throws(() => captureDebugJsonl(link, destination, redactor([])), /changed_or_unreadable_source/);
  fs.writeFileSync(destination, 'KEEP_EXISTING');
  assert.throws(() => captureDebugJsonl(source, destination, redactor([])), error => error.code === 'EEXIST');
  assert.equal(fs.readFileSync(destination, 'utf8'), 'KEEP_EXISTING');
});

test('destination write failures retain their disk error and clean up partially written output', t => {
  fs.writeFileSync(source, '{"safe":"value"}\n');
  t.mock.method(fs, 'writeSync', () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); });
  assert.throws(() => captureDebugJsonl(source, destination, redactor([])), error => error.code === 'ENOSPC');
  assert.equal(fs.existsSync(destination), false);
});

test('capture pins its source length instead of following a continuously growing ledger', () => {
  fs.writeFileSync(source, '{"initial":true}\n');
  let reads = 0;
  assert.throws(() => captureDebugJsonl(source, destination, { ...redactor([]), onProgress: () => {
    reads++;
    // A finite guard keeps a regression from hanging the test itself.
    if (reads <= 10) fs.appendFileSync(source, '{"late":true}\n');
  } }), /changed_or_unreadable_source/);
  assert.equal(reads, 1); assert.equal(fs.existsSync(destination), false);
});
