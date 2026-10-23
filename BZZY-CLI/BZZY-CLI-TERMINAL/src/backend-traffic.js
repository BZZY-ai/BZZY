import { digest, getRecord, putRecord, appendEvent, now } from './database.js';
import { redactedUrl } from './traffic.js';

export function webToolUrl(name, input) {
  if (!/^(?:WebFetch|.*(?:browser[_/-]?(?:navigate|open)|__web_fetch))$/i.test(name || '')) return null;
  if (typeof input === 'string') { try { input = JSON.parse(input); } catch { return null; } }
  try { const url = new URL(input?.url); return ['http:', 'https:'].includes(url.protocol) ? redactedUrl(url.href) : null; }
  catch { return null; }
}

export function backendVisit(event) {
  const params = event.params || {}, item = params.item;
  if (event.method === 'tool.started') { const url = webToolUrl(params.name, params.input); return url ? { callId: params.id, tool: params.name, url } : null; }
  if (['item/started', 'item/completed'].includes(event.method)) {
    const url = item?.type === 'webSearch' && ['openPage', 'open_page'].includes(item.action?.type) ? webToolUrl('WebFetch', { url: item.action.url }) : item?.type === 'mcpToolCall' ? webToolUrl(item.tool, item.arguments) : null;
    if (url) return { callId: item.id, tool: item.type === 'webSearch' ? 'Codex web' : item.tool, url, completed: event.method === 'item/completed' };
  }
  return null;
}

// A backend tool invocation is evidence of tool activity, not a measured HTTP exchange.
export class BackendTraffic {
  constructor(session, ui) { this.session = session; this.ui = ui; this.pending = new Map(); }
  record(key, url, tool, phase = 'started', failed = false) {
    try { const parsed = new URL(url); if (!['http:', 'https:'].includes(parsed.protocol)) return; url = redactedUrl(parsed.href); }
    catch { return; }
    const id = 'backend-' + digest([this.session.id, key, url]);
    const previous = getRecord('traffic', id);
    if (previous && (previous.backendState !== 'started' || phase === 'started')) return;
    const entry = { ...previous, id, backendCallId: key, sessionId: this.session.id, provider: this.session.provider, tool,
      method: null, url, status: null, provenance: 'backend-reported', operation: 'fetch',
      backendState: failed ? 'failed' : phase, localRequestObserved: false,
      startedAt: previous?.startedAt || (phase === 'started' ? now() : null),
      ...(phase !== 'started' ? { completedAt: now(), toolDurationMs: previous?.startedAt ? Date.now() - Date.parse(previous.startedAt) : null } : {}),
    };
    putRecord('traffic', id, entry); this.ui.event('network.backend', entry);
    if (this.session.parentSessionId) appendEvent(this.session.parentSessionId, 'network.backend', { ...entry, agent: this.session.agentNamespace || this.session.provider });
    this.pending.set(key, { url, tool, id });
    if (phase !== 'started') this.pending.delete(key);
  }
  tool(id, name, input, phase = 'started', failed = false) {
    const url = webToolUrl(name, input);
    if (url) this.record(id, url, name, phase, failed);
  }
  complete(id, failed = false) { const pending = this.pending.get(id); if (pending) this.record(id, pending.url, pending.tool, 'completed', failed); }
}
