import { clean, clip, cellWidth } from './terminal-format.js';
import { palette } from './terminal-theme.js';

const tones = [palette.agent, palette.goalSuccess, palette.warning, palette.accent, palette.goalActive, palette.yolo];
const labels = { loaded: 'Loaded', starting: 'Starting', running: 'Running', awaiting_review: 'Awaiting review',
  needs_context: 'Needs context', awaiting_followup: 'Ready for follow-up', paused: 'Paused', interrupted: 'Interrupted',
  cancelled: 'Cancelled', failed: 'Failed', accepted: 'Accepted', inconclusive: 'Inconclusive', abandoned: 'Abandoned',
  cancelling: 'Stopping', timed_out: 'Timed out', budget_limited: 'Budget reached', unknown: 'Unknown',
  rejected: 'Rejected', finished: 'Finished · review pending', unavailable: 'Unavailable' };
const activeStates = new Set(['starting', 'running', 'cancelling']);
const settledStates = new Set(['accepted', 'inconclusive', 'abandoned', 'rejected']);
const phase = state => settledStates.has(state) ? 5 : ['needs_context', 'awaiting_followup', 'paused', 'interrupted', 'cancelled', 'failed', 'unavailable', 'timed_out', 'budget_limited', 'unknown'].includes(state) ? 3
  : ['awaiting_review', 'finished', 'cancelling'].includes(state) ? 2 : state === 'running' ? 1 : 0;
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:._-]{0,191}$/.test(value);
const display = (value, maximum = 120) => clip(clean(typeof value === 'string' ? value : '').replace(/\s+/gu, ' ').trim(), maximum);
const sequence = data => Number.isSafeInteger(data.seq) && data.seq > 0 ? data.seq : 0;
const roundOf = data => Number.isSafeInteger(data.round) && data.round > 0 ? data.round
  : Number.isSafeInteger(data.currentRound) && data.currentRound > 0 ? data.currentRound : 1;
const stateOf = value => Object.hasOwn(labels, value) ? value : 'unavailable';
const sessionFor = (snapshot, explicit) => explicit || snapshot?.session?.id || snapshot?.id;
function sameView(data, sessionId, skill = false) {
  if (!safeId(sessionId)) return false;
  if (data.eventSessionId && data.eventSessionId !== sessionId) return false;
  if (skill) return data.sessionId === sessionId || data.rootSessionId === sessionId;
  return !data.parentSessionId || data.parentSessionId === sessionId;
}
function textFor(entry) {
  return `${entry.invocationType === 'skill' ? 'Skill' : 'Agent'} · ${entry.name} · ${labels[entry.state] || labels.unavailable}`
    + (entry.invocationType === 'agent' && entry.round > 1 ? ` · round ${entry.round}` : '')
    + (entry.invocationType === 'skill' && entry.scope ? ` · ${entry.scope}` : '');
}
function refresh(entry) { entry.text = textFor(entry); return entry; }
function result(entry, changed = false) { return { handled: true, ...(entry ? { entry } : {}), changed }; }
function eventState(type, data) {
  if (type === 'assignment.created' || type === 'assignment.followup') return 'starting';
  if (type === 'assignment.started') return 'running';
  if (type === 'assignment.needs_context') return 'needs_context';
  if (type === 'assignment.context_answered') return 'awaiting_followup';
  if (type === 'assignment.reviewed') return settledStates.has(data.outcome) ? data.outcome : 'unavailable';
  if (type === 'assignment.finished') return Object.hasOwn(labels, data.state) ? data.state : 'unknown';
  if (type === 'assignment.failed') return 'failed';
  if (type === 'assignment.interrupted') return 'interrupted';
  if (type === 'assignment.cancelled') return 'cancelled';
  if (type === 'assignment.paused') return 'paused';
  return null;
}

// A host receipt means that instructions were loaded, never that a skill ran to
// completion. Assignment cards likewise describe the worker, not goal success.
export function recordInvocationEvent(entries, type, data = {}, { sessionId } = {}) {
  if (!Array.isArray(entries) || !data || typeof data !== 'object') return { handled: false, changed: false };
  if (type === 'core.usage') {
    if (data.kind !== 'skill' || !safeId(data.id) || !display(data.name) || !sameView(data, sessionId, true)) return { handled: false, changed: false };
    const id = `skill:${data.id}`, previous = entries.find(entry => entry.kind === 'invocation' && entry.invocationId === id && entry.sessionId === sessionId);
    if (previous) return result(previous);
    const entry = refresh({ kind: 'invocation', invocationType: 'skill', invocationId: id, sessionId,
      actorSessionId: data.sessionId, name: display(data.name), scope: ['project', 'global'].includes(data.scope) ? data.scope : null,
      state: 'loaded', eventSeq: sequence(data) });
    entries.push(entry); return result(entry, true);
  }
  if (!type.startsWith('assignment.')) return { handled: false, changed: false };
  const id = data.assignmentId || data.id;
  if (!safeId(id) || !sameView(data, sessionId)) return { handled: false, changed: false };
  const invocationId = `agent:${id}`;
  let entry = entries.find(item => item.kind === 'invocation' && item.invocationId === invocationId && item.sessionId === sessionId);
  const name = display(data.subagentDefinition?.name);
  // Generic Delegate and Validate workers retain their existing dedicated views.
  if (!entry && (!name || type !== 'assignment.created' || data.parentSessionId !== sessionId && data.eventSessionId !== sessionId)) return { handled: false, changed: false };
  const next = eventState(type, data);
  if (!next) return entry ? result(entry) : { handled: false, changed: false };
  const round = roundOf(data), seq = sequence(data);
  if (entry) {
    if (settledStates.has(entry.state)) return result(entry);
    if (round < entry.round || seq && seq <= (entry.eventSeq || 0)) return result(entry);
    if (round === entry.round && (entry.snapshotBound && seq && seq <= entry.snapshotSeq || phase(next) < phase(entry.state))) return result(entry);
    if (round === entry.round && next === entry.state) { entry.eventSeq = Math.max(seq, entry.eventSeq || 0); return result(entry); }
    Object.assign(entry, { round, state: next, eventSeq: Math.max(seq, entry.eventSeq || 0), snapshotBound: false });
  } else {
    entry = { kind: 'invocation', invocationType: 'agent', invocationId, assignmentId: id, sessionId,
      name, round, state: next, eventSeq: seq,
      agentSlot: entries.filter(item => item.kind === 'invocation' && item.invocationType === 'agent' && item.sessionId === sessionId).length };
    entries.push(entry);
  }
  refresh(entry); return result(entry, true);
}

// Reconcile only cards supplied by actual events. Snapshot data must not flood
// the transcript with assignments the user has not encountered in this view.
export function reconcileInvocationEntries(entries, snapshot, { sessionId } = {}) {
  const current = sessionFor(snapshot, sessionId), projection = snapshot?.invocations;
  if (!Array.isArray(entries) || !safeId(current) || snapshot?.session?.id && snapshot.session.id !== current || projection?.version !== 1 || !Array.isArray(projection.agents)) return [];
  const agents = new Map(projection.agents.filter(item => item && safeId(item.id) && item.parentSessionId === current).map(item => [item.id, item]));
  const changed = [];
  for (const entry of entries) {
    if (entry.kind !== 'invocation' || entry.invocationType !== 'agent' || entry.sessionId !== current) continue;
    const row = agents.get(entry.assignmentId);
    if (!row) {
      if (activeStates.has(entry.state)) { entry.state = 'unavailable'; entry.snapshotBound = true; entry.snapshotSeq = entry.eventSeq || 0; refresh(entry); changed.push(entry); }
      continue;
    }
    const round = roundOf(row);
    if (round < entry.round) continue;
    const state = row.specialist === false || display(row.name) !== entry.name ? 'unavailable'
      : settledStates.has(row.closure) ? row.closure : stateOf(row.state);
    // A cached liveness row can precede a terminal event delivered just now.
    // Same-round running data cannot reopen a stopped or reviewed worker.
    if (round === entry.round && (settledStates.has(entry.state) && !settledStates.has(state)
      || activeStates.has(state) && phase(entry.state) > 1 && !['unavailable', 'unknown'].includes(entry.state))) continue;
    entry.snapshotBound = true; entry.snapshotSeq = entry.eventSeq || 0;
    if (entry.round === round && entry.state === state) continue;
    Object.assign(entry, { round, state }); refresh(entry); changed.push(entry);
  }
  return changed;
}

export function invocationEntryLayout(entry, width, theme) {
  width = Math.max(1, Math.floor(width));
  const agent = entry.invocationType === 'agent', state = labels[entry.state] || labels.unavailable;
  const tone = agent ? tones[(entry.agentSlot || 0) % tones.length] : palette.accent;
  const icon = agent ? activeStates.has(entry.state) ? '●' : entry.state === 'failed' || entry.state === 'rejected' ? '✕' : '◇' : '◆';
  const prefix = `  ${icon} ${agent ? 'Agent' : 'Skill'} · `;
  const details = state + (agent && entry.round > 1 ? ` · round ${entry.round}` : '');
  let suffix = ` · ${details}`;
  if (!agent && entry.scope && width - cellWidth(prefix + suffix + ` · ${entry.scope}`) >= 8) suffix += ` · ${entry.scope}`;
  const room = width - cellWidth(prefix + suffix), lines = [];
  if (room >= 4) lines.push(theme.color(prefix + clip(entry.name, room) + suffix, tone, true));
  else {
    lines.push(theme.color(clip(prefix + entry.name, width), tone, true));
    lines.push(theme.color(clip('    ' + details, width), tone));
  }
  lines.push(''); return { lines };
}
