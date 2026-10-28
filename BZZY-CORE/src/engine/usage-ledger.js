import { database, getRecord, putRecord, transaction, now } from './database.js';

const RUN = 'usage.run', GOAL = 'usage.goal';
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const atomic = operation => database().isTransaction ? operation(database()) : transaction(operation);
const goalKey = (sessionId, goalId) => `${sessionId}:${goalId}`;
const knownGoalTokens = goal => Math.max(0, count(goal?.nativeTokensUsed) || 0, count(goal?.supervisorTokensUsed) || 0,
  (count(goal?.tokensUsed) || 0) - (count(goal?.delegatedTokensUsed) || 0));
function charge(run) {
  const unknown = run.state === 'finished' && !run.accountingComplete;
  return { ...run, chargedTokens: unknown && run.allowance != null ? Math.max(run.measuredTokens, run.allowance) : run.measuredTokens,
    unboundedUnknown: unknown && run.allowance == null };
}

// Core-owned attribution receipts. A native conversation's lifetime counter is
// never itself a goal counter: unrelated chat runs retain a null goal binding.
// These records contain counters/provenance only and grant no replay authority.
export function beginRunUsage(session, run, { tokenBudget } = {}) {
  return atomic(db => {
    const existing = getRecord(RUN, run.id);
    if (existing) return existing;
    // Recovery closes an earlier unfinished receipt without manufacturing a
    // missing backend response or attributing a later chat to that old goal.
    const unfinished = db.prepare("SELECT data FROM records WHERE kind=? AND json_extract(data,'$.sessionId')=? AND json_extract(data,'$.state')='running'").all(RUN, session.id);
    for (const row of unfinished) {
      const previous = JSON.parse(row.data);
      putRecord(RUN, previous.runId, charge({ ...previous, state: 'finished', accountingComplete: false, finishedAt: now() }), db);
    }
    const goal = run.goalMode ? session.goal : null;
    if (goal && !getRecord(GOAL, goalKey(session.id, goal.id))) {
      const legacyTokens = knownGoalTokens(goal);
      const legacyInvalid = ['nativeTokensUsed', 'supervisorTokensUsed', 'tokensUsed', 'delegatedTokensUsed']
        .some(key => goal[key] !== undefined && goal[key] !== null && count(goal[key]) == null);
      putRecord(GOAL, goalKey(session.id, goal.id), { version: 1, sessionId: session.id, goalId: goal.id, legacyTokens,
        legacyInvalid, legacyComplete: !legacyInvalid && (legacyTokens === 0 || Boolean(session.usage?.available || count(goal.nativeTokensUsed) != null || count(goal.supervisorTokensUsed) != null)), createdAt: now() }, db);
    }
    const baselineTokens = count(session.usage?.tokens) || 0;
    const limit = count(tokenBudget);
    const allowance = limit == null ? null : Math.max(0, limit - (goal ? knownGoalTokens(goal) : baselineTokens));
    const receipt = { version: 1, runId: run.id, sessionId: session.id, goalId: goal?.id || null, provider: session.provider,
      backend: session.backend, counter: 'backend-total-tokens', baselineTokens, baselineGoalTokens: knownGoalTokens(goal),
      sessionHighWater: baselineTokens, goalHighWater: knownGoalTokens(goal), measuredTokens: 0, chargedTokens: 0,
      observed: false, accountingComplete: false, allowance, state: 'running', startedAt: now() };
    if (session.usage?.tokens !== undefined && count(session.usage.tokens) == null) receipt.counterInvalid = true;
    putRecord(RUN, run.id, receipt, db); return receipt;
  });
}

export function observeRunUsage(session, runId, { nativeGoal = false, final = false } = {}) {
  if (!runId) return null;
  return atomic(db => {
    const previous = getRecord(RUN, runId);
    if (!previous || previous.sessionId !== session.id) return null;
    const value = nativeGoal ? count(session.goal?.nativeTokensUsed) : count(session.usage?.tokens);
    if (value == null || nativeGoal && (previous.goalId !== session.goal?.id || session.backend !== 'codex')) return previous;
    const sessionHighWater = nativeGoal ? previous.sessionHighWater : Math.max(previous.sessionHighWater, value);
    const goalHighWater = nativeGoal ? Math.max(previous.goalHighWater, value) : previous.goalHighWater;
    const counterReset = Boolean(previous.counterReset || value < (nativeGoal ? previous.goalHighWater : previous.sessionHighWater));
    // Only adapter-normalized total-token counters are reconciled. USD, cache
    // subtotals and provider-specific billable units never enter this maximum.
    const measuredTokens = Math.max(previous.measuredTokens, sessionHighWater - previous.baselineTokens, goalHighWater - previous.baselineGoalTokens);
    const accountingComplete = !previous.counterInvalid && !counterReset && (nativeGoal || Boolean(session.usage?.available && session.usage?.accountingComplete !== false));
    const next = charge({ ...previous, sessionHighWater, goalHighWater, measuredTokens, observed: true,
      ...(final && accountingComplete ? { finalReceipt: true } : {}),
      accountingComplete, ...(counterReset ? { counterReset: true } : {}), updatedAt: now() });
    putRecord(RUN, runId, next, db); return next;
  });
}

export function endRunUsage(session, runId, { noRequest = false, uncertain = false } = {}) {
  return atomic(db => {
    const previous = getRecord(RUN, runId);
    if (!previous || previous.sessionId !== session.id || previous.state === 'finished') return previous;
    const next = charge({ ...previous, state: 'finished', measuredTokens: noRequest ? 0 : previous.measuredTokens,
      accountingComplete: noRequest || (!uncertain || previous.finalReceipt === true) && previous.accountingComplete,
      ...(noRequest ? { preRequestFailure: true } : {}), ...(uncertain && !noRequest && !previous.finalReceipt ? { uncertainEnd: true } : {}), finishedAt: now() });
    putRecord(RUN, runId, next, db); return next;
  });
}

export function supervisorAccounting(session) {
  const goal = session.goal;
  const baseline = goal && getRecord(GOAL, goalKey(session.id, goal.id));
  if (goal && !baseline) return null; // Explicit legacy fallback lives in the caller.
  const filter = goal ? " AND json_extract(data,'$.goalId')=?" : '';
  const parameters = goal ? [RUN, session.id, goal.id] : [RUN, session.id];
  const totals = database().prepare(`SELECT COALESCE(SUM(json_extract(data,'$.measuredTokens')),0) AS measured,
    COALESCE(SUM(json_extract(data,'$.chargedTokens')),0) AS charged,
    COUNT(*) FILTER (WHERE json_extract(data,'$.state')='finished' AND json_extract(data,'$.accountingComplete')=0) AS unknown,
    COUNT(*) FILTER (WHERE json_extract(data,'$.accountingComplete')=0) AS incomplete,
    COUNT(*) FILTER (WHERE json_extract(data,'$.unboundedUnknown')=1) AS unbounded,
    COUNT(*) AS runs FROM records WHERE kind=? AND json_extract(data,'$.sessionId')=?${filter}`).get(...parameters);
  if (!goal && !totals.runs) return null;
  const tokens = goal ? baseline.legacyTokens + totals.measured : count(session.usage?.tokens);
  const chargedTokens = goal ? baseline.legacyTokens + totals.charged : (tokens || 0) + Math.max(0, totals.charged - totals.measured);
  return { tokens, chargedTokens, accountingComplete: (goal ? baseline.legacyComplete : Boolean(session.usage?.available)) && totals.incomplete === 0,
    unknownRuns: totals.unknown, unboundedUnknown: Boolean(baseline?.legacyInvalid || totals.unbounded > 0), source: 'durable-run-attribution' };
}

const claudeFields = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'];
function claudeParts(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !claudeFields.some(key => Object.hasOwn(value, key))) return null;
  if (claudeFields.some(key => value[key] !== undefined && count(value[key]) == null)) return null;
  const parts = Object.fromEntries(claudeFields.map(key => [key, value[key] || 0]));
  return count(Object.values(parts).reduce((sum, item) => sum + item, 0)) == null ? null : parts;
}
// Claude assistant-message usage and final result usage share these four
// disjoint total-token components. The final result is an aggregate, not an
// additional request; repeated message IDs update per-component high waters.
export function createClaudeUsageCounter() {
  const messages = new Map(); let finalTokens = null, streamedTokens = 0, available = false;
  const snapshot = () => ({ tokens: Math.max(streamedTokens, finalTokens || 0), available,
    accountingComplete: finalTokens != null, streamedTokens, finalTokens, counter: 'claude-total-tokens' });
  return {
    observeMessage(id, value) {
      const parts = claudeParts(value);
      if (typeof id !== 'string' || !id || !parts) return snapshot();
      const previous = messages.get(id) || Object.fromEntries(claudeFields.map(key => [key, 0]));
      const next = Object.fromEntries(claudeFields.map(key => [key, Math.max(previous[key], parts[key])]));
      streamedTokens += claudeFields.reduce((sum, key) => sum + next[key] - previous[key], 0);
      messages.set(id, next); available = true; return snapshot();
    },
    finalize(value) {
      const parts = claudeParts(value);
      if (parts) { finalTokens = Math.max(finalTokens || 0, Object.values(parts).reduce((sum, item) => sum + item, 0)); available = true; }
      return snapshot();
    },
    snapshot,
  };
}
