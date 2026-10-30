import { database, getRecord, putRecord, now } from './database.js';

const KIND = 'core.session.compactor.cost';
const count = value => Number.isSafeInteger(value) && value >= 0;
const source = 'https://api-docs.deepseek.com/quick_start/pricing/';
// USD nanodollars per token, verified 2026-10-28. Pin these to each attempt;
// later catalog changes must never reprice a saved receipt. No account lookup.
const rates = { flash: { cached: 3, input: 150, output: 600 }, pro: { cached: 22, input: 660, output: 1980 } };
function family(model) {
  return ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'DeepSeek-V4.1-Flash-1017'].includes(model) ? 'flash'
    : ['deepseek-v4-pro', 'DeepSeek-V4-Pro-0813'].includes(model) ? 'pro' : null;
}
function pricing(provider, model, at) {
  const selected = provider === 'deepseek' && family(model);
  return selected && at >= '2026-10-28' ? { version: 'deepseek-2026-10-28', verifiedAt: '2026-10-28', source,
    currency: 'USD', family: selected, nanosPerToken: { ...rates[selected] } } : null;
}
// Peak windows may instead be off-peak on Chinese public holidays. Retain a
// range without guessing that calendar or the provider's boundary-time rule.
function peakPossible(start, end) {
  const first = Date.parse(start), last = Date.parse(end);
  if (!Number.isFinite(first) || !Number.isFinite(last) || last < first || last - first > 600000) return true;
  const peak = ms => {
    const date = new Date(ms), day = date.getUTCDay(), hour = date.getUTCHours();
    return day > 0 && day < 6 && (hour >= 1 && hour < 4 || hour >= 6 && hour < 10);
  };
  for (let time = first; time <= last; time += 60000) if (peak(time)) return true;
  return peak(last);
}
export function normalizeCompactionTokens(detail) {
  if (!detail || !count(detail.inputTokens) || !count(detail.outputTokens)) return null;
  const total = detail.inputTokens + detail.outputTokens;
  if (!count(total) || detail.totalTokens !== undefined && detail.totalTokens !== total ||
      detail.cachedInputTokens !== undefined && (!count(detail.cachedInputTokens) || detail.cachedInputTokens > detail.inputTokens)) return null;
  return { input: detail.inputTokens, cached: detail.cachedInputTokens ?? null, output: detail.outputTokens, total };
}
function estimate(receipt, at) {
  if (receipt.noInference) return { min: 0, max: 0 };
  const usage = receipt.tokens, price = receipt.pricing;
  if (!usage || !price || receipt.modelMismatch) return null;
  const rate = price.nanosPerToken, cached = usage.cached;
  const min = (cached ?? usage.input) * rate.cached + (cached === null ? 0 : usage.input - cached) * rate.input + usage.output * rate.output;
  const baseMax = (cached ?? 0) * rate.cached + (usage.input - (cached ?? 0)) * rate.input + usage.output * rate.output;
  const max = baseMax * (peakPossible(receipt.startedAt, at) ? 2 : 1);
  return count(min) && count(max) ? { min, max } : null;
}
export { pricing as deepseekPricing, estimate as estimateDeepseekUsage };
export function beginCompactionCost(draft, selection) {
  if (draft.documentTaskKind !== 'session-compaction') return;
  if (getRecord(KIND, draft.id)) return;
  const startedAt = now();
  putRecord(KIND, draft.id, { version: 1, id: draft.id, sessionId: draft.documentSourceSessionId, jobId: draft.documentTaskId,
    provider: selection.provider, model: selection.model, startedAt, state: 'running', complete: false,
    pricing: pricing(selection.provider, selection.model, startedAt), tokens: null, estimateNanos: null });
}
export function observeCompactionCost(draft, data) {
  if (draft.documentTaskKind !== 'session-compaction') return;
  const receipt = getRecord(KIND, draft.id);
  if (!receipt || receipt.state !== 'running' || data?.provider !== receipt.provider) return;
  const tokens = normalizeCompactionTokens(data.detail);
  const reportedTokens = tokens?.total ?? (data.available === true && count(data.tokens) ? data.tokens : null);
  if (reportedTokens === null) return;
  const previous = receipt.tokens;
  const reset = receipt.counterReset || count(receipt.reportedTokens) && reportedTokens < receipt.reportedTokens
    || tokens && previous && (tokens.input < previous.input || tokens.output < previous.output ||
      tokens.cached !== null && previous.cached !== null && tokens.cached < previous.cached);
  // These are cumulative native-thread totals for a fresh document draft.
  // Duplicate telemetry replaces the same receipt instead of adding a charge.
  const at = now(), next = { ...receipt, tokens: reset ? previous : tokens || (previous?.total === reportedTokens ? previous : null), reportedTokens: reset ? receipt.reportedTokens ?? previous?.total : reportedTokens,
    accountingComplete: data.accountingComplete !== false, counterReset: Boolean(reset), updatedAt: at };
  if (data.model && data.model !== receipt.model && (!family(data.model) || family(data.model) !== receipt.pricing?.family)) next.modelMismatch = true;
  next.estimateNanos = estimate(next, at); putRecord(KIND, draft.id, next);
}
export function finishCompactionCost(draft, { completed = false, noInference = false } = {}) {
  if (draft.documentTaskKind !== 'session-compaction') return;
  const receipt = getRecord(KIND, draft.id);
  if (!receipt || receipt.state === 'finished') return;
  const finishedAt = now(), next = { ...receipt, state: 'finished', finishedAt, noInference,
    complete: noInference || Boolean(completed && (receipt.tokens || count(receipt.reportedTokens)) && receipt.accountingComplete !== false && !receipt.counterReset) };
  if (draft.resolvedModel && draft.resolvedModel !== receipt.model &&
      (!family(draft.resolvedModel) || family(draft.resolvedModel) !== receipt.pricing?.family)) next.modelMismatch = true;
  next.estimateNanos = estimate(next, finishedAt); putRecord(KIND, draft.id, next);
}

// Owner-local, read-only lifetime projection. Jobs older than the ledger remain
// visible as unpriced attempts. Never use their conservative token reservations
// as measured spending, and never replay a request to fill a historical gap.
export function sessionCompactionCost(sessionId, db = database(), sessionIds = [sessionId]) {
  const ids = JSON.stringify(sessionIds);
  const groups = db.prepare(`SELECT json_extract(data,'$.provider') AS provider,json_extract(data,'$.model') AS model,
    count(*) AS attempts,sum(json_extract(data,'$.complete')=1) AS completeAttempts,
    coalesce(sum(json_type(data,'$.estimateNanos.min')='integer'),0) AS pricedAttempts,
    coalesce(sum(json_extract(data,'$.estimateNanos.min')),0) AS minNanos,
    coalesce(sum(json_extract(data,'$.estimateNanos.max')),0) AS maxNanos,
    coalesce(sum(coalesce(json_extract(data,'$.reportedTokens'),json_extract(data,'$.tokens.total'))),0) AS reportedTokens,
    min(json_extract(data,'$.startedAt')) AS trackedSince
    FROM records WHERE kind=? AND json_extract(data,'$.sessionId') IN (SELECT value FROM json_each(?)) GROUP BY provider,model`).all(KIND, ids);
  const legacy = db.prepare(`SELECT json_extract(j.data,'$.selection.provider') AS provider,json_extract(j.data,'$.selection.model') AS model,
    sum(max(0,coalesce(json_extract(j.data,'$.attempts'),0)-coalesce(c.attempts,0))) AS attempts
    FROM records j LEFT JOIN (SELECT json_extract(data,'$.jobId') AS jobId,count(*) AS attempts FROM records
      WHERE kind=? AND json_extract(data,'$.sessionId') IN (SELECT value FROM json_each(?)) GROUP BY jobId) c ON c.jobId=j.id
    WHERE j.kind='core.session.compactor.job' AND json_extract(j.data,'$.sessionId') IN (SELECT value FROM json_each(?)) GROUP BY provider,model`).all(KIND, ids, ids);
  const rows = new Map(groups.map(row => [JSON.stringify([row.provider, row.model]), { ...row, legacyAttempts: 0 }]));
  for (const row of legacy) {
    if (!row.attempts) continue;
    const key = JSON.stringify([row.provider, row.model]);
    if (!rows.has(key)) rows.set(key, { provider: row.provider, model: row.model, attempts: 0, completeAttempts: 0, pricedAttempts: 0,
      minNanos: 0, maxNanos: 0, reportedTokens: 0, trackedSince: null, legacyAttempts: 0 });
    rows.get(key).legacyAttempts += row.attempts;
  }
  const totals = { attempts: 0, completeAttempts: 0, pricedAttempts: 0, legacyAttempts: 0, minNanos: 0, maxNanos: 0, reportedTokens: 0 };
  for (const row of rows.values()) for (const key of Object.keys(totals)) totals[key] += row[key];
  const shown = row => ({ provider: row.provider, model: row.model, attempts: row.attempts + row.legacyAttempts,
    pricedAttempts: row.pricedAttempts, unpricedAttempts: row.attempts - row.pricedAttempts + row.legacyAttempts,
    incompleteAttempts: row.attempts - row.completeAttempts + row.legacyAttempts, legacyAttempts: row.legacyAttempts,
    reportedTokens: row.reportedTokens,
    estimatedUsd: row.pricedAttempts || row.attempts + row.legacyAttempts === 0 ? { min: row.minNanos / 1e9, max: row.maxNanos / 1e9 } : null });
  const tracked = groups.map(row => row.trackedSince).filter(Boolean).sort();
  const summaries = db.prepare(`SELECT count(*) AS count FROM records WHERE kind='core.session.compactor.job'
    AND json_extract(data,'$.sessionId') IN (SELECT value FROM json_each(?)) AND json_extract(data,'$.state')='completed'`).get(ids).count;
  return { version: 1, sessionId, scope: 'session-background-compactor', ...shown(totals), summaries,
    complete: totals.legacyAttempts === 0 && totals.attempts === totals.completeAttempts && totals.attempts === totals.pricedAttempts,
    trackedSince: tracked[0] || null, models: [...rows.values()].map(shown),
    pricingSource: source, pricingVerifiedAt: '2026-10-28',
    meaning: 'Estimated direct background-summary cost from reported usage. Native context compaction, chat, workers and possible future savings are separate. Unpriced or interrupted attempts are not zero. Peak/holiday and missing-cache uncertainty use a price range.' };
}

// Measured usage is independent of pricing. Unknown/conservative reservations
// never become token consumption in a terminal status row.
export function sessionCompactorUsage(sessionId) {
  const cost = sessionCompactionCost(sessionId);
  const complete = cost.incompleteAttempts === 0 && cost.legacyAttempts === 0;
  return { version: 1, sessionId, scope: 'session-background-compactor', tokens: cost.reportedTokens,
    available: cost.attempts === 0 || cost.reportedTokens > 0 || complete, complete,
    attempts: cost.attempts, incompleteAttempts: cost.incompleteAttempts, legacyAttempts: cost.legacyAttempts };
}
