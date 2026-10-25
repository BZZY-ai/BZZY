import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { updateRepository, checkPackagedUpdate, updatePackagedInstallation, updateRepositoryInstallation, isCoreInstallation, withPausedCore } from '../src/packaged-update.js';
import { checkInstallationUpdate } from '../src/update-checker.js';
import { lockFile } from '@bzzy/core/engine/store.js';

function fixture(t, { failInstall = false, failPrepare = false, running = true, coreOnly = false,
  managerRunning = running, managerLoaded = managerRunning, operatorStopped = !running, failStart = false,
  failRecoveryInstall = false, stopDuringStart = false, exactManifest = false, serviceInstalled = true, stopIntent = null } = {}) {
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
  fs.writeFileSync(path.join(cli, 'install.sh'), '#!/bin/sh\nif [ "$1" = --prepare-only ]; then exit ' + (failPrepare ? '21' : '0') + '; fi\nmkdir -p "$BZZY_BIN_DIR"\nprintf "# bzzy-managed launcher\\nnew revision\\n" > "$BZZY_BIN_DIR/bzzy"\n' + (failInstall ? 'exit 23\n' : 'exit 0\n'));
  fs.writeFileSync(path.join(author, 'version.txt'), 'checked'); git(author, 'add', '.'); git(author, 'commit', '-m', 'Checked release'); git(author, 'push', 'origin', 'main');
  const checked = git(author, 'rev-parse', 'HEAD');
  fs.mkdirSync(path.join(directory, 'bin'), { recursive: true });
  const dependency = path.join(directory, coreOnly ? 'node_modules/@bzzy/relay' : 'node_modules/@bzzy/core');
  fs.mkdirSync(dependency, { recursive: true });
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: coreOnly ? '@bzzy/core' : 'bzzy-cli' }));
  fs.writeFileSync(path.join(directory, coreOnly ? 'bin/bzzy-core.js' : 'bin/bzzy.js'), '// old package');
  fs.writeFileSync(path.join(dependency, 'package.json'), '{}');
  for (const name of ['bzzy', 'bzzy-core']) fs.writeFileSync(path.join(bin, name), '# bzzy-managed launcher\nold revision\n', { mode: 0o755 });
  const service = [], commands = [], state = { running, managerRunning, managerLoaded, operatorStopped, intent: stopIntent, maintenance: false,
    manifest: 'Original managed Node, source and captured environment settings.' };
  const lifecycle = {
    async coreHostStatus() { return { running: state.running, operatorStopped: state.operatorStopped,
      operatorStopIntent: state.intent, service: { installed: serviceInstalled, running: state.managerRunning, loaded: state.managerLoaded } }; },
    beginCoreMaintenance() { assert.equal(state.maintenance, false); state.maintenance = true; service.push('maintenance'); return () => { state.maintenance = false; service.push('release'); }; },
    async suspendCoreHost() { service.push('suspend'); commands.push({ executable: 'core-suspend', args: [] }); state.running = state.managerRunning = state.managerLoaded = false; },
    async stopCoreHost() {
      assert.equal(state.operatorStopped, true, 'Updates cannot initiate an operator Stop.');
      assert.notEqual(state.intent?.source, 'service_start_failure', 'Automatic startup gates must not pause executions.');
      service.push('stop'); state.running = state.managerRunning = state.managerLoaded = false;
    },
    async clearCoreStartFailure(attemptId) {
      if (state.intent?.source !== 'service_start_failure' || state.intent.attemptId !== attemptId) return false;
      state.operatorStopped = false; state.intent = null; return true;
    },
  };
  if (exactManifest) {
    lifecycle.snapshotCoreServiceManifest = () => ({ manifest: state.manifest });
    lifecycle.restoreCoreServiceManifest = snapshot => {
      assert.equal(state.maintenance, true); assert.equal(state.managerLoaded, false);
      assert.match(fs.readFileSync(path.join(bin, 'bzzy'), 'utf8'), /old revision/);
      state.manifest = snapshot.manifest; service.push('exact-manifest-restored');
    };
    lifecycle.startRestoredCoreService = async (snapshot, { attemptId, respectStop }) => {
      assert.equal(state.maintenance, false); assert.equal(state.operatorStopped, false); assert.equal(respectStop, true);
      assert.match(attemptId, /^[a-f0-9-]{36}$/); assert.equal(state.manifest, snapshot.manifest);
      state.running = state.managerRunning = state.managerLoaded = true; service.push('exact-manifest-started');
    };
  }
  const run = (executable, args, options) => {
    commands.push({ executable, args, startAttemptId: options?.env?.BZZY_CORE_START_ATTEMPT_ID, respectStop: options?.env?.BZZY_CORE_RESPECT_STOP });
    if (executable === 'git') {
      const redirect = args.includes('get-url') ? [] : ['-c', `url.${remote}.insteadOf=${updateRepository}`];
      return spawnSync('git', [...redirect, ...args], { ...options, env: { ...options.env, ...env }, encoding: 'utf8' });
    }
    if (executable === process.execPath) {
      service.push(args.join(' '));
      if (args.slice(-2).join(' ') === 'service install') {
        assert.equal(state.maintenance, true, 'Recovery manifest replacement stays behind maintenance.');
        assert.equal(state.managerLoaded, false, 'The native job is unloaded before any recovery manifest replacement.');
        return { status: failRecoveryInstall ? 31 : 0, stdout: '' };
      }
      if (args.at(-1) === 'start') {
        assert.equal(state.maintenance, false, 'Only a consistent installed manifest may open the startup gate.');
        assert.equal(options.env.BZZY_CORE_RESPECT_STOP, '1');
        assert.match(options.env.BZZY_CORE_START_ATTEMPT_ID, /^[a-f0-9-]{36}$/);
        if (args[0] !== path.join(directory, 'bin', 'bzzy-core.js') && failStart) {
          state.managerLoaded = true;
          state.operatorStopped = true;
          state.intent = stopDuringStart ? { source: 'operator', attemptId: null } : { source: 'service_start_failure', attemptId: options.env.BZZY_CORE_START_ATTEMPT_ID };
          return { status: 32, stdout: '' };
        }
        assert.equal(state.operatorStopped, false, 'Automatic startup cannot erase an explicit Stop.');
        state.running = state.managerRunning = state.managerLoaded = true;
      }
      return { status: 0, stdout: '' };
    }
    if (executable === 'bash' && !args.includes('--prepare-only')) {
      assert.equal(state.managerLoaded, false, 'Activation cannot replace the manifest of a loaded native service.');
      state.manifest = 'New Node, source and environment settings.';
    }
    return spawnSync(executable, args, options);
  };
  return { root, bin, directory, releaseRoot, checked, author, git, run, lifecycle, service, commands, state };
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
  const checkout = path.join(f.releaseRoot, 'versions', f.checked); assert.equal(f.git(checkout, 'rev-parse', 'HEAD'), f.checked);
  assert.equal(fs.readFileSync(path.join(checkout, 'version.txt'), 'utf8'), 'checked');
  assert.deepEqual(f.service.slice(0, 3), ['maintenance', 'suspend', 'release']); assert.ok(f.service[3].includes(path.join(checkout, 'BZZY-CLI/BZZY-CLI-TERMINAL/bin/bzzy-core.js'))); assert.ok(f.service[3].endsWith(' start'));
  const prepare = f.commands.findIndex(c => c.executable === 'bash' && c.args.includes('--prepare-only'));
  const suspend = f.commands.findIndex(c => c.executable === 'core-suspend');
  assert.ok(prepare >= 0 && prepare < suspend, 'dependencies are prepared while existing Core is still running');
  fs.writeFileSync(path.join(checkout, 'BZZY-CORE/package.json'), '{"local":true}');
  await updatePackagedInstallation(f.directory, { expectedCommit: f.checked, releaseRoot: f.releaseRoot, run: f.run, lifecycle: f.lifecycle });
  assert.equal(fs.readFileSync(path.join(checkout, 'BZZY-CORE/package.json'), 'utf8'), '{"local":true}', 'modified retained releases stay intact');
  const fresh = fs.readdirSync(path.join(f.releaseRoot, 'versions')).filter(name => name.startsWith(f.checked + '-') && !name.endsWith('.prepared'));
  assert.equal(fresh.length, 1);
  assert.equal(f.git(path.join(f.releaseRoot, 'versions', fresh[0]), 'status', '--porcelain'), '');
  assert.equal(f.service.length, 8);
});

test('failed package upgrades restore old launchers and recover the retained old service', async t => {
  const f = fixture(t, { failInstall: true });
  await assert.rejects(updatePackagedInstallation(f.directory, { releaseRoot: f.releaseRoot, run: f.run, lifecycle: f.lifecycle }), /update command failed/);
  assert.match(fs.readFileSync(path.join(f.bin, 'bzzy'), 'utf8'), /old revision/);
  const install = f.service.findIndex(item => item.endsWith(' service install')), release = f.service.indexOf('release');
  assert.ok(install > 0 && install < release); assert.ok(f.service[install].includes(f.directory)); assert.ok(f.service.at(-1).endsWith(' start'));
  assert.equal(f.state.running, true);
});

test('updating an operator-stopped package never starts Core or replays work', async t => {
  const f = fixture(t, { running: false });
  await updatePackagedInstallation(f.directory, { releaseRoot: f.releaseRoot, run: f.run, lifecycle: f.lifecycle });
  assert.deepEqual(f.service, ['maintenance', 'stop', 'release']); assert.equal(f.state.operatorStopped, true);
});

test('an explicit Stop finishes its pause barrier before update even when engine health is unavailable', async t => {
  const f = fixture(t, { running: false, managerRunning: true, operatorStopped: true, stopIntent: { source: 'operator' } });
  await updatePackagedInstallation(f.directory, { releaseRoot: f.releaseRoot, run: f.run, lifecycle: f.lifecycle });
  assert.deepEqual(f.service, ['maintenance', 'stop', 'release']); assert.equal(f.state.operatorStopped, true);
  assert.equal(f.commands.filter(item => item.args.at(-1) === 'start').length, 0);
});

test('a prior automatic readiness-failure gate stays stopped without turning into an execution pause', async t => {
  const stopIntent = { source: 'service_start_failure', attemptId: '11111111-1111-4111-8111-111111111111' };
  const f = fixture(t, { running: false, managerRunning: true, operatorStopped: true, stopIntent });
  await updatePackagedInstallation(f.directory, { releaseRoot: f.releaseRoot, run: f.run, lifecycle: f.lifecycle });
  assert.deepEqual(f.service, ['maintenance', 'suspend', 'release']); assert.equal(f.state.operatorStopped, true);
  assert.deepEqual(f.state.intent, stopIntent); assert.equal(f.commands.filter(item => item.args.at(-1) === 'start').length, 0);
});

test('an unhealthy engine still unloads its running native service before installing the checked release', async t => {
  const f = fixture(t, { running: false, managerRunning: true, operatorStopped: false });
  await updatePackagedInstallation(f.directory, { releaseRoot: f.releaseRoot, run: f.run, lifecycle: f.lifecycle });
  assert.deepEqual(f.service.slice(0, 2), ['maintenance', 'suspend']); assert.equal(f.state.running, true);
  assert.equal(f.commands.filter(item => item.args.at(-1) === 'start').length, 1);
});

test('a loaded waiting native job with no PID is suspended and restarted without pausing executions', async t => {
  const f = fixture(t, { running: false, managerRunning: false, managerLoaded: true, operatorStopped: false });
  await updatePackagedInstallation(f.directory, { releaseRoot: f.releaseRoot, run: f.run, lifecycle: f.lifecycle });
  assert.deepEqual(f.service.slice(0, 2), ['maintenance', 'suspend']); assert.equal(f.state.running, true);
});

test('a loaded native job is suspended even if its manifest was removed and engine health is unavailable', async t => {
  const f = fixture(t, { running: false, managerRunning: true, operatorStopped: false, serviceInstalled: false });
  await updatePackagedInstallation(f.directory, { releaseRoot: f.releaseRoot, run: f.run, lifecycle: f.lifecycle });
  assert.deepEqual(f.service.slice(0, 2), ['maintenance', 'suspend']); assert.equal(f.state.running, true);
});

test('new service readiness failure rolls back launchers and the retained manifest before recovering old Core', async t => {
  const f = fixture(t, { failStart: true });
  let output = ''; const originalWrite = process.stdout.write;
  process.stdout.write = function (chunk, ...args) { output += String(chunk); return true; };
  try { await assert.rejects(updatePackagedInstallation(f.directory, { releaseRoot: f.releaseRoot, run: f.run, lifecycle: f.lifecycle }), /update command failed/); }
  finally { process.stdout.write = originalWrite; }
  assert.doesNotMatch(output, /CLI and Core updated/);
  for (const name of ['bzzy', 'bzzy-core']) assert.match(fs.readFileSync(path.join(f.bin, name), 'utf8'), /old revision/);
  const recoveryInstall = f.service.findIndex(item => item.endsWith(' service install'));
  assert.ok(recoveryInstall > f.service.lastIndexOf('maintenance'));
  assert.equal(f.service.filter(item => item === 'maintenance').length, 2);
  assert.ok(f.service.at(-1).startsWith(path.join(f.directory, 'bin', 'bzzy-core.js')));
  assert.equal(f.state.running, true); assert.equal(f.state.operatorStopped, false);
  const starts = f.commands.filter(item => item.args.at(-1) === 'start'); assert.equal(starts.length, 2);
  assert.notEqual(starts[0].startAttemptId, starts[1].startAttemptId);
  assert.equal(fs.readFileSync(path.join(f.releaseRoot, 'versions', f.checked, 'version.txt'), 'utf8'), 'checked', 'The failed release stays available and live sources are never removed.');
});

test('a concurrent explicit Stop during failed startup remains authoritative throughout rollback', async t => {
  const f = fixture(t, { failStart: true, stopDuringStart: true });
  await assert.rejects(updatePackagedInstallation(f.directory, { releaseRoot: f.releaseRoot, run: f.run, lifecycle: f.lifecycle }), /update command failed/);
  assert.equal(f.state.operatorStopped, true); assert.equal(f.state.intent.source, 'operator'); assert.equal(f.state.running, false);
  assert.equal(f.commands.filter(item => item.args.at(-1) === 'start').length, 1, 'The updater must not restart old Core over the user’s Stop.');
  assert.ok(f.service.includes('stop'), 'The user’s pending pause barrier finishes before recovery unloads its supervisor.');
  assert.match(fs.readFileSync(path.join(f.bin, 'bzzy'), 'utf8'), /old revision/);
});

test('an incomplete Stop during failed new startup retains that supervisor and aborts recovery before rewriting files', async t => {
  const f = fixture(t, { failStart: true, stopDuringStart: true });
  f.lifecycle.stopCoreHost = async () => { f.service.push('stop-incomplete'); throw new Error('The pause barrier is incomplete.'); };
  await assert.rejects(updatePackagedInstallation(f.directory, { releaseRoot: f.releaseRoot, run: f.run, lifecycle: f.lifecycle }), /recovery needs attention/);
  assert.equal(f.state.managerLoaded, true); assert.equal(f.state.operatorStopped, true); assert.equal(f.state.intent.source, 'operator');
  assert.equal(f.service.filter(item => item === 'suspend').length, 1, 'Recovery cannot unload the supervisor that still owns the Stop barrier.');
  assert.match(fs.readFileSync(path.join(f.bin, 'bzzy'), 'utf8'), /new revision/);
  assert.equal(f.commands.filter(item => item.args.at(-1) === 'start').length, 1);
  assert.equal(f.commands.filter(item => item.args.slice(-2).join(' ') === 'service install').length, 0);
});

test('rollback restores captured manifest bytes instead of recomputing the retained service with another Node or environment', async t => {
  const f = fixture(t, { failStart: true, exactManifest: true }), original = f.state.manifest;
  await assert.rejects(updatePackagedInstallation(f.directory, { releaseRoot: f.releaseRoot, run: f.run, lifecycle: f.lifecycle }), /update command failed/);
  assert.equal(f.state.manifest, original); assert.equal(f.state.running, true);
  assert.ok(f.service.includes('exact-manifest-restored')); assert.equal(f.service.at(-1), 'exact-manifest-started');
  assert.ok(!f.commands.some(item => item.args.slice(-2).join(' ') === 'service install'), 'An exact trusted snapshot avoids recomputing Node/PATH/account-directory settings.');
  assert.equal(f.commands.filter(item => item.args.at(-1) === 'start').length, 1, 'Restored startup uses new stop-aware lifecycle logic rather than an old CLI that cannot honor it.');
});

test('a failed recovery manifest operation reports incomplete recovery instead of claiming rollback success', async t => {
  const f = fixture(t, { failInstall: true, failRecoveryInstall: true });
  await assert.rejects(updatePackagedInstallation(f.directory, { releaseRoot: f.releaseRoot, run: f.run, lifecycle: f.lifecycle }), /recovery needs attention.*runners were retained/);
  assert.equal(f.state.maintenance, false); assert.equal(f.commands.filter(item => item.args.at(-1) === 'start').length, 0);
  assert.match(fs.readFileSync(path.join(f.bin, 'bzzy'), 'utf8'), /old revision/);
});

for (const running of [true, false]) test(`an incomplete explicit Stop with ${running ? 'healthy' : 'unavailable'} engine health retains its supervisor without installation or recovery`, async t => {
  const f = fixture(t, { running, managerRunning: true, operatorStopped: true }), barrier = new Error('The pause barrier is incomplete.');
  f.lifecycle.stopCoreHost = async () => { f.service.push('stop-incomplete'); throw barrier; };
  let installed = false, rolledBack = false;
  await assert.rejects(withPausedCore(f.directory, () => { installed = true; }, {
    run: f.run, lifecycle: f.lifecycle, rollback() { rolledBack = true; },
  }), error => error === barrier);
  assert.deepEqual(f.service, ['maintenance', 'stop-incomplete', 'release']);
  assert.equal(f.state.running, running); assert.equal(f.state.managerLoaded, true);
  assert.equal(installed, false); assert.equal(rolledBack, false); assert.equal(f.commands.length, 0);
  assert.match(fs.readFileSync(path.join(f.bin, 'bzzy'), 'utf8'), /old revision/);
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

test('successive updates retain each complete old release and never merge or reinstall its dependencies', async t => {
  const f = fixture(t);
  await updatePackagedInstallation(f.directory, { releaseRoot: f.releaseRoot, run: f.run, lifecycle: f.lifecycle });
  const oldRelease = path.join(f.releaseRoot, 'versions', f.checked);
  const dependency = path.join(oldRelease, 'BZZY-CORE', 'node_modules', 'live-runner-fixture.js');
  fs.mkdirSync(path.dirname(dependency), { recursive: true }); fs.writeFileSync(dependency, 'original dependency');
  fs.writeFileSync(path.join(f.author, 'version.txt'), 'new release'); f.git(f.author, 'add', '.'); f.git(f.author, 'commit', '-m', 'Next release'); f.git(f.author, 'push', 'origin', 'main');
  const next = f.git(f.author, 'rev-parse', 'HEAD'); f.commands.length = 0; f.service.length = 0;
  await updatePackagedInstallation(f.directory, { releaseRoot: f.releaseRoot, run: f.run, lifecycle: f.lifecycle });
  assert.equal(fs.readFileSync(path.join(oldRelease, 'version.txt'), 'utf8'), 'checked');
  assert.equal(fs.readFileSync(dependency, 'utf8'), 'original dependency');
  assert.equal(fs.readFileSync(path.join(f.releaseRoot, 'versions', next, 'version.txt'), 'utf8'), 'new release');
  assert.ok(f.commands.every(c => c.executable !== 'git' || !c.args.includes('merge')));
  assert.ok(f.commands.filter(c => c.executable === 'bash').every(c => !c.args[0].startsWith(oldRelease)));
});

test('preparation failure leaves Core, launchers and all active releases untouched', async t => {
  const f = fixture(t, { failPrepare: true });
  await assert.rejects(updatePackagedInstallation(f.directory, { releaseRoot: f.releaseRoot, run: f.run, lifecycle: f.lifecycle }), /update command failed/);
  assert.deepEqual(f.service, []);
  assert.match(fs.readFileSync(path.join(f.bin, 'bzzy'), 'utf8'), /old revision/);
});


test('a standalone Core package checks and updates from an arbitrary path into the combined release', async t => {
  const f = fixture(t, { coreOnly: true });
  assert.equal(isCoreInstallation(f.directory), true);
  const run = async (executable, args, options) => {
    const result = f.run(executable, args, options);
    if (result.status !== 0) throw new Error('Fixture command failed');
    return result.stdout.trim();
  };
  const check = await checkInstallationUpdate({ directory: f.directory, run });
  assert.equal(check.packaged, true); assert.equal(check.target, f.checked); assert.equal(check.blocked, null);
  await updatePackagedInstallation(f.directory, { releaseRoot: f.releaseRoot, expectedCommit: check.target, run: f.run, lifecycle: f.lifecycle });
  assert.equal(fs.readFileSync(path.join(f.directory, 'bin/bzzy-core.js'), 'utf8'), '// old package');
  assert.equal(f.git(path.join(f.releaseRoot, 'versions', f.checked), 'rev-parse', 'HEAD'), f.checked);
});

test('official source updates retain dirty files, untracked projects, detached local history and the original path', async t => {
  const f = fixture(t), source = path.join(f.root, "arbitrary server folder's source");
  f.git(f.root, 'clone', path.join(f.root, 'remote.git'), source);
  f.git(source, 'remote', 'set-url', 'origin', updateRepository);
  fs.writeFileSync(path.join(source, 'local-commit.txt'), 'private custom behavior');
  f.git(source, 'add', '.'); f.git(source, 'commit', '-m', 'Local-only history');
  f.git(source, 'checkout', '--detach');
  const localHead = f.git(source, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(source, 'BZZY-CORE/package.json'), '{"local":true}');
  fs.mkdirSync(path.join(source, 'user references')); fs.writeFileSync(path.join(source, 'user references/notes.txt'), 'untracked project notes');
  const before = f.git(source, 'status', '--porcelain');
  fs.writeFileSync(path.join(f.author, 'version.txt'), 'official next'); f.git(f.author, 'add', '.'); f.git(f.author, 'commit', '-m', 'Next official release'); f.git(f.author, 'push', 'origin', 'main');
  const target = f.git(f.author, 'rev-parse', 'HEAD');
  const run = async (executable, args, options) => {
    const result = f.run(executable, args, options);
    if (result.status !== 0) throw new Error('Fixture command failed');
    return result.stdout.trim();
  };
  const directory = path.join(source, 'BZZY-CLI/BZZY-CLI-TERMINAL');
  const check = await checkInstallationUpdate({ directory, run });
  assert.equal(check.current, localHead); assert.equal(check.target, target); assert.equal(check.blocked, null);
  await updateRepositoryInstallation(directory, { expectedCommit: target, releaseRoot: f.releaseRoot, run: f.run, lifecycle: f.lifecycle });
  assert.equal(f.git(source, 'rev-parse', 'HEAD'), localHead);
  assert.equal(f.git(source, 'status', '--porcelain'), before);
  assert.equal(fs.readFileSync(path.join(source, 'BZZY-CORE/package.json'), 'utf8'), '{"local":true}');
  assert.equal(fs.readFileSync(path.join(source, 'user references/notes.txt'), 'utf8'), 'untracked project notes');
  assert.equal(fs.readFileSync(path.join(f.releaseRoot, 'versions', target, 'version.txt'), 'utf8'), 'official next');
  assert.ok(f.commands.every(command => command.executable !== 'git' || !command.args.some(arg => ['merge', 'pull', 'reset', 'stash', 'clean'].includes(arg))));
});

test('incomplete prepared releases are retained and replaced by a fresh checkout', async t => {
  const f = fixture(t);
  await updatePackagedInstallation(f.directory, { releaseRoot: f.releaseRoot, run: f.run, lifecycle: f.lifecycle });
  const retained = path.join(f.releaseRoot, 'versions', f.checked), modules = path.join(retained, 'BZZY-CLI/BZZY-CLI-TERMINAL/node_modules');
  fs.mkdirSync(modules); fs.writeFileSync(path.join(modules, 'active-runner.js'), 'retain this dependency');
  fs.unlinkSync(retained + '.prepared');
  await updatePackagedInstallation(f.directory, { releaseRoot: f.releaseRoot, run: f.run, lifecycle: f.lifecycle });
  assert.equal(fs.readFileSync(path.join(modules, 'active-runner.js'), 'utf8'), 'retain this dependency');
  assert.equal(fs.readdirSync(path.dirname(retained)).filter(name => name.startsWith(f.checked) && !name.endsWith('.prepared')).length, 2);
});
