import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { root, backendCommand } from '../src/process.js';

test('fresh installation and repeated installation launch bzzy without invoking package managers or backends', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-install-'));
  try {
    const checkout = path.join(temporary, 'checkout'), guards = path.join(temporary, 'guards'), bin = path.join(temporary, 'bin');
    fs.mkdirSync(checkout); fs.mkdirSync(guards); fs.mkdirSync(bin);
    for (const directory of ['src', 'bin', 'assets']) fs.cpSync(path.join(root, directory), path.join(checkout, directory), { recursive: true });
    fs.mkdirSync(path.join(checkout, 'scripts'));
    for (const file of ['install.sh', 'package.json', 'package-lock.json', 'scripts/install-launcher.mjs']) fs.copyFileSync(path.join(root, file), path.join(checkout, file));
    for (const name of ['npm', 'codex', 'claude']) fs.writeFileSync(path.join(guards, name), '#!/bin/sh\nprintf invoked >> "$BZZY_INSTALL_GUARD"\nexit 97\n', { mode: 0o755 });
    const marker = path.join(checkout, 'node_modules', 'existing-installation');
    fs.mkdirSync(path.dirname(marker)); fs.writeFileSync(marker, 'Leave existing packages intact');
    const log = path.join(temporary, 'forbidden-command.log');
    const env = { ...process.env, PATH: [bin, guards, path.dirname(process.execPath), process.env.PATH].join(path.delimiter),
      BZZY_BIN_DIR: bin, BZZY_NO_PATH_UPDATE: '1', BZZY_INSTALL_GUARD: log, BZZY_HOME: path.join(temporary, 'private') };
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = spawnSync('bash', ['install.sh'], { cwd: checkout, env, encoding: 'utf8', timeout: 15000 });
      assert.equal(result.status, 0, result.stderr + result.stdout);
      assert.match(result.stdout, /bzzy is installed\. Run: bzzy/);
      assert.doesNotMatch(result.stdout + result.stderr, /codex|claude|added \d+ packages|npm/i);
      assert.equal(fs.existsSync(log), false, 'installation must not execute npm or either backend');
      assert.equal(fs.readFileSync(marker, 'utf8'), 'Leave existing packages intact');
      const launch = spawnSync(path.join(bin, 'bzzy'), ['--version'], { env, encoding: 'utf8', timeout: 15000 });
      assert.equal(launch.status, 0, launch.stderr); assert.match(launch.stdout, /^bzzy 0\.2\.0\s*$/);
    }
    const lock = JSON.parse(fs.readFileSync(path.join(checkout, 'package-lock.json'), 'utf8'));
    assert.deepEqual(Object.keys(lock.packages), ['']);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

test('backend discovery uses explicit selection first, then existing PATH installations', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-existing-backend-'));
  const previousPath = process.env.PATH, previousOverride = process.env.BZZY_CODEX_BIN;
  try {
    const existing = path.join(temporary, 'codex'); fs.writeFileSync(existing, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    delete process.env.BZZY_CODEX_BIN; process.env.PATH = temporary;
    assert.equal(backendCommand('codex'), existing);
    process.env.BZZY_CODEX_BIN = path.join(temporary, 'selected-codex');
    assert.equal(backendCommand('codex'), process.env.BZZY_CODEX_BIN);
  } finally {
    process.env.PATH = previousPath;
    if (previousOverride == null) delete process.env.BZZY_CODEX_BIN; else process.env.BZZY_CODEX_BIN = previousOverride;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
