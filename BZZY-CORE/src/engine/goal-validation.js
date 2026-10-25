import fs from 'node:fs';
import { database, getRecord, putRecord, digest, appendEvent, now, transaction } from './database.js';
import { missionSourceRevision, missionResultRevision, missionEvidenceCurrent } from './mission-context.js';
import { inside } from './evidence.js';
import { identityAlive } from './process-identity.js';
import { home } from './files.js';

const KIND = 'core.goal.validation', REVIEW = 'core.goal.validation.review';
const atomic = operation => database().isTransaction ? operation(database()) : transaction(operation);
const readOnly = operation => database().isTransaction ? operation(database()) : transaction(operation, { readOnly: true });
const cache = new Map(), activeStates = ['queued', 'launching', 'starting', 'running', 'waiting_for_input'];
let readBudget;
const key = (sessionId, goalId) => `${sessionId}:${goalId}`;
const validGoalId = id => typeof id === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(id);
const rawSession = id => typeof id === 'string' && !getRecord('session-deletion', id) ? getRecord('session', id) : null;
const scope = session => digest([session.cwd || null, session.projectRoot || null, session.agentNamespace || null]);
const empty = goalId => ({ state: 'none', sourceGoalId: validGoalId(goalId) ? goalId : null, reviewSessionId: null, reason: 'not_requested', revision: 0, updatedAt: null });

function latestLink(sessionId, goalId) {
  return database().prepare(`SELECT e.seq,json_extract(e.data,'$.sessionId') AS reviewSessionId FROM events e
    LEFT JOIN records r ON r.kind='session' AND r.id=json_extract(e.data,'$.sessionId')
    WHERE e.session_id=? AND e.type='debate.linked' AND (json_extract(e.data,'$.sourceGoalId')=?
      OR json_extract(e.data,'$.sourceGoalId') IS NULL AND json_extract(r.data,'$.reviewSource.goalId')=?)
    ORDER BY e.seq DESC LIMIT 1`).get(sessionId, goalId, goalId) || null;
}
function finalEvent(review) {
  return database().prepare(`SELECT seq FROM events WHERE session_id=? AND type='debate.result'
    AND json_extract(data,'$.debateId')=? ORDER BY seq DESC LIMIT 1`).get(review.id, review.goal?.id) || null;
}
function manifest(ids) {
  if (!Array.isArray(ids) || ids.length > 4096 || ids.some(id => typeof id !== 'string')) return null;
  const entries = [...new Set(ids)].sort().map(id => getRecord('artifact', id));
  if (entries.some(item => !item)) return null;
  return entries.map(item => ({ id: item.id, sha256: item.sha256, sessionId: item.sessionId, goalId: item.goalId || null,
    path: item.path, source: item.source || null, sourceWorkspace: item.sourceWorkspace || null, sourceSha256: item.sourceSha256 || null, size: item.size }));
}
function currentEvidence(entries) {
  if (!entries || entries.length > 4096) return false;
  const bytes = entries.reduce((sum, item) => sum + (Number.isSafeInteger(item.size) && item.size >= 0 ? item.size : Infinity), 0);
  if (bytes > 256 * 1024 * 1024) return false;
  let signature, bytesToHash = 0;
  try {
    const files = entries.flatMap(item => [item.path, ...(item.source ? [inside(item.sourceWorkspace, item.source)] : [])]);
    signature = digest(files.map(file => {
      const stat = fs.lstatSync(file, { bigint: true });
      if (!stat.isFile() || stat.nlink !== 1n) throw new Error('Invalid validation evidence.');
      bytesToHash += Number(stat.size);
      return [file, String(stat.dev), String(stat.ino), String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs)];
    }));
  } catch { return false; }
  const fingerprint = digest([home(), entries]), previous = cache.get(fingerprint);
  if (previous?.signature === signature) return previous.valid;
  if (readBudget && bytesToHash > readBudget.remaining) return false;
  if (readBudget) readBudget.remaining -= bytesToHash;
  const valid = missionEvidenceCurrent(entries);
  if (cache.size >= 128) cache.delete(cache.keys().next().value);
  cache.set(fingerprint, { signature, valid }); return valid;
}
function sourceEvidence(review) {
  const mission = getRecord('core.mission.context', review.reviewSource?.missionContextId);
  if (mission?.sourceSessionId !== review.reviewSource?.sessionId || mission.sourceGoalId !== review.reviewSource?.goalId) return null;
  const expected = mission.brief?.evidence || [], entries = manifest(expected.map(item => item.id));
  return entries && expected.every(item => entries.some(entry => entry.id === item.id && entry.sha256 === item.sha256 && entry.sessionId === item.sessionId)) ? entries : null;
}
function currentMission(session, value) {
  const record = typeof value === 'string' ? getRecord('core.mission.context', value) : value;
  if (!record || record.sourceSessionId !== session.id || record.sourceGoalId !== session.goal?.id || record.sourceRevision !== missionSourceRevision(session)) return false;
  const saved = getRecord('core.mission.context', record.id);
  if (!saved || saved.sha256 !== record.sha256 || saved.sourceRevision !== record.sourceRevision || saved.sourceSessionId !== record.sourceSessionId ||
      saved.sourceGoalId !== record.sourceGoalId || saved.purpose !== record.purpose || digest(saved.brief) !== record.sha256 || digest(record.brief) !== record.sha256 ||
      record.id !== digest({ sourceSessionId: record.sourceSessionId, sourceGoalId: record.sourceGoalId,
        sourceRevision: record.sourceRevision, purpose: record.purpose, sha256: record.sha256 })) return false;
  const expected = record.brief?.evidence || [], entries = manifest(expected.map(item => item.id));
  return Boolean(entries && expected.every(item => entries.some(entry => entry.id === item.id && entry.sha256 === item.sha256 && entry.sessionId === item.sessionId)) && currentEvidence(entries));
}
function boundSource(source, review, binding) {
  const pin = review.reviewSource;
  if (!source?.goal || source.goal.status !== 'complete' || source.goal.importedHistorical || review.goal?.importedHistorical ||
      review.parentSessionId !== source.id || pin?.sessionId !== source.id || pin.goalId !== source.goal.id ||
      pin.claimedStatus !== 'complete' || pin.sourceRevision !== binding.sourceRevision || pin.resultRevision !== binding.resultRevision ||
      scope(source) !== binding.scopeHash || missionSourceRevision(source) !== binding.sourceRevision || missionResultRevision(source) !== binding.resultRevision) return false;
  const mission = getRecord('core.mission.context', pin.missionContextId);
  // The mission's immutable identity/content are checked separately from its
  // evidence bytes, whose bounded stat/hash cache avoids hashing each frame.
  if (!mission || mission.sourceSessionId !== source.id || mission.sourceGoalId !== source.goal.id || mission.sourceRevision !== binding.sourceRevision ||
      digest(mission.brief) !== mission.sha256 || mission.id !== digest({ sourceSessionId: mission.sourceSessionId, sourceGoalId: mission.sourceGoalId,
        sourceRevision: mission.sourceRevision, purpose: mission.purpose, sha256: mission.sha256 })) return false;
  const entries = sourceEvidence(review);
  return Boolean(entries && digest(entries) === binding.evidenceFingerprint && currentEvidence(entries));
}
function running(review) {
  const jobs = database().prepare(`SELECT data FROM records WHERE kind='execution' AND json_extract(data,'$.sessionId')=?
    AND json_extract(data,'$.state') IN ('queued','launching','starting','running','waiting_for_input')`).all(review.id).map(row => JSON.parse(row.data));
  if (jobs.some(job => job.state === 'queued' || identityAlive(job.runner) || identityAlive(job.launcher))) return true;
  const run = getRecord('run', review.id);
  return Boolean(run && activeStates.includes(run.state) && identityAlive(run.runner));
}
function resultFingerprint(result, review) {
  return digest({ reviewGoalId: review.goal?.id, assessment: result?.assessment, decision: result?.decision,
    goalSatisfaction: result?.goalSatisfaction, unresolvedDisagreement: result?.unresolvedDisagreement,
    objectionLedger: result?.objectionLedger, objectionReview: result?.objectionReview,
    missionContext: result?.missionContext, sourceEvidenceCoverage: result?.sourceEvidenceCoverage, acceptanceId: review.acceptance?.id });
}
function scopedDecisionEvidence(review, result, entries) {
  const defender = getRecord('session', result.assessment.defenderSessionId), job = getRecord('assignment', result.assessment.defenderAssignmentId);
  if (!defender || !job || defender.parentSessionId !== review.id || job.parentSessionId !== review.id || job.goalId !== review.goal.id ||
      job.workerSessionId !== defender.id || defender.assignmentId !== job.id || defender.assignmentRound !== job.currentRound ||
      getRecord('round', `${job.id}:${job.currentRound}`)?.state !== 'awaiting_review') return false;
  const assessment = result.decision?.goalAssessment;
  if (assessment?.objective !== (review.reviewSource?.objective || review.goal.objective) || !Array.isArray(assessment.evidence) || !Array.isArray(assessment.criteria)) return false;
  const cited = [...assessment.evidence, ...assessment.criteria.flatMap(item => Array.isArray(item.evidence) ? item.evidence : []),
    ...(Array.isArray(assessment.severity?.evidence) ? assessment.severity.evidence : [])];
  if (digest([...new Set(cited)].sort()) !== digest(entries.map(item => item.id).sort())) return false;
  const owned = database().prepare(`SELECT id FROM records WHERE kind='artifact' AND json_extract(data,'$.sessionId')=? LIMIT 4097`).all(defender.id);
  if (owned.length > 4096) return false;
  const allowed = new Set([...(defender.allowedArtifactIds || []), ...owned.map(item => item.id)]);
  const reads = database().prepare(`SELECT data FROM records WHERE kind='artifact-read' AND json_extract(data,'$.sessionId')=? LIMIT 8193`).all(defender.id).map(row => JSON.parse(row.data));
  if (reads.length > 8192) return false;
  return entries.every(entry => {
    const item = getRecord('artifact', entry.id), owner = rawSession(item.sessionId), original = item.importedFrom && getRecord('artifact', item.importedFrom);
    return allowed.has(item.id) && (item.sessionId === review.id || item.sessionId === defender.id || owner?.parentSessionId === review.id) &&
      (!original || item.importedSha256 === original.sha256 && item.sha256 === original.sha256 && currentEvidence(manifest([original.id]))) &&
      reads.some(read => read.sessionId === defender.id && (read.artifactId === item.id && read.sha256 === item.sha256 ||
        original && read.artifactId === original.id && read.sha256 === original.sha256) && read.bytesRead > 0 && read.nextOffset > (read.offset || 0));
  });
}
function classify(source, review, binding) {
  if (!review || !boundSource(source, review, binding)) return { state: 'stale', reason: 'source_or_evidence_changed' };
  if (review.goal?.id !== binding.reviewGoalId) return { state: 'stale', reason: 'review_goal_changed' };
  const status = review.goal.status;
  if (status === 'cancelled' || review.executionState === 'cancelled') return { state: 'cancelled', reason: 'review_cancelled' };
  if (status === 'paused' || review.executionState === 'paused') return { state: 'paused', reason: 'review_paused' };
  if (review.executionState === 'failed') return { state: 'inconclusive', reason: 'review_failed' };
  if (running(review)) return { state: 'pending', reason: 'review_running' };
  if (['active', 'verifying'].includes(status)) {
    if (review.executionState === 'idle' && Date.now() - Date.parse(binding.startedAt) < 5000) return { state: 'pending', reason: 'review_preparing' };
    return { state: 'inconclusive', reason: 'review_not_completed' };
  }
  const result = getRecord('debate', review.id);
  if (binding.finalResultFingerprint && binding.finalResultFingerprint !== resultFingerprint(result, review)) return { state: 'stale', reason: 'checked_result_changed' };
  if (!finalEvent(review)) return { state: 'inconclusive', reason: 'review_final_missing' };
  if (result?.goalSatisfaction === 'unsupported' || result?.decision?.goalSatisfaction === 'unsupported') return { state: 'not_validated', reason: 'original_goal_unsupported' };
  const receipt = review.acceptance?.id && getRecord('acceptance', review.acceptance.id);
  if (status !== 'complete' || result?.goalSatisfaction !== 'supported' || result?.assessment?.passed !== true ||
      !receipt || receipt.sessionId !== review.id || receipt.goalId !== review.goal.id || receipt.passed !== true || receipt.debate?.passed !== true ||
      receipt.debate.sourceGoalId !== source.goal.id || receipt.debate.goalSatisfaction !== 'supported' || receipt.debate.evidenceCoverage?.complete !== true ||
      review.acceptance.passed !== true || digest(review.acceptance) !== digest(receipt) ||
      !Array.isArray(result.unresolvedDisagreement) || result.unresolvedDisagreement.length ||
      !Array.isArray(result.decision?.remainingObjections) || result.decision.remainingObjections.length ||
      !Array.isArray(result.decision?.nextVerificationSteps) || result.decision.nextVerificationSteps.length ||
      result.decision?.goalSatisfaction !== 'supported') return { state: 'inconclusive', reason: status === 'budget_limited' ? 'review_budget_limited' : 'host_checks_incomplete' };
  const decisive = manifest(result.assessment.inspectedEvidence || []);
  const copies = manifest(review.reviewSource.evidenceIds || []);
  const receiptEvidence = manifest([...(review.goal.evidence || []), ...(receipt.checks || []).map(item => item.evidence),
    ...(receipt.artifacts || []).map(item => item.evidence), ...(receipt.requirements || []).flatMap(item => item.assessment?.evidence || [])].filter(Boolean));
  if (!decisive?.length || !copies || copies.some(item => item.sessionId !== review.id) || !scopedDecisionEvidence(review, result, decisive) || !currentEvidence(decisive) || !currentEvidence(copies) ||
      !currentEvidence(receiptEvidence) || !currentMission(review, result.missionContext)) return { state: 'stale', reason: 'review_evidence_changed' };
  return { state: 'validated', reason: 'host_checks_passed', verificationLevel: receipt.level || 'evidence-and-supervisor-assessment',
    provenance: 'core-reviewed-goal-and-contract-checks', semanticVerification: 'not-automated' };
}
function checkedOutcome(source, review, binding) {
  try { return classify(source, review, binding); }
  catch { return { state: 'inconclusive', reason: 'validation_receipt_invalid' }; }
}
function projection(binding, outcome = binding) {
  return { state: outcome.state, sourceSessionId: binding.sourceSessionId, sourceGoalId: binding.sourceGoalId, reviewSessionId: binding.reviewSessionId,
    reason: outcome.reason, revision: binding.revision, updatedAt: binding.updatedAt, sourceRevision: binding.sourceRevision,
    resultRevision: binding.resultRevision, evidenceFingerprint: binding.evidenceFingerprint,
    ...(outcome.verificationLevel ? { verificationLevel: outcome.verificationLevel, provenance: outcome.provenance, semanticVerification: outcome.semanticVerification } : {}) };
}

// This projection never rewrites the original achieved claim or starts work.
export function goalValidationFor(value) {
  const previousBudget = readBudget; readBudget = { remaining: 256 * 1024 * 1024 };
  try { return readOnly(() => readGoalValidation(value)); }
  finally { readBudget = previousBudget; }
}
function readGoalValidation(value) {
  const id = typeof value === 'string' ? value : value?.id, source = rawSession(id);
  if (!source?.goal || !validGoalId(source.goal.id) || value && typeof value === 'object' && value.goal?.id !== source.goal.id) return empty(value && typeof value === 'object' ? value.goal?.id : source?.goal?.id);
  const latest = latestLink(source.id, source.goal.id), saved = getRecord(KIND, key(source.id, source.goal.id));
  if (!latest) return empty(source.goal.id);
  const binding = getRecord(REVIEW, latest.reviewSessionId);
  if (!binding || !saved || saved.reviewSessionId !== latest.reviewSessionId || binding.linkSeq !== latest.seq) return {
    ...empty(source.goal.id), state: 'inconclusive', sourceSessionId: source.id, reviewSessionId: latest.reviewSessionId,
    reason: 'review_not_recorded', revision: (saved?.revision || 0) + 1, updatedAt: null };
  return projection(saved, checkedOutcome(source, rawSession(binding.reviewSessionId), { ...binding, finalResultFingerprint: saved.finalResultFingerprint }));
}

export function recordGoalValidationStarted(value) {
  return atomic(db => {
    const review = rawSession(typeof value === 'string' ? value : value?.id), source = rawSession(review?.reviewSource?.sessionId);
    if (!source?.goal || !validGoalId(source.goal.id) || !validGoalId(review.goal?.id) || review.reviewSource.goalId !== source.goal.id || source.goal.status !== 'complete' || source.goal.importedHistorical || review.goal?.importedHistorical) return empty(source?.goal?.id);
    const latest = latestLink(source.id, source.goal.id);
    if (!latest || latest.reviewSessionId !== review.id) return goalValidationFor(source);
    if (getRecord(REVIEW, review.id)) return goalValidationFor(source);
    const entries = sourceEvidence(review), previous = getRecord(KIND, key(source.id, source.goal.id));
    const binding = { sourceSessionId: source.id, sourceGoalId: source.goal.id, reviewSessionId: review.id, reviewGoalId: review.goal.id,
      sourceRevision: review.reviewSource.sourceRevision, resultRevision: review.reviewSource.resultRevision, scopeHash: scope(source),
      evidenceFingerprint: digest(entries || []), linkSeq: latest.seq, startedAt: now(), updatedAt: now(), revision: (previous?.revision || 0) + 1 };
    Object.assign(binding, boundSource(source, review, binding) ? { state: 'pending', reason: 'review_preparing' } : { state: 'stale', reason: 'source_or_evidence_changed' });
    putRecord(REVIEW, review.id, binding, db); putRecord(KIND, key(source.id, source.goal.id), binding, db);
    const shown = projection(binding); appendEvent(source.id, 'goal.validation', { sessionId: source.id, ...shown }, db); return shown;
  });
}

export function recordGoalValidationResult(value) {
  return atomic(db => {
    const review = rawSession(typeof value === 'string' ? value : value?.id);
    if (!validGoalId(review?.reviewSource?.goalId) || !validGoalId(review.goal?.id)) return empty(null);
    const source = rawSession(review.reviewSource.sessionId), binding = getRecord(REVIEW, review.id);
    if (!source?.goal || source.goal.id !== review.reviewSource.goalId || !binding) return empty(source?.goal?.id);
    const latest = latestLink(source.id, source.goal.id), previous = getRecord(KIND, key(source.id, source.goal.id));
    if (latest?.reviewSessionId !== review.id || latest.seq !== binding.linkSeq || previous?.reviewSessionId !== review.id) return goalValidationFor(source);
    const final = finalEvent(review), unchangedFinal = final?.seq === previous.finalEventSeq;
    const outcome = checkedOutcome(source, review, { ...binding, ...(unchangedFinal ? { finalResultFingerprint: previous.finalResultFingerprint } : {}) }), signature = digest(outcome);
    if (previous.finalSignature === signature) return projection(previous, outcome);
    const result = { ...binding, ...outcome, finalSignature: signature,
      finalEventSeq: final?.seq || null, finalResultFingerprint: unchangedFinal && previous.finalResultFingerprint || resultFingerprint(getRecord('debate', review.id), review),
      revision: previous.revision + 1, updatedAt: now() };
    putRecord(KIND, key(source.id, source.goal.id), result, db);
    const shown = projection(result); appendEvent(source.id, 'goal.validation', { sessionId: source.id, ...shown }, db); return shown;
  });
}
