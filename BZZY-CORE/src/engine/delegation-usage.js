import { database, getRecord } from './database.js';
import { loadSession } from './store.js';
import { supervisorAccounting } from './usage-ledger.js';

const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
function normalizedUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const tokens = count(value.tokens);
  return { ...value, tokens, available: value.available === true && tokens != null,
    accountingComplete: value.available === true && tokens != null && value.accountingComplete !== false };
}
function selectUsage(liveValue, reportedValue) {
  const live = normalizedUsage(liveValue), reported = normalizedUsage(reportedValue);
  const selected = live && (!reported || (live.tokens ?? -1) >= (reported.tokens ?? -1)) ? live : reported;
  if (!selected) return null;
  const regressed = live && reported && live.tokens != null && reported.tokens != null && live.tokens < reported.tokens;
  return { ...selected, accountingComplete: selected.accountingComplete && (!live || live.accountingComplete) && !regressed,
    available: selected.available && (!live || live.available) };
}
function withRunAccounting(usage, ledger, state) {
  if (!usage || !ledger) return usage;
  return ledger.accountingComplete === false || !['starting', 'running'].includes(state) && ledger.state !== 'finished'
    ? { ...usage, accountingComplete: false } : usage;
}

// Assignment state belongs to one objective, even when its conversation is reused.
export function assignmentsFor(session) {
  return database().prepare(`SELECT data FROM records WHERE kind='assignment' AND ${assignmentFilter(session)} ORDER BY updated_at DESC,id`).all(...assignmentParameters(session)).map(row => JSON.parse(row.data));
}
export const assignmentFilter = (session, field = 'data') => `json_extract(${field},'$.parentSessionId')=? AND ${session.goal
  ? `(json_extract(${field},'$.goalId')=? OR (json_extract(${field},'$.goalId') IS NULL AND json_extract(${field},'$.chatRunId') IS NULL AND json_extract(${field},'$.createdAt')>=?))`
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
  let selected = selectUsage(worker?.usage, job.latestReport?.usage);
  const state = getRecord('round', `${job.id}:${job.currentRound}`)?.state || job.latestReport?.state;
  const run = worker && getRecord('run', worker.id);
  selected = withRunAccounting(selected, run && getRecord('usage.run', run.id), state);
  if (!selected && !job.workerSessionId && !job.latestReport && preWorkerStates.has(state) && !job.importedUntrusted
    && database().prepare("SELECT 1 FROM requests WHERE scope=? AND state='recorded' AND json_extract(response,'$.id')=? LIMIT 1")
      .get(`assignment:${job.parentSessionId}:${job.chatRunId || job.goalId || 'chat'}`, job.id)) selected = preWorkerUsage;
  const accounting = assignmentAccounting(selected, job.contract?.limits?.tokenBudget, state);
  return { ...(selected || {}), tokens: selected?.tokens ?? null, available: Boolean(selected?.available), ...accounting,
    elapsedSeconds: worker?.elapsedSeconds ?? job.latestReport?.usage?.elapsedSeconds ?? null };
}
const preWorkerStates = new Set(['interrupted', 'failed', 'cancelled', 'paused']);
const preWorkerUsage = Object.freeze({ tokens: 0, available: true, accountingComplete: true, source: 'host-pre-worker' });
function assignmentAccounting(usage, allowance, state) {
  const accountingComplete = Boolean(usage?.available && usage?.accountingComplete !== false);
  const uncertainFinished = !['starting', 'running'].includes(state) && !accountingComplete;
  const bounded = Number.isSafeInteger(allowance) && allowance > 0;
  return { accountingComplete, chargedTokens: Math.max(usage?.tokens || 0, uncertainFinished && bounded ? allowance : 0),
    conservative: uncertainFinished, unboundedUnknown: uncertainFinished && !bounded };
}
export const assignmentBudgetUsage = job => currentAssignmentUsage(job).chargedTokens;
export function supervisorTokens(session) {
  const attributed = supervisorAccounting(session);
  if (attributed) return attributed.tokens;
  const usage = normalizedUsage(session.usage);
  if (!session.goal) return usage?.tokens ?? null;
  const native = count(session.goal.nativeTokensUsed), supervisor = count(session.goal.supervisorTokensUsed);
  if (!usage?.available && native == null && supervisor == null) return null;
  const own = native ?? supervisor ?? Math.max(0, (count(session.goal.tokensUsed) || 0) - (count(session.goal.delegatedTokensUsed) || 0));
  const base = count(session.goal.supervisorUsageBase);
  const live = base == null ? 0 : Math.max(0, (usage?.tokens || 0) - base);
  return Math.max(own, live);
}
export function delegationUsage(session) {
  // Extract only telemetry. Full reports can become large during an hours-long
  // assessment and must not be parsed again on every budget/watchdog tick.
  const rows = database().prepare(`SELECT a.id, json_extract(a.data,'$.selection.provider') AS provider,
    json_extract(a.data,'$.selection.model') AS model, json_extract(a.data,'$.latestReport.usage') AS reported,
    json_extract(w.data,'$.usage') AS live, json_extract(w.data,'$.elapsedSeconds') AS elapsed,
    json_extract(a.data,'$.contract.limits.tokenBudget') AS allowance, json_extract(r.data,'$.state') AS state,
    ur.id AS usageRunId, json_extract(ur.data,'$.state') AS usageRunState, json_extract(ur.data,'$.accountingComplete') AS usageRunComplete,
    CASE WHEN json_extract(a.data,'$.workerSessionId') IS NULL AND json_extract(a.data,'$.latestReport') IS NULL
      AND COALESCE(json_extract(a.data,'$.importedUntrusted'),0)=0 AND json_extract(r.data,'$.state') IN ('interrupted','failed','cancelled','paused')
      THEN EXISTS(SELECT 1 FROM requests q WHERE q.scope='assignment:' || json_extract(a.data,'$.parentSessionId') || ':' ||
        COALESCE(json_extract(a.data,'$.chatRunId'),json_extract(a.data,'$.goalId'),'chat') AND q.state='recorded' AND json_extract(q.response,'$.id')=a.id)
      ELSE 0 END AS preWorkerZero
    FROM records a LEFT JOIN records w ON w.kind='session' AND w.id=json_extract(a.data,'$.workerSessionId')
    LEFT JOIN records r ON r.kind='round' AND r.id=a.id || ':' || json_extract(a.data,'$.currentRound')
    LEFT JOIN records wr ON wr.kind='run' AND wr.id=w.id
    LEFT JOIN records ur ON ur.kind='usage.run' AND ur.id=json_extract(wr.data,'$.id')
    WHERE a.kind='assignment' AND ${assignmentFilter(session, 'a.data')} ORDER BY a.updated_at DESC,a.id`).all(...assignmentParameters(session));
  let delegatedTokens = 0, chargedDelegatedTokens = 0, available = true, unknownAssignmentCount = 0, unboundedUnknown = false;
  const agents = [], providers = new Map();
  for (const row of rows) {
    const live = row.live ? JSON.parse(row.live) : null, reported = row.reported ? JSON.parse(row.reported) : null;
    const usage = withRunAccounting(selectUsage(live, reported), row.usageRunId ? {
      state: row.usageRunState, accountingComplete: row.usageRunComplete === 1,
    } : null, row.state) || (row.preWorkerZero ? preWorkerUsage : null);
    const accounting = assignmentAccounting(usage, row.allowance, row.state);
    const item = { assignmentId: row.id, provider: row.provider, model: row.model, tokens: usage?.tokens ?? null, available: Boolean(usage?.available),
      ...accounting, elapsedSeconds: row.elapsed ?? reported?.elapsedSeconds ?? null };
    delegatedTokens += item.tokens || 0; chargedDelegatedTokens += item.chargedTokens; available &&= item.accountingComplete;
    unknownAssignmentCount += item.conservative ? 1 : 0; unboundedUnknown ||= item.unboundedUnknown;
    if (agents.length < 32) agents.push(item);
    const key = JSON.stringify([item.provider, item.model]), group = providers.get(key) || { provider: item.provider, model: item.model, tokens: 0, chargedTokens: 0, assignments: 0, available: true };
    group.tokens += item.tokens || 0; group.chargedTokens += item.chargedTokens; group.assignments++; group.available &&= item.accountingComplete; providers.set(key, group);
  }
  const ownTokens = supervisorTokens(session);
  const ownAccounting = supervisorAccounting(session);
  const chargedSupervisorTokens = ownAccounting?.chargedTokens ?? ownTokens ?? 0;
  const invalidSupervisorUsage = session.usage?.tokens !== undefined && count(session.usage.tokens) == null
    || ['nativeTokensUsed', 'supervisorTokensUsed', 'tokensUsed', 'delegatedTokensUsed'].some(key => session.goal?.[key] !== undefined && session.goal?.[key] !== null && count(session.goal[key]) == null);
  unboundedUnknown ||= Boolean(ownAccounting?.unboundedUnknown || invalidSupervisorUsage);
  const totalTokens = (ownTokens || 0) + delegatedTokens, chargedTotalTokens = chargedSupervisorTokens + chargedDelegatedTokens;
  const invalidAggregate = !Number.isSafeInteger(totalTokens) || !Number.isSafeInteger(chargedTotalTokens);
  unboundedUnknown ||= invalidAggregate;
  return { supervisorTokens: ownTokens, delegatedTokens, totalTokens,
    chargedSupervisorTokens, chargedDelegatedTokens, chargedTotalTokens,
    unknownAssignmentCount, unknownSupervisorRuns: ownAccounting?.unknownRuns || 0, unboundedUnknown,
    complete: ownTokens != null && !invalidSupervisorUsage && !invalidAggregate && (ownAccounting ? ownAccounting.accountingComplete : Boolean(normalizedUsage(session.usage)?.accountingComplete || count(session.goal?.nativeTokensUsed) != null || count(session.goal?.supervisorTokensUsed) != null)) && available,
    agents, providers: [...providers.values()], assignmentCount: rows.length, omittedAgents: Math.max(0, rows.length - agents.length) };
}
export const budgetUsage = session => { const usage = delegationUsage(session); return usage.unboundedUnknown ? Infinity : usage.chargedTotalTokens; };
