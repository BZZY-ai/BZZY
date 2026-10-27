// Explicit LOCAL installation policy, never a model tool or portable grant.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { home, writeJson } from './files.js';

const failure = (code, message) => Object.assign(new Error(message), { code });
const policyFile = directory => path.join(directory, 'root-execution.json');
export function assertRootExecutable(file) {
  let current = fs.realpathSync(file);
  for (;;) {
    const stat = fs.lstatSync(current);
    if (stat.uid !== 0 || stat.mode & 0o022 || stat.isSymbolicLink() || !stat.isFile() && !stat.isDirectory()) {
      throw failure('SERVICE_PRIVATE_PATH_REQUIRED', 'Root execution requires root-owned code and parent directories that other accounts cannot modify. Install a fresh release under root’s home.');
    }
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
}
export function rootExecutionAllowed({ platform = process.platform, uid = process.getuid?.(), coreHome = home() } = {}) {
  if (platform !== 'linux' || uid !== 0) return false;
  let descriptor;
  try {
    const directory = fs.realpathSync(coreHome), root = fs.lstatSync(coreHome);
    if (!root.isDirectory() || root.isSymbolicLink() || root.uid !== 0 || root.mode & 0o077) return false;
    assertRootExecutable(directory);
    descriptor = fs.openSync(policyFile(directory), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== 0 || stat.mode & 0o077 || stat.size > 4096) return false;
    const buffer = Buffer.alloc(4097), bytes = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    if (bytes !== stat.size) return false;
    const policy = JSON.parse(buffer.subarray(0, bytes).toString('utf8'));
    return policy.version === 1 && policy.mode === 'linux-root' && policy.uid === 0 && policy.coreHome === directory;
  } catch { return false; }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}
export function authorizeRootExecution({ platform = process.platform, uid = process.getuid?.(), coreHome = home() } = {}) {
  if (platform !== 'linux' || uid !== 0 || process.getuid?.() !== 0) throw failure('SERVICE_NON_ROOT_REQUIRED', '--allow-root is available only to the root account on Linux.');
  const directory = path.resolve(coreHome);
  if (directory === path.parse(directory).root || directory === path.resolve(os.homedir())) throw failure('SERVICE_PATH_INVALID', 'Choose a separate private BZZY_HOME.');
  // Validate existing ancestors before creating state; never adopt another
  // account’s code, credentials, private home or host identity.
  let ancestor = directory;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  assertRootExecutable(ancestor);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || stat.mode & 0o077) throw failure('SERVICE_PRIVATE_PATH_REQUIRED', 'Root execution requires its own root-owned private BZZY_HOME (mode 700).');
  if (!rootExecutionAllowed({ platform, uid, coreHome: directory })) writeJson(policyFile(directory), {
    version: 1, mode: 'linux-root', uid: 0, coreHome: fs.realpathSync(directory), authorizedAt: new Date().toISOString(),
  });
  return { allowed: true, mode: 'linux-root', coreHome: fs.realpathSync(directory) };
}
