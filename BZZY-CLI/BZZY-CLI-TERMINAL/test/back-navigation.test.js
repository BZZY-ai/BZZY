import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { UI } from '../src/ui.js';
import { clean } from '../src/terminal-format.js';
import { defaultSelection } from '../src/providers.js';

function terminal(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-back-')), previous = process.env.BZZY_HOME;
  process.env.BZZY_HOME = directory;
  const input = new PassThrough(); Object.assign(input, { isTTY: true, setRawMode() {} });
  const output = new PassThrough(); Object.assign(output, { isTTY: true, columns: 100, rows: 30 });
  let written = ''; output.on('data', chunk => { written += chunk; });
  const ui = new UI({ input, output, error: output }); ui.setSession('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  ui.updateSession({ id: ui.sessionId, cwd: directory, alias: 'Back navigation', provider: 'codex', model: 'Active model' });
  ui.tui.value = 'unsent chat text'; ui.tui.cursor = 6;
  t.after(() => { ui.close(); if (previous == null) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous; fs.rmSync(directory, { recursive: true, force: true }); });
  return { ui, tui: ui.tui, input, get written() { return written; } };
}
function click(input, hit) { assert.ok(hit, 'visible Back control'); input.write(`\x1b[<0;${hit.left};${hit.row}M`); }
function back(tui, input) {
  tui.render();
  const hit = tui.hitTargets.find(hit => hit.type === 'back') || tui.hitTargets.find(hit => ['cancel', 'private-cancel'].includes(hit.type)
    && clean(tui.lastFrame[hit.row - 1] || '').includes('← Back'));
  click(input, hit);
}

test('sticky Settings Back returns to the parent page while Escape still returns to chat', async t => {
  const { ui, tui, input } = terminal(t);
  await ui.settingsCommand('/settings default-models'); tui.settingsOffset = 200; tui.settingsEnsureFocus = false;
  back(tui, input); assert.equal(ui.settings.page, 'main'); assert.equal(tui.panel, 'settings');
  back(tui, input); assert.equal(tui.panel, 'chat'); assert.equal(tui.value, 'unsent chat text'); assert.equal(tui.cursor, 6);
  ui.openSettings(); ui.settings.page = 'approve';
  back(tui, input); assert.equal(ui.settings.page, 'pair');
  back(tui, input); assert.equal(ui.settings.page, 'main');
  await ui.settingsCommand('/settings default-models'); input.write('\x1b[27u'); assert.equal(tui.panel, 'chat');
});

test('all ordinary panels have visible Back and detail views return to their libraries first', async t => {
  const { ui, tui, input } = terminal(t); tui.mode = 'besties';
  for (const panel of ['metrics', 'sessions', 'activity', 'http', 'room']) {
    tui.setPanel(panel); back(tui, input); assert.equal(tui.panel, 'chat', panel);
  }
  await ui.settingsCommand('/skills'); ui.skillPromotionDraft = { definition: { name: 'draft', description: 'Unsaved review', instructions: 'Controlled proposal' } };
  back(tui, input); assert.equal(tui.panel, 'skills'); assert.equal(ui.skillPromotionDraft, null);
  back(tui, input); assert.equal(tui.panel, 'chat');
  tui.setPanel('agents'); ui.subagentPreview = { name: 'Controlled agent', scope: 'project', revision: 1, description: 'Saved detail', instructions: 'Controlled instructions' };
  back(tui, input); assert.equal(tui.panel, 'agents'); assert.equal(ui.subagentPreview, null);
  back(tui, input); assert.equal(tui.panel, 'chat'); assert.equal(tui.value, 'unsent chat text'); assert.equal(tui.inputQueue.length, 0);
});

test('dropdown Back cancels only the cell picker and preserves unsaved model defaults', async t => {
  const { ui, tui, input } = terminal(t); await ui.settingsCommand('/settings default-models');
  const priorSaved = defaultSelection(), draft = ui.settings.defaults.drafts.get('solo');
  draft.agents[0] = { provider: 'codex', model: 'unsaved-selected-model', effort: 'high' }; draft.dirty = true;
  const before = structuredClone(draft), editing = ui.settings.run('defaults:provider:solo:0'); await Promise.resolve(); tui.render();
  assert.ok(tui.selection); assert.match(tui.lastFrame.map(clean).join('\n'), /← Back/);
  const control = tui.hitTargets.find(hit => hit.type === 'cancel'); click(input, control); await editing;
  assert.equal(tui.selection, null); assert.equal(tui.panel, 'settings'); assert.equal(ui.settings.page, 'default-models');
  assert.deepEqual(ui.settings.defaults.drafts.get('solo'), before); assert.deepEqual(defaultSelection(), priorSaved);
  back(tui, input); back(tui, input); assert.equal(tui.value, 'unsent chat text');
});

test('Back cancels selected destructive and approval choices without accepting the default', async t => {
  const { ui, tui, input } = terminal(t);
  const destructive = ui.chooseOne('Delete controlled item?', [{ value: 'delete', label: 'Delete', selected: true }]); await Promise.resolve(); tui.render();
  click(input, tui.hitTargets.find(hit => hit.type === 'cancel')); assert.equal(await destructive, null);
  const approval = ui.approve('Run the controlled operation?'); await Promise.resolve(); tui.render();
  click(input, tui.hitTargets.find(hit => hit.type === 'cancel')); assert.equal(await approval, false);
  assert.equal(tui.entries.find(entry => entry.kind === 'approval').decision, 'denied');
  assert.equal(tui.value, 'unsent chat text'); assert.equal(tui.inputQueue.length, 0);
});

test('Back cancels an inner picker before an active creator generation', async t => {
  const { ui, tui, input } = terminal(t); tui.setPanel('agents'); let aborted = 0;
  ui.cancelDefinitionAuthoring = () => { aborted++; delete ui.cancelDefinitionAuthoring; };
  const picked = ui.chooseOne('Nested choice', [{ value: 'one', label: 'One' }]); await Promise.resolve(); tui.render();
  click(input, tui.hitTargets.find(hit => hit.type === 'cancel' && hit.back));
  assert.equal(await picked, null); assert.equal(aborted, 0); assert.equal(tui.panel, 'agents');
  back(tui, input); assert.equal(aborted, 1); assert.equal(tui.panel, 'agents'); assert.equal(tui.value, 'unsent chat text');
});

test('Back discards secret and editable prompt input without persisting temporary text', async t => {
  const fixture = terminal(t), { ui, tui, input } = fixture;
  const secret = ui.secret('Private provider key: '); await Promise.resolve(); input.write('fixture-private-value-discarded');
  back(tui, input); assert.equal(await secret, null); assert.equal(tui.hidden, false); assert.equal(tui.promptDraft, null);
  assert.equal(tui.value, 'unsent chat text'); assert.equal(tui.cursor, 6); assert.equal(fixture.written.includes('fixture-private-value-discarded'), false);
  const question = ui.ask('Enter a model ID: '); await Promise.resolve(); input.write('discarded-model-id');
  back(tui, input); assert.equal(await question, null); assert.equal(tui.value, 'unsent chat text');
  assert.equal(tui.entries.some(entry => /discarded/.test(entry.text)), false); assert.equal(tui.history.some(text => /discarded/.test(text)), false);
});

test('every Settings page has one sticky Back at compact and tall sizes', t => {
  const { ui, tui, input } = terminal(t); ui.openSettings();
  for (const columns of [50, 100]) for (const rows of [20, 24, 50]) {
    Object.assign(tui.output, { columns, rows });
    for (const page of ['main', 'keys', 'core', 'default-models', 'worker-budget', 'extensions', 'pair', 'approve']) {
      ui.settings.page = page; ui.settings.focus = 0; tui.settingsOffset = 0; tui.render();
      const frame = tui.lastFrame.map(clean).join('\n');
      assert.equal((frame.match(/← Back/g) || []).length, 1, `${page} at ${columns}×${rows}`);
      assert.equal(tui.hitTargets.filter(hit => ['back', 'settings-back'].includes(hit.type) || hit.type === 'settings' && hit.action === 'back').length, 1);
      assert.ok(tui.hitTargets.some(hit => hit.type === 'back'));
      assert.ok(tui.lastFrame.length <= rows);
    }
  }
  ui.settings.page = 'core'; back(tui, input); assert.equal(ui.settings.page, 'main');
});

test('selection dialogs offer one Back, including menus with their own Back choice', async t => {
  const { ui, tui, input } = terminal(t);
  const ordinary = ui.chooseOne('Choose an option', [{ value: 'one', label: 'One' }]);
  await Promise.resolve(); tui.render();
  assert.equal(tui.hitTargets.filter(hit => hit.type === 'cancel' && hit.back).length, 1);
  click(input, tui.hitTargets.find(hit => hit.type === 'cancel' && hit.back));
  assert.equal(await ordinary, null);
  const explicit = ui.chooseOne('Library submenu', [{ value: 'back', label: '← Back to review', selected: true }, { value: 'save', label: 'Save' }]);
  await Promise.resolve(); tui.render();
  assert.equal(tui.hitTargets.filter(hit => hit.type === 'cancel' && hit.back).length, 0);
  const choice = tui.hitTargets.find(hit => hit.type === 'choice' && hit.index === 0); click(input, choice);
  tui.key('', { name: 'return' });
  assert.equal(await explicit, 'back');
});
