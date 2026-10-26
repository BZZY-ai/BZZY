import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { UI } from '../src/ui.js';
import { libraryEntryMenu, prepareLibraryRemoval, removeLibraryEntry } from '../src/library-entry-menu.js';
import { createSession, loadSession, saveSession } from '@bzzy/core/engine/store.js';
import { newGoal } from '@bzzy/core/engine/goals.js';
import { listRecords } from '@bzzy/core/engine/database.js';
import { createSkill, inspectSkill, setSkillEnabled } from '@bzzy/core/engine/skills.js';
import { saveSubagentDefinition, getSubagentDefinition, getSubagentDefinitionVersion } from '@bzzy/core/engine/subagent-definitions.js';
import { saveWorkflow, getWorkflow, selectWorkflow, workflowSelection } from '@bzzy/core/engine/workflows.js';
import { saveGoalTemplate, goalTemplateEntry, listGoalTemplates, deleteGoalTemplate } from '@bzzy/core/engine/goal-templates.js';

let directory, previous, ui, session;
test.beforeEach(() => {
  previous = process.env.BZZY_HOME; directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-entry-menu-')));
  process.env.BZZY_HOME = path.join(directory, 'private');
  session = createSession({ id: 'codex', backend: 'codex' }, directory, 'offline-model', 'Saved terminal');
  session.goal = { ...newGoal('Retain the achieved goal'), status: 'complete', evidence: ['retained-evidence'] }; saveSession(session);
  const input = new PassThrough(); Object.assign(input, { isTTY: true, setRawMode() {} });
  const output = new PassThrough(); Object.assign(output, { isTTY: true, columns: 90, rows: 38 }); output.resume();
  ui = new UI({ input, output, error: output }); ui.setSession(session.id); ui.updateSession(session);
  ui.tui.value = 'Preserve the unsent draft'; ui.tui.cursor = 5;
});
test.afterEach(() => {
  ui.close(); if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
  fs.rmSync(directory, { recursive: true, force: true });
});
const tick = () => new Promise(setImmediate);

test('right-click and F10 remove all four Library entry types after confirmation, retaining scopes, drafts and execution history', { timeout: 8000 }, async () => {
  const skill = createSkill({ name: 'response-check', description: 'Inspect synthetic responses.', instructions: 'Review supplied evidence.' }, { scope: 'global' });
  const projectSkill = createSkill({ name: 'response-check', description: 'Keep the project version.', instructions: 'Keep this independent definition.' }, { scope: 'project', projectRoot: directory });
  const agent = saveSubagentDefinition({ name: 'response-agent', description: 'Review supplied evidence.', instructions: 'Keep evidence attribution.' }, { scope: 'global', cwd: directory });
  const workflow = saveWorkflow({ name: 'response-process', instructions: 'Read supplied evidence.' }, { scope: 'global', cwd: directory });
  selectWorkflow(session.id, workflow.name, { scope: 'global', expectedRevision: 0 });
  const goal = saveGoalTemplate({ objective: 'A manually saved objective' });
  const beforeGoal = loadSession(session.id).goal;
  for (const [kind, command, id] of [['skill', '/skills', projectSkill.id], ['agent', '/agents', agent.id],
    ['workflow', '/workflow library', workflow.id], ['goal', '/saved-goals', 'template:' + goal.id]]) {
    await ui.settingsCommand(command); const input = ui.ask('bzzy › '); await tick(); ui.tui.render();
    const action = ui.tui.libraryMenus.actions.find(value => ui.tui.libraryMenus.menus.get(value)?.entry.id === id);
    const key = { skill: 'skill', agent: 'agent', workflow: 'workflow', goal: 'goal' }[kind];
    ui.tui[key + 'Focus'] = ui.tui.libraryMenus.actions.indexOf(action); ui.tui.render();
    ui.tui.key('', { name: 'f10' }); assert.equal(ui.tui.selection.scope, 'library-entry-menu');
    ui.tui.key('', { name: 'escape' }); assert.equal(ui.tui.selection, null);
    ui.tui.render(); const target = ui.tui.hitTargets.find(hit => hit.libraryMenu?.entry.id === id); assert.ok(target);
    ui.tui.mouse(2, target.left, target.row); assert.equal(ui.tui.selection.scope, 'library-entry-menu');
    ui.tui.selection.focus = 1; ui.tui.key('', { name: 'return' });
    const removal = await input; assert.match(removal, /^\/library remove-entry [a-f0-9-]{36}$/);
    const pending = ui.settingsCommand(removal); await tick();
    assert.equal(ui.tui.selection.scope, 'library-removal'); assert.equal(ui.tui.selection.focus, 0);
    assert.equal(ui.tui.selection.choices[0].value, 'cancel');
    ui.tui.key('', { name: 'down' }); ui.tui.key('', { name: 'return' }); await pending;
    if (kind === 'skill') { assert.throws(() => inspectSkill(projectSkill.id)); assert.equal(inspectSkill(skill.id, { scope: 'global' }).id, skill.id); }
    if (kind === 'agent') { assert.throws(() => getSubagentDefinition(agent.name, { scope: 'global' })); assert.equal(getSubagentDefinitionVersion(agent.id, agent.version).version, agent.version); }
    if (kind === 'workflow') { assert.throws(() => getWorkflow(workflow.name, { scope: 'global' })); assert.equal(workflowSelection(session.id).available, false); }
    if (kind === 'goal') assert.equal(listGoalTemplates().total, 0);
    assert.deepEqual(loadSession(session.id).goal, beforeGoal); assert.equal(listRecords('execution').length, 0);
    assert.equal(ui.tui.value, 'Preserve the unsent draft'); assert.equal(ui.tui.cursor, 5); assert.equal(ui.tui.history.length, 0);
  }
});

test('Cancel, Escape and an unknown removal request never delete or start work', async () => {
  const skill = createSkill({ name: 'keep-skill', description: 'Retain synthetic evidence.', instructions: 'Keep this definition.' }, { scope: 'global' });
  await ui.settingsCommand('/skills'); ui.tui.render();
  const menu = ui.tui.hitTargets.find(hit => hit.libraryMenu?.entry.id === skill.id).libraryMenu;
  const id = prepareLibraryRemoval(ui, menu); const pending = removeLibraryEntry(ui, id); await tick();
  ui.tui.key('', { name: 'escape' }); assert.equal(await pending, false);
  assert.equal(inspectSkill(skill.id).id, skill.id);
  await assert.rejects(removeLibraryEntry(ui, id), /changed|Reopen/);
  assert.equal(listRecords('execution').length, 0);
});

test('changed revisions, replacement goals, conversations and private hosts invalidate pending removal', async () => {
  const skill = createSkill({ name: 'changing-skill', description: 'Retain controls.', instructions: 'Keep this definition.' }, { scope: 'global' });
  ui.tui.setPanel('skills');
  let menu = libraryEntryMenu(ui, 'skill', skill);
  let id = prepareLibraryRemoval(ui, menu);
  ui.chooseOne = async () => { setSkillEnabled(skill.id, true, skill.revision, { scope: 'global' }); return 'remove'; };
  await assert.rejects(removeLibraryEntry(ui, id), /changed/i); assert.equal(inspectSkill(skill.id).enabled, true);
  const record = saveGoalTemplate({ objective: 'Keep the replacement objective' }), entry = goalTemplateEntry(record);
  ui.tui.setPanel('goals'); menu = libraryEntryMenu(ui, 'goal', entry); id = prepareLibraryRemoval(ui, menu);
  ui.chooseOne = async () => { deleteGoalTemplate(entry.id, { revision: entry.revision }); saveGoalTemplate({ objective: entry.objective }); return 'remove'; };
  await assert.rejects(removeLibraryEntry(ui, id), /changed/); assert.equal(listGoalTemplates().total, 1);
  const current = listGoalTemplates().goals[0]; menu = libraryEntryMenu(ui, 'goal', current); id = prepareLibraryRemoval(ui, menu);
  ui.chooseOne = async () => { ui.activeTab = 'different-conversation'; return 'remove'; };
  await assert.rejects(removeLibraryEntry(ui, id), /changed/); delete ui.activeTab;
  menu = libraryEntryMenu(ui, 'goal', current); id = prepareLibraryRemoval(ui, menu);
  const originalHome = process.env.BZZY_HOME;
  ui.chooseOne = async () => { process.env.BZZY_HOME = path.join(directory, 'other-private'); return 'remove'; };
  try { await assert.rejects(removeLibraryEntry(ui, id), /changed/); assert.equal(fs.existsSync(path.join(process.env.BZZY_HOME, 'bzzy.sqlite')), false); }
  finally { process.env.BZZY_HOME = originalHome; }
  assert.equal(listGoalTemplates().total, 1); assert.equal(listRecords('execution').length, 0);
});
