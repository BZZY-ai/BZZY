import { database } from './database.js';
import { loadSession } from './store.js';

// Assignment state belongs to one objective, even when its conversation is reused.
export function assignmentsFor(session) {
  return database().prepare(`SELECT data FROM records WHERE kind='assignment' AND ${assignmentFilter(session)} ORDER BY updated_at DESC,id`).all(...assignmentParameters(session)).map(row => JSON.parse(row.data));
}
export const assignmentFilter = (session, field = 'data') => `json_extract(${field},'$.parentSessionId')=? AND ${session.goal
  ? `(json_extract(${field},'$.goalId')=? OR (json_extract(${field},'$.goalId') IS NULL AND json_extract(${field},'$.createdAt')>=?))`
  : `json_extract(${field},'$.goalId') IS NULL`}`;
export const assignmentParameters = session => session.goal ? [session.id, session.goal.id, session.goal.createdAt] : [session.id];
export function assignmentCounts(session) {
  return database().prepare(`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE json_extract(r.data,'$.state') IN ('starting','running')) AS active
    FROM records a LEFT JOIN records r ON r.kind='round' AND r.id=a.id || ':' || json_extract(a.data,'$.currentRound')
    WHERE a.kind='assignment' AND ${assignmentFilter(session, 'a.data')}`).get(...assignmentParameters(session));
}
export function activeAssignmentsFor(session) {
  return database().prepare(`SELECT a.id, json_extract(a.data,'$.currentRound') AS currentRound
    FROM records a JOIN records r ON r.kind='round' AND r.id=a.id || ':' || json_extract(a.data,'$.currentRound')
    WHERE a.kind='assignment' AND ${assignmentFilter(session, 'a.data')} AND json_extract(r.data,'$.state') IN ('starting','running')`).all(...assignmentParameters(session));
}
export function currentAssignmentUsage(job) {
  const worker = job.workerSessionId && loadSession(job.workerSessionId);
  const reported = job.latestReport?.usage;
  const live = worker?.usage;
  const selected = live && (!reported || (live.tokens ?? -1) >= (reported.tokens ?? -1)) ? live : reported;
  return { ...(selected || {}), tokens: selected?.tokens ?? null, available: Boolean(selected?.available),
    elapsedSeconds: worker?.elapsedSeconds ?? reported?.elapsedSeconds ?? null };
}
export function supervisorTokens(session) {
  if (!session.goal) return session.usage?.tokens ?? null;
  if (!session.usage?.available && session.goal.nativeTokensUsed == null && session.goal.supervisorTokensUsed == null) return null;
  const own = session.goal.nativeTokensUsed ?? session.goal.supervisorTokensUsed ?? Math.max(0, (session.goal.tokensUsed || 0) - (session.goal.delegatedTokensUsed || 0));
  const live = session.goal.supervisorUsageBase == null ? 0 : Math.max(0, (session.usage?.tokens || 0) - session.goal.supervisorUsageBase);
  return Math.max(own, live);
}
export function delegationUsage(session) {
  // Extract only telemetry. Full reports can become large during an hours-long
  // assessment and must not be parsed again on every budget/watchdog tick.
  const rows = database().prepare(`SELECT a.id, json_extract(a.data,'$.selection.provider') AS provider,
    json_extract(a.data,'$.selection.model') AS model, json_extract(a.data,'$.latestReport.usage') AS reported,
    json_extract(w.data,'$.usage') AS live, json_extract(w.data,'$.elapsedSeconds') AS elapsed
    FROM records a LEFT JOIN records w ON w.kind='session' AND w.id=json_extract(a.data,'$.workerSessionId')
    WHERE a.kind='assignment' AND ${assignmentFilter(session, 'a.data')} ORDER BY a.updated_at DESC,a.id`).all(...assignmentParameters(session));
  let delegatedTokens = 0, available = true; const agents = [], providers = new Map();
  for (const row of rows) {
    const live = row.live ? JSON.parse(row.live) : null, reported = row.reported ? JSON.parse(row.reported) : null;
    const usage = live && (!reported || (live.tokens ?? -1) >= (reported.tokens ?? -1)) ? live : reported;
    const item = { assignmentId: row.id, provider: row.provider, model: row.model, tokens: usage?.tokens ?? null, available: Boolean(usage?.available), elapsedSeconds: row.elapsed ?? reported?.elapsedSeconds ?? null };
    delegatedTokens += item.tokens || 0; available &&= item.available;
    if (agents.length < 32) agents.push(item);
    const key = JSON.stringify([item.provider, item.model]), group = providers.get(key) || { provider: item.provider, model: item.model, tokens: 0, assignments: 0, available: true };
    group.tokens += item.tokens || 0; group.assignments++; group.available &&= item.available; providers.set(key, group);
  }
  const ownTokens = supervisorTokens(session);
  return { supervisorTokens: ownTokens, delegatedTokens, totalTokens: (ownTokens || 0) + delegatedTokens,
    complete: ownTokens != null && Boolean(session.usage?.available || session.goal?.nativeTokensUsed != null || session.goal?.supervisorTokensUsed != null) && available,
    agents, providers: [...providers.values()], assignmentCount: rows.length, omittedAgents: Math.max(0, rows.length - agents.length) };
}
export const budgetUsage = session => delegationUsage(session).totalTokens;
