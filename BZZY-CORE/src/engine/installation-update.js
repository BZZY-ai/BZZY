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

export function parseUpdateHead(output) {
  const target = /^([a-f0-9]{40,64})\s+HEAD$/m.exec(output)?.[1];
  const branch = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(output)?.[1];
  if (!target || !branch || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) || branch.includes('..')) throw new Error('GitHub did not return a valid BZZY revision.');
  return { target, branch };
}

export async function checkPackagedUpdate(directory, { run, signal } = {}) {
  if (!isPackagedInstallation(directory)) throw new Error('This is not an installed BZZY package.');
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

export async function withPausedCore(directory, install, { run = spawnSync, lifecycle } = {}) {
  const require = createRequire(path.join(directory, 'package.json'));
  const host = lifecycle || await import(pathToFileURL(require.resolve('@bzzy/core/engine/host-service.js')).href);
  const before = await host.coreHostStatus();
  if (before.running) await host.stopCoreHost();
  let installed;
  try { installed = await install(); }
  catch (error) {
    // A failed installer may have replaced its launchers or service manifest.
    // Restore the old service definition using the old, still-retained package.
    try {
      command(run, process.execPath, [path.join(directory, 'bin', 'bzzy-core.js'), 'service', 'install'], { stdio: 'inherit' });
      if (before.running && !before.operatorStopped) command(run, process.execPath, [path.join(directory, 'bin', 'bzzy-core.js'), 'start'], { stdio: 'inherit' });
    } catch { throw new Error('Update failed and Core recovery needs attention. Run bzzy-core status; saved work remains paused.'); }
    throw error;
  }
  if (before.running && !before.operatorStopped) command(run, process.execPath, [path.join(installed.directory, 'bin', 'bzzy-core.js'), 'start'], { stdio: 'inherit' });
  return installed.code;
}

export async function updatePackagedInstallation(directory, { expectedCommit = process.env.BZZY_UPDATE_TARGET,
  releaseRoot = path.join(os.homedir(), '.local', 'share', 'bzzy'), run = spawnSync, lifecycle, lockHeld = false } = {}) {
  const release = lockHeld ? () => {} : installationLock();
  try { return await installPackaged(directory, { expectedCommit, releaseRoot, run, lifecycle }); }
  finally { release(); }
}

async function installPackaged(directory, { expectedCommit, releaseRoot, run, lifecycle }) {
  const cwd = fs.realpathSync(directory);
  if (!isPackagedInstallation(cwd)) throw new Error('This is not an installed BZZY package.');
  const git = (args, location = cwd) => command(run, 'git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: location });
  const head = parseUpdateHead(git(['ls-remote', '--symref', updateRepository, 'HEAD']));
  const target = expectedCommit || head.target;
  if (!revision(target)) throw new Error('Invalid checked BZZY revision.');
  fs.mkdirSync(releaseRoot, { recursive: true, mode: 0o700 });
  const owner = fs.lstatSync(releaseRoot);
  if (!owner.isDirectory() || owner.isSymbolicLink() || owner.mode & 0o022 || process.getuid && owner.uid !== process.getuid()) throw new Error('Use an owner-controlled BZZY release directory.');
  const checkout = path.join(releaseRoot, 'checkout');
  let needsMerge = false;
  if (fs.existsSync(checkout)) {
    const stat = fs.lstatSync(checkout);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !officialRepository(git(['remote', 'get-url', 'origin'], checkout))) throw new Error('The managed update checkout is unavailable or has an unexpected origin.');
    if (git(['status', '--porcelain', '--untracked-files=normal'], checkout)) throw new Error('The managed BZZY checkout has local changes. Commit or stash them before updating.');
    if (git(['symbolic-ref', '--quiet', '--short', 'HEAD'], checkout) !== head.branch) throw new Error('The managed BZZY checkout is not on its default branch.');
    git(['fetch', '--no-tags', 'origin', target], checkout);
    git(['merge-base', '--is-ancestor', 'HEAD', target], checkout);
    needsMerge = true;
  } else {
    const stage = fs.mkdtempSync(path.join(releaseRoot, '.update-'));
    try {
      git(['clone', '--no-checkout', '--origin', 'origin', updateRepository, path.join(stage, 'source')]);
      const source = path.join(stage, 'source');
      git(['fetch', '--no-tags', 'origin', target], source);
      git(['checkout', '-B', head.branch, target], source);
      git(['branch', '--set-upstream-to', `origin/${head.branch}`, head.branch], source);
      fs.renameSync(source, checkout);
    } finally { fs.rmSync(stage, { recursive: true, force: true }); }
  }
  if (!needsMerge && git(['rev-parse', 'HEAD'], checkout) !== target) throw new Error('Could not verify the checked BZZY update revision.');
  const next = path.join(checkout, 'BZZY-CLI', 'BZZY-CLI-TERMINAL');
  for (const entry of ['BZZY-CORE/package.json', 'BZZY-RELAY/package.json', 'BZZY-CLI/BZZY-CLI-TERMINAL/install.sh']) git(['cat-file', '-e', `${target}:${entry}`], checkout);
  const binDir = process.env.BZZY_BIN_DIR || process.env.BZZY_LAUNCHER_BIN_DIR || path.join(os.homedir(), '.local', 'bin');
  const backups = new Map();
  for (const name of ['bzzy', 'bzzy-core']) {
    const file = path.join(binDir, name);
    if (!fs.existsSync(file)) continue;
    const stat = fs.lstatSync(file), body = fs.readFileSync(file, 'utf8');
    if (!stat.isFile() || stat.isSymbolicLink() || !body.includes('# bzzy-managed launcher')) throw new Error('An unrelated launcher occupies the BZZY install location.');
    backups.set(file, { body, mode: stat.mode & 0o777 });
  }
  process.stdout.write(`Updating BZZY CLI and Core from GitHub (${target.slice(0, 8)})…\n`);
  return withPausedCore(cwd, () => {
    try {
      // An existing managed checkout may be the running installation. Fetch
      // first, but change its working tree only after Core has stopped.
      if (needsMerge) git(['merge', '--ff-only', '--no-edit', target], checkout);
      if (git(['rev-parse', 'HEAD'], checkout) !== target) throw new Error('Could not verify the checked BZZY update revision.');
      command(run, 'bash', [path.join(next, 'install.sh')], { cwd: next, stdio: 'inherit', timeout: 240000,
        env: { ...commandEnvironment(), BZZY_BIN_DIR: binDir } });
    } catch (error) {
      for (const [file, backup] of backups) fs.writeFileSync(file, backup.body, { mode: backup.mode });
      throw error;
    }
    process.stdout.write('BZZY CLI and Core are up to date. Run: bzzy\n');
    return { directory: next, code: 0 };
  }, { run, lifecycle });
}
