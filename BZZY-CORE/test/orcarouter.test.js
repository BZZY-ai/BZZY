import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { BUILTINS, getProvider, saveKey, saveConfig } from '../src/engine/providers.js';
import { availableModels } from '../src/engine/models.js';
import { createSession } from '../src/engine/store.js';
import { codexLaunch } from '../src/engine/engines/codex.js';
import { captureEnvironment, toolEnvironment } from '../src/engine/execution-environment.js';
import { subscriptionEnvironment } from '../src/engine/auth.js';
import { providerSelection } from '../src/conversations.js';
import { CoreAssistant } from '../src/assistant.js';
import { CoreAgents } from '../src/agents.js';
import { CoreWorkspaces } from '../src/workspaces.js';

let directory, saved;
const secret = 'synthetic-orcarouter-credential';
const keys = ['BZZY_HOME', 'BZZY_CODEX_HOME', 'ORCAROUTER_API_KEY'];
test.beforeEach(() => {
  saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-orcarouter-'));
  Object.assign(process.env, { BZZY_HOME: path.join(directory, 'private'), BZZY_CODEX_HOME: path.join(directory, 'codex') });
  delete process.env.ORCAROUTER_API_KEY;
});
test.afterEach(() => {
  for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  fs.rmSync(directory, { recursive: true, force: true });
});
async function catalogServer(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  saveConfig({ version: 1, providers: { orcarouter: { ...BUILTINS.orcarouter, baseUrl: `http://127.0.0.1:${server.address().port}/v1` } } });
  saveKey('orcarouter', secret);
}

test('OrcaRouter defaults to Cyber Zero 1.5 and remains independent from CLI and coordinator defaults', () => {
  const provider = getProvider('orcarouter'), assistant = new CoreAssistant();
  assert.equal(provider.baseUrl, 'https://api.orcarouter.ai/v1'); assert.equal(provider.model, 'orca/orcacyber-zero-1.5');
  assert.ok(assistant.providers().some(value => value.id === provider.id));
  assert.ok(new CoreAgents().providers().some(value => value.id === provider.id));
  assert.equal(assistant.settings().configured, false, 'Provider discovery never changes the Core default');
  assistant.configure({ source: 'core', provider: provider.id, model: 'orca/orcacyber-ultra-1.0', effort: 'high' }, { requestId: randomUUID(), expectedRevision: 0 });
  assert.equal(assistant.settings().selection.model, 'orca/orcacyber-ultra-1.0');
  assert.throws(() => providerSelection({ provider: provider.id, model: provider.model, effort: 'ultra' }), { code: 'INVALID_REQUEST' });
});

test('authenticated discovery puts current and future Cyber models first and keeps the same order across mobile pages', async t => {
  const calls = [];
  await catalogServer(t, (request, response) => {
    calls.push({ path: request.url, auth: request.headers.authorization });
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ object: 'list', data: [
      { id: 'openai/general-chat', context_length: 262144, supported_endpoint_types: ['openai'], architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] } },
      { id: 'orca/orcacyber-zero-1.0', supported_endpoint_types: ['openai'] },
      { id: 'orca/orcacyber-ultra-1.0', supported_endpoint_types: ['openai'] },
      { id: 'orca/orcacyber-next', name: 'Future Cyber', context_length: 524288, effort: { supported_levels: ['low', 'high'], default_level: 'high' } },
      { id: 'custom/security-model', required_tier: 'sec-uncensored' },
      { id: 'orca/orcacyber-zero-1.5', display_name: 'OrcaCyber Zero 1.5', context_length: 999000 },
      { id: 'orca/orcacyber-locked', locked: true }, { id: 'other/locked', access: { available: false } },
      { id: 'other/image', supported_endpoint_types: ['image-generation'] },
      { id: 'other/embedding', supported_endpoint_types: ['embeddings'] },
      { id: 'other/audio', architecture: { output_modalities: ['audio'] } },
    ] }));
  });
  const catalog = await availableModels({ provider: 'orcarouter', cwd: directory });
  assert.equal(catalog.source, 'provider'); assert.equal(catalog.models.length, 6);
  assert.equal(catalog.models[0].id, BUILTINS.orcarouter.model); assert.equal(catalog.models.at(-1).id, 'openai/general-chat');
  assert.equal(catalog.models[0].capabilities.contextWindow, 999000, 'Live metadata overrides the documented fallback');
  const future = catalog.models.find(model => model.id === 'orca/orcacyber-next');
  assert.equal(future.capabilities.category, 'cyber'); assert.deepEqual(future.capabilities.supportedEfforts, ['low', 'high']);
  assert.deepEqual(catalog.models.at(-1).capabilities.inputModalities, ['text', 'image']);
  assert.match(catalog.description, /Cyber models first/);
  const project = path.join(directory, 'projects'); fs.mkdirSync(project);
  new CoreWorkspaces().configure({ path: project }, { requestId: randomUUID(), expectedRevision: 0 });
  const agents = new CoreAgents(), first = await agents.models('orcarouter', { limit: 2 });
  const second = await agents.models('orcarouter', { after: first.nextCursor, limit: 2 });
  assert.deepEqual([...first.models, ...second.models].map(model => model.id), catalog.models.slice(0, 4).map(model => model.id));
  assert.ok(calls.every(call => call.path === '/v1/models' && call.auth === `Bearer ${secret}`), 'Discovery neither submits inference nor fetches a public catalog as account authorization');
  assert.doesNotMatch(JSON.stringify(catalog), new RegExp(secret));
});

test('a key without listed Cyber models gets an access explanation and no invented entitled models', async t => {
  await catalogServer(t, (_request, response) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ data: [{ id: 'openai/general-chat' }] })); });
  const catalog = await availableModels({ provider: 'orcarouter', cwd: directory });
  assert.deepEqual(catalog.models.map(model => model.id), ['openai/general-chat']);
  assert.match(catalog.description, /No Cyber models.*Security Research/);
  assert.equal(catalog.models.some(model => model.id === BUILTINS.orcarouter.model), false);
});

test('Cyber launches use Responses and documented context while isolating the key from subscriptions, tools and public configuration', () => {
  process.env.ORCAROUTER_API_KEY = secret;
  assert.equal(captureEnvironment().ORCAROUTER_API_KEY, secret);
  assert.equal(toolEnvironment().ORCAROUTER_API_KEY, undefined);
  assert.equal(subscriptionEnvironment('codex').ORCAROUTER_API_KEY, undefined);
  assert.equal(subscriptionEnvironment('claude').ORCAROUTER_API_KEY, undefined);
  for (const [model, capabilities] of Object.entries(BUILTINS.orcarouter.modelCapabilities)) {
    const session = createSession(BUILTINS.orcarouter, directory, model), launch = codexLaunch(BUILTINS.orcarouter, session);
    const catalog = JSON.parse(fs.readFileSync(path.join(process.env.BZZY_HOME, 'runtime', `${session.id}-models.json`))).models[0];
    assert.equal(launch.env.BZZY_PROVIDER_API_KEY, secret); assert.equal(launch.env.ORCAROUTER_API_KEY, undefined);
    assert.ok(launch.args.includes('model_providers.bzzy_api.base_url="https://api.orcarouter.ai/v1"'));
    assert.ok(launch.args.includes('model_providers.bzzy_api.wire_api="responses"'));
    assert.equal(catalog.context_window, capabilities.contextWindow); assert.deepEqual(catalog.input_modalities, ['text']);
    assert.deepEqual(catalog.supported_reasoning_levels.map(value => value.effort), capabilities.supportedEfforts);
    assert.doesNotMatch(JSON.stringify({ args: launch.args, catalog }), new RegExp(secret));
  }
});

test('catalog access denial and credential failures never produce Cyber fallbacks or expose provider messages', async t => {
  let status = 403;
  await catalogServer(t, (_request, response) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { code: 'tier_not_granted', message: secret } })); });
  for (status of [403, 401]) {
    const result = await availableModels({ provider: 'orcarouter', cwd: directory });
    assert.equal(result.source, 'manual'); assert.deepEqual(result.models, []);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
    if (status === 401) assert.match(result.description, /bzzy auth orcarouter/);
  }
});
