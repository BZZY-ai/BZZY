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
const runtimeCaches = new Set(['.cache', '.pytest_cache', '.mypy_cache', '.ruff_cache']);
const omissionPolicy = 'best-effort-workspace-snapshot-v3';
const MiB = 1024 * 1024;
const maximumSnapshotLimits = { maxFileMiB: 16384, maxTotalMiB: 65536, maxFiles: 1000000 };
function runtimeCachePath(name) {
  const parts = name.split(path.sep), index = parts.findIndex(part => runtimeCaches.has(part));
  return index < 0 ? null : parts.slice(0, index + 1).join(path.sep);
}
function snapshotLimits() {
  const settings = readJson(path.join(home(), 'config.json'), {}).snapshotLimits || {};
  const limits = { maxFileMiB: 1024, maxTotalMiB: 8192, maxFiles: 100000, ...settings };
  for (const [key, maximum] of Object.entries(maximumSnapshotLimits)) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > maximum) throw new Error(`snapshotLimits.${key} must be an integer from 1 to ${maximum}.`);
  }
  return limits;
}
const recoverableFileError = error => ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EBUSY', 'ENAMETOOLONG', 'EFBIG'].includes(error.code);
function omissionRecorder(omissions) {
  let samples = omissions.filter(item => item.reason.startsWith('snapshot_') && item.path).length;
  return item => {
    if (samples++ < 64) { omissions.push(item); return; }
    let summary = omissions.find(entry => entry.pathsTruncated && entry.reason === item.reason && entry.limit === item.limit);
    if (!summary) { summary = { reason: item.reason, ...(item.limit ? { limit: item.limit, limitValue: item.limitValue } : {}), pathsTruncated: true, omittedCount: 0, bytes: 0 }; omissions.push(summary); }
    summary.omittedCount++; summary.bytes += item.bytes || 0;
  };
}
function snapshotOmissionSummary(snapshot) {
  const omissions = (snapshot?.omissions || []).filter(item => item.reason.startsWith('snapshot_'));
  if (!omissions.length) return null;
  return { snapshotId: snapshot.id, originalWorkspace: snapshot.source, unknownCount: omissions.some(item => item.unknownCount || item.kind === 'directory'),
    skippedFiles: omissions.reduce((count, item) => count + (item.unknownCount || item.kind === 'directory' ? 0 : item.omittedCount || 1), 0),
    samples: omissions.filter(item => item.path).slice(0, 8).map(item => ({ path: item.path.slice(0, 240), reason: item.reason, limit: item.limit })),
    notice: 'This workspace copy is partial. Snapshot limits skip incidental files without stopping the goal; skipped files are not deleted or verified. The parent continues in the original workspace. Isolated workers do not receive skipped files; originalWorkspace is a reference for inputs only where existing read tools and policy allow it, never permission to write there. Continue with available inputs; request selected evidence or report a missing prerequisite when needed. This notice grants no additional filesystem access.' };
}
export function workspaceSnapshotContext(session) {
  const assignment = session.assignmentId && getRecord('assignment', session.assignmentId);
  const group = session.bestiesSessionId ? getRecord('besties', session.bestiesSessionId) : session.parallelSessionId ? getRecord('parallel', session.parallelSessionId) : null;
  const id = assignment?.snapshotId || group?.snapshotId || session.startSnapshotId;
  return id ? snapshotOmissionSummary(getRecord('snapshot', id)) : null;
}
function snapshotInfo(file, expectedSize = Infinity) {
  const fd = fs.openSync(file, 'r'), hash = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let size = 0, count;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null))) { hash.update(buffer.subarray(0, count)); size += count; if (size > expectedSize) break; }
    return { size, sha256: hash.digest('hex') };
  } finally { fs.closeSync(fd); }
}
export function workspaceManifest(root, limits = snapshotLimits(), { omissions = [], omittedPaths = new Set(), omittedDirectories = new Set(), priority = [] } = {}) {
  const resolved = fs.realpathSync(root), privateRoot = fs.existsSync(home()) ? fs.realpathSync(home()) : home(), privateIsInsideWorkspace = privateRoot.startsWith(resolved + path.sep);
  if (resolved === privateRoot) throw new Error('The private bzzy state directory cannot be used as a project workspace.');
  const omit = omissionRecorder(omissions);
  const omittedCaches = new Set();
  const cachePath = name => {
    const relative = runtimeCachePath(name);
    if (!relative) return false;
    if (!omittedCaches.has(relative)) { omissions.push({ path: relative, reason: 'runtime_cache' }); omittedCaches.add(relative); }
    return true;
  };
  let names;
  try { names = execFileSync('git', ['-C', root, 'ls-files', '-co', '--exclude-standard', '-z'], { maxBuffer: 64 * MiB, stdio: ['ignore', 'pipe', 'ignore'] }).toString().split('\0').filter(Boolean); }
  catch (error) {
    // Never fall back to a walk that could include Git-ignored files after
    // truncation. A partial empty copy is safe; native parent work can continue.
    if (error.code === 'ENOBUFS') {
      omissions.push({ reason: 'snapshot_limit', limit: 'listingBytes', limitValue: 64 * MiB, pathsTruncated: true, omittedCount: 0, unknownCount: true });
      omittedDirectories.add(''); return {};
    }
    names = [];
    const walk = (dir, prefix = '') => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
      catch (error) {
        if (!recoverableFileError(error)) throw error;
        omittedDirectories.add(prefix); omit({ path: prefix || '.', reason: 'snapshot_unavailable', kind: 'directory', code: error.code }); return;
      }
      for (const entry of entries) {
        if (privateIsInsideWorkspace && path.resolve(dir, entry.name) === privateRoot) continue;
        const relative = path.join(prefix, entry.name);
        if (excluded.has(entry.name) || privateWorkspacePath(relative)) continue;
        if (cachePath(relative)) continue;
        if (entry.isDirectory()) walk(path.join(dir, entry.name), relative);
        else if (entry.isFile()) names.push(relative);
      }
    }; walk(resolved);
  }
  const result = {}, files = [], preferred = new Set(priority); let total = 0;
  for (const name of [...new Set(names)].sort((a, b) => Number(preferred.has(b)) - Number(preferred.has(a)) || (a < b ? -1 : a > b ? 1 : 0))) {
    const absolute = path.resolve(resolved, name);
    if (privateIsInsideWorkspace && (absolute === privateRoot || absolute.startsWith(privateRoot + path.sep))) continue;
    if (name.split(path.sep).some(p => excluded.has(p)) || privateWorkspacePath(name)) continue;
    if (cachePath(name)) continue;
    let file, stat;
    try { file = inside(root, name, { exists: false }); stat = fs.lstatSync(file); }
    catch (error) {
      if (!recoverableFileError(error)) throw error;
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) { omittedPaths.add(name); omit({ path: name, reason: 'snapshot_unavailable', code: error.code }); }
      continue;
    }
    if (!stat.isFile()) continue;
    const diagnostic = recognizedDebugArtifact(file);
    if (diagnostic) { omissions.push({ path: name, ...diagnostic }); continue; }
    const size = stat.size;
    const limit = size > limits.maxFileMiB * MiB ? 'maxFileMiB' : files.length >= limits.maxFiles ? 'maxFiles' : total + size > limits.maxTotalMiB * MiB ? 'maxTotalMiB' : null;
    if (limit) { omittedPaths.add(name); omit({ path: name, reason: 'snapshot_limit', limit, limitValue: limits[limit], bytes: size }); continue; }
    total += size;
    files.push({ name, file, size });
  }
  // Only hash files that fit. Files that disappear or change during capture are
  // omissions, never an excuse to stop unrelated goal work or widen permissions.
  for (const { name, file, size } of files) {
    try {
      const info = snapshotInfo(file, size);
      if (info.size !== size) { omittedPaths.add(name); omit({ path: name, reason: 'snapshot_changed', bytes: size }); continue; }
      result[name] = info;
    } catch (error) {
      if (!recoverableFileError(error)) throw error;
      omittedPaths.add(name); omit({ path: name, reason: 'snapshot_unavailable', code: error.code, bytes: size });
    }
  }
  return result;
}
export function snapshotWorkspace(session, label = 'snapshot', { ui } = {}) {
  const limits = snapshotLimits(), omissions = [], manifest = workspaceManifest(session.cwd, limits, { omissions }), id = randomUUID();
  const directory = path.join(home(), 'snapshots', id); privateDir(directory);
  const omit = omissionRecorder(omissions);
  try {
    for (const relative of Object.keys(manifest)) {
      const target = path.join(directory, relative); privateDir(path.dirname(target));
      try {
        fs.copyFileSync(inside(session.cwd, relative), target, fs.constants.COPYFILE_FICLONE);
        if (snapshotInfo(target, manifest[relative].size).sha256 === manifest[relative].sha256) continue;
        omit({ path: relative, reason: 'snapshot_changed', bytes: manifest[relative].size });
      } catch (error) {
        if (!recoverableFileError(error)) throw error;
        omit({ path: relative, reason: 'snapshot_unavailable', code: error.code, bytes: manifest[relative].size });
      }
      fs.rmSync(target, { force: true }); delete manifest[relative];
    }
    // Dependencies are explicitly outside the source snapshot; available read-only to tools.
    if (fs.existsSync(path.join(session.cwd, 'node_modules'))) fs.symlinkSync(path.join(session.cwd, 'node_modules'), path.join(directory, 'node_modules'));
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  const record = { id, sessionId: session.id, label, source: session.cwd, directory, manifest, limits, omissions,
    omissionPolicy, manifestHash: digest(manifest), createdAt: now() };
  writeJson(path.join(home(), 'snapshots', `${id}.json`), record); putRecord('snapshot', id, record);
  appendEvent(session.id, 'snapshot', { id, label, manifestHash: record.manifestHash, omissions, omissionPolicy: record.omissionPolicy });
  const summary = snapshotOmissionSummary(record);
  if (summary) {
    const data = { message: `Workspace snapshot skipped ${summary.unknownCount ? 'some' : summary.skippedFiles} file(s) that exceeded its budget or were unavailable. Continuing with available files.`, snapshotId: id, ...summary };
    if (ui) ui.event('info', data); else appendEvent(session.id, 'info', data);
  }
  return record;
}
export function copyWorkspaceSnapshot(snapshot, directory, { sessionId = snapshot.sessionId } = {}) {
  const source = fs.realpathSync(snapshot.directory), omissions = (snapshot.omissions || []).map(item => ({ ...item, phase: 'snapshot' }));
  fs.cpSync(source, directory, { recursive: true, dereference: false, mode: fs.constants.COPYFILE_FICLONE,
    filter(file) {
      const cache = runtimeCachePath(path.relative(source, file));
      if (cache) { omissions.push({ path: cache, reason: 'runtime_cache', phase: 'copy-source' }); return false; }
      if (!fs.lstatSync(file).isFile()) return true;
      const diagnostic = recognizedDebugArtifact(file);
      if (!diagnostic) return true;
      omissions.push({ path: path.relative(source, file), ...diagnostic, phase: 'copy-source' }); return false;
    } });
  const result = { snapshotId: snapshot.id, directory, omissions, omissionPolicy };
  if (sessionId) appendEvent(sessionId, 'snapshot.copy', result);
  return result;
}
export function inspectWorkspace(snapshot, cwd) {
  // Limits are host resource settings, not evidence authority. A resumed worker
  // must honor today's settings instead of remaining stuck on a historical cap.
  const omissions = [], omittedPaths = new Set(), omittedDirectories = new Set(), before = { ...snapshot.manifest };
  const current = workspaceManifest(cwd, snapshotLimits(), { omissions, omittedPaths, omittedDirectories, priority: Object.keys(before) }), changes = [], uninspected = [];
  const baseline = (snapshot.omissions || []).map(item => ({ ...item, phase: 'baseline' }));
  // Older snapshots may already contain diagnostic exports. Validate that saved
  // copy too: a worker never owes deletion/integration of diagnostic data. If
  // that path now holds ordinary source, it remains an observable new change.
  for (const file of Object.keys(before)) {
    if (omittedPaths.has(file) || [...omittedDirectories].some(dir => !dir || file.startsWith(dir + path.sep))) { delete before[file]; uninspected.push(file); continue; }
    const cache = runtimeCachePath(file);
    if (cache) {
      delete before[file];
      if (!baseline.some(item => item.path === cache && item.reason === 'runtime_cache')) baseline.push({ path: cache, reason: 'runtime_cache', phase: 'baseline' });
      continue;
    }
    try {
      const diagnostic = snapshot.directory && recognizedDebugArtifact(inside(snapshot.directory, file));
      if (diagnostic) { delete before[file]; baseline.push({ path: file, ...diagnostic, phase: 'baseline' }); }
    } catch { /* An unavailable saved file is not an exclusion authority. */ }
  }
  for (const file of new Set([...Object.keys(before), ...Object.keys(current)])) {
    if (before[file]?.sha256 !== current[file]?.sha256) changes.push({ path: file, before: before[file] || null, after: current[file] || null });
  }
  Object.defineProperty(changes, 'omissions', { value: [...baseline, ...omissions.map(item => ({ ...item, phase: 'current' }))], enumerable: false });
  Object.defineProperty(changes, 'uninspected', { value: uninspected, enumerable: false });
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
