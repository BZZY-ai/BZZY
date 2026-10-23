import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync, spawn } from 'node:child_process';
import { inside } from './evidence.js';
import { normalizePolicy } from './contracts.js';
import { home, privateDir } from './files.js';
import { toolEnvironment } from './execution-environment.js';

let sandboxAvailable;
function seatbeltProfile(writable, disableNetwork) {
  const rules = ['(version 1)', '(allow default)', '(deny file-write*)', '(deny signal)', '(allow signal (target self) (target children))',
    '(deny process-info*)', '(allow process-info* (target self) (target children))', '(deny appleevent-send)',
    '(allow file-write* (literal "/dev/null") (literal "/dev/tty") (subpath "/dev/fd"))'];
  for (const entry of writable) {
    const real = fs.realpathSync(entry);
    if (/[\x00-\x1f\x7f]/.test(real)) throw new Error('Sandbox paths cannot contain control characters.');
    rules.push(`(allow file-write* (${fs.statSync(real).isDirectory() ? 'subpath' : 'literal'} ${JSON.stringify(real)}))`);
  }
  if (disableNetwork) rules.push('(deny network*)');
  return rules.join('\n');
}
function macSandboxProbe() {
  let directory;
  try {
    directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bz-probe-')));
    const allowed = path.join(directory, 'allowed'), blocked = path.join(directory, 'blocked');
    fs.mkdirSync(allowed); fs.writeFileSync(blocked, 'unchanged'); fs.symlinkSync(blocked, path.join(allowed, 'escape'));
    const program = `const fs = require('node:fs'), net = require('node:net'), cp = require('node:child_process');
      fs.writeFileSync(process.argv[1] + '/ok', 'ok');
      for (const file of [process.argv[2], process.argv[1] + '/escape']) {
        try { fs.writeFileSync(file, 'escaped'); process.exit(10); } catch (e) { if (!['EPERM','EACCES'].includes(e.code)) process.exit(11); }
      }
      if (cp.spawnSync('/bin/sh', ['-c', 'printf escaped > "$1"', 'probe', process.argv[2]], {stdio:'ignore'}).status === 0) process.exit(12);
      const socket = net.connect({host:'127.0.0.1',port:9}); socket.on('connect',()=>process.exit(13));
      socket.on('error',e=>process.exit(['EPERM','EACCES'].includes(e.code)?0:14)); setTimeout(()=>process.exit(15),1000).unref();`;
    const result = spawnSync('/usr/bin/sandbox-exec', ['-p', seatbeltProfile([allowed], true), process.execPath, '-e', program, allowed, blocked],
      { timeout: 5000, stdio: 'ignore', env: { PATH: path.dirname(process.execPath) + ':/usr/bin:/bin', HOME: os.homedir(), LANG: 'C' } });
    return result.status === 0 && fs.readFileSync(blocked, 'utf8') === 'unchanged';
  } catch { return false; }
  finally { if (directory) fs.rmSync(directory, { recursive: true, force: true }); }
}
export function sandboxSupport() {
  if (sandboxAvailable === undefined) {
    const result = process.platform === 'linux' ? spawnSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--unshare-pid', '--die-with-parent', '--', '/usr/bin/true'], { timeout: 5000, stdio: 'ignore' }) : null;
    sandboxAvailable = process.platform === 'darwin' ? macSandboxProbe() : result?.status === 0;
  }
  return sandboxAvailable;
}
export function requireSandbox(feature = 'Enforced task policies') {
  if (!sandboxSupport()) throw Object.assign(new Error(`${feature} need a working OS sandbox: bubblewrap with user namespaces on Debian/Ubuntu, or sandbox-exec on macOS. Isolation is unavailable; no unrestricted fallback was started. Solo chat and ordinary solo goals are available.`), { code: 'UNSUPPORTED_POLICY' });
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
  requireSandbox('Enforced task permissions');
  const roots = [...writable];
  if (policy.mode === 'workspace-write') roots.push(...policy.writablePaths.map(relative => inside(cwd, relative, { exists: false })));
  for (const entry of roots) if (!fs.existsSync(entry)) privateDir(entry);
  if (process.platform === 'darwin') {
    const temporaryRoot = path.join(home(), 'runtime', 'sandbox-tmp'); privateDir(temporaryRoot);
    const temporary = fs.mkdtempSync(path.join(temporaryRoot, 'run-'));
    try {
      return { command: '/usr/bin/sandbox-exec', args: ['-p', seatbeltProfile([...roots, temporary], policy.network === 'disabled' && !inference), command, ...args],
        env: { TMPDIR: temporary, TMP: temporary, TEMP: temporary }, cleanup: () => fs.rmSync(temporary, { recursive: true, force: true }) };
    } catch (error) { fs.rmSync(temporary, { recursive: true, force: true }); throw error; }
  }
  const mounts = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--unshare-pid', '--die-with-parent'];
  for (const root of [...new Set([cwd, ...readable])]) if (fs.existsSync(root)) mounts.push('--ro-bind', fs.realpathSync(root), fs.realpathSync(root));
  if (policy.network === 'disabled' && !inference) mounts.push('--unshare-net');
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
  try {
    const child = spawn(prepared.command, prepared.args, { cwd: options.cwd, env: { ...toolEnvironment(options.env || process.env), ...prepared.env }, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    child.once('close', () => prepared.cleanup?.()); return child;
  } catch (error) { prepared.cleanup?.(); throw error; }
}
export function stopProcess(child, signal = 'SIGTERM') {
  if (!child || child.exitCode != null || child.signalCode != null) return;
  try { if (process.platform !== 'win32') process.kill(-child.pid, signal); else child.kill(signal); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}
