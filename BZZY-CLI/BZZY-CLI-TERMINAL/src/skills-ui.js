import { listSkills, inspectSkill, readSkill, importSkill, createSkill, setSkillEnabled } from '@bzzy/core/engine/skills.js';

export function skillRows(ui) {
  if (ui.skillPreview) {
    const page = ui.skillPreview;
    return [{ text: `${page.name}/${page.file} · ${page.version.slice(0, 8)}`, tone: 'accent' }, { text: page.text },
      ...(page.nextOffset != null ? [{ text: 'Read next page', action: 'read-next' }] : []), { text: 'Supporting files', action: 'files' }, { text: 'Back to library', action: 'library' }];
  }
  const query = ui.skillQuery || '', offset = ui.skillOffset || 0;
  const page = listSkills({ query, offset, limit: 30 });
  const rows = [ { text: 'One Core library · all providers and models', tone: 'muted' },
    { text: 'Import folder or ZIP', action: 'import' }, { text: 'Create skill', action: 'create' }, { text: `Search${query ? ': ' + query : '…'}`, action: 'search' }, { text: '' } ];
  for (const skill of page.skills) {
    rows.push({ text: `${skill.enabled ? '●' : '○'} ${skill.name} · ${skill.enabled ? 'enabled' : 'disabled'}`, action: `view:${skill.name}` });
    rows.push({ text: '  ' + skill.description, tone: 'muted' });
    rows.push({ text: `  ${skill.enabled ? 'Disable' : 'Enable'} · ${skill.version.slice(0, 8)}`, action: `toggle:${skill.name}` });
  }
  if (!page.total) rows.push({ text: 'No skills yet. Import a skill folder/ZIP, or create one.', tone: 'muted' });
  if (offset) rows.push({ text: 'Previous page', action: 'previous' });
  if (page.nextOffset != null) rows.push({ text: 'Next page', action: 'next' });
  return rows;
}

export async function skillsCommand(text, ui) {
  if (!/^\/skills(?:\s|$)/.test(text)) return false;
  ui.openTerminal(); ui.tui.setPanel('skills');
  const action = text.slice(7).trim();
  try {
    if (action === 'import') {
      const source = (await ui.ask('Skill folder or ZIP · absolute path · Esc cancels'))?.trim();
      if (source) { const skill = importSkill(source); ui.event('info', { message: `Imported ${skill.name}. Review it before enabling.` }); }
    } else if (action === 'create') {
      const name = (await ui.ask('Skill name · lowercase words separated by hyphens'))?.trim();
      if (!name) return true;
      const description = (await ui.ask('When should this skill be used?'))?.trim();
      if (!description) return true;
      const instructions = (await ui.ask('Workflow instructions · Shift+Enter adds lines'))?.trim();
      if (!instructions) return true;
      const skill = createSkill({ name, description, instructions });
      ui.event('info', { message: `Created ${skill.name}. Review it before enabling.` });
    } else if (action === 'search') { const query = await ui.ask('Search skills · empty shows all'); if (query != null) { ui.skillQuery = query.trim(); ui.skillOffset = 0; } }
    else if (action === 'next' || action === 'previous') ui.skillOffset = Math.max(0, (ui.skillOffset || 0) + (action === 'next' ? 30 : -30));
    else if (action.startsWith('toggle:')) {
      const skill = inspectSkill(action.slice(7));
      if (!skill.enabled && await ui.chooseOne(`Enable ${skill.name}? Its instructions use existing session permissions.`, [{ value: 'cancel', label: 'Cancel', selected: true }, { value: 'enable', label: 'Enable for all models' }]) !== 'enable') return true;
      setSkillEnabled(skill.name, !skill.enabled, skill.revision);
    } else if (action.startsWith('view:')) {
      ui.skillPreview = readSkill(action.slice(5), { enabledOnly: false });
    } else if (action === 'library') ui.skillPreview = null;
    else if (action === 'read-next' && ui.skillPreview?.nextOffset != null) {
      const page = ui.skillPreview;
      ui.skillPreview = readSkill(page.name, { file: page.file, offset: page.nextOffset, version: page.version, enabledOnly: false });
    } else if (action === 'files' && ui.skillPreview) {
      const page = ui.skillPreview;
      const file = await ui.chooseOne('Skill files', page.files.map(file => ({ value: file.path, label: `${file.path} · ${file.bytes} bytes` })));
      if (file) ui.skillPreview = readSkill(page.name, { file, version: page.version, enabledOnly: false });
    }
  } catch (error) { ui.event('error', { message: error.message }); }
  finally { ui.tui.bodyCache = null; ui.tui.scroll = 0; ui.tui.skillFocus = 0; ui.tui.skillTopRequested = true; ui.tui.schedule(); }
  return true;
}
