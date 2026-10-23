import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { root, CODEX_VERSION, assertCodexVersion } from '../src/process.js';
import { root as coreRoot } from '@bzzy/core/engine/process.js';

test('the preserved goal policy remains based on Codex 0.162.0', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const ref = path.join(root, 'references', 'codex-0.162.0');
  const manifest = JSON.parse(fs.readFileSync(path.join(ref, 'manifest.json'), 'utf8'));
  assert.equal(CODEX_VERSION, '0.162.0');
  assert.deepEqual(pkg.dependencies, { '@bzzy/core': 'file:../../BZZY-CORE' }, 'the terminal depends only on Core, never provider backend packages');
  assert.equal(manifest.commit, 'c1382380de69521303b416720a52f42d51af6248');
  for (const [name, hash] of Object.entries(manifest.sha256)) {
    const source = fs.readFileSync(path.join(ref, name));
    assert.equal(createHash('sha256').update(source).digest('hex'), hash, name);
  }
  const original = fs.readFileSync(path.join(ref, 'codex-rs/ext/goal/templates/goals/continuation.md'), 'utf8');
  const adapted = fs.readFileSync(path.join(coreRoot, 'assets/goal-continuation.md'), 'utf8');
  // Preserve the upstream audit while adapting its pause instruction to bzzy's
  // report-only tool schema; the host, rather than that tool, owns pausing.
  const expected = original.replaceAll('update_goal', 'mcp__bzzy_goal__update_goal').replace(
    'Call mcp__bzzy_goal__update_goal only after the completion or blocked audit passes, or when the user explicitly requests pausing this goal. For a requested pause, use status "paused", report the returned status, and stop goal work; never pause on your own initiative.',
    'Call mcp__bzzy_goal__update_goal only after the completion or blocked audit passes. If the user requests a pause, stop work and tell them to use /pause; the host handles pausing and cancellation. The report tool accepts only complete or blocked.',
  );
  assert.ok(adapted.startsWith(expected));
});

test('compatible newer Codex releases are accepted without changing the goal reference', () => {
  for (const version of ['0.162.0', '0.162.2', '0.163.0', '0.163.0-alpha.1', '0.200.0', '1.0.0']) assert.doesNotThrow(() => assertCodexVersion('codex-cli ' + version));
  for (const version of ['codex-cli 0.161.9', 'codex-cli 0.100.0', 'unknown version']) assert.throws(() => assertCodexVersion(version), /0.162.0 or newer/);
});
