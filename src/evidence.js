import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { home, privateDir, writeJson } from './files.js';
import { digest, getRecord, putRecord, listRecords, appendEvent, now } from './database.js';

export function inside(root, relative, { exists = true } = {}) {
  const base = fs.realpathSync(root);
  const target = path.resolve(base, relative);
  if (target !== base && !target.startsWith(base + path.sep)) throw new Error(`Path is outside the permitted workspace: ${relative}`);
  let current = base;
  for (const part of path.relative(base, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) { if (exists) throw new Error(`Missing evidence: ${relative}`); continue; }
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Evidence paths must not traverse symlinks: ${relative}`);
  }
  return target;
}
export function fileInfo(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 20 * 1024 * 1024) throw new Error('Evidence must be a regular file no larger than 20 MiB.');
  return { size: stat.size, sha256: digest(fs.readFileSync(file)) };
}
export function artifact(session, text, label = 'report', mediaType = 'text/plain') {
  const id = randomUUID(), dir = path.join(home(), 'artifacts', session.id);
  privateDir(dir);
  const file = path.join(dir, `${id}.txt`);
  fs.writeFileSync(file, text, { mode: 0o600, flag: 'wx' });
  const result = { id, sessionId: session.id, projectRoot: session.projectRoot || session.cwd, label, path: file, mediaType, ...fileInfo(file), createdAt: now(), provenance: 'host-recorded' };
  if (!['executor', 'reviewer'].includes(session.role) && session.policy?.mode !== 'read-only') {
    const namespace = session.agentNamespace ? path.join('agents', session.agentNamespace) : '';
    const projectPath = path.join(session.projectRoot || session.cwd, '.bzzy', namespace, 'evidence', `${id}.txt`);
    privateDir(path.dirname(projectPath)); fs.writeFileSync(projectPath, text, { mode: 0o600, flag: 'wx' }); result.projectPath = projectPath;
    writeJson(projectPath.replace(/\.txt$/, '.json'), { ...result, path: path.basename(projectPath), projectPath: undefined });
  }
  putRecord('artifact', id, result); appendEvent(session.id, 'artifact', result); return result;
}
export function captureEvidence(session, relative, label) {
  const file = inside(session.cwd, relative), info = fileInfo(file);
  const item = artifact(session, fs.readFileSync(file), label || relative, 'application/octet-stream');
  Object.assign(item, { source: relative, sourceWorkspace: session.cwd, sourceSha256: info.sha256, provenance: 'workspace-copy' });
  putRecord('artifact', item.id, item); return item;
}
export function readArtifact(id, offset = 0, limit = 8192) {
  const item = getRecord('artifact', id);
  if (!item) throw new Error('Unknown artifact.');
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 32768) throw new Error('Invalid artifact read bounds.');
  const info = fileInfo(item.path);
  if (info.sha256 !== item.sha256) throw new Error('Artifact integrity check failed.');
  const bytes = fs.readFileSync(item.path);
  return { ...item, content: bytes.subarray(offset, offset + limit).toString('utf8'), nextOffset: Math.min(bytes.length, offset + limit), truncated: offset + limit < bytes.length };
}
const excluded = new Set(['.git', 'node_modules', '.bzzy', '.bzzy-runtime', 'codex', 'codex-0.162.0', 'claude-code', '.venv', '__pycache__']);
export function workspaceManifest(root) {
  const resolved = path.resolve(root), privateIsInsideWorkspace = home().startsWith(resolved + path.sep);
  if (resolved === home()) throw new Error('The private bzzy state directory cannot be used as a project workspace.');
  let names;
  try { names = execFileSync('git', ['-C', root, 'ls-files', '-co', '--exclude-standard', '-z'], { maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).toString().split('\0').filter(Boolean); }
  catch {
    names = [];
    const walk = (dir, prefix = '') => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (privateIsInsideWorkspace && path.resolve(dir, entry.name) === home()) continue;
        if (excluded.has(entry.name) || entry.name === '.env' || entry.name.startsWith('.env.')) continue;
        const relative = path.join(prefix, entry.name);
        if (entry.isDirectory()) walk(path.join(dir, entry.name), relative);
        else if (entry.isFile()) names.push(relative);
      }
    }; walk(root);
  }
  const result = {}; let total = 0;
  for (const name of [...new Set(names)].sort()) {
    const absolute = path.resolve(root, name);
    if (privateIsInsideWorkspace && (absolute === home() || absolute.startsWith(home() + path.sep))) continue;
    if (name.split(path.sep).some(p => excluded.has(p) || p === '.env' || p.startsWith('.env.'))) continue;
    const file = inside(root, name, { exists: false });
    if (!fs.existsSync(file) || !fs.lstatSync(file).isFile()) continue;
    const info = fileInfo(file); total += info.size;
    if (total > 100 * 1024 * 1024 || Object.keys(result).length >= 10000) throw new Error('Workspace snapshot exceeds 100 MiB or 10,000 files. Select a smaller workspace.');
    result[name] = info;
  }
  return result;
}
export function snapshotWorkspace(session, label = 'snapshot') {
  const manifest = workspaceManifest(session.cwd), id = randomUUID();
  const directory = path.join(home(), 'snapshots', id); privateDir(directory);
  for (const relative of Object.keys(manifest)) {
    const target = path.join(directory, relative); privateDir(path.dirname(target));
    const content = fs.readFileSync(inside(session.cwd, relative));
    if (digest(content) !== manifest[relative].sha256) throw new Error(`Workspace changed while snapshotting: ${relative}`);
    fs.writeFileSync(target, content, { mode: fs.statSync(path.join(session.cwd, relative)).mode & 0o777 });
  }
  // Dependencies are explicitly outside the source snapshot; available read-only to tools.
  if (fs.existsSync(path.join(session.cwd, 'node_modules'))) fs.symlinkSync(path.join(session.cwd, 'node_modules'), path.join(directory, 'node_modules'));
  const record = { id, sessionId: session.id, label, source: session.cwd, directory, manifest, manifestHash: digest(manifest), createdAt: now() };
  writeJson(path.join(home(), 'snapshots', `${id}.json`), record); putRecord('snapshot', id, record);
  appendEvent(session.id, 'snapshot', { id, label, manifestHash: record.manifestHash }); return record;
}
export function inspectWorkspace(snapshot, cwd) {
  const current = workspaceManifest(cwd), changes = [];
  for (const file of new Set([...Object.keys(snapshot.manifest), ...Object.keys(current)])) {
    if (snapshot.manifest[file]?.sha256 !== current[file]?.sha256) changes.push({ path: file, before: snapshot.manifest[file] || null, after: current[file] || null });
  }
  return changes;
}
export const artifactsFor = sessionId => listRecords('artifact').filter(a => a.sessionId === sessionId);
export function projectArtifact(project, id) {
  if (!/^[a-f0-9-]{36}$/.test(id)) return null;
  const base = path.join(project, '.bzzy'), directories = [path.join(base, 'evidence')];
  const agents = path.join(base, 'agents');
  if (fs.existsSync(agents)) for (const entry of fs.readdirSync(agents, { withFileTypes: true })) if (entry.isDirectory()) directories.push(path.join(agents, entry.name, 'evidence'));
  for (const dir of directories) {
    const file = path.join(dir, id + '.json'); if (!fs.existsSync(file)) continue;
    const record = JSON.parse(fs.readFileSync(inside(dir, id + '.json'), 'utf8'));
    const stored = inside(dir, record.path), info = fileInfo(stored);
    if (info.sha256 !== record.sha256 || record.id !== id) throw new Error('Project evidence integrity check failed.');
    const item = { ...record, projectRoot: project, path: stored, provenance: 'project-file' }; putRecord('artifact', id, item); return item;
  }
  return null;
}
