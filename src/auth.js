import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { home } from './files.js';
import { backendCommand, runtimeEnv } from './process.js';

export function codexHome(provider) {
  return path.resolve(process.env.BZZY_CODEX_HOME || (provider?.auth === 'api-key'
    ? path.join(home(), 'codex-api') : process.env.CODEX_HOME || path.join(os.homedir(), '.codex')));
}
export function claudeHome() {
  return path.resolve(process.env.BZZY_CLAUDE_HOME || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
}
export function subscriptionEnvironment(backend) {
  const env = runtimeEnv();
  const keys = backend === 'claude'
    ? ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDECODE']
    : ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'OPENAI_BASE_URL', 'OPENAI_API_BASE'];
  for (const key of keys) env[key] = undefined;
  if (backend === 'codex') env.CODEX_HOME = codexHome();
  else if (process.env.BZZY_CLAUDE_HOME) env.CLAUDE_CONFIG_DIR = claudeHome();
  return env;
}
// Ask the official CLI about its store; bzzy never parses or copies OAuth tokens.
export function subscriptionStatus(provider, { directory } = {}) {
  if (provider.auth !== 'subscription') return { available: false };
  try {
    const args = provider.backend === 'claude' ? ['auth', 'status', '--json'] : ['login', 'status'];
    const env = subscriptionEnvironment(provider.backend);
    if (directory) env[provider.backend === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'] = directory;
    const result = spawnSync(backendCommand(provider.backend), args, { env, encoding: 'utf8', timeout: 10000, maxBuffer: 65536, windowsHide: true });
    if (result.error || result.status !== 0) return { available: false };
    if (provider.backend === 'codex') return { available: /Logged in using ChatGPT/i.test(result.stdout + result.stderr) };
    const status = JSON.parse(result.stdout);
    return { available: status.loggedIn === true && ['claude.ai', 'oauth'].includes(status.authMethod) };
  } catch { return { available: false }; }
}
