import path from 'node:path';
import { database, getRecord, putRecord, digest, now, appendEvent } from './database.js';
import { home, readJson } from './files.js';
import { loadSession } from './store.js';
import { learningSettings } from './learning.js';
import { queueLearningEvaluation } from './learning-evaluation.js';
import { inspectSkillCandidate, evaluateSkillCandidate, evaluateSkillBehaviorCandidate, acceptSkillCandidate, activeSkillVersionPins } from './skills.js';
import { skillEvolutionSettings, currentEvolutionFixture } from './skill-evolution-policy.js';
import { assertHeldOutSources } from './learning-fixture-contract.js';

const kind = 'core.skill.update';
const terminal = new Set(['activated', 'review-needed']);
const cursors = new WeakMap();
const stopped = session => readJson(path.join(home(), 'runtime', 'operator-stop.json'), null)?.stopped ||
  !learningSettings().enabled || !session || ['paused', 'cancelled'].includes(session.executionState) ||
  database().prepare("SELECT 1 FROM records WHERE kind='execution' AND json_extract(data,'$.sessionId')=? AND json_extract(data,'$.state') IN ('queued','launching','running') AND json_extract(data,'$.stopAction') IN ('pause','cancel') LIMIT 1").get(session?.id || '');
const fail = reason => { throw Object.assign(new Error(reason), { code: 'SKILL_EVOLUTION_REVIEW' }); };
function save(receipt, automation) {
  const current = getRecord(kind, receipt.id);
  if (!current || current.candidateId !== receipt.candidateId || current.candidateVersion !== receipt.candidateVersion) fail('source-receipt-changed');
  const next = { ...current, automation: { ...automation, updatedAt: now() } };
  putRecord(kind, next.id, next);
  appendEvent(next.sessionId, 'learning.skill-update-automation', { updateId: next.id, candidateId: next.candidateId,
    state: automation.state, policyRevision: automation.policyRevision, reason: automation.reason || null });
  return { updateId: next.id, candidateId: next.candidateId, ...next.automation };
}
function selection(receipt, policy) {
  const session = loadSession(receipt.sessionId);
  if (stopped(session)) return null;
  if (session.parentSessionId || ['executor', 'reviewer', 'skill-writer', 'bestie', 'learning-review'].includes(session.role)) fail('restricted-source');
  const candidate = inspectSkillCandidate(receipt.candidateId, { session, readOnly: true });
  if (candidate.scope !== 'project' || candidate.projectId !== receipt.projectId || candidate.provenance?.kind !== 'learning-update' ||
      candidate.provenance.jobId !== receipt.jobId || candidate.provenance.sourceSessionId !== session.id || candidate.version !== receipt.candidateVersion ||
      candidate.update?.packetId !== receipt.packetId || !candidate.baseVersion || candidate.baseVersion !== receipt.baseVersion || candidate.baseRevision !== receipt.baseRevision) fail('source-candidate-mismatch');
  const sourceJob = getRecord('core.learning.job', receipt.jobId), packet = getRecord('core.learning.packet', receipt.packetId);
  if (!sourceJob || sourceJob.sessionId !== session.id || sourceJob.packetId !== receipt.packetId || !packet || packet.sessionId !== session.id) fail('source-packet-unavailable');
  if (sourceJob.state !== 'completed') return null;
  const semantic = currentEvolutionFixture(policy.updateEvaluation?.semantic), continuation = currentEvolutionFixture(policy.updateEvaluation?.continuation);
  if ((candidate.domain === 'general' ? 'procedure-review-v1' : 'security-decision-v1') !== (semantic.contract || 'security-decision-v1')) fail('semantic-contract-mismatch');
  for (const fixture of [semantic, continuation]) {
    if (fixture.projectId && (fixture.projectId !== candidate.projectId || (fixture.agentNamespace || null) !== (session.agentNamespace || null))) fail('fixture-scope-mismatch');
    if (assertHeldOutSources(candidate, fixture).status !== 'independent') fail('unknown-source-independence');
  }
  const base = getRecord('core.skill', candidate.skillId);
  if (candidate.state === 'accepted' && base?.version === candidate.version) return { session, candidate, base, packet, semantic, continuation };
  if (!['pending', 'evaluated'].includes(candidate.state) || !base?.enabled || base.archived || base.version !== candidate.baseVersion || base.revision !== candidate.baseRevision) fail('active-base-changed');
  return { session, candidate, base, packet, semantic, continuation };
}
function queue(receipt, state, phase, selected, policy) {
  const dataset = phase === 'semantic' ? selected.semantic : selected.continuation;
  const requestId = digest(['skill-update-evaluation', receipt.id, receipt.candidateVersion, policy.revision, phase]);
  // Inspect an already recorded request before queueing. A crash after queue
  // commit may have left the candidate at a newer bound revision; it is never
  // permission to repeat the model request using its new revision.
  const request = database().prepare('SELECT response FROM requests WHERE scope=? AND id=?').get(`learning:${receipt.projectId}`, requestId);
  let job;
  if (request) {
    if (!request.response) fail('uncertain-evaluation-request');
    const recorded = JSON.parse(request.response); job = getRecord('core.learning.job', recorded.id);
    if (!job || job.evaluation?.candidateId !== selected.candidate.id || job.evaluation.candidateVersion !== selected.candidate.version ||
        job.evaluation.datasetId !== dataset.id || job.evaluation.fixtureHash !== dataset.hash || job.evaluation.fixtureRevision !== dataset.revision) fail('evaluation-request-mismatch');
  } else {
    // A new policy revision is not permission to repeat an unresolved paid
    // request for this content. Inspect/resume the existing job explicitly;
    // even a cached output must finish through that original job.
    const unresolved = database().prepare(`SELECT id FROM records WHERE kind='core.learning.job'
      AND json_extract(data,'$.evaluation.candidateId')=? AND json_extract(data,'$.evaluation.candidateVersion')=?
      AND json_extract(data,'$.state')<>'completed'
      AND (json_extract(data,'$.reviewStarted')=1 OR json_extract(data,'$.dispatchedAt') IS NOT NULL
        OR json_extract(data,'$.reservationId') IS NOT NULL) LIMIT 1`).get(selected.candidate.id, selected.candidate.version);
    if (unresolved) fail('prior-evaluation-requires-review');
    job = queueLearningEvaluation(selected.candidate.id, { session: selected.session, datasetId: dataset.id,
      expectedRevision: selected.candidate.revision, requestId, evolutionPolicy: { revision: policy.revision, hash: digest(policy) } });
  }
  if (!job) fail('evaluation-source-unavailable');
  return save(receipt, { ...state, state: `${phase}-queued`, [`${phase}JobId`]: job.id, [`${phase}RequestId`]: requestId });
}
function completedEvaluation(jobId, phase, selected) {
  const job = getRecord('core.learning.job', jobId);
  if (!job) fail('evaluation-job-unavailable');
  if (['queued', 'running'].includes(job.state) || job.state === 'paused' && ['queue_limit', 'host_stopped', 'shutdown'].includes(job.reasonPaused) && !job.reviewStarted && !job.dispatchedAt) return null;
  if (job.state !== 'completed') fail('evaluation-requires-review');
  const evaluation = getRecord('core.learning.evaluation', job.result?.evaluationId || '');
  const fixture = phase === 'semantic' ? selected.semantic : selected.continuation;
  if (!evaluation || evaluation.authority !== 'host-fixture' || evaluation.status !== 'passed' || evaluation.candidateId !== selected.candidate.id ||
      evaluation.candidateVersion !== selected.candidate.version || evaluation.fixtureId !== fixture.id || evaluation.fixtureRevision !== fixture.revision ||
      evaluation.fixtureHash !== fixture.hash || evaluation.fixtureApprovalHash !== fixture.approvalHash) fail('evaluation-did-not-pass');
  const key = phase === 'semantic' ? 'evaluation' : 'behaviorEvaluation';
  if (selected.candidate[key]?.id !== evaluation.id) {
    const bind = phase === 'semantic' ? evaluateSkillCandidate : evaluateSkillBehaviorCandidate;
    bind(selected.candidate.id, { expectedRevision: selected.candidate.revision, evaluationId: evaluation.id }, { session: selected.session });
    selected.candidate = inspectSkillCandidate(selected.candidate.id, { session: selected.session });
  }
  if (selected.candidate[key].digest !== digest(evaluation)) fail('bound-evaluation-changed');
  return evaluation;
}

// Host runtime pump: one bounded discovery page, at most one queue or activation
// transition. Existing learning jobs own model dispatch, budgets and no-replay.
export function processSkillEvolution({ canRun = () => true } = {}) {
  const policy = skillEvolutionSettings();
  if (policy.updates !== 'auto' || !policy.reviewed || !policy.updateEvaluation || !learningSettings().enabled || !canRun() ||
      readJson(path.join(home(), 'runtime', 'operator-stop.json'), null)?.stopped) return [];
  const db = database(), cursor = cursors.get(db) ?? getRecord('core.skill.evolution.discovery', 'updates')?.afterId ?? '';
  const page = after => database().prepare("SELECT id,data FROM records WHERE kind=? AND json_extract(data,'$.state')='staged' AND id>? AND (coalesce(json_extract(data,'$.automation.policyRevision'),-1)<>? OR json_extract(data,'$.automation.state') NOT IN ('activated','review-needed')) ORDER BY id LIMIT 32").all(kind, after, policy.revision);
  const rows = page(cursor);
  if (rows.length < 32 && cursor) rows.push(...page('').filter(row => row.id <= cursor).slice(0, 32 - rows.length));
  for (const row of rows) {
    if (!canRun()) return [];
    // Rotate in memory while waiting. Persist only on an actual phase change,
    // so a 100 ms runtime tick cannot rewrite control records indefinitely.
    cursors.set(db, row.id);
    const done = result => {
      if (getRecord('core.skill.evolution.discovery', 'updates')?.afterId !== row.id)
        putRecord('core.skill.evolution.discovery', 'updates', { afterId: row.id });
      return [result];
    };
    const receipt = JSON.parse(row.data);
    let state = receipt.automation?.policyRevision === policy.revision ? receipt.automation : {
      version: 1, policyRevision: policy.revision, policyHash: digest(policy), candidateVersion: receipt.candidateVersion,
      sourceJobId: receipt.jobId, sourcePacketId: receipt.packetId, state: 'pending', startedAt: now() };
    if (terminal.has(state.state)) continue;
    try {
      const selected = selection(receipt, policy);
      if (!selected) continue;
      if (state.policyHash !== digest(skillEvolutionSettings()) || stopped(selected.session)) continue;
      if (state.sourcePacketHash && state.sourcePacketHash !== digest(selected.packet)) fail('source-packet-changed');
      state = { ...state, sourcePacketHash: digest(selected.packet) };
      if (selected.candidate.state === 'accepted') {
        if (state.state !== 'activation-ready' || selected.base.review?.candidateId !== selected.candidate.id ||
            selected.base.review?.automaticUpdate?.policyHash !== state.policyHash) fail('candidate-already-reviewed');
        return done(save(receipt, { ...state, state: 'activated', activeVersion: selected.base.version }));
      }
      if (state.state === 'pending') return done(queue(receipt, state, 'semantic', selected, policy));
      if (state.state === 'semantic-queued') {
        const evaluation = completedEvaluation(state.semanticJobId, 'semantic', selected);
        if (!evaluation) continue;
        return done(queue(receipt, { ...state, semanticEvaluationId: evaluation.id, semanticEvaluationHash: digest(evaluation) }, 'continuation', selected, policy));
      }
      if (state.state === 'continuation-queued') {
        const evaluation = completedEvaluation(state.continuationJobId, 'continuation', selected);
        if (!evaluation) continue;
        if (evaluation.metrics?.improvementDemonstrated !== true || evaluation.metrics?.sourceIndependence?.status !== 'independent' ||
            !evaluation.baseline || evaluation.baseline.version !== selected.candidate.baseVersion || evaluation.metrics.regressedCaseIds?.length !== 0) fail('behavioral-improvement-not-demonstrated');
        return done(save(receipt, { ...state, state: 'activation-ready', continuationEvaluationId: evaluation.id, continuationEvaluationHash: digest(evaluation) }));
      }
      if (state.state !== 'activation-ready') fail('unknown-automation-phase');
      if (activeSkillVersionPins(selected.candidate.skillId, selected.candidate.baseVersion).length) fail('active-version-pins');
      const accepted = acceptSkillCandidate(selected.candidate.id, { expectedRevision: selected.candidate.revision,
        expectedSkillRevision: selected.base.revision, expectedEvaluationId: state.semanticEvaluationId, reviewed: true },
      { session: selected.session, automaticUpdate: { updateId: receipt.id, policyRevision: policy.revision, policyHash: state.policyHash } });
      return done(save(receipt, { ...state, state: 'activated', activeVersion: accepted.version }));
    } catch (error) {
      // Fixed host reason codes avoid leaking provider, fixture or source text.
      const reason = error.code === 'SKILL_EVOLUTION_REVIEW' ? error.message : 'validation-requires-review';
      return done(save(receipt, { ...state, state: 'review-needed', reason }));
    }
  }
  return [];
}
