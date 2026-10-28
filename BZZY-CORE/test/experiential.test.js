import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { BUILTINS, getProvider, providerModelCapabilities, saveKey, saveConfig, config, credentialStatus, providerEffortPolicy, providerEffortCapabilities } from '../src/engine/providers.js';
import { availableModels, modelEffortCapabilities } from '../src/engine/models.js';
import { createSession } from '../src/engine/store.js';
import { codexLaunch } from '../src/engine/engines/codex.js';
import { reasoningEffort } from '../src/engine/instructions.js';
import { captureEnvironment, toolEnvironment } from '../src/engine/execution-environment.js';
import { subscriptionEnvironment } from '../src/engine/auth.js';
import { providerSelection } from '../src/conversations.js';
import { CoreAssistant } from '../src/assistant.js';
import { CoreAgents } from '../src/agents.js';
import { backgroundModelSettings, configureBackgroundModel } from '../src/engine/background-model.js';
import { listRecords } from '../src/engine/database.js';

let directory, saved;
const secret = 'synthetic-experiential-credential';
const keys = ['BZZY_HOME', 'BZZY_CODEX_HOME', 'EXPLABS_API_KEY'];
test.beforeEach(() => {
  saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-experiential-'));
  Object.assign(process.env, { BZZY_HOME: path.join(directory, 'private'), BZZY_CODEX_HOME: path.join(directory, 'codex') });
  delete process.env.EXPLABS_API_KEY;
});
test.afterEach(() => {
  for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  fs.rmSync(directory, { recursive: true, force: true });
});
async function catalogServer(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  saveConfig({ version: 1, providers: { experiential: { ...BUILTINS.experiential, baseUrl: `http://127.0.0.1:${server.address().port}/v1` } } });
  saveKey('experiential', secret);
  return server;
}
const entry = (slug, model = {}, capabilities = {}) => ({
  model: { slug, display_name: `Public ${slug}`, status: 'active', context_window: 64000, input_modalities: ['text'], output_modalities: ['text'], supported_params: { tools: true }, ...model },
  providers: [{ id: `route-${slug}`, status: 'active', routable: true, capabilities: { supports_tools: true, supports_streaming: true, ...capabilities } }],
  default_provider_ids: [`route-${slug}`],
});

test('Experiential is Core-discovered and coordinator/background selections remain independent of terminal defaults', () => {
  const provider = getProvider('experiential'), assistant = new CoreAssistant();
  assert.equal(provider.baseUrl, 'https://api.experientiallabs.ai/v1'); assert.equal(provider.envKey, 'EXPLABS_API_KEY');
  assert.equal(provider.model, 'gpt-5.6-sol'); assert.equal(provider.auth, 'api-key');
  assert.ok(assistant.providers().some(value => value.id === provider.id));
  assert.ok(new CoreAgents().providers().some(value => value.id === provider.id));
  assert.deepEqual(providerModelCapabilities(provider, 'unknown-private-model'), {});
  saveConfig({ version: 1, defaultProvider: 'codex', providers: {} });
  assistant.configure({ source: 'core', provider: provider.id, model: provider.model, effort: 'high' }, { requestId: randomUUID(), expectedRevision: 0 });
  assert.equal(backgroundModelSettings().selection.provider, provider.id);
  configureBackgroundModel({ source: 'custom', provider: provider.id, model: 'owner-selected-background', effort: 'default' }, { expectedRevision: 0 });
  assistant.configure({ source: 'core', provider: 'claude', model: 'independent-core' }, { requestId: randomUUID(), expectedRevision: 1 });
  assert.equal(backgroundModelSettings().selection.model, 'owner-selected-background');
  assert.equal(assistant.settings().selection.model, 'independent-core'); assert.equal(config().defaultProvider, 'codex');
  assert.equal(listRecords('execution').length, 0); assert.equal(listRecords('session').length, 0);
  assert.throws(() => providerSelection({ provider: provider.id, effort: 'ultra' }), { code: 'INVALID_REQUEST' });
});

test('authenticated rich catalog pages use slugs and per-model capabilities, excluding explicit incompatible routes', async t => {
  const calls = [], rows = Array.from({ length: 50 }, (_, i) => entry(`future-${i}`));
  rows[0] = entry('gpt-5.6-sol', { context_window: 900000, input_modalities: ['text', 'image', 'pdf'] },
    { supports_reasoning: true, supported_reasoning_efforts: ['low', 'high'], reasoning_default_effort: 'low' });
  rows[1] = entry('no-thinking', {}, { supports_reasoning: false });
  rows[2] = entry('no-tools', { supported_params: { tools: false } });
  rows[3] = entry('no-stream', {}, { supports_streaming: false });
  rows[4] = entry('embedding', { output_modalities: ['embedding'] });
  rows[5] = entry('inactive', { status: 'inactive' });
  rows[6] = entry('inaccessible'); rows[6].providers[0].available_to_org = false;
  rows[7] = entry('mixed', {}, { supports_reasoning: true, supported_reasoning_efforts: ['low', 'medium', 'high'], reasoning_default_effort: 'medium' });
  rows[7].providers.push({ id: 'second-mixed', status: 'active', routable: true, capabilities: {
    supports_tools: true, supports_streaming: true, supports_reasoning: true, supported_reasoning_efforts: ['low', 'high'], reasoning_default_effort: 'high' } });
  rows[7].default_provider_ids.push('second-mixed');
  rows[8] = entry('disjoint', {}, { supports_reasoning: true, supported_reasoning_efforts: ['low'] });
  rows[8].providers.push({ id: 'second-disjoint', status: 'active', routable: true, capabilities: {
    supports_tools: true, supports_streaming: true, supports_reasoning: true, supported_reasoning_efforts: ['high'] } });
  rows[8].default_provider_ids.push('second-disjoint');
  rows[9] = entry('separate-input-output', { context_window: 1048576, max_input_tokens: 655360, max_output_tokens: 393216 });
  rows.push(entry('owner-private-model'));
  await catalogServer(t, (request, response) => {
    calls.push({ method: request.method, path: request.url, auth: request.headers.authorization });
    const url = new URL(request.url, 'http://localhost'), offset = Number(url.searchParams.get('offset'));
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ total: rows.length, offset, limit: 50, models: rows.slice(offset, offset + 50) }));
  });
  const catalog = await availableModels({ provider: 'experiential', cwd: directory });
  assert.equal(catalog.source, 'provider'); assert.equal(catalog.models.length, 46);
  assert.deepEqual(calls, [0, 50].map(offset => ({ method: 'GET', path: `/api/models?limit=50&offset=${offset}`, auth: `Bearer ${secret}` })));
  const known = catalog.models.find(model => model.id === 'gpt-5.6-sol');
  assert.equal(known.capabilities.contextWindow, 900000); assert.deepEqual(known.capabilities.inputModalities, ['text', 'image']);
  assert.deepEqual(known.capabilities.supportedEfforts, ['low', 'high']); assert.equal(known.capabilities.defaultEffort, 'low');
  assert.equal(catalog.models.find(model => model.id === 'no-thinking').capabilities.supportsEffort, false);
  const mixed = catalog.models.find(model => model.id === 'mixed');
  assert.deepEqual(mixed.capabilities.supportedEfforts, ['low', 'high']); assert.equal(mixed.capabilities.defaultEffort, undefined);
  const disjoint = catalog.models.find(model => model.id === 'disjoint');
  assert.equal(disjoint.capabilities.supportsEffort, false);
  assert.equal(reasoningEffort({ provider: 'experiential', model: disjoint.id, selectedEffort: 'high', modelCapabilities: disjoint.capabilities }), 'high', 'Gateway request controls do not claim every route implements this effort');
  assert.ok(catalog.models.some(model => model.id === 'owner-private-model'));
  const limits = catalog.models.find(model => model.id === 'separate-input-output').capabilities;
  assert.equal(limits.contextWindow, 1048576); assert.equal(limits.maxInputTokens, 655360); assert.equal(limits.maxOutputTokens, 393216);
  assert.doesNotMatch(JSON.stringify(catalog), new RegExp(secret)); assert.match(catalog.description, /checked.*each request/);
});

test('incomplete, repeated and oversized rich catalog pagination never returns a partial model list', async t => {
  let scenario = 'incomplete';
  await catalogServer(t, (request, response) => {
    const offset = Number(new URL(request.url, 'http://localhost').searchParams.get('offset'));
    const models = scenario === 'repeated' ? [entry('repeated')] : [];
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ total: scenario === 'oversized' ? 2001 : scenario === 'repeated' ? 2 : 1, offset, models }));
  });
  for (scenario of ['incomplete', 'repeated', 'oversized']) {
    const result = await availableModels({ provider: 'experiential', cwd: directory });
    assert.deepEqual(result.models, []); assert.equal(result.source, 'manual');
  }
});

test('Experiential default, discovered, non-reasoning and unknown manual launches avoid template capability leakage', () => {
  saveKey('experiential', secret);
  const provider = getProvider('experiential');
  const launchModel = (model, capabilities) => {
    const session = createSession(provider, directory, model); session.modelCapabilities = capabilities;
    session.selectedEffort = 'default';
    const launch = codexLaunch(provider, session);
    const catalog = JSON.parse(fs.readFileSync(path.join(process.env.BZZY_HOME, 'runtime', `${session.id}-models.json`))).models[0];
    assert.ok(launch.args.includes('model_providers.bzzy_api.base_url="https://api.experientiallabs.ai/v1"'));
    assert.ok(launch.args.includes('model_providers.bzzy_api.wire_api="responses"'));
    assert.ok(launch.args.includes('model_providers.bzzy_api.requires_openai_auth=false'));
    assert.equal(launch.env.BZZY_PROVIDER_API_KEY, secret); assert.equal(launch.env.EXPLABS_API_KEY, undefined);
    assert.doesNotMatch(JSON.stringify({ args: launch.args, catalog }), new RegExp(secret));
    return catalog;
  };
  const known = launchModel(provider.model);
  assert.equal(known.context_window, 1050000); assert.equal(known.default_reasoning_level, null);
  assert.deepEqual(known.supported_reasoning_levels.map(value => value.effort), ['none', 'minimal', 'low', 'medium', 'high', 'max', 'xhigh']);
  const discovered = launchModel('new-model', { contextWindow: 48000, inputModalities: ['text', 'image'], supportedEfforts: ['low', 'high'], defaultEffort: 'high' });
  assert.equal(discovered.context_window, 48000); assert.equal(discovered.default_reasoning_level, null); assert.deepEqual(discovered.input_modalities, ['text', 'image']);
  const plain = launchModel(provider.model, { supportsEffort: false });
  assert.equal(plain.default_reasoning_level, null); assert.ok(plain.supported_reasoning_levels.some(row => row.effort === 'max'));
  const manual = launchModel('unknown-private-model');
  assert.equal(manual.context_window, 32768); assert.deepEqual(manual.input_modalities, ['text']);
  assert.equal(manual.default_reasoning_level, null); assert.ok(manual.supported_reasoning_levels.some(row => row.effort === 'minimal'));
  assert.equal(reasoningEffort({ provider: 'experiential', model: 'unknown-private-model' }), undefined);
});

test('Experiential credentials are private and only reach the chosen API backend', () => {
  process.env.EXPLABS_API_KEY = secret;
  assert.equal(captureEnvironment().EXPLABS_API_KEY, secret); assert.equal(toolEnvironment().EXPLABS_API_KEY, undefined);
  assert.equal(subscriptionEnvironment('codex').EXPLABS_API_KEY, undefined); assert.equal(subscriptionEnvironment('claude').EXPLABS_API_KEY, undefined);
  saveKey('experiential', secret); assert.deepEqual(credentialStatus('experiential'), { environment: true, saved: true });
  assert.equal(fs.statSync(path.join(process.env.BZZY_HOME, 'credentials.json')).mode & 0o777, 0o600);
  assert.doesNotMatch(JSON.stringify(new CoreAssistant().providers()), new RegExp(secret));
});

test('catalog auth errors and redirects remain sanitized without sending credentials to a redirect target', async t => {
  let status = 401, leaked = false;
  await catalogServer(t, (request, response) => {
    if (request.url === '/credential-target') leaked = true;
    response.writeHead(status, status === 302 ? { Location: '/credential-target' } : { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { message: secret } }));
  });
  for (status of [401, 403, 302]) {
    const result = await availableModels({ provider: 'experiential', cwd: directory });
    assert.deepEqual(result.models, []); assert.equal(result.source, 'manual'); assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
    if (status === 401) assert.match(result.description, /bzzy auth experiential/);
  }
  assert.equal(leaked, false);
});


const manualLevels = ['none', 'minimal', 'low', 'medium', 'high', 'max'];

test('Experiential manual efforts work without catalog, authentication or fresh model metadata', async t => {
  assert.deepEqual(credentialStatus('experiential'), { environment: false, saved: false });
  assert.deepEqual((await modelEffortCapabilities({ provider: 'experiential', model: 'unverified-owner-model' })).supportedEfforts, manualLevels);
  let calls = 0;
  await catalogServer(t, (_request, response) => { calls++; response.statusCode = 503; response.end('Unavailable'); });
  const current = { provider: 'experiential', model: 'unverified-owner-model', modelCapabilities: { supportsEffort: false, supportedEfforts: [] } };
  for (const model of ['gpt-5.6-sol', 'deepseek-v4.1-flash-1017', 'unverified-owner-model']) {
    const capabilities = await modelEffortCapabilities({ ...current, model });
    assert.equal(capabilities.supportsEffort, true); assert.deepEqual(capabilities.supportedEfforts, manualLevels);
    assert.equal(capabilities.defaultEffort, undefined);
  }
  assert.equal(calls, 0); assert.equal(current.modelCapabilities.supportsEffort, false);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(modelEffortCapabilities(current, { signal: cancelled.signal }), { name: 'AbortError' });
  assert.equal(listRecords('execution').length, 0);
});

test('all six manual efforts pass through stale non-reasoning metadata into Codex without local substitution', () => {
  saveKey('experiential', secret); const provider = getProvider('experiential');
  for (const model of [provider.model, 'deepseek-v4.1-flash-1017']) for (const effort of manualLevels) {
    const session = createSession(provider, directory, model);
    session.modelCapabilities = { supportsEffort: false, supportedEfforts: ['low'] }; session.selectedEffort = effort;
    assert.equal(reasoningEffort(session), effort);
    assert.equal(providerSelection({ provider: provider.id, model, effort }).effort, effort);
    const launch = codexLaunch(provider, session);
    assert.ok(launch.args.includes('model_reasoning_effort=' + JSON.stringify(effort)));
    assert.ok(launch.args.includes('model_providers.bzzy_api.wire_api="responses"'));
    const catalog = JSON.parse(fs.readFileSync(path.join(process.env.BZZY_HOME, 'runtime', session.id + '-models.json'))).models[0];
    assert.ok(catalog.supported_reasoning_levels.some(row => row.effort === effort));
    assert.equal(catalog.default_reasoning_level, null);
  }
  assert.equal(reasoningEffort({ provider: provider.id, model: provider.model, selectedEffort: 'default' }, { effort: 'high' }), undefined);
  assert.equal(reasoningEffort({ provider: provider.id, model: provider.model }), undefined);
  assert.equal(reasoningEffort({ provider: provider.id, model: provider.model, selectedEffort: 'xhigh' }), 'xhigh', 'Previously saved xhigh remains compatible');
  assert.throws(() => reasoningEffort({ provider: provider.id, model: 'manual-model', selectedEffort: 'ultra' }), /does not support/);
  assert.equal(listRecords('execution').length, 0);
});

test('manual effort policy is confined to Experiential and does not replace other provider or model limits', async () => {
  for (const id of ['codex', 'claude', 'deepseek', 'abliteration', 'orcarouter']) {
    const provider = getProvider(id), saved = { supportsEffort: false, supportedEfforts: [] };
    assert.equal(providerEffortPolicy(provider), null);
    assert.deepEqual(providerEffortCapabilities(provider, provider.model, saved), providerModelCapabilities(provider, provider.model, saved));
    assert.throws(() => reasoningEffort({ provider: id, model: provider.model, selectedEffort: 'high', modelCapabilities: saved }), /does not support/);
  }
  assert.throws(() => providerSelection({ provider: 'deepseek', effort: 'minimal' }), { code: 'INVALID_REQUEST' });
  assert.throws(() => providerSelection({ provider: 'experiential', effort: 'ultra' }), { code: 'INVALID_REQUEST' });
  const first = await modelEffortCapabilities({ provider: 'experiential', model: 'manual-model' }); first.supportedEfforts.pop();
  assert.deepEqual((await modelEffortCapabilities({ provider: 'experiential', model: 'manual-model' })).supportedEfforts, manualLevels);
});
