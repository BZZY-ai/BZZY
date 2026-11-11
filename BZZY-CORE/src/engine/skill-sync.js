import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { importSkill, skillMetadata, skillStorageId, scopeSkillToProject } from './skills.js';
import { resolveProjectIdentity } from './project-identity.js';
import { getRecord, putRecord, digest, now } from './database.js';
import { home, privateDir } from './files.js';

const limits = { directories: 4096, skills: 512, bytes: 128 * 1024 * 1024 };
const bindingKind = 'core.skill.codex-sync';
const hash = /^[a-f0-9]{64}$/;
const issue = error => /credential|private binding/i.test(error.message) ? 'Private content detected.'
  : /link|unsafe|hidden|authentication/i.test(error.message) ? 'Linked, hidden or unsafe resources.'
  : /exceed|bounded|limit/i.test(error.message) ? 'Skill exceeds import limits.'
  : /changed/i.test(error.message) ? 'Source changed; sync again.' : 'Invalid or unavailable skill folder.';

// Discovery searches skill locations, never provider login/config locations.
// Options are trusted local administration/test seams, never a model/RPC API.
// Labels name a location for owner views without exposing absolute paths.
export function codexSkillRoots({ cwd = process.cwd(), userHome = os.homedir(),
  codexHome = process.env.CODEX_HOME, bzzyCodexHome = process.env.BZZY_CODEX_HOME,
  adminRoot = '/etc/codex/skills', platform = process.platform, extraRoots = [] } = {}) {
  if (!['darwin', 'linux'].includes(platform)) throw new Error('Codex skill sync supports macOS and Linux.');
  const current = fs.realpathSync(cwd), ancestors = []; let repository;
  for (let cursor = current, depth = 0; depth < 128; depth++) {
    ancestors.push(cursor);
    if (fs.existsSync(path.join(cursor, '.git'))) { repository = cursor; break; }
    const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
  const roots = (repository ? ancestors : [current]).map(directory => ({ scope: 'project', label: 'this project', path: path.join(directory, '.agents', 'skills') }));
  roots.push({ scope: 'user', label: '~/.agents', path: path.join(userHome, '.agents', 'skills') });
  const legacy = path.resolve(userHome, '.codex');
  for (const [directory, label] of [[codexHome, '$CODEX_HOME'], [bzzyCodexHome, '$BZZY_CODEX_HOME'], [legacy, '~/.codex']]) {
    if (!directory) continue;
    const resolved = path.resolve(directory);
    roots.push({ scope: 'codex', label: resolved === legacy ? '~/.codex' : label, path: path.join(resolved, 'skills') });
  }
  roots.push({ scope: 'admin', label: '/etc/codex', path: path.resolve(adminRoot) });
  const unique = [...new Map(roots.map(root => [path.resolve(root.path), root])).values()];
  // An owner-chosen folder never relabels or rescopes a standard location.
  for (const directory of Array.isArray(extraRoots) ? extraRoots.slice(0, 8) : []) {
    const resolved = path.resolve(directory);
    if (!unique.some(root => path.resolve(root.path) === resolved)) unique.push({ scope: 'folder', label: 'other folder', path: resolved });
  }
  return unique;
}

export function discoverCodexSkills(options = {}) {
  const roots = codexSkillRoots(options), candidates = [], issues = [], seen = new Set();
  let visited = 0, truncated = false;
  const visit = (directory, root, depth = 0, system = false) => {
    const scope = root.scope;
    if (++visited > limits.directories || candidates.length >= limits.skills) { truncated = true; return; }
    try {
      const stat = fs.lstatSync(directory);
      if (stat.isSymbolicLink()) { issues.push({ scope, source: directory, reason: 'Linked skill folders are not imported.' }); return; }
      if (!stat.isDirectory()) return;
      const canonical = fs.realpathSync(directory);
      if (seen.has(canonical)) return;
      seen.add(canonical);
      if (fs.existsSync(path.join(directory, 'SKILL.md'))) {
        candidates.push({ scope, label: system ? 'Codex system' : root.label, source: canonical, ...(system ? { system: true } : {}) }); return;
      }
      if (depth >= 4) { issues.push({ scope, source: directory, reason: 'Skill discovery nesting exceeds four levels.' }); return; }
      const entries = [], handle = fs.opendirSync(directory); let read = 0;
      try {
        for (let entry; (entry = handle.readSync());) {
          if (++read > limits.directories - visited) { truncated = true; break; }
          if (entry.name === '.system' || !entry.name.startsWith('.') && !/^(?:auth|credentials|node_modules)$/i.test(entry.name)) entries.push(entry.name);
        }
      } finally { handle.closeSync(); }
      for (const name of entries.sort()) {
        visit(path.join(directory, name), root, depth + 1, system || name === '.system');
        if (truncated) break;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') issues.push({ scope, source: directory, reason: 'Skill location is unavailable.' });
    }
  };
  for (const root of roots) { visit(root.path, root); if (truncated) break; }
  return { roots, candidates, issues, truncated };
}

// Codex tolerates names that BZZY's portable library spells in lowercase with
// hyphens, such as my_skill. Only that frontmatter line changes, in a private
// staged copy; the Codex folder itself is never modified.
function codexManifest(source) {
  let fd, data;
  try { fd = fs.openSync(path.join(source, 'SKILL.md'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
  catch (error) { throw error.code === 'ELOOP' ? new Error('Linked SKILL.md is unsafe.') : error; }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error('SKILL.md is not a regular file.');
    if (stat.size > 128 * 1024) throw new Error('SKILL.md exceeds 128 KiB.');
    data = fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
  // Strict decoding: a staged copy must never silently repair invalid UTF-8.
  const markdown = new TextDecoder('utf-8', { fatal: true }).decode(data);
  try { const metadata = skillMetadata(markdown); return { ...metadata, rawName: metadata.name }; }
  catch (error) {
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
    const line = frontmatter && /^name:[ \t]*(["']?)([^\r\n]*?)\1[ \t]*$/m.exec(frontmatter[1]);
    const raw = line?.[2], name = raw?.toLowerCase().replace(/[\s_]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
    if (!name || name === raw) throw error;
    const start = markdown.indexOf('\n') + 1, block = frontmatter[1];
    const normalized = markdown.slice(0, start) + block.slice(0, line.index) + `name: ${name}` + block.slice(line.index + line[0].length) + markdown.slice(start + block.length);
    return { ...skillMetadata(normalized), rawName: raw, markdown: normalized };
  }
}

function withCodexPackage(source, manifest, operation) {
  if (!manifest.markdown) return operation(source);
  const parent = path.join(home(), 'skills'); privateDir(parent);
  const stage = fs.mkdtempSync(path.join(parent, '.codex-')), target = path.join(stage, manifest.name);
  try {
    fs.cpSync(source, target, { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false,
      filter: item => !/^(?:\.DS_Store|\._.*)$/.test(path.basename(item)) });
    fs.writeFileSync(path.join(target, 'SKILL.md'), manifest.markdown, { mode: 0o600 });
    return operation(target);
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}

const counters = { imported: 'imported', updated: 'updated', unchanged: 'unchanged', conflict: 'conflicts', duplicate: 'duplicates', rejected: 'rejected' };

// One classifier serves the read-only table, a selective import and full sync.
// mode.all imports every importable package; mode.selection imports only the
// sourceId/version pairs the owner checked in a scan and reports only those.
// Unselected entries get no side effects, so a scan never installs, relabels
// or creates project state. Earlier names still win over later locations.
function codexCatalog(options, mode) {
  const discovery = discoverCodexSkills(options), results = [], names = new Map(), cwd = options.cwd || process.cwd();
  const counts = { imported: 0, updated: 0, unchanged: 0, conflicts: 0, rejected: 0, duplicates: 0, scoped: 0 };
  let wanted = false;
  const record = (item, status, extra = {}) => {
    if (mode.selection && !wanted) return;
    if (counters[status]) counts[counters[status]]++;
    results.push({ ...item, status, ...extra });
  };
  let bytes = 0, project, created;
  const projectId = create => {
    project ||= resolveProjectIdentity(cwd, { readOnly: true });
    if (create && !created) {
      created = resolveProjectIdentity(cwd, { create: true });
      if (created.id !== project.id) throw new Error('Project identity changed. Scan Codex skills again.');
    }
    return project.id;
  };
  const seen = new Set();
  for (const candidate of discovery.candidates) {
    const sourceId = digest(candidate.source); seen.add(sourceId);
    wanted = Boolean(mode.all || mode.selection?.has(sourceId));
    const item = { sourceId, scope: candidate.scope, label: candidate.label, ...(candidate.system ? { system: true } : {}),
      source: candidate.source, name: path.basename(candidate.source) };
    let manifest, preview, selected;
    try {
      manifest = codexManifest(candidate.source);
      selected = candidate.scope === 'project' ? { scope: 'project', projectId: projectId(false) } : { scope: 'global' };
      preview = withCodexPackage(candidate.source, manifest, source => importSkill(source, { ...selected, preview: true }));
    } catch (error) { record(item, 'rejected', { reason: issue(error) }); continue; }
    bytes += preview.files.reduce((sum, file) => sum + file.bytes, 0);
    if (bytes > limits.bytes) { discovery.truncated = true; break; }
    Object.assign(item, { name: preview.name, ...(manifest.rawName !== preview.name ? { rawName: manifest.rawName } : {}),
      description: preview.description, target: selected.scope, version: preview.version, files: preview.files.length });
    if (mode.selection && wanted && mode.selection.get(sourceId) !== preview.version) { record(item, 'rejected', { reason: 'Changed after the scan; rescan to import it.' }); continue; }
    const key = skillStorageId(preview.name, selected), first = names.get(key);
    if (first) {
      const duplicate = first.version === preview.version;
      record(item, duplicate ? 'duplicate' : 'conflict', duplicate ? { reason: 'Same skill already discovered.' }
        : { conflictWith: 'location', reason: 'Same name has different content in an earlier skill location.' });
      continue;
    }
    names.set(key, preview);
    try {
      if (wanted && selected.scope === 'project') selected = { ...selected, projectId: projectId(true) };
      // Older sync stored project discoveries globally. Narrow only its exact
      // managed copy; retain the original payload, version history and archive.
      if (selected.scope === 'project' && !getRecord('core.skill', key)) {
        const legacy = getRecord('core.skill', preview.name), legacyBinding = getRecord(bindingKind, preview.name);
        if (legacy && legacyBinding?.sourceId === sourceId && legacyBinding.version === legacy.version) {
          if (!wanted) { record(item, 'update', { reason: 'Moves an earlier global copy into this project.' }); continue; }
          const migrated = scopeSkillToProject(preview.name, legacy.revision, selected);
          putRecord(bindingKind, key, { sourceId, version: migrated.version, updatedAt: now() }); counts.scoped++;
        }
      }
      const saved = getRecord('core.skill', key), binding = getRecord(bindingKind, key);
      if (saved?.version === preview.version) {
        if (wanted) {
          // Label unchanged legacy global imports as an explicitly re-discovered
          // global origin, without changing their review/enable decision.
          if (!saved.scope && selected.scope === 'global') putRecord('core.skill', key, { ...saved, id: key, scope: 'global', provenance: { kind: 'codex-sync' } });
          putRecord(bindingKind, key, { sourceId, version: saved.version, updatedAt: now() });
        }
        record(item, 'unchanged', { enabled: Boolean(saved.enabled) }); continue;
      }
      if (saved && (binding?.sourceId !== sourceId || binding.version !== saved.version)) {
        record(item, 'conflict', { conflictWith: 'library', reason: 'BZZY has an independent copy or local changes; it was kept.' }); continue;
      }
      if (!wanted) { record(item, saved ? 'update' : 'new'); continue; }
      // A changed package is disabled by Core for review. Unchanged versions
      // never alter the owner's current enabled/disabled decision.
      const imported = withCodexPackage(candidate.source, manifest, source => importSkill(source, { ...selected, provenance: { kind: 'codex-sync' },
        expectedRevision: saved?.revision || 0, expectedVersion: preview.version }));
      putRecord(bindingKind, key, { sourceId, version: imported.version, updatedAt: now() });
      record(item, saved ? 'updated' : 'imported', { enabled: false });
    } catch (error) { record(item, 'rejected', { reason: issue(error) }); }
  }
  if (mode.selection?.size) for (const sourceId of mode.selection.keys()) {
    wanted = !seen.has(sourceId);
    record({ sourceId }, 'rejected', { reason: discovery.truncated ? 'Not reached within the Codex scan limits.' : 'Skill folder is no longer available; scan again.' });
  }
  // A selective import reports only what the owner checked; location issues
  // belong to the scan that produced the table.
  const scanIssues = mode.selection?.size ? [] : discovery.issues;
  return { ...counts, scanned: discovery.candidates.length, locations: discovery.roots.length,
    unavailable: scanIssues.length, truncated: discovery.truncated, results, issues: scanIssues };
}

// One-way, repeatable copies into the existing immutable Core skill library.
// Source deletions never delete a BZZY skill; scripts/hooks are never executed.
export function syncCodexSkills(options = {}) { return codexCatalog(options, { all: true }); }

// Read-only scan for the owner's checkbox table. Importable entries have status
// new or update; nothing is installed and no project identity is created.
export function previewCodexSkills(options = {}) { return codexCatalog(options, {}); }

// Imports exactly the checked sourceId/version pairs from a current scan. A
// package that changed after the scan is reported instead of being imported.
export function importCodexSkills(selection, options = {}) {
  if (!Array.isArray(selection) || !selection.length || selection.length > limits.skills ||
      selection.some(item => !hash.test(item?.sourceId || '') || !hash.test(item?.version || ''))) throw new Error('Choose Codex skills from a current scan.');
  return codexCatalog(options, { selection: new Map(selection.map(item => [item.sourceId, item.version])) });
}

export const skillSyncSummary = result => `Codex → BZZY · ${result.imported} new · ${result.updated} updated · ${result.unchanged} unchanged${result.scoped ? ` · ${result.scoped} project scopes repaired` : ''} · ${result.conflicts} conflicts · ${result.rejected + result.unavailable} skipped${result.truncated ? ' · scan limit reached' : ''}. Project discoveries stay in this project; new and changed skills need review and enable once for all models.`;

// Safe CLI/report metadata. Absolute discovery paths are local binding data,
// not reusable skill metadata and never enter model prompts or public reports.
export function skillSyncReport(result) {
  return { ...result, results: result.results.map(({ source, ...item }) => item), issues: result.issues.map(({ source, ...item }) => item) };
}
