import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { UI } from '../src/ui.js';
import { createSession, loadSession, saveSession } from '../src/store.js';
import { BUILTINS } from '../src/providers.js';
import { listRecords, appendEvent, events } from '../src/database.js';
import { deleteSavedSession } from '../src/session-browser.js';
import { clean } from '../src/terminal-format.js';

let directory, cwd, previous;
test.beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-delete-ui-'));
  cwd = path.join(directory, 'project'); fs.mkdirSync(cwd);
  previous = process.env.BZZY_HOME; process.env.BZZY_HOME = path.join(directory, 'private');
});
test.afterEach(() => {
  if (previous == null) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
  fs.rmSync(directory, { recursive: true, force: true });
});
function terminal(session) {
  const input = new PassThrough(); Object.assign(input, { isTTY: true, setRawMode() {} });
  const output = new PassThrough(); Object.assign(output, { isTTY: true, rows: 40, columns: 140 }); output.resume();
  const ui = new UI({ input, output, error: output }); ui.setSession(session.id); ui.updateSession(session);
  return ui;
}
const receipt = (id, deletedSessionIds = [id]) => ({ state: 'deleted', sessionId: id, deletedSessionIds, deletedAt: new Date().toISOString() });
const ready = async () => { await Promise.resolve(); await Promise.resolve(); };

test('right-click and F10 expose Delete chat for the root terminal and preserve the Sessions action', async () => {
  const source = createSession(BUILTINS.codex, cwd, null, 'Named terminal'), ui = terminal(source);
  try {
    const answer = ui.ask('bzzy › '); ui.tui.value = 'Unsent thought'; ui.tui.cursor = 4; ui.tui.render();
    const alias = ui.tui.hitTargets.find(hit => hit.type === 'alias');
    ui.activeTab = 'aaaaaaaa-0000-4000-8000-000000000001';
    ui.tui.mouse(2, alias.left, alias.row); ui.tui.render();
    assert.equal(ui.tui.selection.title, source.alias, 'the alias belongs to the terminal, not a selected child tab');
    const index = ui.tui.selection.choices.findIndex(choice => choice.value === 'delete'); assert.ok(index > 0);
    const hit = ui.tui.hitTargets.find(hit => hit.type === 'choice' && hit.index === index);
    ui.tui.mouse(0, hit.left, hit.row);
    assert.equal(await answer, `/session-action delete ${source.id}`);
    assert.equal(ui.tui.value, 'Unsent thought'); assert.equal(ui.tui.history.length, 0);
    const picking = ui.chooseOne('Sessions', [{ value: source.id, label: source.alias }], { scope: 'sessions' });
    await ready(); ui.tui.key('', { name: 'f10' });
    ui.tui.key('', { name: 'down' }); ui.tui.key('', { name: 'down' }); ui.tui.key('', { name: 'return' });
    assert.deepEqual(await picking, { value: source.id, action: 'delete' });
    assert.equal(listRecords('execution').length, 0);
  } finally { ui.close(); }
});

test('deletion confirmation names the alias and defaults to keeping the chat', async () => {
  const source = createSession(BUILTINS.codex, cwd, null, 'Keep this'), ui = terminal(source);
  ui.tui.value = 'Keep this draft'; ui.tui.cursor = 5;
  let calls = 0;
  try {
    for (const key of ['return', 'escape']) {
      const deleting = deleteSavedSession(ui, source.id, { remove: () => { calls++; } });
      await ready(); ui.tui.render();
      assert.match(ui.tui.selection.title, /Keep this/);
      assert.match(ui.tui.selection.warning, /Project files are kept/);
      assert.equal(ui.tui.selection.choices[ui.tui.selection.focus].value, 'cancel');
      ui.tui.key('', { name: key }); assert.equal(await deleting, null);
    }
    assert.equal(calls, 0); assert.equal(ui.tui.value, 'Keep this draft'); assert.equal(ui.tui.cursor, 5);
    assert.equal(loadSession(source.id).alias, 'Keep this');
  } finally { ui.close(); }
});

test('confirmed deletion of another chat uses the Core receipt and keeps the current conversation and draft', async () => {
  const source = createSession(BUILTINS.codex, cwd, null, 'Current'), other = createSession(BUILTINS.codex, cwd, null, 'Other');
  const ui = terminal(source), calls = [];
  try {
    ui.event('text', { text: 'Visible answer', itemId: 'answer' });
    ui.tui.value = 'Unsent draft'; ui.tui.cursor = 3;
    ui.cursors.set(source.id, 10); ui.cursors.set(other.id, 25);
    ui.tui.drafts.set(other.id, { value: 'Other draft', cursor: 4 });
    ui.tui.inputQueue.push({ sessionId: other.id, text: 'Stale queued input' }, { sessionId: source.id, text: 'Current queued input' });
    const entries = [...ui.tui.entries];
    const deleting = deleteSavedSession(ui, other.id, { remove: async (id, options) => { calls.push({ id, ...options }); return receipt(id); }, fresh: () => assert.fail('Only the deleted current chat needs a replacement') });
    await ready(); ui.tui.render();
    const index = ui.tui.selection.choices.findIndex(choice => choice.value === 'delete');
    const hit = ui.tui.hitTargets.find(hit => hit.type === 'choice' && hit.index === index);
    ui.tui.mouse(0, hit.left, hit.row); await deleting;
    assert.equal(calls[0].id, other.id); assert.match(calls[0].requestId, /^[a-f0-9-]{36}$/);
    assert.equal(ui.sessionId, source.id); assert.equal(ui.nextSession, undefined);
    assert.equal(ui.tui.value, 'Unsent draft'); assert.equal(ui.tui.cursor, 3); assert.deepEqual(ui.tui.entries, entries);
    assert.equal(ui.cursors.get(source.id), 10); assert.equal(ui.cursors.has(other.id), false);
    assert.equal(ui.tui.drafts.has(other.id), false);
    assert.deepEqual(ui.tui.inputQueue, [{ sessionId: source.id, text: 'Current queued input' }]);
    assert.equal(ui.tui.recentCache, null); assert.equal(ui.sessionDeleteRequests.size, 0);
    assert.equal(listRecords('execution').length, 0);
  } finally { ui.close(); }
});

test('confirmation wraps the complete long alias instead of hiding its distinguishing suffix', async () => {
  const alias = '同'.repeat(78) + 'AB', source = createSession(BUILTINS.codex, cwd, null, alias), ui = terminal(source);
  try {
    ui.output.columns = 80; ui.output.rows = 24;
    const deleting = deleteSavedSession(ui, source.id, { remove: () => assert.fail('Rendering cannot delete a chat') });
    await ready(); ui.tui.render();
    const frame = ui.tui.lastFrame.map(clean).join('\n');
    assert.match(frame, /AB”/); assert.match(frame, /Project files are kept/);
    ui.tui.key('', { name: 'escape' }); assert.equal(await deleting, null);
  } finally { ui.close(); }
});

test('deleting the current chat opens a fresh unnamed idle context in the same project without copying old work', async () => {
  const source = createSession(BUILTINS.codex, cwd, 'saved-model', 'Delete me');
  source.selectedEffort = 'high'; source.mode = 'parallel'; source.modelSelectionRequired = true;
  source.goal = { id: 'old-goal', status: 'paused', objective: 'Old private objective' }; saveSession(source);
  appendEvent(source.id, 'text', { text: 'Previous answer' });
  const ui = terminal(source), child = 'aaaaaaaa-0000-4000-8000-000000000002';
  try {
    ui.chooseOne = async () => 'delete'; ui.tui.value = 'Previous draft'; ui.tui.cursor = 4;
    ui.tui.drafts.set(child, { value: 'Child draft', cursor: 5 }); ui.cursors.set(child, 30);
    ui.tui.inputQueue.push({ sessionId: source.id, text: 'Old queued input' }, { sessionId: child, text: 'Old child input' });
    await deleteSavedSession(ui, source.id, { remove: async id => receipt(id, [id, child]) });
    const fresh = ui.nextSession;
    assert.notEqual(fresh.id, source.id); assert.equal(fresh.cwd, cwd); assert.equal(fresh.model, source.model);
    assert.equal(fresh.selectedEffort, 'high'); assert.equal(fresh.mode, 'parallel'); assert.equal(fresh.modelSelectionRequired, true);
    assert.equal(fresh.alias, undefined); assert.equal(fresh.goal, null); assert.equal(fresh.executionState, 'idle');
    assert.equal(ui.tui.value, ''); assert.deepEqual(ui.tui.inputQueue, []); assert.equal(ui.tui.drafts.has(child), false);
    assert.equal(ui.cursors.has(child), false); assert.equal(events(fresh.id).some(event => event.type === 'text'), false);
    assert.equal(listRecords('execution').length, 0);
  } finally { ui.close(); }
});

test('busy work is kept, an uncertain deletion reuses its request ID, and explicit read-only views cannot delete', async () => {
  const source = createSession(BUILTINS.codex, cwd, null, 'Safe chat'), ui = terminal(source), ids = [];
  try {
    ui.chooseOne = async () => 'delete'; ui.tui.value = 'Keep draft';
    const busy = Object.assign(new Error('Stop or pause this chat’s work before deleting it.'), { code: 'SESSION_BUSY' });
    await assert.rejects(deleteSavedSession(ui, source.id, { remove: async (_id, options) => { ids.push(options.requestId); throw busy; } }), /Stop or pause/);
    assert.equal(ui.nextSession, undefined); assert.equal(ui.tui.value, 'Keep draft'); assert.equal(ui.sessionDeleteRequests.size, 0);
    await assert.rejects(deleteSavedSession(ui, source.id, { remove: async (_id, options) => { ids.push(options.requestId); throw Object.assign(new Error('Uncertain'), { code: 'UNCERTAIN' }); } }), /Uncertain/);
    await deleteSavedSession(ui, source.id, { remove: async (id, options) => { ids.push(options.requestId); return receipt(id); } });
    assert.notEqual(ids[0], ids[1]); assert.equal(ids[1], ids[2]);
    ui.sessionMode = 'VIEW';
    await assert.rejects(deleteSavedSession(ui, source.id, { remove: () => assert.fail('No owner deletion from a read-only view') }), /read-only/);
  } finally { ui.close(); }
});
