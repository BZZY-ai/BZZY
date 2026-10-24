import fs from 'node:fs';
import path from 'node:path';
import { home, writeJson, readJson } from './files.js';

// Configuration names, never values, are declared locally. Unrelated host
// credentials and executable startup hooks are not inherited by default.
const configuration = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
  'TERM', 'COLORTERM', 'NO_COLOR', 'FORCE_COLOR', 'SystemRoot', 'WINDIR', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE',
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'BZZY_HOME', 'BZZY_DIRECT', 'BZZY_CODEX_BIN', 'BZZY_CLAUDE_BIN',
  'CODEX_HOME', 'BZZY_CODEX_HOME', 'BZZY_CLAUDE_HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'BZZY_ENV_ALLOW']);
export function credentialEnvironmentNames() {
  const providers = readJson(path.join(home(), 'config.json'), {}).providers || {};
  return new Set(['DEEPSEEK_API_KEY', 'ABLITERATION_API_KEY', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
    ...Object.values(providers).map(provider => provider.envKey).filter(key => typeof key === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))]);
}

const environmentFile = id => {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid execution ID.');
  return path.join(home(), 'runtime', `${id}-environment.json`);
};
export function captureEnvironment(environment = process.env) {
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) throw new Error('Execution environment must be an object.');
  const entries = Object.entries(environment);
  if (entries.some(([key, value]) => !key || /[=\0]/.test(key) || typeof value !== 'string' || value.includes('\0'))) throw new Error('Invalid execution environment variable.');
  if (Buffer.byteLength(JSON.stringify(environment)) > 192 * 1024) throw new Error('Execution environment exceeds 192 KiB.');
  const configured = readJson(path.join(home(), 'config.json'), {}).executionEnvironment?.allow || [];
  const extra = Array.isArray(configured) ? [...configured, ...(environment.BZZY_ENV_ALLOW || '').split(',').filter(Boolean)] : configured;
  if (!Array.isArray(extra) || extra.some(key => typeof key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || /secret|password|passwd|token|cookie|credential|(?:api|private)[_-]?key/i.test(key))) throw new Error('executionEnvironment.allow must list non-secret environment variable names.');
  const allowed = new Set([...configuration, ...credentialEnvironmentNames(), ...extra]);
  return Object.fromEntries(entries.filter(([key]) => allowed.has(key)));
}
export function toolEnvironment(environment = process.env) {
  const result = captureEnvironment(environment);
  for (const key of credentialEnvironmentNames()) delete result[key];
  return result;
}
export function saveExecutionEnvironment(id, environment) { writeJson(environmentFile(id), captureEnvironment(environment)); }
export function readExecutionEnvironment(id) { return readJson(environmentFile(id), null); }
export function removeExecutionEnvironment(id) { fs.rmSync(environmentFile(id), { force: true }); }
