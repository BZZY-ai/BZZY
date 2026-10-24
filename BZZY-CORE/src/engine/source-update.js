import { officialRepository, isPackagedInstallation, isCoreInstallation, updatePackagedInstallation, updateRepositoryInstallation } from './installation-update.js';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { home, lockFile } from './store.js';
import { installationDirectory } from './update-check.js';
const installationRoot = installationDirectory();

export function updateInstallation(directory = installationRoot, { expectedCommit = process.env.BZZY_UPDATE_TARGET, requireCanonical = directory === installationRoot || process.env.BZZY_UPDATE_CANONICAL === '1' } = {}) {
  if (requireCanonical) return updateCoreAndCLI(directory, { expectedCommit });
  const cwd = fs.realpathSync(directory);
  const workspace = path.resolve(cwd, '../..');
  const isWorkspace = cwd === path.join(workspace, 'BZZY-CLI', 'BZZY-CLI-TERMINAL')
    && ['BZZY-CORE', 'BZZY-RELAY'].every(product => fs.existsSync(path.join(workspace, product, 'package.json')));
  if (!isWorkspace && !fs.existsSync(path.join(cwd, '.git')) && isPackagedInstallation(cwd)) return updatePackagedInstallation(cwd, { expectedCommit });
  const trust = [cwd, ...(isWorkspace ? [workspace] : [])].flatMap(directory => ['-c', `safe.directory=${directory}`]);
  const env = { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}` };
  function git(args, failure) {
    // The launcher may be shared by users (e.g. a root shell using an install
    // owned by another user). Trust only this already-running installation for
    // this Git invocation; never add a global safe.directory exception.
    const result = spawnSync('git', [...trust, ...args], { cwd, env, encoding: 'utf8', timeout: 120000 });
    if (result.error || result.status !== 0) {
      throw new Error(`${failure}${result.error ? `: ${result.error.message}` : result.stderr.trim() ? `: ${result.stderr.trim()}` : '.'}`);
    }
    return result.stdout.trim();
  }

  const top = git(['rev-parse', '--show-toplevel'], 'Updating requires a Git checkout. Install bzzy with git clone and ./install.sh');
  const repository = fs.realpathSync(top);
  if (repository !== cwd && !(isWorkspace && repository === workspace)) {
    throw new Error('The bzzy installation must be its own Git checkout or part of the complete BZZY workspace. Install with git clone and ./install.sh.');
  }
  git(['symbolic-ref', '--quiet', '--short', 'HEAD'], 'Cannot update a detached checkout. Switch to your tracked branch first');
  if (git(['status', '--porcelain', '--untracked-files=normal'], 'Could not inspect the installation')) {
    throw new Error('The bzzy installation has uncommitted changes. Commit or stash them before running bzzy --update.');
  }
  git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], 'No upstream branch configured for the bzzy installation');

  if (requireCanonical && !officialRepository(git(['remote', 'get-url', 'origin'], 'Could not inspect update source'))) throw new Error('Updates must come from BZZY-ai/BZZY on GitHub.');
  if (expectedCommit && !/^[a-f0-9]{40,64}$/.test(expectedCommit)) throw new Error('Invalid checked update revision.');
  process.stdout.write('Updating BZZY CLI and Core...\n');
  if (expectedCommit) git(['fetch', '--no-tags', 'origin', expectedCommit], 'Could not fetch the checked BZZY revision');
  const output = git(expectedCommit ? ['merge', '--ff-only', '--no-edit', expectedCommit] : ['pull', '--ff-only', '--no-rebase', '--no-autostash'], 'Update failed; resolve the Git error in the bzzy installation and retry');
  if (expectedCommit && git(['rev-parse', 'HEAD'], 'Could not verify installed revision') !== expectedCommit) throw new Error('Update revision changed. Installation was not run.');
  if (output) process.stdout.write(`${output}\n`);
  const binDir = process.env.BZZY_BIN_DIR || process.env.BZZY_LAUNCHER_BIN_DIR;
  const result = spawnSync('bash', [path.join(cwd, 'install.sh')], {
    cwd, timeout: 240000, env: { ...env, ...(binDir ? { BZZY_BIN_DIR: binDir } : {}) }, stdio: 'inherit',
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Latest source downloaded, but installation failed${result.error ? `: ${result.error.message}` : ` (exit ${result.status ?? result.signal})`}. Run ./install.sh in ${cwd} to retry.`);
  }
  process.stdout.write('bzzy is up to date. Run: bzzy\n');
  return 0;
}

// Interactive/command entry point coordinates the service as well as source.
export async function updateCoreAndCLI(directory = installationRoot, { expectedCommit = process.env.BZZY_UPDATE_TARGET } = {}) {
  if (!directory) throw new Error('A combined BZZY installation is required for updates.');
  const release = lockFile(path.join(home(), 'runtime', 'installation-update.lock'), 'Another BZZY installation update is already running.');
  try {
    const workspace = path.resolve(directory, '../..');
    const fullWorkspace = path.resolve(directory) === path.join(workspace, 'BZZY-CLI', 'BZZY-CLI-TERMINAL') && fs.existsSync(path.join(workspace, 'BZZY-CORE', 'package.json'));
    if (!fullWorkspace && (isPackagedInstallation(directory) || isCoreInstallation(directory))) return await updatePackagedInstallation(directory, { expectedCommit, lockHeld: true });
    const { checkInstallationUpdate } = await import('./update-check.js');
    const check = await checkInstallationUpdate({ directory });
    if (check.blocked) throw new Error(check.blocked);
    return await updateRepositoryInstallation(directory, { expectedCommit: expectedCommit || check.target, lockHeld: true });
  } finally { release(); }
}
