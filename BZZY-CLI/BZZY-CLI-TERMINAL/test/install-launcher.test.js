import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { accountWrapper, planLaunchers, installLaunchers } from '../scripts/install-launcher.mjs';

let directory, bin, node;
test.beforeEach(() => {
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-launcher-install-')));
  bin = path.join(directory, 'bin'); fs.mkdirSync(bin, { mode: 0o700 });
  node = path.join(directory, "node's runtime");
  fs.writeFileSync(node, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2),uid:process.getuid?.()}));\n`, { mode: 0o755 });
});
test.afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));
const wrapper = (command = 'runuser') => `#!/bin/sh\nbzzy_cwd=/private/other-project\ncd -- "$bzzy_cwd" || exit 1\nexec /usr/bin/${command} -u fixture-owner -- env HOME=/private/fixture-owner BZZY_HOME=/private/previous-context PRIVATE_TOKEN=fixture-private-binding /private/inner/bzzy "$@"\n`;

test('managed launchers inherit every project cwd, arguments and invoking identity', () => {
  assert.deepEqual(installLaunchers(bin, node), []);
  for (const name of ['first project', "second project's space"]) {
    const cwd = path.join(directory, name); fs.mkdirSync(cwd);
    const args = ['goal', 'literal $(not-executed); quotes "stay"', '--cwd', 'relative target'];
    const result = spawnSync(path.join(bin, 'bzzy'), args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const received = JSON.parse(result.stdout);
    assert.equal(received.cwd, cwd); assert.deepEqual(received.args.slice(1), args);
    assert.equal(received.uid, process.getuid?.());
    assert.ok(received.args[0].endsWith('/bin/bzzy.js'));
  }
});

test('launcher activation pins the canonical Node target instead of a retargetable alias', () => {
  const alias = path.join(directory, 'node-alias'); fs.symlinkSync(node, alias);
  installLaunchers(bin, alias);
  const replacement = path.join(directory, 'other-node');
  fs.writeFileSync(replacement, '#!/bin/sh\nexit 97\n', { mode: 0o755 });
  fs.unlinkSync(alias); fs.symlinkSync(replacement, alias);
  const result = spawnSync(path.join(bin, 'bzzy'), ['--version'], { cwd: directory, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).args.slice(1), ['--version']);
  assert.equal(fs.readFileSync(path.join(bin, 'bzzy'), 'utf8').includes(alias), false);
});

test('both targets are checked before any launcher changes, and unsafe filesystem targets are refused', () => {
  const target = path.join(bin, 'bzzy'), other = path.join(bin, 'bzzy-core');
  fs.writeFileSync(target, '#!/bin/sh\n# bzzy-managed launcher\nold managed contents\n', { mode: 0o755 });
  fs.writeFileSync(other, '#!/bin/sh\nunrelated tool\n', { mode: 0o755 });
  const prior = fs.readFileSync(target, 'utf8');
  assert.throws(() => installLaunchers(bin, node), /unrelated executable/);
  assert.equal(fs.readFileSync(target, 'utf8'), prior);
  assert.deepEqual(fs.readdirSync(bin).sort(), ['bzzy', 'bzzy-core']);
  fs.unlinkSync(other); fs.symlinkSync(target, other);
  assert.throws(() => planLaunchers(bin, node), /unsafe launcher/);
  fs.unlinkSync(other); fs.linkSync(target, other);
  assert.throws(() => planLaunchers(bin, node), /unsafe launcher/);
  fs.unlinkSync(other); fs.chmodSync(target, 0o777);
  assert.throws(() => planLaunchers(bin, node), /unsafe launcher/);
  assert.equal(fs.readFileSync(target, 'utf8'), prior);
});

test('account-wrapper recognition never executes shell text or exposes bindings', () => {
  for (const command of ['runuser', 'sudo']) {
    const body = wrapper(command);
    assert.equal(accountWrapper(body), true);
    assert.equal(accountWrapper(body.replace(' -- env ', ' -- env \\\n ')), true);
  }
  const marker = path.join(directory, 'must-not-exist');
  assert.equal(accountWrapper(wrapper().replace('PRIVATE_TOKEN=fixture-private-binding', `PATH="$(touch ${marker})"`)), true);
  assert.equal(fs.existsSync(marker), false);
  for (const body of ['#!/bin/sh\nexec /bin/sh -c arbitrary "$@"\n', wrapper() + 'exec /bin/false "$@"\n',
    wrapper().replace(' "$@"', ' --cwd /another/project "$@"'), wrapper().replace('exec /usr/bin/runuser', 'exec runuser')]) {
    assert.equal(accountWrapper(body), false);
  }
});

test('explicit Linux-root wrapper replacement retains private backups and installs same-identity launchers', () => {
  fs.writeFileSync(path.join(bin, 'bzzy'), wrapper(), { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'bzzy-core'), wrapper('sudo'), { mode: 0o755 });
  assert.throws(() => planLaunchers(bin, node), /unrelated executable/);
  assert.throws(() => planLaunchers(bin, node, { replaceAccountWrapper: true, platform: 'linux', uid: 1234 }), /Linux root/);
  assert.throws(() => planLaunchers(bin, node, { replaceAccountWrapper: true, platform: 'darwin', uid: 0 }), /Linux root/);
  const original = fs.lstatSync;
  // Fixture files remain owned by this process. Only ownership metadata is
  // simulated to exercise the root-only installer on non-root development Macs.
  fs.lstatSync = (...args) => {
    const stat = original(...args);
    if (stat && String(args[0]).startsWith(directory)) stat.uid = 0;
    return stat;
  };
  let backups;
  const backupDirectory = path.join(directory, 'launcher-backups');
  try {
    const options = { replaceAccountWrapper: true, platform: 'linux', uid: 0, backupDirectory };
    planLaunchers(bin, node, options);
    assert.equal(fs.existsSync(backupDirectory), false, 'Read-only preflight creates no backup directory');
    backups = installLaunchers(bin, node, options);
  }
  finally { fs.lstatSync = original; }
  assert.equal(backups.length, 2);
  for (const file of backups) {
    assert.equal(path.dirname(file), backupDirectory);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.match(fs.readFileSync(file, 'utf8'), /fixture-private-binding/);
  }
  for (const name of ['bzzy', 'bzzy-core']) {
    const contents = fs.readFileSync(path.join(bin, name), 'utf8');
    assert.match(contents, /# bzzy-managed launcher/);
    assert.doesNotMatch(contents, /fixture-owner|previous-context|PRIVATE_TOKEN|runuser|sudo|\ncd /);
  }
  const cwd = path.join(directory, 'launch project'); fs.mkdirSync(cwd);
  const result = spawnSync(path.join(bin, 'bzzy'), ['--whoami'], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).cwd, cwd);
  assert.equal(JSON.parse(result.stdout).uid, process.getuid?.());
  assert.deepEqual(fs.readdirSync(bin).sort(), ['bzzy', 'bzzy-core']);
});

test('unsafe backup directories leave account-switching launchers unchanged', () => {
  const body = wrapper(), target = path.join(bin, 'bzzy'), destination = path.join(directory, 'launcher-backups');
  fs.writeFileSync(target, body, { mode: 0o755 }); fs.mkdirSync(destination, { mode: 0o755 });
  const original = fs.lstatSync;
  fs.lstatSync = (...args) => {
    const stat = original(...args);
    if (stat && String(args[0]).startsWith(directory)) stat.uid = 0;
    return stat;
  };
  try {
    const options = { replaceAccountWrapper: true, platform: 'linux', uid: 0, backupDirectory: destination };
    assert.throws(() => planLaunchers(bin, node, options), /owned private directories/);
    assert.throws(() => installLaunchers(bin, node, options), /owned private directories/);
    assert.equal(fs.readFileSync(target, 'utf8'), body);
    assert.equal(fs.existsSync(path.join(bin, 'bzzy-core')), false); assert.deepEqual(fs.readdirSync(destination), []);
    fs.rmdirSync(destination); fs.symlinkSync(directory, destination);
    assert.throws(() => installLaunchers(bin, node, options), /owned private directories/);
    assert.equal(fs.readFileSync(target, 'utf8'), body);
  } finally { fs.lstatSync = original; }
});
