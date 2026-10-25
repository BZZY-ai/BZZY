import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { UI } from '../src/ui.js';
import { skillRows } from '../src/skills-ui.js';
import { importSkill, inspectSkill } from '@bzzy/core/engine/skills.js';
import { createSession } from '@bzzy/core/engine/store.js';
import { getProvider } from '@bzzy/core/engine/providers.js';
import { getRecord, listRecords } from '@bzzy/core/engine/database.js';
import { clean } from '../src/terminal-format.js';

let root, previous, project, source, session, skill, ui, input;
test.beforeEach(() => {
  previous = process.env.BZZY_HOME; root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-move-ui-')));
  process.env.BZZY_HOME = path.join(root, 'private'); project = path.join(root, 'project'); source = path.join(root, 'codex-source'); fs.mkdirSync(project);
  fs.mkdirSync(path.join(source, 'references'), { recursive: true }); fs.mkdirSync(path.join(source, 'assets'));
  fs.writeFileSync(path.join(source, 'SKILL.md'), '---\nname: movable-workflow\ndescription: Review controlled inputs.\n---\nCompare controls and preserve uncertainty.\n');
  fs.writeFileSync(path.join(source, 'references', 'method.md'), 'Read the original controlled sample.'); fs.writeFileSync(path.join(source, 'assets', 'sample.bin'), Buffer.from([0, 255, 1]));
  skill = importSkill(source, { projectRoot: project, scope: 'project' }); session = createSession(getProvider('codex'), project, 'current-model', 'Move review');
  input = new PassThrough(); Object.assign(input, { isTTY: true, setRawMode() {} });
  const output = new PassThrough(); Object.assign(output, { isTTY: true, columns: 100, rows: 34 }); output.resume();
  ui = new UI({ input, output, error: output }); ui.setSession(session.id); ui.updateSession(session); ui.tui.value = 'an unsent chat draft'; ui.tui.cursor = 5;
});
test.afterEach(() => { ui.close(); if (previous == null) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous; fs.rmSync(root, { recursive: true, force: true }); });
const command = action => ui.settingsCommand('/skills ' + action);
function clickBack() { ui.tui.render(); const hit = ui.tui.hitTargets.find(hit => hit.type === 'back'); assert.ok(hit); input.write(`\x1b[<0;${hit.left};${hit.row}M`); }

test('project detail offers a concrete package move review and preserves every resource disabled in Core', async () => {
  await command('view:' + skill.id);
  assert.ok(skillRows(ui).some(row => row.text === 'Move to BZZY Core' && row.action === 'move-global:' + skill.id));
  await command('move-global:' + skill.id); ui.tui.render();
  const frame = ui.tui.lastFrame.map(clean).join('\n');
  assert.match(frame, /THIS CHAT \/ PROJECT → BZZY CORE \/ GLOBAL/); assert.match(frame, /references\/method.md/); assert.match(frame, /assets\/sample.bin/);
  assert.equal(getRecord('core.skill', skill.name), null); assert.equal(inspectSkill(skill.id, { projectRoot: project }).revision, skill.revision);
  const inspect = command('move-files'); await new Promise(resolve => setImmediate(resolve)); ui.tui.render();
  const index = ui.tui.selection.choices.findIndex(choice => choice.value === 'references/method.md'); ui.tui.selection.focus = index; input.write('\r'); await inspect;
  assert.match(ui.skillMoveDraft.filePreview.text, /original controlled sample/);
  clickBack(); assert.equal(ui.skillMoveDraft.filePreview, null); assert.ok(ui.skillMoveDraft.review);
  await command('move-confirm');
  const global = inspectSkill(skill.name, { scope: 'global' }); assert.equal(global.enabled, false); assert.equal(global.files.length, 3);
  assert.equal(getRecord('core.skill', skill.id), null); assert.equal(fs.existsSync(source), true); assert.equal(ui.skillPreview.scope, 'global');
  assert.ok(skillRows(ui).some(row => row.text === 'Enable for all models'));
  assert.equal(listRecords('execution').length, 0); assert.equal(listRecords('run').length, 0);
  clickBack(); clickBack(); assert.equal(ui.tui.panel, 'chat'); assert.equal(ui.tui.value, 'an unsent chat draft'); assert.equal(ui.tui.cursor, 5);
});

test('Back and file-picker cancellation leave the project skill and draft unchanged', async () => {
  await command('move-global:' + skill.id); const draft = ui.skillMoveDraft.review;
  const picker = command('move-files'); await new Promise(resolve => setImmediate(resolve)); ui.tui.render();
  const back = ui.tui.hitTargets.find(hit => hit.type === 'cancel'); input.write(`\x1b[<0;${back.left};${back.row}M`); await picker;
  assert.deepEqual(ui.skillMoveDraft.review, draft); assert.equal(ui.skillMoveDraft.filePreview, undefined);
  clickBack(); assert.equal(ui.skillMoveDraft, null); assert.equal(ui.tui.panel, 'skills');
  assert.equal(inspectSkill(skill.id, { projectRoot: project }).revision, skill.revision); assert.equal(getRecord('core.skill', skill.name), null);
  clickBack(); assert.equal(ui.tui.value, 'an unsent chat draft'); assert.equal(ui.tui.cursor, 5);
});

test('changed project or host rejects a pending move without publishing into another scope', async () => {
  await command('move-global:' + skill.id); const errors = [];
  const event = ui.event.bind(ui); ui.event = (type, data) => { if (type === 'error') errors.push(data.message); return event(type, data); };
  const other = path.join(root, 'other'); fs.mkdirSync(other); ui.tui.cwd = other;
  await command('move-confirm'); assert.match(errors.at(-1), /changed/); assert.equal(getRecord('core.skill', skill.name), null);
  ui.tui.cwd = project; await command('move-global:' + skill.id);
  const prior = process.env.BZZY_HOME; process.env.BZZY_HOME = path.join(root, 'other-private');
  await command('move-confirm'); process.env.BZZY_HOME = prior;
  assert.equal(getRecord('core.skill', skill.name), null); assert.equal(inspectSkill(skill.id, { projectRoot: project }).revision, skill.revision);
});
