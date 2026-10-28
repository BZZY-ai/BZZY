import { clean, clip } from './terminal-format.js';

const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:._-]{0,191}$/.test(value);
const name = value => clip(clean(typeof value === 'string' ? value : '').replace(/\s+/gu, ' ').trim(), 100);
const roles = new Set(['main', 'subagent', 'worker', 'reviewer', 'peer']);

// Presentation identities come from saved host event/session metadata. Model
// names, assistant bodies and activity prose never establish actor identity.
export class ActorProjection {
  constructor() { this.actors = new Map(); this.revision = 0; }
  remember(actorId, value) {
    if (!id(actorId)) return;
    const previous = this.actors.get(actorId) || {};
    const next = { ...previous, ...Object.fromEntries(Object.entries(value).filter(([, value]) => value != null && value !== '')) };
    if (JSON.stringify(previous) === JSON.stringify(next)) return;
    this.actors.set(actorId, next); this.revision++;
    if (this.actors.size > 2048) this.actors.delete(this.actors.keys().next().value);
  }
  event(type, data, entries, { sessionId } = {}) {
    if (data.eventSessionId && data.eventSessionId !== sessionId) return;
    const actorId = data.workerSessionId || data.childSessionId || data.actorSessionId || (['activity', 'core.usage', 'peer.text'].includes(type) ? data.sessionId : null);
    const invocation = data.assignmentId && entries.find(entry => entry.kind === 'invocation' && entry.assignmentId === data.assignmentId && entry.sessionId === sessionId);
    if (invocation && id(actorId)) invocation.actorSessionId = actorId;
    if (id(actorId)) {
      const role = invocation ? 'subagent' : roles.has(data.actorRole) ? data.actorRole : type === 'peer.text' ? 'peer' : this.actors.get(actorId)?.role || (actorId === sessionId ? 'main' : 'worker');
      const actorName = invocation?.name || name(data.actorName) || (['worker.tool', 'peer.text'].includes(type) ? name(data.agent) : '');
      this.remember(actorId, { role, name: actorName, ...(invocation ? { assignmentId: invocation.assignmentId } : {}) });
    }
  }
  snapshot(snapshot, { sessionId } = {}) {
    for (const row of snapshot?.invocations?.version === 1 && Array.isArray(snapshot.invocations.agents) ? snapshot.invocations.agents : []) {
      if (row.parentSessionId !== sessionId || !id(row.workerSessionId)) continue;
      this.remember(row.workerSessionId, { role: row.specialist ? 'subagent' : row.role === 'reviewer' ? 'reviewer' : 'worker', name: name(row.name), assignmentId: row.id });
    }
  }
  for(actorId, sessionId) {
    const actor = this.actors.get(actorId);
    if (actor?.role === 'main' || !actor && (!actorId || actorId === sessionId)) return { key: actorId || sessionId || 'main', role: 'main', label: 'Main', name: 'BZZY' };
    const role = actor?.role || 'worker', display = actor?.name || (id(actorId) ? actorId.slice(0, 8) : 'Unknown');
    const repeated = actor?.name && [...this.actors.values()].filter(other => other.role === role && other.name === actor.name).length > 1;
    const suffix = actor?.name && (repeated || ['worker', 'reviewer'].includes(role)) && id(actorId) ? ` · ${actorId.slice(0, 8)}` : '';
    const label = `${role === 'subagent' || role === 'peer' ? 'Agent' : role === 'reviewer' ? 'Reviewer' : 'Worker'} · ${display}${suffix}`;
    return { key: actorId || 'unknown-worker', role, label, name: display };
  }
}
