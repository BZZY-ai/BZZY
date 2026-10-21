import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from '../src/cli.js';

const updater = new URL('../src/update.js', import.meta.url).href;

function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-update-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const remote = path.join(temporary, 'remote.git'), author = path.join(temporary, 'author');
  const checkout = path.join(temporary, "installed bzzy's checkout");
  const log = path.join(temporary, 'install.log');
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Update test', GIT_AUTHOR_EMAIL: 'update@example.test',
    GIT_COMMITTER_NAME: 'Update test', GIT_COMMITTER_EMAIL: 'update@example.test',
    BZZY_UPDATE_TEST_LOG: log, BZZY_LAUNCHER_BIN_DIR: path.join(temporary, 'custom bin') };
  delete env.BZZY_BIN_DIR;
  function git(cwd, ...args) {
    const result = spawnSync('git', args, { cwd, env, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  git(temporary, 'init', '--bare', '--initial-branch=main', remote);
  git(temporary, 'clone', remote, author);
  fs.writeFileSync(path.join(author, 'install.sh'), '#!/bin/sh\nprintf "%s\\n%s\\n" "$PWD" "$BZZY_BIN_DIR" >> "$BZZY_UPDATE_TEST_LOG"\n');
  fs.writeFileSync(path.join(author, 'version.txt'), 'old');
  git(author, 'add', '.'); git(author, 'commit', '-m', 'Initial installation'); git(author, 'push', 'origin', 'main');
  git(temporary, 'clone', remote, checkout);
  function publish(contents = 'new') {
    fs.writeFileSync(path.join(author, 'version.txt'), contents);
    git(author, 'add', '.'); git(author, 'commit', '-m', 'Update installation'); git(author, 'push', 'origin', 'main');
  }
  function update(directory = checkout) {
    return spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { updateInstallation } from ${JSON.stringify(updater)}; try { process.exitCode = updateInstallation(process.argv[1]); } catch (error) { console.error(error.message); process.exitCode = 1; }`, directory],
    { cwd: temporary, env, encoding: 'utf8', timeout: 15000 });
  }
  return { temporary, checkout, author, log, env, git, publish, update };
}

test('--update parses and cannot accidentally launch a task', () => {
  assert.equal(parseArgs(['--update']).options.update, true);
  const result = spawnSync(process.execPath, [new URL('../bin/bzzy.js', import.meta.url).pathname, '--update', '--goal', 'task'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--update by itself/);
});

test('updates the installation from another directory, preserves the launcher path, and can run again', t => {
  const f = fixture(t); f.publish();
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = f.update();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /bzzy is up to date/);
    assert.equal(fs.readFileSync(path.join(f.checkout, 'version.txt'), 'utf8'), 'new');
    assert.equal(f.git(f.checkout, 'status', '--porcelain'), '');
  }
  assert.deepEqual(fs.readFileSync(f.log, 'utf8').trim().split('\n'),
    [f.checkout, f.env.BZZY_LAUNCHER_BIN_DIR, f.checkout, f.env.BZZY_LAUNCHER_BIN_DIR]);
});

for (const untracked of [false, true]) test(`preserves ${untracked ? 'untracked' : 'tracked'} local edits without pulling or installing`, t => {
  const f = fixture(t); f.publish();
  const file = path.join(f.checkout, untracked ? 'local.txt' : 'version.txt');
  fs.writeFileSync(file, 'local changes');
  const before = f.git(f.checkout, 'rev-parse', 'HEAD'), result = f.update();
  assert.equal(result.status, 1); assert.match(result.stderr, /uncommitted changes/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'local changes');
  assert.equal(f.git(f.checkout, 'rev-parse', 'HEAD'), before);
  assert.equal(fs.existsSync(f.log), false);
});

test('refuses divergent history without merging, resetting, or running the installer', t => {
  const f = fixture(t); f.publish();
  fs.writeFileSync(path.join(f.checkout, 'local.txt'), 'committed local changes');
  f.git(f.checkout, 'add', '.'); f.git(f.checkout, 'commit', '-m', 'Local commit');
  const before = f.git(f.checkout, 'rev-parse', 'HEAD'), result = f.update();
  assert.equal(result.status, 1); assert.match(result.stderr, /Update failed/);
  assert.equal(f.git(f.checkout, 'rev-parse', 'HEAD'), before);
  assert.equal(f.git(f.checkout, 'status', '--porcelain'), '');
  assert.equal(fs.existsSync(f.log), false);
});

test('rejects detached checkouts, missing upstreams, and non-checkout installations', t => {
  const f = fixture(t);
  f.git(f.checkout, 'checkout', '--detach');
  assert.match(f.update().stderr, /detached checkout/);
  f.git(f.checkout, 'checkout', 'main'); f.git(f.checkout, 'branch', '--unset-upstream');
  assert.match(f.update().stderr, /No upstream branch/);
  assert.match(f.update(f.temporary).stderr, /requires a Git checkout/);
  const nested = path.join(f.checkout, 'nested'); fs.mkdirSync(nested);
  assert.match(f.update(nested).stderr, /its own Git checkout/);
  assert.equal(fs.existsSync(f.log), false);
});

test('reports installer failure with a retry command after downloading the update', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.author, 'install.sh'), '#!/bin/sh\nexit 23\n');
  f.publish();
  const result = f.update();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Latest source downloaded, but installation failed \(exit 23\)/);
  assert.match(result.stderr, /Run \.\/install.sh/);
  assert.equal(fs.readFileSync(path.join(f.checkout, 'version.txt'), 'utf8'), 'new');
  assert.doesNotMatch(result.stdout, /bzzy is up to date/);
});
