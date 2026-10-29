import { createToolActivityProjector } from '@bzzy/core/engine/tool-activity.js';
import { clean, clip, wrap, cellWidth } from './terminal-format.js';
import { palette } from './terminal-theme.js';

const pageSize = 25, maximumRows = 2000;
const safe = value => clip(clean(typeof value === 'string' ? value : '').replace(/\s+/gu, ' ').trim(), 1000);
const elapsed = value => value == null ? '' : value < 1000 ? `${Math.round(value)}ms` : `${(value / 1000).toFixed(1)}s`;

export class ToolTreeProjection {
  constructor() { this.groups = new Map(); this.projectors = new Map(); this.boundary = 0; this.sequence = 0; }
  event(entries, type, data = {}, { sessionId, actors } = {}) {
    if (data.eventSessionId && data.eventSessionId !== sessionId) return {};
    if (type === 'message.user' || type === 'execution.started') {
      this.boundary = data.executionId || data.id || data.seq || ++this.sequence;
      if (type === 'execution.started') this.runId = data.id;
      return {};
    }
    if (type === 'execution.finished' || type === 'assignment.finished' || type === 'assignment.failed') {
      const changed = [];
      for (const group of this.groups.values()) {
        if (type === 'execution.finished' ? group.boundary !== this.boundary : group.assignmentId !== (data.assignmentId || data.id)) continue;
        for (const call of group.calls) if (call.phase === 'started') { call.phase = 'stopped'; changed.push(group.entry); }
      }
      return { changed };
    }
    const actor = type === 'worker.tool' ? data.workerSessionId : sessionId;
    if (!actor) return {};
    let projector = this.projectors.get(actor);
    if (!projector) { projector = createToolActivityProjector({ sessionId: actor }); this.projectors.set(actor, projector); }
    let action = projector(type === 'worker.tool' ? 'tool.action' : type, { ...data, runId: data.runId || this.runId || String(this.boundary), actorSessionId: actor });
    if (type === 'backend' && action?.phase === 'started') this.nativePending = actor;
    if (type === 'tool') {
      if (this.nativePending === actor) { this.nativePending = null; return { handled: true }; }
      if (/mcp__bzzy_goal__|^bzzy_goal\//i.test(data.name || '')) return { handled: true };
      action = projector('tool.action', { callId: `legacy:${data.seq || ++this.sequence}`, runId: this.runId || String(this.boundary), phase: 'started', actorSessionId: actor,
        name: data.name || 'Tool', label: data.name || 'Tool', detail: data.detail, provenance: 'backend-reported' });
    }
    if (!action) return {};
    const invocation = data.assignmentId && entries.find(entry => entry.kind === 'invocation' && entry.assignmentId === data.assignmentId && entry.sessionId === sessionId);
    const key = invocation ? `${sessionId}:assignment:${data.assignmentId}` : `${sessionId}:${this.boundary}:${actor}`;
    let group = this.groups.get(key);
    if (!group || !entries.includes(group.entry)) {
      const entry = invocation || { kind: 'tool-tree', text: '', sessionId };
      group = { key, actorSessionId: actor, assignmentId: data.assignmentId, agent: safe(actors?.for(actor, sessionId).label || (actor === sessionId ? 'Main' : data.agent ? `Agent · ${data.agent}` : `Worker · ${actor.slice(0, 8)}`)), calls: [], expanded: true, page: 0, dropped: 0 };
      Object.defineProperty(group, 'entry', { value: entry });
      if (invocation) invocation.toolTree = group; else { entry.toolTree = group; entries.push(entry); }
      this.groups.set(key, group);
    }
    group.boundary = this.boundary;
    let call = group.calls.find(row => row.id === action.id);
    if (call) {
      if (action.phase === 'started' && call.phase !== 'started') {
        if (!call.name && action.name) { Object.assign(call, { name: action.name, label: action.label, detail: action.detail }); return { handled: true, changed: [group.entry], group }; }
        return { handled: true };
      }
      if (data.seq && call.seq && data.seq <= call.seq) return { handled: true };
      const previous = JSON.stringify(call);
      Object.assign(call, { ...action, label: action.name || !call.label ? action.label : call.label,
        detail: action.detail || call.detail, began: call.began, expanded: call.expanded, seq: data.seq || call.seq });
      if (previous === JSON.stringify(call)) return { handled: true };
    } else {
      call = { ...action, began: data.occurredAt ? Date.parse(data.occurredAt) : null, seq: data.seq || 0 };
      group.calls.push(call);
      if (group.calls.length > maximumRows) { group.calls.splice(0, 100); group.dropped += 100; }
    }
    if (!group.manualPage) group.page = Math.floor((group.calls.length - 1) / pageSize);
    return { handled: true, changed: [group.entry], group };
  }
}

export function toolTreeLayout(group, width, theme, { nested = false } = {}) {
  const lines = [], hits = [], indent = nested ? '    ' : '  ';
  const put = (value, tone = palette.muted, bold = false) => lines.push(theme.color(clip(value, width), tone, bold));
  const total = group.calls.length + group.dropped;
  put(`${indent}${group.expanded ? '▾' : '▸'} ${nested ? '' : group.agent + ' · '}Tool calls (${total})`, palette.tool, true);
  hits.push({ type: 'tool-tree-toggle', group, row: 0, left: cellWidth(indent), right: width - 1 });
  if (group.expanded) {
    const first = Math.min(group.page * pageSize, Math.max(0, group.calls.length - 1)), rows = group.calls.slice(first, first + pageSize);
    if (group.dropped) put(`${indent}  ${group.dropped} older calls retained in saved events`);
    for (const [index, call] of rows.entries()) {
      const glyph = call.phase === 'started' ? '●' : call.phase === 'completed' ? '✓' : call.phase === 'failed' ? '✕' : '○';
      const tone = call.phase === 'failed' ? palette.danger : call.phase === 'started' ? palette.tool : call.phase === 'completed' ? palette.success : palette.muted;
      const label = safe(call.label || 'Tool'), detail = safe(call.detail);
      const status = call.phase === 'completed' ? 'returned' : call.phase === 'failed' ? 'failed' : call.phase === 'stopped' ? 'stopped · result unknown' : 'running';
      const suffix = ` · ${status}${call.durationMs != null ? ' · ' + elapsed(call.durationMs) : ''}${call.exitCode != null ? ' · exit ' + call.exitCode : ''}`;
      const prefix = `${indent}${index === rows.length - 1 ? '└' : '├'}─ ${glyph} `;
      const title = `${label}${detail ? `("${detail}")` : ''}`;
      const row = lines.length;
      put(prefix + clip(title, Math.max(1, width - cellWidth(prefix + suffix))) + suffix, tone);
      hits.push({ type: 'tool-row-toggle', group, call, row, left: cellWidth(indent), right: width - 1 });
      if (call.expanded) {
        for (const line of wrap(title, Math.max(1, width - cellWidth(indent) - 5))) put(`${indent}│    ${line}`, palette.text);
        put(`${indent}│    ${call.provenance === 'core-tool' ? 'Core tool result' : 'Backend-reported activity'} · ${status}`, tone);
      }
    }
    if (group.calls.length > pageSize) {
      const row = lines.length, label = `${indent}  ‹ Previous   ${first + 1}–${first + rows.length} of ${group.calls.length}   Next ›`;
      put(label, palette.accent);
      const middle = Math.floor(width / 2);
      hits.push({ type: 'tool-tree-page', group, delta: -1, row, left: cellWidth(indent), right: middle });
      hits.push({ type: 'tool-tree-page', group, delta: 1, row, left: middle + 1, right: width - 1 });
    }
  }
  lines.push(''); return { lines, hits };
}

export function changeToolTree(hit) {
  const group = hit?.group;
  if (!group) return false;
  if (hit.type === 'tool-tree-toggle') group.expanded = !group.expanded;
  else if (hit.type === 'tool-row-toggle') hit.call.expanded = !hit.call.expanded;
  else if (hit.type === 'tool-tree-page') { group.page = Math.max(0, Math.min(Math.floor((group.calls.length - 1) / pageSize), group.page + hit.delta)); group.manualPage = true; }
  else return false;
  return true;
}
