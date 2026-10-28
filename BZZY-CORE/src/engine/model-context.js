import { availableModels } from './models.js';
import { getProvider, providerModelCapabilities } from './providers.js';
import { getRecord, putRecord, digest } from './database.js';
import { home } from './files.js';
import { exactPublicModelContext } from './model-context-metadata.js';

const KIND = 'core.model.context', positive = value => Number.isSafeInteger(value) && value > 0 && value <= 1000000000;
const successTtl = 300000, failureCooldown = 60000;
const dispatch = provider => digest({ id: provider.id, backend: provider.backend, auth: provider.auth,
  baseUrl: provider.baseUrl || null, catalogFormat: provider.catalogFormat || null, envKey: provider.envKey || null });
function publicCapabilities(value) {
  const result = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  if (positive(value.contextWindow)) result.contextWindow = value.contextWindow;
  if (positive(value.maxInputTokens)) result.maxInputTokens = value.maxInputTokens;
  if (positive(value.maxOutputTokens)) result.maxOutputTokens = value.maxOutputTokens;
  if (typeof value.supportsEffort === 'boolean') result.supportsEffort = value.supportsEffort;
  if (Array.isArray(value.supportedEfforts)) result.supportedEfforts = [...new Set(value.supportedEfforts.filter(level => typeof level === 'string' && /^[a-z][a-z0-9_-]{0,23}$/.test(level)))].slice(0, 24);
  if (typeof value.defaultEffort === 'string' && /^[a-z][a-z0-9_-]{0,23}$/.test(value.defaultEffort)) result.defaultEffort = value.defaultEffort;
  if (Array.isArray(value.inputModalities)) result.inputModalities = [...new Set(value.inputModalities.filter(item => ['text', 'image'].includes(item)))];
  if (typeof value.category === 'string' && /^[a-z][a-z0-9_-]{0,39}$/.test(value.category)) result.category = value.category;
  return result;
}
function derivedMetadata(value) {
  return value?.version === 1 && typeof value.provider === 'string' && typeof value.model === 'string' &&
    typeof value.dispatchIdentity === 'string' && /^[a-f0-9]{64}$/.test(value.dispatchIdentity) &&
    value.fields && typeof value.fields === 'object' && !Array.isArray(value.fields);
}
function withoutDerived(capabilities, metadata) {
  const result = { ...capabilities };
  if (derivedMetadata(metadata)) for (const [key, value] of Object.entries(publicCapabilities(metadata.fields))) {
    if (digest(result[key] ?? null) === digest(value)) delete result[key];
  }
  return result;
}

// Exact-model public catalog metadata only. This never requests inference,
// changes a selected model/effort/goal, or promotes a local estimate to a
// measured upstream guarantee. Call before native planning at a runner boundary.
export async function hydrateModelContext(session, { signal, timeoutMs = 8000, maxAgeMs = successTtl } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000 || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0 || maxAgeMs > successTtl) throw new Error('Use bounded model-context discovery budgets.');
  const provider = getProvider(session.provider), model = session.model || provider.model, hostHome = home(), identity = dispatch(provider);
  const original = publicCapabilities(session.modelCapabilities), previous = session.modelContextMetadata;
  const existing = withoutDerived(original, previous), previousIdentity = digest(previous ?? null);
  const configured = publicCapabilities(providerModelCapabilities(provider, model));
  // Derived fields are not owner overrides. Re-enter the pinned cache/TTL path
  // on every startup, and remove only values still owned by the old lookup.
  // A later owner edit of a field survives metadata invalidation.
  const invalidate = capabilities => {
    if (derivedMetadata(previous) && digest(session.modelContextMetadata ?? null) === previousIdentity) {
      session.modelCapabilities = Object.keys(capabilities).length ? capabilities : null;
      delete session.modelContextMetadata;
    }
    return digest(original) !== digest(capabilities);
  };
  if (signal?.aborted) return { capabilities: original,
    provenance: { source: 'cancelled', provider: provider.id, model: model || null, upstreamVerified: false }, changed: false };
  if (existing.contextWindow || configured.contextWindow) return { capabilities: { ...configured, ...existing },
    provenance: { source: existing.contextWindow ? 'saved-model-capability' : 'configured-model-capability', provider: provider.id, model, upstreamVerified: false }, changed: invalidate(existing) };
  if (provider.auth !== 'api-key' || typeof model !== 'string' || !model || model.length > 200) return { capabilities: existing,
    provenance: { source: 'native-or-unselected-model', provider: provider.id, model: model || null, upstreamVerified: false }, changed: invalidate(existing) };
  const id = digest([identity, model]), cached = getRecord(KIND, id), at = Date.now(), age = cached ? at - cached.fetchedAtMs : Infinity;
  let result, source;
  const currentLookup = provider.catalogFormat !== 'experiential' || cached?.status === 'available' ||
    typeof cached?.lookup === 'string' && cached.lookup.startsWith('public-exact-model');
  if (cached?.version === 1 && currentLookup && cached.dispatchIdentity === identity && cached.model === model && age >= 0 &&
      (cached.status === 'available' && age < Math.min(successTtl, maxAgeMs) || cached.status === 'unavailable' && age < failureCooldown)) {
    result = cached; source = cached.status === 'available' ? 'cached-provider-catalog' : 'catalog-cooldown';
  } else {
    try {
      // A selected model must not wait for every page of a gateway's complete
      // catalog. The recognized public detail route never receives API keys.
      const bounded = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
      const deadline = Date.now() + timeoutMs;
      const exact = await exactPublicModelContext(provider, model, { signal: bounded });
      const remaining = deadline - Date.now();
      const fallback = Boolean(exact?.fallbackAllowed && !bounded.aborted && remaining > 0);
      const catalog = exact === null || fallback ? await availableModels({ ...session, provider: provider.id, model },
        { signal: bounded, timeoutMs: Math.max(1, Math.min(timeoutMs, remaining)) }) : null;
      const matched = catalog?.source === 'provider' && catalog.models?.find(item => item.id === model);
      const capabilities = publicCapabilities(exact?.capabilities?.contextWindow ? exact.capabilities : matched?.capabilities);
      result = { id, version: 1, provider: provider.id, model, dispatchIdentity: identity, fetchedAtMs: Date.now(),
        status: capabilities.contextWindow ? 'available' : 'unavailable',
        ...(exact ? { lookup: fallback ? 'public-exact-model-then-provider-catalog' : 'public-exact-model' } : {}),
        ...(capabilities.contextWindow ? { capabilities } : { reason: catalog ? catalog.source !== 'provider' ? 'catalog-unavailable' : matched ? 'context-unreported' : 'model-not-listed' : exact?.reason || 'catalog-unavailable' }) };
    } catch { result = { id, version: 1, provider: provider.id, model, dispatchIdentity: identity, fetchedAtMs: Date.now(), status: 'unavailable', reason: 'catalog-unavailable' }; }
    source = result.status === 'available' ? 'provider-catalog' : result.reason;
    // A cancelled caller is not an observation that this model has no metadata.
    if (home() === hostHome && !signal?.aborted) putRecord(KIND, id, result);
  }
  let current;
  try { current = getProvider(session.provider); } catch { /* Selection/configuration changed while discovery yielded. */ }
  if (home() !== hostHome || !current || session.provider !== provider.id || (session.model || current.model) !== model || dispatch(current) !== identity || signal?.aborted) return { capabilities: publicCapabilities(session.modelCapabilities),
    provenance: { source: signal?.aborted ? 'cancelled' : 'source-changed', provider: provider.id, model, upstreamVerified: false }, changed: false };
  // Only invalidate derived fields after the source and caller are still valid.
  // A concurrent owner edit survives, including a fresh explicit selection
  // whose marker was cleared even when its capacity equals the old value.
  const sameMetadata = digest(session.modelContextMetadata ?? null) === previousIdentity;
  const latest = sameMetadata ? withoutDerived(publicCapabilities(session.modelCapabilities), previous) : publicCapabilities(session.modelCapabilities);
  if (latest.contextWindow) return { capabilities: latest,
    provenance: { source: 'saved-model-capability', provider: provider.id, model, upstreamVerified: false }, changed: invalidate(latest) };
  const discovered = result.status === 'available' ? publicCapabilities(result.capabilities) : {};
  const fields = Object.fromEntries(Object.entries(discovered).filter(([key]) => !Object.hasOwn(latest, key)));
  const capabilities = { ...discovered, ...latest };
  const changed = digest(original) !== digest(capabilities);
  if (result.status === 'available') {
    session.modelCapabilities = capabilities;
    session.modelContextMetadata = { version: 1, provider: provider.id, model, dispatchIdentity: identity,
      fetchedAtMs: result.fetchedAtMs, lookup: result.lookup || 'provider-catalog', fields };
  } else invalidate(capabilities);
  return { capabilities, provenance: { source, provider: provider.id, model, cacheId: id, fetchedAt: new Date(result.fetchedAtMs).toISOString(),
    ...(result.lookup ? { lookup: result.lookup } : {}),
    ...(result.reason ? { reason: result.reason } : {}), upstreamVerified: false }, changed };
}
