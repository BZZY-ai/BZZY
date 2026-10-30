import { BzzyClient, home, runtime, requireNode, reserveRequest, getRecord, putRecord, transaction, now } from './engine.js';
import { fail, uuid, opaque } from './validation.js';
import { conversationInput, insertConversation, conversationExport } from './conversations.js';

// A privileged LOCAL host API. Never hand this object to a model or remote client.
export class BzzyCore {
  #home;
  #client;
  #info;
  constructor() { requireNode(); this.#home = home(); }
  #check() {
    if (home() !== this.#home) fail('HOST_CONTEXT_CHANGED', 'BZZY_HOME changed after Core initialization. Use a separate process for each host.', 409);
  }
  async #connection() {
    this.#check();
    const info = await (await runtime()).ensureRuntime();
    this.#check();
    this.#info = info;
    this.#client = new BzzyClient({ url: `${info.url}/v1`, token: info.token });
    return this.#client;
  }
  async start() {
    const client = await this.#connection();
    const health = await client.request('GET', '/health');
    // Owner tokens and environment fingerprints never leave the host adapter.
    return { running: true, version: health.version, apiVersion: health.apiVersion };
  }
  async status() {
    this.#check();
    const { runtimeInfo, runtimeRequest } = await runtime(), info = runtimeInfo();
    if (!info) return { running: false };
    try {
      const health = await runtimeRequest(info, 'GET', '/health');
      return { running: true, version: health.version, apiVersion: health.apiVersion };
    } catch { return { running: false, recorded: true }; }
  }
  createConversation(input, { requestId } = {}) {
    this.#check();
    const normalized = conversationInput(input);
    const result = reserveRequest('core:conversation:create', requestId, normalized, db => {
      const session = insertConversation(normalized, db);
      return { sessionId: session.id };
    });
    // This compatibility export is recoverable; replay never resets live state.
    return conversationExport(result.sessionId);
  }
  async sessions() { return (await this.#connection()).sessions(); }
  async submitJob(input) { return (await this.#connection()).submitJob(input); }
  async jobs(options) { return (await this.#connection()).jobs(options); }
  async job(id) { return (await this.#connection()).job(uuid(id)); }
  async jobLogs(id, options) { return (await this.#connection()).jobLogs(uuid(id), options); }
  async jobEvents(id, options) { return (await this.#connection()).jobEvents(uuid(id), options); }
  async cancelJob(id, options) { return (await this.#connection()).cancelJob(uuid(id), options); }
  async session(id) { return (await this.#connection()).session(uuid(id)); }
  async deleteConversation(id, { requestId } = {}) { return (await this.#connection()).deleteConversation(uuid(id), { requestId }); }
  async usage(id) { return (await this.#connection()).usage(uuid(id)); }
  async events(id, after = 0, limit = 200) { return (await this.#connection()).events(uuid(id), after, limit); }
  async claim(id, owner, takeover = false) { return (await this.#connection()).claim(uuid(id), owner, takeover); }
  async release(id, owner) { return (await this.#connection()).release(uuid(id), owner); }
  async execute(id, { owner, prompt, options = {}, goal = false, resumeGoal = false, requestId }) {
    uuid(id);
    if (!requestId) fail('INVALID_REQUEST', 'Execution requires a stable requestId so retries cannot duplicate work.');
    await this.#connection();
    // Use the terminal's host request path: it captures this caller's allowlisted
    // environment and retries accepted commands only with the same request ID.
    return (await runtime()).runtimeRequest(this.#info, 'POST', `/v1/sessions/${id}/execute`, { owner, prompt, options, goal, resumeGoal }, requestId);
  }
  async answer(id, input) { return (await this.#connection()).answer(uuid(id), input); }
  async control(id, input) { return (await this.#connection()).control(uuid(id), input); }
  async grantSession(input) { return (await this.#connection()).request('POST', '/tokens', input); }
  async revokeSession(id) { return (await this.#connection()).request('DELETE', `/tokens/${uuid(id)}`); }

  processedCursor(consumerId, sessionId) {
    this.#check(); opaque(consumerId, 'Consumer ID'); uuid(sessionId);
    return getRecord('core.cursor', `${consumerId}:${sessionId}`)?.seq || 0;
  }
  async processEvents(sessionId, { consumerId, handle, limit = 200, signal } = {}) {
    this.#check(); uuid(sessionId); opaque(consumerId, 'Consumer ID');
    if (typeof handle !== 'function') fail('INVALID_REQUEST', 'An event handler is required.');
    const key = `${consumerId}:${sessionId}`, after = this.processedCursor(consumerId, sessionId);
    const page = await this.events(sessionId, after, limit);
    let cursor = after, processed = 0;
    for (const event of page.events) {
      if (signal?.aborted) break;
      if (event.sessionId !== sessionId || !Number.isSafeInteger(event.seq) || event.seq <= cursor || event.id !== `${sessionId}:${event.seq}`) fail('INVALID_EVENT', 'The engine returned an invalid event envelope.');
      await handle(event);
      this.#check();
      transaction(db => {
        const current = getRecord('core.cursor', key)?.seq || 0;
        if (current !== cursor) fail('CURSOR_CONFLICT', 'Another consumer changed this cursor. Use one processor per consumer/session.', 409);
        putRecord('core.cursor', key, { consumerId, sessionId, seq: event.seq, updatedAt: now() }, db);
      });
      cursor = event.seq; processed++;
    }
    return { processed, nextCursor: cursor, hasMore: page.hasMore || processed < page.events.length };
  }
}
