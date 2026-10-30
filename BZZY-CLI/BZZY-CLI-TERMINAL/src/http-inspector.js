import { clean, cellWidth, clip, wrap } from './terminal-format.js';
import { palette } from './terminal-theme.js';
import { fillSurface } from './terminal-surface.js';
import { sectionHeading } from './workspace-header.js';
import { diagnosticRedactor } from '@bzzy/core/engine/diagnostic-redaction.js';
import { redactedHeaders, redactedUrl } from '@bzzy/core/engine/traffic.js';

export const httpMethodTone = method => method === 'POST' ? palette.tool : /^(PUT|PATCH)$/.test(method) ? palette.agent : method === 'DELETE' ? palette.danger : palette.accent;
export const httpStatusTone = status => status >= 500 ? palette.danger : status >= 400 ? palette.warning : status >= 300 ? '#5B8CFF' : status >= 200 ? palette.success : palette.muted;
const jsonTokens = /"(?:\\.|[^"\\])*"(?=\s*:)|"(?:\\.|[^"\\])*"|\b(?:true|false|null)\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g;
function jsonLine(line, theme) {
  let result = '', offset = 0;
  for (const match of line.matchAll(jsonTokens)) {
    result += theme.color(line.slice(offset, match.index), palette.muted);
    const token = match[0], key = /^"/.test(token) && /^\s*:/.test(line.slice(match.index + token.length));
    result += theme.color(token, key ? palette.accent : /^"/.test(token) ? palette.success : palette.agent);
    offset = match.index + token.length;
  }
  return result + theme.color(line.slice(offset), palette.muted);
}

// These are views of captured fields only. Unknown wire versions and absent
// bodies never become reconstructed requests or fabricated response payloads.
export function httpExchange(row, width, theme) {
  const c = theme.color, scrub = diagnosticRedactor({ maxString: 8192, maxItems: 256, maxFields: 256 }).scrub;
  const request = [], response = [], copies = { request: [], response: [] };
  function put(section, text, tone = palette.text, format) {
    const safe = clean(text), target = section === 'request' ? request : response;
    copies[section].push(safe);
    for (const line of wrap(safe, width)) target.push(format ? format(line, theme) : c(line, tone));
  }
  function headers(section, values) {
    put(section, 'HEADERS', palette.muted);
    for (const [name, value] of Object.entries(redactedHeaders(values || {}))) {
      const key = clip(name, Math.max(1, width - 2)) + ': ', text = clean(scrub(String(value)));
      copies[section].push(key + text);
      const rows = wrap(key + text, width);
      for (const [index, line] of rows.entries()) {
        if (index) (section === 'request' ? request : response).push(c(line, palette.text));
        else (section === 'request' ? request : response).push(c(line.slice(0, key.length), palette.accent) + c(line.slice(key.length), palette.text));
      }
    }
  }
  function body(section, value, bytes, hash) {
    put(section, ''); put(section, 'BODY', palette.muted);
    if (typeof value === 'string') {
      let parsed;
      try { if (value.length <= 131072) parsed = JSON.parse(value); } catch { /* Non-JSON bodies retain their actual text. */ }
      if (parsed !== undefined) put(section, JSON.stringify(scrub(parsed), null, 2), palette.text, jsonLine);
      else put(section, scrub(value));
    } else {
      put(section, bytes === 0 ? 'Empty body' : 'Body not captured', palette.muted);
      if (Number.isSafeInteger(bytes) && bytes > 0) put(section, bytes.toLocaleString() + ' bytes', palette.muted);
      if (typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash)) put(section, 'SHA-256 ' + hash, palette.muted);
    }
  }
  let url; try { url = redactedUrl(row.url); } catch { url = '[invalid URL]'; }
  put('request', `${row.method || '?'}  ${url}`, httpMethodTone(row.method));
  put('request', ''); headers('request', row.requestHeaders);
  body('request', row.requestPreview, row.requestBytes, row.requestBodySha256);
  put('response', row.status ? String(row.status) + (Number.isFinite(row.durationMs) ? `  ·  ${row.durationMs} ms` : '')
    : row.type === 'network.error' ? 'Request failed' : 'Awaiting response', row.type === 'network.error' ? palette.danger : httpStatusTone(row.status));
  if (row.captureNote) put('response', scrub(row.captureNote), palette.warning);
  if (row.message) put('response', scrub(row.message), palette.danger);
  put('response', ''); headers('response', row.responseHeaders);
  body('response', row.responsePreview, row.responseBytes, row.responseBodySha256);
  if (row.evidence) put('response', 'Evidence: ' + scrub(String(row.evidence)), palette.muted);
  return { request, response, copy: { request: copies.request.join('\n'), response: copies.response.join('\n') } };
}

export function httpExchangeLayout(exchange, width, height, theme, offsets = {}) {
  const lines = [], hits = [], regions = [], maxima = {}, c = theme.color;
  const requestHeight = Math.floor(height / 2);
  for (const [section, size] of [['request', requestHeight], ['response', height - requestHeight]]) {
    if (size < 2) { for (let i = 0; i < size; i++) lines.push(''); continue; }
    const top = lines.length, bodyHeight = size - 2, content = exchange[section], maximum = Math.max(0, content.length - bodyHeight);
    const start = Math.min(maximum, Math.max(0, offsets[section] || 0)); offsets[section] = start; maxima[section] = maximum;
    const copy = 'Copy', tone = section === 'request' ? palette.accent : palette.agent;
    lines.push(sectionHeading(section.toUpperCase(), width, theme, tone, copy));
    hits.push({ type: 'monitor-http-copy', section, row: top + 1, left: Math.max(1, width - copy.length - 2), right: width - 1 });
    for (let i = 0; i < bodyHeight; i++) {
      const mark = maximum && i === Math.round((bodyHeight - 1) * start / maximum) ? '┃' : '│';
      lines.push(c('│', palette.border) + fillSurface(content[start + i] || '', width - 2, theme, palette.background, palette.text) + c(mark, palette.border));
    }
    const tail = clip(` ${content.length ? start + 1 : 0}–${Math.min(content.length, start + bodyHeight)}/${content.length} · scroll ↕ `, width - 4);
    lines.push(c('└─' + tail + '─'.repeat(Math.max(0, width - cellWidth(tail) - 3)) + '┘', palette.border));
    regions.push({ section, left: 1, right: width, top: top + 1, bottom: top + size });
  }
  return { lines, hits, regions, maxima };
}
