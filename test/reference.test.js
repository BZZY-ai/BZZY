import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { root, CODEX_VERSION, assertCodexVersion } from '../src/process.js';

test('the preserved goal policy remains based on Codex 0.162.0', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const ref = path.join(root, 'references', 'codex-0.162.0');
  const manifest = JSON.parse(fs.readFileSync(path.join(ref, 'manifest.json'), 'utf8'));
  assert.equal(CODEX_VERSION, '0.162.0');
  assert.equal(pkg.dependencies, undefined, 'bzzy must not install backend packages');
  assert.equal(manifest.commit, 'c1382380de69521303b416720a52f42d51af6248');
  for (const [name, hash] of Object.entries(manifest.sha256)) {
    const source = fs.readFileSync(path.join(ref, name));
    assert.equal(createHash('sha256').update(source).digest('hex'), hash, name);
  }
  const original = fs.readFileSync(path.join(ref, 'codex-rs/ext/goal/templates/goals/continuation.md'), 'utf8');
  const adapted = fs.readFileSync(path.join(root, 'assets/goal-continuation.md'), 'utf8');
  assert.ok(adapted.startsWith(original.replaceAll('update_goal', 'mcp__bzzy_goal__update_goal')));
});

test('compatible newer Codex releases are accepted without changing the goal reference', () => {
  for (const version of ['0.162.0', '0.162.2', '0.163.0', '0.163.0-alpha.1', '0.200.0', '1.0.0']) assert.doesNotThrow(() => assertCodexVersion('codex-cli ' + version));
  for (const version of ['codex-cli 0.161.9', 'codex-cli 0.100.0', 'unknown version']) assert.throws(() => assertCodexVersion(version), /0.162.0 or newer/);
});
