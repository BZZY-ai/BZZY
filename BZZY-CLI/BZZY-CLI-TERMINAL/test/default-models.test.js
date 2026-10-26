import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DefaultModels, defaultModelGroups, chooseDefaultModel } from '../src/default-models.js';
import { CoreAssistant } from '@bzzy/core';
import { createSession, loadSession, saveSession } from '@bzzy/core/engine/store.js';
import { getProvider, addProvider } from '@bzzy/core/engine/providers.js';
import { modelDefaultSettings, configureModelDefault } from '@bzzy/core/engine/model-defaults.js';
import { backgroundModelSettings, configureBackgroundModel } from '@bzzy/core/engine/background-model.js';
import { listRecords } from '@bzzy/core/engine/database.js';

let directory, previous;
test.beforeEach(() => {
  previous = { BZZY_HOME: process.env.BZZY_HOME, DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY };
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-default-models-')));
  process.env.BZZY_HOME = path.join(directory, 'private'); delete process.env.DEEPSEEK_API_KEY;
});
test.afterEach(() => {
  for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  fs.rmSync(directory, { recursive: true, force: true });
});
const selection = (model = 'offline-selected') => ({ provider: 'codex', model, effort: 'default', capabilities: { supportsEffort: true, supportedEfforts: ['low', 'high'] } });
function settings(options = {}) {
  const ui = { tui: { cwd: directory }, async chooseOne(title) { return /number of agents/.test(title) ? '3' : 'codex'; },
    async secret() { assert.fail('Editing defaults must never request credentials.'); } };
  const controller = new DefaultModels(ui, { modelPicker: async current => ({ ...selection(), provider: current.provider }),
    effortPicker: async () => ({ effort: 'high' }), ...options });
  controller.open(); return { controller, ui };
}
async function fill(controller, target, count = controller.drafts.get(target).count) {
  for (let index = 0; index < count; index++) {
    await controller.run(`defaults:provider:${target}:${index}`);
    await controller.run(`defaults:model:${target}:${index}`);
    await controller.run(`defaults:effort:${target}:${index}`);
  }
}

test('one consolidated metadata table exposes all defaults with exactly one shared Consensus & Compactor row', () => {
  const { controller } = settings(), rows = controller.rows();
  assert.deepEqual(rows.filter(row => row.modelGroup).map(row => row.modelGroup.label), ['Solo', 'BZZY Core', 'Validate', 'Delegate', 'Parallel', 'Besties', 'Consensus & Compactor']);
  assert.equal(rows.filter(row => row.modelTable?.group === 'background').length, 1);
  for (const row of rows.filter(row => row.modelTable)) assert.deepEqual(row.modelTable.cells.map(cell => cell.key), ['provider', 'model', 'effort']);
  assert.equal(Object.keys(defaultModelGroups).length, 7); assert.equal(listRecords('session').length, 0); assert.equal(listRecords('execution').length, 0);
});

test('Save is per group, CAS-backed, and never changes the active chat model or starts inference', async () => {
  const session = createSession(getProvider('claude'), directory, 'live-chat-unchanged'); session.selectedEffort = 'low'; saveSession(session);
  const before = loadSession(session.id), { controller } = settings();
  for (const target of ['solo', 'validate', 'delegate', 'parallel', 'besties']) {
    if (defaultModelGroups[target].count) await controller.run(`defaults:count:${target}`);
    await fill(controller, target);
    assert.equal(modelDefaultSettings(target).agents.length, 0, 'draft editing starts no persistence');
    await controller.run(`defaults:save:${target}`);
    const saved = modelDefaultSettings(target);
    assert.equal(saved.agents.length, defaultModelGroups[target].count ? 3 : target === 'delegate' ? 2 : 1);
    assert.ok(saved.agents.every(agent => agent.effort === 'high'));
  }
  assert.equal(new CoreAssistant().settings().configured, false);
  assert.deepEqual(loadSession(session.id), before); assert.equal(listRecords('session').length, 1); assert.equal(listRecords('execution').length, 0);
});

test('Core and the one shared background target save independently and inheritance follows only saved Core settings', async () => {
  const { controller, ui } = settings(); await fill(controller, 'core');
  assert.equal(new CoreAssistant().settings().configured, false);
  await controller.run('defaults:save:core');
  const core = new CoreAssistant().settings(); assert.equal(core.selection.model, 'offline-selected');
  assert.equal(backgroundModelSettings().source, 'core');
  assert.deepEqual(backgroundModelSettings().selection, core.selection);
  ui.chooseOne = async title => /source/.test(title) ? 'custom' : 'deepseek';
  await controller.run('defaults:source:background'); await controller.run('defaults:provider:background:0');
  await controller.run('defaults:save:background');
  const shared = backgroundModelSettings(); assert.equal(shared.source, 'custom'); assert.equal(shared.selection.provider, 'deepseek'); assert.equal(shared.selection.effort, 'default');
  assert.deepEqual(new CoreAssistant().settings(), core); assert.equal(modelDefaultSettings('solo').agents.length, 0);
  ui.chooseOne = async () => 'core'; await controller.run('defaults:source:background'); await controller.run('defaults:save:background');
  assert.equal(backgroundModelSettings().source, 'core'); assert.deepEqual(backgroundModelSettings().selection, core.selection);
});

test('provider and model changes reset stale selection metadata, while independent effort edits preserve the model', async () => {
  const { controller, ui } = settings(); await fill(controller, 'solo');
  assert.equal(controller.drafts.get('solo').agents[0].effort, 'high');
  ui.chooseOne = async () => 'deepseek'; await controller.run('defaults:provider:solo:0');
  let selected = controller.drafts.get('solo').agents[0];
  assert.equal(selected.model, getProvider('deepseek').model); assert.equal(selected.effort, 'default');
  assert.deepEqual(selected.capabilities.supportedEfforts, getProvider('deepseek').supportedEfforts);
  controller.modelPicker = async current => ({ provider: current.provider, model: 'new-model', effort: 'high', capabilities: { supportedEfforts: ['low'] } });
  await controller.run('defaults:model:solo:0'); selected = controller.drafts.get('solo').agents[0];
  assert.equal(selected.model, 'new-model'); assert.equal(selected.effort, 'default');
  controller.effortPicker = async () => ({ effort: 'low' }); await controller.run('defaults:effort:solo:0');
  assert.equal(controller.drafts.get('solo').agents[0].model, 'new-model'); assert.equal(controller.drafts.get('solo').agents[0].effort, 'low');
});

test('cancel, Back and stale asynchronous selectors cannot save or overwrite a draft; explicit discard reloads', async () => {
  const { controller, ui } = settings(); const before = clone(controller.drafts.get('solo'));
  ui.chooseOne = async () => null; await controller.run('defaults:provider:solo:0'); assert.deepEqual(controller.drafts.get('solo'), before);
  await assert.rejects(controller.run('defaults:save:solo'), { code: 'MODE_INCOMPLETE' });
  ui.chooseOne = async () => 'codex'; await fill(controller, 'solo');
  const draft = clone(controller.drafts.get('solo')); controller.leave(); controller.open(); assert.deepEqual(controller.drafts.get('solo'), draft);
  controller.modelPicker = async () => { controller.leave(); return selection('stale-late-model'); };
  await assert.rejects(controller.run('defaults:model:solo:0'), { code: 'DEFAULTS_STALE_CONTEXT' });
  assert.deepEqual(controller.drafts.get('solo'), draft); controller.open(); await controller.run('defaults:reload:solo');
  assert.equal(controller.drafts.get('solo').dirty, false); assert.equal(controller.drafts.get('solo').agents[0], null);
});
const clone = value => structuredClone(value);

test('concurrent group changes reject stale Save until explicit reload and host changes block all writes', async () => {
  const { controller } = settings(); await fill(controller, 'validate');
  configureModelDefault('validate', [selection('owner-new'), selection('owner-new')], { expectedRevision: modelDefaultSettings('validate').revision });
  await assert.rejects(controller.run('defaults:save:validate'), { code: 'CONFLICT' });
  assert.equal(controller.drafts.get('validate').dirty, true);
  await controller.run('defaults:reload:validate'); assert.equal(controller.drafts.get('validate').agents[0].model, 'owner-new');
  await fill(controller, 'solo'); const home = process.env.BZZY_HOME;
  process.env.BZZY_HOME = path.join(directory, 'different-home');
  await assert.rejects(controller.run('defaults:save:solo'), { code: 'DEFAULTS_STALE_CONTEXT' });
  process.env.BZZY_HOME = home; assert.equal(modelDefaultSettings('solo').agents.length, 0);
});

test('counts are two or three, Delegate stays two, and discovered providers are editable without key setup', async () => {
  addProvider('runtime-provider', { baseUrl: 'https://catalog.example.invalid/v1', envKey: 'BZZY_UNUSED_DEFAULTS_KEY', model: 'runtime-default' });
  const { controller, ui } = settings();
  ui.chooseOne = async (_title, choices) => { assert.ok(choices.some(choice => choice.value === 'runtime-provider')); return 'runtime-provider'; };
  await controller.run('defaults:provider:solo:0'); assert.equal(controller.drafts.get('solo').agents[0].model, 'runtime-default');
  ui.chooseOne = async () => '4'; await assert.rejects(controller.run('defaults:count:validate'), { code: 'MODE_COUNT_INVALID' });
  await controller.run('defaults:count:delegate'); assert.equal(controller.drafts.get('delegate').count, 2);
});

test('provider-only Core catalog picker permits manual IDs without authenticating or sending a model request', async () => {
  let asked = false;
  const ui = { async chooseOne(_title, choices) { const resolved = await choices; assert.ok(resolved.choices.some(choice => choice.value === '@custom')); return '@custom'; },
    async ask() { asked = true; return 'custom-runtime-model'; }, async secret() { assert.fail('Unexpected authentication prompt.'); } };
  const selected = await chooseDefaultModel({ provider: 'deepseek', cwd: directory, model: getProvider('deepseek').model }, ui, { scope: 'defaults:solo:0' });
  assert.equal(asked, true); assert.equal(selected.provider, 'deepseek'); assert.equal(selected.model, 'custom-runtime-model');
  assert.equal(listRecords('execution').length, 0); assert.equal(listRecords('session').length, 0);
});

test('a draft switch from custom background to Core displays and edits the current saved Core model before Save', async () => {
  const core = new CoreAssistant(); core.configure({ source: 'core', provider: 'codex', model: 'core-original', effort: 'default' }, { expectedRevision: 0, requestId: randomUUID() });
  configureBackgroundModel({ source: 'custom', provider: 'deepseek', model: 'background-original', effort: 'low' }, { expectedRevision: 0 });
  const { controller, ui } = settings(); ui.chooseOne = async () => 'core'; await controller.run('defaults:source:background');
  let row = controller.rows().find(item => item.modelTable?.group === 'background');
  assert.equal(row.modelTable.cells[0].text, 'codex'); assert.equal(row.modelTable.cells[1].text, 'core-original');
  assert.equal(backgroundModelSettings().selection.provider, 'deepseek', 'changing the draft source starts no persistence');
  core.configure({ source: 'core', provider: 'claude', model: 'core-new-saved', effort: 'default' }, { expectedRevision: 1, requestId: randomUUID() });
  row = controller.rows().find(item => item.modelTable?.group === 'background'); assert.equal(row.modelTable.cells[1].text, 'core-new-saved');
  controller.modelPicker = async current => {
    assert.equal(current.provider, 'claude'); assert.equal(current.model, 'core-new-saved');
    return { provider: current.provider, model: 'edited-from-core', effort: 'default' };
  };
  await controller.run('defaults:model:background:0');
  assert.equal(controller.drafts.get('background').source, 'custom'); assert.equal(controller.drafts.get('background').agents[0].provider, 'claude');
  assert.equal(backgroundModelSettings().selection.model, 'background-original');
});

test('Core and background effort pickers expose only levels their configuration APIs accept', async () => {
  new CoreAssistant().configure({ source: 'core', provider: 'deepseek', model: getProvider('deepseek').model, effort: 'default' }, { expectedRevision: 0, requestId: randomUUID() });
  configureBackgroundModel({ source: 'custom', provider: 'deepseek', effort: 'default' }, { expectedRevision: 0 });
  const { controller } = settings();
  for (const target of ['core', 'background']) {
    controller.drafts.get(target).agents[0].capabilities = { supportedEfforts: ['medium', 'high'] };
    controller.effortPicker = async current => { assert.deepEqual(current.modelCapabilities.supportedEfforts, ['high']); return { effort: 'high' }; };
    await controller.run(`defaults:effort:${target}:0`); await controller.run(`defaults:save:${target}`);
    assert.equal(target === 'core' ? new CoreAssistant().settings().selection.effort : backgroundModelSettings().selection.effort, 'high');
    controller.effortPicker = async () => ({ effort: 'medium' });
    await assert.rejects(controller.run(`defaults:effort:${target}:0`), { code: 'INVALID_REQUEST' });
  }
  const { controller: dynamic, ui } = settings(); ui.chooseOne = async () => 'deepseek'; await dynamic.run('defaults:provider:solo:0');
  dynamic.drafts.get('solo').agents[0].capabilities = { supportedEfforts: ['medium', 'high'] };
  dynamic.effortPicker = async current => { assert.deepEqual(current.modelCapabilities.supportedEfforts, ['medium', 'high']); return { effort: 'medium' }; };
  await dynamic.run('defaults:effort:solo:0'); await dynamic.run('defaults:save:solo');
  assert.equal(modelDefaultSettings('solo').agents[0].effort, 'medium');
});

test('an explicitly empty discovered effort list remains default-only for Core and shared background', async () => {
  new CoreAssistant().configure({ source: 'core', provider: 'deepseek', effort: 'high' }, { expectedRevision: 0, requestId: randomUUID() });
  configureBackgroundModel({ source: 'custom', provider: 'deepseek', effort: 'high' }, { expectedRevision: 0 });
  const { controller } = settings();
  for (const target of ['core', 'background']) {
    controller.drafts.get(target).agents[0].capabilities = { supportedEfforts: [] };
    controller.effortPicker = async current => {
      assert.deepEqual(current.modelCapabilities.supportedEfforts, []); assert.equal(current.modelCapabilities.supportsEffort, false);
      return { effort: 'default' };
    };
    await controller.run(`defaults:effort:${target}:0`); await controller.run(`defaults:save:${target}`);
    assert.equal(target === 'core' ? new CoreAssistant().settings().selection.effort : backgroundModelSettings().selection.effort, 'default');
  }
});

test('refreshing the same model retains a supported effort and resets an effort removed by fresh capabilities', async () => {
  new CoreAssistant().configure({ source: 'core', provider: 'deepseek', effort: 'high' }, { expectedRevision: 0, requestId: randomUUID() });
  configureBackgroundModel({ source: 'custom', provider: 'deepseek', effort: 'high' }, { expectedRevision: 0 });
  for (const target of ['solo', 'core', 'background']) for (const levels of [['high'], ['low'], []]) {
    const { controller } = settings();
    controller.drafts.get(target).agents[0] = { provider: 'deepseek', model: getProvider('deepseek').model, effort: 'high', capabilities: { supportedEfforts: ['high'] } };
    controller.modelPicker = async current => ({ provider: current.provider, model: current.model, capabilities: { supportedEfforts: levels } });
    await controller.run(`defaults:model:${target}:0`);
    const expected = levels.includes('high') ? 'high' : 'default';
    assert.equal(controller.drafts.get(target).agents[0].effort, expected);
    await controller.run(`defaults:save:${target}`);
    const saved = target === 'core' ? new CoreAssistant().settings().selection : target === 'background' ? backgroundModelSettings().selection : modelDefaultSettings('solo').agents[0];
    assert.equal(saved.effort, expected);
  }
});


test('Core and shared background effort validation uses fresh picker metadata instead of stale disabled flags', async () => {
  new CoreAssistant().configure({ source: 'core', provider: 'experiential', model: 'future-gateway', effort: 'default' }, { expectedRevision: 0, requestId: randomUUID() });
  configureBackgroundModel({ source: 'custom', provider: 'experiential', model: 'future-gateway', effort: 'default' }, { expectedRevision: 0 });
  const { controller } = settings();
  for (const target of ['core', 'background']) {
    controller.drafts.get(target).agents[0].capabilities = { supportsEffort: false, supportedEfforts: [] };
    controller.effortPicker = async () => ({ effort: 'high', capabilities: { supportedEfforts: ['low', 'high', 'max'] } });
    await controller.run(`defaults:effort:${target}:0`); await controller.run(`defaults:save:${target}`);
    assert.equal(target === 'core' ? new CoreAssistant().settings().selection.effort : backgroundModelSettings().selection.effort, 'high');
  }
  assert.equal(listRecords('execution').length, 0);
});
