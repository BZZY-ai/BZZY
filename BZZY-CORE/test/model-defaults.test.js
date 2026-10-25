import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { modelDefaultSettings, configureModelDefault } from '../src/engine/model-defaults.js';
import { getProvider, config, saveDefaultSelection, saveModeDefault, addProvider } from '../src/engine/providers.js';
import { createSession, loadSession, lockFile } from '../src/engine/store.js';
import { listRecords } from '../src/engine/database.js';
import { CoreAssistant } from '../src/assistant.js';
import { exportProject, importProject } from '../src/engine/project-bundle.js';

let root, previous;
test.beforeEach(() => {
  previous = process.env.BZZY_HOME;
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-model-defaults-')));
  process.env.BZZY_HOME = path.join(root, 'private');
});
test.afterEach(() => {
  if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
  fs.rmSync(root, { recursive: true, force: true });
});
const agent = (model, provider = 'codex', effort = 'default') => ({ provider, model, effort });
const save = (target, agents) => configureModelDefault(target, agents, { expectedRevision: modelDefaultSettings(target).revision });

test('default group reads are idle and saving never changes the current session or Core assistant', () => {
  for (const target of ['solo', 'validate', 'delegate', 'parallel', 'besties']) assert.deepEqual(modelDefaultSettings(target).agents, []);
  assert.equal(fs.existsSync(process.env.BZZY_HOME), false);
  const session = createSession(getProvider('codex'), root, 'current-chat-model');
  const core = new CoreAssistant(); core.configure({ source: 'core', provider: 'claude', model: 'core-model' }, { expectedRevision: 0, requestId: 'core-setup' });
  save('solo', [agent('next-solo-model')]); save('delegate', [agent('brain'), agent('executor', 'deepseek', 'low')]);
  assert.equal(loadSession(session.id).model, 'current-chat-model'); assert.equal(core.settings().selection.model, 'core-model');
  assert.equal(listRecords('execution').length, 0); assert.equal(listRecords('run').length, 0);
});

test('target revisions reject stale GUI writes after legacy edits while unrelated defaults stay independent', () => {
  const shown = modelDefaultSettings('solo'), validate = modelDefaultSettings('validate');
  saveDefaultSelection({ provider: 'codex', model: 'legacy-change' });
  assert.throws(() => configureModelDefault('solo', [agent('stale')], { expectedRevision: shown.revision }), { code: 'CONFLICT' });
  configureModelDefault('validate', [agent('main'), agent('reviewer')], { expectedRevision: validate.revision });
  assert.equal(modelDefaultSettings('solo').agents[0].model, 'legacy-change');
  assert.equal(modelDefaultSettings('debate').agents[1].model, 'reviewer');
  const stale = modelDefaultSettings('validate');
  saveModeDefault('debate', [agent('other-main'), agent('other-reviewer'), agent('third')]);
  assert.throws(() => configureModelDefault('validate', [agent('bad-main'), agent('bad-reviewer')], { expectedRevision: stale.revision }), { code: 'CONFLICT' });
});

test('configuration lock excludes existing provider/default writers without partial writes', () => {
  save('solo', [agent('saved')]); const before = config();
  const unlock = lockFile(path.join(process.env.BZZY_HOME, 'config.json.lock'));
  try {
    assert.throws(() => saveDefaultSelection({ provider: 'claude', model: 'blocked' }), { code: 'CONFLICT' });
    assert.throws(() => saveModeDefault('delegate', [agent('a'), agent('b')]), { code: 'CONFLICT' });
    assert.throws(() => addProvider('custom', { baseUrl: 'https://example.invalid/v1', envKey: 'CUSTOM_KEY', model: 'custom-model' }), { code: 'CONFLICT' });
    assert.deepEqual(config(), before);
  } finally { unlock(); }
  save('solo', [agent('after-unlock')]); assert.equal(modelDefaultSettings('solo').agents[0].model, 'after-unlock');
});

test('complete group validation rejects invalid counts, unsupported effort and private capability fields atomically', () => {
  save('validate', [agent('main'), agent('reviewer')]); const before = config();
  for (const entries of [[agent('only-one')], [agent('a'), agent('b'), agent('c'), agent('d')],
    [agent('valid'), agent('invalid', 'deepseek', 'medium')], [agent('valid'), { ...agent('bad'), model: 0 }],
    [agent('valid'), { ...agent('bad'), capabilities: { apiKey: 'synthetic-private-binding' } }]]) {
    assert.throws(() => save('validate', entries)); assert.deepEqual(config(), before);
  }
  assert.throws(() => save('delegate', [agent('a'), agent('b'), agent('c')]));
  assert.throws(() => configureModelDefault('solo', [agent('x')], { expectedRevision: 0 }));
  const capabilities = { supportsEffort: true, supportedEfforts: ['low', 'max'], defaultEffort: 'low', contextWindow: 1048576, inputModalities: ['text'] };
  const saved = save('parallel', [{ ...agent('discovered', 'codex', 'max'), capabilities }, agent('peer')]);
  assert.deepEqual(saved.agents[0].capabilities, capabilities);
  capabilities.supportedEfforts.push('high'); assert.deepEqual(modelDefaultSettings('parallel').agents[0].capabilities.supportedEfforts, ['low', 'max']);
});

test('project imports merge provider definitions without restoring an earlier model default snapshot', async () => {
  const workspace = path.join(root, 'project'), destination = path.join(root, 'restored');
  fs.mkdirSync(workspace); fs.mkdirSync(destination); fs.writeFileSync(path.join(workspace, 'source.txt'), 'Synthetic project.');
  const session = createSession(getProvider('codex'), workspace, 'project-model');
  save('solo', [agent('before-import')]);
  const bundle = await exportProject(session, path.join(root, 'project.zip'));
  let edited = false;
  await importProject(bundle.path, destination, { event(type, data) {
    if (!edited && type === 'info' && data.message.startsWith('Reading the project ZIP')) {
      edited = true; save('solo', [agent('changed-while-importing')]);
    }
  } });
  assert.equal(edited, true); assert.equal(modelDefaultSettings('solo').agents[0].model, 'changed-while-importing');
  assert.equal(loadSession(session.id).model, 'project-model');
});
