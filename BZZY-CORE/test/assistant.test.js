import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CoreAssistant } from '../src/index.js';
import { listRecords, getRecord, putRecord, generationSecurityPolicy } from '../src/engine.js';
import { agentInstructions } from '../src/engine/instructions.js';
import { addProvider, saveDefaultSelection, saveModeDefault } from '../src/engine/providers.js';

let directory, workspace, previous;
test.beforeEach(() => {
  previous = process.env.BZZY_HOME;
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-assistant-'));
  process.env.BZZY_HOME = path.join(directory, 'private'); fs.mkdirSync(process.env.BZZY_HOME, { mode: 0o700 });
  workspace = path.join(directory, 'project'); fs.mkdirSync(workspace);
});
test.afterEach(() => {
  if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
  fs.rmSync(directory, { force: true, recursive: true });
});
const cliConfig = value => fs.writeFileSync(path.join(process.env.BZZY_HOME, 'config.json'), JSON.stringify(value));
const configure = (assistant, input, extra = {}) => assistant.configure(input, { requestId: randomUUID(), expectedRevision: assistant.settings().revision, ...extra });
const context = (assistant, requestId = randomUUID()) => assistant.createContext({ cwd: workspace }, { requestId });

test('an unconfigured home host needs a deliberate AI selection and starts no inference', () => {
  cliConfig({ defaultProvider: 'codex', defaultSelection: { provider: 'codex', model: 'cli-only-model', effort: 'high' } });
  const assistant = new CoreAssistant();
  assert.deepEqual(assistant.settings(), { source: 'core', revision: 0, configured: false, selection: null });
  assert.throws(() => context(assistant), { code: 'ASSISTANT_SETUP_REQUIRED' });
  assert.equal(listRecords('session').length, 0); assert.equal(listRecords('execution').length, 0);
});

test('an explicit one-time CLI copy saves only provider/model/effort and never follows later CLI changes', () => {
  cliConfig({ defaultProvider: 'deepseek', defaultSelection: { provider: 'deepseek', model: 'saved-model', effort: 'high',
    capabilities: { privateField: 'SYNTHETIC_PRIVATE_SETTING' } }, providers: {} });
  fs.writeFileSync(path.join(process.env.BZZY_HOME, 'credentials.json'), '{"deepseek":"SYNTHETIC_ACCOUNT_SECRET"}', { mode: 0o600 });
  const assistant = new CoreAssistant(), requestId = randomUUID();
  assert.equal(assistant.settings().configured, false);
  const state = configure(assistant, { source: 'cli' }, { requestId, expectedRevision: 0 }), created = context(assistant);
  assert.equal(state.source, 'core'); assert.equal(getRecord('core.assistant', 'default').source, 'core');
  assert.deepEqual(state.selection, { provider: 'deepseek', model: 'saved-model', effort: 'high' });
  assert.equal(created.provider, 'deepseek'); assert.equal(created.model, 'saved-model');
  assert.doesNotMatch(JSON.stringify([state, created, assistant.providers(), listRecords('session')]), /SYNTHETIC_|baseUrl|envKey|credentials/);
  assert.equal(fs.readFileSync(path.join(process.env.BZZY_HOME, 'credentials.json'), 'utf8'), '{"deepseek":"SYNTHETIC_ACCOUNT_SECRET"}');
  cliConfig({ defaultProvider: 'claude', defaultSelection: { provider: 'claude', model: 'different-cli-model', effort: 'default' } });
  assert.deepEqual(new CoreAssistant().settings(), state);
  assert.deepEqual(configure(assistant, { source: 'cli' }, { requestId, expectedRevision: 0 }), state);
  assert.equal(context(assistant).provider, 'deepseek');
  assert.equal(listRecords('execution').length, 0);
});

test('a separate Core selection persists without changing the terminal default', () => {
  cliConfig({ defaultProvider: 'codex', defaultSelection: { provider: 'codex', model: 'cli-model', effort: 'default' } });
  const before = fs.readFileSync(path.join(process.env.BZZY_HOME, 'config.json'), 'utf8'), assistant = new CoreAssistant();
  configure(assistant, { source: 'core', provider: 'claude', model: 'core-model', effort: 'high' });
  assert.deepEqual(new CoreAssistant().settings().selection, { provider: 'claude', model: 'core-model', effort: 'high' });
  assert.equal(fs.readFileSync(path.join(process.env.BZZY_HOME, 'config.json'), 'utf8'), before);
  cliConfig({ defaultProvider: 'deepseek' });
  assert.equal(assistant.settings().selection.provider, 'claude');
  configure(assistant, { source: 'cli' });
  assert.equal(assistant.settings().selection.provider, 'deepseek');
  cliConfig({ defaultProvider: 'codex' });
  assert.equal(assistant.settings().selection.provider, 'deepseek');
});

test('normal chat and every CLI mode default remain independent of Core and its existing contexts', () => {
  const assistant = new CoreAssistant();
  configure(assistant, { source: 'core', provider: 'claude', model: 'core-coordinator', effort: 'high' });
  const initial = assistant.settings(), created = context(assistant);
  saveDefaultSelection({ provider: 'codex', model: 'terminal-chat', selectedEffort: 'low' });
  for (const mode of ['delegate', 'besties', 'parallel', 'debate']) {
    saveModeDefault(mode, [{ provider: 'codex', model: `cli-${mode}`, effort: 'medium' }, { provider: 'deepseek', effort: 'high' }]);
    assert.deepEqual(new CoreAssistant().settings(), initial);
    assert.equal(getRecord('session', created.contextId).model, 'core-coordinator');
  }
  assert.equal(context(assistant).provider, 'claude');
  assert.equal(listRecords('execution').length, 0);
});

test('legacy live-CLI settings require deliberate setup at their existing revision without a read-side migration', () => {
  cliConfig({ defaultProvider: 'deepseek' });
  const legacy = { source: 'cli', selection: null, revision: 7, updatedAt: '2026-01-01T00:00:00.000Z' };
  putRecord('core.assistant', 'default', legacy);
  const assistant = new CoreAssistant();
  assert.deepEqual(assistant.settings(), { source: 'core', revision: 7, configured: false, selection: null });
  assert.deepEqual(getRecord('core.assistant', 'default'), legacy);
  assert.throws(() => context(assistant), { code: 'ASSISTANT_SETUP_REQUIRED' });
  assert.throws(() => configure(assistant, { source: 'core', provider: 'claude' }, { expectedRevision: 6 }), { code: 'CONFLICT' });
  assert.equal(configure(assistant, { source: 'cli' }).revision, 8);
  assert.equal(getRecord('core.assistant', 'default').source, 'core');
  cliConfig({ defaultProvider: 'codex' });
  assert.equal(assistant.settings().selection.provider, 'deepseek');
});

test('copying with no saved CLI selection does not invent a Core provider', () => {
  const assistant = new CoreAssistant();
  assert.throws(() => configure(assistant, { source: 'cli' }), { code: 'ASSISTANT_SETUP_REQUIRED' });
  assert.equal(assistant.settings().revision, 0); assert.equal(assistant.settings().configured, false);
  assert.equal(getRecord('core.assistant', 'default'), null);
});

test('a registered local Responses provider can be selected independently without inference or model installation', () => {
  cliConfig({ defaultProvider: 'codex', providers: {} });
  addProvider('local-interpreter', { baseUrl: 'http://127.0.0.1:11434/v1', envKey: 'BZZY_LOCAL_INTERPRETER_TOKEN', model: 'local-example-model' });
  const assistant = new CoreAssistant();
  configure(assistant, { source: 'core', provider: 'local-interpreter', effort: 'default' });
  const created = context(assistant);
  saveDefaultSelection({ provider: 'codex', model: 'different-terminal-model', selectedEffort: 'medium' });
  assert.equal(assistant.settings().selection.provider, 'local-interpreter');
  assert.equal(created.model, 'local-example-model');
  assert.equal(getRecord('session', created.contextId).backend, 'codex');
  assert.doesNotMatch(JSON.stringify(assistant.providers()), /127\.0\.0\.1|BZZY_LOCAL_INTERPRETER_TOKEN/);
  assert.equal(listRecords('execution').length, 0);
  assert.equal(fs.existsSync(path.join(process.env.BZZY_HOME, 'credentials.json')), false);
});

test('stale settings edits conflict while retries never overwrite a newer selection', () => {
  const assistant = new CoreAssistant(), requestId = randomUUID(), input = { source: 'core', provider: 'codex' };
  const first = configure(assistant, input, { requestId, expectedRevision: 0 });
  assert.throws(() => configure(assistant, { source: 'core', provider: 'claude' }, { expectedRevision: 0 }), { code: 'CONFLICT' });
  configure(assistant, { source: 'core', provider: 'deepseek' });
  assert.deepEqual(configure(assistant, input, { requestId, expectedRevision: 0 }), first);
  assert.equal(assistant.settings().selection.provider, 'deepseek');
  assert.equal(assistant.settings().revision, 2);
});

test('internal contexts are independent and a lost creation acknowledgment cannot change their provider or history', () => {
  const assistant = new CoreAssistant(); cliConfig({ defaultProvider: 'deepseek' });
  configure(assistant, { source: 'core', provider: 'codex' });
  const requestId = randomUUID(), first = context(assistant, requestId), original = getRecord('session', first.contextId);
  assert.equal(original.purpose, 'core-assistant'); assert.equal(original.engineThreadId, null); assert.equal(original.goal, null);
  assert.ok(agentInstructions(original).includes(generationSecurityPolicy));
  putRecord('session', original.id, { ...original, turns: 3, executionState: 'paused' });
  cliConfig({ defaultProvider: 'claude' });
  const replay = context(new CoreAssistant(), requestId), second = context(assistant);
  assert.equal(replay.contextId, first.contextId); assert.equal(replay.provider, 'codex');
  assert.equal(getRecord('session', first.contextId).turns, 3); assert.equal(getRecord('session', first.contextId).executionState, 'paused');
  assert.notEqual(second.contextId, first.contextId); assert.equal(second.provider, 'codex');
  assert.equal(getRecord('session', second.contextId).turns, 0);
  configure(assistant, { source: 'core', provider: 'claude' });
  const third = context(assistant); assert.equal(third.provider, 'claude');
  assert.equal(getRecord('session', first.contextId).provider, 'codex');
  assert.equal(getRecord('session', second.contextId).provider, 'codex');
  assert.equal(listRecords('core.permission').length, 0); assert.equal(listRecords('core.binding').length, 0); assert.equal(listRecords('execution').length, 0);
});

test('selection and context inputs cannot smuggle credentials, privileges, imported history or private storage', () => {
  const assistant = new CoreAssistant();
  for (const field of ['apiKey', 'environment', 'permissions', 'bindingId', 'baseUrl', 'history']) {
    assert.throws(() => configure(assistant, { source: 'core', provider: 'codex', [field]: 'SYNTHETIC_SECRET' }), { code: 'INVALID_REQUEST' });
    assert.throws(() => assistant.createContext({ cwd: workspace, [field]: 'SYNTHETIC_SECRET' }, { requestId: randomUUID() }), { code: 'INVALID_REQUEST' });
  }
  for (const provider of ['__proto__', 'constructor', 'missing-provider']) assert.throws(() => configure(assistant, { source: 'core', provider }), { code: 'PROVIDER_UNAVAILABLE' });
  assert.throws(() => configure(assistant, { source: 'cli', provider: 'codex' }), { code: 'INVALID_REQUEST' });
  assert.throws(() => configure(assistant, { source: 'core', provider: 'deepseek', effort: 'unsupported' }), { code: 'INVALID_REQUEST' });
  assert.throws(() => configure(assistant, { source: 'core', provider: 'codex', model: 'bad\u0085model' }), { code: 'INVALID_REQUEST' });
  assert.throws(() => assistant.createContext({ cwd: process.env.BZZY_HOME }, { requestId: randomUUID() }), { code: 'FORBIDDEN' });
  assert.equal(listRecords('session').length, 0);
});

test('assistant objects cannot follow a changed home into another host identity', () => {
  const assistant = new CoreAssistant(); process.env.BZZY_HOME = path.join(directory, 'other-private');
  for (const operation of [() => assistant.settings(), () => assistant.providers(), () => configure(assistant, { source: 'cli' }), () => context(assistant)]) assert.throws(operation, { code: 'HOST_CONTEXT_CHANGED' });
});

test('Core setup commands save the default and create an idle internal context without starting the daemon', () => {
  const command = (...args) => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/bzzy-core.js', import.meta.url)), 'assistant', ...args], { env: process.env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
  };
  assert.equal(command('set', 'claude', '--model', 'fixture-model').selection.provider, 'claude');
  const created = command('context', workspace); assert.equal(created.purpose, 'core-assistant');
  assert.equal(command('status').selection.model, 'fixture-model');
  cliConfig({ defaultProvider: 'codex', defaultSelection: { provider: 'codex', model: 'copied-once', effort: 'high' } });
  assert.equal(command('copy-cli').selection.model, 'copied-once');
  cliConfig({ defaultProvider: 'deepseek' });
  assert.equal(command('status').selection.model, 'copied-once');
  assert.equal(command('inherit').selection.provider, 'deepseek');
  cliConfig({ defaultProvider: 'claude' });
  assert.equal(command('status').selection.provider, 'deepseek');
  assert.equal(fs.existsSync(path.join(process.env.BZZY_HOME, 'runtime/service.json')), false);
  assert.equal(listRecords('execution').length, 0);
});
