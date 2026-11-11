import { listSkills, inspectSkill, readSkill, importSkill, createSkill, setSkillEnabled, skillHistory, rollbackSkill, promoteSkill, scopeSkillToProject,
  previewSkillGlobalMove, moveSkillToGlobal, deleteSkill, previewSkillClear, clearSkills } from '@bzzy/core/engine/skills.js';
import { skillSyncSummary, skillSyncReport, previewCodexSkills, importCodexSkills } from '@bzzy/core/engine/skill-sync.js';
import { loadSession } from '@bzzy/core/engine/store.js';
import { projectIdentityForSession, resolveProjectIdentity } from '@bzzy/core/engine/project-identity.js';
import { knowledgeAction, knowledgeRows } from './knowledge-ui.js';
import { creatorRows, startCreator, saveCreator } from './definition-creator-ui.js';
import { bundleLibraryRows, definitionBundleRows, definitionBundleAction, returnFromDefinitionBundle, cancelDefinitionBundle } from './definition-bundle-ui.js';
import { libraryToggleRow } from './library-toggle-ui.js';
import { libraryEntryMenu } from './library-entry-menu.js';
import { openWorkflows } from './workflow-ui.js';
import { cellWidth, clip } from './terminal-format.js';
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
const counted = (value, noun) => `${value} ${noun}${value === 1 ? '' : 's'}`;
const ensureSkillView = ui => {
  if (!['codex', 'library'].includes(ui.skillView)) ui.skillView = 'library';
  if (!(ui.codexSelected instanceof Set)) ui.codexSelected = new Set();
};
const setSkillView = (ui, view) => {
  ensureSkillView(ui);
  if (!['codex', 'library'].includes(view)) return;
  ui.skillView = view;
  if (ui.tui) { ui.tui.skillTopRequested = true; ui.tui.bodyCache = null; ui.tui.schedule(); }
};
export function returnToSkillLibrary(ui) {
  if (returnFromDefinitionBundle(ui, 'skills')) return true;
  ensureSkillView(ui);
  // Skipped-item details opened from the Codex table return to that table.
  if (ui.skillSyncDetails && ui.skillView === 'codex') {
    ui.skillSyncDetails = false;
    if (ui.tui) { ui.tui.skillFocus = 0; ui.tui.skillTopRequested = true; ui.tui.bodyCache = null; ui.tui.schedule(); }
    return true;
  }
  const fromDetail = Boolean(ui.skillCreatorDraft || ui.skillMoveDraft || ui.skillPreview || ui.skillHistoryState || ui.skillSyncDetails || ui.skillPromotionDraft || ui.skillView === 'codex');
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

// Codex import: Core scans every local Codex skill location and classifies
// each package; this view only presents that read-only scan as a checkbox
// table and sends back the checked sourceId/version pairs. Absolute source
// paths stay inside Core's scan and never enter CLI state, reports or prompts.
const preferencesFile = () => path.join(home(), 'cli-preferences.json');
// One optional owner-chosen folder (for example a copied ~/.codex/skills) is
// scanned together with Codex's standard locations. It is local CLI preference.
const savedCodexFolder = () => {
  try {
    const value = readJson(preferencesFile(), {})?.codexSkillsDirectory;
    return typeof value === 'string' && path.isAbsolute(value) ? value : '';
  } catch { return ''; }
};
const projectCwd = ui => sessionFor(ui)?.cwd || ui.tui?.cwd || process.cwd();
// ui.codexSkillDiscovery is a trusted test seam for discovery roots; no user
// input or remote client can set it.
const codexOptions = ui => {
  const folder = savedCodexFolder();
  return { cwd: projectCwd(ui), ...(folder ? { extraRoots: [folder] } : {}), ...(ui.codexSkillDiscovery || {}) };
};
const codexSelectable = item => ['new', 'update'].includes(item.status);
const codexStatus = item => item.status === 'unchanged' ? 'in BZZY'
  : item.status === 'conflict' ? item.conflictWith === 'location' ? 'name clash' : 'name taken'
    : item.status === 'rejected' ? 'invalid' : item.status;
const codexTone = item => codexSelectable(item) ? 'accent' : ['conflict', 'rejected'].includes(item.status) ? 'warning' : 'muted';

function scanCodex(ui) {
  const context = contextKey(ui), keep = ui.codexScan?.context === context ? ui.codexSelected : new Set();
  try {
    const result = skillSyncReport(previewCodexSkills(codexOptions(ui)));
    const items = result.results.filter(item => item.sourceId);
    ui.codexScan = { context, items, truncated: result.truncated, issues: result.issues };
    ui.codexSelected = new Set(items.filter(item => codexSelectable(item) && keep.has(item.sourceId)).map(item => item.sourceId));
  } catch (error) {
    ui.codexScan = { context, items: [], error: ['ENOENT', 'EACCES', 'EPERM'].includes(error.code) ? 'This terminal folder is unavailable. Reopen BZZY in an existing project.' : error.message };
    ui.codexSelected = new Set();
  }
}

function openCodexImport(ui) {
  resetViews(ui); ui.codexMessage = ''; ui.skillSyncResult = null;
  setSkillView(ui, 'codex'); scanCodex(ui);
}

function codexSummary(result) {
  const parts = [result.imported && `${result.imported} imported`, result.updated && `${result.updated} updated`,
    result.unchanged && `${result.unchanged} already in BZZY`].filter(Boolean);
  const skipped = result.conflicts + result.rejected + result.duplicates;
  if (skipped) parts.push(`${skipped} skipped`);
  return `Codex → BZZY · ${parts.join(' · ') || 'nothing imported'}`;
}

function importCheckedCodex(ui) {
  const scan = ui.codexScan;
  if (!scan || scan.context !== contextKey(ui)) throw new Error('The terminal changed. Rescan Codex skills before importing.');
  const chosen = scan.items.filter(item => codexSelectable(item) && ui.codexSelected.has(item.sourceId));
  if (!chosen.length) { ui.codexMessage = 'Check at least one skill to import.'; return; }
  const result = importCodexSkills(chosen.map(({ sourceId, version }) => ({ sourceId, version })), codexOptions(ui));
  const names = new Map(scan.items.map(item => [item.sourceId, item.name]));
  const report = skillSyncReport(result);
  report.results = report.results.map(item => ({ ...item, name: item.name || names.get(item.sourceId) || 'skill' }));
  ui.skillSyncResult = report; ui.codexMessage = codexSummary(result);
  ui.event('info', { message: `${ui.codexMessage}.${result.imported + result.updated ? ' Imported skills start OFF; turn them ON in the Skills library.' : ''}` });
  ui.codexSelected = new Set(); scanCodex(ui);
}

async function chooseCodexFolder(ui) {
  const saved = savedCodexFolder();
  const entered = await prompt(ui, 'ask', `Another folder with Codex skills · absolute path${saved ? ' · empty forgets it' : ''} · Esc cancels`, { initialValue: saved });
  if (entered == null) return;
  const settings = readJson(preferencesFile(), {}) || {}, value = entered.trim().replace(/^~(?=$|\/)/, os.homedir());
  if (!value) {
    const { codexSkillsDirectory, ...rest } = settings;
    writeJson(preferencesFile(), rest); ui.codexMessage = saved ? 'Stopped scanning the other folder.' : '';
  } else {
    if (!path.isAbsolute(value)) throw new Error('Enter an absolute folder path, such as ~/backup/.codex/skills.');
    const folder = fs.realpathSync(value);
    if (!fs.statSync(folder).isDirectory()) throw new Error('Choose a folder that contains Codex skill folders.');
    writeJson(preferencesFile(), { ...settings, codexSkillsDirectory: folder });
    ui.codexMessage = 'Also scanning the other folder.';
  }
  scanCodex(ui);
}

// Columns: checkbox, SKILL, FROM, STATUS. The name and status take priority;
// FROM narrows first and is omitted when even a short location cannot fit.
function codexTable(ui, items, width) {
  const statusWidth = Math.max(6, ...items.map(item => cellWidth(codexStatus(item))));
  const fromWidth = Math.max(4, ...items.map(item => cellWidth(item.label || '')));
  const longest = Math.max(5, ...items.map(item => cellWidth(item.name))), room = Math.max(5, width - 8 - statusWidth);
  const showFrom = room >= Math.min(longest, 24) + 2 + Math.min(fromWidth, 8);
  const fromShown = showFrom ? Math.min(fromWidth, room - 2 - Math.min(longest, 24)) : 0;
  const nameWidth = Math.max(5, Math.min(longest, showFrom ? room - 2 - fromShown : room));
  const pad = (text, size) => { const shown = clip(text, size); return shown + ' '.repeat(Math.max(0, size - cellWidth(shown))); };
  const header = `      ${pad('SKILL', nameWidth)}  ${showFrom ? pad('FROM', fromShown) + '  ' : ''}STATUS`;
  const rows = [{ text: header, segments: [{ text: header, tone: 'muted' }] }];
  for (const item of items) {
    const selectable = codexSelectable(item), checked = selectable && ui.codexSelected.has(item.sourceId);
    const label = `${selectable ? `[${checked ? 'x' : ' '}]` : '[-]'} ${pad(item.name, nameWidth)}`;
    const middle = `  ${showFrom ? pad(item.label || '', fromShown) + '  ' : ''}`, status = codexStatus(item);
    rows.push({ text: `  ${label}${middle}${status}`, segments: [{ text: '  ' },
      { text: label, tone: checked ? 'accent' : selectable ? 'text' : 'muted', ...(selectable ? { action: `codex-toggle:${item.sourceId}` } : {}) },
      { text: middle, tone: 'muted' }, { text: status, tone: codexTone(item) }] });
  }
  return rows;
}

function codexRows(ui) {
  const scan = ui.codexScan, rows = [{ text: '← Back to library', action: 'library' }, { text: 'IMPORT SKILLS FROM CODEX', tone: 'accent' }];
  if (!scan || scan.context !== contextKey(ui)) {
    return [...rows, { text: 'The terminal changed since this scan.', tone: 'warning' }, { text: 'Rescan', action: 'codex-rescan', buttonGroup: 'codex', buttonIcon: '↻' }];
  }
  if (scan.error) return [...rows, { text: scan.error, tone: 'warning' }, { text: 'Rescan', action: 'codex-rescan', buttonGroup: 'codex', buttonIcon: '↻' }];
  const items = scan.items, ready = items.filter(codexSelectable).length, installed = items.filter(item => item.status === 'unchanged').length;
  const blocked = items.length - ready - installed, checked = items.filter(item => codexSelectable(item) && ui.codexSelected.has(item.sourceId)).length;
  // Text rows stay short: the workspace center column can be about 60 cells.
  rows.push({ text: `${counted(items.length, 'Codex skill')} · ${ready} ready${installed ? ` · ${installed} in BZZY` : ''}${blocked ? ` · ${blocked} can't import` : ''}${scan.truncated ? ' · scan limit reached' : ''}`, tone: 'muted' },
    { text: `Import checked · ${checked}`, action: 'codex-import', buttonGroup: 'codex', buttonIcon: '↓' },
    { text: 'Select all', action: 'codex-all', buttonGroup: 'codex' }, { text: 'Select none', action: 'codex-none', buttonGroup: 'codex' },
    { text: 'Rescan', action: 'codex-rescan', buttonGroup: 'codex', buttonIcon: '↻' }, { text: 'Other folder', action: 'codex-folder', buttonGroup: 'codex', buttonIcon: '+' });
  if (ui.codexMessage) rows.push({ text: ui.codexMessage, tone: /^Codex → BZZY|scanning|Stopped/.test(ui.codexMessage) ? 'accent' : 'warning' });
  const skipped = ui.skillSyncResult?.results.filter(item => ['conflict', 'rejected', 'duplicate'].includes(item.status)).length;
  if (skipped) rows.push({ text: `Show why ${counted(skipped, 'skill')} ${skipped === 1 ? 'was' : 'were'} skipped`, action: 'sync-details' });
  // Folders discovery could not use (BZZY never follows linked skill folders).
  const reasons = new Map();
  for (const issue of scan.issues || []) {
    const reason = /Linked/.test(issue.reason) ? 'linked folders are not followed' : /nesting/.test(issue.reason) ? 'nested deeper than 4 levels' : 'location unreadable';
    reasons.set(reason, (reasons.get(reason) || 0) + 1);
  }
  for (const [reason, count] of reasons) rows.push({ text: `${counted(count, 'folder')} skipped (${reason})`, tone: 'warning' });
  if (!items.length) {
    rows.push({ text: '' }, { text: 'No Codex skills found. BZZY looked in:', tone: 'muted' },
      { text: '~/.codex/skills (with Codex system skills)', tone: 'muted' }, { text: '$CODEX_HOME/skills · ~/.agents/skills', tone: 'muted' },
      { text: '/etc/codex/skills · this project\'s .agents/skills', tone: 'muted' });
    return rows;
  }
  rows.push({ text: 'Space checks · ↑/↓ move · Esc back', tone: 'muted' }, { text: '' });
  rows.push(...codexTable(ui, items, Math.max(40, ui.tui?.libraryWidth || ui.tui?.output?.columns || 80)), { text: '' });
  rows.push({ text: 'Imports start OFF; Codex folders stay untouched.', tone: 'muted' });
  if (items.some(item => item.target === 'project')) rows.push({ text: 'Skills from this project stay project-only.', tone: 'muted' });
  if (items.some(item => item.rawName)) rows.push({ text: 'Names use hyphens in BZZY: my_skill → my-skill', tone: 'muted' });
  if (items.some(item => item.status === 'conflict' && item.conflictWith === 'library')) rows.push({ text: 'name taken: delete BZZY\'s copy to import it.', tone: 'muted' });
  if (items.some(item => item.status === 'conflict' && item.conflictWith === 'location')) rows.push({ text: 'name clash: an earlier folder has this name.', tone: 'muted' });
  return rows;
}

// Clear covers what this library manages: the current project's skills and/or
// global skills, following the scope filter. Core pins the exact reviewed list.
function clearContext(ui) {
  if (ui.skillScope === 'global') return { include: 'global' };
  const session = sessionFor(ui), project = session ? { session } : { projectRoot: projectFor(ui).root };
  return { ...project, include: ui.skillScope === 'project' ? 'project' : 'all' };
}

async function clearLibrary(ui) {
  resetViews(ui); setSkillView(ui, 'library');
  const options = clearContext(ui), review = previewSkillClear(options);
  if (!review.total) { ui.event('info', { message: 'There are no skills to clear.' }); return; }
  const where = [review.project && `${review.project} in this project`, review.global && `${review.global} in BZZY Core (global)`].filter(Boolean).join(' · ');
  const label = review.total === 1 ? 'Delete 1 skill' : `Delete all ${review.total} skills`;
  const answer = await prompt(ui, 'chooseOne', `${label}?`, {
    description: `${where}. Models lose access immediately; audit history is kept.`, descriptionRows: 5,
    choices: [{ value: 'cancel', label: 'Cancel', selected: true }, { value: 'clear', label }],
  }, { scope: 'skill-clear', presentation: 'dropdown', detailLimit: 5 });
  if (answer !== 'clear') return;
  const result = clearSkills(review, { ...options, reviewed: true });
  ui.skillOffset = 0; ui.skillSyncResult = null;
  ui.event('info', { message: `Deleted ${counted(result.deleted, 'skill')} from the library. History was kept for audit.` });
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
    const result = ui.skillSyncResult, items = [...result.results.filter(item => ['conflict', 'rejected', 'duplicate'].includes(item.status)), ...result.issues];
    const offset = ui.skillSyncOffset || 0, fromCodex = ui.skillView === 'codex';
    return [{ text: fromCodex ? '← Back to Codex import' : '← Back to library', action: fromCodex ? 'codex-back' : 'library' }, { text: 'Codex import details', tone: 'accent' },
      ...items.slice(offset, offset + 20).flatMap(item => [{ text: `${item.name || item.scope} · ${item.status || 'skipped'}` }, { text: item.reason || '', tone: 'muted' }]),
      ...(offset ? [{ text: 'Previous details', action: 'sync-previous' }] : []),
      ...(offset + 20 < items.length ? [{ text: 'More details', action: 'sync-next' }] : [])];
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
  if (ui.skillView === 'codex') return codexRows(ui);
  const page = listSkills({ ...currentContext(ui), offset: ui.skillOffset || 0, limit: 30 });
  const rows = [{ text: 'SKILLS', tone: 'accent' }, ...bundleLibraryRows(),
    { text: 'Codex import', action: 'codex', buttonGroup: 'transfer', buttonIcon: '↓' },
    { text: 'Clear', action: 'clear', buttonGroup: 'transfer', buttonIcon: '−', disabled: !page.total }, { text: '' },
    { text: 'Click ON/OFF · ↑/↓ or Tab select · Space toggles · Enter opens', tone: 'muted' }];
  const projectSkills = page.skills.filter(skill => skill.scope === 'project');
  const globalSkills = page.skills.filter(skill => skill.scope !== 'project');
  ui.skillLibraryContext = contextKey(ui);
  ui.skillLibraryEntries = new Map(page.skills.map(skill => [skill.id || skill.name, { ...skill }]));
  const appendSkill = skill => {
    const id = skill.id || skill.name;
    rows.push(libraryToggleRow({ name: skill.name, scope: skill.scope, enabled: skill.enabled,
      menu: libraryEntryMenu(ui, 'skill', skill, '/skills view:' + id), viewAction: `view:${id}`,
      toggleAction: `toggle-row:${id}|${skill.revision}|${skill.version}|${skill.enabled ? '1' : '0'}` }, ui.tui?.output?.columns || 80));
  };
  rows.push({ text: 'THIS CHAT / PROJECT', tone: 'accent' });
  if (projectSkills.length) for (const skill of projectSkills) appendSkill(skill);
  else rows.push({ text: '  No project skills installed.', tone: 'muted' });
  rows.push({ text: '' }, { text: 'BZZY CORE / GLOBAL', tone: 'accent' });
  if (globalSkills.length) for (const skill of globalSkills) appendSkill(skill);
  else rows.push({ text: '  No Core/global skills installed.', tone: 'muted' });
  if (ui.skillSyncResult) {
    rows.push({ text: '' }, { text: '  ' + (ui.codexMessage || skillSyncSummary(ui.skillSyncResult)), tone: 'muted' });
  }
  if (ui.skillOffset) rows.push({ text: 'Previous page', action: 'previous' });
  if (page.nextOffset != null) rows.push({ text: 'Next page', action: 'next' });
  return rows;
}

export async function skillsCommand(text, ui, { generateDefinition, bundleApi } = {}) {
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
    // `sync` and `tab:import` are earlier names for the same Codex import view.
    else if (['codex', 'sync', 'sync codex', 'tab:import'].includes(action)) openCodexImport(ui);
    else if (action === 'tab:library') { resetViews(ui); setSkillView(ui, 'library'); }
    else if (action === 'codex-back') { ui.skillSyncDetails = false; setSkillView(ui, 'codex'); }
    else if (action === 'codex-rescan') { ui.codexMessage = ''; setSkillView(ui, 'codex'); scanCodex(ui); }
    else if (action.startsWith('codex-toggle:')) {
      const id = action.slice(13), scan = ui.codexScan?.context === contextKey(ui) ? ui.codexScan : null;
      const item = scan?.items.find(entry => entry.sourceId === id);
      if (item && codexSelectable(item)) { if (ui.codexSelected.has(id)) ui.codexSelected.delete(id); else ui.codexSelected.add(id); }
    }
    else if (action === 'codex-all') {
      if (ui.codexScan?.context === contextKey(ui)) ui.codexSelected = new Set(ui.codexScan.items.filter(codexSelectable).map(item => item.sourceId));
    }
    else if (action === 'codex-none') ui.codexSelected = new Set();
    else if (action === 'codex-import') importCheckedCodex(ui);
    else if (action === 'codex-folder') await chooseCodexFolder(ui);
    else if (action === 'clear') await clearLibrary(ui);
    else if (action === 'scope') {
      const scope = await prompt(ui, 'chooseOne', 'Skills visible in this library', [
        { value: 'current', label: 'This project + global methods', selected: !ui.skillScope || ui.skillScope === 'current' },
        { value: 'project', label: 'This project only', selected: ui.skillScope === 'project' },
        { value: 'global', label: 'Global reusable methods', selected: ui.skillScope === 'global' }]);
      if (scope) { ui.skillScope = scope; ui.skillOffset = 0; resetViews(ui); }
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
    // Toggling a row or checkbox keeps the cursor and scroll where the owner is.
    const keepPosition = action.startsWith('toggle-row:') || action.startsWith('codex-toggle:') || ['codex-all', 'codex-none'].includes(action);
    if (!keepPosition) { ui.tui.scroll = 0; ui.tui.skillFocus = 0; ui.tui.skillTopRequested = true; }
    ui.tui.schedule();
  }
  return true;
}
