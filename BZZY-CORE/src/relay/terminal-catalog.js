import path from 'node:path';
import os from 'node:os';
import { home } from '../engine/files.js';
import { sessionDeleted } from '../engine/store.js';
import { canonicalPath, contains } from '../paths.js';

// A catalog/notification grant never exposes internal contexts or auth stores.
export function terminalSession(session) {
  if (!session || session.deletedAt || sessionDeleted(session.id) || session.parentSessionId || session.purpose && session.purpose !== 'terminal' || typeof session.cwd !== 'string' ||
    !path.isAbsolute(session.cwd) || Buffer.byteLength(session.cwd) > 4096 || /[\x00-\x1f\x7f-\x9f]/u.test(session.cwd)) return false;
  const names = new Set(['.bzzy', '.ssh', '.aws', '.azure', '.gnupg', '.codex', '.claude', 'keychains']);
  if (session.cwd.split(path.sep).some(part => names.has(part.toLowerCase()))) return false;
  try {
    const cwd = canonicalPath(session.cwd);
    const privatePaths = [home(), path.join(os.homedir(), '.codex'), path.join(os.homedir(), '.claude'), path.join(os.homedir(), '.ssh'),
      ...['BZZY_CODEX_HOME', 'CODEX_HOME', 'BZZY_CLAUDE_HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR'].map(key => process.env[key]).filter(Boolean)];
    return !privatePaths.some(value => contains(canonicalPath(value), cwd));
  } catch { return false; }
}
