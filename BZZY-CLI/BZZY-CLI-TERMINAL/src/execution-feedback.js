import { clean, clip } from './terminal-format.js';
import { createToolActivityProjector } from '@bzzy/core/engine/tool-activity.js';

const activeStates = new Set(['queued', 'launching', 'running']);
const stamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const label = value => clip(clean(typeof value === 'string' ? value : '').replace(/\s+/gu, ' ').trim(), 180);
export const feedbackAge = milliseconds => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};
export const feedbackClock = milliseconds => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return [Math.floor(seconds / 60), seconds % 60].map(value => String(value).padStart(2, '0')).join(':');
};

function progress(type, data, now, project) {
  const at = Math.min(now, stamp(data.occurredAt) ?? stamp(data.updatedAt) ?? stamp(data.createdAt) ?? now);
  const base = { at, seq: Number.isSafeInteger(data.seq) ? data.seq : 0 };
  if (['text', 'peer.text'].includes(type) && data.text) return { ...base, kind: 'response', output: true, key: data.itemId || data.turnId || 'response', title: type === 'peer.text' ? 'Receiving agent output' : 'Receiving response' };
  if (type === 'tool') {
    const action = project('tool.action', { callId: 'preview', phase: 'started', name: data.name, label: data.name || 'tool', detail: data.detail });
    return { ...base, kind: 'tool', title: `Running ${label(action?.label) || 'tool'}`, detail: label(action?.detail) };
  }
  if (type === 'activity' && data.status === 'running' && !data.closedAt) return { ...base, kind: 'activity', key: data.id, title: 'Reported activity', detail: label(data.summary) };
  if (type === 'worker.progress' && ['tool', 'summary', 'error'].includes(data.type)) return { ...base, kind: 'activity', key: data.workerSessionId,
    title: data.type === 'tool' ? 'Agent tool activity' : data.type === 'error' ? 'Agent reported an error' : 'Agent returned a report',
    detail: [label(data.agent), label(data.name)].filter(Boolean).join(' · ') };
  if (type === 'debate.phase') return { ...base, kind: 'activity', key: data.phase, title: 'Validation activity', detail: label(data.phase) };
  if (type === 'backend') {
    const p = data.params || {}, item = p.item || {};
    if (data.method === 'item/commandExecution/outputDelta' && p.delta) return { ...base, kind: 'output', output: true };
    if (data.method === 'tool.started' || data.method === 'item/started' && ['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch'].includes(item.type)) {
      const action = project(type, data);
      return { ...base, kind: 'tool', key: item.id || p.id, title: `Running ${label(action?.name || ({ commandExecution: 'shell', fileChange: 'edit', mcpToolCall: 'tool', webSearch: 'web search' })[item.type]) || 'tool'}`, detail: label(action?.detail) };
    }
    if (data.method === 'tool.completed' || data.method === 'item/completed' && ['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch'].includes(item.type))
      return { ...base, kind: 'tool-end', key: item.id || p.id, failed: p.failed === true || Number.isInteger(item.exitCode) && item.exitCode !== 0 };
    if (data.method === 'turn/started') return { ...base, kind: 'model', key: p.turn?.id, title: 'Waiting for model output' };
  }
  if (type === 'execution.finished') return { ...base, kind: 'end', key: data.id, exitCode: data.exitCode };
  return null;
}

// UI projection only: polling/animation never counts as model activity. Source
// timestamps keep old replay honest; a runner observation does not prove progress.
export class ExecutionFeedback {
  constructor({ clock = Date.now } = {}) { this.clock = clock; this.recent = []; this.tools = new Map(); this.toolActivity = createToolActivityProjector(); }
  connection(connected) { this.disconnected = !connected; }
  update(snapshot) {
    const now = this.clock(), session = snapshot.session || snapshot, job = snapshot.execution;
    if (this.sessionId && session.id !== this.sessionId) {
      this.active = false; this.settled = null; this.phase = null; this.observation = null; this.lastOutputAt = null; this.tools.clear();
      this.recent = this.recent.filter(event => event.sessionId === session.id); this.seq = 0; this.coreAt = null;
    }
    const active = job ? activeStates.has(job.state) : ['running', 'waiting_for_input', 'verifying'].includes(session.executionState);
    const id = job?.id || (active ? `${session.id}:${snapshot.run?.startedAt || 'current'}` : null);
    if (snapshot.session) { this.coreAt = now; this.disconnected = false; }
    const began = stamp(job?.startedAt);
    if (active && (!this.active || this.executionId !== id || this.sessionId !== session.id || began != null && began !== this.startedAt)) {
      this.executionId = id; this.sessionId = session.id; this.startedAt = stamp(job?.startedAt || job?.createdAt || snapshot.run?.startedAt) ?? now;
      this.phase = null; this.lastOutputAt = null; this.lastProgressAt = this.startedAt; this.seq = 0; this.settled = null; this.tools.clear();
      this.active = true;
      for (const event of this.recent) if (!event.sessionId || event.sessionId === session.id) this.apply(event);
    }
    if (!active && (this.active || this.settled && job?.id === this.executionId)) this.settled = { at: stamp(job?.finishedAt) ?? this.settled?.at ?? now, title: session.executionState === 'paused' ? 'Response paused'
      : session.executionState === 'cancelled' ? 'Response cancelled' : job?.exitCode || session.executionState === 'failed' ? 'Response stopped' : 'Response finished' };
    this.active = active; this.sessionId = session.id;
    this.childCount = snapshot.children?.filter(child => ['running', 'waiting_for_input', 'verifying'].includes(child.executionState)).length || 0;
    this.state = session.executionState === 'waiting_for_input' || snapshot.questions?.length ? 'input' : job?.stopAction ? 'stopping' : job?.state === 'queued' ? 'queued' : job?.state === 'launching' ? 'starting' : 'running';
    if (snapshot.observation?.executionId === job?.id) this.observation = snapshot.observation;
    else this.observation = null;
    if (!active) this.tools.clear();
  }
  event(type, data = {}) {
    const event = progress(type, data, this.clock(), this.toolActivity);
    if (!event) return;
    event.sessionId = data.eventSessionId;
    this.recent.push(event); if (this.recent.length > 64) this.recent.shift();
    if (this.active && (!event.sessionId || event.sessionId === this.sessionId)) this.apply(event);
  }
  phaseTo(event) {
    const same = this.phase?.kind === event.kind && this.phase?.key === event.key;
    this.phase = { ...event, since: same ? this.phase.since : event.at };
  }
  apply(event) {
    if (event.at < this.startedAt || event.seq && event.seq <= this.seq) return;
    if (event.kind === 'end' && event.key !== this.executionId) return;
    if (event.kind === 'tool-end' && (!event.key || !this.tools.has(event.key))) return;
    this.seq = Math.max(this.seq, event.seq);
    this.lastProgressAt = Math.max(this.lastProgressAt || 0, event.at);
    if (event.output) this.lastOutputAt = Math.max(this.lastOutputAt || 0, event.at);
    if (event.kind === 'tool') {
      const key = event.key || (this.phase?.kind === 'tool' ? this.phase.key : `tool:${event.at}`);
      const next = { ...event, key };
      this.tools.set(key, next); this.phaseTo(next);
    } else if (event.kind === 'tool-end') {
      this.tools.delete(event.key);
      const remaining = [...this.tools.values()].at(-1);
      this.phaseTo(remaining || { kind: 'model', key: 'after-tool', at: event.at, title: event.failed ? 'Tool returned an error · waiting for model' : 'Tool returned · waiting for model' });
    } else if (['model', 'response', 'activity'].includes(event.kind)) this.phaseTo(event);
    else if (event.kind === 'end') {
      this.settled = { at: event.at, title: event.exitCode ? 'Response stopped' : 'Response finished' }; this.active = false; this.tools.clear();
    }
  }
  view(entries = []) {
    const now = this.clock();
    if (!this.active) return this.settled ? { title: this.settled.title, elapsed: feedbackClock(this.settled.at - this.startedAt), complete: true, warning: this.settled.title !== 'Response finished' } : null;
    const since = this.phase?.since ?? this.startedAt;
    const phaseTitle = this.state === 'input' ? 'Waiting for your input' : this.state === 'queued' ? 'Queued for execution'
      : this.state === 'starting' ? 'Starting execution' : this.state === 'stopping' ? 'Stopping execution' : this.phase?.title || 'Waiting for model output';
    const coreAge = this.coreAt == null ? null : now - this.coreAt;
    const observed = stamp(this.observation?.observedAt), observationAge = observed == null ? null : now - observed;
    const fresh = observationAge != null && observationAge >= 0 && observationAge <= 10000;
    const lost = this.disconnected || coreAge != null && coreAge > 10000;
    const quiet = now - (this.lastOutputAt ?? this.lastProgressAt ?? this.startedAt);
    const activity = this.lastOutputAt != null ? `Last output ${feedbackAge(quiet)} ago` : `Last activity ${feedbackAge(quiet)} ago`;
    const health = lost ? 'Core connection lost · process unknown' : fresh && this.observation.runnerAlive === true ? `Process alive · checked ${feedbackAge(observationAge)} ago`
      : fresh && this.observation.runnerAlive === false ? 'Process not detected' : 'Process check unavailable';
    const agents = Math.max(this.childCount, entries.filter(entry => entry.kind === 'invocation' && entry.invocationType === 'agent' && entry.sessionId === this.sessionId && ['starting', 'running', 'cancelling'].includes(entry.state)).length);
    const missing = fresh && this.observation.runnerAlive === false;
    return { title: lost ? 'Reconnecting to Core' : missing ? 'Process not detected · checking execution' : phaseTitle, detail: lost || missing || this.state !== 'running' ? '' : this.phase?.detail || '',
      elapsed: feedbackClock(now - since), meta: [activity, health, ...(agents ? [`${agents} agent${agents === 1 ? '' : 's'} active`] : [])].join(' · '),
      waiting: this.state === 'input', warning: lost || this.state === 'input' || quiet >= 30000 || missing };
  }
}
