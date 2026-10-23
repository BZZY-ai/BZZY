import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { UI } from '../src/ui.js';
import { clean, cellWidth } from '../src/terminal-format.js';
import { createChatSession } from '@bzzy/core/engine/host-commands.js';
import { getProvider } from '../src/providers.js';
import { createSkill, inspectSkill } from '@bzzy/core/engine/skills.js';
import { listRecords } from '../src/database.js';
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-workspace-ui-')), previous = process.env.BZZY_HOME;
process.env.BZZY_HOME = path.join(directory, 'private');
test.after(() => { if (previous == null) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous; fs.rmSync(directory, { recursive: true, force: true }); });
function terminal() {
 const input = new PassThrough(); input.isTTY = true; input.setRawMode = () => {};
 const output = new PassThrough(); Object.assign(output, { isTTY: true, rows: 36, columns: 120 }); output.resume();
 const ui = new UI({ input, output, error: output });
 const session = createChatSession(getProvider('codex'), { cwd: directory, modelSelectionRequired: true });
 ui.setSession(session.id); ui.updateSession({ ...session, alias: 'COOL' });
 return { ui, output, session };
}
test('empty first chat exposes model/effort/Save clicks and preserves unsent text', async () => {
 const { ui, output, session } = terminal();
 try {
  assert.equal(session.modelSelectionRequired, true); assert.equal(session.model, null);
  for (const columns of [80, 120]) {
   output.columns = columns; ui.tui.render();
   const controls = ui.tui.hitTargets.filter(hit => hit.type === 'model-control');
   for (const command of ['/providers', '/models @effort', '/default']) assert.ok(controls.some(hit => hit.command === command));
   assert.ok(ui.tui.lastFrame.every(line => cellWidth(line) <= columns - 1));
  }
  const answer = ui.ask('bzzy › '); await Promise.resolve(); ui.tui.key('unsent draft', {}); ui.tui.render();
  const target = ui.tui.hitTargets.find(hit => hit.command === '/providers'); ui.tui.mouse(0, target.left, target.row);
  assert.equal(await answer, '/providers'); assert.equal(ui.tui.value, 'unsent draft');
  assert.equal(listRecords('execution').length, 0);
 } finally { ui.close(); }
});
test('double clicking the alias edits inline through the authorized alias command', async () => {
 const { ui } = terminal();
 try {
  const answer = ui.ask('bzzy › '); await Promise.resolve(); ui.tui.key('draft', {}); ui.tui.render();
  const hit = ui.tui.hitTargets.find(hit => hit.type === 'alias');
  ui.tui.mouse(0, hit.left, hit.row); ui.tui.mouse(0, hit.left, hit.row);
  for (let index = 0; index < 4; index++) ui.tui.key('', { name: 'backspace' });
  ui.tui.key('Renamed', {}); ui.tui.key('', { name: 'return' });
  assert.equal(await answer, '/alias Renamed'); assert.equal(ui.tui.value, 'draft');
 } finally { ui.close(); }
});
test('the shared skills view reads instructions and explicitly enables a disabled import without inference', async () => {
 const skill = createSkill({ name: 'ui-check', description: 'Review a UI.', instructions: 'Inspect the layout and verify it at two terminal sizes.' });
 const { ui } = terminal();
 try {
  await ui.settingsCommand('/skills'); ui.tui.render();
  assert.match(ui.tui.lastFrame.map(clean).join('\n'), /Import folder or ZIP/);
  await ui.settingsCommand('/skills view:' + skill.name); ui.tui.render();
  assert.match(ui.tui.lastFrame.map(clean).join('\n'), /Inspect the layout/);
  await ui.settingsCommand('/skills library'); ui.chooseOne = async () => 'enable';
  await ui.settingsCommand('/skills toggle:' + skill.name); assert.equal(inspectSkill(skill.name).enabled, true);
  assert.equal(listRecords('execution').length, 0);
 } finally { ui.close(); }
});
