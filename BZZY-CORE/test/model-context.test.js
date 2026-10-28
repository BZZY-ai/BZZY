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
import { createSession, saveSession } from '../src/engine/store.js';
import { newConversation } from '../src/engine/host-commands.js';

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
    if (!response.writableEnded) {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(request.url.startsWith('/api/models/') ? result[0] || {} : { models: result, total: result.length, offset: 0 }));
    }
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
  const { modelCapabilities, modelContextMetadata, ...retained } = current; assert.deepEqual(retained, before);
  assert.equal(modelContextMetadata.provider, 'experiential'); assert.equal(modelContextMetadata.model, current.model);
  assert.match(modelContextMetadata.dispatchIdentity, /^[a-f0-9]{64}$/);
  assert.deepEqual(requests, [{ url: '/api/models/fixture-exact-model', authorization: false }]);
  assert.equal(result.provenance.lookup, 'public-exact-model');
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
  const missing = await hydrateModelContext(current); assert.equal(missing.changed, false); assert.equal(missing.provenance.reason, 'model-mismatch');
  assert.equal(nativeContextBudget(getProvider(current.provider), current).tokens, 32768);
  assert.equal((await hydrateModelContext(current)).provenance.source, 'catalog-cooldown'); assert.equal(requests.length, 1);
  for (const record of listRecords('core.model.context')) putRecord('core.model.context', record.id, { ...record, fetchedAtMs: Date.now() - 61000 });
  scenario = 'invalid'; const invalid = await hydrateModelContext(current); assert.equal(invalid.provenance.reason, 'context-unreported'); assert.equal(requests.length, 3);
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
  const { requests } = await localCatalog(t, async (_request, response) => { await new Promise(resolve => setTimeout(resolve, 100)); if (!response.destroyed) return [row(current.model)]; return []; });
  const start = performance.now(), timed = await hydrateModelContext(current, { timeoutMs: 10 });
  assert.equal(timed.changed, false); assert.ok(performance.now() - start < 1000); assert.equal(current.modelCapabilities, undefined);
  const controller = new AbortController(); controller.abort();
  assert.equal((await hydrateModelContext(current, { signal: controller.signal })).provenance.source, 'cancelled');
  assert.ok(requests.length <= 1, 'A timed-out public request must not begin an authenticated fallback');
});

test('startup resolves only the selected public model and tolerates a response beyond the old total catalog budget', async t => {
  const { requests } = await localCatalog(t, async (request, response) => {
    assert.equal(request.url, '/api/models/fixture-exact-model', 'Startup must not enumerate every paginated catalog entry');
    await new Promise(resolve => setTimeout(resolve, 1650));
    return [row(current.model, 123456)];
  });
  const result = await hydrateModelContext(current);
  assert.equal(result.changed, true); assert.equal(current.modelCapabilities.contextWindow, 123456);
  assert.equal(result.provenance.lookup, 'public-exact-model');
  assert.deepEqual(requests, [{ url: '/api/models/fixture-exact-model', authorization: false }]);
});

test('a legacy full-catalog failure does not suppress the new exact public lookup', async t => {
  const { requests } = await localCatalog(t);
  await hydrateModelContext(current); current.modelCapabilities = null;
  const cached = listRecords('core.model.context')[0];
  putRecord('core.model.context', cached.id, { ...cached, status: 'unavailable', capabilities: undefined, lookup: undefined, reason: 'catalog-unavailable' });
  const result = await hydrateModelContext(current);
  assert.equal(result.changed, true); assert.equal(requests.length, 2);
  assert.equal(current.modelCapabilities.contextWindow, 96000);
});

test('public metadata redirects are refused without forwarding an account key', async t => {
  let redirectedRequests = 0;
  const destination = http.createServer((_request, response) => { redirectedRequests++; response.end('{}'); });
  await new Promise(resolve => destination.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => destination.close(resolve)));
  const { requests } = await localCatalog(t, (_request, response) => {
    response.statusCode = 302; response.setHeader('Location', `http://127.0.0.1:${destination.address().port}/private-catalog`); response.end(); return [];
  });
  const result = await hydrateModelContext(current);
  assert.equal(result.changed, false); assert.equal(redirectedRequests, 0);
  assert.equal(requests.length, 1, 'A redirect must not begin an authenticated fallback');
  assert.equal(requests[0].authorization, false); assert.equal(current.modelCapabilities, undefined);
});

test('oversized or mismatched public detail cannot become native context or stored provider text', async t => {
  const privateBody = 'synthetic-private-provider-body';
  const { requests } = await localCatalog(t, (_request, response) => {
    response.end(JSON.stringify({ model: { slug: current.model, context_window: 1000000 }, padding: privateBody.repeat(16000) })); return [];
  });
  const result = await hydrateModelContext(current);
  assert.equal(result.changed, false); assert.equal(current.modelCapabilities, undefined);
  assert.equal(nativeContextBudget(getProvider(current.provider), current).tokens, 32768);
  assert.equal(requests.length, 1, 'An oversized response must not begin an authenticated fallback');
  assert.equal(requests[0].authorization, false);
  assert.doesNotMatch(JSON.stringify(result) + JSON.stringify(listRecords('core.model.context')), /synthetic-private-provider-body/);
});

test('declared input and output limits remain separate from the selected model total context', async t => {
  await localCatalog(t, () => [row(current.model, 1048576, { max_input_tokens: 655360, max_output_tokens: 393216 })]);
  await hydrateModelContext(current);
  assert.equal(current.modelCapabilities.contextWindow, 1048576);
  assert.equal(current.modelCapabilities.maxInputTokens, 655360);
  assert.equal(current.modelCapabilities.maxOutputTokens, 393216);
  assert.equal(nativeContextBudget(getProvider(current.provider), current).tokens, 1048576, 'Metadata must not silently rewrite native total capacity semantics');
});

for (const status of [401, 403, 404, 405, 501]) test(`unavailable public detail (${status}) can use its authenticated organization catalog within the same deadline`, async t => {
  const { requests } = await localCatalog(t, (request, response) => {
    if (request.url.startsWith('/api/models/')) { response.statusCode = status; response.end('{}'); return []; }
    return [row(current.model, 64000)];
  });
  const result = await hydrateModelContext(current);
  assert.equal(current.modelCapabilities.contextWindow, 64000);
  assert.equal(result.provenance.lookup, 'public-exact-model-then-provider-catalog');
  assert.deepEqual(requests.map(item => item.authorization), [false, true], 'Only the existing organization catalog route receives its private credential');
  assert.equal(requests[1].url, '/api/models?limit=50&offset=0');
});

test('derived capacity respects TTL and dispatch/model changes without clearing session capabilities', async t => {
  let capacity = 96000;
  const { requests, provider } = await localCatalog(t, () => [row(current.model, capacity)]);
  await hydrateModelContext(current);
  const cached = listRecords('core.model.context')[0];
  putRecord('core.model.context', cached.id, { ...cached, fetchedAtMs: Date.now() - 301000 });
  capacity = 72000;
  await hydrateModelContext(current);
  assert.equal(current.modelCapabilities.contextWindow, 72000); assert.equal(requests.length, 2);
  saveConfig({ version: 1, providers: { experiential: { ...provider, baseUrl: provider.baseUrl.replace('/v1', '/different-dispatch') } } });
  capacity = 48000;
  await hydrateModelContext(current);
  assert.equal(current.modelCapabilities.contextWindow, 48000); assert.equal(requests.length, 3);
  current.model = 'another-exact-slug'; capacity = 64000;
  await hydrateModelContext(current);
  assert.equal(current.modelCapabilities.contextWindow, 64000); assert.equal(requests.length, 4);
  assert.equal(current.modelContextMetadata.model, 'another-exact-slug');
  current.modelCapabilities.contextWindow = 32000;
  await hydrateModelContext(current);
  assert.equal(current.modelCapabilities.contextWindow, 32000); assert.equal(requests.length, 4, 'A later explicit owner cap must remain authoritative');
  assert.equal(current.modelContextMetadata, undefined);
});

test('organization fallback shares the public lookup deadline rather than starting a second budget', async t => {
  const { requests } = await localCatalog(t, async (request, response) => {
    await new Promise(resolve => setTimeout(resolve, 80));
    if (response.destroyed) return [];
    if (request.url.startsWith('/api/models/')) { response.statusCode = 404; response.end('{}'); return []; }
    return [row(current.model, 64000)];
  });
  const start = performance.now(), result = await hydrateModelContext(current, { timeoutMs: 120 });
  assert.equal(result.changed, false); assert.equal(current.modelCapabilities, undefined);
  assert.ok(performance.now() - start < 250, 'Fallback cannot receive another complete 120ms budget');
  assert.deepEqual(requests.map(item => item.authorization), [false, true]);
});

test('cancelled and changed-source lookups cannot strip previously hydrated session metadata', async t => {
  let mutate = () => {};
  await localCatalog(t, () => { const result = [row('fixture-exact-model')]; mutate(); return result; });
  await hydrateModelContext(current);
  const before = structuredClone(current), cached = listRecords('core.model.context')[0];
  putRecord('core.model.context', cached.id, { ...cached, fetchedAtMs: Date.now() - 301000 });
  const controller = new AbortController(); controller.abort();
  assert.equal((await hydrateModelContext(current, { signal: controller.signal })).changed, false);
  assert.deepEqual(current, before);
  mutate = () => { current.model = 'concurrently-selected-model'; };
  const result = await hydrateModelContext(current);
  assert.equal(result.provenance.source, 'source-changed'); assert.equal(result.changed, false);
  assert.deepEqual(current.modelCapabilities, before.modelCapabilities);
  assert.deepEqual(current.modelContextMetadata, before.modelContextMetadata);
});

test('expired derived capacity is invalidated on catalog failure while owner fields survive', async t => {
  let failed = false;
  await localCatalog(t, (_request, response) => {
    if (failed) { response.statusCode = 503; response.end('{}'); return []; }
    return [row(current.model)];
  });
  current.modelCapabilities = { supportsEffort: false };
  await hydrateModelContext(current);
  const cached = listRecords('core.model.context')[0];
  putRecord('core.model.context', cached.id, { ...cached, fetchedAtMs: Date.now() - 301000 });
  failed = true;
  const result = await hydrateModelContext(current);
  assert.equal(result.changed, true); assert.equal(result.provenance.reason, 'catalog-unavailable');
  assert.deepEqual(current.modelCapabilities, { supportsEffort: false });
  assert.equal(current.modelContextMetadata, undefined);
  assert.equal(nativeContextBudget(getProvider(current.provider), current).tokens, 32768);
});

test('a concurrent explicit capacity equal to old derived metadata remains owner selected', async t => {
  let mutate = () => {};
  const { requests } = await localCatalog(t, () => { mutate(); return [row(current.model, 72000)]; });
  await hydrateModelContext(current);
  const cached = listRecords('core.model.context')[0];
  putRecord('core.model.context', cached.id, { ...cached, fetchedAtMs: Date.now() - 301000 });
  mutate = () => { current.modelCapabilities = { contextWindow: 72000 }; current.modelContextMetadata = null; };
  await hydrateModelContext(current);
  assert.deepEqual(current.modelCapabilities, { contextWindow: 72000 }); assert.equal(current.modelContextMetadata, null);
  await hydrateModelContext(current, { maxAgeMs: 0 });
  assert.equal(requests.length, 2, 'The explicit selection cannot be retagged as dynamic discovery');
});

test('new conversations retain derived provenance for TTL and dispatch refresh without weakening explicit caps', async t => {
  let capacity = 96000;
  const { requests, provider } = await localCatalog(t, () => [row('fixture-exact-model', capacity)]);
  current = createSession(getProvider('experiential'), directory, 'fixture-exact-model');
  await hydrateModelContext(current); saveSession(current);
  const next = newConversation(current, { cwd: directory });
  assert.deepEqual(next.modelContextMetadata, current.modelContextMetadata);
  assert.notEqual(next.modelContextMetadata, current.modelContextMetadata, 'Derived provenance is copied, not shared mutable state');
  const cached = listRecords('core.model.context')[0];
  putRecord('core.model.context', cached.id, { ...cached, fetchedAtMs: Date.now() - 301000 });
  capacity = 72000;
  await hydrateModelContext(next);
  assert.equal(next.modelCapabilities.contextWindow, 72000); assert.equal(requests.length, 2);
  assert.equal(current.modelCapabilities.contextWindow, 96000);
  saveConfig({ version: 1, providers: { experiential: { ...provider, baseUrl: provider.baseUrl.replace('/v1', '/next-dispatch') } } });
  capacity = 64000;
  await hydrateModelContext(next);
  assert.equal(next.modelCapabilities.contextWindow, 64000); assert.equal(requests.length, 3);
  const explicit = createSession(getProvider('experiential'), directory, 'fixture-exact-model');
  explicit.modelCapabilities = { contextWindow: 32000 }; saveSession(explicit);
  const ownerSelected = newConversation(explicit, { cwd: directory });
  assert.equal(ownerSelected.modelContextMetadata, undefined);
  assert.equal((await hydrateModelContext(ownerSelected, { maxAgeMs: 0 })).provenance.source, 'saved-model-capability');
  assert.equal(ownerSelected.modelCapabilities.contextWindow, 32000); assert.equal(requests.length, 3);
});
