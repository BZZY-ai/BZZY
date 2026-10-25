import { listSkills, inspectSkill, readSkill, importSkill, createSkill, setSkillEnabled, skillHistory, rollbackSkill, promoteSkill, scopeSkillToProject, skillMetadata } from '@bzzy/core/engine/skills.js';
import { skillSyncSummary, skillSyncReport } from '@bzzy/core/engine/skill-sync.js';
import { loadSession } from '@bzzy/core/engine/store.js';
import { projectIdentityForSession, resolveProjectIdentity } from '@bzzy/core/engine/project-identity.js';
import { knowledgeAction, knowledgeRows } from './knowledge-ui.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sessionFor = ui => ui.sessionId && loadSession(ui.sessionId);
const projectFor = ui => {
  const session = sessionFor(ui);
  return session ? projectIdentityForSession(session) : resolveProjectIdentity(ui.tui?.cwd || process.cwd());
};
const currentContext = ui => {
  if (ui.skillScope === 'global') return { scope: 'global' };
  if (ui.skillScope === 'project') return { projectRoot: projectFor(ui).root, scope: 'project' };
  const session = sessionFor(ui); return session ? { session } : { projectRoot: projectFor(ui).root };
};
const writeContext = ui => ui.skillScope === 'global' ? { scope: 'global' } : { projectRoot: projectFor(ui).root, scope: 'project' };
const contextKey = ui => JSON.stringify([ui.sessionId || null, ui.tui?.cwd || null, ui.skillScope || 'current']);
async function prompt(ui, method, ...arguments_) {
  const original = contextKey(ui), answer = await ui[method](...arguments_);
  if (contextKey(ui) !== original) throw new Error('Conversation changed. Reopen Skills for this project before acting.');
  return answer;
}
const preview = (ui, id, options = {}) => {
  ui.skillPreview = { ...readSkill(id, { ...currentContext(ui), ...options, enabledOnly: false }), historical: Boolean(options.historical) };
  ui.skillPreviewContext = contextKey(ui);
};
const resetViews = ui => { ui.skillPreview = null; ui.skillHistoryState = null; ui.skillPromotionDraft = null; ui.skillSyncDetails = false; ui.knowledgeView = null; };

export function codexSkillDirectories(directory) {
  const root = fs.realpathSync(directory), stat = fs.lstatSync(root);
  if (!stat.isDirectory()) throw new Error('Choose a directory containing Codex skill folders.');
  const candidates = [], issues = [];
  const add = (folder, name) => {
    const entry = fs.lstatSync(folder);
    if (entry.isSymbolicLink()) { issues.push({ name, reason: 'Linked skill folders are not imported.' }); return; }
    if (entry.isDirectory() && fs.existsSync(path.join(folder, 'SKILL.md'))) candidates.push({ source: folder, name });
  };
  if (fs.existsSync(path.join(root, 'SKILL.md'))) add(root, path.basename(root));
  else {
    const ordered = fs.readdirSync(root, { withFileTypes: true })
      .sort((a, b) => a.name.replaceAll('_', '-').localeCompare(b.name.replaceAll('_', '-')));
    for (const entry of ordered) {
      if (candidates.length >= 512) break;
      if (entry.name.startsWith('.') || !entry.isDirectory()) continue;
      add(path.join(root, entry.name), entry.name);
    }
  }
  return { root, candidates, issues, truncated: candidates.length >= 512 };
}

function codexSkillManifest(directory) {
  const file = path.join(directory, 'SKILL.md'), stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 128 * 1024) throw new Error('SKILL.md is not a bounded regular file.');
  const markdown = fs.readFileSync(file, 'utf8');
  try {
    const metadata = skillMetadata(markdown);
    return { rawName: metadata.name, metadata, normalizedMarkdown: markdown };
  } catch (error) {
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown), name = /^name:\s*(.+?)\s*$/m.exec(frontmatter?.[1] || '')?.[1];
    const normalized = name?.replaceAll('_', '-').toLowerCase();
    if (!normalized || normalized === name) throw error;
    const normalizedMarkdown = markdown.replace(/^name:\s*.+$/m, `name: ${normalized}`);
    return { rawName: name, metadata: skillMetadata(normalizedMarkdown), normalizedMarkdown };
  }
}

function stageCodexSkill(candidate, manifest) {
  if (manifest.rawName === manifest.metadata.name) return { source: candidate.source, cleanup() {} };
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-codex-skill-'));
  const target = path.join(temporary, manifest.metadata.name);
  try {
    fs.cpSync(candidate.source, target, {
      recursive: true,
      dereference: false,
      filter: source => !['.DS_Store'].includes(path.basename(source)) && !path.basename(source).startsWith('._'),
    });
    fs.writeFileSync(path.join(target, 'SKILL.md'), manifest.normalizedMarkdown, { mode: 0o600 });
    return { source: target, cleanup: () => fs.rmSync(temporary, { recursive: true, force: true }) };
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

export async function importCodexSkillDirectory(ui, {
  directory,
  discover = codexSkillDirectories,
  importer = importSkill,
} = {}) {
  const fallback = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'skills');
  if (!directory) {
    const entered = await prompt(ui, 'ask',
      `Codex skills directory · one folder per skill · default: ${fallback} · Esc cancels`);
    if (entered == null) return null;
    directory = entered.trim() || fallback;
  }
  const found = discover(path.resolve(directory));
  if (!found.candidates.length) {
    ui.event('info', { message: `No skill folders with SKILL.md found in ${found.root}.` });
    return null;
  }
  const projectRoot = projectFor(ui).root;
  const projectDirectory = path.resolve(path.join(projectRoot, '.agents', 'skills'));
  const projectScope = ui.skillScope === 'project'
    || (ui.skillScope !== 'global' && (found.root === projectDirectory || found.root.startsWith(projectDirectory + path.sep)));
  const scopeOptions = projectScope ? { ...currentContext(ui), scope: 'project' } : { scope: 'global' };
  const choices = [], manifests = new Map();
  for (const candidate of found.candidates) {
    try {
      const manifest = codexSkillManifest(candidate.source);
      if (choices.some(choice => choice.importName === manifest.metadata.name)) {
        found.issues.push({ name: manifest.rawName, reason: 'Duplicate skill name; choose one source at a time.' });
        continue;
      }
      const rename = manifest.rawName === manifest.metadata.name ? '' : ` · imports as ${manifest.metadata.name}`;
      choices.push({ value: candidate.source, label: `${manifest.rawName}${rename}`, importName: manifest.metadata.name,
        description: manifest.metadata.description, candidate, manifest });
      manifests.set(candidate.source, manifest);
    } catch {
      found.issues.push({ name: candidate.name, reason: 'Invalid or unsafe skill package.' });
    }
  }
  if (!choices.length) {
    ui.event('info', { message: 'No valid Codex skill packages were found.' });
    return null;
  }
  const selected = await ui.chooseMany(`Import from Codex · ${choices.length} available · ${projectScope ? 'this project' : 'Core / global'}`, choices,
    { hint: 'Space toggles · ↑/↓ moves · Enter imports selected · Esc cancels', confirmLabel: 'Import selected' });
  if (!selected?.length) return null;
  const counts = { imported: 0, updated: 0, unchanged: 0, conflicts: 0, rejected: 0, scanned: found.candidates.length,
    unavailable: found.issues.length, truncated: found.truncated };
  const results = [];
  for (const choice of choices.filter(item => selected.includes(item.value))) {
    const manifest = manifests.get(choice.value), staged = stageCodexSkill(choice.candidate, manifest);
    try {
      const preview = importer(staged.source, { ...scopeOptions, preview: true, provenance: { kind: 'codex-sync' } });
      let existing = null;
      try { existing = inspectSkill(preview.name, scopeOptions); } catch {}
      if (existing?.version === preview.version) {
        counts.unchanged++;
        results.push({ name: preview.name, status: 'unchanged', enabled: existing.enabled });
        continue;
      }
      const skill = importer(staged.source, { ...scopeOptions, expectedRevision: existing?.revision || 0,
        provenance: { kind: 'codex-sync' } });
      const status = existing ? 'updated' : 'imported'; counts[status]++;
      results.push({ name: skill.name, status, enabled: false });
    } catch {
      counts.rejected++;
      results.push({ name: manifest.metadata.name, status: 'rejected', reason: 'Import failed or the package changed.' });
    } finally { staged.cleanup(); }
  }
  return { ...counts, locations: 1, results, issues: found.issues };
}

export function skillRows(ui) {
  if (ui.knowledgeView) return knowledgeRows(ui);
  if (ui.skillAdminContext && ui.skillAdminContext !== contextKey(ui)) resetViews(ui);
  if (ui.skillPromotionDraft) {
    const { definition } = ui.skillPromotionDraft;
    return [{ text: 'Review a separate global workflow', tone: 'accent' }, { text: definition.name }, { text: definition.description }, { text: definition.instructions },
      { text: 'Only this generic text enters the global candidate; project resources stay private.', tone: 'muted' },
      { text: 'Create reviewed global candidate', action: 'promote-confirm' }, { text: 'Cancel promotion', action: 'library' }];
  }
  if (ui.skillHistoryState && !ui.skillPreview) {
    const { skill, entries } = ui.skillHistoryState, seen = new Set();
    const rows = [{ text: `${skill.name} · ${skill.scope} · version history`, tone: 'accent' }];
    for (const entry of entries) {
      rows.push({ text: `${entry.action} · ${entry.version.slice(0, 8)} · revision ${entry.revision}`, tone: 'muted' });
      if (!seen.has(entry.version)) {
        seen.add(entry.version); rows.push({ text: 'Read this immutable version', action: `history-read:${skill.id}|${entry.version}` });
        if (entry.version !== skill.version) rows.push({ text: 'Restore this version for review', action: `rollback:${skill.id}|${entry.version}|${skill.revision}` });
      }
    }
    return [...rows, { text: 'Back to library', action: 'library' }];
  }
  if (ui.skillSyncDetails && ui.skillSyncResult) {
    const result = ui.skillSyncResult, items = [...result.results.filter(item => ['conflict', 'rejected'].includes(item.status)), ...result.issues];
    const offset = ui.skillSyncOffset || 0;
    return [{ text: 'Codex sync details', tone: 'accent' },
      ...items.slice(offset, offset + 20).flatMap(item => [{ text: `${item.name || item.scope} · ${item.status || 'skipped'}` }, { text: item.reason, tone: 'muted' }]),
      ...(offset ? [{ text: 'Previous details', action: 'sync-previous' }] : []),
      ...(offset + 20 < items.length ? [{ text: 'More details', action: 'sync-next' }] : []),
      { text: 'Back to library', action: 'library' }];
  }
  if (ui.skillPreview) {
    if (ui.skillPreviewContext !== contextKey(ui)) { ui.skillPreview = null; ui.skillHistoryState = null; }
  }
  if (ui.skillPreview) {
    const page = ui.skillPreview;
    return [{ text: `${page.name}/${page.file} · ${page.scope} · ${page.version.slice(0, 8)}${page.historical ? ' · historical' : ''}`, tone: 'accent' }, { text: page.text },
      ...(page.nextOffset != null ? [{ text: 'Read next page', action: 'read-next' }] : []), { text: 'Supporting files', action: 'files' },
      ...(ui.skillHistoryState ? [{ text: 'Back to version history', action: 'history-back' }] : []), { text: 'Back to library', action: 'library' }];
  }
  const query = ui.skillQuery || '', offset = ui.skillOffset || 0;
  const page = listSkills({ ...currentContext(ui), query, offset, limit: 30 }), target = ui.skillScope === 'global' ? 'global' : 'project';
  const rows = [ { text: 'Codex-compatible skill library · Core/global + this project', tone: 'accent' },
    { text: 'Each skill folder has SKILL.md plus optional scripts/, references/, assets/ and agents/openai.yaml', tone: 'muted' },
    { text: 'Discovery: project .agents/skills · user .agents/skills · $CODEX_HOME/skills · ~/.codex/skills', tone: 'muted' },
    { text: 'Scope: ' + (ui.skillScope === 'global' ? 'Global methods' : ui.skillScope === 'project' ? 'This project only' : 'This project + global methods'), action: 'scope' },
    { text: 'Project memory and history', action: 'knowledge:memory' }, { text: 'Learning reviews and candidates', action: 'knowledge:home' },
    { text: 'Sync skills from Codex into BZZY', action: 'sync' }, { text: `Import one skill folder or ZIP · ${target}`, action: 'import' }, { text: `Create ${target} skill`, action: 'create' }, { text: `Search${query ? ': ' + query : '…'}`, action: 'search' }, { text: '' } ];
  if (ui.skillSyncResult) {
    rows.push({ text: skillSyncSummary(ui.skillSyncResult), tone: 'muted' });
    if (ui.skillSyncResult.conflicts || ui.skillSyncResult.rejected || ui.skillSyncResult.unavailable) rows.push({ text: 'Sync details', action: 'sync-details' });
  }
  const appendSkill = skill => {
    const id = skill.id || skill.name;
    rows.push({ text: `${skill.enabled ? '●' : '○'} ${skill.name} · ${skill.enabled ? 'enabled' : 'disabled'}`, action: `view:${id}` });
    rows.push({ text: '  ' + skill.description, tone: 'muted' });
    rows.push({ text: `  ${skill.enabled ? 'Disable' : 'Enable'} · ${skill.version.slice(0, 8)}`, action: `toggle:${id}` }, { text: '  Version history and rollback', action: `history:${id}` });
    if (skill.scope === 'project') rows.push({ text: '  Propose a separate global method', action: `promote:${id}` });
    if (skill.needsScopeReview) rows.push({ text: '  Keep this legacy copy in this project', action: `scope-project:${id}` });
  };
  const projectSkills = page.skills.filter(skill => skill.scope === 'project');
  const globalSkills = page.skills.filter(skill => skill.scope !== 'project');
  if (projectSkills.length) {
    rows.push({ text: 'PROJECT SKILLS', tone: 'accent' });
    for (const skill of projectSkills) appendSkill(skill);
  }
  if (globalSkills.length) {
    rows.push({ text: 'CORE / GLOBAL SKILLS', tone: 'accent' });
    for (const skill of globalSkills) appendSkill(skill);
  }
  if (!page.total) rows.push({ text: 'No skills yet. Import from a Codex skills directory, import one folder/ZIP, or create one.', tone: 'muted' });
  if (offset) rows.push({ text: 'Previous page', action: 'previous' });
  if (page.nextOffset != null) rows.push({ text: 'Next page', action: 'next' });
  return rows;
}

export async function skillsCommand(text, ui, { sync, discover = codexSkillDirectories, importer = importSkill } = {}) {
  if (!/^\/skills(?:\s|$)/.test(text)) return false;
  ui.openTerminal();
  if (!ui.tui) { ui.event('error', { message: 'Open the interactive terminal to manage skills.' }); return true; }
  ui.tui.setPanel('skills');
  const action = text.slice(7).trim();
  if (!action.startsWith('knowledge:')) ui.knowledgeView = null;
  if (!action.startsWith('promote:') && action !== 'promote-confirm') ui.skillPromotionDraft = null;
  try {
    if (action.startsWith('knowledge:')) await knowledgeAction(action.slice(10), ui);
    else if (!action || action === 'library') resetViews(ui);
    else if (action === 'scope') {
      const scope = await prompt(ui, 'chooseOne', 'Skills visible in this library', [
        { value: 'current', label: 'This project + global methods', selected: !ui.skillScope || ui.skillScope === 'current' },
        { value: 'project', label: 'This project only', selected: ui.skillScope === 'project' },
        { value: 'global', label: 'Global reusable methods', selected: ui.skillScope === 'global' }]);
      if (scope) { ui.skillScope = scope; ui.skillOffset = 0; resetViews(ui); }
    } else if (action === 'sync' || action === 'sync codex') {
      const result = sync
        ? sync({ cwd: ui.tui.cwd || process.cwd() })
        : await importCodexSkillDirectory(ui, { discover, importer });
      if (!result) return true;
      resetViews(ui); ui.skillSyncResult = skillSyncReport(result); ui.skillQuery = ''; ui.skillOffset = 0;
      ui.event('info', { message: skillSyncSummary(result) });
    } else if (action === 'sync-details') { ui.skillSyncDetails = true; ui.skillSyncOffset = 0; }
    else if (action === 'sync-next' || action === 'sync-previous') ui.skillSyncOffset = Math.max(0, (ui.skillSyncOffset || 0) + (action === 'sync-next' ? 20 : -20));
    else if (action === 'import') {
      const source = (await prompt(ui, 'ask', 'Skill folder or ZIP · absolute path · Esc cancels'))?.trim();
      if (source) { const skill = importSkill(source, writeContext(ui)); resetViews(ui); ui.event('info', { message: `Imported ${skill.name} into ${skill.scope} scope. Review it before enabling.` }); }
    } else if (action === 'create') {
      const name = (await prompt(ui, 'ask', 'Skill name · lowercase words separated by hyphens'))?.trim();
      if (!name) return true;
      const description = (await prompt(ui, 'ask', 'When should this skill be used?'))?.trim();
      if (!description) return true;
      const instructions = (await prompt(ui, 'ask', 'Workflow instructions · Shift+Enter adds lines'))?.trim();
      if (!instructions) return true;
      const skill = createSkill({ name, description, instructions }, writeContext(ui)); resetViews(ui);
      ui.event('info', { message: `Created ${skill.name} in ${skill.scope} scope. Review it before enabling.` });
    } else if (action === 'search') { const query = await prompt(ui, 'ask', 'Search skills · empty shows all'); if (query != null) { resetViews(ui); ui.skillQuery = query.trim(); ui.skillOffset = 0; } }
    else if (action === 'next' || action === 'previous') ui.skillOffset = Math.max(0, (ui.skillOffset || 0) + (action === 'next' ? 30 : -30));
    else if (action.startsWith('toggle:')) {
      const skill = inspectSkill(action.slice(7), currentContext(ui));
      if (!skill.enabled && await prompt(ui, 'chooseOne', `Enable ${skill.name} in ${skill.scope} scope? Existing session permissions apply.`, [{ value: 'cancel', label: 'Cancel', selected: true }, { value: 'enable', label: 'Enable for all models' }]) !== 'enable') return true;
      setSkillEnabled(skill.id, !skill.enabled, skill.revision, currentContext(ui));
    } else if (action.startsWith('view:')) {
      ui.skillHistoryState = null; preview(ui, action.slice(5));
    } else if (action.startsWith('history:')) {
      ui.skillPreview = null; ui.skillHistoryState = skillHistory(action.slice(8), currentContext(ui));
    } else if (action === 'history-back') ui.skillPreview = null;
    else if (action.startsWith('history-read:')) {
      const [id, version] = action.slice(13).split('|'); preview(ui, id, { version, historical: true });
    } else if (action.startsWith('rollback:')) {
      const [id, version, revision] = action.slice(9).split('|');
      if (await prompt(ui, 'chooseOne', `Restore ${version.slice(0, 8)}? It will need review before enabling.`, [{ value: 'cancel', label: 'Cancel', selected: true }, { value: 'restore', label: 'Restore for review' }]) === 'restore') {
        rollbackSkill(id, version, Number(revision), currentContext(ui)); ui.skillHistoryState = skillHistory(id, currentContext(ui)); ui.skillPreview = null;
      }
    } else if (action.startsWith('scope-project:')) {
      const skill = inspectSkill(action.slice(14), currentContext(ui));
      if (await prompt(ui, 'chooseOne', `Keep ${skill.name} only in this engagement? The original is archived.`, [{ value: 'cancel', label: 'Cancel', selected: true }, { value: 'scope', label: 'Use project scope' }]) === 'scope') {
        scopeSkillToProject(skill.id, skill.revision, { projectRoot: projectFor(ui).root }); resetViews(ui); ui.skillScope = 'current';
      }
    } else if (action.startsWith('promote:')) {
      const source = inspectSkill(action.slice(8), currentContext(ui));
      const name = (await prompt(ui, 'ask', 'Name for the generic global skill · lowercase-hyphenated'))?.trim(); if (!name) return true;
      const description = (await prompt(ui, 'ask', 'When should this generic method apply?'))?.trim(); if (!description) return true;
      const instructions = (await prompt(ui, 'ask', 'Generic instructions only · parameterize targets, paths and accounts · project evidence stays private'))?.trim(); if (!instructions) return true;
      ui.skillPreview = null; ui.skillHistoryState = null;
      ui.skillPromotionDraft = { sourceId: source.id, sourceRevision: source.revision, definition: { name, description, instructions } };
    } else if (action === 'promote-confirm' && ui.skillPromotionDraft) {
      const draft = ui.skillPromotionDraft;
      const candidate = promoteSkill(draft.sourceId, { ...draft.definition, expectedRevision: draft.sourceRevision, reviewed: true }, { projectRoot: projectFor(ui).root });
      resetViews(ui); await knowledgeAction('candidates', ui); await knowledgeAction('candidate:' + encodeURIComponent(candidate.id), ui);
      ui.event('info', { message: 'A separate global candidate was created. Evaluate it on approved offline cases before enabling.' });
    }
    else if (action === 'read-next' && ui.skillPreview?.nextOffset != null) {
      const page = ui.skillPreview;
      preview(ui, page.id || page.name, { file: page.file, offset: page.nextOffset, version: page.version, historical: page.historical });
    } else if (action === 'files' && ui.skillPreview) {
      const page = ui.skillPreview;
      const file = await prompt(ui, 'chooseOne', 'Skill files', page.files.map(file => ({ value: file.path, label: `${file.path} · ${file.bytes} bytes` })));
      if (file) preview(ui, page.id || page.name, { file, version: page.version, historical: page.historical });
    }
  } catch (error) { ui.event('error', { message: ['ENOENT', 'EACCES', 'EPERM', 'ELOOP', 'ENOTDIR'].includes(error.code) ? 'Skill source unavailable. Check its location and permissions.' : error.message }); }
  finally { ui.skillAdminContext = contextKey(ui); ui.tui.bodyCache = null; ui.tui.scroll = 0; ui.tui.skillFocus = 0; ui.tui.skillTopRequested = true; ui.tui.schedule(); }
  return true;
}
