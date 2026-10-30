import { clean, clip, cellWidth, wrap } from './terminal-format.js';
import { palette } from './terminal-theme.js';
import { diagnosticRedactor } from '@bzzy/core/engine/diagnostic-redaction.js';
import { redactedUrl, redactedHeaders } from '@bzzy/core/engine/traffic.js';

const identityColors = [palette.accent, palette.main, palette.agent, palette.tool, palette.success, palette.warning, '#5B8CFF'];
export function actorColor(actor) {
  if (actor.role === 'main') return palette.main;
  const name = actor.name || actor.key || '';
  if (/idor/i.test(name)) return palette.accent;
  if (/xss/i.test(name)) return palette.main;
  if (/auth/i.test(name)) return palette.agent;
  if (/\bjs\b|javascript/i.test(name)) return palette.tool;
  let hash = 0; for (const char of name) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return identityColors[hash % identityColors.length];
}
const time = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : '--:--';
const methodTone = method => /^(POST)$/.test(method) ? palette.tool : /^(PUT|PATCH)$/.test(method) ? palette.agent : method === 'DELETE' ? palette.danger : palette.accent;
const statusTone = status => status >= 500 ? palette.danger : status >= 400 ? palette.warning : status >= 300 ? '#5B8CFF' : status >= 200 ? palette.success : palette.muted;
const syntax = /(?:\/\/[^\n]*|#[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:import|from|export|const|let|var|async|await|function|return|if|else|for|while|class|new|def|in|try|catch|throw|public|private|func|package|use|fn|true|false|null|None|self)\b|\b[A-Za-z_$][\w$]*(?=\s*\())/g;
export function highlightSource(text, theme) {
  const source = clean(text).replaceAll('\t', '  '); let offset = 0, result = '';
  for (const match of source.matchAll(syntax)) {
    result += theme.color(source.slice(offset, match.index), palette.text);
    const token = match[0], tone = /^(\/\/|#)/.test(token) ? palette.muted : /^["'`]/.test(token) ? palette.success : /\w\s*\(/.test(source.slice(match.index, match.index + token.length + 3)) ? palette.agent : palette.accent;
    result += theme.color(token, tone); offset = match.index + token.length;
  }
  return result + theme.color(source.slice(offset), palette.text);
}

export class ActivityMonitor {
  constructor({ now = () => performance.now(), revealMs = 650 } = {}) {
    this.feed = []; this.files = new Map(); this.commands = new Map(); this.commandChars = 0; this.pending = new Map(); this.seen = new Set(); this.revision = 0;
    this.offsets = { agents: 0, http: 0, code: 0, source: 0, command: 0 }; this.collapsed = new Set(); this.maxima = {}; this.followCode = true;
    this.redactor = null;
    this.now = now; this.revealMs = revealMs;
  }
  scrub(value) { this.redactor ||= diagnosticRedactor({ maxString: 4096, maxItems: 32 }); return this.redactor.scrub(value); }
  event(type, data, actors, sessionId) {
    if (data.seq != null) { const key = `${data.eventSessionId || sessionId}:${data.seq}`; if (this.seen.has(key)) return; this.seen.add(key); if (this.seen.size > 4096) this.seen.delete(this.seen.values().next().value); }
    if (type === 'network.capture' && typeof data.enabled === 'boolean') { this.captureEnabled = data.enabled; this.captureUnavailable = data.reason === 'unavailable'; this.revision++; return; }
    if (type === 'command.observed' && typeof data.command === 'string' && typeof data.callId === 'string') {
      const key = `${data.actorSessionId || sessionId}:${data.runId || ''}:${data.callId}`, previous = this.commands.get(key);
      const command = clean(data.command).slice(0, 256 * 1024);
      this.commandChars += command.length - (previous?.command.length || 0);
      this.commands.set(key, { ...previous, ...data, key, command, at: previous?.at || data.occurredAt || data.observedAt });
      while (this.commands.size > 500 || this.commandChars > 8 * 1024 * 1024) { const first = this.commands.keys().next().value; this.commandChars -= this.commands.get(first).command.length; this.commands.delete(first); }
      if (!previous && this.offsets.code) this.offsets.code++;
      this.revision++; return;
    }
    if (['source.changed', 'source.delta'].includes(type) && typeof data.path === 'string') {
      const key = `${data.actorSessionId || sessionId}:${data.sourceId || data.path}`, previous = this.files.get(key);
      if (type === 'source.delta') {
        const prior = previous?.sourceText || '';
        if (!Number.isSafeInteger(data.revision) || data.revision <= 0 || !Number.isSafeInteger(data.replaceFrom) || data.replaceFrom < 0 || data.replaceFrom > prior.length || typeof data.text !== 'string' || previous?.streamRevision >= data.revision) return;
        data = { ...data, content: prior.slice(0, data.replaceFrom) + data.text, streamRevision: data.revision };
      }
      const lines = typeof data.content === 'string' ? clean(data.content).split('\n').slice(0, 5000) : previous?.lines || [];
      const changed = new Set();
      if (typeof data.content === 'string' && previous?.lines) for (let i = 0; i < lines.length; i++) if (lines[i] !== previous.lines[i]) changed.add(i);
      const file = { ...previous, ...data, key, sourceText: typeof data.content === 'string' ? data.content.slice(0, 256 * 1024) : previous?.sourceText, lines, changed, clipped: typeof data.content === 'string' && data.content.split('\n').length > 5000 };
      if (type === 'source.delta') { file.revealAt = null; file.revealPending = false; }
      else if (typeof data.content === 'string' && file.sourceText !== previous?.sourceText) {
        let common = 0;
        while (common < (previous?.sourceText?.length || 0) && common < file.sourceText.length && previous.sourceText[common] === file.sourceText[common]) common++;
        // Event replay/polling can take longer than a reveal. Start its clock
        // when CODE is actually painted, so a batch cannot consume every frame.
        file.revealFrom = common; file.revealAt = null; file.revealPending = this.followCode;
      }
      delete file.content;
      this.files.delete(key); this.files.set(key, file);
      if (this.files.size > 24) this.files.delete(this.files.keys().next().value);
      if (this.followCode || !this.activeFile) this.activeFile = key;
      else if (this.activeFile === key && previous) this.offsets.source = Math.max(0, this.offsets.source + lines.length - previous.lines.length);
      this.revision++; return;
    }
  }
  invocation(entry, data = {}) {
    if (!entry || entry.kind !== 'invocation') return;
    const id = entry.invocationId || entry.assignmentId;
    if (!id) return;
    const previous = this.feed.find(row => row.id === id);
    if (previous) { previous.entry = entry; previous.summary = entry.name; return; }
    this.feed.unshift({ id, entry, actorId: entry.actorSessionId, kind: entry.invocationType,
      summary: entry.name, at: data.occurredAt || data.createdAt || entry.createdAt, type: entry.invocationType === 'skill' ? 'skill.loaded' : 'agent.invoked' });
    if (this.feed.length > 1500) this.feed.length = 1500;
    if (this.offsets.agents) this.offsets.agents++;
    this.revision++;
  }
  requests(traffic) {
    // Native web visits carry no measured method/status. Keep them in the
    // existing HTTP history; never turn them into synthetic probe requests.
    let rows = traffic.filter(row => ['host-observed', 'proxy-observed'].includes(row.provenance) || row.localRequestObserved === true);
    if (this.httpFilter === 'errors') rows = rows.filter(row => row.status >= 400 || row.type === 'network.error');
    else if (this.httpFilter && this.httpFilter !== 'all') rows = rows.filter(row => row.method === this.httpFilter);
    if (this.httpSort === 'status') rows = rows.slice().sort((a, b) => (a.status || 0) - (b.status || 0));
    return rows;
  }
  captureLabel(tui) {
    if (this.captureUnavailable && tui.busy) return 'Capture unavailable';
    if (!tui.busy) return tui.ui.launchCaptureNetwork ? 'Shell capture ON · next run' : 'Shell capture OFF';
    return (typeof tui.captureNetwork === 'boolean' ? tui.captureNetwork : this.captureEnabled) ? 'Shell capture ON' : 'Shell capture OFF';
  }
  animating(file = this.detail?.kind === 'command' ? this.commandPreview : this.files.get(this.activeFile)) {
    return Boolean((file === this.commandPreview || this.followCode) && file?.sourceText && file.revealFrom < file.sourceText.length
      && (file.revealPending || file.revealAt != null && this.now() - file.revealAt < this.revealMs));
  }
  visibleSource(file) {
    if (!this.animating(file)) return file.lines;
    if (file.revealPending) { file.revealAt = this.now(); file.revealPending = false; }
    const fraction = Math.max(0, Math.min(1, (this.now() - file.revealAt) / this.revealMs));
    const count = file.revealFrom + Math.max(1, Math.ceil((file.sourceText.length - file.revealFrom) * fraction));
    return clean(file.sourceText.slice(0, count).replace(/[\ud800-\udbff]$/, '')).split('\n').slice(0, 5000);
  }
  rows(kind, width, tui, { detail = false } = {}) {
    const { theme } = tui, c = theme.color, lines = [], hits = [];
    const put = (text, tone = palette.muted) => lines.push(c(clip(text, width), tone));
    if (detail && kind === 'code' && this.detail?.kind === 'source') return this.sourceRows(width, tui, this.files.get(this.activeFile));
    if (detail && kind !== 'http' && this.detail && this.expanded === kind) {
      const detail = this.detail;
      if (detail.row.entry) {
        return tui.entryLayout(detail.row.entry, width);
      } else {
        put(tui.actors.for(detail.row.actorId, tui.ui.sessionId).label, palette.agent);
        for (const line of wrap(detail.row.summary, width)) put(line, detail.row.type === 'source.changed' ? line.startsWith('+') ? palette.success : line.startsWith('-') ? palette.danger : line.startsWith('@@') ? palette.accent : palette.text : palette.text);
        put(`${detail.row.type} · ${time(detail.row.at)}`);
      }
      return { lines, hits };
    }
    if (kind === 'agents') {
      for (const row of this.feed) {
        const tone = row.kind === 'skill' ? palette.agent : actorColor({ role: 'subagent', name: row.summary });
        const stamp = time(row.at), label = (row.kind === 'skill' ? '✧ ' : '◇ ') + row.summary;
        hits.push({ type: 'monitor-detail', kind, item: row, row: lines.length, left: 1, right: width });
        lines.push(c(stamp + ' ', palette.muted) + c(clip(label, Math.max(1, width - stamp.length - 1)), tone));
      }
    } else if (kind === 'http') {
      for (const row of this.requests(tui.traffic)) {
        let endpoint; try { const url = new URL(redactedUrl(row.url)); endpoint = row.method === 'CONNECT' ? url.host : (width >= 60 ? url.host : '') + url.pathname + url.search; } catch { endpoint = '[invalid URL]'; }
        hits.push({ type: 'monitor-detail', kind, item: row, row: lines.length, left: 1, right: width });
        lines.push(c(clip(row.method || '?', 6).padEnd(7), methodTone(row.method)) + c(String(row.status || (row.type === 'network.error' ? 'ERR' : '…')).padEnd(4), row.type === 'network.error' ? palette.danger : statusTone(row.status)) + c(clip(endpoint, Math.max(1, width - 11)), palette.text));
      }
    } else {
      for (const row of [...this.commands.values()].reverse()) {
        const actor = tui.actors.for(row.actorSessionId || tui.ui.sessionId, tui.ui.sessionId), stamp = time(row.at);
        const done = row.phase === 'completed', failed = row.phase === 'failed', mark = failed ? '✕' : done ? '✓' : row.phase === 'started' ? '●' : '·';
        const name = width >= 36 ? clip(actor.name, 9).padEnd(10) : '';
        const prefix = stamp + ' ' + mark + ' ' + name;
        hits.push({ type: 'monitor-command', key: row.key, row: lines.length, left: 1, right: width });
        lines.push(c(stamp + ' ', palette.muted) + c(mark + ' ', failed ? palette.danger : done ? palette.success : palette.tool)
          + c(name, actorColor(actor)) + c(clip(row.command.replace(/\s+/g, ' '), Math.max(1, width - cellWidth(prefix))), palette.tool));
      }
    }
    return { lines, hits };
  }
  sourceRows(width, tui, file, { wrapLines = false } = {}) {
      const { theme } = tui, c = theme.color, lines = [], hits = [];
      if (!file) return { lines, hits };
      if (file.unavailable) lines.push(c(clip(file.unavailable, width), palette.warning));
      const digits = Math.max(3, String(file.lines.length).length);
      const visible = this.visibleSource(file), revealing = this.animating(file);
      const cursor = revealing || tui.busy && ['started', 'running', 'preparing', 'prepared'].includes(file.phase) && Math.floor(this.now() / 400) % 2 === 0;
      for (const [index, source] of visible.entries()) {
        const text = source.replaceAll('\t', '  ') + (cursor && index === visible.length - 1 ? '▏' : '');
        const chunks = wrapLines ? wrap(text, Math.max(1, width - digits - 2)) : [clip(text, Math.max(1, width - digits - 2), '')];
        for (const [part, chunk] of chunks.entries()) {
          hits.push({ type: 'monitor-line', file, index, row: lines.length, left: 1, right: width });
          const mark = file.changed?.has(index) ? '~' : ' ';
          lines.push(c(mark + (part ? '·'.padStart(digits) : String(index + 1).padStart(digits)) + ' ', mark === '~' ? palette.warning : palette.muted) + highlightSource(chunk, theme));
        }
      }
      if (file.clipped) lines.push(c('Preview limited to 5,000 lines.', palette.warning));
    return { lines, hits };
  }
  scroll(kind, delta) {
    this.offsets[kind] = kind === 'command' ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, this.offsets.command + delta))
      : Math.max(0, Math.min(this.maxima[kind] || 0, this.offsets[kind] + (['agents', 'code'].includes(kind) ? delta : -delta)));
    if (kind === 'source' || kind === 'command') {
      if (kind === 'source') this.followCode = this.offsets.source === 0;
      const file = kind === 'command' ? this.commandPreview : this.files.get(this.activeFile);
      if (file) { file.revealPending = false; file.revealAt = null; }
    }
  }
}
