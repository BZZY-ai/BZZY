import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { home, digest, now } from './engine.js';
import { fail, object, opaque } from './validation.js';
import { canonicalPath, contains as contained } from './paths.js';

const protectedNames = /^(?:\.env(?:\..*)?|\.git|\.ssh|\.aws|\.azure|\.kube|\.gnupg|\.config|\.codex|\.claude|\.bzzy|\.npmrc|\.netrc|\.pypirc|credentials(?:\..*)?|auth\.json|cookies(?:\..*)?|tokens?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|login data)$/i;
const protectedExtension = /\.(?:pem|key|p12|pfx|keychain(?:-db)?|sqlite(?:3)?|db)$/i;

export function filesystemRoots(input) {
  if (!Array.isArray(input) || !input.length || input.length > 16) fail('INVALID_REQUEST', 'Choose 1–16 explicit filesystem roots.');
  const names = new Set();
  return input.map(item => {
    object(item, ['id', 'path'], 'Filesystem root'); opaque(item.id, 'Root ID');
    if (names.has(item.id) || typeof item.path !== 'string' || !path.isAbsolute(item.path)) fail('INVALID_REQUEST', 'Filesystem roots need distinct IDs and absolute local directories.');
    names.add(item.id);
    const resolved = fs.realpathSync(item.path);
    if (!fs.statSync(resolved).isDirectory() || resolved === path.parse(resolved).root || contained(canonicalPath(home()), resolved)) fail('FORBIDDEN', 'This directory cannot be granted as a tool workspace.', 403);
    const stat = fs.statSync(resolved);
    return { id: item.id, path: resolved, dev: stat.dev, ino: stat.ino };
  });
}

function checkPath(base, relative, { projectContext = false } = {}) {
  if (typeof relative !== 'string' || !relative || relative.length > 4096 || /[\\\x00-\x1f\x7f]/.test(relative) || path.isAbsolute(relative) || relative.split('/').some(part => !part || part === '.' || part === '..')) fail('FORBIDDEN', 'Use a relative file path inside an approved root.', 403);
  const target = path.resolve(base, relative);
  const privateRoots = [home(), ...['.ssh', '.aws', '.azure', '.kube', '.gnupg', '.config', '.codex', '.claude', '.bzzy'].map(name => path.join(os.homedir(), name))].map(canonicalPath);
  const parts = relative.split('/');
  const safeContext = projectContext && parts[0] === '.bzzy' && /^(?:project\.json|constraints\.json|notes(?:\.(?:txt|md|json))?|issues|hypotheses|memory|evidence|artifacts|history|sessions|contracts|goals|ledger|agents|imports)$/.test(parts[1] || '');
  if (!contained(base, target) || privateRoots.some(root => contained(root, target)) ||
      base.split(path.sep).some(part => protectedNames.test(part) || protectedExtension.test(part)) ||
      parts.some((part, index) => !(safeContext && index === 0) && (protectedNames.test(part) || protectedExtension.test(part)))) fail('FORBIDDEN', 'Private authentication and runtime files are outside tool access.', 403);
  return target;
}

function readFile(args, { resources, assertAuthorized, projectContext = false }) {
  const root = resources.roots?.find(item => item.id === args.root);
  if (!root) fail('FORBIDDEN', 'This filesystem root is not authorized.', 403);
  const target = checkPath(root.path, args.path, { projectContext }), handles = [];
  const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
  const ancestry = [];
  try {
    const rootStat = fs.lstatSync(root.path);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || !same(rootStat, root)) fail('FORBIDDEN', 'The authorized directory changed. Review its grant again.', 403);
    let current = root.path;
    ancestry.push({ path: current, stat: rootStat });
    for (const segment of args.path.split('/').slice(0, -1)) {
      current = path.join(current, segment);
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail('FORBIDDEN', 'Tool paths cannot traverse symlinks.', 403);
      ancestry.push({ path: current, stat });
    }
    const before = fs.lstatSync(target);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) fail('FORBIDDEN', 'Only regular, unlinked workspace files can be read.', 403);
    // On Linux, pin every directory descriptor and traverse through procfs.
    // This prevents parent-directory substitution while opening the final file.
    let openPath = target;
    if (process.platform === 'linux') {
      let parent = fs.openSync(root.path, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      handles.push(parent);
      if (!same(fs.fstatSync(parent), rootStat)) fail('FORBIDDEN', 'The authorized directory changed.', 403);
      const segments = args.path.split('/');
      for (const segment of segments.slice(0, -1)) {
        parent = fs.openSync(`/proc/self/fd/${parent}/${segment}`, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
        handles.push(parent);
      }
      openPath = `/proc/self/fd/${parent}/${segments.at(-1)}`;
    }
    const fd = fs.openSync(openPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    handles.push(fd);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || !same(before, stat)) fail('FORBIDDEN', 'The requested file changed while opening.', 403);
    if (stat.size > 1024 * 1024) fail('FILE_TOO_LARGE', 'Tool reads are limited to files of 1 MiB.');
    const offset = args.offset ?? 0, limit = args.limit ?? 16384;
    const bytes = Buffer.alloc(Math.min(limit, Math.max(0, stat.size - offset)));
    const count = fs.readSync(fd, bytes, 0, bytes.length, offset);
    const content = bytes.subarray(0, count);
    for (const entry of ancestry) if (!same(fs.lstatSync(entry.path), entry.stat) || fs.lstatSync(entry.path).isSymbolicLink()) fail('FORBIDDEN', 'The workspace changed while reading.', 403);
    const after = fs.fstatSync(fd);
    if (!same(stat, fs.lstatSync(target)) || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || after.nlink !== 1) fail('FORBIDDEN', 'The file changed while reading.');
    assertAuthorized();
    return { root: args.root, path: args.path, content: content.toString('utf8'), offset, nextOffset: offset + count,
      totalBytes: stat.size, truncated: offset + count < stat.size, sha256: digest(content), observedAt: now(), provenance: 'host-observed-file-slice' };
  } catch (error) {
    if (['FORBIDDEN', 'FILE_TOO_LARGE'].includes(error.code)) throw error;
    fail('FILE_UNAVAILABLE', 'The approved file is unavailable.');
  } finally { for (const fd of handles.reverse()) fs.closeSync(fd); }
}

export const filesystemIntegration = {
  id: 'filesystem', description: 'Bounded read-only access to explicitly authorized local project files.',
  capabilities: ['filesystem.read'], authentication: { required: false, scopes: [] },
  rateLimit: { calls: 120, intervalSeconds: 60 },
  errors: ['FORBIDDEN', 'FILE_UNAVAILABLE', 'FILE_TOO_LARGE'],
  tools: [{ name: 'read_file', description: 'Read a UTF-8 file slice from a symbolic project root. Authentication stores, symlinks, hardlinks and runtime databases are denied.',
    capability: 'filesystem.read', effect: 'read',
    inputSchema: { type: 'object', properties: { root: { type: 'string', minLength: 1, maxLength: 80 }, path: { type: 'string', minLength: 1, maxLength: 4096 }, offset: { type: 'integer', minimum: 0, maximum: 1048576 }, limit: { type: 'integer', minimum: 1, maximum: 16384 } }, required: ['root', 'path'], additionalProperties: false },
    outputSchema: { type: 'object', properties: { root: { type: 'string' }, path: { type: 'string' }, content: { type: 'string' }, offset: { type: 'integer' }, nextOffset: { type: 'integer' }, totalBytes: { type: 'integer' }, truncated: { type: 'boolean' }, sha256: { type: 'string' }, observedAt: { type: 'string' }, provenance: { const: 'host-observed-file-slice' } }, required: ['root', 'path', 'content', 'offset', 'nextOffset', 'totalBytes', 'truncated', 'sha256', 'observedAt', 'provenance'], additionalProperties: false } }],
  execute: (_tool, args, context) => readFile(args, context),
};

// A separate trusted adapter permits known project-context subtrees. The
// generic filesystem integration continues to deny every .bzzy runtime path.
export const agentProjectFilesystemIntegration = {
  ...filesystemIntegration,
  execute: (_tool, args, context) => readFile(args, { ...context, projectContext: true }),
};
