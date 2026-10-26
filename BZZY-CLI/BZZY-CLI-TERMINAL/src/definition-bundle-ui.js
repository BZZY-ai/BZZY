import fs from 'node:fs';
import path from 'node:path';
import { home } from './files.js';
import { loadSession } from '@bzzy/core/engine/store.js';
import { resolveProjectIdentity } from '@bzzy/core/engine/project-identity.js';
import { libraryCommand, transferLibraryTab } from './library-ui.js';

const changedMessage = 'The host or terminal project changed. Reopen the ZIP review before acting.';
const hostKey = () => { const value = path.resolve(home()); return fs.existsSync(value) ? fs.realpathSync(value) : value; };
const refresh = ui => { if (ui.tui) { ui.tui.bodyCache = null; ui.tui.scroll = 0; ui.tui.skillTopRequested = true; ui.tui.agentTopRequested = true; ui.tui.schedule(); } };
function contextFor(ui) {
  const sessionId = ui.activeTab || ui.sessionId || null, session = sessionId && loadSession(sessionId);
  if (sessionId && !session) throw new Error(changedMessage);
  const cwd = fs.realpathSync(session?.cwd || ui.tui?.cwd || process.cwd());
  return { home: hostKey(), sessionId, parentSessionId: ui.sessionId || null, cwd,
    projectId: resolveProjectIdentity(cwd).id, terminalCwd: ui.tui?.cwd || null };
}
function checkContext(ui, context) {
  if (hostKey() !== context.home || JSON.stringify(contextFor(ui)) !== JSON.stringify(context)) throw new Error(changedMessage);
}
const scopeLabel = scope => scope === 'global' ? 'BZZY Core / global' : 'This project';
const kindLabel = kind => kind === 'agent' ? 'Agent' : 'Skill';
const counted = (value, noun) => `${value.toLocaleString()} ${noun}${value === 1 ? '' : 's'}`;
const fileItems = review => review.entries.flatMap(entry => entry.files.map(file => ({ entry, file })));
const discard = draft => { try { if (draft?.review) draft.backend?.discardDefinitionBundleReview?.(draft.review); } catch {} };
export function cancelDefinitionBundle(ui, panel) {
  if (!ui.definitionBundleDraft || panel && ui.definitionBundleDraft.panel !== panel) return false;
  discard(ui.definitionBundleDraft); ui.definitionBundleDraft = null; return true;
}

export function bundleLibraryRows() {
  return [{ text: 'Import', action: 'bundle-import-type', buttonGroup: 'transfer', buttonIcon: '↓' },
    { text: 'Export', action: 'bundle-export-type', buttonGroup: 'transfer', buttonIcon: '↑' }];
}
const bundleLabel = draft => draft.kinds ? draft.panel === 'skills' ? 'skills' : 'agents' : 'skills & agents';
function checkTypes(review, kinds) {
  if (kinds && (!Array.isArray(review?.kinds) || JSON.stringify(review.kinds) !== JSON.stringify(kinds) ||
      !review.entries?.length || review.entries.some(entry => !kinds.includes(entry.kind)))) {
    throw new Error('Update BZZY Core and CLI together to import or export one Library type.');
  }
}

export function returnFromDefinitionBundle(ui, panel) {
  const draft = ui.definitionBundleDraft;
  if (!draft || draft.panel !== panel) return false;
  if (draft.filePreview) draft.filePreview = null;
  else if (draft.section === 'files') draft.section = 'review';
  else cancelDefinitionBundle(ui, panel);
  if (ui.tui) { ui.tui.skillFocus = 0; ui.tui.agentFocus = 0; }
  refresh(ui); return true;
}

export function definitionBundleRows(ui, panel) {
  const draft = ui.definitionBundleDraft;
  if (!draft || draft.panel !== panel) return null;
  try { checkContext(ui, draft.context); }
  catch {
    cancelDefinitionBundle(ui, panel);
    return [{ text: changedMessage, tone: 'warning' }, { text: '← Back to library', action: 'library' }];
  }
  if (draft.loading) return [{ text: `Import / export ${bundleLabel(draft)}`, tone: 'accent' },
    { text: draft.operation === 'export' ? 'Checking portable packages for export…' : 'Checking the ZIP and destination conflicts…', tone: 'muted' },
    { text: '← Back to library', action: 'bundle-cancel' }];
  const review = draft.review;
  if (draft.filePreview) return [{ text: '← Back to manifest files', action: 'bundle-files-back' },
    { text: draft.filePreview.file, tone: 'accent' }, { text: `SHA256 ${draft.filePreview.sha256}`, tone: 'muted' },
    { text: draft.filePreview.text == null ? 'Binary resource · bytes are preserved in the ZIP; no terminal text preview.' : draft.filePreview.text },
    ...(draft.filePreview.nextOffset != null ? [{ text: 'Read next page', action: 'bundle-read-next' }] : [])];
  if (draft.section === 'files') {
    const files = fileItems(review), start = draft.offset || 0;
    return [{ text: '← Back to ZIP review', action: 'bundle-review' }, { text: 'EXACT PORTABLE MANIFEST', tone: 'accent' },
      { text: `${files.length} package files · ${review.id.slice(0, 12)}`, tone: 'muted' },
      ...files.slice(start, start + 24).flatMap(({ entry, file }) => [
        { text: `${kindLabel(entry.kind)} · ${entry.name} · ${scopeLabel(entry.scope)}`, tone: 'accent' },
        { text: `${file.path} · ${file.bytes.toLocaleString()} bytes`, action: `bundle-read:${files.findIndex(item => item.entry === entry && item.file === file)}` }, { text: `SHA256 ${file.sha256}`, tone: 'muted' }]),
      ...(start ? [{ text: 'Previous files', action: 'bundle-files-previous' }] : []),
      ...(start + 24 < files.length ? [{ text: 'More files', action: 'bundle-files-next' }] : [])];
  }
  const importing = draft.operation === 'import', conflicts = review.conflicts || [];
  const rows = [{ text: '← Back to library', action: 'bundle-cancel' },
    { text: `${importing ? 'Import' : 'Export'} ${bundleLabel(draft)} · review`, tone: 'accent' },
    { text: draft.path || review.outputPath },
    { text: `${counted(review.totals.skills, 'skill')} · ${counted(review.totals.agents, 'agent')} · ${counted(review.totals.files, 'file')} · ${counted(review.totals.bytes, 'byte')}` },
    { text: 'Portable registered definitions only. Account bindings, sessions and persistent iPhone Agents are excluded.', tone: 'muted' },
    ...(importing ? [{ text: 'Project definitions go into this terminal’s project. Global definitions remain Core/global.', tone: 'muted' },
      { text: draft.kinds ? draft.panel === 'skills' ? 'Skills import disabled for review; no execution starts.' : 'Agents are added without starting an agent or model.'
        : 'Skills import disabled; agent definitions are added, with no agent/model started.', tone: 'muted' }]
      : [{ text: 'The ZIP is written in this terminal’s current directory. Existing files are never overwritten.', tone: 'muted' }]),
    { text: '' }];
  for (const entry of review.entries) {
    rows.push({ text: `${kindLabel(entry.kind)} · ${entry.name} · ${scopeLabel(entry.scope)}`, tone: 'accent' },
      { text: `${counted(entry.files.length, 'file')} · version ${String(entry.version).slice(0, 12)}`, tone: 'muted' });
    if (entry.description) rows.push({ text: entry.description });
    if (entry.kind === 'agent') {
      const selection = entry.selection || {};
      rows.push({ text: selection.provider || selection.model || selection.effort
        ? `Model: ${selection.provider || 'current provider'} · ${selection.model || 'provider default'} · ${selection.effort || 'default'} effort`
        : 'Model: inherits the invoking chat’s provider, model and effort', tone: 'muted' });
    }
  }
  if (conflicts.length) {
    rows.push({ text: '' }, { text: `${conflicts.length} destination conflicts · no overwrite`, tone: 'warning' });
    for (const conflict of conflicts) rows.push({ text: `${kindLabel(conflict.kind)} · ${conflict.name} · ${scopeLabel(conflict.scope)}`, tone: 'warning' });
  }
  rows.push({ text: '' }, { text: 'Inspect exact manifest files', action: 'bundle-files' });
  if (importing) {
    if (!conflicts.length) rows.push({ text: 'Import reviewed definitions', action: 'bundle-confirm', tone: 'accent' });
    else if (conflicts.length < review.entries.length) rows.push({ text: 'Import non-conflicting definitions only', action: 'bundle-confirm-skip', tone: 'accent' });
    else rows.push({ text: 'All definitions conflict. Nothing can be imported from this review.', tone: 'warning' });
  } else rows.push({ text: 'Write reviewed ZIP here', action: 'bundle-confirm', tone: 'accent' },
    { text: 'Choose another ZIP filename', action: 'bundle-output' });
  rows.push({ text: 'Cancel ZIP review', action: 'bundle-cancel' });
  return rows;
}

export async function definitionBundleAction(action, ui, panel, { api, loadApi = () => import('@bzzy/core/engine/definition-bundle.js'), transfer = transferLibraryTab } = {}) {
  if (!action.startsWith('bundle-')) return false;
  if (['bundle-export-type', 'bundle-import-type'].includes(action)) {
    const context = contextFor(ui); cancelDefinitionBundle(ui, panel);
    await transfer(action === 'bundle-export-type' ? 'export' : 'import', panel === 'skills' ? 'skill' : 'agent', context.cwd, ui, { loadBundle: async () => api || loadApi() });
    checkContext(ui, context); refresh(ui); return true;
  }
  if (['bundle-relay', 'bundle-share-relay', 'bundle-import-relay'].includes(action)) {
    const context = contextFor(ui); cancelDefinitionBundle(ui, panel);
    await libraryCommand(action === 'bundle-relay' ? '' : action === 'bundle-share-relay' ? 'share' : 'import', context.cwd, ui);
    checkContext(ui, context); refresh(ui); return true;
  }
  const prompt = async (context, title, options) => {
    checkContext(ui, context); const result = await ui.ask(title, options); checkContext(ui, context); return result;
  };
  if (action === 'bundle-cancel') { cancelDefinitionBundle(ui, panel); refresh(ui); return true; }
  if (action === 'bundle-review') { if (ui.definitionBundleDraft?.panel === panel) ui.definitionBundleDraft.section = 'review'; refresh(ui); return true; }
  if (action === 'bundle-files' || action === 'bundle-files-next' || action === 'bundle-files-previous') {
    const draft = ui.definitionBundleDraft;
    if (!draft || draft.panel !== panel || draft.loading) throw new Error('Reopen the ZIP review.');
    checkContext(ui, draft.context); draft.section = 'files';
    draft.offset = action === 'bundle-files' ? 0 : Math.max(0, Math.min(Math.max(0, fileItems(draft.review).length - 1), (draft.offset || 0) + (action === 'bundle-files-next' ? 24 : -24)));
    refresh(ui); return true;
  }
  if (action === 'bundle-files-back') { if (ui.definitionBundleDraft?.panel === panel) ui.definitionBundleDraft.filePreview = null; refresh(ui); return true; }
  const starting = ['bundle-export', 'bundle-import', 'bundle-export-zip-type', 'bundle-import-zip-type'].includes(action), requestedContext = contextFor(ui);
  const requestedDraft = starting ? { context: requestedContext, panel, operation: action.startsWith('bundle-export') ? 'export' : 'import', loading: true,
    ...(action.endsWith('-type') ? { kinds: [panel === 'skills' ? 'skill' : 'agent'] } : {}) } : ui.definitionBundleDraft;
  if (!requestedDraft || requestedDraft.panel !== panel) throw new Error('Open and review the ZIP first.');
  if (starting) { discard(ui.definitionBundleDraft); ui.definitionBundleDraft = requestedDraft; refresh(ui); }
  let backend;
  try { backend = api || await loadApi(); checkContext(ui, requestedContext); }
  catch (error) { if (starting && ui.definitionBundleDraft === requestedDraft) ui.definitionBundleDraft = null; refresh(ui); throw error; }
  if (ui.tui?.panel !== panel || ui.definitionBundleDraft !== requestedDraft) return true;
  requestedDraft.backend = backend;
  if (starting) {
    const context = requestedContext, draft = requestedDraft, operation = draft.operation;
    let file;
    if (operation === 'import') {
      const recent = ui.definitionBundleLastPath;
      const initialValue = recent?.context === JSON.stringify(context) && JSON.stringify(recent.kinds) === JSON.stringify(draft.kinds)
        ? recent.path : path.join(context.cwd, `bzzy-${draft.kinds ? panel : 'skills-agents'}.zip`);
      try { file = (await prompt(context, `Import ${bundleLabel(draft)} · ZIP file path · Esc cancels`, { initialValue }))?.trim(); }
      catch (error) { if (ui.definitionBundleDraft === draft) cancelDefinitionBundle(ui, panel); refresh(ui); throw error; }
      if (ui.definitionBundleDraft !== draft || ui.tui.panel !== panel) return true;
      if (!file) { ui.definitionBundleDraft = null; refresh(ui); return true; }
      file = path.resolve(context.cwd, file);
    }
    draft.path = file; refresh(ui);
    let review;
    try {
      const options = { cwd: context.cwd, ...(draft.kinds ? { kinds: draft.kinds } : {}) };
      review = operation === 'export' ? await backend.previewDefinitionExport(options)
        : await backend.previewDefinitionImport(file, options);
      checkContext(ui, context);
      checkTypes(review, draft.kinds);
      if (ui.definitionBundleDraft !== draft) { discard({ review, backend }); return true; }
      draft.review = review; draft.loading = false; draft.section = 'review'; refresh(ui);
    } catch (error) { discard({ review, backend }); if (ui.definitionBundleDraft === draft) ui.definitionBundleDraft = null; refresh(ui); throw error; }
    return true;
  }
  const draft = ui.definitionBundleDraft;
  if (!draft || draft.panel !== panel || draft.loading) throw new Error('Open and review the ZIP first.');
  checkContext(ui, draft.context);
  if (action.startsWith('bundle-read:') || action === 'bundle-read-next') {
    if (!backend.readDefinitionBundleFile) throw new Error('This Core version cannot preview definition file contents.');
    const index = action === 'bundle-read-next' ? draft.fileIndex : Number(action.slice('bundle-read:'.length));
    const item = Number.isSafeInteger(index) && index >= 0 ? fileItems(draft.review)[index] : null;
    if (!item) throw new Error('Choose a file from the reviewed manifest.');
    const offset = action === 'bundle-read-next' ? draft.filePreview?.nextOffset : 0;
    if (offset == null) throw new Error('There is no next file page.');
    const page = await backend.readDefinitionBundleFile(draft.review, { cwd: draft.context.cwd,
      entryIndex: draft.review.entries.indexOf(item.entry), file: item.file.path, offset, limit: 16384 });
    checkContext(ui, draft.context);
    if (ui.definitionBundleDraft === draft) { draft.fileIndex = index; draft.filePreview = page; refresh(ui); }
    return true;
  }
  if (action === 'bundle-output' && draft.operation === 'export') {
    const value = (await prompt(draft.context, 'ZIP filename in this terminal directory · Esc keeps the review', { initialValue: path.basename(draft.review.outputPath) }))?.trim();
    if (!value) return true;
    const outputPath = path.resolve(draft.context.cwd, value);
    if (path.dirname(outputPath) !== draft.context.cwd || path.extname(outputPath).toLowerCase() !== '.zip') throw new Error('Choose a .zip filename in this terminal’s current directory.');
    const review = await backend.previewDefinitionExport({ cwd: draft.context.cwd, outputPath, ...(draft.kinds ? { kinds: draft.kinds } : {}) });
    checkContext(ui, draft.context);
    try { checkTypes(review, draft.kinds); } catch (error) { discard({ review, backend }); throw error; }
    if (ui.definitionBundleDraft === draft) { discard(draft); draft.review = review; refresh(ui); }
    else discard({ review, backend });
    return true;
  }
  if (!['bundle-confirm', 'bundle-confirm-skip'].includes(action)) throw new Error('Choose an action from the ZIP review.');
  let result;
  if (draft.operation === 'export') {
    if (action !== 'bundle-confirm') throw new Error('Choose Write reviewed ZIP here.');
    result = await backend.exportDefinitionBundle(draft.review, { cwd: draft.context.cwd, outputPath: draft.review.outputPath });
    checkContext(ui, draft.context);
    ui.definitionBundleLastPath = { context: JSON.stringify(draft.context), path: result.path, ...(draft.kinds ? { kinds: draft.kinds } : {}) };
    ui.event('info', { message: `Exported ${result.skills} skills and ${result.agents} agents to ${result.path}.` });
  } else {
    const skipConflicts = action === 'bundle-confirm-skip';
    if (draft.review.conflicts?.length && !skipConflicts) throw new Error('This review contains destination conflicts. Choose the non-conflicting import or cancel.');
    if (skipConflicts && draft.review.conflicts?.length >= draft.review.entries.length) throw new Error('Every definition conflicts. Nothing can be imported from this review.');
    result = await backend.importDefinitionBundle(draft.review, { cwd: draft.context.cwd, skipConflicts });
    checkContext(ui, draft.context);
    ui.event('info', { message: `Imported ${result.skills.length} skills disabled and ${result.agents.length} agent definitions. No agent/model started.${result.skipped?.length ? ` Skipped ${result.skipped.length} conflicts.` : ''}` });
  }
  if (ui.definitionBundleDraft === draft) ui.definitionBundleDraft = null;
  refresh(ui); return true;
}
