// Public, exact-model capability discovery. This is not inference and does not
// receive an account key or follow a provider-supplied URL.
const maximumBytes = 256 * 1024;
const positive = value => Number.isSafeInteger(value) && value > 0 && value <= 1000000000;
const unavailable = (reason, fallbackAllowed = false) => ({ capabilities: {}, reason, fallbackAllowed });

export async function exactPublicModelContext(provider, model, { signal } = {}) {
  if (provider.catalogFormat !== 'experiential') return null;
  if (typeof model !== 'string' || !model || model.length > 200 || ['.', '..'].includes(model) || /[\s\x00-\x1f\x7f-\x9f]/u.test(model)) return unavailable('model-not-listed');
  let url;
  try {
    const base = new URL(provider.baseUrl);
    if (base.username || base.password || base.search || base.hash ||
        base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))) return unavailable('catalog-unavailable');
    url = new URL('/api/models/' + encodeURIComponent(model), base);
    if (url.origin !== base.origin) return unavailable('catalog-unavailable');
  } catch { return unavailable('catalog-unavailable'); }
  try {
    const response = await fetch(url, { method: 'GET', redirect: 'error', credentials: 'omit', headers: { Accept: 'application/json' }, signal });
    if (!response.ok) {
      await response.body?.cancel();
      return unavailable(response.status === 404 ? 'model-not-listed' : 'catalog-unavailable', [401, 403, 404, 405, 501].includes(response.status));
    }
    const chunks = []; let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > maximumBytes) return unavailable('catalog-response-too-large');
      chunks.push(chunk);
    }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const entry = value?.model && typeof value.model === 'object' ? value.model : value;
    if (!entry || entry.slug !== model) return unavailable('model-mismatch');
    if (entry.status && entry.status !== 'active') return unavailable('model-not-listed');
    if (!positive(entry.context_window)) return unavailable('context-unreported', true);
    return { capabilities: { contextWindow: entry.context_window,
      ...(positive(entry.max_input_tokens) && entry.max_input_tokens <= entry.context_window ? { maxInputTokens: entry.max_input_tokens } : {}),
      ...(positive(entry.max_output_tokens) && entry.max_output_tokens <= entry.context_window ? { maxOutputTokens: entry.max_output_tokens } : {}),
      ...(Array.isArray(entry.input_modalities) ? { inputModalities: [...new Set(entry.input_modalities.filter(item => ['text', 'image'].includes(item)))] } : {}) },
      lookup: 'public-exact-model' };
  } catch { return unavailable(signal?.aborted ? 'catalog-timeout-or-cancelled' : 'catalog-unavailable'); }
}
