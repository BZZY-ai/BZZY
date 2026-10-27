import path from 'node:path';

// A deterministic exclusion for known private stores. It is not a proof that
// arbitrary project files are free of private data, or an OS read sandbox.
const privateDirectories = new Set(['.ssh', '.aws', '.azure', '.gnupg', '.kube', '.codex', '.claude', '.bzzy', '.bzzy-runtime']);
const privateNames = new Set(['.env', '.netrc', '_netrc', '.npmrc', '.pypirc', '.git-credentials', '.boto', '.claude.json',
  'auth.json', 'root-execution.json', 'credentials.json', 'credentials.db', 'cookies.sqlite', 'cookies.txt', 'login.keychain-db', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519']);
export function privateWorkspacePath(relative) {
  const parts = relative.split(/[\\/]/).map(part => part.toLowerCase());
  return parts.some(part => privateDirectories.has(part) || privateNames.has(part) || part.startsWith('.env.') || part.startsWith('._') || /\.(?:pem|key|p12|pfx|keychain|keychain-db)$/.test(part))
    || parts.some((part, i) => part === '.config' && ['gcloud', 'gh'].includes(parts[i + 1]) || part === '.docker' && parts[i + 1] === 'config.json');
}
export function assertPublicWorkspacePath(relative) {
  if (privateWorkspacePath(relative)) throw new Error(`Private credential paths cannot be captured as task evidence: ${JSON.stringify(path.basename(relative))}`);
}
