import { database, getRecord, putRecord, digest, now, transaction } from './database.js';
import { normalizeCompactionTokens, deepseekPricing, estimateDeepseekUsage, sessionCompactionCost } from './compaction-cost.js';

const CURSOR = 'core.session.spending.cursor', RECEIPT = 'core.session.spending.receipt';
const atomic = operation => database().isTransaction ? operation(database()) : transaction(operation);
const cursorId = (session, threadId) => digest([session.id, session.provider, threadId]);
const documentSource = session => session.role === 'learning-review' && session.purpose === 'document' ? session.documentSourceSessionId : null;
const costSession = session => documentSource(session) || session.id;
const foreground = session => session.provider === 'deepseek' && session.documentTaskKind !== 'session-compaction' &&
  (documentSource(session) || !['learning-review', 'knowledge-review', 'skill-writer'].includes(session.role));
export const deepseekSpendingVisible = session => session?.mode === 'delegate'
  ? session.provider === 'deepseek' || session.executor?.provider === 'deepseek'
  : (!session?.mode || session.mode === 'solo') && session?.provider === 'deepseek';

export function beginSessionCost(session, { threadId, resumed } = {}) {
  if (!foreground(session) || !threadId) return;
  const id = cursorId(session, threadId);
  const previous = getRecord(CURSOR, id);
  putRecord(CURSOR, id, previous ? { ...previous, originSessionId: session.id, updatedAt: now() } : { id, sessionId: costSession(session), originSessionId: session.id, epoch: 0, historical: Boolean(resumed),
    total: resumed ? null : { input: 0, cached: 0, output: 0, total: 0 }, updatedAt: now() });
}
export function observeSessionCost(session, { threadId, tokenUsage } = {}) {
  if (!foreground(session) || !threadId) return null;
  return atomic(db => {
    const id = cursorId(session, threadId);
    if (!getRecord(CURSOR, id)) beginSessionCost(session, { threadId, resumed: true });
    const cursor = getRecord(CURSOR, id), total = normalizeCompactionTokens(tokenUsage?.total);
    if (total && cursor.total && JSON.stringify(total) === JSON.stringify(cursor.total)) return null;
    const at = now(), previous = cursor.total;
    const reset = total && previous && (total.input < previous.input || total.output < previous.output ||
      total.cached !== null && previous.cached !== null && total.cached < previous.cached);
    let tokens;
    if (total && previous && !reset) tokens = normalizeCompactionTokens({ inputTokens: total.input - previous.input,
      outputTokens: total.output - previous.output,
      ...(total.cached !== null && previous.cached !== null ? { cachedInputTokens: total.cached - previous.cached } : {}) });
    else {
      const last = normalizeCompactionTokens(tokenUsage?.last);
      if (last && total && last.input <= total.input && last.output <= total.output) tokens = last;
    }
    const epoch = cursor.epoch + (reset ? 1 : 0), numericTotal = tokenUsage?.total?.totalTokens;
    const receiptId = digest([id, epoch, total || (Number.isSafeInteger(numericTotal) ? numericTotal : 'unknown')]);
    const existing = getRecord(RECEIPT, receiptId);
    if (existing) return existing;
    const model = session.resolvedModel || session.model || null;
    const receipt = { version: 1, id: receiptId, sessionId: costSession(session), provider: 'deepseek', model, startedAt: cursor.updatedAt,
      observedAt: at, tokens: tokens || null, pricing: deepseekPricing('deepseek', model, at), complete: Boolean(tokens) };
    receipt.estimateNanos = estimateDeepseekUsage(receipt, at);
    putRecord(RECEIPT, receiptId, receipt, db);
    putRecord(CURSOR, id, { ...cursor, epoch, total, historical: Boolean(cursor.historical || reset || !tokens), updatedAt: at }, db);
    return receipt;
  });
}
const usd = (min, max) => ({ min: min / 1e9, max: max / 1e9 });
export function sessionSpending(sessionId, { sessionIds = [sessionId], bounded = false } = {}) {
  const db = database(), ids = JSON.stringify(sessionIds);
  const chat = db.prepare(`SELECT count(*) AS updates,
    coalesce(sum(json_type(data,'$.estimateNanos.min')='integer'),0) AS pricedUpdates,
    coalesce(sum(json_extract(data,'$.estimateNanos.min')),0) AS minNanos,
    coalesce(sum(json_extract(data,'$.estimateNanos.max')),0) AS maxNanos
    FROM records WHERE kind=? AND json_extract(data,'$.sessionId') IN (SELECT value FROM json_each(?))`).get(RECEIPT, ids);
  const legacy = db.prepare(`SELECT count(*) AS count FROM events WHERE type='usage.updated'
    AND session_id IN (SELECT value FROM json_each(?)) AND json_extract(data,'$.provider')='deepseek'
    AND json_extract(data,'$.spendingTracked') IS NULL AND json_extract(data,'$.spendingBaseline') IS NULL`).get(ids).count;
  const historical = db.prepare(`SELECT count(*) AS count FROM records WHERE kind=?
    AND json_extract(data,'$.sessionId') IN (SELECT value FROM json_each(?)) AND json_extract(data,'$.historical')=1`).get(CURSOR, ids).count;
  const untracked = db.prepare(`SELECT count(*) AS count FROM records s WHERE s.kind='session'
    AND s.id IN (SELECT value FROM json_each(?)) AND json_extract(s.data,'$.provider')='deepseek'
    AND json_extract(s.data,'$.usage.available')=1 AND json_extract(s.data,'$.usage.tokens')>0
    AND NOT EXISTS(SELECT 1 FROM records c WHERE c.kind=? AND json_extract(c.data,'$.originSessionId')=s.id)`).get(ids, CURSOR).count;
  const documentScope = `s.kind='session' AND json_extract(s.data,'$.provider')='deepseek'
    AND json_extract(s.data,'$.role')='learning-review' AND json_extract(s.data,'$.purpose')='document'
    AND json_extract(s.data,'$.documentSourceSessionId') IN (SELECT value FROM json_each(?))
    AND coalesce(json_extract(s.data,'$.documentTaskKind'),'')!='session-compaction'`;
  const legacyDocuments = db.prepare(`SELECT count(*) AS count FROM records s WHERE ${documentScope}
    AND json_extract(s.data,'$.engineThreadId') IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM records c WHERE c.kind=? AND json_extract(c.data,'$.originSessionId')=s.id)`).get(ids, CURSOR).count;
  const activeDocuments = db.prepare(`SELECT count(*) AS count FROM records s WHERE ${documentScope}
    AND json_extract(s.data,'$.executionState')='running'`).get(ids).count;
  const uncertain = activeDocuments + db.prepare(`SELECT count(*) AS count FROM records WHERE kind='usage.run'
    AND json_extract(data,'$.sessionId') IN (SELECT value FROM json_each(?)) AND json_extract(data,'$.provider')='deepseek'
    AND (json_extract(data,'$.state')='running' OR json_extract(data,'$.accountingComplete')=0)`).get(ids).count;
  const historyGap = Boolean(legacy || historical || untracked || legacyDocuments);
  const chatPart = { updates: chat.updates, unpricedUpdates: chat.updates - chat.pricedUpdates,
    historical: historyGap, incompleteRuns: uncertain,
    complete: !bounded && !historyGap && !uncertain && chat.updates === chat.pricedUpdates,
    estimatedUsd: chat.pricedUpdates || !chat.updates && !historyGap && !uncertain ? usd(chat.minNanos, chat.maxNanos) : null };
  const compaction = sessionCompactionCost(sessionId, db, sessionIds), models = compaction.models.filter(row => row.provider === 'deepseek');
  const summaries = db.prepare(`SELECT count(*) AS count FROM records WHERE kind='core.session.compactor.job'
    AND json_extract(data,'$.sessionId') IN (SELECT value FROM json_each(?)) AND json_extract(data,'$.state')='completed'
    AND json_extract(data,'$.selection.provider')='deepseek'`).get(ids).count;
  const compactorPart = { attempts: models.reduce((sum, row) => sum + row.attempts, 0), summaries,
    unpricedAttempts: models.reduce((sum, row) => sum + row.unpricedAttempts, 0),
    incompleteAttempts: models.reduce((sum, row) => sum + row.incompleteAttempts, 0),
    legacyAttempts: models.reduce((sum, row) => sum + row.legacyAttempts, 0), models };
  const priced = models.filter(row => row.estimatedUsd);
  compactorPart.estimatedUsd = priced.length || !compactorPart.attempts
    ? { min: priced.reduce((sum, row) => sum + row.estimatedUsd.min, 0), max: priced.reduce((sum, row) => sum + row.estimatedUsd.max, 0) } : null;
  compactorPart.complete = !bounded && !compactorPart.unpricedAttempts && !compactorPart.incompleteAttempts;
  const known = [chatPart.estimatedUsd, compactorPart.estimatedUsd].filter(Boolean);
  const hasKnownAmount = known.length === 2 || known.some(part => part.max > 0);
  return { version: 1, sessionId, currency: 'USD', provider: 'deepseek', scope: 'session-and-linked-workers', bounded, chat: chatPart, compactor: compactorPart,
    total: { estimatedUsd: hasKnownAmount ? { min: known.reduce((sum, part) => sum + part.min, 0), max: known.reduce((sum, part) => sum + part.max, 0) } : null,
      complete: chatPart.complete && compactorPart.complete }, pricingVerifiedAt: '2026-10-28',
    meaning: 'Only direct DeepSeek API usage is added. Chat includes linked workers/reviews and backend context compaction reported in its usage. Background summaries are separate. Account balance is account-wide and is never used to infer this session bill.' };
}
