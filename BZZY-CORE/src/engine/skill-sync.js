import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { importSkill, skillStorageId, scopeSkillToProject } from './skills.js';
import { resolveProjectIdentity } from './project-identity.js';
import { getRecord, putRecord, digest, now } from './database.js';

const limits = { directories: 4096, skills: 512, bytes: 128 * 1024 * 1024 };
const bindingKind = 'core.skill.codex-sync';
const issue = error => /credential|private binding/i.test(error.message) ? 'Private content detected.'
  : /link|unsafe|hidden|authentication/i.test(error.message) ? 'Linked, hidden or unsafe resources.'
  : /exceed|bounded|limit/i.test(error.message) ? 'Skill exceeds import limits.'
  : /changed/i.test(error.message) ? 'Source changed; sync again.' : 'Invalid or unavailable skill folder.';

// Discovery searches skill locations, never provider login/config locations.
// Options are trusted local administration/test seams, never a model/RPC API.
export function codexSkillRoots({ cwd = process.cwd(), userHome = os.homedir(),
  codexHome = process.env.CODEX_HOME, bzzyCodexHome = process.env.BZZY_CODEX_HOME,
  adminRoot = '/etc/codex/skills', platform = process.platform } = {}) {
  if (!['darwin', 'linux'].includes(platform)) throw new Error('Codex skill sync supports macOS and Linux.');
  const current = fs.realpathSync(cwd), ancestors = []; let repository;
  for (let cursor = current, depth = 0; depth < 128; depth++) {
    ancestors.push(cursor);
    if (fs.existsSync(path.join(cursor, '.git'))) { repository = cursor; break; }
    const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
  const roots = (repository ? ancestors : [current]).map(directory => ({ scope: 'project', path: path.join(directory, '.agents', 'skills') }));
  roots.push({ scope: 'user', path: path.join(userHome, '.agents', 'skills') });
  for (const directory of [codexHome, bzzyCodexHome, path.join(userHome, '.codex')].filter(Boolean)) {
    roots.push({ scope: 'codex', path: path.join(path.resolve(directory), 'skills') });
  }
  roots.push({ scope: 'admin', path: path.resolve(adminRoot) });
  return [...new Map(roots.map(root => [path.resolve(root.path), root])).values()];
}

export function discoverCodexSkills(options = {}) {
  const roots = codexSkillRoots(options), candidates = [], issues = [], seen = new Set();
  let visited = 0, truncated = false;
  const visit = (directory, scope, depth = 0) => {
    if (++visited > limits.directories || candidates.length >= limits.skills) { truncated = true; return; }
    try {
      const stat = fs.lstatSync(directory);
      if (stat.isSymbolicLink()) { issues.push({ scope, source: directory, reason: 'Linked skill folders are not imported.' }); return; }
      if (!stat.isDirectory()) return;
      const canonical = fs.realpathSync(directory);
      if (seen.has(canonical)) return;
      seen.add(canonical);
      if (fs.existsSync(path.join(directory, 'SKILL.md'))) { candidates.push({ scope, source: canonical }); return; }
      if (depth >= 4) { issues.push({ scope, source: directory, reason: 'Skill discovery nesting exceeds four levels.' }); return; }
      const entries = [], handle = fs.opendirSync(directory); let read = 0;
      try {
        for (let entry; (entry = handle.readSync());) {
          if (++read > limits.directories - visited) { truncated = true; break; }
          if (entry.name === '.system' || !entry.name.startsWith('.') && !/^(?:auth|credentials|node_modules)$/i.test(entry.name)) entries.push(entry.name);
        }
      } finally { handle.closeSync(); }
      for (const name of entries.sort()) {
        visit(path.join(directory, name), scope, depth + 1);
        if (truncated) break;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') issues.push({ scope, source: directory, reason: 'Skill location is unavailable.' });
    }
  };
  for (const root of roots) { visit(root.path, root.scope); if (truncated) break; }
  return { roots, candidates, issues, truncated };
}

// One-way, repeatable copies into the existing immutable Core skill library.
// Source deletions never delete a BZZY skill; scripts/hooks are never executed.
export function syncCodexSkills(options = {}) {
  const discovery = discoverCodexSkills(options), results = [], names = new Map(); let bytes = 0;
  const counts = { imported: 0, updated: 0, unchanged: 0, conflicts: 0, rejected: 0, duplicates: 0, scoped: 0 };
  let project;
  for (const candidate of discovery.candidates) {
    const selected = candidate.scope === 'project'
      ? { scope: 'project', projectId: (project ||= resolveProjectIdentity(options.cwd || process.cwd(), { create: true })).id }
      : { scope: 'global' };
    let preview;
    try { preview = importSkill(candidate.source, { ...selected, preview: true }); }
    catch (error) { counts.rejected++; results.push({ ...candidate, status: 'rejected', reason: issue(error) }); continue; }
    bytes += preview.files.reduce((sum, file) => sum + file.bytes, 0);
    if (bytes > limits.bytes) { discovery.truncated = true; break; }
    const key = skillStorageId(preview.name, selected), first = names.get(key);
    if (first) {
      const duplicate = first.version === preview.version;
      counts[duplicate ? 'duplicates' : 'conflicts']++;
      results.push({ ...candidate, name: preview.name, status: duplicate ? 'duplicate' : 'conflict', reason: duplicate ? 'Same skill already discovered.' : 'Same name has different content in an earlier skill location.' });
      continue;
    }
    names.set(key, preview);
    const sourceId = digest(candidate.source);
    // Older sync stored project discoveries globally. Narrow only its exact
    // managed copy; retain the original payload, version history and archive.
    if (selected.scope === 'project' && !getRecord('core.skill', key)) {
      const legacy = getRecord('core.skill', preview.name), legacyBinding = getRecord(bindingKind, preview.name);
      if (legacy && legacyBinding?.sourceId === sourceId && legacyBinding.version === legacy.version) {
        try {
          const migrated = scopeSkillToProject(preview.name, legacy.revision, selected);
          putRecord(bindingKind, key, { sourceId, version: migrated.version, updatedAt: now() }); counts.scoped++;
        } catch (error) { counts.rejected++; results.push({ ...candidate, name: preview.name, status: 'rejected', reason: issue(error) }); continue; }
      }
    }
    const saved = getRecord('core.skill', key), binding = getRecord(bindingKind, key);
    if (saved?.version === preview.version) {
      // Label unchanged legacy global imports as an explicitly re-discovered
      // global origin, without changing their review/enable decision.
      if (!saved.scope && selected.scope === 'global') putRecord('core.skill', key, { ...saved, id: key, scope: 'global', provenance: { kind: 'codex-sync' } });
      putRecord(bindingKind, key, { sourceId, version: saved.version, updatedAt: now() });
      counts.unchanged++; results.push({ ...candidate, name: preview.name, status: 'unchanged', enabled: saved.enabled }); continue;
    }
    if (saved && (binding?.sourceId !== sourceId || binding.version !== saved.version)) {
      counts.conflicts++; results.push({ ...candidate, name: preview.name, status: 'conflict', reason: 'BZZY has an independent copy or local changes; it was kept.' }); continue;
    }
    try {
      // A changed package is disabled by Core for review. Unchanged versions
      // never alter the owner's current enabled/disabled decision.
      const imported = importSkill(candidate.source, { ...selected, provenance: { kind: 'codex-sync' }, expectedRevision: saved?.revision || 0, expectedVersion: preview.version });
      putRecord(bindingKind, key, { sourceId, version: imported.version, updatedAt: now() });
      const status = saved ? 'updated' : 'imported'; counts[status]++;
      results.push({ ...candidate, name: imported.name, status, enabled: false });
    } catch (error) { counts.rejected++; results.push({ ...candidate, name: preview.name, status: 'rejected', reason: issue(error) }); }
  }
  return { ...counts, scanned: discovery.candidates.length, locations: discovery.roots.length,
    unavailable: discovery.issues.length, truncated: discovery.truncated, results, issues: discovery.issues };
}

export const skillSyncSummary = result => `Codex → BZZY · ${result.imported} new · ${result.updated} updated · ${result.unchanged} unchanged${result.scoped ? ` · ${result.scoped} project scopes repaired` : ''} · ${result.conflicts} conflicts · ${result.rejected + result.unavailable} skipped${result.truncated ? ' · scan limit reached' : ''}. Project discoveries stay in this project; new and changed skills need review and enable once for all models.`;

// Safe CLI/report metadata. Absolute discovery paths are local binding data,
// not reusable skill metadata and never enter model prompts or public reports.
export function skillSyncReport(result) {
  return { ...result, results: result.results.map(({ source, ...item }) => item), issues: result.issues.map(({ source, ...item }) => item) };
}
