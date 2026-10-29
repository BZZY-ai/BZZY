import { home } from '@bzzy/core/engine/files.js';
import { readClipboard } from './clipboard.js';
import path from 'node:path';
import { loadSession } from '@bzzy/core/engine/store.js';
import { listExtensions, getExtension, saveExtension, setExtensionEnabled, readExtension, setExtensionValues, saveExtensionSecrets, runExtensionAction, newExtensionRequestId } from '@bzzy/core/engine/extensions.js';
import { readExtensionFile, exportExtensionFile } from '@bzzy/core/engine/extensions-cli.js';
import { transferLibraryTab } from './library-ui.js';
import { clean, clip, wrap, cellWidth } from './terminal-format.js';
import { palette } from './terminal-theme.js';

const form = e => ['input', 'textarea', 'select', 'toggle'].includes(e.type);
const control = e => form(e) || ['secret', 'button', 'table'].includes(e.type);
const sessionFor = ui => loadSession(ui.activeTab || ui.sessionId);
export class NativeExtensions {
  constructor(ui) { this.ui = ui; this.catalog = []; this.views = new Map(); this.focus = 0; this.offset = 0; this.tableOffset = 0; this.drafts = {}; this.secrets = {}; this.cursors = {}; }
  refresh() {
    try {
      this.catalog = listExtensions({ enabledOnly: true });
      if (this.id) {
        if (!this.catalog.some(x => x.id === this.id) || this.sessionId !== (this.ui.activeTab || this.ui.sessionId)) this.leave();
        else { const view = readExtension(sessionFor(this.ui), this.id, { offset: this.tableOffset, limit: 100 });
          if (this.view?.version !== view.version || this.view?.installationId !== view.installationId) { this.drafts = {}; this.secrets = {}; this.cursors = {}; this.focus = 0; this.offset = 0; }
          this.view = view;
        }
      }
    } catch { this.catalog = []; if (this.id) this.leave(); }
  }
  leave() {
    const tui = this.ui.tui;
    if (this.id && this.view) this.views.set(`${this.sessionId}:${this.id}:${this.view.version}:${this.view.installationId}`, { focus: this.focus, offset: this.offset, tableOffset: this.tableOffset, drafts: this.drafts, cursors: this.cursors });
    // Private unsaved input is intentionally discarded on navigation.
    this.id = null; this.view = null; this.secrets = {}; this.drafts = {}; this.cursors = {};
    if (tui?.panel === 'extension') { tui.panel = 'chat'; tui.scroll = this.chatScroll || 0; tui.bodyCache = null; tui.schedule(); }
  }
  select(id) {
    const tui = this.ui.tui;
    if (!tui || tui.selection || tui.promptDraft || tui.hidden || this.ui.privateView || this.ui.coreLifecycleInterrupted) return;
    if (!id) { this.leave(); if (tui.panel !== 'chat') tui.setPanel('chat'); return; }
    try {
      if (this.id) this.leave();
      const view = readExtension(sessionFor(this.ui), id, { limit: 100 });
      this.chatScroll = tui.scroll; this.sessionId = this.ui.activeTab || this.ui.sessionId; this.id = id; this.view = view;
      Object.assign(this, { focus: 0, offset: 0, tableOffset: 0, drafts: {}, secrets: {}, cursors: {}, ...this.views.get(`${this.sessionId}:${id}:${view.version}:${view.installationId}`) });
      if (this.tableOffset) this.view = readExtension(sessionFor(this.ui), id, { offset: this.tableOffset, limit: 100 });
      tui.setPanel('extension'); this.ensureFocus = true; tui.schedule();
    } catch { tui.notice('Extension is unavailable for this terminal.', true); }
  }
  tabs(width, row, theme) {
    if (!this.catalog.length) return { line: '', hits: [] };
    const hits = [], { color } = theme; let line = '  ', col = 3;
    const add = (label, id, active) => { const shown = clip(` ${label} `, Math.max(1, width - col - 3)); hits.push({ type: 'extension-tab', id, row, left: col, right: col + cellWidth(shown) - 1 }); line += color(shown, active ? palette.accent : palette.muted, active); col += cellWidth(shown); };
    if (this.tabStart) { hits.push({ type: 'extension-tabs-page', direction: -1, row, left: col + 1, right: col + 3 }); line += ' ‹ '; col += 3; }
    let index = this.tabStart || 0;
    for (; index < this.catalog.length; index++) {
      const e = this.catalog[index];
      if (col + Math.min(42, cellWidth(e.title) + 3) > width - 4 && index > (this.tabStart || 0)) break;
      add(e.title, e.id, this.id === e.id);
      if (col >= width - 4) { index++; break; }
    }
    if (index < this.catalog.length) { hits.push({ type: 'extension-tabs-page', direction: 1, row, left: col + 1, right: col + 3 }); line += ' › '; this.nextTabStart = index; }
    return { line: cellWidth(line) <= width ? line : clip(line, width), hits };
  }
  controls() { return this.view?.elements.filter(control) || []; }
  current(e) { return Object.hasOwn(this.drafts, e.id) ? this.drafts[e.id] : e.value ?? ''; }
  currentSession() { const session = sessionFor(this.ui); if (session?.id !== this.sessionId || !this.id) throw new Error('The terminal changed.'); return session; }
  commit() {
    if (!this.view || !Object.keys(this.drafts).length) return;
    this.view = setExtensionValues(this.currentSession(), this.id, { version: this.view.version, revision: this.view.revision, values: this.drafts }); this.drafts = {};
  }
  async activate(id) {
    if (this.busy || !this.view) return;
    const e = this.view.elements.find(e => e.id === id), extensionId = this.id, version = this.view.version;
    if (!e) return;
    try {
      const session = this.currentSession();
      if (e.type === 'button') {
        this.busy = true; this.ui.tui.schedule(); this.commit();
        const a = this.view.actions.find(a => a.id === e.action);
        if (a?.type === 'save') { this.view = saveExtensionSecrets(session, extensionId, { version, installationId: this.view.installationId, secrets: this.secrets }); this.secrets = {}; }
        const input = { version, revision: this.view.revision, action: e.action, requestId: newExtensionRequestId() };
        const view = await runExtensionAction(session, extensionId, input, { actor: 'owner', authorized: () => !this.ui.closed && !this.ui.coreLifecycleInterrupted && (this.ui.activeTab || this.ui.sessionId) === session.id });
        if (this.id === extensionId && this.sessionId === session.id) { this.view = view; this.tableOffset = 0; }
      } else if (e.type === 'toggle') { this.drafts[e.id] = !this.current(e); this.commit(); }
      else if (e.type === 'select') this.cycle(e, 1);
      else if (form(e)) this.commit();
    } catch { this.ui.tui.notice('Extension action failed or state changed. Refresh the view and check its status.', true); this.refresh(); }
    finally { this.busy = false; this.ui.tui?.schedule(); }
  }
  cycle(e, direction) { const at = e.options.findIndex(o => o.value === this.current(e)); this.drafts[e.id] = e.options[(at + direction + e.options.length) % e.options.length].value; this.commit(); }
  click(hit) {
    if (hit.type === 'extension-tab') this.select(hit.id);
    else if (hit.type === 'extension-tabs-page') { this.tabStart = hit.direction > 0 ? this.nextTabStart : Math.max(0, (this.tabStart || 0) - 1); this.ui.tui.schedule(); }
    else if (hit.type === 'extension-control') { this.focus = this.controls().findIndex(e => e.id === hit.id); this.ensureFocus = true; this.task = this.activate(hit.id); }
    else if (hit.type === 'extension-table-page') { this.tableOffset = Math.max(0, this.tableOffset + hit.direction * 100); this.refresh(); this.offset = 0; this.ensureFocus = true; this.ui.tui.schedule(); }
  }
  async paste() {
    const id = this.id, field = this.controls()[this.focus], session = this.sessionId;
    if (!field || !['input', 'textarea', 'secret'].includes(field.type)) return;
    const result = await (this.ui.clipboard?.readClipboard || readClipboard)();
    if (this.id !== id || this.sessionId !== session || this.controls()[this.focus]?.id !== field.id || this.ui.closed) return;
    if (typeof result.text === 'string') this.key(clean(result.text).replace(/[\r\n\t]/g, ' '), {});
  }
  key(text, key) {
    if (this.busy) return;
    const controls = this.controls(), e = controls[this.focus];
    if (key.ctrl && key.name === 'v') { this.task = this.paste(); return; }
    try {
      if (['tab', 'up', 'down'].includes(key.name)) { this.commit(); const direction = key.shift || key.name === 'up' ? -1 : 1; this.focus = (this.focus + direction + controls.length) % Math.max(1, controls.length); this.ensureFocus = true; }
      else if (['pageup', 'pagedown'].includes(key.name)) { this.offset = Math.max(0, Math.min(this.maximum || 0, this.offset + (key.name === 'pageup' ? -8 : 8))); }
      else if (key.name === 'return' && !(e?.type === 'textarea' && (key.shift || key.meta))) { this.task = this.activate(e?.id); }
      else if (e?.type === 'select' && ['left', 'right'].includes(key.name)) this.cycle(e, key.name === 'left' ? -1 : 1);
      else if (e?.type === 'toggle' && key.name === 'space') this.task = this.activate(e.id);
      else if (e && ['input', 'textarea', 'secret'].includes(e.type)) {
        const current = e.type === 'secret' ? this.secrets[e.id] || '' : this.current(e), chars = [...current]; let cursor = Math.min(chars.length, this.cursors[e.id] ?? chars.length);
        if (key.ctrl && key.name === 'u') { chars.length = 0; cursor = 0; }
        else if (key.name === 'backspace') { if (cursor) chars.splice(--cursor, 1); }
        else if (key.name === 'delete') chars.splice(cursor, 1);
        else if (key.name === 'left') cursor = Math.max(0, cursor - 1);
        else if (key.name === 'right') cursor = Math.min(chars.length, cursor + 1);
        else if (key.name === 'home' || key.ctrl && key.name === 'a') cursor = 0;
        else if (key.name === 'end' || key.ctrl && key.name === 'e') cursor = chars.length;
        else if (key.name === 'return' && e.type === 'textarea') { chars.splice(cursor++, 0, '\n'); }
        else if (text && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f-\x9f]/.test(text)) { const inserted = [...text]; chars.splice(cursor, 0, ...inserted); cursor += inserted.length; }
        const value = chars.join('').slice(0, e.type === 'textarea' ? 12000 : 4000);
        if (e.type === 'secret') this.secrets[e.id] = value; else this.drafts[e.id] = value;
        this.cursors[e.id] = cursor;
      }
    } catch { this.ui.tui.notice('Extension state changed. Reopen its tab before editing.', true); this.refresh(); }
    this.ui.tui.schedule();
  }
  layout(width, height, theme) {
    const { color } = theme, lines = [], hits = [], positions = new Map(); const focused = this.controls()[this.focus]?.id;
    const put = (value = '', tone = palette.text, bold = false) => lines.push(color(clip(value, width), tone, bold));
    if (!this.view) { put('  Extension unavailable', palette.warning); return { lines, hits }; }
    put('  ' + this.view.title, palette.accent, true);
    for (const line of wrap(this.view.description, width - 4)) put('  ' + line, palette.muted);
    put('  ' + (this.busy ? '⟳ Working…' : this.view.status), this.busy ? palette.accent : palette.muted); put();
    for (const e of this.view.elements) {
      positions.set(e.id, lines.length); const selected = focused === e.id, mark = selected ? '› ' : '  ';
      if (['text', 'status'].includes(e.type)) {
        const tone = ({ muted: palette.muted, accent: palette.accent, success: palette.goalSuccess, warning: palette.warning })[e.tone] || palette.text;
        if (e.label) put('  ' + e.label, tone, true);
        for (const line of wrap(clean(e.value ?? e.text), width - 4)) put('  ' + line, tone);
      } else if (e.type === 'separator') put('  ' + '─'.repeat(Math.max(1, width - 4)), palette.border);
      else {
        const row = lines.length;
        if (e.type === 'button') put('  ' + mark + '[ ' + e.label + ' ]', selected ? palette.accent : palette.text, selected);
        else if (e.type === 'toggle') put('  ' + mark + '[' + (this.current(e) ? 'x' : ' ') + '] ' + e.label, selected ? palette.accent : palette.text);
        else if (e.type === 'table') {
          put('  ' + mark + e.label + ` · ${e.total} rows`, palette.accent, selected);
          const size = Math.max(4, Math.floor((width - 4 - (e.columns.length - 1) * 3) / e.columns.length));
          const tableLine = row => '  ' + e.columns.map(c => { const t = clip(String(row[c.key] ?? ''), size); return t + ' '.repeat(Math.max(0, size - cellWidth(t))); }).join(' │ ');
          put(tableLine(Object.fromEntries(e.columns.map(c => [c.key, c.label]))), palette.muted, true);
          for (const row of e.rows) put(tableLine(row));
          if (!e.rows.length) put('  No rows yet.', palette.muted);
          if (e.total > 100) {
            put(`  [ Previous ]  [ Next ]  ${e.offset + 1}–${Math.min(e.total, e.offset + e.rows.length)} / ${e.total}`, palette.accent);
            if (e.offset > 0) hits.push({ type: 'extension-table-page', direction: -1, row: lines.length - 1, left: 3, right: 14 });
            if (e.nextOffset !== null) hits.push({ type: 'extension-table-page', direction: 1, row: lines.length - 1, left: 17, right: 26 });
          }
        } else {
          put('  ' + mark + e.label, selected ? palette.accent : palette.muted, selected);
          const value = e.type === 'secret' ? this.secrets[e.id] ? '•'.repeat(Math.min(24, [...this.secrets[e.id]].length)) : e.configured ? '•••••••• (saved)' : ''
            : e.type === 'select' ? e.options.find(o => o.value === this.current(e))?.label || '' : String(this.current(e));
          const wrapped = wrap(value || e.placeholder || (e.type === 'secret' ? 'Enter privately · Save to connect' : 'Enter a value'), width - 8, e.type === 'textarea' ? 8 : 1);
          for (const line of wrapped) put('    [ ' + line + ' ]', value ? palette.text : palette.muted);
        }
        for (let r = row; r < Math.min(lines.length, row + (e.type === 'table' ? 1 : 2)); r++) hits.push({ type: 'extension-control', id: e.id, row: r, left: 3, right: width - 2 });
      }
      put();
    }
    this.maximum = Math.max(0, lines.length - height);
    if (this.ensureFocus) { const row = positions.get(focused) || 0; if (row < this.offset || row > this.offset + height - 3) this.offset = Math.max(0, row - 1); this.ensureFocus = false; }
    this.offset = Math.max(0, Math.min(this.maximum, this.offset));
    return { lines: lines.slice(this.offset, this.offset + height), hits: hits.filter(h => h.row >= this.offset && h.row < this.offset + height).map(h => ({ ...h, row: h.row - this.offset })) };
  }
}

export function extensionSettingsRows() {
  const rows = [ { text: 'Import from local file', action: 'extensions-local-import', tone: 'accent' }, { text: 'Export to local file', action: 'extensions-local-export', tone: 'accent' },
    { text: 'Import from BZZY Relay', action: 'extensions-relay-import', tone: 'accent' }, { text: 'Export through BZZY Relay', action: 'extensions-relay-export', tone: 'accent' },
    { text: '' }, { text: 'Loaded extensions', section: true } ];
  try { const list = listExtensions(); if (!list.length) rows.push({ text: 'No extensions installed.', tone: 'muted' });
    for (const item of list) rows.push({ text: `[${item.enabled ? 'x' : ' '}] ${item.title}`, detail: item.description, action: 'extensions-toggle:' + item.id, tone: item.enabled ? 'accent' : 'muted' });
  } catch { rows.push({ text: 'Extension catalog unavailable.', tone: 'warning' }); }
  rows.push({ text: 'Definitions only · private credentials stay on this host', tone: 'muted' }, { text: '← Back', action: 'back', tone: 'muted' }); return rows;
}
export async function extensionSettingsAction(action, ui, { transfer = transferLibraryTab } = {}) {
  const session = loadSession(ui.sessionId), cwd = session?.cwd || ui.launchCwd || process.cwd();
  const before = { session: ui.sessionId, tab: ui.activeTab, home: home() };
  const check = () => { if (home() !== before.home || ui.closed || ui.coreLifecycleInterrupted || ui.sessionId !== before.session || ui.activeTab !== before.tab) throw new Error('Extension context changed. Reopen Settings.'); };
  if (action.startsWith('extensions-toggle:')) { const item = getExtension(action.slice('extensions-toggle:'.length)); setExtensionEnabled(item.id, !item.enabled, item.revision); }
  else if (action.startsWith('extensions-relay-')) { await transfer(action.endsWith('export') ? 'export' : 'import', 'extension', cwd, ui); }
  else if (action === 'extensions-local-import') {
    const file = await ui.ask('Extension JSON file: '); check(); if (!file?.trim()) return;
    const definition = readExtensionFile(file.trim(), cwd);
    const confirm = await ui.chooseOne('Import extension', { choices: [ { value: 'import', label: `Install ${definition.title}`, description: definition.description }, { value: 'cancel', label: 'Cancel' } ], description: 'Review this package before installing. Destinations: ' + (definition.actions.filter(a => a.type === 'http').map(a => a.url + (a.ai ? ' (AI enabled)' : ' (owner only)')).join(' · ') || 'Offline controls only') + '. Credentials are connected separately.' }, { scope: 'extension-install', confirmLabel: 'Import' });
    check(); if (confirm === 'import') saveExtension(definition);
  } else if (action === 'extensions-local-export') {
    const list = listExtensions(); if (!list.length) { ui.tui.notice('No extensions installed.'); return; }
    const id = await ui.chooseOne('Export extension', list.map(e => ({ value: e.id, label: e.title })), { scope: 'extension-export', description: 'Exports the portable JSON definition only.' });
    check(); if (!id) return;
    const file = await ui.ask('New JSON export file: '); check(); if (!file?.trim()) return;
    const result = exportExtensionFile(id, file.trim(), cwd); ui.tui.notice('Exported ' + path.basename(result.path));
  }
  ui.extensions?.refresh(); ui.tui.bodyCache = null; ui.tui.schedule();
}
