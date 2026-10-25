import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { UI } from '../src/ui.js';
import { clean, cellWidth } from '../src/terminal-format.js';
import { skillsCommand, skillRows } from '../src/skills-ui.js';
import { subagentsCommand, subagentRows } from '../src/subagents-ui.js';
import { createChatSession } from '@bzzy/core/engine/host-commands.js';
import { getProvider } from '@bzzy/core/engine/providers.js';
import { createSkill, inspectSkill, setSkillEnabled } from '@bzzy/core/engine/skills.js';
import { saveSubagentDefinition, getSubagentDefinition, setSubagentEnabled } from '@bzzy/core/engine/subagent-definitions.js';
import { listRecords } from '@bzzy/core/engine/database.js';

let directory, previous, ui, session, output, dispatched, notices;
const definition = name => ({ name, description: 'Inspect supplied response evidence.', instructions: 'Stay in the original scope and cite inspected evidence.' });
const actions = rows => rows.flatMap(row => row.segments ? row.segments.filter(item => item.action).map(item => item.action) : row.action ? [row.action] : []);
const rowFor = (rows, name, scope) => rows.find(row => row.toggleAction && row.text.includes(name) && row.text.endsWith(' · ' + scope));
test.beforeEach(() => {
  previous = process.env.BZZY_HOME;
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-library-toggle-')));
  process.env.BZZY_HOME = path.join(directory, 'private');
  const input = new PassThrough(); input.isTTY = true; input.setRawMode = () => {};
  output = new PassThrough(); Object.assign(output, { isTTY: true, rows: 24, columns: 80 }); output.resume();
  ui = new UI({ input, output, error: output });
  session = createChatSession(getProvider('codex'), { cwd: directory, model: 'offline-fixture', effort: 'default' });
  ui.setSession(session.id); ui.updateSession(session);
  dispatched = []; ui.tui.localCommand = command => dispatched.push(command);
  notices = []; const original = ui.event.bind(ui);
  ui.event = (type, data) => { notices.push({ type, ...data }); original(type, data); };
  ui.tui.value = 'Retain my draft'; ui.tui.cursor = 5;
});
test.afterEach(() => {
  ui.close();
  if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
  fs.rmSync(directory, { recursive: true, force: true });
});
const skillCommand = action => skillsCommand('/skills ' + action, ui);
const agentCommand = action => subagentsCommand('/agents ' + action, ui);

test('both libraries keep visible switches and scope beside long names at wide and narrow terminal sizes', async () => {
  const name = 'response-analysis-specialist-with-a-long-but-valid-name';
  createSkill(definition(name), { session }); createSkill(definition('core-method'), { scope: 'global' });
  saveSubagentDefinition(definition(name), { cwd: directory }); saveSubagentDefinition(definition('core-agent'), { scope: 'global' });
  for (const columns of [40, 80, 140]) {
    output.columns = columns;
    for (const [command, rows, panel] of [[skillCommand, skillRows, 'skills'], [agentCommand, subagentRows, 'agents']]) {
      await command('library');
      const entries = rows(ui).filter(row => row.toggleAction); assert.equal(entries.length, 2);
      for (const row of entries) {
        const visible = row.segments.map(item => item.text).join('');
        assert.match(visible, /^  \[(?: ON |OFF )\]/);
        assert.match(visible, / · (?:project|global)$/);
        assert.ok(cellWidth(visible) <= columns - 1);
        assert.equal(row.segments.filter(item => item.action).length, 2);
      }
      ui.tui.render();
      assert.ok(ui.tui.lastFrame.every(line => cellWidth(clean(line)) <= columns - 1));
      assert.ok(ui.tui.hitTargets.some(hit => hit.type === (panel === 'skills' ? 'skill-action' : 'agent-action') && hit.action.startsWith('toggle-row:')));
    }
  }
  assert.equal(listRecords('execution').length, 0); assert.equal(listRecords('assignment').length, 0);
});

test('clicking a skill switch toggles directly, clicking its name only opens it, and Space works on either cell', async () => {
  const skill = createSkill(definition('response-method'), { session });
  await skillCommand('library'); ui.tui.render();
  const toggle = ui.tui.hitTargets.find(hit => hit.type === 'skill-action' && hit.action.startsWith('toggle-row:'));
  ui.tui.mouse(0, toggle.left, toggle.row);
  assert.match(dispatched[0], /^\/skills toggle-row:/);
  ui.chooseOne = async () => assert.fail('A Library switch does not need an additional enable prompt.');
  await ui.settingsCommand(dispatched.shift());
  assert.equal(inspectSkill(skill.id, { session }).enabled, true);
  await skillCommand('library'); ui.tui.render();
  const view = ui.tui.hitTargets.find(hit => hit.type === 'skill-action' && hit.action === 'view:' + skill.id);
  ui.tui.mouse(0, view.left, view.row); assert.equal(dispatched[0], '/skills view:' + skill.id);
  await ui.settingsCommand(dispatched.shift());
  assert.equal(ui.skillPreview.id, skill.id); assert.equal(inspectSkill(skill.id, { session }).enabled, true);
  await skillCommand('library');
  ui.tui.skillFocus = actions(skillRows(ui)).indexOf('view:' + skill.id);
  ui.tui.key(' ', { name: 'space' });
  await ui.settingsCommand(dispatched.shift());
  assert.equal(inspectSkill(skill.id, { session }).enabled, false);
  assert.equal(ui.tui.value, 'Retain my draft'); assert.equal(ui.tui.cursor, 5);
  assert.equal(listRecords('execution').length, 0);
});

test('agent switches are scoped, keyboard-accessible and leave OFF entries inspectable without a Use action', async () => {
  const local = saveSubagentDefinition(definition('response-agent'), { cwd: directory });
  saveSubagentDefinition(definition('response-agent'), { scope: 'global' });
  await agentCommand('library');
  const rows = subagentRows(ui), selected = rowFor(rows, local.name, 'project');
  ui.tui.agentFocus = actions(rows).indexOf(selected.toggleAction); ui.tui.render();
  ui.tui.key('', { name: 'right' }); assert.equal(actions(rows)[ui.tui.agentFocus], 'view:project:response-agent');
  ui.tui.key(' ', { name: 'space' }); await ui.settingsCommand(dispatched.shift());
  assert.equal(getSubagentDefinition(local.name, { cwd: directory, scope: 'project' }).enabled, false);
  assert.equal(getSubagentDefinition(local.name, { scope: 'global' }).enabled, true);
  await agentCommand('view:project:response-agent');
  assert.match(subagentRows(ui).map(row => row.text).join('\n'), /OFF · unavailable/);
  assert.ok(!subagentRows(ui).some(row => row.action === 'use'));
  ui.ask = async () => assert.fail('An OFF specialist must not open an invocation prompt.');
  await agentCommand('use'); assert.ok(notices.some(item => item.type === 'error' && /Turn.*ON/.test(item.message)));
  await agentCommand('toggle'); assert.equal(ui.subagentPreview.enabled, true);
  assert.equal(ui.tui.value, 'Retain my draft'); assert.equal(ui.tui.cursor, 5);
  assert.equal(listRecords('assignment').length, 0); assert.equal(listRecords('execution').length, 0);
});

test('stale displayed availability cannot flip a newer skill or specialist state', async () => {
  const skill = createSkill(definition('stale-method'), { session });
  await skillCommand('library'); const oldSkillAction = rowFor(skillRows(ui), skill.name, 'project').toggleAction;
  setSkillEnabled(skill.id, true, skill.revision, { session });
  await skillCommand(oldSkillAction); assert.equal(inspectSkill(skill.id, { session }).enabled, true);
  assert.ok(notices.some(item => item.type === 'error' && /changed/.test(item.message)));
  const agent = saveSubagentDefinition(definition('stale-agent'), { cwd: directory });
  await agentCommand('library'); const oldAgentAction = rowFor(subagentRows(ui), agent.name, 'project').toggleAction;
  setSubagentEnabled(agent.name, false, { cwd: directory, scope: 'project', expectedRevision: agent.revision });
  await agentCommand(oldAgentAction); assert.equal(getSubagentDefinition(agent.name, { cwd: directory }).enabled, false);
});

test('switch commands from a previous conversation are rejected and import-directory spaces stay editable', async () => {
  const skill = createSkill(definition('core-method'), { scope: 'global' });
  const agent = saveSubagentDefinition(definition('core-agent'), { scope: 'global' });
  await skillCommand('library'); const skillAction = rowFor(skillRows(ui), skill.name, 'global').toggleAction;
  await agentCommand('library'); const agentAction = rowFor(subagentRows(ui), agent.name, 'global').toggleAction;
  const other = path.join(directory, 'other'); fs.mkdirSync(other);
  const conversation = createChatSession(getProvider('codex'), { cwd: other, model: 'offline-fixture', effort: 'default' });
  ui.setSession(conversation.id); ui.updateSession(conversation);
  await skillCommand(skillAction); await agentCommand(agentAction);
  assert.equal(inspectSkill(skill.id, { scope: 'global' }).enabled, false);
  assert.equal(getSubagentDefinition(agent.name, { scope: 'global' }).enabled, true);
  assert.ok(notices.filter(item => item.type === 'error').length >= 2);
  await skillCommand('tab:import'); ui.tui.value = '/private/tmp/folder'; ui.tui.cursor = [...ui.tui.value].length;
  dispatched.length = 0; ui.tui.key(' ', { name: 'space' });
  assert.equal(dispatched.length, 0); assert.equal(ui.tui.value, '/private/tmp/folder ');
});
