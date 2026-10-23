import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { updateRepository, checkPackagedUpdate, updatePackagedInstallation } from '../src/packaged-update.js';
import { lockFile } from '@bzzy/core/engine/store.js';

function fixture(t, { failInstall = false, running = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-package-update-'));
  const bin = path.join(root, 'bin'), previousBin = process.env.BZZY_BIN_DIR, previousHome = process.env.BZZY_HOME;
  process.env.BZZY_BIN_DIR = bin; process.env.BZZY_HOME = path.join(root, 'private'); fs.mkdirSync(bin);
  t.after(() => {
    if (previousBin == null) delete process.env.BZZY_BIN_DIR; else process.env.BZZY_BIN_DIR = previousBin;
    if (previousHome == null) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const env = { ...process.env, GIT_AUTHOR_NAME: 'BZZY fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'BZZY fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' };
  const remote = path.join(root, 'remote.git'), author = path.join(root, 'author'), directory = path.join(root, 'old-package'), releaseRoot = path.join(root, 'releases');
  const git = (cwd, ...args) => { const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
  git(root, 'init', '--bare', '--initial-branch=main', remote); git(root, 'clone', remote, author);
  const cli = path.join(author, 'BZZY-CLI/BZZY-CLI-TERMINAL'); fs.mkdirSync(cli, { recursive: true });
  for (const product of ['BZZY-CORE', 'BZZY-RELAY']) { fs.mkdirSync(path.join(author, product)); fs.writeFileSync(path.join(author, product, 'package.json'), '{}'); }
  fs.writeFileSync(path.join(cli, 'install.sh'), '#!/bin/sh\nmkdir -p "$BZZY_BIN_DIR"\nprintf "# bzzy-managed launcher\\nnew revision\\n" > "$BZZY_BIN_DIR/bzzy"\n' + (failInstall ? 'exit 23\n' : 'exit 0\n'));
  fs.writeFileSync(path.join(author, 'version.txt'), 'checked'); git(author, 'add', '.'); git(author, 'commit', '-m', 'Checked release'); git(author, 'push', 'origin', 'main');
  const checked = git(author, 'rev-parse', 'HEAD');
  fs.mkdirSync(path.join(directory, 'bin'), { recursive: true }); fs.mkdirSync(path.join(directory, 'node_modules/@bzzy/core'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'package.json'), '{"name":"bzzy-cli"}'); fs.writeFileSync(path.join(directory, 'bin/bzzy.js'), '// old package'); fs.writeFileSync(path.join(directory, 'node_modules/@bzzy/core/package.json'), '{}');
  for (const name of ['bzzy', 'bzzy-core']) fs.writeFileSync(path.join(bin, name), '# bzzy-managed launcher\nold revision\n', { mode: 0o755 });
  const service = [], commands = [];
  const lifecycle = { async coreHostStatus() { return { running, operatorStopped: !running }; }, async stopCoreHost() { service.push('stop'); commands.push({ executable: 'core-stop', args: [] }); } };
  const run = (executable, args, options) => {
    commands.push({ executable, args });
    if (executable === 'git') {
      const redirect = args.includes('get-url') ? [] : ['-c', `url.${remote}.insteadOf=${updateRepository}`];
      return spawnSync('git', [...redirect, ...args], { ...options, env: { ...options.env, ...env }, encoding: 'utf8' });
    }
    if (executable === process.execPath) { service.push(args.join(' ')); return { status: 0, stdout: '' }; }
    return spawnSync(executable, args, options);
  };
  return { root, bin, directory, releaseRoot, checked, author, git, run, lifecycle, service, commands };
}

test('an installed package can check GitHub without requiring or creating a checkout', async t => {
  const f = fixture(t);
  const result = await checkPackagedUpdate(f.directory, { run: async () => `ref: refs/heads/main\tHEAD\n${f.checked}\tHEAD` });
  assert.equal(result.packaged, true); assert.equal(result.available, true); assert.equal(result.current, 'packaged-release');
  assert.equal(fs.existsSync(f.releaseRoot), false); assert.deepEqual(f.service, []);
});

test('the old packaged CLI fetches the checked revision and installs CLI/Core together through its updater', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.author, 'version.txt'), 'later'); f.git(f.author, 'add', '.'); f.git(f.author, 'commit', '-m', 'Later release'); f.git(f.author, 'push', 'origin', 'main');
  const result = await updatePackagedInstallation(f.directory, { expectedCommit: f.checked, releaseRoot: f.releaseRoot, run: f.run, lifecycle: f.lifecycle });
  assert.equal(result, 0);
  const checkout = path.join(f.releaseRoot, 'checkout'); assert.equal(f.git(checkout, 'rev-parse', 'HEAD'), f.checked);
  assert.equal(fs.readFileSync(path.join(checkout, 'version.txt'), 'utf8'), 'checked');
  assert.equal(f.service[0], 'stop'); assert.ok(f.service[1].includes(path.join(checkout, 'BZZY-CLI/BZZY-CLI-TERMINAL/bin/bzzy-core.js'))); assert.ok(f.service[1].endsWith(' start'));
  fs.writeFileSync(path.join(checkout, 'BZZY-CORE/package.json'), '{"local":true}');
  await assert.rejects(updatePackagedInstallation(f.directory, { releaseRoot: f.releaseRoot, run: f.run, lifecycle: f.lifecycle }), /local changes/);
  assert.equal(f.service.length, 2, 'a dirty managed checkout cannot stop Core or install');
});

test('failed package upgrades restore old launchers and recover the retained old service', async t => {
  const f = fixture(t, { failInstall: true });
  await assert.rejects(updatePackagedInstallation(f.directory, { releaseRoot: f.releaseRoot, run: f.run, lifecycle: f.lifecycle }), /update command failed/);
  assert.match(fs.readFileSync(path.join(f.bin, 'bzzy'), 'utf8'), /old revision/);
  assert.equal(f.service[0], 'stop'); assert.ok(f.service[1].includes(f.directory) && f.service[1].endsWith(' service install')); assert.ok(f.service[2].endsWith(' start'));
});

test('updating an operator-stopped package never starts Core or replays work', async t => {
  const f = fixture(t, { running: false });
  await updatePackagedInstallation(f.directory, { releaseRoot: f.releaseRoot, run: f.run, lifecycle: f.lifecycle });
  assert.deepEqual(f.service, []);
});

test('legacy packaged upgrades honor the same installation lock as current Core updates', async t => {
  const f = fixture(t);
  const release = lockFile(path.join(process.env.BZZY_HOME, 'runtime/installation-update.lock'));
  try {
    await assert.rejects(updatePackagedInstallation(f.directory, { releaseRoot: f.releaseRoot, run: f.run, lifecycle: f.lifecycle }), { code: 'BZZY_LOCKED' });
    assert.equal(f.commands.length, 0, 'a concurrent update must not fetch, stop Core or install');
  } finally { release(); }
  await updatePackagedInstallation(f.directory, { releaseRoot: f.releaseRoot, run: f.run, lifecycle: f.lifecycle });
  assert.equal(fs.existsSync(path.join(process.env.BZZY_HOME, 'runtime/installation-update.lock')), false);
});

test('an existing managed checkout changes revision only after Core is paused', async t => {
  const f = fixture(t);
  await updatePackagedInstallation(f.directory, { releaseRoot: f.releaseRoot, run: f.run, lifecycle: f.lifecycle });
  fs.writeFileSync(path.join(f.author, 'version.txt'), 'new release'); f.git(f.author, 'add', '.'); f.git(f.author, 'commit', '-m', 'Next release'); f.git(f.author, 'push', 'origin', 'main');
  f.commands.length = 0; f.service.length = 0;
  await updatePackagedInstallation(f.directory, { releaseRoot: f.releaseRoot, run: f.run, lifecycle: f.lifecycle });
  const stop = f.commands.findIndex(command => command.executable === 'core-stop');
  const merge = f.commands.findIndex(command => command.executable === 'git' && command.args.includes('merge'));
  assert.ok(stop >= 0 && merge > stop, 'stop must precede the working tree fast-forward');
  assert.equal(fs.readFileSync(path.join(f.releaseRoot, 'checkout/version.txt'), 'utf8'), 'new release');
});
