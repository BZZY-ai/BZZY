import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assignmentTaskSource, maskAssignmentTaskText, sanitizedTaskPreview } from '../src/engine/assignment-task.js';

let directory, previousHome, previousKey;
test.beforeEach(() => {
  previousHome = process.env.BZZY_HOME; previousKey = process.env.BZZY_TASK_TEST_API_KEY;
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-assignment-task-'));
  process.env.BZZY_HOME = directory;
});
test.afterEach(() => {
  if (previousHome === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previousHome;
  if (previousKey === undefined) delete process.env.BZZY_TASK_TEST_API_KEY; else process.env.BZZY_TASK_TEST_API_KEY = previousKey;
  fs.rmSync(directory, { recursive: true, force: true });
});

test('task previews mask complete known credentials and private aliases before their byte boundary', () => {
  const secret = 'CREDENTIAL_SEGMENT_'.repeat(10);
  process.env.BZZY_TASK_TEST_API_KEY = secret;
  for (const privateValue of [secret, 'private-owner+verification@forwarding.example', 'private/owner=case?verification^1@forwarding.example']) {
    const original = 'Check https://target.example/search: ' + 'a'.repeat(540) + privateValue + ' and retain evidence.';
    const preview = sanitizedTaskPreview(original);
    assert.ok(Buffer.byteLength(preview) <= 600);
    assert.ok(preview.includes('https://target.example/search'));
    assert.ok(preview.includes('[redacted]'));
    assert.ok(!preview.includes(privateValue.slice(0, 15)));
    assert.ok(!preview.includes('forwarding.example'));
  }
});

test('task previews mask quoted multiline and plain credential assignments without folding them into partial secrets', () => {
  const original = `Verify https://target.example/register using password="first private line\nsecond private line"; api_key=another-private-value; then report.\nMailbox alias private+2@forwarding.example`;
  const preview = sanitizedTaskPreview(original);
  for (const privateValue of ['first private', 'second private', 'another-private', 'private+2', 'forwarding.example']) assert.ok(!preview.includes(privateValue));
  assert.match(preview, /https:\/\/target\.example\/register/);
  assert.ok(!preview.includes('\n'));
});

test('task sources have stable immutable hashes while current credentials change redacted exposure', () => {
  const secret = 'rotating_known_credential_123456', original = `Inspect the offline case with ${secret}.`;
  delete process.env.BZZY_TASK_TEST_API_KEY;
  const before = assignmentTaskSource(original);
  process.env.BZZY_TASK_TEST_API_KEY = secret;
  assert.deepEqual(assignmentTaskSource(original), before);
  assert.ok(!sanitizedTaskPreview(original).includes(secret));
  const masked = maskAssignmentTaskText(original);
  assert.equal([...masked.text].length, [...original].length);
});

test('task previews keep UTF-8 boundaries, remove controls and omit oversized original values', () => {
  const preview = sanitizedTaskPreview('Check 🧪 https://target.example/a\x1b[31m\x00 ' + '𝄞'.repeat(500));
  assert.ok(Buffer.byteLength(preview) <= 600);
  assert.ok(!preview.includes('\ufffd')); assert.ok(!/[\x00-\x1f\x7f-\x9f]/u.test(preview));
  const oversized = 'a'.repeat(128 * 1024 + 1);
  assert.deepEqual(assignmentTaskSource(oversized), { omitted: 'over_128_kib' });
  assert.match(sanitizedTaskPreview(oversized), /omitted/);
  assert.equal(sanitizedTaskPreview({ objective: 'private object' }), undefined);
  assert.equal(sanitizedTaskPreview('   '), undefined);
});
