// Standalone on purpose: this also repairs older packaged CLI updaters without
// importing a newer Core or activating any new product behavior before update.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export const updateRepository = 'https://github.com/BZZY-ai/BZZY.git';
export const officialRepository = value => /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)BZZY-ai\/BZZY(?:\.git)?\/?$/i.test(value);
const revision = value => typeof value === 'string' && /^[a-f0-9]{40,64}$/.test(value);
const commandEnvironment = () => ({ ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}`, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' });

// The first upgrade from an old package cannot import the newer Core store.
// Use its lock format so old-package upgrades and current Core updates exclude
// one another. PID-only liveness is conservative when a PID has been reused.
function installationLock() {
  const folder = path.resolve(process.env.BZZY_HOME || path.join(os.homedir(), '.bzzy'), 'runtime');
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const directory = fs.lstatSync(folder);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.mode & 0o022 || process.getuid && directory.uid !== process.getuid()) throw new Error('Use an owner-controlled BZZY runtime directory.');
  const file = path.join(folder, 'installation-update.lock'), temporary = `${file}.${randomUUID()}.tmp`;
  const contents = JSON.stringify({ identity: { pid: process.pid, start: 'platform-unverified' }, nonce: randomUUID() });
  fs.writeFileSync(temporary, contents, { mode: 0o600, flag: 'wx' });
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        fs.linkSync(temporary, file);
        return () => { try { if (fs.readFileSync(file, 'utf8') === contents) fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; } };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let stat, body;
        try { stat = fs.lstatSync(file); body = fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o022 || process.getuid && stat.uid !== process.getuid()) throw new Error('The BZZY update lock is not owner-controlled.');
        let pid;
        try { pid = JSON.parse(body).identity?.pid; } catch { /* Refuse malformed locks rather than guessing their owner. */ }
        let alive = true;
        if (Number.isSafeInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
        }
        if (alive) throw Object.assign(new Error('Another BZZY installation update is already running.'), { code: 'BZZY_LOCKED' });
        try {
          const latest = fs.lstatSync(file);
          if (latest.ino === stat.ino && latest.dev === stat.dev && fs.readFileSync(file, 'utf8') === body) fs.unlinkSync(file);
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
    throw new Error('Could not acquire the BZZY update lock.');
  } finally { fs.rmSync(temporary, { force: true }); }
}

export function isPackagedInstallation(directory) {
  try {
    return JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')).name === 'bzzy-cli'
      && fs.existsSync(path.join(directory, 'bin', 'bzzy.js')) && fs.existsSync(path.join(directory, 'node_modules', '@bzzy', 'core', 'package.json'));
  } catch { return false; }
}

export function isCoreInstallation(directory) {
  try {
    return JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')).name === '@bzzy/core'
      && fs.existsSync(path.join(directory, 'bin', 'bzzy-core.js')) && fs.existsSync(path.join(directory, 'node_modules', '@bzzy', 'relay', 'package.json'));
  } catch { return false; }
}

export function parseUpdateHead(output) {
  const target = /^([a-f0-9]{40,64})\s+HEAD$/m.exec(output)?.[1];
  const branch = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(output)?.[1];
  if (!target || !branch || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) || branch.includes('..')) throw new Error('GitHub did not return a valid BZZY revision.');
  return { target, branch };
}

export async function checkPackagedUpdate(directory, { run, signal } = {}) {
  if (!isPackagedInstallation(directory) && !isCoreInstallation(directory)) throw new Error('This is not an installed BZZY CLI or Core package.');
  const output = await run('git', ['ls-remote', '--symref', updateRepository, 'HEAD'], { cwd: directory, signal });
  const { target, branch } = parseUpdateHead(output);
  let current = 'packaged-release';
  try {
    const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'assets', 'release.json'), 'utf8'));
    if (revision(metadata.revision) && metadata.repository === updateRepository) current = metadata.revision;
  } catch { /* Older releases did not include revision metadata. */ }
  return { repository: updateRepository, current, target, branch, available: current !== target, blocked: null, packaged: true, directory, checkedAt: Date.now() };
}

function command(run, executable, args, options = {}) {
  const result = run(executable, args, { encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024, env: commandEnvironment(), ...options });
  if (result.error || result.status !== 0) throw new Error('BZZY update command failed. Check GitHub access, installation permissions and connectivity; private credentials are never requested in chat.');
  return result.stdout?.trim() || '';
}

// Compatibility name for older callers. This now preserves runners; callers
// must stage dependencies separately and never mutate the retained installation.
export async function withPausedCore(directory, install, { run = spawnSync, lifecycle } = {}) {
  const require = createRequire(path.join(directory, 'package.json'));
  const host = lifecycle || await import(pathToFileURL(require.resolve('@bzzy/core/engine/host-service.js')).href);
  if (!host.suspendCoreHost || !host.beginCoreMaintenance) throw new Error('Stage a release with execution-preserving lifecycle support before updating.');
  const release = host.beginCoreMaintenance();
  let before, installed, failure;
  try {
    before = await host.coreHostStatus();
    if (before.operatorStopped && before.running) await host.stopCoreHost();
    else if (before.running) await host.suspendCoreHost();
    installed = await install();
  } catch (error) { failure = error; }
  finally { release(); }
  if (failure) {
    if (before) {
      try {
        command(run, process.execPath, [path.join(directory, 'bin', 'bzzy-core.js'), 'service', 'install'], { stdio: 'inherit' });
        if (before.running && !before.operatorStopped && !(await host.coreHostStatus()).operatorStopped)
          command(run, process.execPath, [path.join(directory, 'bin', 'bzzy-core.js'), 'start'], { stdio: 'inherit' });
      } catch { throw new Error('Update failed and Core control recovery needs attention. Existing runners were retained. Run bzzy-core status.'); }
    }
    throw failure;
  }
  if (before.running && !before.operatorStopped && !(await host.coreHostStatus()).operatorStopped)
    command(run, process.execPath, [path.join(installed.directory, 'bin', 'bzzy-core.js'), 'start'], { stdio: 'inherit' });
  return installed.code;
}

export async function updatePackagedInstallation(directory, options = {}) {
  if (!isPackagedInstallation(directory) && !isCoreInstallation(directory)) throw new Error('This is not an installed BZZY CLI or Core package.');
  return updateRepositoryInstallation(directory, options);
}

function ownedDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o022 || process.getuid && stat.uid !== process.getuid())
    throw new Error('Use an owner-controlled BZZY release directory.');
}

// Both source and packaged installs switch to a separate, immutable checkout
// for every revision. No npm ci, git merge or cleanup touches a live release.
export async function updateRepositoryInstallation(directory, { expectedCommit = process.env.BZZY_UPDATE_TARGET,
  releaseRoot = path.join(os.homedir(), '.local', 'share', 'bzzy'), run = spawnSync, lifecycle, lockHeld = false } = {}) {
  const release = lockHeld ? () => {} : installationLock();
  try {
    const cwd = fs.realpathSync(directory);
    const git = (args, location = cwd) => command(run, 'git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: location });
    const head = parseUpdateHead(git(['ls-remote', '--symref', updateRepository, 'HEAD']));
    const target = expectedCommit || head.target;
    if (!revision(target)) throw new Error('Invalid checked BZZY revision.');
    ownedDirectory(releaseRoot);
    const versions = path.join(releaseRoot, 'versions'); ownedDirectory(versions);
    let checkout = path.join(versions, target);
    let retained;
    try { retained = fs.lstatSync(checkout); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (retained) {
      let reusable = false;
      if (retained.isDirectory() && !retained.isSymbolicLink() && !(retained.mode & 0o022) && (!process.getuid || retained.uid === process.getuid())) {
        try {
          reusable = officialRepository(git(['remote', 'get-url', 'origin'], checkout))
            && git(['rev-parse', 'HEAD'], checkout) === target
            && !git(['status', '--porcelain', '--untracked-files=normal'], checkout)
            && (fs.existsSync(checkout + '.prepared') || !fs.existsSync(path.join(checkout, 'BZZY-CLI/BZZY-CLI-TERMINAL/node_modules')));
        } catch { /* Keep an altered or incomplete release intact; prepare a fresh one. */ }
      }
      if (!reusable) checkout = path.join(versions, `${target}-${randomUUID()}`);
    }
    const prepared = checkout + '.prepared';
    if (!fs.existsSync(checkout)) {
      const stage = fs.mkdtempSync(path.join(releaseRoot, '.update-'));
      try {
        const source = path.join(stage, 'source');
        git(['clone', '--no-checkout', '--origin', 'origin', updateRepository, source]);
        git(['fetch', '--no-tags', 'origin', target], source);
        git(['checkout', '-B', head.branch, target], source);
        git(['branch', '--set-upstream-to', `origin/${head.branch}`, head.branch], source);
        fs.renameSync(source, checkout);
      } finally { fs.rmSync(stage, { recursive: true, force: true }); }
    }
    ownedDirectory(checkout);
    if (!officialRepository(git(['remote', 'get-url', 'origin'], checkout))) throw new Error('The release has an unexpected origin.');
    if (git(['status', '--porcelain', '--untracked-files=normal'], checkout)) throw new Error('The retained release has local changes. It will not be overwritten.');
    if (git(['rev-parse', 'HEAD'], checkout) !== target) throw new Error('Could not verify the checked BZZY update revision.');
    const next = path.join(checkout, 'BZZY-CLI', 'BZZY-CLI-TERMINAL');
    for (const entry of ['BZZY-CORE/package.json', 'BZZY-RELAY/package.json', 'BZZY-CLI/BZZY-CLI-TERMINAL/install.sh']) git(['cat-file', '-e', `${target}:${entry}`], checkout);
    const binDir = process.env.BZZY_BIN_DIR || process.env.BZZY_LAUNCHER_BIN_DIR || path.join(os.homedir(), '.local', 'bin');
    const backups = new Map();
    for (const name of ['bzzy', 'bzzy-core']) {
      const file = path.join(binDir, name);
      if (!fs.existsSync(file)) { backups.set(file, null); continue; }
      const stat = fs.lstatSync(file), body = fs.readFileSync(file, 'utf8');
      if (!stat.isFile() || stat.isSymbolicLink() || !body.includes('# bzzy-managed launcher')) throw new Error('An unrelated launcher occupies the BZZY install location.');
      backups.set(file, { body, mode: stat.mode & 0o777 });
    }
    const install = (prepare = false) => command(run, 'bash', [path.join(next, 'install.sh'), ...(prepare ? ['--prepare-only'] : [])], {
      cwd: next, stdio: 'inherit', timeout: 240000, env: { ...commandEnvironment(), BZZY_BIN_DIR: binDir,
        ...(!prepare ? { BZZY_INSTALL_PREPARED: '1', BZZY_NO_PATH_UPDATE: '1' } : {}) } });
    process.stdout.write(`Preparing BZZY CLI and Core (${target.slice(0, 8)}). Active goals continue…\n`);
    if (!fs.existsSync(prepared)) {
      // A release that was used before losing its preparation receipt is never
      // rebuilt in place: npm ci would replace files beneath a surviving runner.
      if (fs.existsSync(path.join(next, 'node_modules'))) throw new Error('Release preparation is incomplete. Retain this directory for existing runners; inspect it before retrying.');
      install(true);
      fs.writeFileSync(prepared, JSON.stringify({ revision: target }), { mode: 0o600, flag: 'wx' });
    }
    const host = lifecycle || await import(pathToFileURL(path.join(checkout, 'BZZY-CORE/src/engine/host-service.js')).href);
    return await withPausedCore(cwd, () => {
      try { install(); }
      catch (error) {
        for (const [file, backup] of backups) {
          if (backup) fs.writeFileSync(file, backup.body, { mode: backup.mode });
          else fs.rmSync(file, { force: true });
        }
        throw error;
      }
      process.stdout.write('BZZY CLI and Core updated. Reattaching to existing work…\n');
      return { directory: next, code: 0 };
    }, { run, lifecycle: host });
  } finally { release(); }
}
