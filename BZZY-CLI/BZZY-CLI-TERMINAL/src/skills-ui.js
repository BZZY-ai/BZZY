import { listSkills, inspectSkill, readSkill, importSkill, createSkill, setSkillEnabled, skillHistory, rollbackSkill, promoteSkill, scopeSkillToProject, skillMetadata,
  previewSkillGlobalMove, moveSkillToGlobal, deleteSkill } from '@bzzy/core/engine/skills.js';
import { skillSyncSummary, skillSyncReport } from '@bzzy/core/engine/skill-sync.js';
import { loadSession } from '@bzzy/core/engine/store.js';
import { projectIdentityForSession, resolveProjectIdentity } from '@bzzy/core/engine/project-identity.js';
import { knowledgeAction, knowledgeRows } from './knowledge-ui.js';
import { creatorRows, startCreator, saveCreator } from './definition-creator-ui.js';
import { bundleLibraryRows, definitionBundleRows, definitionBundleAction, returnFromDefinitionBundle, cancelDefinitionBundle } from './definition-bundle-ui.js';
import { libraryToggleRow } from './library-toggle-ui.js';
import { openWorkflows } from './workflow-ui.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { home, readJson, writeJson } from './files.js';

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
const contextKey = ui => JSON.stringify([home(), ui.sessionId || null, ui.tui?.cwd || null, ui.skillScope || 'current']);
async function prompt(ui, method, ...arguments_) {
  const original = contextKey(ui), answer = await ui[method](...arguments_);
  if (contextKey(ui) !== original) throw new Error('Conversation changed. Reopen Skills for this project before acting.');
  return answer;
}
const preview = (ui, id, options = {}) => {
  const selected = { ...currentContext(ui), ...options };
  ui.skillPreview = { ...inspectSkill(id, selected), ...readSkill(id, { ...selected, enabledOnly: false }), historical: Boolean(options.historical) };
  ui.skillPreviewContext = contextKey(ui);
};
const scopeForSkill = (ui, skill) => skill.scope === 'global' ? { scope: 'global' } : { scope: 'project', projectRoot: projectFor(ui).root };
const sourceRows = skill => skill.provenance?.kind === 'learning' ? [
  { text: 'Learned automatically · available to all models when enabled', tone: 'accent' },
  ...(skill.provenance.jobId ? [{ text: `Learning job ${skill.provenance.jobId.slice(0, 12)}`, tone: 'muted' }] : []),
  ...(skill.provenance.sourceSessionId ? [{ text: `Source conversation ${skill.provenance.sourceSessionId.slice(0, 12)}`, tone: 'muted' }] : []),
] : [];
const resetViews = ui => { cancelDefinitionBundle(ui, 'skills'); ui.skillCreatorDraft = null; ui.skillMoveDraft = null; ui.skillPreview = null; ui.skillHistoryState = null; ui.skillPromotionDraft = null; ui.skillSyncDetails = false; ui.knowledgeView = null; };
const preferencesFile = () => path.join(home(), 'cli-preferences.json');
const savedImportDirectory = () => {
  try {
    const value = readJson(preferencesFile(), {})?.codexSkillsDirectory;
    return typeof value === 'string' && path.isAbsolute(value) ? value : '';
  } catch { return ''; }
};
const defaultImportDirectory = () => path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'skills');
const ensureSkillView = ui => {
  if (!['import', 'library'].includes(ui.skillView)) ui.skillView = 'library';
  if (!Object.hasOwn(ui, 'skillImportDirectory')) ui.skillImportDirectory = savedImportDirectory() || defaultImportDirectory();
  if (!Object.hasOwn(ui, 'skillImportDraft')) ui.skillImportDraft = ui.skillImportDirectory;
  if (!Array.isArray(ui.skillImportCandidates)) ui.skillImportCandidates = [];
  if (!(ui.skillImportSelected instanceof Set)) ui.skillImportSelected = new Set();
};
const setSkillView = (ui, view) => {
  ensureSkillView(ui);
  if (!['import', 'library'].includes(view)) return;
  if (ui.tui && ui.skillView === 'import') ui.skillImportDraft = ui.tui.value;
  ui.skillView = view;
  if (ui.tui) {
    if (view === 'import') {
      ui.tui.value = ui.skillImportDraft || ui.skillImportDirectory;
      ui.tui.cursor = [...ui.tui.value].length;
    } else if (ui.tui.skillPanelDraft) Object.assign(ui.tui, ui.tui.skillPanelDraft);
    ui.tui.skillTopRequested = true; ui.tui.bodyCache = null; ui.tui.schedule();
  }
};
export function returnToSkillLibrary(ui) {
  if (returnFromDefinitionBundle(ui, 'skills')) return true;
  const fromDetail = Boolean(ui.skillCreatorDraft || ui.skillMoveDraft || ui.skillPreview || ui.skillHistoryState || ui.skillSyncDetails || ui.skillPromotionDraft);
  if (ui.skillMoveDraft?.filePreview) ui.skillMoveDraft.filePreview = null;
  else if (ui.skillPreview && ui.skillHistoryState) ui.skillPreview = null;
  else resetViews(ui);
  setSkillView(ui, 'library');
  if (ui.tui) {
    ui.tui.skillFocus = 0; ui.tui.skillEnsureFocus = true;
    ui.tui.skillTopRequested = true; ui.tui.bodyCache = null; ui.tui.schedule();
  }
  return fromDetail;
}

// Learning job links use this same scoped library preview, with no model work
// or new session. Import drafts and the original chat composer stay intact.
export function showSkillInLibrary(ui, id, { scope = 'current' } = {}) {
  resetViews(ui); ui.skillScope = scope; ui.skillOffset = 0;
  setSkillView(ui, 'library'); preview(ui, id);
  ui.skillAdminContext = contextKey(ui);
  if (ui.tui) { ui.tui.bodyCache = null; ui.tui.skillFocus = 0; ui.tui.skillTopRequested = true; ui.tui.schedule(); }
  return ui.skillPreview;
}

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

export function refreshCodexImport(ui, { directory = ui.skillImportDraft || ui.skillImportDirectory,
  save = false, discover = codexSkillDirectories } = {}) {
  ensureSkillView(ui);
  const selected = new Set();
  try {
    if (!directory?.trim()) throw new Error('Enter a Codex skills directory.');
    const root = fs.realpathSync(path.resolve(directory.trim()));
    if (!fs.lstatSync(root).isDirectory()) throw new Error('Choose a directory containing Codex skill folders.');
    const found = discover(root), previous = ui.skillImportSelected;
    const candidates = [];
    for (const candidate of found.candidates) {
      try {
        const manifest = codexSkillManifest(candidate.source);
        if (candidates.some(item => item.importName === manifest.metadata.name)) {
          found.issues.push({ name: manifest.rawName, reason: 'Duplicate skill name; choose one source at a time.' });
          continue;
        }
        candidates.push({ source: candidate.source, rawName: manifest.rawName, importName: manifest.metadata.name,
          rename: manifest.rawName === manifest.metadata.name ? '' : manifest.metadata.name,
          description: manifest.metadata.description, manifest });
      } catch {
        found.issues.push({ name: candidate.name, reason: 'Invalid or unsafe skill package.' });
      }
    }
    ui.skillImportDirectory = root;
    ui.skillImportDraft = root;
    if (ui.tui && ui.skillView === 'import') { ui.tui.value = root; ui.tui.cursor = [...root].length; }
    ui.skillImportCandidates = candidates;
    ui.skillImportSelected = new Set(candidates.filter(item => previous?.has(item.source)).map(item => item.source));
    ui.skillImportScope = (() => {
      const projectRoot = projectFor(ui).root, projectDirectory = path.resolve(path.join(projectRoot, '.agents', 'skills'));
      return ui.skillScope === 'project' || (ui.skillScope !== 'global' &&
        (root === projectDirectory || root.startsWith(projectDirectory + path.sep))) ? 'project' : 'global';
    })();
    ui.skillImportIssues = found.issues;
    ui.skillImportMessage = `${candidates.length} skill${candidates.length === 1 ? '' : 's'} found${found.issues.length ? ` · ${found.issues.length} skipped` : ''}.`;
    if (save) {
      const settings = readJson(preferencesFile(), {});
      writeJson(preferencesFile(), { ...settings, codexSkillsDirectory: root });
    }
    if (ui.tui) { ui.tui.bodyCache = null; ui.tui.skillEnsureFocus = true; ui.tui.schedule(); }
    return { root, candidates: ui.skillImportCandidates, issues: found.issues };
  } catch (error) {
    ui.skillImportCandidates = [];
    selected.clear(); ui.skillImportSelected = selected;
    ui.skillImportIssues = [];
    ui.skillImportMessage = error.message || 'Unable to scan this directory.';
    if (ui.tui) { ui.tui.bodyCache = null; ui.tui.schedule(); }
    return null;
  }
}

function importCodexSelection(ui, choices, scopeOptions, importer) {
  const counts = { imported: 0, updated: 0, unchanged: 0, conflicts: 0, rejected: 0,
    scanned: ui.skillImportCandidates.length, unavailable: ui.skillImportIssues?.length || 0, truncated: false };
  const results = [];
  for (const choice of choices) {
    const staged = stageCodexSkill(choice, choice.manifest);
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
      results.push({ name: choice.manifest.metadata.name, status: 'rejected', reason: 'Import failed or the package changed.' });
    } finally { staged.cleanup(); }
  }
  return { ...counts, locations: 1, results, issues: ui.skillImportIssues || [] };
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
  ensureSkillView(ui);
  if (ui.knowledgeView) return knowledgeRows(ui);
  if (ui.skillAdminContext && ui.skillAdminContext !== contextKey(ui)) resetViews(ui);
  const bundle = definitionBundleRows(ui, 'skills');
  if (bundle) return bundle;
  const creator = creatorRows(ui, 'skill');
  if (creator) return creator;
  if (ui.skillMoveDraft) {
    const draft = ui.skillMoveDraft;
    if (draft.context !== contextKey(ui)) {
      ui.skillMoveDraft = null;
      return [{ text: 'The host or conversation changed. Reopen the skill to review its move.', tone: 'warning' }, { text: '← Back to library', action: 'library' }];
    }
    if (draft.filePreview) return [{ text: '← Back to move review', action: 'move-review' },
      { text: draft.filePreview.file + ' · ' + draft.review.sourceVersion.slice(0, 8), tone: 'accent' }, { text: draft.filePreview.text },
      ...(draft.filePreview.nextOffset != null ? [{ text: 'Read next page', action: 'move-read-next' }] : [])];
    return [{ text: '← Back to library', action: 'library' }, { text: `Move ${draft.review.name} to BZZY Core`, tone: 'accent' },
      { text: 'THIS CHAT / PROJECT → BZZY CORE / GLOBAL', tone: 'accent' },
      { text: `Exact package ${draft.review.sourceVersion.slice(0, 12)} · ${draft.review.files.length} files · source revision ${draft.review.sourceRevision}` },
      { text: draft.review.description }, { text: '' },
      ...draft.review.files.map(file => ({ text: `${file.path} · ${file.bytes.toLocaleString()} bytes` })), { text: '' },
      { text: 'The project library entry is archived. Original folders, immutable versions and history stay intact.', tone: 'muted' },
      { text: 'The global skill starts disabled. Review it and explicitly Enable it when ready.', tone: 'muted' },
      { text: 'Inspect package files', action: 'move-files' }, { text: 'Move to BZZY Core', action: 'move-confirm', tone: 'accent' },
      { text: 'Cancel move', action: 'library' }];
  }
  if (ui.skillPromotionDraft) {
    const { definition } = ui.skillPromotionDraft;
    return [{ text: 'Review a separate global workflow', tone: 'accent' }, { text: definition.name }, { text: definition.description }, { text: definition.instructions },
      { text: 'Only this generic text enters the global candidate; project resources stay private.', tone: 'muted' },
      { text: 'Create reviewed global candidate', action: 'promote-confirm' }, { text: 'Cancel promotion', action: 'library' }];
  }
  if (ui.skillHistoryState && !ui.skillPreview) {
    const { skill, entries } = ui.skillHistoryState, seen = new Set();
    const rows = [{ text: `${skill.name} · ${skill.scope} · version history`, tone: 'accent' }, ...sourceRows(skill)];
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
    return [{ text: ui.skillHistoryState ? '← Back to history' : '← Back to library', action: ui.skillHistoryState ? 'history-back' : 'library' },
      { text: `${page.name}/${page.file} · ${page.scope} · ${page.version.slice(0, 8)}${page.historical ? ' · historical' : ''}`, tone: 'accent' }, { text: page.text },
      ...sourceRows(page),
      ...(page.nextOffset != null ? [{ text: 'Read next page', action: 'read-next' }] : []), { text: 'Supporting files', action: 'files' },
      ...(!page.historical ? [{ text: page.enabled ? 'Disable for all models' : 'Enable for all models', action: `toggle:${page.id}` },
        { text: 'Version history and source', action: `history:${page.id}` }, { text: 'Delete skill', action: `delete:${page.id}`, tone: 'warning' }] : []),
      ...(page.scope === 'project' && !page.historical ? [{ text: 'Move to BZZY Core', action: `move-global:${page.id}`, tone: 'accent' },
        { text: 'Create a separate generic global candidate', action: `promote:${page.id}` }] : []),
      ...(ui.skillHistoryState ? [{ text: 'Back to library', action: 'library' }] : [])];
  }
  const tabs = {
    text: '  IMPORT       LIBRARY',
    segments: [
      { text: '  IMPORT', tone: ui.skillView === 'import' ? 'accent' : 'muted', action: 'tab:import' },
      { text: '       ' },
      { text: 'LIBRARY', tone: ui.skillView === 'library' ? 'accent' : 'muted', action: 'tab:library' },
    ],
  };
  if (ui.skillView === 'import') {
    const shown = ui.tui?.value || ui.skillImportDraft || ui.skillImportDirectory;
    const rows = [tabs, { text: '' }, { text: 'CODEX SKILLS DIRECTORY', tone: 'accent' },
      { text: '  ' + (shown || 'Type or paste a directory below'), tone: 'text' },
      { text: '  [ Save directory ]    [ Refresh ]', segments: [
        { text: '  [ Save directory ]', tone: 'accent', action: 'save-directory' },
        { text: '    ' },
        { text: '[ Refresh ]', tone: 'accent', action: 'refresh' },
      ] },
      { text: '' }];
    if (ui.skillImportMessage) rows.push({ text: '  ' + ui.skillImportMessage,
      tone: /found|imported|updated|unchanged/i.test(ui.skillImportMessage) ? 'accent' : 'warning' });
    for (const [index, item] of ui.skillImportCandidates.entries()) {
      const checked = ui.skillImportSelected.has(item.source);
      rows.push({ text: `  [${checked ? 'x' : ' '}] ${item.rawName}`, action: `codex-toggle:${index}`, tone: checked ? 'accent' : 'text' });
    }
    if (!ui.skillImportCandidates.length) rows.push({ text: '  No discovered skills. Save the directory or press Refresh.', tone: 'muted' });
    rows.push({ text: '' }, { text: `  [ Import selected · ${ui.skillImportSelected.size} ]`, action: 'codex-import', tone: 'accent' });
    return rows;
  }
  const page = listSkills({ ...currentContext(ui), offset: ui.skillOffset || 0, limit: 30 });
  const rows = [{ text: 'SKILLS', tone: 'accent' }, ...bundleLibraryRows(), { text: '' },
    { text: 'Click ON/OFF · ↑/↓ or Tab select · Space toggles · Enter opens', tone: 'muted' }];
  const projectSkills = page.skills.filter(skill => skill.scope === 'project');
  const globalSkills = page.skills.filter(skill => skill.scope !== 'project');
  ui.skillLibraryContext = contextKey(ui);
  ui.skillLibraryEntries = new Map(page.skills.map(skill => [skill.id || skill.name, { ...skill }]));
  const appendSkill = skill => {
    const id = skill.id || skill.name;
    rows.push(libraryToggleRow({ name: skill.name, scope: skill.scope, enabled: skill.enabled,
      viewAction: `view:${id}`,
      toggleAction: `toggle-row:${id}|${skill.revision}|${skill.version}|${skill.enabled ? '1' : '0'}` }, ui.tui?.output?.columns || 80));
  };
  rows.push({ text: 'THIS CHAT / PROJECT', tone: 'accent' });
  if (projectSkills.length) for (const skill of projectSkills) appendSkill(skill);
  else rows.push({ text: '  No project skills installed.', tone: 'muted' });
  rows.push({ text: '' }, { text: 'BZZY CORE / GLOBAL', tone: 'accent' });
  if (globalSkills.length) for (const skill of globalSkills) appendSkill(skill);
  else rows.push({ text: '  No Core/global skills installed.', tone: 'muted' });
  if (ui.skillSyncResult) {
    rows.push({ text: '' }, { text: '  ' + skillSyncSummary(ui.skillSyncResult), tone: 'muted' });
  }
  if (ui.skillOffset) rows.push({ text: 'Previous page', action: 'previous' });
  if (page.nextOffset != null) rows.push({ text: 'Next page', action: 'next' });
  return rows;
}

export async function skillsCommand(text, ui, { sync, discover = codexSkillDirectories, importer = importSkill, generateDefinition, bundleApi } = {}) {
  if (!/^\/skills(?:\s|$)/.test(text)) return false;
  ui.openTerminal();
  if (!ui.tui) { ui.event('error', { message: 'Open the interactive terminal to manage skills.' }); return true; }
  ensureSkillView(ui);
  ui.tui.setPanel('skills');
  const action = text.slice(7).trim();
  if (!action.startsWith('knowledge:')) ui.knowledgeView = null;
  if (!action.startsWith('promote:') && action !== 'promote-confirm') ui.skillPromotionDraft = null;
  if (!action.startsWith('move-') && !action.startsWith('move-global:') && action !== 'library') ui.skillMoveDraft = null;
  try {
    if (action === 'workflows') await openWorkflows(ui, { origin: 'skills' });
    else if (action.startsWith('bundle-')) {
      if (['bundle-export', 'bundle-import', 'bundle-export-type', 'bundle-import-type', 'bundle-export-zip-type', 'bundle-import-zip-type'].includes(action)) { resetViews(ui); setSkillView(ui, 'library'); }
      await definitionBundleAction(action, ui, 'skills', { api: bundleApi });
    }
    else if (action.startsWith('knowledge:')) await knowledgeAction(action.slice(10), ui);
    else if (!action) { resetViews(ui); setSkillView(ui, 'library'); }
    else if (action === 'library') returnToSkillLibrary(ui);
    else if (action === 'creator') { resetViews(ui); setSkillView(ui, 'library'); await startCreator(ui, 'skill', { generate: generateDefinition }); }
    else if (action === 'creator-cancel') ui.cancelDefinitionAuthoring?.();
    else if (action === 'creator-save') { saveCreator(ui, 'skill'); resetViews(ui); setSkillView(ui, 'library'); }
    else if (action === 'tab:import') setSkillView(ui, 'import');
    else if (action === 'tab:library') setSkillView(ui, 'library');
    else if (action === 'save-directory') {
      const scanned = refreshCodexImport(ui, { directory: ui.tui.value, save: true, discover });
      if (scanned) ui.skillImportMessage = `Saved · ${scanned.candidates.length} skill${scanned.candidates.length === 1 ? '' : 's'} found.`;
    }
    else if (action === 'refresh') refreshCodexImport(ui, { directory: ui.skillImportDirectory, discover });
    else if (action.startsWith('codex-toggle:')) {
      const index = Number(action.slice(13));
      const candidate = Number.isSafeInteger(index) ? ui.skillImportCandidates[index] : null;
      if (candidate) {
        if (ui.skillImportSelected.has(candidate.source)) ui.skillImportSelected.delete(candidate.source);
        else ui.skillImportSelected.add(candidate.source);
      }
    }
    else if (action === 'codex-import') {
      const candidates = ui.skillImportCandidates.filter(item => ui.skillImportSelected.has(item.source));
      if (!candidates.length) ui.skillImportMessage = 'Select at least one skill to import.';
      else {
        const scopeOptions = ui.skillImportScope === 'project'
          ? { ...currentContext(ui), scope: 'project' } : { scope: 'global' };
        const result = importCodexSelection(ui, candidates, scopeOptions, importer);
        ui.skillImportSelected = new Set();
        ui.skillImportMessage = skillSyncSummary(result);
        ui.skillSyncResult = skillSyncReport(result);
        ui.skillSyncDetails = false;
        ui.event('info', { message: skillSyncSummary(result) });
      }
    }
    else if (action === 'scope') {
      const scope = await prompt(ui, 'chooseOne', 'Skills visible in this library', [
        { value: 'current', label: 'This project + global methods', selected: !ui.skillScope || ui.skillScope === 'current' },
        { value: 'project', label: 'This project only', selected: ui.skillScope === 'project' },
        { value: 'global', label: 'Global reusable methods', selected: ui.skillScope === 'global' }]);
      if (scope) { ui.skillScope = scope; ui.skillOffset = 0; resetViews(ui); }
    } else if (action === 'sync' || action === 'sync codex') {
      setSkillView(ui, 'import');
      if (sync) {
        const result = sync({ cwd: ui.tui.cwd || process.cwd() });
        resetViews(ui); ui.skillSyncResult = skillSyncReport(result); ui.skillQuery = ''; ui.skillOffset = 0;
        ui.skillImportMessage = skillSyncSummary(result);
        ui.event('info', { message: skillSyncSummary(result) });
      } else refreshCodexImport(ui, { discover });
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
    else if (action.startsWith('toggle-row:')) {
      const [id, revision, version, enabled] = action.slice(11).split('|'), shown = ui.skillLibraryEntries?.get(id);
      if (ui.skillLibraryContext !== contextKey(ui) || !shown || shown.revision !== Number(revision) || shown.version !== version ||
          String(shown.enabled ? 1 : 0) !== enabled) throw new Error('The library changed. Refresh the skill before toggling it.');
      const selected = scopeForSkill(ui, shown), current = inspectSkill(id, selected);
      if (current.revision !== shown.revision || current.version !== shown.version || current.enabled !== shown.enabled) throw new Error('Skill changed. Refresh the library before toggling it.');
      const saved = setSkillEnabled(id, !shown.enabled, shown.revision, selected);
      ui.event('info', { message: `${shown.name} is ${saved.enabled ? 'ON · available to models' : 'OFF · unavailable to models'} in ${shown.scope} scope.` });
    }
    else if (action.startsWith('toggle:')) {
      const id = action.slice(7), shown = ui.skillPreview?.id === id ? ui.skillPreview : null;
      if (shown && (shown.historical || ui.skillPreviewContext !== contextKey(ui))) throw new Error('Reopen the current skill before changing its enabled state.');
      const selected = shown ? scopeForSkill(ui, shown) : currentContext(ui), current = inspectSkill(id, selected), skill = shown || current;
      if (current.revision !== skill.revision || current.version !== skill.version) throw new Error('Skill changed. Reopen it before enabling or disabling.');
      if (!skill.enabled && await prompt(ui, 'chooseOne', `Enable ${skill.name} in ${skill.scope} scope? Existing session permissions apply.`, [{ value: 'cancel', label: 'Cancel', selected: true }, { value: 'enable', label: 'Enable for all models' }]) !== 'enable') return true;
      setSkillEnabled(skill.id, !skill.enabled, skill.revision, selected);
      if (shown) preview(ui, skill.id, { ...selected, file: shown.file, offset: shown.offset || 0 });
    } else if (action.startsWith('delete:')) {
      const id = action.slice(7), shown = ui.skillPreview;
      if (!shown || shown.id !== id || shown.historical || ui.skillPreviewContext !== contextKey(ui)) throw new Error('Open the current skill in the library before deleting it.');
      const selected = scopeForSkill(ui, shown), current = inspectSkill(shown.id, selected);
      if (current.revision !== shown.revision || current.version !== shown.version) throw new Error('Skill changed. Reopen it before deleting.');
      const answer = await prompt(ui, 'chooseOne', `Delete ${shown.name} from ${shown.scope} Library? Saved versions, history and source files are retained.`, [
        { value: 'cancel', label: 'Cancel', selected: true }, { value: 'delete', label: 'Delete skill' },
      ]);
      if (answer === 'delete') {
        deleteSkill(shown.id, shown.revision, selected); resetViews(ui); ui.skillOffset = 0; setSkillView(ui, 'library');
        ui.event('info', { message: `Deleted ${shown.name} from the ${shown.scope} library. Saved history and source files were retained.` });
      }
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
    } else if (action.startsWith('move-global:')) {
      const review = previewSkillGlobalMove(action.slice(12), { projectRoot: projectFor(ui).root });
      ui.skillPreview = null; ui.skillHistoryState = null; ui.skillMoveDraft = { review, context: contextKey(ui) };
    } else if (action === 'move-review' && ui.skillMoveDraft) ui.skillMoveDraft.filePreview = null;
    else if (action === 'move-confirm' && ui.skillMoveDraft) {
      const draft = ui.skillMoveDraft;
      if (draft.context !== contextKey(ui)) throw new Error('The host or conversation changed. Reopen the move review.');
      const moved = moveSkillToGlobal(draft.review, { projectRoot: projectFor(ui).root, reviewed: true });
      resetViews(ui); ui.skillScope = 'global'; setSkillView(ui, 'library'); preview(ui, moved.id);
      ui.event('info', { message: `Moved ${moved.name} to BZZY Core. It is disabled until you explicitly Enable it.` });
    } else if (action === 'move-files' && ui.skillMoveDraft) {
      const draft = ui.skillMoveDraft, selected = await prompt(ui, 'chooseOne', 'Inspect the exact package before moving', draft.review.files.map(file => ({ value: file.path, label: file.path })));
      if (selected) draft.filePreview = readSkill(draft.review.sourceId, { projectRoot: projectFor(ui).root, scope: 'project', enabledOnly: false, version: draft.review.sourceVersion, file: selected });
    } else if (action === 'move-read-next' && ui.skillMoveDraft?.filePreview?.nextOffset != null) {
      const draft = ui.skillMoveDraft, page = draft.filePreview;
      draft.filePreview = readSkill(draft.review.sourceId, { projectRoot: projectFor(ui).root, scope: 'project', enabledOnly: false, version: draft.review.sourceVersion, file: page.file, offset: page.nextOffset });
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
  finally {
    ui.skillAdminContext = contextKey(ui); ui.tui.bodyCache = null;
    if (!action.startsWith('toggle-row:')) { ui.tui.scroll = 0; ui.tui.skillFocus = 0; ui.tui.skillTopRequested = true; }
    ui.tui.schedule();
  }
  return true;
}
