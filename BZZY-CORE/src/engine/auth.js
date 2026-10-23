import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { home } from './files.js';
import { backendCommand, runtimeEnv } from './process.js';
import { credentialEnvironmentNames } from './execution-environment.js';

export function codexHome(provider) {
  return path.resolve(process.env.BZZY_CODEX_HOME || (provider?.auth === 'api-key'
    ? path.join(home(), 'codex-api') : process.env.CODEX_HOME || path.join(os.homedir(), '.codex')));
}
export function claudeHome(backendHomes) {
  let directory = process.env.BZZY_CLAUDE_HOME ? path.resolve(process.env.BZZY_CLAUDE_HOME) : process.env.CLAUDE_CONFIG_DIR;
  if (Object.hasOwn(backendHomes || {}, 'claudeConfigDir')) directory = backendHomes.claudeConfigDir;
  return path.resolve(directory || path.join(os.homedir(), '.claude'));
}
export function subscriptionEnvironment(backend, { backendHomes, directory } = {}) {
  const env = runtimeEnv();
  for (const key of credentialEnvironmentNames()) env[key] = undefined;
  const keys = backend === 'claude'
    ? ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDECODE']
    : ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'OPENAI_BASE_URL', 'OPENAI_API_BASE'];
  for (const key of keys) env[key] = undefined;
  if (backend === 'codex') env.CODEX_HOME = directory ?? codexHome();
  else {
    // On macOS these values identify Keychain entries. Unset, empty, and an
    // explicit ~/.claude are different identities; never infer or normalize one.
    if (process.env.BZZY_CLAUDE_HOME) env.CLAUDE_CONFIG_DIR = path.resolve(process.env.BZZY_CLAUDE_HOME);
    if (Object.hasOwn(backendHomes || {}, 'claudeConfigDir')) env.CLAUDE_CONFIG_DIR = backendHomes.claudeConfigDir ?? undefined;
    if (Object.hasOwn(backendHomes || {}, 'claudeSecureStorageConfigDir')) env.CLAUDE_SECURESTORAGE_CONFIG_DIR = backendHomes.claudeSecureStorageConfigDir ?? undefined;
    if (directory !== undefined) env.CLAUDE_CONFIG_DIR = directory ?? undefined;
  }
  return env;
}
export function claudeAuthHomes() {
  const env = subscriptionEnvironment('claude');
  return { claudeConfigDir: env.CLAUDE_CONFIG_DIR ?? null, claudeSecureStorageConfigDir: env.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? null };
}
// Ask the official CLI about its store; bzzy never parses or copies OAuth tokens.
export function subscriptionStatus(provider, { directory, backendHomes, diagnostic = false } = {}) {
  if (provider.auth !== 'subscription') return { available: false };
  const unavailable = reason => diagnostic ? { available: false, reason } : { available: false };
  try {
    const args = provider.backend === 'claude' ? ['auth', 'status', '--json'] : ['login', 'status'];
    const env = subscriptionEnvironment(provider.backend, { directory, backendHomes });
    const result = spawnSync(backendCommand(provider.backend), args, { env, encoding: 'utf8', timeout: 10000, maxBuffer: 65536, windowsHide: true });
    if (result.error || result.status !== 0) return unavailable(result.error?.code === 'ETIMEDOUT'
      ? `The ${provider.backend} login-status check timed out after 10s. Try ${provider.backend} ${args.join(' ')} directly.`
      : `The ${provider.backend} login-status command failed${result.status != null ? ` (exit ${result.status})` : ''}. Run bzzy auth ${provider.id}.`);
    if (provider.backend === 'codex') return /Logged in using ChatGPT/i.test(result.stdout + result.stderr)
      ? { available: true } : unavailable('The Codex CLI does not report a ChatGPT subscription login. Run bzzy auth codex.');
    const status = JSON.parse(result.stdout);
    return status.loggedIn === true && ['claude.ai', 'oauth'].includes(status.authMethod)
      ? { available: true } : unavailable('The Claude CLI does not report a subscription login. Run bzzy auth claude.');
  } catch { return unavailable(`Could not read the official ${provider.backend} login status. Run bzzy auth ${provider.id}.`); }
}
