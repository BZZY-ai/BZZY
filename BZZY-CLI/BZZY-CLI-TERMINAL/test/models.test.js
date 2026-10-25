import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { availableModels, chooseModel, normalizeModel } from '../src/models.js';
import { chooseEffort } from '../src/model-controls.js';
import { BUILTINS, addProvider, chooseProvider, ensureApiKey, apiKey, defaultSelection, saveDefaultSelection, setDefault } from '../src/providers.js';
import { root } from '../src/process.js';
import { reasoningEffort } from '../src/instructions.js';
import { codexLaunch } from '../src/engines/codex.js';
import { claudeArgs } from '../src/engines/claude.js';
import { changeConversationProvider } from '../src/conversation-settings.js';
import { createSession, saveSession, loadSession } from '../src/store.js';
import { config } from '../src/providers.js';
import { runtimeInfo, runtimeRequest } from '../src/runtime.js';
import { identityAlive } from '../src/recovery.js';
import { delay } from '../src/delegation.js';
import { chooseDelegation, applyDelegationSelection } from '../src/delegation-setup.js';
import { prepareTask } from '../src/task.js';

let directory, previous;
test.beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-models-'));
  previous = Object.fromEntries(['BZZY_HOME', 'BZZY_CODEX_BIN', 'BZZY_CLAUDE_BIN', 'BZZY_TEST_MODEL_MODE', 'BZZY_TEST_LOG', 'BZZY_FIXTURE_MODELS_KEY', 'DEEPSEEK_API_KEY', 'ABLITERATION_API_KEY', 'ORCAROUTER_API_KEY', 'EXPLABS_API_KEY'].map(key => [key, process.env[key]]));
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.ABLITERATION_API_KEY;
  delete process.env.ORCAROUTER_API_KEY;
  delete process.env.EXPLABS_API_KEY;
  Object.assign(process.env, { BZZY_HOME: path.join(directory, 'private'), BZZY_CODEX_BIN: path.join(root, 'test/fixtures/models.mjs'), BZZY_CLAUDE_BIN: path.join(root, 'test/fixtures/models.mjs'), BZZY_TEST_LOG: path.join(directory, 'backend.jsonl') });
});
test.afterEach(async () => {
  const info = runtimeInfo();
  if (info && identityAlive(info.identity)) await runtimeRequest(info, 'POST', '/shutdown', {}).catch(() => {});
  for (let i = 0; i < 50 && info && identityAlive(info.identity); i++) await delay(20);
  for (const [key, value] of Object.entries(previous)) if (value == null) delete process.env[key]; else process.env[key] = value;
  fs.rmSync(directory, { recursive: true, force: true });
});
const session = provider => ({ provider, cwd: directory, model: null });

test('a saved launch default retains provider, resolved model and current effort', () => {
  const current = createSession(BUILTINS.codex, directory);
  Object.assign(current, { resolvedModel: 'fixture-brain', reasoningEffort: 'high', modelCapabilities: { supportedEfforts: ['medium', 'high', 'xhigh'] } });
  const saved = saveDefaultSelection(current);
  assert.deepEqual(saved, { provider: 'codex', model: 'fixture-brain', effort: 'high', capabilities: current.modelCapabilities });
  assert.deepEqual(defaultSelection(), saved);
  assert.equal(defaultSelection('claude'), null);
  setDefault('claude');
  assert.equal(defaultSelection(), null, 'choosing a different provider cannot leave a stale model preset active');
  assert.equal(config().defaultProvider, 'claude');
});

test('delegation setup selects supervisor then executor with independent models and effort before creating a session', async () => {
  const titles = [], snapshots = [];
  const ui = { interactive: true, event() {}, async chooseOne(title, choices) {
    titles.push(title); const picker = await choices;
    if (title.includes('Choose provider')) return title.startsWith('Supervisor') ? 'codex' : 'claude';
    assert.equal(picker.selectEffort, true);
    snapshots.push(picker);
    return title.startsWith('Supervisor') ? { value: 'fixture-brain', effort: 'xhigh' } : { value: 'sonnet', effort: 'medium' };
  } };
  const selection = await chooseDelegation({ cwd: directory }, ui);
  assert.deepEqual(titles, ['Supervisor · 1/2 · Choose provider', 'Supervisor · 1/2 · Choose model · codex', 'Executor · 2/2 · Choose provider', 'Executor · 2/2 · Choose model · claude']);
  assert.equal(selection.supervisor.effort, 'xhigh'); assert.equal(selection.executor.effort, 'medium');
  assert.ok(snapshots[1].choices.find(choice => choice.value === 'sonnet').efforts.includes('medium'));
  const created = createSession(BUILTINS.codex, directory, selection.supervisor.model); applyDelegationSelection(created, selection);
  prepareTask(created, { mode: 'delegate', executor: 'claude', executorModel: 'sonnet' }, 'Verify the requested result');
  assert.equal(reasoningEffort(created, { goalMode: true }), 'xhigh');
  assert.deepEqual(created.executor, selection.executor, 'preparing a goal preserves the executor effort and model capabilities');
  const next = loadSession(created.id); assert.equal(next.executor.effort, 'medium');
  const log = fs.readFileSync(path.join(directory, 'backend.jsonl'), 'utf8');
  assert.doesNotMatch(log, /thread\/start|turn\/start/, 'the setup only reads model catalogs');
  ui.chooseOne = async () => null;
  assert.equal(await chooseDelegation({ cwd: directory }, ui), null, 'Escape cancels before any conversation starts');
  ui.chooseOne = async (title, choices) => { await choices; return title.startsWith('Executor') ? null : title.includes('Choose provider') ? 'codex' : { value: 'fixture-brain', effort: 'high' }; };
  assert.equal(await chooseDelegation({ cwd: directory }, ui), null, 'cancelling executor setup cancels the launch');
});

test('model discovery reads paginated installed catalogs and never starts inference or a native thread', async () => {
  const result = await availableModels({ ...session('codex'), backendHomes: { codex: path.join(directory, 'native-login') } });
  assert.deepEqual(result.models.map(model => model.id), ['fixture-brain', 'fixture-light']);
  assert.equal(result.source, 'installed backend');
  assert.deepEqual(result.models[1].capabilities.supportedEfforts, ['low']);
  assert.equal(result.models[0].capabilities.defaultEffort, 'medium');
  const log = fs.readFileSync(path.join(directory, 'backend.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(log[0].home, path.join(directory, 'native-login'));
  assert.ok(log.slice(1).every(entry => ['initialize', 'initialized', 'model/list'].includes(entry.method)));
  const claude = await availableModels(session('claude'));
  assert.deepEqual(claude.models.map(model => model.id), ['sonnet', 'haiku']);
  assert.equal(claude.models[1].capabilities.supportsEffort, false);
  assert.equal(reasoningEffort({ ...session('claude'), modelCapabilities: claude.models[1].capabilities }), undefined);
});

test('catalog failures and timeouts offer a manual fallback without exposing backend errors', async () => {
  process.env.BZZY_TEST_MODEL_MODE = 'error';
  const failed = await availableModels(session('codex'));
  assert.equal(failed.source, 'manual'); assert.deepEqual(failed.models, []);
  assert.doesNotMatch(JSON.stringify(failed), /Private backend error/);
  process.env.BZZY_TEST_MODEL_MODE = 'timeout';
  const started = Date.now(), timedOut = await availableModels(session('codex'), { timeoutMs: 150 });
  assert.equal(timedOut.source, 'manual'); assert.ok(Date.now() - started < 3000);
});

test('API catalogs use the configured provider key, retain Unicode names, and never follow redirects', async () => {
  let auth, redirected = false;
  const server = http.createServer((request, response) => {
    if (request.url === '/redirect/models') { response.writeHead(302, { Location: '/leak' }); response.end(); return; }
    if (request.url === '/leak') redirected = true;
    auth = request.headers.authorization;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ data: [{ id: 'api-model', name: '模型' }, { id: 'invalid\nmodel' }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    process.env.BZZY_FIXTURE_MODELS_KEY = 'fixture-only-key';
    addProvider('fixture', { baseUrl: base + '/v1', envKey: 'BZZY_FIXTURE_MODELS_KEY', model: 'configured-model' });
    const result = await availableModels(session('fixture'));
    assert.equal(auth, 'Bearer fixture-only-key');
    assert.deepEqual(result.models.map(model => [model.id, model.name]), [['api-model', '模型']]);
    addProvider('redirected', { baseUrl: base + '/redirect', envKey: 'BZZY_FIXTURE_MODELS_KEY', model: 'configured-model' });
    assert.equal((await availableModels(session('redirected'))).source, 'manual'); assert.equal(redirected, false);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('model picker supports current selection, manual IDs, provider default and cancellation', async () => {
  let options;
  const ui = { async chooseOne(title, choices) { assert.match(title, /codex/); options = await choices; return 'fixture-light'; } };
  const selected = await chooseModel({ ...session('codex'), model: 'fixture-brain' }, '', ui);
  assert.equal(selected.model, 'fixture-light'); assert.deepEqual(selected.capabilities.supportedEfforts, ['low']);
  assert.equal(options.choices.find(choice => choice.selected).value, 'fixture-brain');
  const custom = options.choices.at(-1).value, defaultChoice = options.choices[0].value;
  ui.chooseOne = async (_title, choices) => { await choices; return custom; }; ui.ask = async () => 'custom-model';
  assert.equal((await chooseModel(session('codex'), '', ui)).model, 'custom-model');
  ui.chooseOne = async (_title, choices) => { await choices; return defaultChoice; };
  assert.equal((await chooseModel(session('codex'), '', ui)).model, null);
  ui.chooseOne = async (_title, choices) => { await choices; return null; };
  assert.equal(await chooseModel(session('codex'), '', ui), null);
  assert.equal(normalizeModel(BUILTINS.deepseek, 'default'), BUILTINS.deepseek.model);
  for (const value of ['', 'two models', 'bad\x1bmodel', 'x'.repeat(201)]) assert.throws(() => normalizeModel(BUILTINS.codex, value));
});
test('provider selection prompts once for a missing DeepSeek key and keeps credentials out of model choices', async () => {
  let prompts = 0, choices;
  const ui = { interactive: true, event() {}, async secret() { prompts++; return 'fixture-deepseek-key'; }, async chooseOne(_title, items) { choices = items; return 'deepseek'; } };
  assert.equal((await chooseProvider('codex', '', ui)).id, 'deepseek');
  assert.deepEqual(choices.map(choice => choice.value), ['codex', 'claude', 'deepseek', 'abliteration', 'orcarouter', 'experiential']);
  assert.equal(prompts, 1); assert.equal(apiKey(BUILTINS.deepseek), 'fixture-deepseek-key');
  assert.doesNotMatch(JSON.stringify(choices), /fixture-deepseek-key/);
  assert.equal(fs.statSync(path.join(directory, 'private', 'credentials.json')).mode & 0o777, 0o600);
  await ensureApiKey(BUILTINS.deepseek, ui); assert.equal(prompts, 1);
  assert.equal(reasoningEffort(session('deepseek')), 'low');
  assert.equal(reasoningEffort(session('deepseek'), { goalMode: true }), undefined);
  assert.throws(() => reasoningEffort(session('deepseek'), { effort: 'medium' }), /does not support/);
});
for (const id of ['abliteration', 'orcarouter', 'experiential']) test(`${id} appears in the existing provider picker and uses hidden key setup`, async () => {
  let prompts = 0, choices;
  const ui = { interactive: true, event() {}, async secret() { prompts++; return 'synthetic-provider-key'; },
    async chooseOne(_title, items) { choices = items; return id; } };
  const provider = await chooseProvider('codex', '', ui);
  assert.equal(provider.id, id); assert.ok(choices.some(choice => choice.value === provider.id));
  assert.equal(prompts, 1); assert.equal(apiKey(provider), 'synthetic-provider-key');
  assert.doesNotMatch(JSON.stringify(choices), /synthetic-provider-key/);
  assert.equal((await chooseModel({ ...session(id) }, 'default', ui)).model, BUILTINS[id].model);
  await ensureApiKey(provider, ui); assert.equal(prompts, 1);
});
test('model effort choices retain the current setting, reject unsupported levels and configure both execution backends', async () => {
  const current = { ...session('codex'), model: 'fixture-brain', selectedEffort: 'high' };
  const ui = { async chooseOne(_title, choices) {
    const picker = await choices;
    assert.equal(picker.selectEffort, true);
    const brain = picker.choices.find(choice => choice.value === 'fixture-brain');
    assert.deepEqual(brain.efforts, ['medium', 'high', 'xhigh']); assert.equal(brain.effort, 'high');
    return { value: brain.value, effort: 'xhigh' };
  } };
  const chosen = await chooseModel(current, '', ui); assert.equal(chosen.effort, 'xhigh');
  const next = { ...current, selectedEffort: chosen.effort, modelCapabilities: chosen.capabilities, engineHome: path.join(directory, 'codex') };
  assert.equal(reasoningEffort(next, { goalMode: true, effort: 'medium' }), 'xhigh', 'the later interactive choice overrides a launch flag');
  assert.ok(codexLaunch(BUILTINS.codex, next, { goalMode: true }).args.includes('model_reasoning_effort="xhigh"'));
  const claude = { ...session('claude'), id: 'fixture-claude-session', selectedEffort: 'high', modelCapabilities: { supportedEfforts: ['medium', 'high'] } };
  const args = claudeArgs(claude, { goalMode: true }); assert.equal(args[args.indexOf('--effort') + 1], 'high');
  assert.equal(reasoningEffort({ ...next, selectedEffort: 'default' }, { effort: 'high' }), undefined);
  ui.chooseOne = async (_title, choices) => { await choices; return { value: 'fixture-light', effort: 'xhigh' }; };
  await assert.rejects(chooseModel(current, '', ui), /supported by this model/);
  const manual = await chooseModel(next, 'new-model-id', ui); assert.equal(manual.effort, null); assert.equal(manual.capabilities, null);
});

test('effort picker uses provider defaults when an API catalog omits model effort metadata', async () => {
  let picker;
  const ui = { async chooseOne(_title, choices) { picker = await choices; return picker.choices.find(choice => choice.value === 'high').value; } };
  const chosen = await chooseEffort({ provider: 'deepseek', model: 'deepseek-v4.1-flash', modelCapabilities: {}, cwd: directory }, ui);
  assert.equal(chosen.effort, 'high');
  assert.deepEqual(picker.choices.map(choice => choice.value), ['default', 'low', 'high', 'max']);
  assert.deepEqual(chosen.capabilities.supportedEfforts, ['low', 'high', 'max']);
});
test('choosing another provider opens its model and effort picker and retains the conversation', async () => {
  const source = createSession(BUILTINS.codex, directory); source.engineThreadId = 'preserved-thread';
  source.contract = { constraints: ['Preserve the source scope'] }; saveSession(source); const titles = [];
  const ui = { interactive: true, event() {}, updateSession() {}, async chooseOne(title, choices) {
    titles.push(title); const picker = await choices;
    if (Array.isArray(picker)) return 'claude';
    assert.notEqual(picker.selectEffort, true, 'header model and effort are separate dropdowns'); assert.ok(picker.choices.some(choice => choice.value === JSON.stringify(['claude', 'sonnet'])));
    return { value: JSON.stringify(['claude', 'sonnet']), effort: 'high' };
  } };
  const next = await changeConversationProvider(source, '', ui);
  assert.deepEqual(titles, ['Choose model']);
  assert.equal(next.id, source.id); assert.equal(next.provider, 'claude'); assert.equal(next.model, 'sonnet'); assert.equal(next.selectedEffort, 'high');
  assert.equal(next.engineThreadId, null); assert.notEqual(next.engineSessionId, source.id);
  assert.deepEqual(next.contract.constraints, source.contract.constraints); assert.equal(loadSession(source.id).provider, 'claude');
  assert.equal(config().defaultProvider, null);
  ui.chooseOne = async (title, choices) => { await choices; return title === 'Choose provider' ? 'codex' : null; };
  assert.equal(await changeConversationProvider(next, '', ui), null); assert.equal(config().defaultProvider, null);
});

test('changing a provider inside another mode preserves the normal chat preset', async () => {
  const normal = saveDefaultSelection({ provider: 'codex', model: 'normal-chat', selectedEffort: 'high' });
  const ui = { interactive: true, event() {}, updateSession() {}, async chooseOne(_title, choices) {
    return Array.isArray(await choices) ? 'claude' : { value: JSON.stringify(['claude', 'sonnet']), effort: 'high' };
  } };
  for (const mode of ['delegate', 'debate', 'besties']) {
    const source = createSession(BUILTINS.codex, directory); source.mode = mode; saveSession(source);
    const next = await changeConversationProvider(source, '', ui);
    assert.equal(next.provider, 'claude'); assert.equal(config().defaultProvider, 'codex');
    assert.deepEqual(defaultSelection(), normal);
  }
});
