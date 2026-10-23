import fs from 'node:fs';
import path from 'node:path';
import { root, CODEX_VERSION } from './process.js';
import { home } from './files.js';
import { codexHome, claudeHome } from './auth.js';

export function whoami(cwd = process.cwd()) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const locations = [
    ['Installation', root], ['Working directory', path.resolve(cwd)], ['Private bzzy state (BZZY_HOME)', home()],
    ['Project records', path.join(path.resolve(cwd), '.bzzy')], ['Codex subscription home', codexHome()],
    ['Codex API-provider home', codexHome({ auth: 'api-key' })], ['Claude configuration home', claudeHome()],
  ].map(([label, value]) => `- ${label}: ${JSON.stringify(value)}`).join('\n');
  return `# bzzy ${pkg.version} — reference for humans and AI integrations

Node requirement: ${pkg.engines.node}. Codex CLI baseline: ${CODEX_VERSION} or newer.
Public API version: 1. This describes the installed build; it is not a live health check.

## Resolved locations for this invocation

${locations}

Only locations are reported. Configuration, credentials, tokens, transcripts and
private account contents are not read or printed. This command starts no backend,
runtime, login, session or network request and creates no state directories.

${fs.readFileSync(path.join(root, 'docs/WHOAMI.md'), 'utf8').trim()}

${fs.readFileSync(path.join(root, 'docs/INTEGRATION.md'), 'utf8').trim()}
`;
}
