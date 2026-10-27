import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { hydrateModelContext } from '../src/engine/model-context.js';
import { BUILTINS, saveConfig, saveKey, getProvider } from '../src/engine/providers.js';
import { listRecords, putRecord } from '../src/engine/database.js';
import { nativeContextBudget } from '../src/engine/native-context.js';

let directory, prior, current;
test.beforeEach(() => {
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-model-context-')));
  prior = { BZZY_HOME: process.env.BZZY_HOME, EXPLABS_API_KEY: process.env.EXPLABS_API_KEY };
  process.env.BZZY_HOME = path.join(directory, 'private'); delete process.env.EXPLABS_API_KEY;
  current = { provider: 'experiential', model: 'fixture-exact-model', cwd: directory, selectedEffort: 'max',
    goal: { id: 'retained-goal', nativeTokensUsed: 70, nativeTokenOffset: 70 } };
});
test.afterEach(() => {
  for (const [key, value] of Object.entries(prior)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  fs.rmSync(directory, { recursive: true, force: true });
});
const row = (slug, context = 96000, extra = {}) => ({ model: { slug, status: 'active', context_window: context,
  input_modalities: ['text'], output_modalities: ['text'], supported_params: { tools: true }, ...extra },
  default_provider_ids: ['fixture-route'], providers: [{ id: 'fixture-route', status: 'active', routable: true,
    capabilities: { supports_tools: true, supports_streaming: true } }] });
async function localCatalog(t, respond = () => [row(current.model)]) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    requests.push({ url: request.url, authorization: Boolean(request.headers.authorization) });
    const result = await respond(request, response);
    if (!response.writableEnded) { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ models: result, total: result.length, offset: 0 })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const provider = { ...BUILTINS.experiential, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
  saveConfig({ version: 1, providers: { experiential: provider } }); saveKey('experiential', 'synthetic-context-fixture-key');
  return { requests, provider };
}

test('an old exact-model session hydrates public context before planning and preserves goal/model/effort', async t => {
  const { requests } = await localCatalog(t), before = structuredClone(current);
  assert.equal(nativeContextBudget(getProvider(current.provider), current).source, 'conservative-local-fallback');
  const result = await hydrateModelContext(current);
  assert.equal(result.changed, true); assert.equal(result.provenance.source, 'provider-catalog');
  assert.equal(current.modelCapabilities.contextWindow, 96000);
  assert.equal(nativeContextBudget(getProvider(current.provider), current).tokens, 96000);
  const { modelCapabilities, ...retained } = current; assert.deepEqual(retained, before);
  assert.deepEqual(requests, [{ url: '/api/models?limit=50&offset=0', authorization: true }]);
  const cached = listRecords('core.model.context'); assert.equal(cached.length, 1);
  assert.doesNotMatch(JSON.stringify(cached), /127\.0\.0\.1|synthetic-context-fixture-key|Authorization|baseUrl|envKey/);
});

test('usable saved/configured context never fetches and exact successful cache is reused', async t => {
  const { requests } = await localCatalog(t);
  await hydrateModelContext(current); assert.equal(requests.length, 1);
  const second = { ...current, modelCapabilities: null }, cached = await hydrateModelContext(second);
  assert.equal(cached.provenance.source, 'cached-provider-catalog'); assert.equal(second.modelCapabilities.contextWindow, 96000); assert.equal(requests.length, 1);
  current.modelCapabilities = { contextWindow: 48000, supportsEffort: false };
  assert.equal((await hydrateModelContext(current)).changed, false); assert.equal(requests.length, 1);
  current.model = BUILTINS.experiential.model; current.modelCapabilities = null;
  assert.equal((await hydrateModelContext(current)).provenance.source, 'configured-model-capability'); assert.equal(requests.length, 1);
});

test('other slugs, invalid context and catalog errors retain fallback with a bounded negative cooldown', async t => {
  let scenario = 'other'; const { requests } = await localCatalog(t, (_request, response) => {
    if (scenario === 'failure') { response.statusCode = 503; response.end('private provider failure body'); return []; }
    return [row(scenario === 'other' ? 'different-model' : current.model, null)];
  });
  const missing = await hydrateModelContext(current); assert.equal(missing.changed, false); assert.equal(missing.provenance.reason, 'model-not-listed');
  assert.equal(nativeContextBudget(getProvider(current.provider), current).tokens, 32768);
  assert.equal((await hydrateModelContext(current)).provenance.source, 'catalog-cooldown'); assert.equal(requests.length, 1);
  for (const record of listRecords('core.model.context')) putRecord('core.model.context', record.id, { ...record, fetchedAtMs: Date.now() - 61000 });
  scenario = 'invalid'; const invalid = await hydrateModelContext(current); assert.equal(invalid.provenance.reason, 'context-unreported'); assert.equal(requests.length, 2);
  for (const record of listRecords('core.model.context')) putRecord('core.model.context', record.id, { ...record, fetchedAtMs: Date.now() - 61000 });
  scenario = 'failure'; const failed = await hydrateModelContext(current); assert.equal(failed.provenance.reason, 'catalog-unavailable');
  assert.doesNotMatch(JSON.stringify(failed) + JSON.stringify(listRecords('core.model.context')), /private provider failure body|synthetic-context-fixture-key/);
});

test('stale successful cache refreshes, and a different provider dispatch cannot inherit it', async t => {
  const { requests, provider } = await localCatalog(t);
  await hydrateModelContext(current); current.modelCapabilities = null;
  const record = listRecords('core.model.context')[0]; putRecord('core.model.context', record.id, { ...record, fetchedAtMs: Date.now() - 301000 });
  await hydrateModelContext(current); assert.equal(requests.length, 2);
  current.modelCapabilities = null;
  saveConfig({ version: 1, providers: { experiential: { ...provider, baseUrl: provider.baseUrl.replace('/v1', '/different-dispatch') } } });
  assert.equal((await hydrateModelContext(current)).provenance.source, 'provider-catalog'); assert.equal(requests.length, 3);
  assert.equal(listRecords('core.model.context').length, 2);
});

test('source selection and BZZY_HOME changes during lookup cannot apply or cross-persist metadata', async t => {
  let mutate = () => { current.model = 'owner-selected-next-model'; };
  await localCatalog(t, () => { const models = [row('fixture-exact-model')]; mutate(); return models; });
  assert.equal((await hydrateModelContext(current)).provenance.source, 'source-changed'); assert.equal(current.modelCapabilities, undefined);
  current.model = 'fixture-exact-model';
  const originalHome = process.env.BZZY_HOME, otherHome = path.join(directory, 'other-private');
  mutate = () => { process.env.BZZY_HOME = otherHome; };
  // Force a fresh lookup instead of a cache hit from the first exact identity.
  for (const record of listRecords('core.model.context')) putRecord('core.model.context', record.id, { ...record, fetchedAtMs: Date.now() - 301000 });
  const result = await hydrateModelContext(current);
  assert.equal(result.provenance.source, 'source-changed'); assert.equal(current.modelCapabilities, undefined);
  assert.deepEqual(listRecords('core.model.context'), []);
  process.env.BZZY_HOME = originalHome;
});

test('timeout and cancellation remain bounded and never become an enlarged context estimate', async t => {
  await localCatalog(t, async (_request, response) => { await new Promise(resolve => setTimeout(resolve, 100)); if (!response.destroyed) return [row(current.model)]; return []; });
  const start = performance.now(), timed = await hydrateModelContext(current, { timeoutMs: 10 });
  assert.equal(timed.changed, false); assert.ok(performance.now() - start < 1000); assert.equal(current.modelCapabilities, undefined);
  const controller = new AbortController(); controller.abort();
  assert.equal((await hydrateModelContext(current, { signal: controller.signal })).provenance.source, 'cancelled');
});
