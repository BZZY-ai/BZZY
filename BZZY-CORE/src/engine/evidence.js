import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { home, privateDir, writeJson, readJson } from './files.js';
import { digest, getRecord, putRecord, listRecords, appendEvent, now } from './database.js';
import { privateWorkspacePath, assertPublicWorkspacePath } from './private-paths.js';
import { recognizedDebugArtifact } from './debug-artifact.js';

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
  const result = { id, sessionId: session.id, ...(session.goal?.id ? { goalId: session.goal.id } : {}), projectRoot: session.projectRoot || session.cwd, label, path: file, mediaType, ...fileInfo(file), createdAt: now(), provenance: 'host-recorded' };
  if (label !== 'agent-output' && !label.startsWith('http-response:') && !['executor', 'reviewer'].includes(session.role) && session.policy?.mode !== 'read-only') {
    const namespace = session.agentNamespace ? path.join('agents', session.agentNamespace) : '';
    const projectPath = path.join(session.projectRoot || session.cwd, '.bzzy', namespace, 'evidence', `${id}.txt`);
    privateDir(path.dirname(projectPath)); fs.writeFileSync(projectPath, text, { mode: 0o600, flag: 'wx' }); result.projectPath = projectPath;
    writeJson(projectPath.replace(/\.txt$/, '.json'), { ...result, path: path.basename(projectPath), projectPath: undefined });
  }
  putRecord('artifact', id, result); appendEvent(session.id, 'artifact', result); return result;
}
export function captureEvidence(session, relative, label) {
  assertPublicWorkspacePath(relative);
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
function snapshotLimits() {
  const settings = readJson(path.join(home(), 'config.json'), {}).snapshotLimits || {};
  const limits = { maxFileMiB: 20, maxTotalMiB: 100, maxFiles: 10000, ...settings };
  for (const [key, maximum] of [['maxFileMiB', 512], ['maxTotalMiB', 16384], ['maxFiles', 1000000]]) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > maximum) throw new Error(`snapshotLimits.${key} must be an integer from 1 to ${maximum}.`);
  }
  return limits;
}
function snapshotInfo(file) {
  const fd = fs.openSync(file, 'r'), hash = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let size = 0, count;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null))) { hash.update(buffer.subarray(0, count)); size += count; }
    return { size, sha256: hash.digest('hex') };
  } finally { fs.closeSync(fd); }
}
export function workspaceManifest(root, limits = snapshotLimits(), { omissions = [] } = {}) {
  const resolved = fs.realpathSync(root), privateRoot = fs.existsSync(home()) ? fs.realpathSync(home()) : home(), privateIsInsideWorkspace = privateRoot.startsWith(resolved + path.sep);
  if (resolved === privateRoot) throw new Error('The private bzzy state directory cannot be used as a project workspace.');
  let names;
  try { names = execFileSync('git', ['-C', root, 'ls-files', '-co', '--exclude-standard', '-z'], { maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).toString().split('\0').filter(Boolean); }
  catch {
    names = [];
    const walk = (dir, prefix = '') => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (privateIsInsideWorkspace && path.resolve(dir, entry.name) === privateRoot) continue;
        const relative = path.join(prefix, entry.name);
        if (excluded.has(entry.name) || privateWorkspacePath(relative)) continue;
        if (entry.isDirectory()) walk(path.join(dir, entry.name), relative);
        else if (entry.isFile()) names.push(relative);
      }
    }; walk(resolved);
  }
  const result = {}; let total = 0, count = 0;
  for (const name of [...new Set(names)].sort()) {
    const absolute = path.resolve(resolved, name);
    if (privateIsInsideWorkspace && (absolute === privateRoot || absolute.startsWith(privateRoot + path.sep))) continue;
    if (name.split(path.sep).some(p => excluded.has(p)) || privateWorkspacePath(name)) continue;
    const file = inside(root, name, { exists: false });
    if (!fs.existsSync(file) || !fs.lstatSync(file).isFile()) continue;
    const diagnostic = recognizedDebugArtifact(file);
    if (diagnostic) { omissions.push({ path: name, ...diagnostic }); continue; }
    if (fs.statSync(file).size > limits.maxFileMiB * 1024 * 1024) throw new Error(`Cannot snapshot ${JSON.stringify(name)}: file exceeds ${limits.maxFileMiB} MiB. Configure snapshotLimits, move it outside the task workspace or exclude it with .gitignore in a Git project.`);
    const info = snapshotInfo(file); total += info.size;
    if (info.size > limits.maxFileMiB * 1024 * 1024 || total > limits.maxTotalMiB * 1024 * 1024 || count++ >= limits.maxFiles) throw new Error(`Workspace snapshot exceeds ${limits.maxTotalMiB} MiB or ${limits.maxFiles.toLocaleString('en-US')} files. Configure snapshotLimits or select a smaller workspace.`);
    result[name] = info;
  }
  return result;
}
export function snapshotWorkspace(session, label = 'snapshot') {
  const limits = snapshotLimits(), omissions = [], manifest = workspaceManifest(session.cwd, limits, { omissions }), id = randomUUID();
  const directory = path.join(home(), 'snapshots', id); privateDir(directory);
  try {
    for (const relative of Object.keys(manifest)) {
      const target = path.join(directory, relative); privateDir(path.dirname(target));
      fs.copyFileSync(inside(session.cwd, relative), target, fs.constants.COPYFILE_FICLONE);
      if (snapshotInfo(target).sha256 !== manifest[relative].sha256) throw new Error(`Workspace changed while snapshotting: ${relative}`);
    }
    // Dependencies are explicitly outside the source snapshot; available read-only to tools.
    if (fs.existsSync(path.join(session.cwd, 'node_modules'))) fs.symlinkSync(path.join(session.cwd, 'node_modules'), path.join(directory, 'node_modules'));
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  const record = { id, sessionId: session.id, label, source: session.cwd, directory, manifest, limits, omissions,
    omissionPolicy: 'content-validated-bzzy-debug-v1', manifestHash: digest(manifest), createdAt: now() };
  writeJson(path.join(home(), 'snapshots', `${id}.json`), record); putRecord('snapshot', id, record);
  appendEvent(session.id, 'snapshot', { id, label, manifestHash: record.manifestHash, omissions, omissionPolicy: record.omissionPolicy }); return record;
}
export function copyWorkspaceSnapshot(snapshot, directory, { sessionId = snapshot.sessionId } = {}) {
  const source = fs.realpathSync(snapshot.directory), omissions = (snapshot.omissions || []).map(item => ({ ...item, phase: 'snapshot' }));
  fs.cpSync(source, directory, { recursive: true, dereference: false, mode: fs.constants.COPYFILE_FICLONE,
    filter(file) {
      if (!fs.lstatSync(file).isFile()) return true;
      const diagnostic = recognizedDebugArtifact(file);
      if (!diagnostic) return true;
      omissions.push({ path: path.relative(source, file), ...diagnostic, phase: 'copy-source' }); return false;
    } });
  const result = { snapshotId: snapshot.id, directory, omissions, omissionPolicy: 'content-validated-bzzy-debug-v1' };
  if (sessionId) appendEvent(sessionId, 'snapshot.copy', result);
  return result;
}
export function inspectWorkspace(snapshot, cwd) {
  const omissions = [], current = workspaceManifest(cwd, snapshot.limits, { omissions }), changes = [], before = { ...snapshot.manifest };
  const baseline = (snapshot.omissions || []).map(item => ({ ...item, phase: 'baseline' }));
  // Older snapshots may already contain diagnostic exports. Validate that saved
  // copy too: a worker never owes deletion/integration of diagnostic data. If
  // that path now holds ordinary source, it remains an observable new change.
  for (const file of Object.keys(before)) {
    try {
      const diagnostic = snapshot.directory && recognizedDebugArtifact(inside(snapshot.directory, file));
      if (diagnostic) { delete before[file]; baseline.push({ path: file, ...diagnostic, phase: 'baseline' }); }
    } catch { /* An unavailable saved file is not an exclusion authority. */ }
  }
  for (const file of new Set([...Object.keys(before), ...Object.keys(current)])) {
    if (before[file]?.sha256 !== current[file]?.sha256) changes.push({ path: file, before: before[file] || null, after: current[file] || null });
  }
  Object.defineProperty(changes, 'omissions', { value: [...baseline, ...omissions.map(item => ({ ...item, phase: 'current' }))], enumerable: false });
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
