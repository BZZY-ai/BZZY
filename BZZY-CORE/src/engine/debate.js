import fs from 'node:fs';
import path from 'node:path';
import { Coordinator as DefaultCoordinator } from './coordination.js';
import { startAssignment as defaultStartAssignment, followupAssignment as defaultFollowupAssignment, waitAssignment as defaultWaitAssignment, assignmentStatus as defaultAssignmentStatus } from './delegation.js';
import { snapshotWorkspace, inside, artifact, readArtifact } from './evidence.js';
import { getRecord, putRecord, appendEvent, now, digest } from './database.js';
import { investigate as defaultInvestigate, investigationConsensus, investigationReadiness } from './investigation.js';
import { accumulateDebateObjections, assessObjectionDispositions, assessDebateGoal, assessDebateEvidenceCoverage, formatInvestigation, formatPosition, formatDecision } from './debate-format.js';
import { configuredDebate, applyDebateSelection } from './debate-setup.js';
import { saveSession } from './store.js';
import { createMissionContext, missionContextCurrent, missionEvidenceCurrent } from './mission-context.js';
import { chatReviewSourceCurrent } from './chat-debate.js';
import { debateEventUI, debateIdentity, debateParticipants } from './debate-events.js';
import { sessionMemoryEligible } from './session-memory.js';
import { queueSessionCompaction } from './session-compactor.js';
import { synthesizeDebateConsensus, consensusTokenBudget } from './debate-consensus.js';
import { runAdaptiveValidationReview } from './adaptive-validation.js';
import { recordAdaptiveValidationPolicy } from './verification.js';

export async function runDebate(session, options, ui, dependencies = {}) {
  // Runtime/model options are never executable adapter overrides.
  const { Coordinator = DefaultCoordinator, startAssignment = defaultStartAssignment, followupAssignment = defaultFollowupAssignment,
    waitAssignment = defaultWaitAssignment, assignmentStatus = defaultAssignmentStatus, investigate = defaultInvestigate,
    synthesizeConsensus = synthesizeDebateConsensus } = dependencies;
  const selectedAgents = configuredDebate({ ...options, provider: session.provider, model: session.model, debateAgents: options.debateAgents || session.debateAgents });
  ui = debateEventUI(session, ui, selectedAgents);
  const coordinator = new Coordinator(session, ui, options); coordinator.start();
  const transcript = [], agents = []; let investigationUsage = [], usage = { totalTokens: 0, complete: true, agents }, stopReason = 'round_limit', decision = null, objectionLedger = [];
  try {
    const rounds = options.rounds || 5;
    if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 5) throw new Error('Validation rounds must be 1–5.');
    ui.event('debate.started', { title: session.reviewSource ? 'Review achieved goal' : 'Evidence review', participants: debateParticipants(session, selectedAgents), maxRounds: rounds });
    const selected = options.artifact ? getRecord('artifact', options.artifact) : null;
    if (selected && ![session.id, session.parentSessionId].includes(selected.sessionId) && !session.allowedArtifactIds?.includes(selected.id)) throw new Error('Selected validation evidence is outside this conversation scope.');
    if (selected) readArtifact(selected.id, 0, 1); // Validate the immutable source before copying it.
    const content = selected ? fs.readFileSync(selected.path) : options.artifact ? fs.readFileSync(inside(session.cwd, options.artifact)) : Buffer.from(`GOAL\n${session.goal.objective}\n\nIndependently investigate this goal in the supplied workspace before debating its support.`);
    if (content.length > 512 * 1024) throw new Error('Selected validation material exceeds 512 KiB. Select a smaller artifact.');
    if (selected && selected.sessionId === session.parentSessionId) { session.allowedArtifactIds = [...new Set([...(session.allowedArtifactIds || []), selected.id])]; saveSession(session); }
    const material = artifact(session, content, 'debate-selected-material', selected?.mediaType || 'text/plain');
    if (selected) { Object.assign(material, { importedFrom: selected.id, importedSha256: selected.sha256,
      ...(selected.source ? { source: selected.source, sourceWorkspace: selected.sourceWorkspace, sourceSha256: selected.sourceSha256 } : {}) }); putRecord('artifact', material.id, material); }
    const snapshot = snapshotWorkspace(session, 'debate-fixed-snapshot', { ui });
    const materialPath = path.join(snapshot.directory, 'BZZY_SELECTED_MATERIAL.txt');
    if (fs.existsSync(materialPath)) throw new Error('Reserved validation snapshot path already exists.');
    fs.writeFileSync(materialPath, content, { mode: 0o600 });
    snapshot.manifest['BZZY_SELECTED_MATERIAL.txt'] = { size: content.length, sha256: digest(content) };
    snapshot.manifestHash = digest(snapshot.manifest); putRecord('snapshot', snapshot.id, snapshot);
    applyDebateSelection(session, selectedAgents); saveSession(session);
    const [supervisor, ...choices] = selectedAgents;
    const reviewPolicy = { ...session.policy, mode: 'read-only', writablePaths: [] };
    session.contract.limits.concurrency = Math.min(options.concurrency || session.contract.limits.concurrency || selectedAgents.length, 8);
    const missionContext = createMissionContext(session, { purpose: 'debate', independent: true, evidenceIds: [material.id, ...(selected ? [selected.id] : [])] });
    if (!options.reviewOnly) investigationUsage = await investigate(session, selectedAgents, snapshot, options, ui, coordinator);
    const investigation = options.reviewOnly ? null : getRecord('debate-investigation', session.id);
    const sourceEvidenceIds = session.reviewSource?.evidenceIds || [];
    const commonEvidence = [...new Set([material.id, ...(selected ? [selected.id] : []), ...sourceEvidenceIds,
      ...(investigation?.reports.flatMap(report => report.artifacts.filter(item => item.id && !item.omitted).map(item => item.id)) || [])])];
    const updateUsage = () => { usage.agents = [...investigationUsage, ...agents.filter(Boolean)]; usage.totalTokens = usage.agents.reduce((sum, a) => sum + (a.tokens || 0), 0); usage.complete = usage.agents.every(a => a.available); coordinator.checkBudget(usage.totalTokens); };
    updateUsage();
    const consensus = options.reviewOnly ? null : investigationConsensus(investigation, selectedAgents.length);
    if (!options.reviewOnly && investigation?.protocol === 'tri-state-v1') {
      const result = await runAdaptiveValidationReview({ session, options, ui, coordinator, selectedAgents, snapshot, material, missionContext,
        investigation, sourceEvidenceIds, commonEvidence, usage, startAssignment, followupAssignment, waitAssignment, assignmentStatus });
      decision = result.decision; objectionLedger = result.objectionLedger;
      if (result.validationPolicy) recordAdaptiveValidationPolicy(session, result);
      return await finishValidation(session, options, ui, coordinator, result, usage, missionContext, synthesizeConsensus);
    }
    session.contract.limits.maxRetries = Math.max(session.contract.limits.maxRetries || 0, rounds);
    const persistLedger = () => putRecord('debate-objections', session.id, { version: 1, goalId: session.goal.id, snapshotHash: snapshot.manifestHash, entries: objectionLedger, updatedAt: now() });
    if (!options.reviewOnly) {
      objectionLedger = accumulateDebateObjections(objectionLedger, investigation?.reports || [], { phase: 'investigation', consensus }); persistLedger();
      if (consensus.reached) ui.event('debate.phase', { phase: 'investigation', status: 'agreement', consensus });
      const readiness = investigationReadiness(investigation, selectedAgents.length, { sessionId: session.id });
      if (!readiness.passed) {
        stopReason = 'insufficient_investigation_evidence';
        const remaining = [`Only ${readiness.usable}/${readiness.total} independent reports contained a usable conclusion with recorded evidence; ${readiness.required} are required.`, ...readiness.reasons];
        const result = { version: 1, debateId: debateIdentity(session), material: { id: material.id, sha256: material.sha256 }, snapshotId: snapshot.id, opening: null, transcript, decision: null,
          stopReason, unresolvedDisagreement: remaining, investigation, investigationReadiness: readiness, missionContext, objectionLedger,
          goalSatisfaction: 'inconclusive', assessment: { passed: false, challengeRounds: 0 }, independentInvestigationPerformed: true,
          newVerificationPerformed: null, newVerificationDuringRounds: false, verificationReporting: 'The evidence phase did not support an adversarial discussion.', maxRounds: rounds, usage, outcome: 'unresolved' };
        putRecord('debate', session.id, result);
        const code = await coordinator.finish('awaiting_review', result, usage);
        ui.event('debate.phase', { phase: 'finished', status: 'inconclusive' });
        ui.event('debate.result', { sessionId: session.id, status: session.goal.status, decision: null, consensus, goalSatisfaction: 'inconclusive', unresolvedDisagreement: remaining, evidence: session.goal.evidence,
          message: `Validation finished · insufficient evidence\n${remaining.map(item => `• ${item}`).join('\n')}` });
        return code;
      }
    }
    ui.event('debate.phase', { phase: 'opening', status: 'started' });
    const openingContext = `You are the main agent responding with the opening case in an evidence-based debate about BZZY_SELECTED_MATERIAL.txt.
${options.reviewOnly ? 'Assess the fixed material now; no new experiments are allowed in this review-only debate.' : 'All selected agents completed independent assessments. Inspect BZZY_INVESTIGATION_REPORTS.json and the shared evidence only now, after independence was preserved.'}
Synthesize the strongest supported case, acknowledge contrary evidence and uncertainty, and identify the claims that still need verification. Agreement is not evidence.
Compare the original user goal and every critical acceptance condition in the selected material, including severity or impact when claimed. A real vulnerability alone does not prove a requested HIGH severity or satisfy the original objective. Preserve unsupported and inconclusive conclusions separately.
Read ALL original source-goal evidence IDs with read_artifact, paginating until every byte has been inspected. A manifest or first page is not a review of the evidence. If budgets prevent full review, state which files/ranges remain and return inconclusive.
Do not change implementation or perform new tests here. Return finish_assignment including a decision object with arrays acceptedConclusions, rejectedClaims, corrections, remainingObjections, nextVerificationSteps and objectionDispositions. The opening objectionDispositions array is empty.
PERSISTENT OBJECTION LEDGER (IDs are assigned by Core; preserve every contrary point):\n${JSON.stringify(objectionLedger)}`;
    let defenderJob = startAssignment(session, { requestId: `debate-main-${session.id}`, objective: session.goal.objective, context: openingContext,
      acceptanceCriteria: ['Open with an evidence-grounded case that preserves contrary findings, uncertainty and missing verification.'], policy: reviewPolicy,
      limits: { runtimeSeconds: options.runtimeSeconds || 300 } }, { executor: supervisor, snapshot, role: 'reviewer', allowDebate: true, sharedEvidence: commonEvidence }).id;
    while (!coordinator.stopping) { if ((await waitAssignment(session.id, defenderJob, 1)).terminal) break; }
    let defender = assignmentStatus(defenderJob), currentCase = defender.round.state === 'awaiting_review' && defender.latestReport?.round === defender.currentRound ? defender.latestReport.report : null;
    let defenderError = defender.round.error || defender.latestReport?.error || defender.latestReport?.stopReason || null;
    agents[choices.length] = { ...supervisor, role: 'main', tokens: defender.latestReport?.usage?.tokens ?? null, available: Boolean(defender.latestReport?.usage?.available) };
    updateUsage();
    ui.event('debate.message', { participant: supervisor.provider, participantIndex: 0, role: 'main opening', round: 0, maxRounds: rounds, assignmentId: defenderJob, state: defender.round.state,
      error: defenderError, text: currentCase ? formatPosition(currentCase) : formatInvestigation({ state: defender.round.state, error: defenderError }) });
    const opening = { mainResponse: currentCase, assignmentId: defenderJob, snapshotHash: snapshot.manifestHash, createdAt: now() };
    objectionLedger = accumulateDebateObjections(objectionLedger, [{ participant: supervisor, assignmentId: defenderJob, report: currentCase }], { phase: 'opening' }); persistLedger();
    putRecord('debate-opening', session.id, opening); appendEvent(session.id, 'debate.opening', opening);
    decision = currentCase?.decision || null;

    const jobs = [], previousPositions = new Map(); let finalObjectionReview = { complete: false, unresolved: [] }, goalReview = { passed: false, goalSatisfaction: 'inconclusive', reasons: ['No challenge response assessed the original goal.'] }, sourceEvidenceCoverage = { complete: !sourceEvidenceIds.length, reviewed: [], missing: sourceEvidenceIds, partial: [] };
    for (let round = 1; round <= rounds && !coordinator.stopping; round++) {
      ui.event('debate.phase', { phase: 'challenge', status: 'started', round, maxRounds: rounds, snapshotHash: snapshot.manifestHash });
      const reports = [];
      for (let index = 0; index < choices.length && !coordinator.stopping; index++) {
        const selection = choices[index];
        const context = `Challenge the main agent's current case against the fixed selected material in BZZY_SELECTED_MATERIAL.txt. ${options.reviewOnly ? 'This is a read-only assessment.' : 'Independent assessments are complete; inspect BZZY_INVESTIGATION_REPORTS.json and the shared evidence bundle. Treat every agent finding as a claim and compare the actual evidence and test limitations.'}
Identify which claims survive, specific objections, source/evidence references, assumptions and missing verification. Address revisions from earlier rounds instead of repeating answered points. Do not implement changes, contact targets or run new experiments; describe needed verification separately.
Validate the original goal and acceptance conditions, not just whether the latest reply sounds plausible. Challenge any unsupported vulnerability classification, impact or severity; a majority vote is never proof of a HIGH-severity goal.
Use record_evidence for relevant files. Return finish_assignment with status, summary, evidence, objections (stable IDs), conclusions, position and changedBecause.
CURRENT MAIN CASE:\n${JSON.stringify(currentCase)}\nPERSISTENT OBJECTION LEDGER:\n${JSON.stringify(objectionLedger)}`;
        if (round === 1) {
          const job = startAssignment(session, { requestId: `debate-${session.id}-${index}`, objective: session.goal.objective, context, acceptanceCriteria: ['Ground objections and conclusions in the fixed material; preserve uncertainty and missing verification.'], policy: reviewPolicy, limits: { runtimeSeconds: options.runtimeSeconds || 300 } }, { executor: selection, snapshot, role: 'reviewer', allowDebate: true, sharedEvidence: commonEvidence });
          jobs[index] = job.id;
        } else followupAssignment(session, jobs[index], { requestId: `debate-${session.id}-${index}-${round}`, objective: session.goal.objective, feedback: context });
        // One participant at a time keeps memory and resource consumption bounded. Their first prompts remain independent.
        while (!coordinator.stopping) { const result = await waitAssignment(session.id, jobs[index], 1); if (result.terminal) break; }
        const job = assignmentStatus(jobs[index]), report = job.round.state === 'awaiting_review' && job.latestReport?.round === job.currentRound ? job.latestReport : null;
        reports.push({ participant: selection, assignmentId: job.id, round, report: report?.report || null, state: job.round.state,
          error: job.round.error || report?.error || report?.stopReason || null, artifacts: report?.artifacts || [], missingReport: !report?.report });
        agents[index] = { ...selection, tokens: report?.usage?.tokens ?? null, available: Boolean(report?.usage?.available) };
        updateUsage();
        const assessment = reports.at(-1);
        ui.event('debate.message', { participant: selection.provider, participantIndex: index + 1, role: 'reviewer', round, maxRounds: rounds, assignmentId: job.id,
          state: assessment.state, error: assessment.error, text: assessment.report ? formatPosition(assessment.report) : formatInvestigation(assessment) });
      }
      if (coordinator.stopping) break;
      ui.event('debate.phase', { phase: 'response', status: 'started', round, maxRounds: rounds });
      objectionLedger = accumulateDebateObjections(objectionLedger, reports, { phase: 'challenge', round }); persistLedger();
      const context = `You are the main agent responding to a challenge round by revising the current case about BZZY_SELECTED_MATERIAL.txt.
Defend supported claims, concede valid objections, or revise conclusions. Address every specific objection ID and state what changed from the prior case. Agreement is not evidence.
Compare the original goal and critical acceptance criteria, including severity/impact claims. Distinguish review finished from goal proven. Missing account controls, uncertain impact, unresolved dissent or unsupported severity require an inconclusive result and explicit next verification.
Open every evidence artifact you rely on with read_artifact, including your own recorded evidence, and cite its returned ID. Core checks scoped immutable evidence and actual read receipts. Do not change implementation or perform new tests here; list required verification separately.
Before supporting the original goal, read every source-goal evidence ID in the original evidence manifest completely, paging with offset and limit. Include every contradiction or missing control in the persistent objections. Core checks full coverage of all source evidence; partial pages or a summary do not count as reviewing the full evidence.
Return finish_assignment including a decision object with arrays acceptedConclusions, rejectedClaims, corrections, remainingObjections, nextVerificationSteps and objectionDispositions. Give EVERY persistent ledger ID exactly one objectionDispositions entry with status accepted, resolved, rejected or unresolved plus a concise rationale and evidence IDs. Missing, malformed or unsupported resolutions remain unverified. Preserve uncertainty and unresolved disagreement.
Also return decision.goalSatisfaction supported, unsupported or inconclusive and goalAssessment:{objective:<exact original goal>,rationale,evidence:[IDs],criteria:[{id:<acceptance criterion ID>,status:supported|unsupported|inconclusive,rationale,evidence:[IDs]}]}. Address every original acceptance criterion. When the original goal requests a severity, include goalAssessment.severity:{requested,assessed,rationale,evidence:[IDs]} with the actual impact judgment; a real lower-severity issue does not satisfy HIGH. These remain model assessments; Core independently checks evidence scope, integrity, inspection and declared contract tests.
PRIOR MAIN CASE:\n${JSON.stringify(currentCase)}\nCHALLENGER REPORTS:\n${JSON.stringify(reports)}\nPERSISTENT OBJECTION LEDGER:\n${JSON.stringify(objectionLedger)}`;
      const sharedEvidence = [...commonEvidence, ...reports.flatMap(r => r.artifacts.map(a => a.id))];
      followupAssignment(session, defenderJob, { requestId: `debate-main-${session.id}-${round}`, objective: session.goal.objective, feedback: context }, { sharedEvidence });
      while (!coordinator.stopping) { if ((await waitAssignment(session.id, defenderJob, 1)).terminal) break; }
      defender = assignmentStatus(defenderJob); const response = defender.round.state === 'awaiting_review' && defender.latestReport?.round === defender.currentRound ? defender.latestReport.report : null;
      defenderError = defender.round.error || defender.latestReport?.error || defender.latestReport?.stopReason || null;
      agents[choices.length] = { ...supervisor, role: 'main', tokens: defender.latestReport?.usage?.tokens ?? null, available: Boolean(defender.latestReport?.usage?.available) };
      updateUsage();
      ui.event('debate.message', { participant: supervisor.provider, participantIndex: 0, role: 'main agent', round, maxRounds: rounds, assignmentId: defenderJob,
        state: defender.round.state, error: defenderError, text: response ? formatPosition(response) : formatInvestigation({ state: defender.round.state, error: defenderError }) });
      const current = { round, caseBefore: currentCase, assessments: reports, mainResponse: response, snapshotHash: snapshot.manifestHash, createdAt: now() };
      transcript.push(current);
      decision = response?.decision || null;
      objectionLedger = accumulateDebateObjections(objectionLedger, [{ participant: supervisor, assignmentId: defenderJob, report: response }], { phase: 'response', round }); persistLedger();
      const allowedArtifactIds = [material.id, ...commonEvidence, ...reports.flatMap(report => report.artifacts.map(item => item.id)), ...(defender.latestReport?.artifacts || []).map(item => item.id)];
      const evidenceContext = { sessionId: session.id, defenderSessionId: defender.workerSessionId, allowedArtifactIds };
      finalObjectionReview = assessObjectionDispositions(objectionLedger, decision, evidenceContext);
      goalReview = assessDebateGoal(session, decision, evidenceContext);
      if (response?.status !== 'complete' && goalReview.passed) {
        goalReview.passed = false; goalReview.goalSatisfaction = 'inconclusive';
        goalReview.reasons.push('The main agent returned a partial or inconclusive assessment.');
      }
      sourceEvidenceCoverage = assessDebateEvidenceCoverage(sourceEvidenceIds, evidenceContext);
      if (!sourceEvidenceCoverage.complete) {
        goalReview.passed = false; if (goalReview.goalSatisfaction === 'supported') goalReview.goalSatisfaction = 'inconclusive';
        goalReview.reasons.push('The main agent has not inspected all original goal evidence completely.');
      }
      current.objectionReview = finalObjectionReview; current.objectionLedger = structuredClone(objectionLedger);
      current.goalReview = goalReview; current.sourceEvidenceCoverage = sourceEvidenceCoverage;
      putRecord('debate-round', `${session.id}:${round}`, current); appendEvent(session.id, 'debate.round', current);
      if (!response || reports.some(r => r.missingReport || !Array.isArray(r.report?.objections))) { stopReason = 'incomplete_assessment'; break; }
      if (!finalObjectionReview.complete) { stopReason = 'incomplete_assessment'; break; }
      if (!finalObjectionReview.unresolved.length && !decision.nextVerificationSteps.length && goalReview.passed) { stopReason = 'issues_resolved'; break; }
      const semanticDecision = { acceptedConclusions: decision.acceptedConclusions, rejectedClaims: decision.rejectedClaims, corrections: decision.corrections,
        remainingObjections: decision.remainingObjections, nextVerificationSteps: decision.nextVerificationSteps,
        objectionDispositions: decision.objectionDispositions.map(item => ({ id: item.id, status: item.status, rationale: item.rationale })), goalSatisfaction: goalReview.goalSatisfaction };
      const positions = JSON.stringify({ participants: reports.map(r => ({ objections: r.report.objections.map(o => ({ id: o.id, claim: o.claim, assumptions: o.assumptions, missingVerification: o.missingVerification,
        evidenceHashes: (o.evidence || []).map(id => getRecord('artifact', id)?.sha256 || id).sort() })).sort((a, b) => String(a.id).localeCompare(String(b.id))), position: r.report.position, conclusions: r.report.conclusions })), decision: semanticDecision });
      if (round > 1 && previousPositions.get('all') === positions) { stopReason = 'positions_stable'; break; }
      previousPositions.set('all', positions); currentCase = response;
    }
    const remaining = [...new Set([...(Array.isArray(decision?.remainingObjections) ? decision.remainingObjections : []), ...finalObjectionReview.unresolved,
      ...(!finalObjectionReview.complete ? objectionLedger.map(item => item.id) : []), ...goalReview.reasons,
      ...(!decision ? ['No complete decision record was returned.'] : []), ...(getRecord('debate-investigation', session.id)?.reports || []).filter(report => !report.report).map(report => `${report.participant.provider}: independent investigation returned no report.`)])];
    const result = { version: 1, debateId: debateIdentity(session), material: { id: material.id, sha256: material.sha256 }, snapshotId: snapshot.id, opening, transcript, decision,
      stopReason: coordinator.stopping || stopReason, unresolvedDisagreement: remaining,
      missionContext, investigation, investigationConsensus: consensus, objectionLedger, objectionReview: finalObjectionReview,
      goalSatisfaction: goalReview.goalSatisfaction, goalAssessment: goalReview.assessment || null, goalReview, sourceEvidenceCoverage,
      independentInvestigationPerformed: !options.reviewOnly, newVerificationPerformed: options.reviewOnly ? false : null, newVerificationDuringRounds: false, verificationReporting: options.reviewOnly ? 'No new tests in snapshot review.' : 'Independent workers report their tests and evidence before the read-only rounds. Artifact integrity and inspection are checked; semantic validity is not automated.', maxRounds: rounds, usage };
    const challengeRounds = transcript.filter(item => item.mainResponse && item.assessments.length === choices.length && item.assessments.every(report => report.report && !report.missingReport)).length;
    const missionCurrent = missionContextCurrent(getRecord('session', session.id) || session, missionContext);
    if (!missionCurrent) remaining.push('Original goal, instructions or selected evidence changed during the review.');
    result.assessment = { passed: Boolean(challengeRounds >= 1 && opening.mainResponse && finalObjectionReview.complete && goalReview.passed && missionCurrent && !remaining.length && !decision?.nextVerificationSteps?.length && !coordinator.stopping),
      challengeRounds, objectionCount: objectionLedger.length, evidenceChecksPassed: Boolean(finalObjectionReview.complete && goalReview.passed), inspectedEvidence: goalReview.inspectedEvidence || [],
      defenderSessionId: defender.workerSessionId, defenderAssignmentId: defenderJob, missionCurrent, semanticVerification: 'not-automated' };
    const unresolved = !result.assessment.passed;
    result.outcome = unresolved ? 'unresolved' : 'assessed';
    return await finishValidation(session, options, ui, coordinator, result, usage, missionContext, synthesizeConsensus, consensus);
  } catch (error) {
    ui.event('error', { message: error.message });
    const partial = { version: 1, debateId: debateIdentity(session), transcript, decision, objectionLedger, outcome: 'unresolved', goalSatisfaction: 'inconclusive',
      assessment: { passed: false, challengeRounds: transcript.length, semanticVerification: 'not-automated' },
      unresolvedDisagreement: ['The assessment stopped before the original goal and evidence could be verified.'], stopReason: error.message, usage };
    putRecord('debate', session.id, partial);
    const code = await coordinator.finish('awaiting_review', partial, usage);
    ui.event('debate.phase', { phase: 'finished', status: session.goal.status });
    ui.event('debate.result', { status: session.goal.status, decision: null, consensus: null, goalSatisfaction: 'inconclusive',
      unresolvedDisagreement: partial.unresolvedDisagreement, message: 'Validation stopped · assessment remains inconclusive.' });
    return code;
  } finally {
    if (sessionMemoryEligible(session)) {
      try { queueSessionCompaction(session); } catch { /* Derived memory cannot change the review outcome. */ }
    }
  }
}


async function finishValidation(session, options, ui, coordinator, result, usage, missionContext, synthesizeConsensus, consensus = null) {
  putRecord('debate', session.id, result);
  const afterAssessment = async (checkedResult, checkedStatus) => {
    ui.event('debate.phase', { phase: 'consensus', status: 'started' });
    const remainingTokens = session.goal.tokenBudget == null ? consensusTokenBudget : Math.max(0, session.goal.tokenBudget - (coordinator.tokenOffset || 0) - usage.totalTokens);
    const maximumRuntime = Math.min(options.runtimeSeconds ?? Infinity, session.contract.limits.runtimeSeconds ?? Infinity);
    const elapsed = coordinator.started ? (Date.now() - coordinator.started) / 1000 : 0;
    const remainingSeconds = Math.min(45, Math.max(0, maximumRuntime - (session.goal.runtimeUsedSeconds || 0) - elapsed));
    result.consensus = await synthesizeConsensus(session, checkedResult, { signal: coordinator.abort.signal, tokenBudget: remainingTokens, runtimeSeconds: remainingSeconds, checkedStatus });
    const charged = result.consensus.chargedTokens || 0;
    if (result.consensus.selection && (charged || result.consensus.usageAvailable)) {
      usage.agents.push({ ...result.consensus.selection, role: 'consensus', tokens: result.consensus.tokens ?? null,
        available: result.consensus.usageAvailable === true, chargedTokens: charged });
      usage.totalTokens += charged; usage.complete &&= result.consensus.usageAvailable === true;
      coordinator.checkBudget(usage.totalTokens);
    }
    const decisive = (checkedResult.assessment?.inspectedEvidence || []).map(id => getRecord('artifact', id));
    if (!chatReviewSourceCurrent(session) || !missionContextCurrent(getRecord('session', session.id) || session, missionContext) ||
        decisive.some(item => !item) || !missionEvidenceCurrent(decisive)) {
      const reason = 'The original goal, source instructions or inspected evidence changed during Core consensus.';
      checkedResult.reportedGoalSatisfaction ||= checkedResult.goalSatisfaction;
      checkedResult.goalSatisfaction = 'inconclusive'; checkedResult.outcome = 'unresolved';
      checkedResult.assessment = { ...checkedResult.assessment, passed: false, postConsensusCurrent: false };
      checkedResult.unresolvedDisagreement = [...new Set([...(checkedResult.unresolvedDisagreement || []), reason])];
      if (checkedResult.decision) checkedResult.decision = { ...checkedResult.decision, goalSatisfaction: 'inconclusive' };
      session.acceptance = { ...session.acceptance, passed: false, debate: { ...session.acceptance?.debate, passed: false,
        reasons: [...(session.acceptance?.debate?.reasons || []), reason] } };
      checkedResult.acceptance = session.acceptance;
      const { text, ...invalidated } = checkedResult.consensus;
      checkedResult.consensus = { ...invalidated, state: 'unavailable', reason: 'source_changed' };
      return { status: 'awaiting_review' };
    }
  };
  const code = await coordinator.finish(result.assessment?.passed ? 'complete' : 'awaiting_review', result, usage, { afterAssessment });
  putRecord('debate', session.id, result);
  ui.event('debate.phase', { phase: 'finished', status: session.goal.status });
  ui.event('debate.result', { sessionId: session.id, status: session.goal.status, decision: result.decision, consensus: result.consensus || consensus, goalSatisfaction: result.goalSatisfaction,
    unresolvedDisagreement: result.unresolvedDisagreement, evidence: session.goal.evidence, stopReason: result.stopReason,
    message: `Validation ${session.goal.status === 'complete' ? 'finished' : session.goal.status === 'awaiting_review' ? 'finished · unresolved' : session.goal.status}\n${result.consensus?.state === 'ready' ? `Core consensus · ${result.consensus.selection.provider}${result.consensus.selection.model ? ' · ' + result.consensus.selection.model : ''}\n${result.consensus.text}\n\n` : ''}${result.validationPolicy?.message || formatDecision(result.decision, result.unresolvedDisagreement)}` });
  return code;
}
