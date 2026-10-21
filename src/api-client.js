// Browser- and Node-compatible client. Keep privileged tokens on your website's backend.
export class BzzyClient {
  constructor({ url, token, fetch: fetchImpl = globalThis.fetch }) { this.url = url.replace(/\/$/, ''); this.token = token; this.fetch = fetchImpl; }
  async request(method, endpoint, body, requestId) {
    const response = await this.fetch(this.url + endpoint, { method, headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json', ...(requestId ? { 'idempotency-key': requestId } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const value = await response.json(); if (!response.ok) throw Object.assign(new Error(value.error || `HTTP ${response.status}`), { status: response.status, code: value.code }); return value;
  }
  sessions() { return this.request('GET', '/sessions'); }
  session(id) { return this.request('GET', `/sessions/${id}`); }
  usage(id) { return this.request('GET', `/sessions/${id}/usage`); }
  activities(id) { return this.request('GET', `/sessions/${id}/activities`); }
  traffic(id) { return this.request('GET', `/sessions/${id}/traffic`); }
  events(id, after = 0, limit = 200) { return this.request('GET', `/sessions/${id}/events?after=${after}&limit=${limit}`); }
  claim(id, owner, takeover = false) { return this.request('POST', `/sessions/${id}/claim`, { owner, takeover }); }
  release(id, owner) { return this.request('POST', `/sessions/${id}/release`, { owner }); }
  execute(id, { owner, prompt, options = {}, goal = false, resumeGoal = false, requestId }) {
    if (!requestId) throw new Error('Execution requires a stable requestId so retries cannot duplicate work.');
    return this.request('POST', `/sessions/${id}/execute`, { owner, prompt, options, goal, resumeGoal }, requestId);
  }
  answer(id, { owner, questionId, answer, requestId }) { return this.request('POST', `/sessions/${id}/answer`, { owner, questionId, answer }, requestId); }
  control(id, { owner, action, text, requestId }) { return this.request('POST', `/sessions/${id}/control`, { owner, action, text }, requestId); }
  observerToken(id, expiresInSeconds = 86400) { return this.request('POST', '/tokens', { sessionId: id, expiresInSeconds }); }
  async *stream(id, { after = 0, signal, types } = {}) {
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
            while ((boundary = buffer.indexOf('\n\n')) >= 0) {
              const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
              const line = frame.split('\n').find(l => l.startsWith('data: ')); if (!line) continue;
              const event = JSON.parse(line.slice(6)); if (event.seq <= cursor) continue;
              cursor = event.seq;
              if (!types || types.some(t => event.type === t || t.endsWith('*') && event.type.startsWith(t.slice(0, -1)))) yield event;
            }
          }
        } finally { await reader.cancel().catch(() => {}); }
      } catch (error) { if (signal?.aborted) return; if ([401, 403, 404].includes(error.status)) throw error; }
      if (!signal?.aborted) await new Promise(resolve => { const timer = setTimeout(resolve, 1000); signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true }); });
    }
  }
}
