import { checkPackagedUpdate, isPackagedInstallation, officialRepository, updateRepository, parseUpdateHead } from './installation-update.js';
export { officialRepository, updateRepository } from './installation-update.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { lockFile, home } from './store.js';

export function installationDirectory() {
  const core = fileURLToPath(new URL('../../', import.meta.url));
  const workspace = path.resolve(core, '../BZZY-CLI/BZZY-CLI-TERMINAL');
  if (fs.existsSync(path.join(workspace, 'package.json'))) return workspace;
  const packaged = path.resolve(core, '../../..');
  return isPackagedInstallation(packaged) ? packaged : null;
}
export function runUpdateCommand(command, args, { cwd, signal, inherit = false, target } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'], signal,
      env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}`, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', ...(target ? { BZZY_UPDATE_TARGET: target, BZZY_UPDATE_CANONICAL: '1' } : {}) } });
    let output = '';
    child.stdout?.on('data', chunk => { output = (output + chunk).slice(-16384); });
    child.stderr?.resume();
    child.once('error', () => reject(new Error('Update command could not start. Check Git, network access and installation permissions.')));
    child.once('close', code => code === 0 ? resolve(output.trim()) : reject(new Error('Update command failed. Check repository access and the installation; private Git credentials are never requested in chat.')));
  });
}

export async function checkInstallationUpdate({ directory = installationDirectory(), run = runUpdateCommand, signal = AbortSignal.timeout(12000) } = {}) {
  if (!directory) throw new Error('A complete CLI/Core installation is required for combined updates.');
  const cwd = fs.realpathSync(directory), workspace = path.resolve(cwd, '../..');
  if (cwd !== path.join(workspace, 'BZZY-CLI', 'BZZY-CLI-TERMINAL') || !fs.existsSync(path.join(workspace, 'BZZY-CORE', 'package.json'))) {
    if (isPackagedInstallation(cwd)) return checkPackagedUpdate(cwd, { run, signal });
    throw new Error('Combined updates require a BZZY workspace or an installed BZZY package.');
  }
  const git = args => run('git', ['-c', `safe.directory=${workspace}`, ...args], { cwd: workspace, signal });
  if (fs.realpathSync(await git(['rev-parse', '--show-toplevel'])) !== workspace) throw new Error('The installation is not a complete BZZY checkout.');
  const [head, branch, origin, dirty] = await Promise.all([
    git(['rev-parse', 'HEAD']), git(['symbolic-ref', '--quiet', '--short', 'HEAD']), git(['remote', 'get-url', 'origin']), git(['status', '--porcelain', '--untracked-files=normal']),
  ]);
  if (!officialRepository(origin)) throw new Error('The installation origin must be BZZY-ai/BZZY on GitHub.');
  const remote = await git(['ls-remote', '--symref', 'origin', 'HEAD']);
  const { target, branch: targetBranch } = parseUpdateHead(remote);
  const blocked = dirty ? 'Local changes must be committed or stashed before updating.' : branch !== targetBranch ? `Switch the installation to ${targetBranch} before updating.` : null;
  let ahead = false;
  if (head !== target) { try { await git(['merge-base', '--is-ancestor', target, head]); ahead = true; } catch {} }
  return { repository: updateRepository, current: head, target, branch: targetBranch, available: head !== target && !ahead, blocked: blocked || (ahead ? 'This checkout is ahead of GitHub. No downgrade will be performed.' : null), checkedAt: Date.now(), directory: cwd };
}

export async function applyInstallationUpdate(check, { run = runUpdateCommand } = {}) {
  if (!check || check.blocked || !check.available || !/^[a-f0-9]{40,64}$/.test(check.target)) throw new Error('Check for an available update before installing.');
  const release = lockFile(path.join(home(), 'runtime', 'update.lock'), 'Another BZZY update is in progress.');
  try {
    const fresh = await checkInstallationUpdate({ directory: check.directory, run });
    if (fresh.blocked || fresh.current !== check.current || fresh.target !== check.target) throw new Error('The installation or GitHub revision changed. Check again before updating.');
    // The child exits after replacing both products; it never continues a chat
    // with a mixture of old in-memory code and newly installed source.
    return await run(process.execPath, [fileURLToPath(new URL('../../bin/bzzy-core.js', import.meta.url)), 'update'], { cwd: check.directory, inherit: true,
      signal: AbortSignal.timeout(300000), target: check.target });
  } finally { release(); }
}
