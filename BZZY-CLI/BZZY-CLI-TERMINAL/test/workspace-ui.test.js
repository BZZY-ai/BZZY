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
import { codexSkillDirectories, skillsCommand, skillRows } from '../src/skills-ui.js';
import { syncCodexSkills } from '@bzzy/core/engine/skill-sync.js';
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

test('Skills sync imports from Codex into the shared library and stays idle until explicit enable', async () => {
 const { ui, session } = terminal(), source = path.join(directory, '.agents', 'skills', 'synced-ui-skill');
 fs.mkdirSync(path.join(directory, '.git'), { recursive: true }); fs.mkdirSync(source, { recursive: true });
 fs.writeFileSync(path.join(source, 'SKILL.md'), '---\nname: synced-ui-skill\ndescription: Review a UI across selected models.\n---\nInspect and verify the layout.\n');
 try {
  ui.tui.cwd = directory;
  const before = listRecords('execution').length;
  assert.ok(skillRows(ui).some(row => row.segments?.some(segment => segment.action === 'tab:import')));
  assert.ok(skillRows(ui).some(row => row.text.includes('THIS CHAT / PROJECT')));
  await skillsCommand('/skills sync', ui, { sync: input => syncCodexSkills({ ...input, userHome: path.join(directory, 'empty-home'), codexHome: null, bzzyCodexHome: null, adminRoot: path.join(directory, 'empty-admin') }) });
  assert.equal(ui.skillSyncResult.imported, 1); assert.equal(inspectSkill('synced-ui-skill').enabled, false);
  assert.equal(listRecords('execution').length, before); assert.equal(ui.sessionId, session.id);
  ui.chooseOne = async () => 'enable'; await skillsCommand('/skills toggle:synced-ui-skill', ui);
  assert.equal(inspectSkill('synced-ui-skill').enabled, true);
  assert.ok(skillRows(ui).some(row => row.text.includes('Codex → BZZY')));
  await skillsCommand('/skills tab:library', ui);
  assert.ok(skillRows(ui).some(row => row.text.includes('synced-ui-skill')));
 } finally { ui.close(); }
});

test('Codex skill sync preserves SKILL.md and optional scripts, references, assets and agents metadata', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-codex-skill-package-'));
  const codexHome = path.join(root, '.codex'), skill = path.join(codexHome, 'skills', 'package-layout');
  try {
    for (const folder of ['scripts', 'references', 'assets', 'agents']) fs.mkdirSync(path.join(skill, folder), { recursive: true });
    fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: package-layout\ndescription: Verify Codex-compatible skill package structure.\n---\n\nRead the bundled references before acting.\n');
    fs.writeFileSync(path.join(skill, 'scripts', 'run.sh'), '#!/bin/sh\nexit 0\n');
    fs.writeFileSync(path.join(skill, 'references', 'guide.md'), '# Guide\n');
    fs.writeFileSync(path.join(skill, 'assets', 'template.txt'), 'template\n');
    fs.writeFileSync(path.join(skill, 'agents', 'openai.yaml'), 'interface:\n  display_name: Package Layout\n');
    const result = syncCodexSkills({ cwd: root, codexHome, userHome: path.join(root, 'user'),
      bzzyCodexHome: null, adminRoot: path.join(root, 'admin') });
    assert.equal(result.imported, 1, JSON.stringify(result));
    const imported = inspectSkill('package-layout');
    assert.deepEqual(imported.files.map(file => file.path), [
      'SKILL.md', 'agents/openai.yaml', 'assets/template.txt', 'references/guide.md', 'scripts/run.sh',
    ]);
    assert.equal(imported.enabled, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Codex directory import lists every skill, shows checkboxes, and imports only selected packages', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-codex-skill-picker-'));
  const skillsRoot = path.join(root, 'skills');
  try {
    for (const name of ['picker-alpha', 'picker-beta', 'picker_under_score']) {
      fs.mkdirSync(path.join(skillsRoot, name), { recursive: true });
      fs.writeFileSync(path.join(skillsRoot, name, 'SKILL.md'),
        `---\nname: ${name}\ndescription: Fixture ${name} for selective Codex import.\n---\n\nFollow ${name}.\n`);
    }
    for (const folder of ['scripts', 'references', 'agents']) fs.mkdirSync(path.join(skillsRoot, 'picker_under_score', folder));
    fs.writeFileSync(path.join(skillsRoot, 'picker_under_score', 'scripts', 'tool.sh'), '#!/bin/sh\nexit 0\n');
    fs.writeFileSync(path.join(skillsRoot, 'picker_under_score', 'references', 'guide.md'), '# Guide\n');
    fs.writeFileSync(path.join(skillsRoot, 'picker_under_score', 'agents', 'openai.yaml'), 'interface:\n  display_name: Picker Under Score\n');
    const found = codexSkillDirectories(skillsRoot);
    assert.deepEqual(found.candidates.map(item => item.name).sort(), ['picker-alpha', 'picker-beta', 'picker_under_score'].sort());

    const { ui } = terminal();
    try {
      ui.tui.value = 'Keep my chat draft'; ui.tui.cursor = 4;
      await skillsCommand('/skills tab:import', ui);
      ui.tui.value = skillsRoot; ui.tui.cursor = skillsRoot.length;
      await skillsCommand('/skills save-directory', ui); ui.tui.render();
      const frame = ui.tui.lastFrame.map(clean).join('\n');
      assert.match(frame, /3 skills found/); assert.match(frame, /Save directory.*Refresh/);
      assert.match(frame, /\[ \] picker-alpha/); assert.match(frame, /\[ \] picker-beta/);
      assert.match(frame, /\[ \] picker_under_score/);
      assert.doesNotMatch(frame, /Fixture picker|SKILL\s+IMPORT NAME/);
      assert.match(frame, /Import selected/);
      await skillsCommand('/skills codex-toggle:0', ui);
      await skillsCommand('/skills codex-toggle:2', ui);
      ui.tui.render(); assert.match(ui.tui.lastFrame.map(clean).join('\n'), /Import selected · 2/);
      await skillsCommand('/skills codex-import', ui);
      assert.equal(ui.skillSyncResult.imported, 2); assert.equal(ui.skillSyncResult.unchanged, 0);
      assert.equal(inspectSkill('picker-alpha').enabled, false);
      assert.throws(() => inspectSkill('picker-beta'), /not found/i);
      assert.equal(inspectSkill('picker-under-score').enabled, false);
      assert.deepEqual(inspectSkill('picker-under-score').files.map(file => file.path),
        ['SKILL.md', 'agents/openai.yaml', 'references/guide.md', 'scripts/tool.sh']);
      await skillsCommand('/skills tab:library', ui);
      const library = skillRows(ui).map(row => row.text).join('\n');
      assert.match(library, /THIS CHAT \/ PROJECT/); assert.match(library, /BZZY CORE \/ GLOBAL/);
      assert.match(library, /picker-alpha[\s\S]*picker-under-score/);
      assert.doesNotMatch(library, /Fixture picker/);
      ui.tui.key('', { name: 'escape' });
      assert.equal(ui.tui.value, 'Keep my chat draft');
      assert.equal(listRecords('execution').length, 0);
    } finally { ui.close(); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('empty first chat exposes bottom model/effort controls and preserves unsent text', async () => {
 const { ui, output, session } = terminal();
 try {
  assert.equal(session.modelSelectionRequired, true); assert.equal(session.model, null);
  for (const columns of [80, 120]) {
   output.columns = columns; ui.tui.render();
   const controls = ui.tui.hitTargets.filter(hit => hit.type === 'model-control');
   for (const command of ['/providers', '/models @effort']) assert.ok(controls.some(hit => hit.command === command));
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
  assert.match(ui.tui.lastFrame.map(clean).join('\n'), /IMPORT.*LIBRARY/);
  assert.match(ui.tui.lastFrame.map(clean).join('\n'), /THIS CHAT \/ PROJECT.*BZZY CORE \/ GLOBAL/s);
  await ui.settingsCommand('/skills view:' + skill.name); ui.tui.render();
  assert.match(ui.tui.lastFrame.map(clean).join('\n'), /Back to library[\s\S]*Inspect the layout[\s\S]*Skill · Esc goes back/);
  assert.equal(skillRows(ui)[0].action, 'library');
  ui.tui.key('', { name: 'escape' });
  assert.equal(ui.skillPreview, null); assert.equal(ui.tui.panel, 'skills');
  ui.tui.render(); assert.match(ui.tui.lastFrame.map(clean).join('\n'), /ui-check/);
  ui.tui.key('', { name: 'escape' }); assert.equal(ui.tui.panel, 'chat');
  await ui.settingsCommand('/skills library'); ui.chooseOne = async () => 'enable';
  await ui.settingsCommand('/skills toggle:' + skill.name); assert.equal(inspectSkill(skill.name).enabled, true);
  assert.equal(listRecords('execution').length, 0);
 } finally { ui.close(); }
});
