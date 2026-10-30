import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { createSession, saveSession, loadSession, sessions, findSession, setSessionAlias, sessionPath } from '../src/store.js';
import { BUILTINS } from '../src/providers.js';
import { chooseSavedSession, namedTerminalSessions, promptSessionAlias, queueSessionBrowser, shareSavedSession } from '../src/session-browser.js';
import { attachSession, viewSession, watchRegistry, changeSessionProvider } from '../src/runtime-client.js';
import { UI } from '../src/ui.js';
import { parseArgs } from '../src/cli.js';
import { appendEvent, events, listRecords } from '../src/database.js';
import { root } from '../src/process.js';
import { runtimeInfo, runtimeRequest } from '../src/runtime.js';
import { identityAlive } from '../src/recovery.js';

let directory, work, elsewhere, previous;
test.beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-sessions-'));
  work = path.join(directory, 'original-project'); elsewhere = path.join(directory, 'another-directory');
  fs.mkdirSync(work); fs.mkdirSync(elsewhere);
  const keys = ['BZZY_HOME', 'BZZY_CODEX_HOME', 'BZZY_CODEX_BIN', 'BZZY_TEST_LOG', 'BZZY_DIRECT'];
  previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { BZZY_HOME: path.join(directory, 'private'), BZZY_CODEX_HOME: path.join(directory, 'codex'),
    BZZY_CODEX_BIN: path.join(root, 'test/fixtures/codex.mjs'), BZZY_TEST_LOG: path.join(directory, 'backend.jsonl') });
  delete process.env.BZZY_DIRECT;
});
test.afterEach(async () => {
  const info = runtimeInfo();
  if (info && identityAlive(info.identity)) await runtimeRequest(info, 'POST', '/shutdown', {}).catch(() => {});
  for (let index = 0; index < 100 && info && identityAlive(info.identity); index++) await new Promise(resolve => setTimeout(resolve, 20));
  for (const [key, value] of Object.entries(previous)) if (value == null) delete process.env[key]; else process.env[key] = value;
  fs.rmSync(directory, { recursive: true, force: true });
});

test('right-click and F10 offer a named terminal menu without attaching, executing or losing the Sessions picker', async () => {
  const selected = createSession(BUILTINS.codex, work, null, 'Full context');
  const input = new PassThrough(); Object.assign(input, { isTTY: true, setRawMode() {} });
  const output = new PassThrough(); Object.assign(output, { isTTY: true, rows: 40, columns: 140 }); output.resume();
  const ui = new UI({ input, output, error: output }); ui.setSession(selected.id); ui.updateSession(selected);
  try {
    const answer = ui.ask('bzzy › '); await Promise.resolve(); ui.tui.value = 'unsent draft'; ui.tui.cursor = 12;
    ui.tui.render(); const alias = ui.tui.hitTargets.find(hit => hit.type === 'alias');
    ui.tui.mouse(2, alias.left, alias.row); ui.tui.render();
    assert.equal(ui.tui.selection.scope, 'session-menu'); assert.equal(ui.tui.inputQueue.length, 0);
    assert.equal(ui.tui.value, 'unsent draft'); assert.equal(listRecords('execution').length, 0);
    ui.tui.key('', { name: 'escape' }); assert.equal(ui.tui.selection == null, true);
    ui.tui.key('', { name: 'f10' }); ui.tui.render();
    const share = ui.tui.hitTargets.find(hit => hit.type === 'choice' && hit.index === 1);
    ui.tui.mouse(0, share.left, share.row);
    assert.equal(await answer, `/session-action share ${selected.id}`);
    assert.equal(ui.tui.history.some(item => item.startsWith('/session-action')), false);
    ui.ask = async prompt => {
      assert.match(prompt, /Type SHARE/);
      assert.match(ui.privateView.lines.join('\n'), /full chats.*memory.*evidence/);
      return null;
    };
    assert.equal(await ui.settingsCommand(`/session-action share ${selected.id}`), true);
    assert.equal(ui.privateView, undefined); assert.equal(listRecords('execution').length, 0);
    const picker = ui.chooseOne('Sessions', [{ value: selected.id, label: selected.alias }], { scope: 'sessions' });
    await Promise.resolve(); ui.tui.render(); const parent = ui.tui.selection;
    ui.tui.key('', { name: 'f10' }); ui.tui.render(); assert.equal(ui.tui.selection.scope, 'session-menu');
    ui.tui.mouse(0, 1, 1); assert.equal(ui.tui.selection, parent);
    ui.tui.key('', { name: 'f10' }); ui.tui.key('', { name: 'down' }); ui.tui.key('', { name: 'return' });
    assert.deepEqual(await picker, { value: selected.id, action: 'share' });
  } finally { ui.close(); }
});

test('sharing a saved terminal selects its original full-context source and rejects unnamed, internal or read-only sessions', async () => {
  const selected = createSession(BUILTINS.codex, work, null, 'Project');
  const unnamed = createSession(BUILTINS.codex, elsewhere);
  const child = createSession(BUILTINS.codex, work, null, 'Child'); child.parentSessionId = selected.id; saveSession(child);
  const before = events(selected.id), calls = [], ui = { sessionId: unnamed.id, sessionMode: 'CONTROL' };
  await shareSavedSession(ui, selected.id, { share: async (source, target) => { calls.push(source); assert.equal(target, ui); } });
  assert.equal(calls[0].id, selected.id); assert.equal(calls[0].cwd, work); assert.equal(ui.sessionId, unnamed.id);
  assert.deepEqual(events(selected.id), before); assert.equal(listRecords('execution').length, 0);
  for (const id of [unnamed.id, child.id, '00000000-0000-0000-0000-000000000000']) await assert.rejects(shareSavedSession(ui, id), /named terminal/);
  ui.sessionMode = 'VIEW'; await assert.rejects(shareSavedSession(ui, selected.id), /control/);
});

test('aliases identify the original session and its directory without changing its history', () => {
  const original = createSession(BUILTINS.codex, work, 'chosen-model', 'trabajo_01');
  appendEvent(original.id, 'text', { text: 'Previous findings', itemId: 'answer' });
  assert.equal(parseArgs(['--alias', ' trabajo_01 ']).options.alias, 'trabajo_01');
  for (const alias of ['', ' ', 'x'.repeat(81), 'bad\nname', 'bad\x1bname']) assert.throws(() => parseArgs([`--alias=${alias}`]));
  assert.equal(findSession('trabajo_01', elsewhere).id, original.id);
  assert.equal(findSession(original.id.slice(0, 8)).cwd, work);
  const renamed = setSessionAlias(original.id, 'trabajo_02');
  assert.equal(renamed.cwd, work); assert.equal(findSession('trabajo_02').id, original.id);
  assert.throws(() => findSession('trabajo_01'), /No matching/);
  assert.ok(events(original.id).some(event => event.type === 'text' && event.data.text === 'Previous findings'));
  assert.equal(JSON.parse(fs.readFileSync(sessionPath(original.id), 'utf8')).alias, 'trabajo_02');
  createSession(BUILTINS.codex, elsewhere, null, 'trabajo_02');
  assert.throws(() => findSession('trabajo_02'), /ambiguous/);
  assert.equal(findSession(original.id).cwd, work);
});

test('a runner saving an older snapshot cannot erase a new alias or its directory', () => {
  const stale = createSession(BUILTINS.codex, work, null, 'old-name');
  setSessionAlias(stale.id, 'new-name');
  stale.turns = 5; stale.executionState = 'running'; saveSession(stale);
  assert.equal(loadSession(stale.id).alias, 'new-name');
  assert.equal(loadSession(stale.id).turns, 5); assert.equal(loadSession(stale.id).cwd, work);
});

test('/alias prompts, supports an inline name, and cancels without renaming', async () => {
  const session = createSession(BUILTINS.codex, work);
  const ui = { event() {}, updateSession() {}, async ask(prompt) { assert.match(prompt, /Session alias/); return 'trabajo_01'; } };
  assert.equal((await promptSessionAlias(session.id, '', ui)).alias, 'trabajo_01');
  ui.ask = async () => { throw new Error('Inline aliases must not prompt'); };
  assert.equal((await promptSessionAlias(session.id, 'trabajo_02', ui)).alias, 'trabajo_02');
  ui.ask = async () => null;
  assert.equal((await promptSessionAlias(session.id, '', ui)).alias, 'trabajo_02');
  await assert.rejects(promptSessionAlias(session.id, 'denied', ui, () => { throw new Error('Input ownership changed'); }), /ownership/);
  assert.equal(loadSession(session.id).alias, 'trabajo_02');
});

test('session picker shows only aliases, excludes unnamed/internal sessions and opens the exact ID', async () => {
  const session = createSession(BUILTINS.codex, work, null, 'trabajo_01');
  createSession(BUILTINS.codex, work);
  const child = createSession(BUILTINS.codex, work, null, 'Hidden child'); child.parentSessionId = session.id; saveSession(child);
  const agent = createSession(BUILTINS.codex, work, null, 'Hidden Agent'); agent.purpose = 'agent'; saveSession(agent);
  let answer = session.id;
  const ui = { event() {}, async chooseOne(title, picker) {
    if (title === 'Open session?') return 'open';
    assert.equal(title, 'Sessions'); assert.deepEqual(picker.choices, [{ value: session.id, label: 'trabajo_01' }]);
    assert.equal(picker.shortcuts, undefined); return answer;
  } };
  assert.equal((await chooseSavedSession(ui)).action, 'attach');
  assert.equal((await chooseSavedSession(ui)).session.cwd, work);
  answer = null; assert.equal(await chooseSavedSession(ui), null);
  const duplicate = createSession(BUILTINS.codex, elsewhere, null, 'trabajo_01');
  ui.chooseOne = async (_title, picker) => {
    if (_title === 'Open session?') return 'open';
    assert.ok(picker.choices.every(item => item.label === 'trabajo_01'));
    assert.deepEqual(new Set(picker.choices.map(item => item.description)), new Set([work, elsewhere]));
    return duplicate.id;
  };
  assert.equal((await chooseSavedSession(ui)).session.id, duplicate.id);
});

test('named terminals sort newest saved activity first with creation fallback and deterministic ties', () => {
  const base = { cwd: work, provider: 'codex', alias: 'Only alias' };
  const row = (id, fields) => ({ ...base, id, ...fields });
  const source = [row('z', { updatedAt: '2026-10-23T01:00:00Z' }), row('a', { updatedAt: '2026-10-23T01:00:00Z' }),
    row('new', { updatedAt: Date.parse('2026-10-24T01:00:00Z') }), row('fallback', { updatedAt: 'invalid', createdAt: '2026-10-22T01:00:00Z' }),
    row('blank', { alias: '  ' }), row('missing', { alias: undefined }), row('coordinator', { purpose: 'assistant' }), row('child', { parentSessionId: 'a' })];
  assert.deepEqual(namedTerminalSessions(source).map(item => item.id), ['new', 'a', 'z', 'fallback']);
  assert.equal(source[0].id, 'z', 'sorting does not mutate the catalog');
});

function terminal() {
  const input = new PassThrough(); Object.assign(input, { isTTY: true, isRaw: false, setRawMode(value) { this.isRaw = value; } });
  const output = new PassThrough(); Object.assign(output, { isTTY: true, rows: 32, columns: 100 }); output.resume();
  const ui = new UI({ input, output, error: output }); ui.openTerminal();
  return ui;
}

test('a restored chat changes provider through the visible control and real Core lease without replaying work', { timeout: 15000 }, async () => {
  const saved = createSession(BUILTINS.codex, work, 'fixture-restored', 'Restored controls');
  appendEvent(saved.id, 'text', { itemId: 'saved', text: 'Retain this saved answer' });
  const ui = terminal(); let providerCalled = false, watching;
  const until = async check => {
    const deadline = Date.now() + 8000;
    while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(check(), 'restored-session control flow completed');
  };
  ui.onProvider = async (id, argument, connection) => {
    assert.equal(id, saved.id); assert.equal(argument, '@provider');
    assert.equal(ui.sessionMode, 'CONTROL', 'the normal input loop obtains Core ownership before mutation');
    const changed = await changeSessionProvider(loadSession(id), BUILTINS.claude,
      { model: 'fixture-provider-model', effort: 'default' }, ui, connection);
    providerCalled = true; return changed;
  };
  try {
    watching = attachSession(saved, { cwd: elsewhere }, ui);
    await until(() => ui.permissionConnection?.acquire && ui.tui.entries.some(entry => entry.text === 'Retain this saved answer') && ui.tui.resolveInput);
    assert.equal(ui.sessionMode, 'VIEW', 'opening alone leaves the input lease unclaimed');
    ui.tui.render();
    const provider = ui.tui.hitTargets.find(hit => hit.command === '/providers @provider');
    assert.ok(provider && !provider.disabled); ui.tui.mouse(0, provider.left, provider.row);
    await until(() => providerCalled);
    assert.equal(loadSession(saved.id).provider, 'claude'); assert.equal(loadSession(saved.id).cwd, work);
    assert.equal(loadSession(saved.id).model, 'fixture-provider-model');
    assert.equal(listRecords('execution').length, 0); assert.equal(fs.existsSync(process.env.BZZY_TEST_LOG), false);
    assert.ok(events(saved.id).some(event => event.data.text === 'Retain this saved answer'));
    ui.tui.localCommand('/exit'); assert.equal(await watching, 0);
  } finally { ui.reader?.close(); ui.close(); await watching; }
});
test('capture-network remains enabled for successive ordinary chat messages in an existing session', { timeout: 20000 }, async () => {
  const session = createSession(BUILTINS.codex, work, 'fixture-model', 'Capture follow-ups');
  let sent = 0, captures = 0;
  const waitForRuns = async count => {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      const rows = listRecords('execution', { sessionId: session.id });
      if (rows.length === count && rows.every(row => !['queued', 'launching', 'running'].includes(row.state))) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail('Fixture chat runs did not settle.');
  };
  const ui = { interactive: true, cursors: new Map(), setSession(id) { this.sessionId = id; }, updateSession() {}, clearHistory() {},
    event(type) { if (type === 'network.capture') captures++; },
    async ask() { if (sent) await waitForRuns(sent); if (sent === 2) return '/exit'; return 'Capture fixture message ' + (++sent); },
    async settingsCommand() { return false; } };
  assert.equal(await attachSession(session, { captureNetwork: true }, ui), 0);
  const executions = listRecords('execution', { sessionId: session.id });
  assert.equal(executions.length, 2); assert.ok(executions.every(row => row.options.captureNetwork === true));
  assert.ok(captures >= 2, 'both actual runners initialized the existing HTTP recorder');
  assert.equal(loadSession(session.id).cwd, work);
});

test('real arrow keys and Enter open the chosen alias without leaking directories into the picker', async () => {
  const original = createSession(BUILTINS.codex, work, null, 'First alias');
  const latest = createSession(BUILTINS.codex, elsewhere, null, 'Latest alias');
  const ui = terminal();
  try {
    const picking = chooseSavedSession(ui); await Promise.resolve();
    assert.deepEqual(ui.tui.selection.choices.map(item => item.label), namedTerminalSessions().map(item => item.alias));
    assert.ok(ui.tui.selection.choices.every(item => !item.description));
    ui.tui.key('', { name: 'down' }); ui.tui.key('', { name: 'return' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(ui.tui.selection.scope, 'session-open'); assert.equal(ui.tui.selection.choices[ui.tui.selection.focus].value, 'cancel');
    ui.tui.finishSelection('open');
    const selected = await picking;
    assert.equal(selected.session.id, namedTerminalSessions()[1].id);
    assert.equal(selected.session.cwd, selected.session.id === original.id ? work : elsewhere);
    assert.equal(ui.tui.panel, 'chat'); assert.equal(listRecords('execution').length, 0);
  } finally { ui.close(); }
});

test('Sessions navigation is local, queues once during a reply and never interrupts private input', async () => {
  const ui = terminal(); ui.setSession('saved-terminal');
  try {
    ui.onSessions = () => queueSessionBrowser(ui);
    const waiting = ui.ask('bzzy › '); await Promise.resolve();
    ui.tui.setPanel('sessions'); assert.equal(await waiting, '/sessions');
    queueSessionBrowser(ui); queueSessionBrowser(ui);
    assert.deepEqual(ui.tui.inputQueue, [{ sessionId: 'saved-terminal', text: '/sessions' }]);
    assert.equal(await ui.ask('bzzy › '), '/sessions');
    ui.privateView = { title: 'Private invitation' }; assert.equal(queueSessionBrowser(ui), false); ui.privateView = null;
    const privateInput = ui.ask('Source fingerprint: '); await Promise.resolve();
    assert.equal(queueSessionBrowser(ui), false); ui.tui.finish(null); await privateInput;
    assert.equal(listRecords('execution').length, 0);
  } finally { ui.close(); }
});

test('the top Open Sessions control deploys an anchored dropdown of aliased chats without losing the draft', async () => {
  const current = createSession(BUILTINS.codex, work, null, 'Current chat');
  createSession(BUILTINS.codex, elsewhere, null, 'Previous chat');
  const ui = terminal(); ui.setSession(current.id); ui.onSessions = () => queueSessionBrowser(ui);
  try {
    const waiting = ui.ask('bzzy › '); await Promise.resolve();
    ui.tui.value = 'Keep this draft'; ui.tui.cursor = 5; ui.tui.render();
    const open = ui.tui.hitTargets.find(hit => hit.type === 'top-sessions'); assert.ok(open);
    ui.tui.mouse(0, open.left, open.row);
    assert.equal(await waiting, '/sessions');
    assert.deepEqual(ui.tui.topSessionAnchor, { left: open.left, row: 1 });

    const choosing = chooseSavedSession(ui); await Promise.resolve(); ui.tui.render();
    assert.equal(ui.tui.selection.presentation, 'dropdown');
    assert.ok(ui.tui.popupRegion.top <= 3, 'the combobox stays attached to the top bar');
    assert.deepEqual(ui.tui.selection.choices.map(choice => choice.label), namedTerminalSessions().map(session => session.alias));
    ui.tui.key('', { name: 'escape' }); assert.equal(await choosing, null);
    assert.equal(ui.tui.value, 'Keep this draft'); assert.equal(ui.tui.cursor, 5);
  } finally { ui.close(); }
});

test('mouse/keyboard Sessions navigation preserves the unsent draft, history and event cursor on cancel', async () => {
  const session = createSession(BUILTINS.codex, work, null, 'Saved chat');
  const ui = terminal(); ui.setSession(session.id); ui.onSessions = () => queueSessionBrowser(ui);
  try {
    ui.event('text', { text: 'Visible previous answer', itemId: 'answer' }); ui.cursors.set(session.id, 73);
    const before = [...ui.tui.entries];
    const waiting = ui.ask('bzzy › '); await Promise.resolve();
    ui.tui.value = 'Keep this unsent thought'; ui.tui.cursor = 7;
    ui.tui.setPanel('http'); ui.tui.key('', { name: 'g', ctrl: true });
    assert.equal(await waiting, '/sessions');
    const choosing = chooseSavedSession(ui); await Promise.resolve();
    ui.tui.key('', { name: 'escape' }); assert.equal(await choosing, null);
    assert.equal(ui.tui.panel, 'chat'); assert.equal(ui.tui.value, 'Keep this unsent thought'); assert.equal(ui.tui.cursor, 7);
    assert.deepEqual(ui.tui.entries, before); assert.equal(ui.cursors.get(session.id), 73);
    assert.equal(ui.tui.inputQueue.length, 0); assert.equal(listRecords('execution').length, 0);
  } finally { ui.close(); }
});

test('queued Sessions navigation keeps separate drafts when the active group child changes', async () => {
  const session = createSession(BUILTINS.codex, work, null, 'Saved group'), ui = terminal();
  try {
    ui.setSession(session.id); ui.setTabs(session.id, [{ id: 'child-a', agent: 'A' }, { id: 'child-b', agent: 'B' }], 'child-a');
    ui.tui.value = 'Draft A'; ui.tui.cursor = 2; queueSessionBrowser(ui);
    ui.tui.drafts.set('child-b', { value: 'Draft B', cursor: 4 });
    ui.setTabs(session.id, [{ id: 'child-a', agent: 'A' }, { id: 'child-b', agent: 'B' }], 'child-b');
    const waiting = ui.ask('bzzy › '); await Promise.resolve(); queueSessionBrowser(ui); assert.equal(await waiting, '/sessions');
    const choosing = chooseSavedSession(ui); await Promise.resolve(); ui.tui.key('', { name: 'escape' }); await choosing;
    assert.equal(ui.tui.value, 'Draft B'); assert.equal(ui.tui.cursor, 4);
    assert.deepEqual(ui.sessionBrowserDrafts.get('child-a'), { value: 'Draft A', cursor: 2 });
    assert.deepEqual(ui.tui.inputQueue, [{ sessionId: 'child-a', text: '/sessions' }]);
  } finally { ui.close(); }
});

for (const mode of ['solo', 'parallel']) test(`/sessions opens existing ${mode} chat history in its original directory without resuming work`, { timeout: 15000 }, async () => {
  const source = createSession(BUILTINS.codex, elsewhere, null, 'Source'); source.mode = mode; saveSession(source);
  const target = createSession(BUILTINS.codex, work, 'saved-model', 'Target');
  target.goal = { status: 'paused', objective: 'Do not resume this goal' }; target.executionState = 'paused'; saveSession(target);
  appendEvent(target.id, 'message.user', { text: 'Original saved question' });
  appendEvent(target.id, 'text', { text: 'Original saved answer', itemId: 'saved-answer' });
  const inputs = ['/sessions', '/exit'], histories = [], selected = [];
  let history = [];
  const ui = { interactive: true, cursors: new Map([[target.id, 999]]),
    event(type, data) { history.push({ type, ...data }); },
    setSession(id) { this.sessionId = id; selected.push(id); }, updateSession() {},
    clearHistory() { history = []; histories.push(history); },
    async ask() { assert.ok(inputs.length, 'unexpected chat/model prompt'); return inputs.shift(); },
    async chooseOne(title) { return title === 'Open session?' ? 'open' : target.id; }, async settingsCommand() { return false; } };
  assert.equal(await attachSession(source, { cwd: elsewhere, mode: 'solo' }, ui), 0);
  assert.equal(ui.sessionId, target.id); assert.ok(selected.includes(source.id));
  assert.ok(history.some(item => item.type === 'message.user' && item.text === 'Original saved question'));
  assert.ok(history.some(item => item.type === 'text' && item.text === 'Original saved answer'));
  assert.equal(loadSession(target.id).cwd, work); assert.equal(loadSession(target.id).goal.status, 'paused');
  assert.equal(listRecords('execution').length, 0); assert.equal(sessions().length, 2);
  assert.ok(!fs.existsSync(process.env.BZZY_TEST_LOG), 'opening history never invokes a model');
});

for (const mode of ['view', 'activity']) test(`Sessions opens the selected chat from a read-only ${mode} screen`, { timeout: 15000 }, async () => {
  const source = createSession(BUILTINS.codex, elsewhere, null, 'Source');
  const target = createSession(BUILTINS.codex, work, null, 'Target');
  appendEvent(target.id, 'text', { text: 'Selected history', itemId: 'saved-answer' });
  const inputs = ['/sessions', '/exit'], rendered = [];
  const ui = { interactive: true, cursors: new Map(), event(type, data) { rendered.push({ type, ...data }); },
    setSession(id) { this.sessionId = id; }, updateSession() {}, clearHistory() { rendered.length = 0; },
    async ask() { assert.ok(inputs.length, 'unexpected input'); return inputs.shift(); },
    async chooseOne(title) { return title === 'Open session?' ? 'open' : target.id; }, async settingsCommand() { return false; } };
  assert.equal(await (mode === 'view' ? viewSession(source, {}, ui) : watchRegistry(source, {}, ui, 'activity')), 0);
  assert.equal(ui.sessionId, target.id); assert.ok(rendered.some(item => item.text === 'Selected history'));
  assert.equal(listRecords('execution').length, 0); assert.equal(sessions().length, 2);
});

for (const reopening of [false, true]) test(`opening a saved parallel target ${reopening ? 'again' : 'from another chat'} restores only its selected child history and draft`, { timeout: 15000 }, async () => {
  const source = createSession(BUILTINS.codex, elsewhere);
  const group = createSession(BUILTINS.codex, work, 'group-model', 'Saved parallel');
  group.mode = 'parallel'; group.goal = { id: 'saved-group-goal', status: 'paused', objective: 'Stay paused' }; saveSession(group);
  const children = [createSession(BUILTINS.codex, work, 'first-model'), createSession(BUILTINS.codex, work, 'second-model')];
  children.forEach((child, index) => {
    Object.assign(child, { parentSessionId: group.id, createdAt: `2026-10-2${index + 1}T00:00:00Z`, agentNamespace: `peer-${index}`, executionState: 'paused' });
    saveSession(child); appendEvent(child.id, 'text', { text: `Child ${index} saved answer`, itemId: `child-${index}-answer` });
  });
  appendEvent(group.id, 'text', { text: 'Parent overview answer must stay in overview', itemId: 'parent-answer' });
  const expected = children[reopening ? 1 : 0], ui = terminal();
  try {
    ui.setSession(reopening ? group.id : source.id);
    if (reopening) ui.setTabs(group.id, children.map(child => ({ id: child.id, agent: child.agentNamespace })), expected.id);
    ui.tui.value = reopening ? 'Current child draft' : 'Source draft'; ui.tui.cursor = 6;
    ui.tui.drafts.set(group.id, { value: 'Root draft must not become child draft', cursor: 3 });
    if (!reopening) ui.tui.drafts.set(expected.id, { value: 'Saved child draft', cursor: 4 });
    ui.event('text', { text: 'Old visible history must be cleared', itemId: 'old-answer' });
    children.forEach(child => ui.cursors.set(child.id, 999));
    ui.chooseOne = async title => title === 'Open session?' ? 'open' : group.id;
    const selected = await chooseSavedSession(ui); assert.equal(selected.session.id, group.id);
    ui.ask = async () => {
      assert.equal(ui.sessionId, group.id); assert.equal(ui.activeTab, expected.id);
      const history = ui.tui.entries.map(entry => entry.text || '').join('\n');
      assert.match(history, new RegExp(`Child ${reopening ? 1 : 0} saved answer`));
      assert.doesNotMatch(history, /Parent overview answer|Old visible history/);
      assert.ok(!history.includes(`Child ${reopening ? 0 : 1} saved answer`));
      assert.equal(ui.tui.value, reopening ? 'Current child draft' : 'Saved child draft');
      assert.equal(ui.tui.cursor, reopening ? 6 : 4);
      assert.equal(ui.tui.model, expected.model);
      return '/exit';
    };
    assert.equal(await attachSession(selected.session, { cwd: elsewhere }, ui), 0);
    assert.equal(ui.tui.drafts.get(group.id).value, 'Root draft must not become child draft');
    assert.equal(loadSession(group.id).goal.status, 'paused');
    assert.equal(listRecords('execution').length, 0); assert.ok(!fs.existsSync(process.env.BZZY_TEST_LOG));
  } finally { ui.close(); }
});

test('noninteractive sessions output includes the alias and saved directory', () => {
  const session = createSession(BUILTINS.codex, work, null, 'trabajo_01');
  const result = spawnSync(process.execPath, [path.join(root, 'bin/bzzy.js'), 'sessions', '--json'], { cwd: elsewhere, env: process.env, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  const item = result.stdout.trim().split('\n').map(JSON.parse).find(item => item.session?.id === session.id);
  assert.equal(item.session.alias, 'trabajo_01'); assert.equal(item.session.cwd, work);
  assert.equal(item.message, 'trabajo_01');
});

test('--alias persists on the direct task creation path, including request IDs', () => {
  const result = spawnSync(process.execPath, [path.join(root, 'bin/bzzy.js'), 'run', 'Hello', '--provider', 'codex', '--alias', 'trabajo_01', '--request-id', 'named-task', '--json', '--no-pet'],
    { cwd: work, env: { ...process.env, BZZY_DIRECT: '1' }, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const session = findSession('trabajo_01'); assert.equal(session.cwd, work);
  assert.equal(sessions().length, 1);
});

const ptyAvailable = process.platform === 'linux' && spawnSync('script', ['--version'], { stdio: 'ignore' }).status === 0;
for (const action of ['attach', 'view', 'new']) {
  test(`terminal ${action}: alias restores the project directory from another directory`, { skip: !ptyAvailable, timeout: 20000 }, async () => {
    let original;
    if (action !== 'new') {
      original = createSession(BUILTINS.codex, work, null, 'trabajo_01');
      appendEvent(original.id, 'text', { text: 'saved-history-marker', itemId: 'saved-answer' });
      const latest = createSession(BUILTINS.codex, elsewhere, null, 'another-session');
      // Keep the target below another row so the real terminal must navigate down.
      saveSession(latest);
      appendEvent(latest.id, 'text', { text: 'other-history-marker', itemId: 'other-answer' });
    }
    const command = [process.execPath, path.join(root, 'bin/bzzy.js'), ...(action === 'new' ? ['--provider', 'codex', '--alias', 'trabajo_01'] : action === 'view' ? ['--view', original.id] : ['sessions']), '--no-pet'];
    const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
    const child = spawn('script', ['-qefc', command.map(quote).join(' '), '/dev/null'], { cwd: action === 'new' ? work : elsewhere,
      env: { ...process.env, TERM: 'xterm-256color' }, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    const done = new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
    async function until(check) {
      for (let attempt = 0; attempt < 500; attempt++) {
        if (check()) return; assert.equal(child.exitCode, null, output.slice(-2500));
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error('Missing terminal state: ' + output.slice(-2500));
    }
    try {
      if (action !== 'new') {
        if (action === 'attach') {
          await until(() => output.includes('Sessions') && output.includes('another-session') && output.includes('trabajo_01'));
          child.stdin.write('\x1b[B\r');
          await until(() => output.includes('Open session?'));
          child.stdin.write('\x1b[A\r');
        }
        await until(() => output.includes('saved-history-marker'));
        assert.ok(!output.includes('other-history-marker'));
      } else await until(() => output.includes('What should BZZY work on?'));
      if (action === 'attach' || action === 'new') {
        child.stdin.write('/alias\r');
        await until(() => output.includes('Session alias [trabajo_01]'));
        child.stdin.write('renamed-project\r');
        await until(() => output.includes('Session alias: renamed-project'));
        if (action === 'attach') {
          child.stdin.write('/export shared-project.zip\r');
          await until(() => output.includes('Exported:') && fs.existsSync(path.join(work, 'shared-project.zip')));
          child.stdin.write('Hello from another directory\r');
          await until(() => output.includes('First pass.'));
        }
      } else {
        child.stdin.write('/alias denied\r');
        await until(() => output.includes('read-only view'));
      }
      child.stdin.write('/exit\r'); assert.equal(await done, 0, output.slice(-2500));
      const session = findSession(action === 'view' ? 'trabajo_01' : 'renamed-project');
      assert.equal(session.cwd, work);
      if (original) assert.equal(session.id, original.id);
      if (action === 'attach') {
        const execution = listRecords('execution').find(job => job.sessionId === session.id);
        assert.equal(execution.options.cwd, work);
        const log = fs.readFileSync(process.env.BZZY_TEST_LOG, 'utf8').trim().split('\n').map(JSON.parse);
        assert.ok(log.some(item => item.method === 'thread/start' && item.params.cwd === work));
      }
      if (action === 'view') assert.equal(listRecords('execution').length, 0, 'view never executes the session');
    } finally {
      if (child.exitCode == null) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
      await done.catch(() => {});
    }
  });
}
