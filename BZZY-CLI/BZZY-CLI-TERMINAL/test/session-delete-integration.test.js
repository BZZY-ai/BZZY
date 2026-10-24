import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { BzzyCore } from '@bzzy/core';
import { UI } from '../src/ui.js';
import { attachSession, viewSession, conversationInput } from '../src/runtime-client.js';
import { createSession, saveSession, loadSession } from '../src/store.js';
import { appendEvent, listRecords } from '../src/database.js';
import { BUILTINS } from '../src/providers.js';
import { namedTerminalSessions, chooseSavedSession } from '../src/session-browser.js';
import { runtimeInfo, runtimeRequest } from '../src/runtime.js';
import { identityAlive } from '../src/recovery.js';

let directory, cwd, previous;
test.beforeEach(() => {
  directory = fs.realpathSync(fs.mkdtempSync(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'bzzy-delete-line-')));
  cwd = path.join(directory, 'project'); fs.mkdirSync(cwd);
  previous = process.env.BZZY_HOME; process.env.BZZY_HOME = path.join(directory, 'private');
});
test.afterEach(async () => {
  const info = runtimeInfo();
  if (info && identityAlive(info.identity)) await runtimeRequest(info, 'POST', '/shutdown', {}).catch(() => {});
  for (let index = 0; index < 100 && info && identityAlive(info.identity); index++) await new Promise(resolve => setTimeout(resolve, 20));
  if (previous == null) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
  fs.rmSync(directory, { recursive: true, force: true });
});
function terminal() {
  const input = new PassThrough(); Object.assign(input, { isTTY: true, setRawMode() {} });
  const output = new PassThrough(); Object.assign(output, { isTTY: true, rows: 40, columns: 140 }); output.resume();
  return new UI({ input, output, error: output });
}
async function eventually(check) {
  const end = Date.now() + 6000;
  while (Date.now() < end) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.fail('Expected frontend deletion state did not arrive.');
}

test('deleting the attached current chat leaves its pollers cleanly and opens exactly one fresh idle context', { timeout: 15000 }, async () => {
  const source = createSession(BUILTINS.codex, cwd, 'saved-model', 'Current chat');
  source.goal = { status: 'paused', objective: 'Keep previous work inactive' }; source.selectedEffort = 'high'; saveSession(source);
  appendEvent(source.id, 'text', { text: 'Old response', itemId: 'old' });
  const ui = terminal(), seen = [], inputs = [`/session-action delete ${source.id}`, '/exit'];
  const setSession = ui.setSession.bind(ui); ui.setSession = (id, mode) => { seen.push(id); setSession(id, mode); };
  ui.ask = async () => { assert.ok(inputs.length, 'No model or unexpected prompt'); return inputs.shift(); };
  ui.chooseOne = async (title, options) => { assert.match(title, /Current chat/); assert.equal(options.choices[0].value, 'cancel'); return 'delete'; };
  try {
    assert.equal(await attachSession(source, { cwd, mode: 'solo' }, ui), 0);
    assert.equal(loadSession(source.id), null); assert.equal(namedTerminalSessions().length, 0);
    assert.notEqual(ui.sessionId, source.id); const fresh = loadSession(ui.sessionId);
    assert.equal(fresh.cwd, cwd); assert.equal(fresh.model, 'saved-model'); assert.equal(fresh.selectedEffort, 'high');
    assert.equal(fresh.goal, null); assert.equal(fresh.executionState, 'idle');
    const freshIds = new Set(seen.filter(id => id !== source.id)); assert.equal(freshIds.size, 1);
    assert.equal(listRecords('session').filter(row => !row.deletedAt).length, 1, 'one replacement conversation, without a poll/delete race duplicate');
    assert.equal(listRecords('execution').length, 0); assert.equal(inputs.length, 0);
  } finally { ui.close(); }
});

test('Sessions deletion refreshes the catalog, retains the current draft and never attaches to the deleted chat', { timeout: 15000 }, async () => {
  const current = createSession(BUILTINS.codex, cwd, null, 'Current');
  const other = createSession(BUILTINS.codex, cwd, null, 'Remove this');
  const ui = terminal(); ui.setSession(current.id); ui.tui.value = 'Keep current draft'; ui.tui.cursor = 5;
  const answers = [{ value: other.id, action: 'delete' }, 'delete', null]; let calls = 0;
  ui.chooseOne = async (title, options) => {
    calls++;
    if (calls === 1) { assert.equal(title, 'Sessions'); assert.ok(options.choices.some(choice => choice.value === other.id)); }
    if (calls === 2) assert.match(title, /Remove this/);
    if (calls === 3) { assert.equal(title, 'Sessions'); assert.deepEqual(options.choices.map(choice => choice.value), [current.id]); }
    return answers.shift();
  };
  try {
    assert.equal(await chooseSavedSession(ui), null); assert.equal(calls, 3);
    assert.equal(loadSession(other.id), null); assert.equal(ui.sessionId, current.id); assert.equal(ui.nextSession, undefined);
    assert.equal(ui.tui.value, 'Keep current draft'); assert.equal(ui.tui.cursor, 5);
    assert.equal(listRecords('execution').length, 0);
  } finally { ui.close(); }
});

test('an existing read-only observer closes gracefully and clears its displayed chat after another client deletes it', { timeout: 15000 }, async () => {
  const source = createSession(BUILTINS.codex, cwd, null, 'Observed chat');
  appendEvent(source.id, 'text', { text: 'Old visible response', itemId: 'old' });
  const ui = terminal();
  try {
    const viewing = viewSession(source, { follow: true }, ui);
    await eventually(() => ui.tui?.entries.some(entry => entry.text === 'Old visible response'));
    await new BzzyCore().deleteConversation(source.id, { requestId: randomUUID() });
    assert.equal(await viewing, 0); assert.equal(ui.nextSession, undefined);
    assert.equal(ui.tui.entries.some(entry => entry.text === 'Old visible response'), false);
    assert.equal(listRecords('session').filter(row => !row.deletedAt).length, 0, 'a read-only observer never creates a replacement chat');
    assert.equal(listRecords('execution').length, 0);
  } finally { ui.close(); }
});

test('an idle chat input reader leaves a remotely deleted context without waiting for another typed command', { timeout: 15000 }, async () => {
  const source = createSession(BUILTINS.codex, cwd, 'saved-model', 'Idle chat');
  appendEvent(source.id, 'text', { text: 'Idle previous response', itemId: 'old' });
  const ui = terminal(); ui.setSession(source.id);
  try {
    const waiting = conversationInput(source, ui);
    await eventually(() => ui.tui?.entries.some(entry => entry.text === 'Idle previous response'));
    await new BzzyCore().deleteConversation(source.id, { requestId: randomUUID() });
    assert.equal(await waiting, ''); assert.notEqual(ui.nextSession.id, source.id);
    assert.equal(ui.nextSession.cwd, cwd); assert.equal(ui.nextSession.model, source.model);
    assert.equal(ui.tui.entries.some(entry => entry.text === 'Idle previous response'), false);
    assert.equal(listRecords('execution').length, 0);
  } finally { ui.close(); }
});
