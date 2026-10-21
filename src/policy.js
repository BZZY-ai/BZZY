import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync, spawn } from 'node:child_process';
import { inside } from './evidence.js';
import { normalizePolicy } from './contracts.js';
import { home, privateDir } from './files.js';

let sandboxAvailable;
export function sandboxSupport() {
  if (sandboxAvailable === undefined) {
    const result = process.platform === 'linux' ? spawnSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--unshare-pid', '--die-with-parent', '--', '/bin/true'], { timeout: 5000, stdio: 'ignore' }) : null;
    sandboxAvailable = result?.status === 0;
  }
  return sandboxAvailable;
}
export function requireSandbox(feature = 'Enforced task policies') {
  if (!sandboxSupport()) throw Object.assign(new Error(`${feature} require Linux bubblewrap with working user namespaces. This platform cannot enforce worker isolation; no backend was started. Solo chat and ordinary solo goals are available.`), { code: 'UNSUPPORTED_POLICY' });
}
export function effectivePolicy(session, options = {}) {
  const policy = normalizePolicy(options.policy || session.contract?.policy);
  if (options.readOnly) { policy.mode = 'read-only'; policy.writablePaths = []; }
  if (options.yolo && policy.mode === 'read-only') throw new Error('--yolo conflicts with enforced read-only access.');
  return policy;
}
export function childPolicy(parent, requested) {
  const child = normalizePolicy(requested || parent);
  if (parent.mode === 'read-only' && child.mode !== 'read-only') throw new Error('Worker cannot widen the parent’s read-only permissions.');
  if (parent.network === 'disabled' && child.network !== 'disabled') throw new Error('Worker cannot enable network access denied to its parent.');
  if (child.writablePaths.some(p => !parent.writablePaths.some(root => root === '.' || p === root || p.startsWith(root + '/')))) throw new Error('Worker writable paths exceed the parent’s authorization.');
  return child;
}
export function sandboxCommand(command, args, { cwd, policy, writable = [], readable = [], inference = false } = {}) {
  if (!policy) return { command, args };
  if (!sandboxSupport()) throw Object.assign(new Error('Enforced task permissions require Linux bubblewrap with working user namespaces. No unrestricted fallback was launched.'), { code: 'UNSUPPORTED_POLICY' });
  const mounts = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--unshare-pid', '--die-with-parent'];
  for (const root of [...new Set([cwd, ...readable])]) if (fs.existsSync(root)) mounts.push('--ro-bind', fs.realpathSync(root), fs.realpathSync(root));
  if (policy.network === 'disabled' && !inference) mounts.push('--unshare-net');
  const roots = [...writable];
  if (policy.mode === 'workspace-write') roots.push(...policy.writablePaths.map(relative => inside(cwd, relative, { exists: false })));
  for (const root of [...new Set(roots)]) {
    if (!fs.existsSync(root)) privateDir(root);
    mounts.push('--bind', fs.realpathSync(root), fs.realpathSync(root));
  }
  return { command: 'bwrap', args: [...mounts, '--chdir', cwd, '--', command, ...args] };
}
export function backendIsolation(name, env, cwd, policy) {
  if (!policy) return null;
  if (name === 'claude' && policy.network === 'disabled') throw Object.assign(new Error('This Claude adapter cannot enforce disabled tool networking while preserving model connectivity. Choose a compatible policy or the Codex backend.'), { code: 'UNSUPPORTED_POLICY' });
  const writable = name === 'codex' ? [env.CODEX_HOME || path.join(home(), 'codex')] : [env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')];
  const config = path.join(os.homedir(), '.claude.json');
  if (name === 'claude' && !env.CLAUDE_CONFIG_DIR && fs.existsSync(config)) writable.push(config);
  return { cwd, policy, writable, readable: [path.join(home(), 'runtime'), path.join(home(), 'traffic-ca')], inference: true };
}
export function spawnBounded(command, args, options) {
  const prepared = sandboxCommand(command, args, options);
  return spawn(prepared.command, prepared.args, { cwd: options.cwd, env: options.env || process.env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], shell: false });
}
export function stopProcess(child, signal = 'SIGTERM') {
  if (!child || child.exitCode != null || child.signalCode != null) return;
  try { if (process.platform !== 'win32') process.kill(-child.pid, signal); else child.kill(signal); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}
