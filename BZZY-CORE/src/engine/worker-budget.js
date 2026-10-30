import fs from 'node:fs';
import path from 'node:path';
import { home, writeJson } from './files.js';
import { loadSession, lockFile } from './store.js';
import { database, getRecord, putRecord, transaction, appendEvent, digest, now } from './database.js';
import { currentAssignmentUsage, delegationUsage, assignmentFilter, assignmentParameters } from './delegation-usage.js';

const defaults = { version: 1, revision: 0, mode: 'adaptive', initialTokenBudget: 20000, initialRuntimeSeconds: 300,
  maxTokenBudget: null, maxRuntimeSeconds: null, reportReserveTokens: 2000, supervisorReserveTokens: 2000 };
const fields = Object.keys(defaults).filter(key => !['version', 'revision'].includes(key));
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const fail = (message = 'Agent execution settings are unavailable. Check private Core configuration.', code = 'WORKER_BUDGET_INVALID') => { throw Object.assign(new Error(message), { code }); };
function configuration() {
  let fd;
  try {
    fd = fs.openSync(path.join(home(), 'config.json'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    // Existing non-secret Core preferences may be owner-writable 0644 files.
    // Never accept another user's writes; credential readers retain their own
    // stricter private-file policy. Saving settings publishes a 0600 replacement.
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 2 * 1024 * 1024 || stat.mode & 0o022 || process.getuid && stat.uid !== process.getuid()) fail();
    const value = JSON.parse(fs.readFileSync(fd, 'utf8')); if (!plain(value)) fail(); return value;
  } catch (error) { if (error.code === 'ENOENT') return {}; fail(); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function validated(input, base = defaults) {
  if (!plain(input) || Object.keys(input).some(key => !fields.includes(key))) fail();
  const result = { ...base, ...input };
  if (!['adaptive', 'fixed'].includes(result.mode)) fail();
  for (const [key, maximum] of [['initialTokenBudget', 200000], ['initialRuntimeSeconds', 3600], ['reportReserveTokens', 20000], ['supervisorReserveTokens', 20000]]) {
    if (!Number.isSafeInteger(result[key]) || result[key] < 1 || result[key] > maximum) fail();
  }
  for (const [key, maximum] of [['maxTokenBudget', 20000000], ['maxRuntimeSeconds', 604800]]) {
    if (result[key] !== null && (!Number.isSafeInteger(result[key]) || result[key] < 1 || result[key] > maximum)) fail();
  }
  if (result.maxTokenBudget !== null && result.maxTokenBudget < result.initialTokenBudget
    || result.maxRuntimeSeconds !== null && result.maxRuntimeSeconds < result.initialRuntimeSeconds) fail('A hard maximum must cover the initial allocation.');
  return result;
}
export function getWorkerBudgetSettings() {
  const stored = configuration().workerBudgetSettings;
  if (stored === undefined) return { ...defaults };
  if (!plain(stored) || stored.version !== 1 || !Number.isSafeInteger(stored.revision) || stored.revision < 1
    || Object.keys(stored).some(key => !Object.keys(defaults).includes(key))) fail();
  return validated(Object.fromEntries(fields.map(key => [key, stored[key]])), { version: 1, revision: stored.revision });
}
export function setWorkerBudgetSettings(input, { expectedRevision } = {}) {
  let release;
  try {
    release = lockFile(path.join(home(), 'config.json.lock'));
    const prior = getWorkerBudgetSettings();
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== prior.revision) fail('Agent execution settings changed. Reopen them before saving.', 'WORKER_BUDGET_STALE');
    const next = { ...validated(input, prior), revision: prior.revision + 1 }, config = configuration();
    writeJson(path.join(home(), 'config.json'), { ...config, workerBudgetSettings: next }); return next;
  } catch (error) { if (error.code?.startsWith('WORKER_BUDGET_')) throw error; fail(); }
  finally { if (release) { try { release(); } catch { fail(); } } }
}
// Trusted local-owner action. Imported history, model tools and an active runner
// cannot use this operation to change an admitted contract or resume work.
export function applyWorkerBudgetSettingsToGoal(sessionId, { expectedGoalId, expectedRevision } = {}) {
  return transaction(db => {
    const policy = getWorkerBudgetSettings(), saved = loadSession(sessionId), run = getRecord('run', sessionId);
    if (policy.revision !== expectedRevision) fail('Agent execution settings changed. Reopen them before applying.', 'WORKER_BUDGET_STALE');
    if (!saved || saved.parentSessionId || saved.role || saved.agentId || saved.purpose && saved.purpose !== 'terminal'
      || saved.importedUntrusted || !saved.goal || saved.goal.id !== expectedGoalId || ['complete', 'cancelled'].includes(saved.goal.status)
      || !['idle', 'paused', 'failed'].includes(saved.executionState) || ['running', 'starting'].includes(run?.state)) {
      fail('Pause the current owner terminal goal before applying settings to its future workers.', 'WORKER_BUDGET_ACTIVE');
    }
    saved.goal.workerBudgetPolicy = policy; saved.updatedAt = now(); putRecord('session', saved.id, saved, db);
    appendEvent(saved.id, 'assignment.policy.changed', { goalId: saved.goal.id, policyRevision: policy.revision, futureWorkersOnly: true }, db);
    return { sessionId, goalId: saved.goal.id, policyRevision: policy.revision, applied: true };
  });
}
export function workerPolicyFor(parent, context = {}) {
  const policy = context.goalMode ? parent.goal?.workerBudgetPolicy : getRecord('run', parent.id)?.workerBudgetPolicy;
  if (!policy) return { ...defaults, mode: 'fixed' }; // Existing goals retain their original policy.
  if (policy.version !== 1 || !Number.isSafeInteger(policy.revision) || policy.revision < 0) fail();
  return validated(Object.fromEntries(fields.map(key => [key, policy[key]])), { version: 1, revision: policy.revision });
}
const minimum = values => values.filter(value => value != null).reduce((left, right) => left == null ? right : Math.min(left, right), null);
export function initialWorkerBudget(parent, context, definition, requested = {}) {
  requested ||= {};
  const policy = workerPolicyFor(parent, context);
  const hardTokenLimit = minimum([definition.limits?.tokenBudget, requested.tokenBudget, policy.maxTokenBudget]);
  const hardRuntimeLimitSeconds = minimum([definition.limits?.runtimeSeconds, requested.runtimeSeconds, policy.maxRuntimeSeconds, parent.contract?.limits?.assignmentSeconds]);
  const tokenBudget = Math.min(requested.tokenBudget || definition.limits?.tokenBudget || policy.initialTokenBudget, hardTokenLimit ?? Infinity);
  const runtimeSeconds = Math.min(requested.runtimeSeconds || definition.limits?.runtimeSeconds || policy.initialRuntimeSeconds, hardRuntimeLimitSeconds ?? Infinity);
  return { limits: { tokenBudget, runtimeSeconds }, workerBudget: { version: 1, revision: 1, mode: policy.mode, policyRevision: policy.revision,
    initialTokenBudget: tokenBudget, tokenStep: policy.initialTokenBudget, runtimeStepSeconds: policy.initialRuntimeSeconds,
    hardTokenLimit: policy.mode === 'fixed' ? tokenBudget : hardTokenLimit,
    hardRuntimeLimitSeconds: policy.mode === 'fixed' ? runtimeSeconds : hardRuntimeLimitSeconds,
    requestedReportReserveTokens: policy.reportReserveTokens, reportReserveTokens: Math.min(policy.reportReserveTokens, Math.max(1, Math.floor(tokenBudget / 5))),
    supervisorReserveTokens: policy.supervisorReserveTokens, lastProgressEvidence: [], extensionCount: 0 } };
}
export function supervisorHeadroom(parent, workerBudget, limit) {
  return workerBudget?.mode === 'adaptive' && limit != null ? Math.min(workerBudget.supervisorReserveTokens || 2000, Math.max(1, Math.floor(limit / 10))) : 0;
}
export function assignmentBudgetView(job) {
  if (!job) return null;
  const usage = currentAssignmentUsage(job), worker = job.workerSessionId && loadSession(job.workerSessionId), run = worker && getRecord('run', worker.id);
  const liveSeconds = run?.state === 'running' && Number.isFinite(Date.parse(run.startedAt)) ? Math.max(0, (Date.now() - Date.parse(run.startedAt)) / 1000) : 0;
  const count = value => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : null;
  const elapsedSeconds = (count(usage.elapsedSeconds) || 0) + liveSeconds;
  const tokenLimit = count(job.contract?.limits?.tokenBudget), runtimeLimitSeconds = count(job.contract?.limits?.runtimeSeconds);
  const mode = job.workerBudget?.mode === 'adaptive' ? 'adaptive' : 'fixed', reserve = count(job.workerBudget?.reportReserveTokens) ?? Math.min(2000, Math.floor((tokenLimit || 20000) / 5));
  const nextInput = count(worker?.usage?.lastRequestInputTokens);
  const handoffReserve = Math.min(Number.MAX_SAFE_INTEGER, Math.max(reserve, nextInput == null ? reserve : Math.ceil(nextInput * 1.1) + reserve));
  const softReached = tokenLimit != null && (count(usage.tokens) || 0) >= Math.max(0, tokenLimit - handoffReserve)
    || runtimeLimitSeconds != null && elapsedSeconds >= Math.max(0, runtimeLimitSeconds - Math.min(30, runtimeLimitSeconds / 5));
  return { revision: count(job.workerBudget?.revision) || 0, mode, tokensUsed: count(usage.tokens), tokensCharged: count(usage.chargedTokens ?? usage.tokens),
    tokenLimit, nextRequestInputEstimate: nextInput, reportReserveTokens: reserve, handoffReserveTokens: handoffReserve,
    requestAdmission: 'Backend-internal requests cannot be gated; input-based headroom is an estimate and warnings may arrive after dispatch.',
    initialTokenBudget: count(job.workerBudget?.initialTokenBudget) ?? tokenLimit, elapsedSeconds, runtimeLimitSeconds,
    hardTokenLimit: job.workerBudget ? count(job.workerBudget.hardTokenLimit) : tokenLimit, hardRuntimeLimitSeconds: job.workerBudget ? count(job.workerBudget.hardRuntimeLimitSeconds) : runtimeLimitSeconds,
    complete: Boolean(usage.available) && usage.accountingComplete !== false && count(usage.tokens) !== null, softReached,
    canRequestExtension: mode === 'adaptive' && job.closure === 'open' && !job.importProvenance
      && (job.workerBudget.hardTokenLimit == null || tokenLimit < job.workerBudget.hardTokenLimit
        || job.workerBudget.hardRuntimeLimitSeconds == null || runtimeLimitSeconds < job.workerBudget.hardRuntimeLimitSeconds) };
}
// Allocation and lifecycle changes invalidate structural navigation, while
// heartbeat/usage polling remains a separate live view.
export function workerAllocationRevision(session) {
  const scoped = session.goal && !session.goal.createdAt ? { ...session, goal: { ...session.goal, createdAt: '9999-12-31T23:59:59.999Z' } } : session;
  return digest(database().prepare(`SELECT a.id,json_extract(a.data,'$.currentRound') AS round,
    json_extract(a.data,'$.closure') AS closure,json_extract(a.data,'$.workerBudget.revision') AS revision,
    json_extract(a.data,'$.contract.limits.tokenBudget') AS tokens,json_extract(a.data,'$.contract.limits.runtimeSeconds') AS seconds,
    json_extract(r.data,'$.state') AS state FROM records a LEFT JOIN records r ON r.kind='round'
    AND r.id=a.id || ':' || json_extract(a.data,'$.currentRound') WHERE a.kind='assignment' AND ${assignmentFilter(scoped, 'a.data')}
    ORDER BY a.id`).all(...assignmentParameters(scoped)));
}
export function currentBudgetCapsule(session, context = {}) {
  const saved = loadSession(session.id);
  if (!saved || saved.cwd !== session.cwd) fail('This budget view is unavailable.', 'WORKER_BUDGET_SCOPE');
  if (saved.assignmentId) {
    const job = getRecord('assignment', saved.assignmentId);
    if (job?.workerSessionId !== saved.id || job.currentRound !== saved.assignmentRound) fail('The worker assignment changed.', 'WORKER_BUDGET_STALE');
    return { assignmentId: job.id, round: job.currentRound, budget: assignmentBudgetView(job),
      next: 'Before the allocation ends, save evidence and call finish_assignment with a concise partial report. The parent alone can extend an adaptive allocation.' };
  }
  let scoped = context.goalMode === false ? { ...saved, goal: null } : saved;
  if (scoped.goal && !scoped.goal.createdAt) scoped = { ...scoped, goal: { ...scoped.goal, createdAt: '9999-12-31T23:59:59.999Z' } };
  const usage = delegationUsage(scoped);
  const goalLimit = context.goalMode === false ? context.tokenBudget ?? null : saved.goal?.tokenBudget ?? null;
  return { goalId: context.goalMode === false ? null : saved.goal?.id || null, tokenLimit: goalLimit,
    tokensUsed: usage.totalTokens, tokensCharged: usage.chargedTotalTokens ?? usage.totalTokens, complete: usage.complete,
    remainingTokens: goalLimit == null || usage.unboundedUnknown ? null : Math.max(0, goalLimit - (usage.chargedTotalTokens ?? usage.totalTokens)),
    unknownUsage: Boolean(usage.unboundedUnknown),
    allocationRevision: workerAllocationRevision(scoped), observedAt: new Date().toISOString(), source: 'live-core-accounting',
    revision: digest([saved.goal?.id || null, goalLimit, usage.totalTokens, usage.chargedTotalTokens, usage.complete]) };
}
