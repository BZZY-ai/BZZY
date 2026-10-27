import { checkPackagedUpdate, isPackagedInstallation, isCoreInstallation, officialRepository, updateRepository, parseUpdateHead } from './installation-update.js';
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
  return isPackagedInstallation(packaged) ? packaged : isCoreInstallation(core) ? core : null;
}
const commandStage = (command, args) => path.basename(command) === 'git' ? args.includes('ls-remote') ? 'remote' : 'git' : command === process.execPath ? 'updater' : 'command';
const commandLabels = { remote: 'GitHub update check', git: 'Git inspection', updater: 'BZZY updater', command: 'Update command' };
const commandFailure = (stage, code, message, extra = {}) => Object.assign(new Error(message), { code, stage, ...extra });
function interruptedCommand(stage, signal) {
  const timedOut = signal?.reason?.name === 'TimeoutError', label = commandLabels[stage];
  const help = stage === 'remote' ? "Check network access and this account's GitHub authentication, then retry."
    : stage === 'git' ? 'Check Git and the installation directory, then retry.' : 'Check the host and installation status before retrying.';
  return timedOut ? commandFailure(stage, 'UPDATE_TIMEOUT', `${label} timed out. ${help}`)
    : commandFailure(stage, 'UPDATE_CANCELLED', `${label} was cancelled.`, { name: 'AbortError' });
}
function startFailure(stage, error) {
  const label = commandLabels[stage];
  if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return commandFailure(stage, 'UPDATE_COMMAND_NOT_FOUND',
    `${label} could not start (${error.code}). Check that the executable is installed and the installation directory still exists.`);
  if (error?.code === 'EACCES' || error?.code === 'EPERM') return commandFailure(stage, 'UPDATE_COMMAND_PERMISSION',
    `${label} could not start (${error.code}). Check executable and installation-directory permissions.`);
  return commandFailure(stage, 'UPDATE_COMMAND_START_FAILED', `${label} could not start. Check the host's available resources and installation.`);
}

export function runUpdateCommand(command, args, { cwd, signal, inherit = false, target, timeoutMs } = {}) {
  if (typeof command !== 'string' || !Array.isArray(args)) return Promise.reject(commandFailure('command', 'UPDATE_COMMAND_INVALID', 'Invalid update command.'));
  const stage = commandStage(command, args);
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000)) {
    return Promise.reject(commandFailure(stage, 'UPDATE_COMMAND_INVALID', 'Invalid update-command deadline.'));
  }
  const deadline = timeoutMs === undefined ? null : AbortSignal.timeout(timeoutMs);
  const combined = signal && deadline ? AbortSignal.any([signal, deadline]) : signal || deadline || undefined;
  return new Promise((resolve, reject) => {
    if (combined?.aborted) { reject(interruptedCommand(stage, combined)); return; }
    let child;
    try {
      child = spawn(command, args, { cwd, shell: false, stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'], signal: combined,
        env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}`, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', ...(target ? { BZZY_UPDATE_TARGET: target, BZZY_UPDATE_CANONICAL: '1' } : {}) } });
    } catch (error) { reject(combined?.aborted ? interruptedCommand(stage, combined) : startFailure(stage, error)); return; }
    let output = '';
    child.stdout?.on('data', chunk => { output = (output + chunk).slice(-16384); });
    child.stderr?.resume();
    child.once('error', error => reject(combined?.aborted || error.name === 'AbortError' ? interruptedCommand(stage, combined) : startFailure(stage, error)));
    child.once('close', code => {
      if (combined?.aborted) { reject(interruptedCommand(stage, combined)); return; }
      if (code === 0) { resolve(output.trim()); return; }
      const exit = Number.isSafeInteger(code) && code >= 0 ? ` (exit ${code})` : '';
      reject(commandFailure(stage, 'UPDATE_COMMAND_FAILED', `${commandLabels[stage]} failed${exit}. Check repository access and the installation; private Git credentials are never requested in chat.`,
        Number.isSafeInteger(code) && code >= 0 ? { exitCode: code } : {}));
    });
  });
}

export async function checkInstallationUpdate({ directory = installationDirectory(), run = runUpdateCommand, signal } = {}) {
  if (!directory) throw new Error('A complete CLI/Core installation is required for combined updates.');
  const cwd = fs.realpathSync(directory), workspace = path.resolve(cwd, '../..');
  const checkedRun = (command, args, options = {}) => run(command, args, { ...options, signal,
    timeoutMs: args.includes('ls-remote') ? 60000 : 10000 });
  if (cwd !== path.join(workspace, 'BZZY-CLI', 'BZZY-CLI-TERMINAL') || !fs.existsSync(path.join(workspace, 'BZZY-CORE', 'package.json'))) {
    if (isPackagedInstallation(cwd) || isCoreInstallation(cwd)) return checkPackagedUpdate(cwd, { run: checkedRun, signal });
    throw new Error('Combined updates require a BZZY workspace or an installed BZZY package.');
  }
  const git = args => checkedRun('git', ['-c', `safe.directory=${workspace}`, ...args], { cwd: workspace });
  if (fs.realpathSync(await git(['rev-parse', '--show-toplevel'])) !== workspace) throw new Error('The installation is not a complete BZZY checkout.');
  const [head, origin] = await Promise.all([git(['rev-parse', 'HEAD']), git(['remote', 'get-url', 'origin'])]);
  if (!officialRepository(origin)) throw new Error('The installation origin must be BZZY-ai/BZZY on GitHub.');
  const remote = await git(['ls-remote', '--symref', 'origin', 'HEAD']);
  const { target, branch: targetBranch } = parseUpdateHead(remote);
  // The source is retained verbatim. Installation switches launchers to a new
  // official release, so local edits, branches and detached HEADs need no repair.
  return { repository: updateRepository, current: head, target, branch: targetBranch, available: head !== target, blocked: null, checkedAt: Date.now(), directory: cwd };
}

export async function applyInstallationUpdate(check, { run = runUpdateCommand, inherit = true } = {}) {
  if (!check || check.blocked || !check.available || !/^[a-f0-9]{40,64}$/.test(check.target)) throw new Error('Check for an available update before installing.');
  const release = lockFile(path.join(home(), 'runtime', 'update.lock'), 'Another BZZY update is in progress.');
  try {
    const fresh = await checkInstallationUpdate({ directory: check.directory, run });
    if (fresh.blocked || fresh.current !== check.current || fresh.target !== check.target) throw new Error('The installation or GitHub revision changed. Check again before updating.');
    // The child exits after replacing both products; it never continues a chat
    // with a mixture of old in-memory code and newly installed source.
    return await run(process.execPath, [fileURLToPath(new URL('../../bin/bzzy-core.js', import.meta.url)), 'update'], { cwd: check.directory, inherit,
      signal: AbortSignal.timeout(300000), target: check.target });
  } finally { release(); }
}
