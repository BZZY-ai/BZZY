import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { BUILTINS, getProvider, providerModelCapabilities, saveKey, saveConfig, credentialStatus } from '../src/engine/providers.js';
import { availableModels } from '../src/engine/models.js';
import { createSession } from '../src/engine/store.js';
import { codexLaunch } from '../src/engine/engines/codex.js';
import { reasoningEffort } from '../src/engine/instructions.js';
import { captureEnvironment, toolEnvironment } from '../src/engine/execution-environment.js';
import { subscriptionEnvironment } from '../src/engine/auth.js';
import { providerSelection } from '../src/conversations.js';
import { CoreAssistant } from '../src/assistant.js';
import { CoreAgents } from '../src/agents.js';

let directory, previous;
const secret = 'synthetic-abliteration-credential';
test.beforeEach(() => {
  previous = { ...process.env };
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-abliteration-'));
  process.env.BZZY_HOME = path.join(directory, 'private');
  process.env.BZZY_CODEX_HOME = path.join(directory, 'codex');
  delete process.env.ABLITERATION_API_KEY;
});
test.afterEach(() => {
  for (const name of ['BZZY_HOME', 'BZZY_CODEX_HOME', 'ABLITERATION_API_KEY']) {
    if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
  }
  fs.rmSync(directory, { recursive: true, force: true });
});

test('Abliteration is Core-discovered and model-specific Responses efforts apply to coordinator setup', () => {
  const provider = getProvider('abliteration');
  assert.equal(provider.baseUrl, 'https://api.abliteration.ai/v1');
  assert.equal(provider.backend, 'codex'); assert.equal(provider.auth, 'api-key');
  assert.ok(new CoreAgents().providers().some(value => value.id === provider.id));
  const assistant = new CoreAssistant();
  assert.ok(assistant.providers().some(value => value.id === provider.id));
  const input = { source: 'core', provider: provider.id, model: 'abliterated-model-large-v2', effort: 'max' };
  assert.equal(assistant.configure(input, { requestId: randomUUID(), expectedRevision: 0 }).selection.effort, 'max');
  for (const [model, effort] of [['abliterated-model', 'max'], ['abliterated-model-large-v2', 'none'], ['abliterated-model-large-flash', 'medium']]) {
    assert.throws(() => providerSelection({ provider: provider.id, model, effort }), { code: 'INVALID_REQUEST' });
    assert.throws(() => reasoningEffort({ provider: provider.id, model, selectedEffort: effort }), /does not support/);
  }
  assert.deepEqual(providerSelection({ provider: provider.id }), { provider: provider.id, model: provider.model, effort: 'default' });
});

test('live catalog retains new models, public names and context_length while excluding unavailable models', async () => {
  const calls = [];
  const server = http.createServer((request, response) => {
    calls.push({ path: request.url, auth: request.headers.authorization });
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ object: 'list', data: [
      ...Object.keys(BUILTINS.abliteration.modelCapabilities).map(id => ({ id, display_name: `Public ${id}`, context_length: 900000, is_ready: true })),
      { id: 'future-model', display_name: 'Future model', context_length: 524288, input_modalities: ['text'], effort: { supported_levels: ['low', 'high'], default_level: 'high' } },
      { id: 'locked', access: { locked: true } }, { id: 'no-access', access: { available: false } }, { id: 'not-ready', is_ready: false }, null,
    ] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    saveConfig({ version: 1, providers: { abliteration: { ...BUILTINS.abliteration, baseUrl: `http://127.0.0.1:${server.address().port}/v1` } } });
    saveKey('abliteration', secret);
    const result = await availableModels({ provider: 'abliteration', cwd: directory });
    assert.equal(result.source, 'provider'); assert.equal(result.models.length, 5);
    assert.deepEqual(calls, [{ path: '/v1/models', auth: `Bearer ${secret}` }], 'Discovery never submits inference');
    const large = result.models.find(model => model.id === 'abliterated-model-large-v2');
    assert.equal(large.name, 'Public abliterated-model-large-v2');
    assert.deepEqual(large.capabilities.supportedEfforts, ['low', 'high', 'max']);
    assert.equal(large.capabilities.defaultEffort, 'max'); assert.equal(large.capabilities.contextWindow, 900000);
    const future = result.models.find(model => model.id === 'future-model');
    assert.equal(future.capabilities.contextWindow, 524288); assert.deepEqual(future.capabilities.supportedEfforts, ['low', 'high']);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
    assert.equal(providerModelCapabilities(BUILTINS.abliteration, large.id).contextWindow, 1000000, 'Live normalization never changes defaults');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('manual/default model launches use Responses with each model context, modalities and effort', () => {
  saveKey('abliteration', secret);
  assert.deepEqual(credentialStatus('abliteration'), { environment: false, saved: true });
  for (const [model, capabilities] of Object.entries(BUILTINS.abliteration.modelCapabilities)) {
    const provider = getProvider('abliteration'), session = createSession(provider, directory, model);
    const launch = codexLaunch(provider, session);
    const catalog = JSON.parse(fs.readFileSync(path.join(process.env.BZZY_HOME, 'runtime', `${session.id}-models.json`))).models[0];
    assert.ok(launch.args.includes('model_providers.bzzy_api.wire_api="responses"'));
    assert.ok(launch.args.includes('model_providers.bzzy_api.base_url="https://api.abliteration.ai/v1"'));
    assert.equal(catalog.context_window, capabilities.contextWindow); assert.deepEqual(catalog.input_modalities, capabilities.inputModalities);
    assert.deepEqual(catalog.supported_reasoning_levels.map(value => value.effort), capabilities.supportedEfforts);
    if (capabilities.defaultEffort) assert.equal(catalog.default_reasoning_level, capabilities.defaultEffort);
    assert.equal(launch.env.BZZY_PROVIDER_API_KEY, secret); assert.equal(launch.env.ABLITERATION_API_KEY, undefined);
    assert.doesNotMatch(JSON.stringify({ args: launch.args, catalog }), new RegExp(secret));
  }
  assert.equal(fs.statSync(path.join(process.env.BZZY_HOME, 'credentials.json')).mode & 0o777, 0o600);
});

test('Abliteration credentials reach only the selected API backend, never subscriptions or tool environments', () => {
  process.env.ABLITERATION_API_KEY = secret;
  assert.equal(captureEnvironment().ABLITERATION_API_KEY, secret);
  assert.equal(toolEnvironment().ABLITERATION_API_KEY, undefined);
  assert.equal(subscriptionEnvironment('codex').ABLITERATION_API_KEY, undefined);
  assert.equal(subscriptionEnvironment('claude').ABLITERATION_API_KEY, undefined);
  const launch = codexLaunch(BUILTINS.abliteration, createSession(BUILTINS.abliteration, directory));
  assert.equal(launch.env.BZZY_PROVIDER_API_KEY, secret); assert.equal(launch.env.ABLITERATION_API_KEY, undefined);
});

test('catalog authentication errors remain sanitized and never forward a credential through a redirect', async () => {
  let redirected = false;
  const server = http.createServer((request, response) => {
    if (request.url === '/leak') redirected = true;
    if (request.url === '/redirect/models') { response.writeHead(302, { Location: '/leak' }); response.end(); return; }
    response.writeHead(401, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: secret } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    saveKey('abliteration', secret);
    for (const prefix of ['/v1', '/redirect']) {
      saveConfig({ version: 1, providers: { abliteration: { ...BUILTINS.abliteration, baseUrl: `http://127.0.0.1:${server.address().port}${prefix}` } } });
      const result = await availableModels({ provider: 'abliteration', cwd: directory });
      assert.equal(result.source, 'manual'); assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
      if (prefix === '/v1') assert.match(result.description, /bzzy auth abliteration/);
    }
    assert.equal(redirected, false);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
