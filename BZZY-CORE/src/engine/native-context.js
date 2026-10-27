import { appendEvent, digest, getRecord, putRecord, transaction } from './database.js';
import { saveSession, sessionDeleted, sessionPath, writeJson } from './store.js';

const positive = value => Number.isSafeInteger(value) && value > 0;
const stamp = () => new Date().toISOString();

// These are the values submitted to the native planner, not a measurement of
// the upstream model's actual window. Never inherit a template model's window.
export function nativeContextBudget(provider, session) {
  const model = session.model || provider.model;
  const discovered = session.modelCapabilities?.contextWindow;
  const exact = provider.modelCapabilities?.[model]?.contextWindow;
  const configured = provider.contextWindow;
  const [tokens, source] = positive(discovered) ? [discovered, 'discovered-model-capability']
    : positive(exact) ? [exact, 'configured-exact-model-capability']
      : positive(configured) ? [configured, 'configured-provider-default']
        : provider.auth === 'api-key' ? [32768, 'conservative-local-fallback'] : [null, 'native-backend-unreported'];
  return { version: 1, tokens, maxTokens: tokens, source, model: model || null,
    provider: provider.id, appliedToNativeCatalog: provider.auth === 'api-key', upstreamVerified: false,
    revision: digest({ provider: provider.id, model, tokens, source }) };
}

export function toolSchemaManifest(tools = [], source = 'submitted') {
  return { source, count: tools.length, names: tools.map(tool => tool.name).filter(name => typeof name === 'string').sort(),
    sha256: digest(tools), bytes: Buffer.byteLength(JSON.stringify(tools)) };
}

export function prepareNativeReadiness(session, { backend, threadId, tools, instructions, contextBudget, resumed = false }) {
  const previous = session.nativeBackendReadiness;
  const inherited = resumed && previous?.threadRef === digest(threadId || '') && previous?.backend === backend && typeof previous?.tools?.sha256 === 'string';
  const toolsManifest = resumed ? inherited ? { ...previous.tools, source: 'inherited-recorded-native-thread' }
    : { source: 'unknown-legacy-native-thread', count: null, names: null, sha256: null }
    : toolSchemaManifest(tools || []);
  const manifest = { version: 1, backend, provider: session.provider, model: session.model || null,
    phase: 'requested', requestedAt: stamp(), ...(threadId ? { threadRef: digest(threadId) } : {}),
    tools: toolsManifest, contextBudget, instructions: { sha256: digest(instructions || ''), bytes: Buffer.byteLength(instructions || '') },
    catalogReadiness: { nativeTools: resumed ? inherited ? 'inherited-recorded' : 'unknown-legacy' : 'requested',
      skillPrompt: resumed ? 'inherited-not-reenumerated' : 'prepared', acknowledgment: 'not-yet-received' } };
  session.nativeBackendReadiness = manifest;
  saveSession(session);
  return manifest;
}

export function acknowledgeNativeReadiness(session, { threadId, reportedTools, phase = 'request-accepted' } = {}) {
  const manifest = session.nativeBackendReadiness;
  if (!manifest) return null;
  manifest.phase = phase; manifest.acknowledgedAt = stamp();
  if (threadId) manifest.threadRef = digest(threadId);
  manifest.catalogReadiness.acknowledgment = phase;
  // A successful thread/control request does not enumerate or verify schemas.
  if (Array.isArray(reportedTools)) manifest.reportedTools = [...new Set(reportedTools.filter(name => typeof name === 'string'))].sort();
  saveSession(session);
  return manifest;
}

function contextState(session, threadId) {
  const threadRef = digest(threadId || 'unknown-thread');
  if (!session.nativeContext || session.nativeContext.threadRef !== threadRef) session.nativeContext = {
    version: 1, threadRef, epoch: 0, metrics: { modernStarted: 0, modernCompleted: 0, legacySignals: 0,
      completedDurationMs: 0, durationSamples: 0, recent: [] }, refresh: null };
  return session.nativeContext;
}

function event(session, data, db) {
  const run = getRecord('run', session.id);
  appendEvent(session.id, 'diagnostic.context', { version: 1, runId: run?.id || null,
    goalId: run?.goalMode ? run.goalId : null, ...data }, db);
}

// Item IDs are durably deduplicated rather than keeping an ever-growing list in
// the session or relying on an in-memory cache that disappears on recovery.
export function recordNativeCompaction(session, { threadId, turnId, itemId, phase, legacy = false, at = Date.now(), reason }) {
  const state = contextState(session, threadId);
  const runId = getRecord('run', session.id)?.id || null;
  if (state.lastSignalRunId !== runId) {
    state.lastSignalRunId = runId; state.lastModernTurnId = null; state.lastLegacyTurnId = null;
  }
  const identity = digest({ session: session.id, run: runId, thread: state.threadRef,
    item: itemId || (legacy ? `legacy:${turnId || `unidentified-signal-${state.metrics.legacySignals + 1}`}` : null) });
  const receipt = getRecord('native-compaction', identity) || { id: identity, sessionId: session.id,
    runId, threadRef: state.threadRef, turnId: turnId || null, itemRef: itemId ? digest(itemId) : null, legacy };
  if (phase === 'started') {
    if (receipt.startedAt != null || receipt.completedAt != null) return false;
    receipt.startedAt = at; state.metrics.modernStarted++;
  } else {
    if (receipt.completedAt != null) return false;
    receipt.completedAt = at;
    const priorModernTurnId = state.lastModernTurnId;
    if (legacy) { state.metrics.legacySignals++; state.lastLegacyTurnId = turnId || null; }
    else {
      state.metrics.modernCompleted++;
      const durationMs = receipt.startedAt == null ? null : Math.max(0, at - receipt.startedAt);
      if (durationMs != null) { state.metrics.completedDurationMs += durationMs; state.metrics.durationSamples++; }
      state.metrics.recent = [...state.metrics.recent, { at, startedAt: receipt.startedAt ?? null, durationMs }].slice(-64);
      state.lastModernTurnId = turnId || null;
    }
    // A legacy signal has no stable item identity. If a modern completion was
    // already seen in this turn, preserve it as a signal, not another item.
    const coalesced = Boolean(turnId && (legacy ? priorModernTurnId === turnId
      : state.lastLegacyTurnId === turnId && priorModernTurnId !== turnId));
    if (!coalesced) {
      state.epoch++;
      const uncertain = ['dispatching', 'uncertain'].includes(state.refresh?.state);
      const alreadyPending = ['pending', 'dispatching', 'uncertain'].includes(state.refresh?.state);
      state.refresh = { ...(uncertain ? state.refresh : {}), state: uncertain ? state.refresh.state : 'pending',
        epoch: state.epoch, requestedAt: alreadyPending ? state.refresh.requestedAt : stamp(), latestRequestedAt: stamp(),
        reason: uncertain ? state.refresh.reason : reason || 'awaiting-safe-prompt',
        nextDelivery: 'next-safe-prompt', ...(uncertain ? { supersededByEpoch: state.epoch } : {}) };
      session.sessionMemoryRefresh = true;
    }
    receipt.coalesced = Boolean(coalesced);
    state.metrics.rolling = nativeCompactionPressure(state, at);
  }
  let durable;
  transaction(db => {
    if (sessionDeleted(session.id)) throw Object.assign(new Error('This chat was deleted.'), { code: 'SESSION_DELETED' });
    const current = getRecord('session', session.id);
    durable = { ...current, nativeContext: state, sessionMemoryRefresh: session.sessionMemoryRefresh, updatedAt: stamp() };
    // The dedup receipt and its pending refresh must commit together. A crash
    // cannot retain the receipt while losing the demand it deduplicates.
    putRecord('native-compaction', identity, receipt, db); putRecord('session', session.id, durable, db);
    event(session, { method: 'native-compaction', phase, legacy, receiptRef: identity, threadRef: state.threadRef,
      turnId: turnId || null, epoch: state.epoch, durationMs: receipt.startedAt == null || receipt.completedAt == null ? null : Math.max(0, receipt.completedAt - receipt.startedAt),
      refresh: state.refresh, metrics: state.metrics, metricMeaning: 'native-lifecycle-wall-time; not CPU, billing or inference time' }, db);
  });
  session.updatedAt = durable.updatedAt;
  writeJson(sessionPath(session.id), durable);
  return true;
}

export function pendingNativeRefresh(session, reason) {
  if (!session.nativeContext?.refresh || session.nativeContext.refresh.state !== 'pending') return;
  if (session.nativeContext.refresh.reason === reason) return;
  session.nativeContext.refresh.reason = reason;
  saveSession(session);
  event(session, { method: 'host-context-refresh', outcome: 'pending', threadRef: session.nativeContext.threadRef, refresh: session.nativeContext.refresh });
}

// Prompt preparation can fail or be interrupted. Only the adapter's accepted
// transport response is allowed to consume the captured epoch.
export function markNativeRefreshPrepared(session, epoch) {
  const refresh = session.nativeContext?.refresh;
  if (!refresh || refresh.epoch !== epoch || !['pending', 'uncertain'].includes(refresh.state)) return;
  refresh.preparedEpoch = epoch; refresh.preparedAt = stamp();
  saveSession(session);
}

export function consumeNativeRefresh(session, epoch, delivery) {
  const refresh = session.nativeContext?.refresh;
  if (!refresh || epoch == null || refresh.epoch !== epoch || refresh.preparedEpoch !== epoch) return;
  refresh.state = 'consumed'; refresh.delivery = delivery; refresh.consumedAt = stamp();
  session.sessionMemoryRefresh = false;
  saveSession(session);
  event(session, { method: 'host-context-refresh', outcome: 'consumed', threadRef: session.nativeContext.threadRef, refresh });
}

export function updateNativeRefresh(session, input) {
  if (!session.nativeContext?.refresh) return;
  Object.assign(session.nativeContext.refresh, input);
  saveSession(session);
  event(session, { method: 'host-context-refresh', outcome: input.state || 'pending', threadRef: session.nativeContext.threadRef, refresh: session.nativeContext.refresh });
}

export function nativeInputEstimate({ contextBudget, instructions = '', toolSchemaBytes = 0, prompt = '', mandatoryPrompt = prompt, toolsKnown = true }) {
  const bytes = value => Buffer.byteLength(value || '');
  const components = { instructions: bytes(instructions), toolSchemas: toolSchemaBytes, preparedPrompt: bytes(prompt), mandatoryPrompt: bytes(mandatoryPrompt) };
  const outputHeadroomTokens = positive(contextBudget?.tokens) ? Math.min(4096, Math.max(512, Math.floor(contextBudget.tokens / 10))) : 4096;
  const estimate = { version: 1, method: 'ceil(UTF-8-bytes/3); approximate planning estimate, not tokenizer proof', components,
    estimatedInputTokens: Math.ceil((components.instructions + components.toolSchemas + components.preparedPrompt) / 3),
    estimatedMandatoryTokens: Math.ceil((components.instructions + components.toolSchemas + components.mandatoryPrompt) / 3),
    outputHeadroomTokens, toolsKnown, contextBudget, enforced: Boolean(contextBudget?.appliedToNativeCatalog && positive(contextBudget.tokens)) };
  estimate.exceedsBudget = estimate.enforced && estimate.estimatedInputTokens + outputHeadroomTokens > contextBudget.tokens;
  estimate.mandatoryExceedsBudget = estimate.enforced && estimate.estimatedMandatoryTokens + outputHeadroomTokens > contextBudget.tokens;
  return estimate;
}

export function assertNativeInputFits(estimate) {
  if (!estimate.exceedsBudget) return;
  throw Object.assign(new Error(`BZZY's approximate native input estimate (${estimate.estimatedInputTokens} input + ${estimate.outputHeadroomTokens} output headroom tokens) exceeds the configured ${estimate.contextBudget.tokens}-token planning window. Configure accurate model context metadata or reduce the objective/workflow/tool surface; mandatory source text was not truncated.`),
    { code: 'CONTEXT_BUDGET_EXCEEDED', contextEstimate: estimate });
}

export function nativeGoalTokenBudget(goal, observedDelegatedTokens = 0) {
  const delegatedTokens = Math.max(0, goal.delegatedTokensUsed || 0, observedDelegatedTokens || 0);
  const nativeOffset = Math.max(0, goal.nativeTokenOffset || 0);
  const nativeUsed = Math.max(nativeOffset, goal.nativeTokensUsed || goal.supervisorTokensUsed || 0);
  const remainingTokens = goal.tokenBudget == null ? null : Math.max(0, goal.tokenBudget - nativeUsed - delegatedTokens);
  // The backend limit is absolute within its existing native goal. Its current
  // counter still includes nativeUsed-offset; subtracting that counter twice
  // on same-thread resume would lose legitimately remaining owner budget.
  return { goalLimit: goal.tokenBudget ?? null, nativeOffset, nativeUsed, delegatedTokens, remainingTokens,
    nativeBudget: goal.tokenBudget == null ? undefined : Math.max(0, goal.tokenBudget - nativeOffset - delegatedTokens) };
}

export function nativeCompactionPressure(state, measuredAt = Date.now()) {
  const recent = state.metrics.recent, spanMs = recent.length > 1 ? Math.max(0, recent.at(-1).at - recent[0].at) : 0;
  const intervals = recent.filter(sample => sample.startedAt != null).map(sample => [sample.startedAt, sample.at]).sort((a, b) => a[0] - b[0]);
  let unionMs = 0, start, end;
  for (const interval of intervals) {
    if (end == null || interval[0] > end) { if (end != null) unionMs += Math.max(0, end - start); [start, end] = interval; }
    else end = Math.max(end, interval[1]);
  }
  if (end != null) unionMs += Math.max(0, end - start);
  const lifecycleSpanMs = intervals.length ? Math.max(0, Math.max(...intervals.map(interval => interval[1])) - intervals[0][0]) : 0;
  return { samples: recent.length, measuredAt, spanMs, compactionsPerMinute: spanMs ? (recent.length - 1) * 60000 / spanMs : null,
    timedSamples: intervals.length, lifecycleUnionMs: unionMs, lifecycleDutyRatio: lifecycleSpanMs > 0 ? unionMs / lifecycleSpanMs : null,
    pendingRefreshAgeMs: ['pending', 'dispatching', 'uncertain'].includes(state.refresh?.state) ? Math.max(0, measuredAt - Date.parse(state.refresh.requestedAt)) : 0 };
}

// Only a trusted execution option may authorize a pressure pause. Absent or
// malformed policy means observable metrics only, never automatic interruption.
export function observeContextPressure(session, policy) {
  const state = session.nativeContext, metrics = state?.metrics?.rolling;
  if (!metrics || !policy || policy.action !== 'pause' || !Number.isSafeInteger(policy.minimumSamples) || policy.minimumSamples < 3
    || !Number.isSafeInteger(policy.consecutiveBreaches) || policy.consecutiveBreaches < 2
    || !Number.isSafeInteger(policy.recoverySamples) || policy.recoverySamples < 2
    || !(Number.isFinite(policy.maximumCompactionsPerMinute) && policy.maximumCompactionsPerMinute > 0)
    || !(Number.isFinite(policy.maximumDutyRatio) && policy.maximumDutyRatio > 0 && policy.maximumDutyRatio <= 1)) return false;
  const pressure = state.pressure ||= { consecutive: 0, recovery: 0, latched: false };
  if (pressure.lastObservedEpoch === state.epoch) return false;
  pressure.lastObservedEpoch = state.epoch;
  const breached = metrics.samples >= policy.minimumSamples && metrics.compactionsPerMinute > policy.maximumCompactionsPerMinute
    && metrics.lifecycleDutyRatio != null && metrics.lifecycleDutyRatio > policy.maximumDutyRatio;
  const recovered = metrics.compactionsPerMinute != null && metrics.compactionsPerMinute < policy.maximumCompactionsPerMinute * 0.75
    && metrics.lifecycleDutyRatio != null && metrics.lifecycleDutyRatio < policy.maximumDutyRatio * 0.75;
  pressure.consecutive = breached ? pressure.consecutive + 1 : 0;
  pressure.recovery = recovered ? pressure.recovery + 1 : 0;
  if (pressure.recovery >= policy.recoverySamples) pressure.latched = false;
  pressure.policy = { action: 'pause', minimumSamples: policy.minimumSamples, consecutiveBreaches: policy.consecutiveBreaches,
    recoverySamples: policy.recoverySamples, maximumCompactionsPerMinute: policy.maximumCompactionsPerMinute, maximumDutyRatio: policy.maximumDutyRatio };
  const pause = !pressure.latched && pressure.consecutive >= policy.consecutiveBreaches;
  if (pause) { pressure.latched = true; pressure.requestedAt = stamp(); }
  saveSession(session);
  event(session, { method: 'context-pressure-policy', outcome: pause ? 'pause-requested' : 'observed', pressure, metrics });
  return pause;
}
