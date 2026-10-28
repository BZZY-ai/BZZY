import { database, transaction } from './database.js';
import { identityAlive } from './process-identity.js';
import { assignmentBudgetView } from './worker-budget.js';

const LIMIT = 64, live = new Map(), CACHE_MS = 750;
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const states = new Set(['starting', 'running', 'paused', 'cancelled', 'needs_context', 'awaiting_review', 'accepted', 'rejected', 'inconclusive', 'abandoned', 'interrupted', 'failed', 'timed_out', 'budget_limited']);
const closures = new Set(['open', 'accepted', 'rejected', 'inconclusive', 'abandoned']);
const active = new Set(['starting', 'running']);
const text = (value, maximum) => typeof value === 'string' && value.length <= maximum && value.trim() && !/[\x00-\x1f\x7f-\x9f]/u.test(value) ? value : null;
const identity = value => {
  try { return value ? JSON.parse(value) : null; } catch { return null; }
};
function alive(value) {
  if (!value || !Number.isSafeInteger(value.pid) || value.pid < 1 || typeof value.start !== 'string') return false;
  const key = JSON.stringify([value.pid, value.platform, value.start, value.boot]), cached = live.get(key), clock = Date.now();
  if (cached && clock - cached.at < CACHE_MS) return cached.alive;
  const result = identityAlive(value);
  if (live.size >= 256) live.delete(live.keys().next().value);
  live.set(key, { at: clock, alive: result }); return result;
}
function stateFor(row) {
  if (!row.roundPresent || !Number.isSafeInteger(row.round) || row.round < 1) return 'unknown';
  if (!active.has(row.state)) {
    if (closures.has(row.closure) && row.closure !== 'open') return row.closure;
    return states.has(row.state) ? row.state : 'unknown';
  }
  if (row.closure !== 'open') return 'unknown';
  const process = identity(row.state === 'running' ? row.runner : row.launcher);
  const cancellation = row.control === 'cancel' && (row.controlRound == null || row.controlRound === row.round);
  if (process?.start === 'platform-unverified') return 'unknown';
  if (process && !alive(process)) return cancellation ? 'cancelled' : 'interrupted';
  if (row.state === 'running' && !process) return 'unknown';
  if (row.state === 'starting' && !process) {
    const createdAt = Date.parse(row.createdAt);
    if (!Number.isFinite(createdAt)) return 'unknown';
    if (Date.now() - createdAt > 30000) return cancellation ? 'cancelled' : 'interrupted';
  }
  if (cancellation) return 'cancelling';
  if (row.contextState === 'pending') return 'needs_context';
  return row.state;
}

// Read-only presentation state. It never reconciles records, launches work or
// copies task instructions, reports, paths or arbitrary errors into a client.
export function sessionInvocations(sessionId) {
  if (!uuid(sessionId)) throw new Error('Use an existing terminal session ID.');
  const db = database(), read = () => {
    if (!db.prepare(`SELECT 1 FROM records s WHERE s.kind='session' AND s.id=?
      AND NOT EXISTS(SELECT 1 FROM records d WHERE d.kind='session-deletion' AND d.id=s.id)`).get(sessionId)) return [];
    return db.prepare(`SELECT a.id, json_extract(a.data,'$.parentSessionId') AS parentSessionId,
      json_type(a.data,'$.subagentDefinition') AS specialistType, json_extract(a.data,'$.subagentDefinition.name') AS name,
      json_extract(a.data,'$.role') AS role, json_extract(a.data,'$.selection.provider') AS provider,
      json_extract(a.data,'$.selection.model') AS model, json_extract(a.data,'$.currentRound') AS round,
      json_extract(a.data,'$.closure') AS closure, json_extract(a.data,'$.contextRequest.state') AS contextState,
      json_extract(a.data,'$.workerSessionId') AS workerSessionId, json_extract(a.data,'$.contract.limits') AS limits,
      json_extract(a.data,'$.workerBudget') AS workerBudget, json_extract(a.data,'$.latestReport.usage') AS reportedUsage,
      json_extract(a.data,'$.latestReport.reportArtifactId') AS reportArtifactId, json_extract(a.data,'$.latestReport.missingReport') AS missingReport,
      json_extract(r.data,'$.stopReason') AS stopReason,
      r.id AS roundPresent, json_extract(r.data,'$.state') AS state, json_extract(r.data,'$.createdAt') AS createdAt,
      json_extract(r.data,'$.runner') AS runner, json_extract(r.data,'$.launcher') AS launcher,
      json_extract(c.data,'$.action') AS control, json_extract(c.data,'$.round') AS controlRound
      FROM records a LEFT JOIN records r ON r.kind='round' AND r.id=a.id || ':' || json_extract(a.data,'$.currentRound')
      LEFT JOIN records c ON c.kind='assignment-control' AND c.id=a.id
      WHERE a.kind='assignment' AND json_extract(a.data,'$.parentSessionId')=?
      ORDER BY a.updated_at DESC,a.id LIMIT ?`).all(sessionId, LIMIT + 1);
  };
  const rows = db.isTransaction ? read() : transaction(read, { readOnly: true });
  return { version: 1, agents: rows.slice(0, LIMIT).filter(row => uuid(row.id)).map(row => {
    const specialist = row.specialistType === 'object', name = text(row.name, 128);
    const model = text(row.model, 256);
    const job = { id: row.id, parentSessionId: sessionId, workerSessionId: row.workerSessionId, closure: row.closure,
      contract: { limits: identity(row.limits) || {} }, workerBudget: identity(row.workerBudget), latestReport: { usage: identity(row.reportedUsage) } };
    const parent = db.prepare("SELECT json_extract(data,'$.executionState') AS state FROM records WHERE kind='session' AND id=?").get(sessionId);
    return { id: row.id, parentSessionId: sessionId, workerSessionId: uuid(row.workerSessionId) ? row.workerSessionId : null,
      role: ['executor', 'reviewer', 'peer', 'bestie'].includes(row.role) ? row.role : 'worker',
      name: specialist && /^[a-z0-9][a-z0-9_-]*$/i.test(name || '') ? name : row.role === 'reviewer' ? 'Reviewer' : row.role === 'executor' ? 'Executor' : 'Agent',
      specialist, provider: /^[a-z0-9][a-z0-9_.-]{0,63}$/i.test(row.provider || '') ? row.provider : null,
      model: model && /^[a-z0-9][a-z0-9_.:/@+-]*$/i.test(model) && !/^(?:[a-z]:\/|file:)/i.test(model) ? model : null,
      round: Number.isSafeInteger(row.round) && row.round > 0 ? row.round : null,
      state: stateFor(row), closure: closures.has(row.closure) ? row.closure : 'unknown', budget: assignmentBudgetView(job),
      stopReason: ['runtime_limit', 'token_limit', 'allocation_checkpoint', 'needs_context', 'cancelled', 'parent_stopped', 'user_pause', 'interrupted'].includes(row.stopReason) ? row.stopReason : null,
      result: { saved: Boolean(row.reportArtifactId), missingReport: row.missingReport == null ? null : Boolean(row.missingReport), reportArtifactId: uuid(row.reportArtifactId) ? row.reportArtifactId : null },
      parentState: ['running', 'paused', 'idle', 'waiting_for_input', 'failed', 'cancelled', 'verifying'].includes(parent?.state) ? parent.state : 'unknown' };
  }), truncated: rows.length > LIMIT };
}
