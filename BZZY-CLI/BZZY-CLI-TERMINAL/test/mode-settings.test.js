import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ModeSettings } from '../src/mode-settings.js';
import { config, saveConfig, modeDefault } from '../src/providers.js';
import { CoreAssistant } from '@bzzy/core';
import { listRecords } from '../src/database.js';

let directory, previous;
test.beforeEach(() => {
  previous = process.env.BZZY_HOME; directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-presets-'));
  process.env.BZZY_HOME = directory;
});
test.afterEach(() => {
  if (previous == null) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
  fs.rmSync(directory, { recursive: true, force: true });
});
const selection = { provider: 'codex', model: 'fixture-model', effort: 'default', capabilities: { supportsEffort: true, supportedEfforts: ['high'] } };

test('each mode saves Core-owned role presets without changing chat or coordinator defaults or starting work', async () => {
  saveConfig({ ...config(), defaultProvider: 'claude', defaultSelection: { provider: 'claude', model: 'chat-default', effort: 'default' } });
  const before = config(), coordinator = new CoreAssistant().settings();
  const ui = { tui: { cwd: directory }, chooseOne: async (_title, _choices, options) => {
    assert.equal(options.presentation, 'dropdown'); assert.equal(options.scope, 'preset-count'); return '3';
  } };
  const modes = new ModeSettings(ui, {
    modelPicker: async (_current, _ui, options) => { assert.match(options.scope, /^preset:[0-2]$/); return selection; },
    effortPicker: async current => { assert.equal(current.modelCapabilities.supportsEffort, true); return { effort: 'high' }; },
  });
  for (const mode of ['debate', 'parallel', 'besties', 'delegate']) {
    modes.open(mode);
    await assert.rejects(modes.run('preset-effort:0'), { code: 'MODE_MODEL_REQUIRED' });
    await assert.rejects(modes.run('preset-save'), { code: 'MODE_INCOMPLETE' });
    await modes.run('preset-count');
    assert.equal(modes.draft.count, mode === 'delegate' ? 2 : 3);
    for (let index = 0; index < modes.draft.count; index++) await modes.run(`preset-model:${index}`);
    await modes.run('preset-effort:0');
    assert.equal(modeDefault(mode), null, 'editing has no persistence side effects');
    await modes.run('preset-save');
    assert.equal(modeDefault(mode).length, modes.draft.count);
    assert.equal(modeDefault(mode)[0].effort, 'high');
  }
  assert.equal(config().defaultProvider, before.defaultProvider); assert.deepEqual(config().defaultSelection, before.defaultSelection);
  assert.deepEqual(new CoreAssistant().settings(), coordinator);
  assert.equal(listRecords('session').length, 0); assert.equal(listRecords('execution').length, 0);
});

test('cancelled choices preserve drafts, invalid counts fail, and concurrent presets require explicit reload', async () => {
  let picked = null;
  const modes = new ModeSettings({ tui: {}, chooseOne: async () => picked }, { modelPicker: async () => picked });
  modes.open('parallel'); const draft = structuredClone(modes.draft);
  await modes.run('preset-count'); await modes.run('preset-model:0'); assert.deepEqual(modes.draft, draft);
  picked = '4'; await assert.rejects(modes.run('preset-count'), { code: 'MODE_COUNT_INVALID' }); assert.equal(modes.draft.count, 2);
  picked = selection; await modes.run('preset-model:0'); await modes.run('preset-model:1');
  modes.open('besties'); modes.open('parallel'); assert.equal(modes.draft.dirty, true);
  saveConfig({ ...config(), parallelDefault: [selection, selection] });
  await assert.rejects(modes.run('preset-save'), { code: 'CONFLICT' });
  await modes.run('preset-reload'); assert.equal(modes.draft.dirty, false); assert.deepEqual(modes.draft.agents, modeDefault('parallel'));
  await modes.run('preset-save');
});
