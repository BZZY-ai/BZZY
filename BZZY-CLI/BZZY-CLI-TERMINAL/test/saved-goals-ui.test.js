import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { UI } from '../src/ui.js';
import { chooseSavedGoal, openGoals, goalRows, goalAction } from '../src/saved-goals-ui.js';
import { createSession, loadSession, saveSession } from '@bzzy/core/engine/store.js';
import { saveGoalTemplate, goalTemplateEntry } from '@bzzy/core/engine/goal-templates.js';
import { newGoal } from '@bzzy/core/engine/goals.js';
import { getRecord, putRecord, listRecords, database } from '@bzzy/core/engine/database.js';
import { clean, cellWidth } from '../src/terminal-format.js';

let directory, previous, target, ui, notices;
const pick = offered => offered.choices.find(choice => !['back', 'older', 'newer', 'import', 'export'].includes(choice.value)).value;
const provider = { id: 'codex', backend: 'codex' };
function saved(objective, createdAt = '2026-10-01T00:00:00.000Z', extra = {}) {
  const session = createSession(provider, directory, 'offline-model', extra.alias);
  session.goal = { ...newGoal(objective), createdAt };
  Object.assign(session, extra); saveSession(session);
  const template = saveGoalTemplate({ objective });
  putRecord('core.goal.template', template.id, { ...template, createdAt });
  session.template = goalTemplateEntry({ ...template, createdAt });
  return session;
}
function state() {
  const db = database();
  return { records: db.prepare('SELECT * FROM records ORDER BY kind,id').all(),
    events: db.prepare('SELECT * FROM events ORDER BY seq').all(),
    requests: db.prepare('SELECT * FROM requests ORDER BY scope,id').all() };
}
test.beforeEach(() => {
  previous = process.env.BZZY_HOME;
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-saved-goals-ui-')));
  process.env.BZZY_HOME = path.join(directory, 'private');
  target = createSession(provider, directory, 'offline-model'); notices = [];
  ui = { sessionId: target.id, openTerminal() {}, event(type, data) { notices.push({ type, ...data }); },
    tui: { value: 'Unsent draft', cursor: 4, notice() {} } };
});
test.afterEach(() => {
  ui.close?.();
  if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
  fs.rmSync(directory, { recursive: true, force: true });
});

test('empty saved goals offer Import without changing durable state', async () => {
  const before = state();
  ui.chooseOne = (_title, offered) => {
    assert.match(offered.description, /No saved goals.*Goals tab/);
    assert.equal(offered.choices.find(row => row.value === 'import').disabled, undefined);
    assert.equal(offered.choices.find(row => row.value === 'export').disabled, true);
    return null;
  };
  assert.equal(await chooseSavedGoal(ui), null);
  assert.deepEqual(state(), before);
});

test('reuse returns the complete objective as data, including reserved controls and multiline text', async () => {
  const full = ('Review the complete HTTP response\nKeep newlines, Unicode 你🐝 and /goal cancel as text.\n' + 'A long requirement. '.repeat(200)).trim();
  for (const objective of ['resume', full]) {
    const source = saved(objective);
    const before = state();
    ui.chooseOne = async (title, offered, options) => {
      assert.equal(title, 'Saved goals'); assert.equal(options.scope, 'saved-goals');
      assert.equal(offered.choices[0].value, 'back'); assert.equal(offered.choices[0].selected, true);
      assert.match(offered.description, /NEW goal/);
      const choice = offered.choices.find(row => row.value === source.template.id);
      assert.ok(choice.description.endsWith(objective));
      assert.equal(choice.value, source.template.id);
      return choice.value;
    };
    const result = await chooseSavedGoal(ui);
    assert.equal(result.objective, objective); assert.equal(result.goalId, null);
    assert.equal(result.sessionId, null); assert.deepEqual(state(), before);
    assert.equal(ui.tui.value, 'Unsent draft'); assert.equal(ui.tui.cursor, 4);
  }
});

test('Back, Escape and invalid picker values cannot submit or mutate goals', async () => {
  saved('Inspect the supplied local fixture'); const before = state();
  for (const value of [null, 'back']) {
    ui.chooseOne = async () => value;
    assert.equal(await chooseSavedGoal(ui), null);
  }
  ui.chooseOne = async () => `${randomUUID()}:${randomUUID()}`;
  await assert.rejects(chooseSavedGoal(ui), /current list/);
  assert.deepEqual(state(), before);
});

test('pages expose every saved goal in recent order and support Older and Newer navigation', async () => {
  for (let index = 0; index < 43; index++) saved(`Goal ${index}`, new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString());
  const pages = [], before = state();
  ui.chooseOne = async (_title, offered) => {
    const goals = offered.choices.filter(row => !['back', 'older', 'newer', 'import', 'export'].includes(row.value));
    pages.push(goals.map(row => row.label));
    if (pages.length <= 2) return 'older';
    if (pages.length === 3) return 'newer';
    return goals.at(-1).value;
  };
  const result = await chooseSavedGoal(ui);
  assert.deepEqual(pages.map(page => page.length), [20, 20, 3, 20]);
  assert.equal(pages[0][0], 'Goal 42'); assert.equal(pages[2].at(-1), 'Goal 0');
  assert.equal(result.objective, 'Goal 3'); assert.deepEqual(state(), before);
});

test('picker pins its host, visible conversation and target directory across an await', async () => {
  const source = saved('A saved objective'), originalHome = process.env.BZZY_HOME;
  const neighbor = createSession(provider, directory, 'offline-model');
  const cases = [
    () => { ui.sessionId = neighbor.id; },
    () => { ui.activeTab = neighbor.id; },
    () => { ui.nextSession = neighbor; },
    () => { ui.coreLifecycleInterrupted = true; },
    () => { const current = loadSession(target.id); current.cwd = path.join(directory, 'elsewhere'); saveSession(current); },
    () => { process.env.BZZY_HOME = path.join(directory, 'other-private'); },
  ];
  for (const mutate of cases) {
    process.env.BZZY_HOME = originalHome; ui.sessionId = target.id; delete ui.activeTab;
    delete ui.nextSession; delete ui.coreLifecycleInterrupted;
    const current = loadSession(target.id); current.cwd = directory; saveSession(current);
    ui.chooseOne = async (_title, offered) => { const selected = pick(offered); mutate(); return selected; };
    await assert.rejects(chooseSavedGoal(ui), /terminal|host/i);
  }
  process.env.BZZY_HOME = originalHome;
  assert.equal(fs.existsSync(path.join(directory, 'other-private/bzzy.sqlite')), false, 'a host switch must be rejected before reading another host');
  assert.equal(loadSession(source.id).goal.objective, 'A saved objective');
  assert.equal(listRecords('execution').length, 0);
});

test('saved templates survive changes to source execution history while template and target changes invalidate choices', async () => {
  const source = saved('Keep the exact original objective');
  ui.chooseOne = async (_title, offered) => {
    const chosen = pick(offered); source.goal.objective = 'A later execution'; source.goal.status = 'paused'; saveSession(source);
    putRecord('session-deletion', source.id, { id: source.id }); return chosen;
  };
  assert.equal((await chooseSavedGoal(ui)).objective, 'Keep the exact original objective');
  const record = getRecord('core.goal.template', source.template.id.slice(9));
  ui.chooseOne = async (_title, offered) => {
    const chosen = pick(offered); putRecord('core.goal.template', record.id, { ...record, objective: 'Unreviewed edit' }); return chosen;
  };
  await assert.rejects(chooseSavedGoal(ui), /changed/i);
  putRecord('core.goal.template', record.id, record);
  ui.chooseOne = async (_title, offered) => { const chosen = pick(offered); putRecord('session-deletion', target.id, { id: target.id }); return chosen; };
  await assert.rejects(chooseSavedGoal(ui), /root terminal/i);
  assert.equal(listRecords('execution').length, 0);
});

test('worker and Agent targets, including orphan metadata, are rejected; an explicit group root may be used while its child tab is visible', async () => {
  saved('A reusable objective');
  const worker = createSession(provider, directory, 'offline-model'); worker.parentSessionId = target.id; saveSession(worker);
  const agent = createSession(provider, directory, 'offline-model'); agent.purpose = 'agent'; saveSession(agent);
  for (const session of [worker, agent]) await assert.rejects(chooseSavedGoal(ui, { sessionId: session.id }), /root terminal/);
  ui.chooseOne = () => assert.fail('A nonterminal target cannot open the saved-goal picker');
  for (const metadata of [{ role: 'peer' }, { assignmentId: randomUUID() }, { canvasParentId: randomUUID() }]) {
    const orphan = createSession(provider, directory, 'offline-model'); Object.assign(orphan, metadata); saveSession(orphan);
    await assert.rejects(chooseSavedGoal(ui, { sessionId: orphan.id }), /root terminal/);
  }
  ui.activeTab = worker.id; ui.chooseOne = async (_title, offered) => pick(offered);
  const selected = await chooseSavedGoal(ui, { sessionId: target.id });
  assert.equal(selected.objective, 'A reusable objective'); assert.equal(ui.activeTab, worker.id);
  assert.equal(listRecords('execution').length, 0);
});

function actualTerminal(columns, rows, minimal) {
  const input = new PassThrough(); Object.assign(input, { isTTY: true, setRawMode() {} });
  const output = new PassThrough(); Object.assign(output, { isTTY: true, columns, rows }); output.resume();
  const terminal = new UI({ input, output, error: output, minimal });
  terminal.setSession(target.id); terminal.updateSession(target);
  terminal.tui.value = 'Keep the unsent draft 你🐝'; terminal.tui.cursor = 7;
  return terminal;
}

test('actual saved-goal popup supports keyboard reuse, clickable Back and Escape across terminal sizes', { timeout: 5000 }, async () => {
  const objective = ('Review this response 你🐝\nRetain every requirement. ' + 'Long requirement. '.repeat(20)).trim();
  saved(objective, undefined, { alias: 'HTTP checks' });
  const before = state();
  for (const minimal of [false, true]) for (const [columns, rows] of [[60, 18], [80, 24], [120, 36]]) {
    const terminal = actualTerminal(columns, rows, minimal), tui = terminal.tui;
    try {
      let result = chooseSavedGoal(terminal); await Promise.resolve(); tui.render();
      assert.ok(tui.popupRegion.top >= 1 && tui.popupRegion.bottom <= rows);
      assert.ok(tui.popupRegion.left >= 1 && tui.popupRegion.right < columns);
      assert.ok(tui.lastFrame.every(line => cellWidth(line) <= columns - 1));
      assert.match(tui.lastFrame.map(clean).join('\n'), /Saved goals/);
      for (let index = 0; index < 3; index++) tui.key('', { name: 'down' });
      tui.key('', { name: 'return' });
      assert.equal((await result).objective, objective);
      result = chooseSavedGoal(terminal); await Promise.resolve(); tui.render();
      const back = tui.hitTargets.find(hit => hit.type === 'cancel' && hit.back); assert.ok(back);
      tui.mouse(0, back.left, back.row); assert.equal(await result, null);
      result = chooseSavedGoal(terminal); await Promise.resolve(); tui.key('', { name: 'escape' });
      assert.equal(await result, null);
      assert.equal(tui.value, 'Keep the unsent draft 你🐝'); assert.equal(tui.cursor, 7);
      assert.equal(tui.history.length, 0); assert.equal(tui.inputQueue.length, 0);
    } finally { terminal.close(); }
  }
  assert.deepEqual(state(), before);
});


test('saved-goal Import is available when empty, refreshes the list, and never starts work', async () => {
  const calls = []; let step = 0;
  ui.chooseOne = async (_title, offered) => {
    if (!step++) { assert.ok(offered.choices.some(row => row.value === 'import')); return 'import'; }
    assert.ok(offered.choices.some(row => row.label === 'Imported goal fixture')); return 'back';
  };
  await chooseSavedGoal(ui, { transfer: async (operation, kind, cwd, screen) => {
    calls.push([operation, kind, cwd, screen === ui]);
    const { saveGoalTemplate } = await import('@bzzy/core/engine/goal-templates.js');
    saveGoalTemplate({ objective: 'Imported goal fixture' });
  } });
  assert.deepEqual(calls, [['import', 'goal', directory, true]]);
  assert.equal(loadSession(target.id).goal, null); assert.equal(listRecords('execution').length, 0);
  assert.equal(ui.tui.value, 'Unsent draft'); assert.equal(ui.tui.cursor, 4);
});

test('saved-goal Export uses the original project and a context switch cancels a pending transfer', async () => {
  saved('A reusable supplied objective');
  let step = 0, called = 0;
  ui.chooseOne = async () => step++ ? 'back' : 'export';
  assert.equal(await chooseSavedGoal(ui, { transfer: async (operation, kind, cwd) => {
    assert.deepEqual([operation, kind, cwd], ['export', 'goal', directory]); called++;
  } }), null);
  assert.equal(called, 1); assert.equal(listRecords('execution').length, 0);
  ui.chooseOne = async () => 'import';
  await assert.rejects(chooseSavedGoal(ui, { transfer: async () => { ui.sessionId = randomUUID(); } }), /terminal or host changed/);
});


test('Goals tab saves only explicitly entered or confirmed current objectives and cancelling cannot save', async () => {
  ui.tui.setPanel = panel => { ui.tui.panel = panel; }; ui.tui.schedule = () => {};
  target.goal = newGoal('Current objective remains execution history'); saveSession(target);
  openGoals(ui);
  assert.equal(ui.tui.panel, 'goals'); assert.ok(goalRows(ui).some(row => row.action === 'save-current'));
  assert.ok(goalRows(ui).some(row => /No manually saved/.test(row.text)));
  ui.ask = async (_prompt, options) => { assert.equal(options.initialValue, ''); return 'A manually saved objective'; };
  await goalAction('save', ui);
  ui.ask = async (_prompt, options) => { assert.equal(options.initialValue, target.goal.objective); return null; };
  await goalAction('save-current', ui);
  let rows = goalRows(ui); assert.equal(rows.filter(row => row.action?.startsWith('view:')).length, 1);
  ui.ask = async (_prompt, options) => options.initialValue;
  await goalAction('save-current', ui); await goalAction('save-current', ui);
  rows = goalRows(ui); assert.equal(rows.filter(row => row.action?.startsWith('view:')).length, 2);
  await goalAction(rows.find(row => row.action?.startsWith('view:')).action, ui);
  assert.ok(ui.goalPreview.objective); assert.equal(goalRows(ui)[0].action, 'back');
  await goalAction('back', ui); assert.equal(ui.goalPreview, null);
  await goalAction('close', ui); assert.equal(ui.tui.panel, 'chat');
  assert.equal(loadSession(target.id).goal.id, target.goal.id); assert.equal(listRecords('execution').length, 0);
  assert.equal(ui.tui.value, 'Unsent draft'); assert.equal(ui.tui.cursor, 4);
});

test('Goals tab rejects a save when the conversation changes while editing', async () => {
  ui.tui.setPanel = panel => { ui.tui.panel = panel; }; ui.tui.schedule = () => {};
  openGoals(ui); ui.ask = async () => { ui.sessionId = randomUUID(); return 'Do not save in a different context'; };
  await goalAction('save', ui);
  assert.equal(listRecords('core.goal.template').length, 0);
  assert.ok(notices.some(row => row.type === 'error' && /terminal or host changed/.test(row.message)));
});

test('actual top tabs, goal editing, preview Back and Escape preserve chat drafts without model work', { timeout: 5000 }, async () => {
  const terminal = actualTerminal(90, 32, false); const tui = terminal.tui;
  try {
    for (const [type, expected, panel] of [['top-workflows', '/workflow library', 'workflows'], ['top-goals', '/saved-goals', 'goals']]) {
      const pending = terminal.ask('bzzy › '); await Promise.resolve(); tui.render();
      const hit = tui.hitTargets.find(row => row.type === type); assert.ok(hit); tui.mouse(0, hit.left, hit.row);
      const command = await pending; assert.equal(command, expected); await terminal.settingsCommand(command);
      assert.equal(tui.panel, panel); tui.key('', { name: 'escape' }); assert.equal(tui.panel, 'chat');
    }
    await terminal.settingsCommand('/saved-goals');
    let pending = terminal.ask('bzzy › '); await Promise.resolve(); tui.render();
    const hit = tui.hitTargets.find(row => row.type === 'goal-action' && row.action === 'save'); assert.ok(hit);
    tui.mouse(0, hit.left, hit.row); const command = await pending;
    pending = terminal.settingsCommand(command); await new Promise(setImmediate); tui.render();
    assert.ok(tui.promptDraft); assert.ok(tui.hitTargets.some(row => row.type === 'confirm'));
    tui.value = 'Explicitly saved through the Goals tab'; tui.cursor = tui.value.length; tui.key('', { name: 'return' });
    await pending; tui.render();
    pending = terminal.ask('bzzy › '); await Promise.resolve(); tui.render();
    const entry = tui.hitTargets.find(row => row.type === 'goal-action' && row.action.startsWith('view:')); assert.ok(entry);
    tui.mouse(0, entry.left, entry.row); await terminal.settingsCommand(await pending);
    assert.equal(terminal.goalPreview.objective, 'Explicitly saved through the Goals tab');
    tui.key('', { name: 'escape' }); assert.equal(terminal.goalPreview, null); assert.equal(tui.panel, 'goals');
    tui.key('', { name: 'escape' }); assert.equal(tui.panel, 'chat');
    assert.equal(tui.value, 'Keep the unsent draft 你🐝'); assert.equal(tui.cursor, 7);
    assert.equal(tui.history.length, 0); assert.equal(tui.inputQueue.length, 0);
    assert.equal(listRecords('execution').length, 0);
  } finally { terminal.close(); }
});


test('Goals paging and focus reveal each page from its top and damaged templates leave Back available', async () => {
  for (let index = 0; index < 23; index++) saved(`Explicit goal ${index}`);
  const terminal = actualTerminal(80, 24, false), tui = terminal.tui;
  try {
    openGoals(terminal); tui.render();
    assert.ok(tui.hitTargets.some(row => row.type === 'goal-action' && row.action === 'save'));
    for (let index = 0; index < 24; index++) { tui.key('', { name: 'down' }); tui.render(); }
    await goalAction('next', terminal); tui.render();
    assert.equal(terminal.goalOffset, 20);
    assert.ok(tui.hitTargets.some(row => row.type === 'goal-action' && row.action === 'close'));
    assert.equal(goalRows(terminal).filter(row => row.action?.startsWith('view:')).length, 3);
    const template = listRecords('core.goal.template')[0];
    putRecord('core.goal.template', template.id, { ...template, objective: 'Damaged objective' });
    terminal.goalOffset = 0; terminal.goalPreview = null;
    assert.ok(goalRows(terminal).some(row => row.action === 'close'));
  } finally { terminal.close(); }
});
