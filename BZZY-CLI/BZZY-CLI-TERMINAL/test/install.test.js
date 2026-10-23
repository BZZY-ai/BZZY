import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { root, backendCommand } from '../src/process.js';

function copyBundledCore(checkout) {
  const source = fs.realpathSync(path.join(root, 'node_modules/@bzzy/core'));
  const target = path.join(checkout, 'node_modules/@bzzy/core');
  const pkg = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
  fs.mkdirSync(target, { recursive: true });
  for (const entry of ['package.json', ...pkg.files, 'node_modules']) {
    const file = path.join(source, entry);
    if (fs.existsSync(file)) fs.cpSync(file, path.join(target, entry), { recursive: true, dereference: true,
      filter: name => !name.split(path.sep).some(part => part.startsWith('._')) });
  }
  fs.chmodSync(path.join(target, 'bin', 'bzzy-core.js'), 0o755);
}

test('bundled fresh and repeated installation launch bzzy without invoking package managers or backends', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-install-'));
  try {
    const checkout = path.join(temporary, 'checkout'), guards = path.join(temporary, 'guards'), bin = path.join(temporary, 'bin'), userHome = path.join(temporary, 'user');
    fs.mkdirSync(checkout); fs.mkdirSync(guards); fs.mkdirSync(bin); fs.mkdirSync(userHome, { mode: 0o700 });
    for (const directory of ['src', 'bin', 'assets']) fs.cpSync(path.join(root, directory), path.join(checkout, directory), { recursive: true });
    copyBundledCore(checkout);
    fs.mkdirSync(path.join(checkout, 'scripts'));
    for (const file of ['install.sh', 'package.json', 'package-lock.json', 'scripts/install-launcher.mjs']) fs.copyFileSync(path.join(root, file), path.join(checkout, file));
    for (const name of ['npm', 'codex', 'claude']) fs.writeFileSync(path.join(guards, name), '#!/bin/sh\nprintf invoked >> "$BZZY_INSTALL_GUARD"\nexit 97\n', { mode: 0o755 });
    const marker = path.join(checkout, 'node_modules', 'existing-installation');
    fs.mkdirSync(path.dirname(marker), { recursive: true }); fs.writeFileSync(marker, 'Leave existing packages intact');
    const log = path.join(temporary, 'forbidden-command.log');
    const env = { ...process.env, PATH: [bin, guards, path.dirname(process.execPath), process.env.PATH].join(path.delimiter),
      HOME: userHome, BZZY_BIN_DIR: bin, BZZY_NO_PATH_UPDATE: '1', BZZY_INSTALL_GUARD: log, BZZY_HOME: path.join(temporary, 'private') };
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = spawnSync('bash', ['install.sh'], { cwd: checkout, env, encoding: 'utf8', timeout: 15000 });
      assert.equal(result.status, 0, result.stderr + result.stdout);
      assert.match(result.stdout, /bzzy is installed\. Run: bzzy/);
      assert.doesNotMatch(result.stdout + result.stderr, /codex|claude|added \d+ packages|npm/i);
      assert.equal(fs.existsSync(log), false, 'installation must not execute npm or either backend');
      assert.equal(fs.readFileSync(marker, 'utf8'), 'Leave existing packages intact');
      const launch = spawnSync(path.join(bin, 'bzzy'), ['--version'], { env, encoding: 'utf8', timeout: 15000 });
      assert.equal(launch.status, 0, launch.stderr); assert.match(launch.stdout, /^bzzy 0\.2\.0\s*$/);
      const coreLaunch = spawnSync(path.join(bin, 'bzzy-core'), ['help'], { env, encoding: 'utf8', timeout: 15000 });
      assert.equal(coreLaunch.status, 0, coreLaunch.stderr); assert.match(coreLaunch.stdout, /Usage: bzzy-core/);
      const doctor = spawnSync(path.join(bin, 'bzzy-core'), ['doctor'], { env, encoding: 'utf8', timeout: 15000 });
      assert.equal(doctor.status, 0, doctor.stderr + doctor.stdout); assert.equal(JSON.parse(doctor.stdout).checks.python.ready, true);
      const servicePlan = spawnSync(path.join(bin, 'bzzy-core'), ['service', 'install', '--dry-run'], { env, encoding: 'utf8', timeout: 15000 });
      assert.equal(servicePlan.status, 0, servicePlan.stderr);
      const planned = JSON.parse(servicePlan.stdout); assert.equal(planned.dryRun, true); assert.equal(planned.secretsIncluded, false);
      assert.equal(planned.entry, fs.realpathSync(path.join(checkout, 'node_modules/@bzzy/core/bin/bzzy-core.js')));
      assert.ok(planned.file.startsWith(fs.realpathSync(userHome) + path.sep), 'prepared service belongs only to the isolated test home');
      assert.equal(fs.existsSync(planned.file), true, 'default installation prepares the user manifest without loading it');
      if (process.platform === 'darwin') assert.match(fs.readFileSync(planned.file, 'utf8'), /<key>Disabled<\/key><true\/>/);
      const stopped = spawnSync(path.join(bin, 'bzzy-core'), ['status'], { env, encoding: 'utf8', timeout: 15000 });
      assert.equal(stopped.status, 0); assert.match(stopped.stdout, /"running":false/);
      assert.equal(JSON.parse(stopped.stdout).service.installed, true);
      assert.equal(fs.existsSync(path.join(env.BZZY_HOME, 'runtime', 'listener.json')), false, 'help must not start the daemon');
    }
    const lock = JSON.parse(fs.readFileSync(path.join(checkout, 'package-lock.json'), 'utf8'));
    assert.equal(lock.packages[''].dependencies['@bzzy/core'], 'file:../../BZZY-CORE');
    assert.equal(lock.packages['node_modules/@bzzy/core'].link, true);
    assert.deepEqual(lock.packages[''].bundleDependencies, ['@bzzy/core']);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

test('workspace installation refreshes locked Core dependencies without invoking backends', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-workspace-install-'));
  try {
    const checkout = path.join(temporary, 'BZZY-CLI', 'BZZY-CLI-TERMINAL'), core = path.join(temporary, 'BZZY-CORE');
    const guards = path.join(temporary, 'guards'), bin = path.join(temporary, 'bin');
    fs.mkdirSync(checkout, { recursive: true }); fs.mkdirSync(core); fs.mkdirSync(guards); fs.mkdirSync(bin);
    const userHome = path.join(temporary, 'user'); fs.mkdirSync(userHome, { mode: 0o700 });
    fs.writeFileSync(path.join(core, 'package.json'), '{"name":"@bzzy/core"}');
    for (const directory of ['src', 'bin', 'assets']) fs.cpSync(path.join(root, directory), path.join(checkout, directory), { recursive: true });
    copyBundledCore(checkout);
    fs.mkdirSync(path.join(checkout, 'scripts'));
    for (const file of ['install.sh', 'package.json', 'package-lock.json', 'scripts/install-launcher.mjs']) fs.copyFileSync(path.join(root, file), path.join(checkout, file));
    const log = path.join(temporary, 'npm.log');
    // The installer puts the selected Node directory first. Keep the npm guard
    // there too, including when the real Node installation also ships npm.
    fs.symlinkSync(process.execPath, path.join(guards, 'node'));
    fs.writeFileSync(path.join(guards, 'npm'), '#!/bin/sh\nprintf "%s\\n" "$PWD" "$@" >> "$BZZY_INSTALL_NPM_LOG"\n', { mode: 0o755 });
    for (const name of ['codex', 'claude']) fs.writeFileSync(path.join(guards, name), '#!/bin/sh\nexit 97\n', { mode: 0o755 });
    const env = { ...process.env, PATH: [guards, path.dirname(process.execPath), process.env.PATH].join(path.delimiter),
      HOME: userHome, BZZY_BIN_DIR: bin, BZZY_NO_PATH_UPDATE: '1', BZZY_INSTALL_NPM_LOG: log, BZZY_HOME: path.join(temporary, 'private') };
    const result = spawnSync('bash', ['install.sh'], { cwd: checkout, env, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const args = links => ['ci', '--ignore-scripts', `--install-links=${links}`, '--no-audit', '--no-fund'];
    assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), [fs.realpathSync(core), ...args(true), fs.realpathSync(checkout), ...args(false)]);
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

test('installer reports missing Python before changing launchers or invoking package managers', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-python-prerequisite-'));
  try {
    const guards = path.join(temporary, 'guards'), bin = path.join(temporary, 'bin'); fs.mkdirSync(guards);
    fs.writeFileSync(path.join(guards, 'python3'), '#!/bin/sh\nexit 98\n', { mode: 0o755 });
    const result = spawnSync('/bin/bash', [path.join(root, 'install.sh')], { env: { ...process.env,
      PATH: [guards, path.dirname(process.execPath), process.env.PATH].join(path.delimiter), BZZY_BIN_DIR: bin }, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 1); assert.match(result.stderr, /Python 3\.9\+/);
    assert.equal(fs.existsSync(bin), false);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});
