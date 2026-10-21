import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const installationRoot = fileURLToPath(new URL('../', import.meta.url));

export function updateInstallation(directory = installationRoot) {
  const cwd = fs.realpathSync(directory);
  const env = { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}` };
  function git(args, failure) {
    const result = spawnSync('git', args, { cwd, env, encoding: 'utf8', timeout: 120000 });
    if (result.error || result.status !== 0) {
      throw new Error(`${failure}${result.error ? `: ${result.error.message}` : result.stderr.trim() ? `: ${result.stderr.trim()}` : '.'}`);
    }
    return result.stdout.trim();
  }

  const top = git(['rev-parse', '--show-toplevel'], 'Updating requires a Git checkout. Install bzzy with git clone and ./install.sh');
  if (fs.realpathSync(top) !== cwd) throw new Error('The bzzy installation must be its own Git checkout. Install with git clone and ./install.sh.');
  git(['symbolic-ref', '--quiet', '--short', 'HEAD'], 'Cannot update a detached checkout. Switch to your tracked branch first');
  if (git(['status', '--porcelain', '--untracked-files=normal'], 'Could not inspect the installation')) {
    throw new Error('The bzzy installation has uncommitted changes. Commit or stash them before running bzzy --update.');
  }
  git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], 'No upstream branch configured for the bzzy installation');

  process.stdout.write('Updating bzzy...\n');
  const output = git(['pull', '--ff-only', '--no-rebase', '--no-autostash'], 'Update failed; resolve the Git error in the bzzy installation and retry');
  if (output) process.stdout.write(`${output}\n`);
  const binDir = process.env.BZZY_BIN_DIR || process.env.BZZY_LAUNCHER_BIN_DIR;
  const result = spawnSync('bash', [path.join(cwd, 'install.sh')], {
    cwd, env: { ...env, ...(binDir ? { BZZY_BIN_DIR: binDir } : {}) }, stdio: 'inherit',
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Latest source downloaded, but installation failed${result.error ? `: ${result.error.message}` : ` (exit ${result.status ?? result.signal})`}. Run ./install.sh in ${cwd} to retry.`);
  }
  process.stdout.write('bzzy is up to date. Run: bzzy\n');
  return 0;
}
