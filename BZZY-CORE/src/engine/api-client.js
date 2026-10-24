// Browser- and Node-compatible client. Keep privileged tokens on your website's backend.
export class BzzyClient {
  constructor({ url, token, fetch: fetchImpl = globalThis.fetch }) { this.url = url.replace(/\/$/, '').replace(/\/v1$/, ''); this.token = token; this.fetch = fetchImpl; }
  async request(method, endpoint, body, requestId) {
    const response = await this.fetch(this.url + endpoint, { method, headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json', ...(requestId ? { 'idempotency-key': requestId } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const value = await response.json(); if (!response.ok) throw Object.assign(new Error(value.error || `HTTP ${response.status}`), { status: response.status, code: value.code }); return value;
  }
  health() { return this.request('GET', '/v1/health'); }
  capabilities() { return this.request('GET', '/v1/capabilities'); }
  schema() { return this.request('GET', '/v1/schema'); }
  metrics() { return this.request('GET', '/v1/metrics'); }
  sessions() { return this.request('GET', '/sessions'); }
  session(id) { return this.request('GET', `/sessions/${id}`); }
  submitInput(id, { requestId, ...input }) { return this.request('POST', `/sessions/${id}/input`, input, requestId); }
  usage(id) { return this.request('GET', `/sessions/${id}/usage`); }
  activities(id, { after = '', limit = 100 } = {}) { return this.request('GET', `/sessions/${id}/activities?after=${encodeURIComponent(after)}&limit=${limit}`); }
  traffic(id, { after = '', limit = 100 } = {}) { return this.request('GET', `/sessions/${id}/traffic?after=${encodeURIComponent(after)}&limit=${limit}`); }
  events(id, after = 0, limit = 200) { return this.request('GET', `/sessions/${id}/events?after=${after}&limit=${limit}`); }
  eventHistory(id, before = Number.MAX_SAFE_INTEGER, limit = 200) { return this.request('GET', `/sessions/${id}/events?before=${before}&limit=${limit}`); }
  claim(id, owner, takeover = false) { return this.request('POST', `/sessions/${id}/claim`, { owner, takeover }); }
  release(id, owner) { return this.request('POST', `/sessions/${id}/release`, { owner }); }
  execute(id, { owner, prompt, options = {}, goal = false, resumeGoal = false, requestId }) {
    if (!requestId) throw new Error('Execution requires a stable requestId so retries cannot duplicate work.');
    return this.request('POST', `/sessions/${id}/execute`, { owner, prompt, options, goal, resumeGoal }, requestId);
  }
  answer(id, { owner, questionId, answer, requestId }) {
    if (!requestId) throw new Error('Answer requires a stable requestId so retries cannot duplicate input.');
    return this.request('POST', `/sessions/${id}/answer`, { owner, questionId, answer }, requestId);
  }
  control(id, { owner, action, text, requestId }) {
    if (!requestId) throw new Error('Control requires a stable requestId so retries cannot duplicate commands.');
    return this.request('POST', `/sessions/${id}/control`, { owner, action, text }, requestId);
  }
  observerToken(id, expiresInSeconds = 86400) { return this.request('POST', '/tokens', { sessionId: id, expiresInSeconds }); }
  sessionToken(id, { permissions = ['observe'], recipient, expiresInSeconds = 86400, includeChildren = true } = {}) {
    return this.request('POST', '/v1/tokens', { sessionId: id, permissions, recipient, expiresInSeconds, includeChildren });
  }
  grants() { return this.request('GET', '/v1/tokens'); }
  revokeToken(grantId) { return this.request('DELETE', `/v1/tokens/${grantId}`); }
  async *stream(id, { after = 0, signal, types, reconnectDelayMs = 1000 } = {}) {
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('Event cursor must be a nonnegative integer.');
    if (!Number.isSafeInteger(reconnectDelayMs) || reconnectDelayMs < 0 || reconnectDelayMs > 30000) throw new Error('Reconnect delay must be 0–30000 ms.');
    if (types && (!Array.isArray(types) || types.some(type => typeof type !== 'string'))) throw new Error('Event types must be an array of strings.');
    let cursor = after;
    while (!signal?.aborted) {
      try {
        const response = await this.fetch(`${this.url}/sessions/${id}/events?stream=1&after=${cursor}`, { headers: { authorization: `Bearer ${this.token}`, accept: 'text/event-stream' }, signal });
        if (!response.ok) throw Object.assign(new Error(`Event stream HTTP ${response.status}`), { status: response.status });
        const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
        try {
          while (!signal?.aborted) {
            const chunk = await reader.read(); if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            let boundary;
            while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
              const frame = buffer.slice(0, boundary.index); buffer = buffer.slice(boundary.index + boundary[0].length);
              if (frame.length > 1024 * 1024) throw Object.assign(new Error('Event frame exceeds 1 MiB.'), { code: 'INVALID_EVENT' });
              const lines = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, ''));
              if (!lines.length) continue;
              let event;
              try { event = JSON.parse(lines.join('\n')); } catch { throw Object.assign(new Error('Invalid event JSON.'), { code: 'INVALID_EVENT' }); }
              if (event.sessionId !== id || !Number.isSafeInteger(event.seq) || event.seq < 1 || typeof event.type !== 'string') throw Object.assign(new Error('Invalid session event envelope.'), { code: 'INVALID_EVENT' });
              if (event.seq <= cursor) continue;
              cursor = event.seq;
              if (!types || types.some(t => event.type === t || t.endsWith('*') && event.type.startsWith(t.slice(0, -1)))) yield event;
            }
            if (buffer.length > 1024 * 1024) throw Object.assign(new Error('Event frame exceeds 1 MiB.'), { code: 'INVALID_EVENT' });
          }
        } finally { await reader.cancel().catch(() => {}); }
      } catch (error) { if (signal?.aborted) return; if (error.code === 'INVALID_EVENT' || error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) throw error; }
      if (!signal?.aborted) await new Promise(resolve => {
        const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, reconnectDelayMs); signal?.addEventListener('abort', done, { once: true });
      });
    }
  }
}
