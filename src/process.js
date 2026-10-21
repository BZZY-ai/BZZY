import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { sandboxCommand } from './policy.js';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const CODEX_VERSION = '0.162.0';

export function assertCodexVersion(installed) {
  const match = /^codex-cli\s+(\d+)\.(\d+)\.(\d+)(?:\b|[-+])/.exec(installed);
  const minimum = CODEX_VERSION.split('.').map(Number), actual = match?.slice(1, 4).map(Number);
  const difference = actual?.map((part, index) => part - minimum[index]).find(part => part !== 0) || 0;
  if (!actual || difference < 0) throw new Error(`bzzy needs Codex ${CODEX_VERSION} or newer; found ${installed}. Set BZZY_CODEX_BIN to an existing compatible executable. bzzy does not install or update backends.`);
}

export function backendCommand(name) {
  const override = process.env[`BZZY_${name.toUpperCase()}_BIN`];
  if (override) return path.resolve(override);
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const file = path.join(dir, name + (process.platform === 'win32' ? '.exe' : ''));
    try { fs.accessSync(file, fs.constants.X_OK); return file; } catch { /* Try the next PATH entry. */ }
  }
  const local = path.join(root, 'node_modules', '.bin', name + (process.platform === 'win32' ? '.cmd' : ''));
  try { fs.accessSync(local, fs.constants.X_OK); return local; } catch { /* Older bzzy installations may already have a local executable. */ }
  throw new Error(`No existing ${name} executable found. Add it to PATH or set BZZY_${name.toUpperCase()}_BIN to its path. bzzy does not install backends.`);
}

export function runtimeEnv(extra = {}) {
  return { ...process.env, ...extra, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}` };
}

export function launch(name, args, options = {}) {
  const { isolation, ...spawnOptions } = options;
  const prepared = sandboxCommand(backendCommand(name), args, isolation || {});
  return spawn(prepared.command, prepared.args, { shell: false, detached: process.platform !== 'win32', ...spawnOptions, env: runtimeEnv(options.env) });
}

export function inherited(name, args, env = {}) {
  const result = spawnSync(backendCommand(name), args, { stdio: 'inherit', shell: false, env: runtimeEnv(env) });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

export function version(name) {
  const result = spawnSync(backendCommand(name), ['--version'], { encoding: 'utf8', timeout: 15000, env: runtimeEnv() });
  if (result.error || result.status !== 0) throw new Error(`${name} could not start: ${result.error?.message || result.stderr.trim()}`);
  return result.stdout.trim();
}
