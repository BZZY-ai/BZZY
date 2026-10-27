import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { database, digest, getRecord, putRecord, now, transaction } from './database.js';
import { privateDir, writeJson } from './files.js';

const kind = 'core.project.identity';
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const stableId = value => { const hash = digest(value).slice(0, 32); return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20)}`; };
const inside = (root, child) => child === root || child.startsWith(root + path.sep);
const atomic = operation => database().isTransaction ? operation(database()) : transaction(operation);
function fingerprint(root) {
  const stat = fs.statSync(root);
  return `${stat.dev}:${stat.ino}`;
}
function markerAt(root) {
  const directory = path.join(root, '.bzzy'), file = path.join(directory, 'project.json');
  let directoryStat, stat;
  try { directoryStat = fs.lstatSync(directory); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('Project knowledge directory must be a real directory.');
  try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16384) throw new Error('Project identity must be a bounded regular file without links.');
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('Project identity is unreadable. Restore its valid project.json before continuing.'); }
  if (!uuid(data?.id)) throw new Error('Project identity needs a valid ID. Restore its project.json before continuing.');
  return { file, data };
}

// Paths locate an engagement; a private directory binding distinguishes a move
// from a copied marker. No Git origin, target name or model can merge projects.
export function resolveProjectIdentity(directory, { create = false, boundary, readOnly = false } = {}) {
  if (readOnly && create) throw new Error('A read-only project lookup cannot initialize an identity.');
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('Project directory must be absolute.');
  const cwd = fs.realpathSync(directory);
  if (!fs.statSync(cwd).isDirectory()) throw new Error('Project directory is unavailable.');
  const stop = boundary == null ? null : fs.realpathSync(boundary);
  if (stop && !inside(stop, cwd)) throw new Error('Project directory lies outside its authorized boundary.');
  let root = cwd, marker;
  for (let cursor = cwd, depth = 0; depth < 128; depth++) {
    const found = markerAt(cursor);
    if (found) { root = cursor; marker = found; break; }
    if (cursor === stop) break;
    const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
  const identity = fingerprint(root);
  if (!marker && !create) return { id: stableId(['unmarked-project', root]), root, markerRoot: null, initialized: false, aliases: [root], fingerprint: identity };
  if (!marker) {
    const data = { version: 1, id: stableId(['unmarked-project', root]), createdAt: now(), description: 'BZZY engagement knowledge. Private account bindings belong outside this directory.' };
    marker = atomic(() => {
      const current = markerAt(root); if (current) return current;
      privateDir(path.join(root, '.bzzy'));
      // Publish a complete marker; cooperating Core initializers serialize in
      // SQLite. Independent homes derive the same initial ID for this root.
      writeJson(path.join(root, '.bzzy', 'project.json'), data);
      return markerAt(root);
    });
  }
  const resolve = db => {
    const originalId = marker.data.id, previous = getRecord(kind, originalId);
    const copied = previous && previous.fingerprint !== identity;
    const id = copied ? stableId(['copied-project', originalId, identity]) : originalId;
    const current = getRecord(kind, id);
    if (current && current.fingerprint !== identity) throw new Error('Project identity collision. Choose a fresh engagement identity.');
    const aliases = [...new Set([...(current?.aliases || (!copied ? previous?.aliases : []) || []), current?.root, !copied && previous?.root, root].filter(Boolean))].slice(-32);
    const record = { id, root, fingerprint: identity, aliases, createdAt: current?.createdAt || (!copied && previous?.createdAt) || now(), updatedAt: now() };
    if (!readOnly) putRecord(kind, id, record, db);
    if (copied && create) writeJson(marker.file, { ...marker.data, id, copiedFrom: undefined, forkedAt: now() });
    return { ...record, markerRoot: root, initialized: true, forked: Boolean(copied) };
  };
  return readOnly ? resolve(database()) : atomic(resolve);
}

export function projectIdentityForSession(session, options = {}) {
  if (!session || typeof session.cwd !== 'string') throw new Error('A saved session is required for project knowledge.');
  const seen = new Set(); let current = (session.id && getRecord('session', session.id)) || session, boundary;
  for (let depth = 0; current && depth < 64 && !seen.has(current.id); depth++) {
    seen.add(current.id);
    if (current.purpose === 'agent' && current.agentId) {
      const agent = getRecord('core.agent', current.agentId);
      if (agent && agent.sessionId === current.id && !agent.archivedAt) { boundary = agent.cwd; break; }
    }
    current = current.parentSessionId ? getRecord('session', current.parentSessionId) : null;
  }
  return resolveProjectIdentity(boundary || session.projectRoot || session.cwd, { ...options, ...(boundary ? { boundary } : {}) });
}

export function recordBelongsToProject(record, project) {
  if (!record || !project) return false;
  const location = record.project || record.projectRoot || record.cwd;
  // Imported/copy records cannot assert another engagement merely by supplying
  // its ID. A matching current or verified moved location is required too.
  if (typeof location !== 'string' || !project.aliases.some(root => path.resolve(location) === root)) return false;
  return !record.projectId || record.projectId === project.id;
}

export function sessionBelongsToProject(session, project) {
  if (!session || ['skill-writer', 'learning-review', 'knowledge-review'].includes(session.role)) return false;
  if (recordBelongsToProject(session, project)) return true;
  if (session.projectRoot || session.projectId) return false;
  try {
    const own = resolveProjectIdentity(session.cwd);
    return own.id === project.id && inside(project.root, own.root);
  } catch { return false; }
}

// Explicit local-owner operation for a move across filesystems. It refuses to
// adopt an identity while its previous directory still exists; copying requires
// a fresh engagement. No model tool exposes this helper.
export function relinkProjectIdentity(directory, { projectId, expectedRoot, explicit = false } = {}) {
  if (!explicit || !uuid(projectId) || typeof expectedRoot !== 'string') throw new Error('Explicit owner confirmation and the previous project location are required.');
  const previous = getRecord(kind, projectId), root = fs.realpathSync(directory);
  if (!previous || previous.root !== path.resolve(expectedRoot) || fs.existsSync(previous.root)) throw new Error('The prior project must be unavailable and match the reviewed location before relinking.');
  const marker = markerAt(root);
  if (!marker || marker.data.id !== projectId) throw new Error('The moved project marker does not match the reviewed engagement.');
  return atomic(db => {
    const updated = { ...previous, root, fingerprint: fingerprint(root), aliases: [...new Set([...(previous.aliases || []), previous.root, root])].slice(-32), updatedAt: now() };
    putRecord(kind, projectId, updated, db); return { ...updated, markerRoot: root, initialized: true };
  });
}
