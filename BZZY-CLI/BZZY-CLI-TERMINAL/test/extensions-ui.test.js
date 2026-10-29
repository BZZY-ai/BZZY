import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { UI } from '../src/ui.js';
import { clean, cellWidth } from '../src/terminal-format.js';
import { createSession } from '@bzzy/core/engine/store.js';
import { saveExtension, readExtension, getExtension } from '@bzzy/core/engine/extensions.js';
import { extensionSettingsAction } from '../src/extensions-ui.js';
const definition = () => ({ format: 'bzzy-extension', version: 1, id: 'test-board', title: 'Test Board', description: 'Native fixture controls.',
  elements: [{ id: 'query', type: 'input', label: 'Query' }, { id: 'private-input', type: 'secret', label: 'Private credential' }, { id: 'save-button', type: 'button', label: 'Save', action: 'save' },
    { id: 'preview-button', type: 'button', label: 'Preview', action: 'preview' }, { id: 'output', type: 'text', text: '' }, { id: 'results', type: 'table', label: 'Results', columns: [{ key: 'name', label: 'Name' }] }],
  actions: [{ id: 'save', type: 'save' }, { id: 'preview', type: 'set', ai: true, values: { output: { input: 'query' } } }] });
function terminal(t, install = true) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-extension-ui-'))), previous = process.env.BZZY_HOME;
  process.env.BZZY_HOME = path.join(directory, 'private'); const cwd = path.join(directory, 'project'); fs.mkdirSync(cwd);
  const session = createSession({ id: 'codex', backend: 'codex' }, cwd); if (install) saveExtension(definition());
  const input = new PassThrough(), output = new PassThrough(); Object.assign(input, { isTTY: true, setRawMode() {} }); Object.assign(output, { isTTY: true, columns: 100, rows: 30 });
  let written = ''; output.on('data', chunk => { written += chunk; });
  const ui = new UI({ input, output, error: output, cwd }); ui.setSession(session.id); ui.updateSession({ session });
  ui.tui.value = 'Unsent chat draft'; ui.tui.cursor = 6;
  t.after(() => { ui.close(); if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous; fs.rmSync(directory, { recursive: true, force: true }); });
  return { ui, tui: ui.tui, input, output, session, directory, cwd, get written() { return written; } };
}
const click = (tui, type, id) => { tui.render(); const hit = tui.hitTargets.find(h => h.type === type && (id === undefined || h.id === id)); assert.ok(hit, type); tui.mouse(0, hit.left, hit.row); tui.render(); };
test('extension lane opens native controls; Chat before Skills returns from extensions and Settings preserving draft/scroll', t => {
  const { ui, tui } = terminal(t); ui.event('text', { text: 'Saved history\n'.repeat(100) }); tui.scroll = 7;
  click(tui, 'extension-tab', 'test-board'); assert.equal(tui.panel, 'extension'); assert.equal(tui.canCompose(), false);
  assert.match(tui.lastFrame.map(clean).join('\n'), /Test Board/); assert.doesNotMatch(tui.lastFrame.map(clean).join('\n'), /Unsent chat draft/);
  click(tui, 'top-chat'); assert.equal(tui.panel, 'chat'); assert.equal(tui.value, 'Unsent chat draft'); assert.equal(tui.cursor, 6); assert.equal(tui.scroll, 7);
  ui.openSettings(); tui.render(); const chat = tui.hitTargets.find(h => h.type === 'top-chat'), skills = tui.hitTargets.find(h => h.type === 'top-skills');
  assert.ok(chat.row < skills.row || chat.row === skills.row && chat.left < skills.left); click(tui, 'top-chat'); assert.equal(tui.panel, 'chat');
  for (const panel of ['metrics', 'skills', 'agents', 'workflows', 'goals', 'http', 'activity']) { tui.setPanel(panel); click(tui, 'top-chat'); assert.equal(tui.panel, 'chat'); }
});
test('native form edits are visible to chat after commit; owner Save masks credentials and AI-compatible button updates text', async t => {
  const fixture = terminal(t), { ui, tui, input, session } = fixture;
  ui.extensions.select('test-board'); input.write('public query'); input.write('\r'); await ui.extensions.task;
  assert.equal(readExtension(session, 'test-board').elements.find(e => e.id === 'query').value, 'public query');
  click(tui, 'extension-control', 'preview-button'); await ui.extensions.task; tui.render(); assert.match(tui.lastFrame.map(clean).join('\n'), /public query/);
  click(tui, 'extension-control', 'private-input'); input.write('fixture-private-owner-secret'); tui.render();
  assert.equal(fixture.written.includes('fixture-private-owner-secret'), false);
  click(tui, 'extension-control', 'save-button'); await ui.extensions.task;
  assert.equal(readExtension(session, 'test-board').elements.find(e => e.type === 'secret').configured, true);
  assert.equal(fixture.written.includes('fixture-private-owner-secret'), false); assert.equal(tui.value, 'Unsent chat draft');
});
test('Settings offers local and Relay transfers and loaded checkboxes disable and re-enable tabs', async t => {
  const { ui, tui, cwd } = terminal(t); ui.openSettings(); await ui.settings.run('extensions');
  const actions = ui.settings.rows().filter(r => r.action).map(r => r.action);
  for (const action of ['extensions-local-import', 'extensions-local-export', 'extensions-relay-import', 'extensions-relay-export', 'extensions-toggle:test-board']) assert.ok(actions.includes(action));
  await ui.settings.run('extensions-toggle:test-board'); assert.equal(getExtension('test-board').enabled, false); assert.equal(ui.extensions.catalog.length, 0);
  await ui.settings.run('extensions-toggle:test-board'); assert.equal(getExtension('test-board').enabled, true);
  const transfers = []; await extensionSettingsAction('extensions-relay-export', ui, { transfer: (...args) => transfers.push(args.slice(0, 3)) });
  await extensionSettingsAction('extensions-relay-import', ui, { transfer: (...args) => transfers.push(args.slice(0, 3)) }); assert.deepEqual(transfers, [['export', 'extension', cwd], ['import', 'extension', cwd]]);
  const added = definition(); added.id = 'local-board'; added.title = 'Local Board'; fs.writeFileSync(path.join(cwd, 'local.json'), JSON.stringify(added));
  ui.ask = async () => 'local.json'; ui.chooseOne = async (_title, review) => { assert.match(review.description, /Offline controls only/); return 'import'; };
  await extensionSettingsAction('extensions-local-import', ui); assert.equal(getExtension('local-board').title, 'Local Board');
  tui.setPanel('chat'); assert.equal(tui.value, 'Unsent chat draft');
});
test('compact extension screens retain bounded cells and tab paging; an empty extension lane remains reserved', t => {
  const { ui, tui, output } = terminal(t); ui.extensions.select('test-board');
  for (const columns of [40, 80, 120]) { output.columns = columns; output.rows = 24; tui.render(); assert.ok(tui.lastFrame.length <= 24); assert.ok(tui.lastFrame.every(line => cellWidth(line) < columns)); assert.ok(tui.hitTargets.some(h => h.type === 'top-chat')); }
  ui.extensions.leave(); const item = getExtension('test-board'); assert.equal(item.enabled, true);
});
test('Escape Exit/Cancel preserves the main reader and draft, and only explicit Exit submits /exit', async t => {
  const { ui, tui, input } = terminal(t); const waiting = ui.ask('bzzy › '); await Promise.resolve();
  const reader = ui.reader; input.write('\x1b[27u'); assert.equal(tui.selection.scope, 'exit'); assert.equal(tui.selection.choices[tui.selection.focus].value, 'cancel');
  input.write('\x1b[27u'); assert.equal(tui.selection, null); assert.equal(ui.reader, reader); assert.equal(tui.value, 'Unsent chat draft'); assert.equal(tui.inputQueue.length, 0);
  input.write('\x1b[27u'); tui.selection.focus = 0; input.write('\r'); assert.equal(await waiting, '/exit'); assert.equal(tui.value, 'Unsent chat draft');
});
test('idle Ctrl+C / Ctrl+D ask before exit; busy Ctrl+C pauses through the existing command path', t => {
  const { tui } = terminal(t); tui.value = ''; tui.cursor = 0;
  tui.key('', { ctrl: true, name: 'd' }); assert.equal(tui.selection.scope, 'exit'); tui.finishSelection(null);
  tui.key('', { ctrl: true, name: 'c' }); assert.equal(tui.selection.scope, 'exit'); tui.finishSelection(null);
  tui.busy = true; tui.key('', { ctrl: true, name: 'c' }); assert.equal(tui.selection, null); assert.equal(tui.inputQueue.at(-1).text, '/pause');
});

test('loading retains fast typing without acting on stale controls and failed restores discard queued actions', t => {
  const { tui, input } = terminal(t); const draft = tui.value;
  const finish = tui.beginHistoryRestore({ alias: 'Long saved chat' });
  input.write(' typed while loading'); assert.equal(tui.value, draft); assert.equal(tui.inputQueue.length, 0);
  finish(); assert.ok(tui.value.includes('typed while loading')); assert.equal(tui.historyRestoreDepth, 0);
  const before = tui.value, failed = tui.beginHistoryRestore(); input.write('/exit\r'); failed(false);
  assert.equal(tui.value, before); assert.equal(tui.inputQueue.length, 0); assert.equal(tui.historyRestoreDepth, 0);
});

test('switching saved terminals discards private extension drafts before the next snapshot arrives', t => {
  const { ui, tui, session, cwd } = terminal(t); ui.extensions.select('test-board');
  click(tui, 'extension-control', 'private-input'); ui.extensions.key('unsaved-private-binding', {});
  const other = createSession({ id: 'codex', backend: 'codex' }, cwd); ui.setSession(other.id);
  assert.equal(ui.extensions.id, null); assert.deepEqual(ui.extensions.secrets, {}); assert.equal(tui.panel, 'chat');
  assert.equal(readExtension(other, 'test-board').elements.find(e => e.type === 'secret').configured, false);
  assert.equal(readExtension(session, 'test-board').elements.find(e => e.type === 'secret').configured, false);
});
