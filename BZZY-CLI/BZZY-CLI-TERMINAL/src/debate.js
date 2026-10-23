import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Coordinator } from './coordination.js';
import { startAssignment, followupAssignment, waitAssignment, assignmentStatus, delay } from './delegation.js';
import { snapshotWorkspace, inside, artifact } from './evidence.js';
import { getRecord, putRecord, appendEvent, now, digest } from './database.js';
import { investigate, investigationConsensus, investigationReadiness } from './investigation.js';
import { assessObjectionDispositions, formatInvestigation, formatPosition, formatDecision } from './debate-format.js';
import { configuredDebate, applyDebateSelection } from './debate-setup.js';
import { saveSession } from './store.js';

export async function runDebate(session, options, ui) {
  const coordinator = new Coordinator(session, ui, options); coordinator.start();
  const transcript = [], agents = []; let investigationUsage = [], usage = { totalTokens: 0, complete: true, agents }, stopReason = 'round_limit', decision = null;
  try {
    const rounds = options.rounds || 5;
    if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 5) throw new Error('Debate rounds must be 1–5.');
    const selected = options.artifact ? getRecord('artifact', options.artifact) : null;
    const content = selected ? fs.readFileSync(selected.path) : options.artifact ? fs.readFileSync(inside(session.cwd, options.artifact)) : Buffer.from(`GOAL\n${session.goal.objective}\n\nIndependently investigate this goal in the supplied workspace before debating its support.`);
    if (content.length > 512 * 1024) throw new Error('Selected debate material exceeds 512 KiB. Select a smaller artifact.');
    const material = artifact(session, content, 'debate-selected-material', selected?.mediaType || 'text/plain');
    const snapshot = snapshotWorkspace(session, 'debate-fixed-snapshot');
    const materialPath = path.join(snapshot.directory, 'BZZY_SELECTED_MATERIAL.txt');
    if (fs.existsSync(materialPath)) throw new Error('Reserved debate snapshot path already exists.');
    fs.writeFileSync(materialPath, content, { mode: 0o600 });
    snapshot.manifest['BZZY_SELECTED_MATERIAL.txt'] = { size: content.length, sha256: digest(content) };
    snapshot.manifestHash = digest(snapshot.manifest); putRecord('snapshot', snapshot.id, snapshot);
    const selectedAgents = configuredDebate({ ...options, provider: session.provider, model: session.model, debateAgents: options.debateAgents || session.debateAgents });
    applyDebateSelection(session, selectedAgents); saveSession(session);
    const [supervisor, ...choices] = selectedAgents;
    const reviewPolicy = { ...session.policy, mode: 'read-only', writablePaths: [] };
    session.contract.limits.maxRetries = Math.max(session.contract.limits.maxRetries || 0, rounds);
    session.contract.limits.concurrency = Math.min(options.concurrency || session.contract.limits.concurrency || selectedAgents.length, 8);
    if (!options.reviewOnly) investigationUsage = await investigate(session, selectedAgents, snapshot, options, ui, coordinator);
    const investigation = getRecord('debate-investigation', session.id);
    const commonEvidence = investigation?.reports.flatMap(report => report.artifacts.filter(item => item.id && !item.omitted).map(item => item.id)) || [];
    const updateUsage = () => { usage.agents = [...investigationUsage, ...agents.filter(Boolean)]; usage.totalTokens = usage.agents.reduce((sum, a) => sum + (a.tokens || 0), 0); usage.complete = usage.agents.every(a => a.available); coordinator.checkBudget(usage.totalTokens); };
    updateUsage();
    if (!options.reviewOnly) {
      const consensus = investigationConsensus(investigation, selectedAgents.length);
      if (consensus.reached) {
        stopReason = 'majority_consensus';
        const conclusion = consensus.verdict === 'real' ? 'The finding is real.' : 'The finding is a false positive.';
        decision = { acceptedConclusions: [conclusion], rejectedClaims: [], corrections: [], remainingObjections: [], nextVerificationSteps: [], objectionDispositions: [], consensus };
        const result = { version: 1, material: { id: material.id, sha256: material.sha256 }, snapshotId: snapshot.id, opening: null, transcript, decision,
          stopReason, unresolvedDisagreement: [], investigation, investigationConsensus: consensus, independentInvestigationPerformed: true,
          newVerificationPerformed: null, newVerificationDuringRounds: false, verificationReporting: 'A strict majority of independent complete reports reached the same evidence-backed verdict.', maxRounds: rounds, usage, outcome: 'assessed' };
        putRecord('debate', session.id, result);
        const abstentions = consensus.votes.filter(vote => !vote.counted).map(vote => `${vote.provider}: ${vote.state === 'timed_out' ? 'timed out' : vote.reportedVerdict || vote.status || vote.state}`);
        ui.event('info', { message: `CONSENSUS REACHED · ${consensus.counts[consensus.verdict]}/${consensus.total}\nVerdict: ${consensus.verdict === 'real' ? 'REAL' : 'FALSE POSITIVE'}${abstentions.length ? `\nNot counted: ${abstentions.join(' · ')}` : ''}\nSkipping challenge rounds.` });
        const code = await coordinator.finish('complete', result, usage);
        ui.event('debate.result', { sessionId: session.id, status: session.goal.status, decision, unresolvedDisagreement: [], evidence: session.goal.evidence,
          message: `Debate finished · majority consensus\n${conclusion}\nAgreement: ${consensus.counts[consensus.verdict]}/${consensus.total} evidence-backed agents.` });
        return code;
      }
      const readiness = investigationReadiness(investigation, selectedAgents.length);
      if (!readiness.passed) {
        stopReason = 'insufficient_investigation_evidence';
        const remaining = [`Only ${readiness.usable}/${readiness.total} independent reports contained a usable conclusion with recorded evidence; ${readiness.required} are required.`, ...readiness.reasons];
        const result = { version: 1, material: { id: material.id, sha256: material.sha256 }, snapshotId: snapshot.id, opening: null, transcript, decision: null,
          stopReason, unresolvedDisagreement: remaining, investigation, investigationReadiness: readiness, independentInvestigationPerformed: true,
          newVerificationPerformed: null, newVerificationDuringRounds: false, verificationReporting: 'The evidence phase did not support an adversarial discussion.', maxRounds: rounds, usage, outcome: 'unresolved' };
        putRecord('debate', session.id, result);
        ui.event('info', { message: `DEBATE STOPPED · evidence phase not ready\n${remaining.map(item => `• ${item}`).join('\n')}\nResolve the investigation blockers or provide concrete finding material, then run the debate again.` });
        const code = await coordinator.finish('awaiting_review', result, usage);
        ui.event('debate.result', { sessionId: session.id, status: session.goal.status, decision: null, unresolvedDisagreement: remaining, evidence: session.goal.evidence,
          message: `Debate finished · insufficient evidence\n${remaining.map(item => `• ${item}`).join('\n')}` });
        return code;
      }
    }
    ui.event('info', { message: 'PHASE 2 · Main agent opening case' });
    const openingContext = `You are the main agent responding with the opening case in an evidence-based debate about BZZY_SELECTED_MATERIAL.txt.
${options.reviewOnly ? 'Assess the fixed material now; no new experiments are allowed in this review-only debate.' : 'All selected agents completed independent assessments. Inspect BZZY_INVESTIGATION_REPORTS.json and the shared evidence only now, after independence was preserved.'}
Synthesize the strongest supported case, acknowledge contrary evidence and uncertainty, and identify the claims that still need verification. Agreement is not evidence.
Do not change implementation or perform new tests here. Return finish_assignment including a decision object with arrays acceptedConclusions, rejectedClaims, corrections, remainingObjections, nextVerificationSteps and objectionDispositions. The opening objectionDispositions array is empty.`;
    let defenderJob = startAssignment(session, { requestId: `debate-main-${session.id}`, objective: session.goal.objective, context: openingContext,
      acceptanceCriteria: ['Open with an evidence-grounded case that preserves contrary findings, uncertainty and missing verification.'], policy: reviewPolicy,
      limits: { runtimeSeconds: options.runtimeSeconds || 300 } }, { executor: supervisor, snapshot, role: 'reviewer', allowDebate: true, sharedEvidence: commonEvidence }).id;
    while (!coordinator.stopping) { if ((await waitAssignment(session.id, defenderJob, 1)).terminal) break; }
    let defender = assignmentStatus(defenderJob), currentCase = defender.latestReport?.report || null;
    let defenderError = defender.round.error || defender.latestReport?.error || defender.latestReport?.stopReason || null;
    agents[choices.length] = { ...supervisor, role: 'main', tokens: defender.latestReport?.usage?.tokens ?? null, available: Boolean(defender.latestReport?.usage?.available) };
    updateUsage();
    ui.event('debate.message', { participant: supervisor.provider, role: 'main opening', assignmentId: defenderJob, state: defender.round.state,
      error: defenderError, text: currentCase ? formatPosition(currentCase) : formatInvestigation({ state: defender.round.state, error: defenderError }) });
    const opening = { mainResponse: currentCase, assignmentId: defenderJob, snapshotHash: snapshot.manifestHash, createdAt: now() };
    putRecord('debate-opening', session.id, opening); appendEvent(session.id, 'debate.opening', opening);
    decision = currentCase?.decision || null;

    ui.event('info', { message: `PHASE 3 · Challenge and revision · up to ${rounds} rounds` });
    const jobs = [], previousPositions = new Map(); let finalObjectionReview = { complete: false, unresolved: [] };
    for (let round = 1; round <= rounds && !coordinator.stopping; round++) {
      ui.event('info', { message: `Debate round ${round}/${rounds} · fixed snapshot ${snapshot.manifestHash.slice(0, 12)}` });
      const reports = [];
      for (let index = 0; index < choices.length && !coordinator.stopping; index++) {
        const selection = choices[index];
        const context = `Challenge the main agent's current case against the fixed selected material in BZZY_SELECTED_MATERIAL.txt. ${options.reviewOnly ? 'This is a read-only assessment.' : 'Independent assessments are complete; inspect BZZY_INVESTIGATION_REPORTS.json and the shared evidence bundle. Treat every agent finding as a claim and compare the actual evidence and test limitations.'}
Identify which claims survive, specific objections, source/evidence references, assumptions and missing verification. Address revisions from earlier rounds instead of repeating answered points. Do not implement changes, contact targets or run new experiments; describe needed verification separately.
Use record_evidence for relevant files. Return finish_assignment with status, summary, evidence, objections (stable IDs), conclusions, position and changedBecause.
CURRENT MAIN CASE:\n${JSON.stringify(currentCase)}`;
        if (round === 1) {
          const job = startAssignment(session, { requestId: `debate-${session.id}-${index}`, objective: session.goal.objective, context, acceptanceCriteria: ['Ground objections and conclusions in the fixed material; preserve uncertainty and missing verification.'], policy: reviewPolicy, limits: { runtimeSeconds: options.runtimeSeconds || 300 } }, { executor: selection, snapshot, role: 'reviewer', allowDebate: true, sharedEvidence: commonEvidence });
          jobs[index] = job.id;
        } else followupAssignment(session, jobs[index], { requestId: `debate-${session.id}-${index}-${round}`, objective: session.goal.objective, feedback: context });
        // One participant at a time keeps memory and resource consumption bounded. Their first prompts remain independent.
        while (!coordinator.stopping) { const result = await waitAssignment(session.id, jobs[index], 1); if (result.terminal) break; }
        const job = assignmentStatus(jobs[index]), report = job.latestReport;
        reports.push({ participant: selection, assignmentId: job.id, round, report: report?.report || null, state: job.round.state,
          error: job.round.error || report?.error || report?.stopReason || null, artifacts: report?.artifacts || [], missingReport: !report?.report });
        agents[index] = { ...selection, tokens: report?.usage?.tokens ?? null, available: Boolean(report?.usage?.available) };
        updateUsage();
        const assessment = reports.at(-1);
        ui.event('debate.message', { participant: selection.provider, role: 'reviewer', round, maxRounds: rounds, assignmentId: job.id,
          state: assessment.state, error: assessment.error, text: assessment.report ? formatPosition(assessment.report) : formatInvestigation(assessment) });
      }
      if (coordinator.stopping) break;
      const context = `You are the main agent responding to a challenge round by revising the current case about BZZY_SELECTED_MATERIAL.txt.
Defend supported claims, concede valid objections, or revise conclusions. Address every specific objection ID and state what changed from the prior case. Agreement is not evidence.
Inspect cited evidence. Do not change implementation or perform new tests here; list required verification separately.
Return finish_assignment including a decision object with arrays acceptedConclusions, rejectedClaims, corrections, remainingObjections, nextVerificationSteps and objectionDispositions. Give every challenger objection ID exactly one objectionDispositions entry with status accepted, resolved, rejected or unresolved plus a concise rationale and evidence IDs. Preserve uncertainty and unresolved disagreement.
PRIOR MAIN CASE:\n${JSON.stringify(currentCase)}\nCHALLENGER REPORTS:\n${JSON.stringify(reports)}`;
      const sharedEvidence = [...commonEvidence, ...reports.flatMap(r => r.artifacts.map(a => a.id))];
      followupAssignment(session, defenderJob, { requestId: `debate-main-${session.id}-${round}`, objective: session.goal.objective, feedback: context }, { sharedEvidence });
      while (!coordinator.stopping) { if ((await waitAssignment(session.id, defenderJob, 1)).terminal) break; }
      defender = assignmentStatus(defenderJob); const response = defender.latestReport?.report || null;
      defenderError = defender.round.error || defender.latestReport?.error || defender.latestReport?.stopReason || null;
      agents[choices.length] = { ...supervisor, role: 'main', tokens: defender.latestReport?.usage?.tokens ?? null, available: Boolean(defender.latestReport?.usage?.available) };
      updateUsage();
      ui.event('debate.message', { participant: supervisor.provider, role: 'main agent', round, maxRounds: rounds, assignmentId: defenderJob,
        state: defender.round.state, error: defenderError, text: response ? formatPosition(response) : formatInvestigation({ state: defender.round.state, error: defenderError }) });
      const current = { round, caseBefore: currentCase, assessments: reports, mainResponse: response, snapshotHash: snapshot.manifestHash, createdAt: now() };
      transcript.push(current); putRecord('debate-round', `${session.id}:${round}`, current); appendEvent(session.id, 'debate.round', current);
      decision = response?.decision || null;
      const validDecision = decision && ['acceptedConclusions', 'rejectedClaims', 'corrections', 'remainingObjections', 'nextVerificationSteps', 'objectionDispositions'].every(key => Array.isArray(decision[key]));
      if (!validDecision || reports.some(r => r.missingReport || !Array.isArray(r.report?.objections))) { stopReason = 'incomplete_assessment'; break; }
      finalObjectionReview = assessObjectionDispositions(reports, decision);
      if (!finalObjectionReview.complete) { stopReason = 'incomplete_assessment'; break; }
      if (!finalObjectionReview.unresolved.length && !decision.nextVerificationSteps.length) { stopReason = 'issues_resolved'; break; }
      const semanticDecision = { acceptedConclusions: decision.acceptedConclusions, rejectedClaims: decision.rejectedClaims, corrections: decision.corrections,
        remainingObjections: decision.remainingObjections, nextVerificationSteps: decision.nextVerificationSteps,
        objectionDispositions: decision.objectionDispositions.map(item => ({ id: item.id, status: item.status, rationale: item.rationale })) };
      const positions = JSON.stringify({ participants: reports.map(r => ({ objections: r.report.objections.map(o => ({ id: o.id, claim: o.claim, assumptions: o.assumptions, missingVerification: o.missingVerification,
        evidenceHashes: (o.evidence || []).map(id => getRecord('artifact', id)?.sha256 || id).sort() })).sort((a, b) => String(a.id).localeCompare(String(b.id))), position: r.report.position, conclusions: r.report.conclusions })), decision: semanticDecision });
      if (round > 1 && previousPositions.get('all') === positions) { stopReason = 'positions_stable'; break; }
      previousPositions.set('all', positions); currentCase = response;
    }
    const remaining = [...new Set([...(decision?.remainingObjections || []), ...finalObjectionReview.unresolved,
      ...(!decision ? ['No complete decision record was returned.'] : []), ...(getRecord('debate-investigation', session.id)?.reports || []).filter(report => !report.report).map(report => `${report.participant.provider}: independent investigation returned no report.`)])];
    const result = { version: 1, material: { id: material.id, sha256: material.sha256 }, snapshotId: snapshot.id, opening, transcript, decision,
      stopReason: coordinator.stopping || stopReason, unresolvedDisagreement: remaining,
      investigation, independentInvestigationPerformed: !options.reviewOnly, newVerificationPerformed: options.reviewOnly ? false : null, newVerificationDuringRounds: false, verificationReporting: options.reviewOnly ? 'No new tests in snapshot review.' : 'Independent workers report their tests and evidence before the read-only rounds. Test claims still require evidence review.', maxRounds: rounds, usage };
    const unresolved = stopReason === 'incomplete_assessment' || !decision || remaining.length || decision.nextVerificationSteps?.length;
    result.outcome = unresolved ? 'unresolved' : 'assessed';
    putRecord('debate', session.id, result);
    const code = await coordinator.finish(unresolved ? 'awaiting_review' : 'complete', result, usage);
    ui.event('debate.result', { sessionId: session.id, status: session.goal.status, decision, unresolvedDisagreement: remaining, evidence: session.goal.evidence,
      message: `Debate ${session.goal.status === 'complete' ? 'finished' : session.goal.status === 'awaiting_review' ? 'finished · unresolved' : session.goal.status}\n${formatDecision(decision, remaining)}` });
    return code;
  } catch (error) {
    ui.event('error', { message: error.message });
    return coordinator.finish('blocked', { transcript, decision, stopReason: error.message }, usage);
  }
}
