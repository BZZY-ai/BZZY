import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { home, requireNode, getRecord, putRecord, reserveRequest, now } from './engine.js';
import { fail, object } from './validation.js';
import { canonicalPath, contains } from './paths.js';

const privateNames = new Set(['.bzzy', '.ssh', '.aws', '.azure', '.gnupg', '.codex', '.claude', '.config', '.local',
  '.keychain', 'keychains', '.secrets', '.credentials']);
const publicRoot = root => ({ id: root.id, revision: root.revision, path: root.path, name: path.basename(root.path) || root.path });
const identity = stat => ({ dev: String(stat.dev), ino: String(stat.ino) });
const sameIdentity = (left, right) => left?.dev === right?.dev && left?.ino === right?.ino;
const privateDirectories = () => [home(), path.join(os.homedir(), '.codex'), path.join(os.homedir(), '.claude'),
  path.join(os.homedir(), '.ssh'), path.join(os.homedir(), '.aws'), path.join(os.homedir(), 'Library/Keychains'),
  ...['BZZY_CODEX_HOME', 'CODEX_HOME', 'BZZY_CLAUDE_HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR']
    .map(key => process.env[key]).filter(Boolean)].map(value => canonicalPath(value));
function assertNotPrivate(value, { root = false } = {}) {
  if (value.split(path.sep).some(part => privateNames.has(part.toLowerCase()) || /^\.env(?:\.|$)/i.test(part))) fail('FORBIDDEN', 'Private authentication/storage paths are unavailable.', 403);
  for (const secret of privateDirectories()) if (contains(secret, value) || root && contains(value, secret)) fail('FORBIDDEN', 'Keep the workspace separate from private host storage.', 403);
}

// Privileged LOCAL host settings API; it is absent from the remote gateway.
// This is a managed-project/agent default, never a restriction on CLI cwd.
export class CoreWorkspaces {
  #home;
  constructor() { requireNode(); this.#home = home(); }
  #check() { if (home() !== this.#home) fail('HOST_CONTEXT_CHANGED', 'The workspace host context changed.', 409); }
  settings() {
    this.#check(); const root = getRecord('core.workspace', 'default');
    return { configured: Boolean(root), revision: root?.revision || 0, root: root ? publicRoot(root) : null };
  }
  configure(input, { requestId, expectedRevision } = {}) {
    this.#check(); object(input, ['path', 'create']);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || typeof input.path !== 'string' || !path.isAbsolute(input.path) || Buffer.byteLength(input.path) > 4096 || /[\x00-\x1f\x7f-\x9f]/u.test(input.path) || input.create !== undefined && typeof input.create !== 'boolean') fail('INVALID_REQUEST', 'Choose an absolute local root and its current settings revision.');
    const requested = path.resolve(input.path);
    assertNotPrivate(canonicalPath(requested), { root: true });
    return reserveRequest('core:workspace:configure', requestId, { input, expectedRevision }, db => {
      const previous = getRecord('core.workspace', 'default');
      if ((previous?.revision || 0) !== expectedRevision) fail('CONFLICT', 'Workspace root settings changed. Reload before editing.', 409);
      if (!fs.existsSync(requested)) {
        if (!input.create) fail('NOT_FOUND', 'Choose an existing workspace directory.', 404);
        fs.mkdirSync(requested, { recursive: true, mode: 0o700 });
      }
      const stat = fs.lstatSync(requested);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail('FORBIDDEN', 'The configured root must be a real directory.', 403);
      const canonical = fs.realpathSync(requested);
      assertNotPrivate(canonical, { root: true });
      const root = { id: randomUUID(), revision: expectedRevision + 1, path: canonical, identity: identity(fs.statSync(canonical)), createdAt: now() };
      putRecord('core.workspace', 'default', root, db);
      return { configured: true, revision: root.revision, root: publicRoot(root) };
    });
  }
  pin() {
    this.#check(); const root = getRecord('core.workspace', 'default');
    if (!root) fail('WORKSPACE_SETUP_REQUIRED', 'Configure Core workspaceRoot on the host first.', 409);
    this.assertPin(root); return structuredClone(root);
  }
  assertPin(pin) {
    this.#check(); const current = getRecord('core.workspace', 'default');
    if (!current || !pin || current.id !== pin.id || current.revision !== pin.revision || current.path !== pin.path || !sameIdentity(current.identity, pin.identity)) fail('WORKSPACE_CHANGED', 'Workspace authorization must be approved again after a root change.', 403);
    try {
      const stat = fs.lstatSync(current.path);
      if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync(current.path) !== current.path || !sameIdentity(identity(stat), current.identity)) fail('WORKSPACE_CHANGED', 'The pinned workspace directory changed.', 403);
      assertNotPrivate(current.path, { root: true });
    } catch (error) { if (error.code === 'FORBIDDEN' || error.code === 'WORKSPACE_CHANGED') throw error; fail('WORKSPACE_UNAVAILABLE', 'The workspace directory is unavailable.', 403); }
    return current;
  }
}
