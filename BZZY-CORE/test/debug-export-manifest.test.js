import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDebugManifestLog } from '../src/engine/debug-export-manifest.js';

test('manifest arrays are spooled privately and composed without changing the public shape', async t => {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-manifest-'));
  t.after(() => fs.rmSync(stage, { recursive: true, force: true }));
  const log = createDebugManifestLog(stage);
  t.after(() => log.close());
  for (let i = 0; i < 10000; i++) log.append('inventory', { path: `workspace/file-${i}.txt`, bytes: i });
  log.append('exclusions', { path: 'workspace/private\nname', reason: 'private_path' });
  assert.equal(log.count('inventory'), 10000);
  assert.ok(log.bytes > 400000);
  const sidecars = fs.readdirSync(stage);
  assert.equal(sidecars.length, 2);
  for (const name of sidecars) assert.equal(fs.statSync(path.join(stage, name)).mode & 0o777, 0o600);
  let bytes = 0;
  await log.write(path.join(stage, 'manifest.json'), { format: 'bzzy-full-session-debug', version: 1 }, size => { bytes += size; });
  const saved = JSON.parse(fs.readFileSync(path.join(stage, 'manifest.json'), 'utf8'));
  assert.equal(saved.inventory.length, 10000);
  assert.deepEqual(saved.inventory.at(-1), { path: 'workspace/file-9999.txt', bytes: 9999 });
  assert.deepEqual(saved.exclusions, [{ path: 'workspace/private\nname', reason: 'private_path' }]);
  assert.equal(fs.statSync(path.join(stage, 'manifest.json')).size, bytes);
  assert.deepEqual(fs.readdirSync(stage), ['manifest.json']);
});

test('an empty capture writes valid empty arrays and closes on failure', async t => {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-manifest-empty-'));
  t.after(() => fs.rmSync(stage, { recursive: true, force: true }));
  const log = createDebugManifestLog(stage);
  t.after(() => log.close());
  await log.write(path.join(stage, 'manifest.json'), { version: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(stage, 'manifest.json'), 'utf8')), { version: 1, inventory: [], exclusions: [] });
  await assert.rejects(log.write(path.join(stage, 'failed.json'), { version: 1 }, () => { throw new Error('disk full'); }), /disk full/);
  log.close();
});

test('an unavailable inventory fails manifest composition instead of publishing missing entries', async t => {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-manifest-missing-'));
  t.after(() => fs.rmSync(stage, { recursive: true, force: true }));
  const log = createDebugManifestLog(stage);
  t.after(() => log.close());
  log.append('inventory', { path: 'workspace/saved.txt', bytes: 123 });
  log.close();
  fs.unlinkSync(path.join(stage, '.manifest-inventory.jsonl'));
  await assert.rejects(log.write(path.join(stage, 'manifest.json'), { version: 1 }), error => error.code === 'ENOENT');
});
