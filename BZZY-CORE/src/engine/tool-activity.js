import { diagnosticRedactor } from './diagnostic-redaction.js';

const phases = new Set(['started', 'completed', 'failed', 'stopped']);
const coreTool = name => /^mcp__bzzy_goal__|^bzzy_goal\//i.test(name || '');
const object = input => {
  if (typeof input === 'string') { try { input = JSON.parse(input); } catch { return {}; } }
  return input && typeof input === 'object' && !Array.isArray(input) ? input : {};
};
function describe(name, input, item = {}) {
  input = object(input);
  if (/(?:^|\/|__)gmail_read$/.test(name || '')) return ['Read email', input.operation === 'list' ? 'List messages' : input.operation === 'read' ? 'Read selected message' : 'Mailbox request'];
  const rawCommand = input.command || input.cmd || item.command;
  const command = Array.isArray(rawCommand) && rawCommand.every(part => typeof part === 'string') ? rawCommand.join(' ') : rawCommand;
  const file = input.file_path || input.path || input.file || input.filename;
  const url = input.url || item.action?.url;
  if (/commandExecution|^(?:bash|shell|terminal|exec_command)$/i.test(name)) return ['Terminal', command];
  if (/fileChange/i.test(name)) return ['Edit files', (Array.isArray(item.changes) ? item.changes : []).map(change => change?.path).filter(value => typeof value === 'string').join(', ')];
  if (/browser/i.test(name)) return ['Browser', input.description || input.intent || url || input.action];
  if (/webSearch/i.test(name) && url) return ['Open web', url];
  if (/webSearch|web_search|search_query/i.test(name)) return ['Web search', input.query || item.query];
  if (/webfetch|fetch_url|http_request/i.test(name)) return ['Open web', url];
  if (/read[_ ]?file|^read$|read_project_file/i.test(name)) return ['Read file', file];
  if (/write[_ ]?file|^write$/i.test(name)) return ['Write file', file];
  if (/edit|patch/i.test(name)) return ['Edit file', file];
  if (/glob|grep|search/i.test(name)) return ['Search files', input.pattern || input.query || file];
  return [String(name || 'Tool').replace(/^mcp__[^_]+__/, '').replace(/_/g, ' '), input.description || file || url || input.query || input.name || input.id];
}

// A display projection, never an execution receipt or additional model memory.
// Only a short allowlisted command/path/URL description crosses this boundary;
// file contents, outputs, cookies, environment and reasoning are never selected.
export function createToolActivityProjector({ sessionId, runId, secrets } = {}) {
  let redactor; const ignored = new Set();
  return (type, data = {}) => {
    let callId, name, input, item = {}, phase, durationMs, exitCode, provenance = 'backend-reported';
    if (type === 'backend') {
      const p = data.params || {}; item = p.item || {};
      if (['item/started', 'item/completed'].includes(data.method)) {
        if (!['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch'].includes(item.type)) return null;
        name = item.type === 'mcpToolCall' ? `${item.server || ''}/${item.tool || 'tool'}` : item.type;
        if (coreTool(name)) return null;
        callId = item.id; input = item.arguments; phase = data.method === 'item/started' ? 'started' : item.error || item.status === 'failed' || Number.isInteger(item.exitCode) && item.exitCode !== 0 ? 'failed' : 'completed';
        durationMs = item.durationMs; exitCode = item.exitCode;
      } else if (['tool.started', 'tool.completed'].includes(data.method)) {
        if (coreTool(p.name)) { ignored.add(p.id); if (ignored.size > 4096) ignored.delete(ignored.values().next().value); return null; }
        if (ignored.has(p.id)) return null;
        callId = p.id; name = p.name; input = p.input; phase = data.method === 'tool.started' ? 'started' : p.failed ? 'failed' : 'completed';
        durationMs = p.durationMs;
      } else return null;
    } else if (type === 'tool.action') {
      if (!phases.has(data.phase) || typeof data.callId !== 'string') return null;
      callId = data.callId; name = data.name; input = data.input; phase = data.phase; durationMs = data.durationMs; exitCode = data.exitCode;
      provenance = data.provenance === 'core-tool' ? 'core-tool' : 'backend-reported';
    } else return null;
    if (typeof callId !== 'string' || !callId || callId.length > 256) return null;
    const actorSessionId = data.actorSessionId || sessionId;
    const namespace = data.runId || runId || 'historical';
    const [label, detail] = type === 'tool.action' && data.label ? [data.label, data.detail] : describe(name, input, item);
    redactor ||= diagnosticRedactor({ ...(secrets ? { secrets } : {}), maxString: 2048, maxItems: 8 });
    const safe = redactor.scrub({ name, label, detail: typeof detail === 'string' ? detail : '' });
    const line = value => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1000) : '';
    return { version: 1, id: `${namespace}:${callId}`, callId, runId: namespace, actorSessionId,
      phase, name: line(safe.name), label: line(safe.label), detail: line(safe.detail), provenance,
      ...(Number.isFinite(durationMs) && durationMs >= 0 ? { durationMs } : {}), ...(Number.isInteger(exitCode) ? { exitCode } : {}),
      ...(data.occurredAt ? { occurredAt: data.occurredAt } : {}) };
  };
}
