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
import { skillsCommand, skillRows } from '../src/skills-ui.js';
import { libraryActions } from '../src/library-layout.js';
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
 return { ui, input, output, session };
}

test('Skills sync opens the Codex table, imports a checked project skill, and stays idle until explicit enable', async () => {
 const { ui, session } = terminal(), source = path.join(directory, '.agents', 'skills', 'synced-ui-skill');
 fs.mkdirSync(path.join(directory, '.git'), { recursive: true }); fs.mkdirSync(source, { recursive: true });
 fs.writeFileSync(path.join(source, 'SKILL.md'), '---\nname: synced-ui-skill\ndescription: Review a UI across selected models.\n---\nInspect and verify the layout.\n');
 try {
  ui.tui.cwd = directory;
  ui.codexSkillDiscovery = { userHome: path.join(directory, 'empty-home'), codexHome: null, bzzyCodexHome: null, adminRoot: path.join(directory, 'empty-admin') };
  const before = listRecords('execution').length;
  assert.ok(skillRows(ui).some(row => row.action === 'bundle-import-type' && row.text === 'Import'));
  assert.ok(skillRows(ui).some(row => row.action === 'codex' && row.text === 'Codex import' && row.buttonGroup));
  assert.ok(skillRows(ui).some(row => row.text.includes('THIS CHAT / PROJECT')));
  await skillsCommand('/skills sync', ui);
  assert.equal(ui.skillView, 'codex');
  const item = ui.codexScan.items.find(entry => entry.name === 'synced-ui-skill');
  assert.equal(item.status, 'new'); assert.equal(item.label, 'this project'); assert.equal(item.target, 'project');
  await skillsCommand('/skills codex-toggle:' + item.sourceId, ui);
  await skillsCommand('/skills codex-import', ui);
  assert.equal(ui.skillSyncResult.imported, 1);
  const imported = inspectSkill('synced-ui-skill', { session }); assert.equal(imported.enabled, false); assert.equal(imported.scope, 'project');
  assert.equal(ui.codexScan.items.find(entry => entry.name === 'synced-ui-skill').status, 'unchanged');
  assert.equal(listRecords('execution').length, before); assert.equal(ui.sessionId, session.id);
  await skillsCommand('/skills library', ui);
  ui.chooseOne = async () => 'enable'; await skillsCommand('/skills toggle:' + imported.id, ui);
  assert.equal(inspectSkill(imported.id, { session }).enabled, true);
  assert.ok(skillRows(ui).some(row => row.text.includes('Codex → BZZY')));
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

test('Codex import lists every local Codex skill in a checkbox table and imports only checked packages', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-codex-skill-picker-')));
  const codexHome = path.join(root, '.codex'), skillsRoot = path.join(codexHome, 'skills');
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
    fs.mkdirSync(path.join(skillsRoot, '.system', 'picker-system'), { recursive: true });
    fs.writeFileSync(path.join(skillsRoot, '.system', 'picker-system', 'SKILL.md'), '---\nname: picker-system\ndescription: Built-in fixture.\n---\nFollow it.\n');
    fs.mkdirSync(path.join(skillsRoot, 'picker-broken')); fs.writeFileSync(path.join(skillsRoot, 'picker-broken', 'SKILL.md'), 'no metadata');
    fs.mkdirSync(path.join(root, 'elsewhere', 'picker-linked'), { recursive: true }); fs.writeFileSync(path.join(root, 'elsewhere', 'picker-linked', 'SKILL.md'), '---\nname: picker-linked\ndescription: Linked fixture.\n---\nFollow it.\n');
    fs.symlinkSync(path.join(root, 'elsewhere', 'picker-linked'), path.join(skillsRoot, 'picker-linked'));

    const { ui } = terminal();
    try {
      ui.codexSkillDiscovery = { cwd: root, userHome: path.join(root, 'home'), codexHome, bzzyCodexHome: null, adminRoot: path.join(root, 'admin') };
      ui.tui.value = 'Keep my chat draft'; ui.tui.cursor = 4;
      await skillsCommand('/skills codex', ui); ui.tui.render();
      let frame = ui.tui.lastFrame.map(clean).join('\n');
      assert.match(frame, /IMPORT SKILLS FROM CODEX/);
      assert.match(frame, /5 Codex skills · 4 ready · 1 can't import/);
      assert.match(frame, /SKILL\s+FROM\s+STATUS/);
      assert.match(frame, /\[ \] picker-alpha\s+\$CODEX_HOME\s+new/);
      assert.match(frame, /\[ \] picker-system\s+Codex system\s+new/);
      assert.match(frame, /\[ \] picker-under-score\s+\$CODEX_HOME\s+new/);
      assert.match(frame, /\[-\] picker-broken\s+\$CODEX_HOME\s+invalid/);
      assert.match(frame, /Import checked · 0[\s\S]*Select all[\s\S]*Select none[\s\S]*Rescan[\s\S]*Other folder/);
      assert.match(frame, /1 folder skipped \(linked folders are not followed\)/); assert.doesNotMatch(frame, /picker-linked/);
      assert.match(frame, /hyphens in BZZY: my_skill → my-skill/); assert.match(frame, /Imports start OFF; Codex folders stay untouched\./);
      assert.doesNotMatch(frame, /Fixture picker/); assert.equal(frame.includes(root), false, 'absolute source paths stay out of the view');
      assert.ok(ui.tui.lastFrame.every(line => cellWidth(clean(line)) <= 119));

      // Space on the focused row checks it; the cursor stays on that row.
      const byName = name => ui.codexScan.items.find(item => item.name === name);
      const actions = libraryActions(skillRows(ui)), alphaAction = 'codex-toggle:' + byName('picker-alpha').sourceId;
      assert.equal(actions.some(action => action.endsWith(byName('picker-broken').sourceId)), false, 'invalid rows cannot be checked');
      ui.tui.skillFocus = actions.indexOf(alphaAction); ui.tui.key(' ', { name: 'space' });
      const queued = ui.tui.inputQueue.shift(); assert.equal(queued.text, '/skills ' + alphaAction);
      await skillsCommand(queued.text, ui); assert.equal(ui.tui.skillFocus, actions.indexOf(alphaAction));
      await skillsCommand('/skills codex-toggle:' + byName('picker-under-score').sourceId, ui);
      ui.tui.render(); frame = ui.tui.lastFrame.map(clean).join('\n');
      assert.match(frame, /Import checked · 2/); assert.match(frame, /\[x\] picker-alpha/); assert.match(frame, /\[ \] picker-beta/);
      await skillsCommand('/skills codex-all', ui); assert.equal(ui.codexSelected.size, 4);
      await skillsCommand('/skills codex-none', ui); assert.equal(ui.codexSelected.size, 0);
      await skillsCommand('/skills codex-import', ui); assert.equal(ui.codexMessage, 'Check at least one skill to import.');
      for (const name of ['picker-alpha', 'picker-under-score']) await skillsCommand('/skills codex-toggle:' + byName(name).sourceId, ui);
      await skillsCommand('/skills codex-import', ui);
      assert.equal(ui.skillSyncResult.imported, 2); assert.equal(ui.skillSyncResult.results.length, 2);
      assert.equal(inspectSkill('picker-alpha').enabled, false);
      assert.throws(() => inspectSkill('picker-beta'), /not found/i);
      assert.equal(inspectSkill('picker-under-score').enabled, false);
      assert.deepEqual(inspectSkill('picker-under-score').files.map(file => file.path),
        ['SKILL.md', 'agents/openai.yaml', 'references/guide.md', 'scripts/tool.sh']);
      assert.match(fs.readFileSync(path.join(skillsRoot, 'picker_under_score', 'SKILL.md'), 'utf8'), /name: picker_under_score/);
      ui.tui.render(); frame = ui.tui.lastFrame.map(clean).join('\n');
      assert.match(frame, /Codex → BZZY · 2 imported/);
      assert.match(frame, /\[-\] picker-alpha\s+\$CODEX_HOME\s+in BZZY/);
      assert.match(frame, /Import checked · 0/);

      ui.tui.key('', { name: 'escape' }); assert.equal(ui.tui.panel, 'skills'); assert.equal(ui.skillView, 'library');
      const library = skillRows(ui).map(row => row.text).join('\n');
      assert.match(library, /THIS CHAT \/ PROJECT/); assert.match(library, /BZZY CORE \/ GLOBAL/);
      assert.match(library, /picker-alpha[\s\S]*picker-under-score/);
      assert.match(library, /Codex → BZZY · 2 imported/);
      assert.doesNotMatch(library, /Fixture picker/);
      ui.tui.key('', { name: 'escape' });
      assert.equal(ui.tui.value, 'Keep my chat draft');
      assert.equal(listRecords('execution').length, 0);
    } finally { ui.close(); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Codex import scans another chosen folder and can forget it', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-codex-other-folder-')));
  const copied = path.join(root, 'backup', '.codex', 'skills', 'copied-skill');
  fs.mkdirSync(copied, { recursive: true });
  fs.writeFileSync(path.join(copied, 'SKILL.md'), '---\nname: copied-skill\ndescription: Copied from another machine.\n---\nFollow it.\n');
  const { ui } = terminal();
  try {
    ui.codexSkillDiscovery = { cwd: root, userHome: path.join(root, 'home'), codexHome: null, bzzyCodexHome: null, adminRoot: path.join(root, 'admin') };
    await skillsCommand('/skills codex', ui); assert.equal(ui.codexScan.items.length, 0);
    ui.ask = async (question, options) => { assert.match(question, /Another folder with Codex skills/); assert.equal(options.initialValue, ''); return path.join(root, 'backup', '.codex', 'skills'); };
    await skillsCommand('/skills codex-folder', ui);
    const item = ui.codexScan.items.find(entry => entry.name === 'copied-skill');
    assert.equal(item.label, 'other folder'); assert.equal(item.target, 'global'); assert.equal(item.status, 'new');
    await skillsCommand('/skills codex-rescan', ui); assert.ok(ui.codexScan.items.some(entry => entry.name === 'copied-skill'), 'the folder is remembered');
    ui.ask = async (question, options) => { assert.match(question, /empty forgets it/); assert.equal(options.initialValue, path.join(root, 'backup', '.codex', 'skills')); return ''; };
    await skillsCommand('/skills codex-folder', ui);
    assert.equal(ui.codexScan.items.length, 0); assert.equal(ui.codexMessage, 'Stopped scanning the other folder.');
  } finally { ui.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('empty first chat exposes bottom model/effort controls and preserves unsent text', async () => {
 const { ui, output, session } = terminal();
 try {
  assert.equal(session.modelSelectionRequired, true); assert.equal(session.model, null);
  for (const columns of [80, 120]) {
   output.columns = columns; ui.tui.render();
   const controls = ui.tui.hitTargets.filter(hit => hit.type === 'model-control');
   for (const command of ['/providers @saved', '/effort']) assert.ok(controls.some(hit => hit.command === command));
   assert.ok(ui.tui.lastFrame.every(line => cellWidth(line) <= columns - 1));
  }
  const answer = ui.ask('bzzy › '); await Promise.resolve(); ui.tui.key('unsent draft', {}); ui.tui.render();
  const target = ui.tui.hitTargets.find(hit => hit.command === '/providers @saved'); ui.tui.mouse(0, target.left, target.row);
  assert.equal(await answer, '/providers @saved'); assert.equal(ui.tui.value, 'unsent draft');
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
 const { ui, input } = terminal();
 try {
  await ui.settingsCommand('/skills'); ui.tui.render();
  assert.match(ui.tui.lastFrame.map(clean).join('\n'), /SKILLS.*Import.*Export/s);
  assert.match(ui.tui.lastFrame.map(clean).join('\n'), /THIS CHAT \/ PROJECT.*BZZY CORE \/ GLOBAL/s);
  await ui.settingsCommand('/skills view:' + skill.name); ui.tui.render();
  assert.match(ui.tui.lastFrame.map(clean).join('\n'), /Back to library[\s\S]*Inspect the layout[\s\S]*Actions/);
  assert.equal(skillRows(ui)[0].action, 'library');
  input.write('\x1b'); await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(ui.skillPreview, null); assert.equal(ui.tui.panel, 'skills');
  ui.tui.render(); assert.match(ui.tui.lastFrame.map(clean).join('\n'), /ui-check/);
  input.write('\x1b'); await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(ui.tui.panel, 'chat');
  await ui.settingsCommand('/skills library'); ui.chooseOne = async () => 'enable';
  await ui.settingsCommand('/skills toggle:' + skill.name); assert.equal(inspectSkill(skill.name).enabled, true);
  assert.equal(listRecords('execution').length, 0);
 } finally { ui.close(); }
});

test('Clear asks for confirmation, then deletes every project and global skill this library manages', async () => {
  const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-skill-clear-other-')));
  const { ui, session } = terminal(), notices = [], original = ui.event.bind(ui);
  ui.event = (type, data) => { notices.push({ type, ...data }); original(type, data); };
  const definition = name => ({ name, description: `Fixture ${name}.`, instructions: `Follow ${name}.` });
  try {
    createSkill(definition('clear-global-a'), { scope: 'global' }); createSkill(definition('clear-global-b'), { scope: 'global' });
    createSkill(definition('clear-project'), { session, scope: 'project' });
    createSkill(definition('clear-elsewhere'), { projectRoot: other, scope: 'project' });
    let dialog;
    ui.chooseOne = async (title, details, options) => { dialog = { title, ...details, options }; return 'cancel'; };
    await skillsCommand('/skills clear', ui);
    const count = Number(/^Delete all (\d+) skills\?$/.exec(dialog.title)?.[1]); assert.ok(count >= 3, dialog.title);
    assert.match(dialog.description, /^\d+ in this project · \d+ in BZZY Core \(global\)\. Models lose access immediately; audit history is kept\.$/);
    assert.deepEqual(dialog.choices.map(choice => [choice.value, choice.label]), [['cancel', 'Cancel'], ['clear', `Delete all ${count} skills`]]);
    assert.equal(dialog.choices[0].selected, true); assert.equal(dialog.options.presentation, 'dropdown');
    assert.equal(inspectSkill('clear-global-a', { scope: 'global' }).name, 'clear-global-a', 'Cancel deletes nothing');

    // A skill that appears while the confirmation is open cancels the whole clear.
    ui.chooseOne = async () => { createSkill(definition('clear-arrived'), { scope: 'global' }); return 'clear'; };
    await skillsCommand('/skills clear', ui);
    assert.ok(notices.some(item => item.type === 'error' && /library changed/i.test(item.message)));
    assert.equal(inspectSkill('clear-global-a', { scope: 'global' }).name, 'clear-global-a');

    ui.chooseOne = async () => 'clear';
    await skillsCommand('/skills clear', ui);
    for (const name of ['clear-global-a', 'clear-global-b', 'clear-arrived']) assert.throws(() => inspectSkill(name, { scope: 'global' }), /not found/);
    assert.throws(() => inspectSkill('clear-project', { session }), /not found/);
    assert.equal(inspectSkill('clear-elsewhere', { projectRoot: other, scope: 'project' }).name, 'clear-elsewhere', 'other projects are untouched');
    assert.ok(notices.some(item => item.type === 'info' && /^Deleted \d+ skills from the library\. History was kept for audit\.$/.test(item.message)));
    const library = skillRows(ui);
    assert.ok(library.some(row => row.text === '  No project skills installed.'));
    assert.ok(library.some(row => row.text === '  No Core/global skills installed.'));
    assert.equal(library.find(row => row.action === 'clear').disabled, true);
    dialog = null; ui.chooseOne = async (title, details) => { dialog = { title, ...details }; return 'clear'; };
    await skillsCommand('/skills clear', ui);
    assert.equal(dialog, null); assert.ok(notices.some(item => item.message === 'There are no skills to clear.'));
    assert.equal(listRecords('execution').length, 0);
  } finally { ui.close(); fs.rmSync(other, { recursive: true, force: true }); }
});
