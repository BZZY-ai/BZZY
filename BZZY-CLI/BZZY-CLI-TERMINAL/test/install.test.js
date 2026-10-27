import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
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

test('private Node bootstrap keeps installer ownership and prepare-only leaves host state unchanged', t => {
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(process.getuid?.() === 0 ? os.homedir() : os.tmpdir(), 'bzzy-node-bootstrap-')));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const checkout = path.join(temporary, 'standalone', 'checkout'), guards = path.join(temporary, 'guards');
  fs.mkdirSync(checkout, { recursive: true }); fs.mkdirSync(guards);
  fs.copyFileSync(path.join(root, 'install.sh'), path.join(checkout, 'install.sh'));
  const metadata = path.join(checkout, 'node_modules', '@bzzy', 'core', 'package.json');
  fs.mkdirSync(path.dirname(metadata), { recursive: true }); fs.writeFileSync(metadata, '{}');
  const archiveName = `node-fixture-${process.platform}-${process.arch}.tar.gz`, archive = path.join(temporary, archiveName);
  const made = spawnSync('python3', ['-c', `import io,shlex,sys,tarfile
with tarfile.open(sys.argv[1], 'w:gz') as bundle:
 entry=tarfile.TarInfo('node-runtime/bin/node');entry.uid=12345;entry.gid=12345;entry.mode=0o755
 body=('#!/bin/sh\\nexec '+shlex.quote(sys.argv[2])+' "$@"\\n').encode();entry.size=len(body);bundle.addfile(entry,io.BytesIO(body))`, archive, process.execPath], { encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  const sums = path.join(temporary, 'SHASUMS256.txt');
  fs.writeFileSync(sums, createHash('sha256').update(fs.readFileSync(archive)).digest('hex') + '  ' + archiveName + '\n');
  fs.writeFileSync(path.join(guards, 'node'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  fs.writeFileSync(path.join(guards, 'curl'), `#!/bin/sh
while [ "$#" -gt 0 ]; do
 case "$1" in -o) destination=$2; shift 2;; https://*) address=$1; shift;; *) shift;; esac
done
case "$address" in */SHASUMS256.txt) cp "$BZZY_TEST_BOOTSTRAP_SUMS" "$destination";; *) cp "$BZZY_TEST_BOOTSTRAP_ARCHIVE" "$destination";; esac
`, { mode: 0o755 });
  const coreHome = path.join(temporary, 'private'), bin = path.join(temporary, 'bin');
  const result = spawnSync('/bin/bash', ['install.sh', '--prepare-only'], { cwd: checkout, encoding: 'utf8', timeout: 15000,
    env: { ...process.env, PATH: [guards, path.dirname(process.execPath), process.env.PATH].join(path.delimiter),
      BZZY_INSTALL_PREPARED: '1', BZZY_HOME: coreHome, BZZY_BIN_DIR: bin,
      BZZY_TEST_BOOTSTRAP_SUMS: sums, BZZY_TEST_BOOTSTRAP_ARCHIVE: archive } });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /Release prepared/);
  const runtime = path.join(checkout, '.bzzy-runtime', 'node', 'bin', 'node');
  assert.equal(fs.statSync(runtime).uid, process.getuid?.());
  assert.equal(spawnSync(runtime, ['--version'], { encoding: 'utf8' }).stdout.trim(), process.version);
  assert.equal(fs.existsSync(coreHome), false); assert.equal(fs.existsSync(bin), false);
});

test('service setup failure leaves the prior launchers intact', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-install-order-'));
  try {
    const checkout = path.join(temporary, 'checkout'), bin = path.join(temporary, 'bin');
    fs.mkdirSync(checkout); fs.mkdirSync(bin);
    copyBundledCore(checkout);
    fs.mkdirSync(path.join(checkout, 'scripts')); fs.mkdirSync(path.join(checkout, 'bin'));
    fs.copyFileSync(path.join(root, 'install.sh'), path.join(checkout, 'install.sh'));
    fs.copyFileSync(path.join(root, 'scripts/install-launcher.mjs'), path.join(checkout, 'scripts/install-launcher.mjs'));
    fs.writeFileSync(path.join(checkout, 'bin/bzzy-core.js'), 'process.stderr.write("fixture service setup failed\\n"); process.exit(31);\n');
    const prior = '#!/bin/sh\n# bzzy-managed launcher\necho retained launcher\n';
    for (const name of ['bzzy', 'bzzy-core']) fs.writeFileSync(path.join(bin, name), prior, { mode: 0o755 });
    const result = spawnSync('bash', ['install.sh'], { cwd: checkout, env: { ...process.env,
      PATH: path.dirname(process.execPath) + path.delimiter + process.env.PATH, BZZY_BIN_DIR: bin, BZZY_INSTALL_PREPARED: '1' }, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 31, result.stderr);
    for (const name of ['bzzy', 'bzzy-core']) assert.equal(fs.readFileSync(path.join(bin, name), 'utf8'), prior);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

test('root installation rejects a spoofed identity or unsafe source before any Node probe', t => {
  if (!fs.existsSync('/usr/bin/python3')) return t.skip('root installation requires the OS Python interpreter');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-root-install-preflight-'));
  try {
    const checkout = path.join(temporary, 'checkout'), guards = path.join(temporary, 'guards'), bin = path.join(temporary, 'bin');
    fs.mkdirSync(checkout); fs.mkdirSync(guards);
    fs.copyFileSync(path.join(root, 'install.sh'), path.join(checkout, 'install.sh'));
    const marker = path.join(temporary, 'node-was-executed');
    fs.writeFileSync(path.join(guards, 'id'), '#!/bin/sh\nprintf "0\\n"\n', { mode: 0o755 });
    fs.writeFileSync(path.join(guards, 'uname'), '#!/bin/sh\nprintf "Linux\\n"\n', { mode: 0o755 });
    fs.writeFileSync(path.join(guards, 'node'), '#!/bin/sh\nprintf invoked > "$BZZY_NODE_PROBE_MARKER"\nexit 97\n', { mode: 0o755 });
    // On a root CI worker ownership is real; this writable source must still
    // fail before its fake Node executable can run. On developer Macs the
    // source is additionally foreign to the simulated root invocation.
    fs.chmodSync(path.join(checkout, 'install.sh'), 0o666);
    const result = spawnSync('/bin/bash', ['install.sh', '--allow-root', '--replace-account-wrapper'], { cwd: checkout,
      env: { ...process.env, PATH: guards + path.delimiter + process.env.PATH, BZZY_BIN_DIR: bin, BZZY_NODE_PROBE_MARKER: marker },
      encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, process.getuid?.() === 0 && process.platform === 'linux'
      ? /Root installation requires root-owned source/ : /Root installation options require Linux and the root account/);
    const source = fs.readFileSync(path.join(root, 'install.sh'), 'utf8');
    const preflight = /<<'PY'\n([\s\S]*?)\nPY/.exec(source)?.[1]; assert.ok(preflight);
    const checked = spawnSync('/usr/bin/python3', ['-I', '-c', preflight, checkout, path.join(guards, 'node'), path.join(checkout, 'missing-node')],
      { encoding: 'utf8', timeout: 10000 });
    assert.equal(checked.status, 1, checked.stderr);
    assert.match(checked.stderr, /Root installation requires root-owned source/);
    assert.equal(fs.existsSync(marker), false); assert.equal(fs.existsSync(bin), false);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});
