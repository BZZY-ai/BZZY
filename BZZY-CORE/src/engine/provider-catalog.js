import { providerSelection } from '../conversations.js';
import { availableModels, sortModelCatalog } from './models.js';
import { providers } from './providers.js';
import { fail } from '../validation.js';

export async function providerModels(provider, { after, limit = 25, cwd } = {}) {
  const selection = providerSelection({ provider });
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25 || after !== undefined && (typeof after !== 'string' || after.length > 200 || /[\s\x00-\x1f\x7f-\x9f]/u.test(after))) fail('INVALID_REQUEST', 'Invalid model page.');
  const catalog = await availableModels({ ...selection, cwd }, { timeoutMs: 8000 });
  const all = sortModelCatalog(catalog.models, providers()[provider]);
  const start = after === undefined ? 0 : all.findIndex(model => model.id === after) + 1;
  if (after !== undefined && !start) fail('INVALID_CURSOR', 'The model catalog changed. Reload before continuing.');
  const selected = all.slice(start, start + limit), hasMore = start + selected.length < all.length;
  return { ...catalog, hasMore, nextCursor: hasMore ? selected.at(-1).id : null, models: selected.map(model => ({ id: model.id,
      ...(typeof model.name === 'string' ? { name: model.name.slice(0, 160) } : {}),
      ...(model.capabilities ? { capabilities: { ...model.capabilities, supportedEfforts: model.capabilities.supportedEfforts?.slice(0, 12) } } : {}) })) };
}
