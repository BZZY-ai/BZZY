import { availableModels } from './models.js';
import { getProvider, providerModelCapabilities } from './providers.js';
import { getRecord, putRecord, digest } from './database.js';
import { home } from './files.js';

const KIND = 'core.model.context', positive = value => Number.isSafeInteger(value) && value > 0 && value <= 1000000000;
const successTtl = 300000, failureCooldown = 60000;
const dispatch = provider => digest({ id: provider.id, backend: provider.backend, auth: provider.auth,
  baseUrl: provider.baseUrl || null, catalogFormat: provider.catalogFormat || null, envKey: provider.envKey || null });
function publicCapabilities(value) {
  const result = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  if (positive(value.contextWindow)) result.contextWindow = value.contextWindow;
  if (typeof value.supportsEffort === 'boolean') result.supportsEffort = value.supportsEffort;
  if (Array.isArray(value.supportedEfforts)) result.supportedEfforts = [...new Set(value.supportedEfforts.filter(level => typeof level === 'string' && /^[a-z][a-z0-9_-]{0,23}$/.test(level)))].slice(0, 24);
  if (typeof value.defaultEffort === 'string' && /^[a-z][a-z0-9_-]{0,23}$/.test(value.defaultEffort)) result.defaultEffort = value.defaultEffort;
  if (Array.isArray(value.inputModalities)) result.inputModalities = [...new Set(value.inputModalities.filter(item => ['text', 'image'].includes(item)))];
  if (typeof value.category === 'string' && /^[a-z][a-z0-9_-]{0,39}$/.test(value.category)) result.category = value.category;
  return result;
}

// Exact-model public catalog metadata only. This never requests inference,
// changes a selected model/effort/goal, or promotes a local estimate to a
// measured upstream guarantee. Call before native planning at a runner boundary.
export async function hydrateModelContext(session, { signal, timeoutMs = 1500, maxAgeMs = successTtl } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000 || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0 || maxAgeMs > successTtl) throw new Error('Use bounded model-context discovery budgets.');
  const provider = getProvider(session.provider), model = session.model || provider.model, hostHome = home(), identity = dispatch(provider);
  const existing = publicCapabilities(session.modelCapabilities), configured = publicCapabilities(providerModelCapabilities(provider, model));
  if (existing.contextWindow || configured.contextWindow) return { capabilities: { ...configured, ...existing },
    provenance: { source: existing.contextWindow ? 'saved-model-capability' : 'configured-model-capability', provider: provider.id, model, upstreamVerified: false }, changed: false };
  if (provider.auth !== 'api-key' || typeof model !== 'string' || !model || model.length > 200 || signal?.aborted) return { capabilities: existing,
    provenance: { source: signal?.aborted ? 'cancelled' : 'native-or-unselected-model', provider: provider.id, model: model || null, upstreamVerified: false }, changed: false };
  const id = digest([identity, model]), cached = getRecord(KIND, id), at = Date.now(), age = cached ? at - cached.fetchedAtMs : Infinity;
  let result, source;
  if (cached?.version === 1 && cached.dispatchIdentity === identity && cached.model === model && age >= 0 &&
      (cached.status === 'available' && age < Math.min(successTtl, maxAgeMs) || cached.status === 'unavailable' && age < failureCooldown)) {
    result = cached; source = cached.status === 'available' ? 'cached-provider-catalog' : 'catalog-cooldown';
  } else {
    try {
      const catalog = await availableModels({ ...session, provider: provider.id, model }, { signal, timeoutMs });
      const matched = catalog.source === 'provider' && catalog.models?.find(item => item.id === model), capabilities = publicCapabilities(matched?.capabilities);
      result = { id, version: 1, provider: provider.id, model, dispatchIdentity: identity, fetchedAtMs: Date.now(),
        status: capabilities.contextWindow ? 'available' : 'unavailable',
        ...(capabilities.contextWindow ? { capabilities } : { reason: catalog.source !== 'provider' ? 'catalog-unavailable' : matched ? 'context-unreported' : 'model-not-listed' }) };
    } catch { result = { id, version: 1, provider: provider.id, model, dispatchIdentity: identity, fetchedAtMs: Date.now(), status: 'unavailable', reason: 'catalog-unavailable' }; }
    source = result.status === 'available' ? 'provider-catalog' : result.reason;
    // A cancelled caller is not an observation that this model has no metadata.
    if (home() === hostHome && !signal?.aborted) putRecord(KIND, id, result);
  }
  let current;
  try { current = getProvider(session.provider); } catch { /* Selection/configuration changed while discovery yielded. */ }
  if (home() !== hostHome || !current || session.provider !== provider.id || (session.model || current.model) !== model || dispatch(current) !== identity || signal?.aborted) return { capabilities: publicCapabilities(session.modelCapabilities),
    provenance: { source: signal?.aborted ? 'cancelled' : 'source-changed', provider: provider.id, model, upstreamVerified: false }, changed: false };
  // A concurrent owner selection may have supplied authoritative local metadata.
  if (positive(session.modelCapabilities?.contextWindow)) return { capabilities: publicCapabilities(session.modelCapabilities),
    provenance: { source: 'saved-model-capability', provider: provider.id, model, upstreamVerified: false }, changed: false };
  const latest = publicCapabilities(session.modelCapabilities);
  const capabilities = result.status === 'available' ? { ...latest, ...publicCapabilities(result.capabilities) } : latest;
  const changed = result.status === 'available' && digest(latest) !== digest(capabilities);
  if (changed) session.modelCapabilities = capabilities;
  return { capabilities, provenance: { source, provider: provider.id, model, cacheId: id, fetchedAt: new Date(result.fetchedAtMs).toISOString(),
    ...(result.reason ? { reason: result.reason } : {}), upstreamVerified: false }, changed };
}
