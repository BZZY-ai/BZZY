import { listSkills, inspectSkill, readSkill, importSkill, createSkill, setSkillEnabled, skillHistory, rollbackSkill, promoteSkill, scopeSkillToProject } from '@bzzy/core/engine/skills.js';
import { syncCodexSkills, skillSyncSummary, skillSyncReport } from '@bzzy/core/engine/skill-sync.js';
import { loadSession } from '@bzzy/core/engine/store.js';
import { projectIdentityForSession, resolveProjectIdentity } from '@bzzy/core/engine/project-identity.js';
import { knowledgeAction, knowledgeRows } from './knowledge-ui.js';

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
  const rows = [ { text: 'All providers and models · project knowledge stays scoped', tone: 'muted' },
    { text: 'Scope: ' + (ui.skillScope === 'global' ? 'Global methods' : ui.skillScope === 'project' ? 'This project only' : 'This project + global methods'), action: 'scope' },
    { text: 'Project memory and history', action: 'knowledge:memory' }, { text: 'Learning reviews and candidates', action: 'knowledge:home' },
    { text: 'Sync Codex skills', action: 'sync' }, { text: `Import folder or ZIP · ${target}`, action: 'import' }, { text: `Create ${target} skill`, action: 'create' }, { text: `Search${query ? ': ' + query : '…'}`, action: 'search' }, { text: '' } ];
  if (ui.skillSyncResult) {
    rows.push({ text: skillSyncSummary(ui.skillSyncResult), tone: 'muted' });
    if (ui.skillSyncResult.conflicts || ui.skillSyncResult.rejected || ui.skillSyncResult.unavailable) rows.push({ text: 'Sync details', action: 'sync-details' });
  }
  for (const skill of page.skills) {
    const id = skill.id || skill.name;
    rows.push({ text: `${skill.enabled ? '●' : '○'} ${skill.name} · ${skill.scope} · ${skill.enabled ? 'enabled' : 'disabled'}`, action: `view:${id}` });
    rows.push({ text: '  ' + skill.description, tone: 'muted' });
    rows.push({ text: `  ${skill.enabled ? 'Disable' : 'Enable'} · ${skill.version.slice(0, 8)}`, action: `toggle:${id}` }, { text: '  Version history and rollback', action: `history:${id}` });
    if (skill.scope === 'project') rows.push({ text: '  Propose a separate global method', action: `promote:${id}` });
    if (skill.needsScopeReview) rows.push({ text: '  Keep this legacy copy in this project', action: `scope-project:${id}` });
  }
  if (!page.total) rows.push({ text: 'No skills yet. Sync Codex skills, import a folder/ZIP, or create one.', tone: 'muted' });
  if (offset) rows.push({ text: 'Previous page', action: 'previous' });
  if (page.nextOffset != null) rows.push({ text: 'Next page', action: 'next' });
  return rows;
}

export async function skillsCommand(text, ui, { sync = syncCodexSkills } = {}) {
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
      const result = sync({ cwd: ui.tui.cwd || process.cwd() });
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
