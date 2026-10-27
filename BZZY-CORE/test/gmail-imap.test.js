import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('../src/engine/gmail-imap.py', import.meta.url));
const fixtures = fileURLToPath(new URL('./gmail-imap-fixture.py', import.meta.url));

test('the stdlib Gmail adapter enforces read-only, credential, MIME and transport bounds offline', () => {
  const result = spawnSync('python3', ['-I', '-B', fixtures], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('malformed and oversized stdin emit one fixed JSON error and no diagnostic stream', () => {
  for (const input of ['{not-json', '{}\n{}', '{"operation":"check","operation":"read"}', '{"operation":NaN}',
    'x'.repeat(128 * 1024 + 1), JSON.stringify({ operation: 'check', appPassword: 'never-echo-fixture-password' })]) {
    const result = spawnSync('python3', ['-I', '-B', helper], { input, encoding: 'utf8', timeout: 5_000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), { ok: false, error: { code: 'INVALID_REQUEST', message: 'The Gmail request is invalid.' } });
    assert.ok(!result.stdout.includes('never-echo-fixture-password'));
  }
});
