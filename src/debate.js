import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Coordinator } from './coordination.js';
import { agentChoice, startAssignment, followupAssignment, waitAssignment, assignmentStatus, delay } from './delegation.js';
import { snapshotWorkspace, inside, artifact } from './evidence.js';
import { getRecord, putRecord, appendEvent, now, digest } from './database.js';
import { investigate } from './investigation.js';
import { formatPosition, formatDecision } from './debate-format.js';

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
    const choices = (options.participants?.length ? options.participants : ['claude', 'deepseek']).map(v => agentChoice(v));
    const supervisor = agentChoice(options.supervisor || session.provider, options.supervisorModel || session.model);
    const reviewPolicy = { ...session.policy, mode: 'read-only', writablePaths: [] };
    session.contract.limits.maxRetries = Math.max(session.contract.limits.maxRetries || 0, rounds - 1);
    session.contract.limits.concurrency = Math.min(options.concurrency || session.contract.limits.concurrency || choices.length, 8);
    if (!options.reviewOnly) investigationUsage = await investigate(session, choices, snapshot, options, ui, coordinator);
    const commonEvidence = getRecord('debate-investigation', session.id)?.reports.flatMap(report => report.artifacts.filter(item => item.id && !item.omitted).map(item => item.id)) || [];
    const updateUsage = () => { usage.agents = [...investigationUsage, ...agents.filter(Boolean)]; usage.totalTokens = usage.agents.reduce((sum, a) => sum + (a.tokens || 0), 0); usage.complete = usage.agents.every(a => a.available); coordinator.checkBudget(usage.totalTokens); };
    updateUsage();
    ui.event('info', { message: `/goal ${session.goal.objective}\nPHASE 2 · Evidence debate · up to ${rounds} rounds` });
    const jobs = [], previousPositions = new Map(); let priorArguments = null, defenderJob;
    for (let round = 1; round <= rounds && !coordinator.stopping; round++) {
      ui.event('info', { message: `Debate round ${round}/${rounds} · fixed snapshot ${snapshot.manifestHash.slice(0, 12)}` });
      const reports = [];
      for (let index = 0; index < choices.length && !coordinator.stopping; index++) {
        const selection = choices[index];
        const context = `Assess only the fixed selected material in BZZY_SELECTED_MATERIAL.txt and this snapshot. ${options.reviewOnly ? 'Your initial assessment is independent: no other participant’s first assessment is supplied.' : 'Independent investigations are complete. Inspect BZZY_INVESTIGATION_REPORTS.json and the shared evidence bundle. Treat worker findings as claims; compare actual evidence and test limitations.'}
Identify specific objections, source/evidence references, assumptions and missing verification. Do not implement changes, contact targets or run new experiments; describe needed verification separately.
Use record_evidence for relevant files. Return finish_assignment with status, summary, evidence, objections (stable IDs), conclusions, position and changedBecause.
${round > 1 ? `Answer these specific prior arguments and the main agent's response; explain positions you retain or revise:\n${JSON.stringify(priorArguments)}` : ''}`;
        if (round === 1) {
          const job = startAssignment(session, { requestId: `debate-${session.id}-${index}`, objective: session.goal.objective, context, acceptanceCriteria: ['Ground objections and conclusions in the fixed material; preserve uncertainty and missing verification.'], policy: reviewPolicy, limits: { runtimeSeconds: options.runtimeSeconds || 300 } }, { executor: selection, snapshot, role: 'reviewer', allowDebate: true, sharedEvidence: commonEvidence });
          jobs[index] = job.id;
        } else followupAssignment(session, jobs[index], { requestId: `debate-${session.id}-${index}-${round}`, objective: session.goal.objective, feedback: context });
        // One participant at a time keeps memory and resource consumption bounded. Their first prompts remain independent.
        while (!coordinator.stopping) { const result = await waitAssignment(session.id, jobs[index], 1); if (result.terminal) break; }
        const job = assignmentStatus(jobs[index]), report = job.latestReport;
        reports.push({ participant: selection, assignmentId: job.id, round, report: report?.report || null, state: job.round.state, artifacts: report?.artifacts || [], missingReport: !report?.report });
        agents[index] = { ...selection, tokens: report?.usage?.tokens ?? null, available: Boolean(report?.usage?.available) };
        updateUsage();
        ui.event('debate.message', { participant: selection.provider, role: 'reviewer', round, maxRounds: rounds, text: formatPosition(report?.report) });
      }
      if (coordinator.stopping) break;
      const context = `You are the main agent responding to independent challenges to the selected work in BZZY_SELECTED_MATERIAL.txt.
Defend supported claims, concede valid objections or revise conclusions. Address specific objection IDs. Agreement is not evidence.
Inspect cited evidence. Do not change implementation or perform new tests here; list required verification separately.
Return finish_assignment including a decision object with arrays acceptedConclusions, rejectedClaims, corrections, remainingObjections, nextVerificationSteps. Preserve uncertainty and unresolved disagreement.
PARTICIPANT REPORTS:\n${JSON.stringify(reports)}`;
      const sharedEvidence = [...commonEvidence, ...reports.flatMap(r => r.artifacts.map(a => a.id))];
      if (!defenderJob) defenderJob = startAssignment(session, { requestId: `debate-main-${session.id}`, objective: session.goal.objective, context,
        acceptanceCriteria: ['Answer concrete objections with evidence and return a decision record without forcing consensus.'], policy: reviewPolicy, limits: { runtimeSeconds: options.runtimeSeconds || 300 } }, { executor: supervisor, snapshot, role: 'reviewer', allowDebate: true, sharedEvidence }).id;
      else followupAssignment(session, defenderJob, { requestId: `debate-main-${session.id}-${round}`, objective: session.goal.objective, feedback: context }, { sharedEvidence });
      while (!coordinator.stopping) { if ((await waitAssignment(session.id, defenderJob, 1)).terminal) break; }
      const defender = assignmentStatus(defenderJob), response = defender.latestReport?.report || null;
      agents[choices.length] = { ...supervisor, role: 'main', tokens: defender.latestReport?.usage?.tokens ?? null, available: Boolean(defender.latestReport?.usage?.available) };
      updateUsage();
      ui.event('debate.message', { participant: supervisor.provider, role: 'main agent', round, maxRounds: rounds, text: formatPosition(response) });
      const current = { round, assessments: reports, mainResponse: response, snapshotHash: snapshot.manifestHash, createdAt: now() };
      transcript.push(current); putRecord('debate-round', `${session.id}:${round}`, current); appendEvent(session.id, 'debate.round', current);
      decision = response?.decision || null;
      const validDecision = decision && ['acceptedConclusions', 'rejectedClaims', 'corrections', 'remainingObjections', 'nextVerificationSteps'].every(key => Array.isArray(decision[key]));
      if (!validDecision || reports.some(r => r.missingReport || !Array.isArray(r.report?.objections))) { stopReason = 'incomplete_assessment'; break; }
      const objections = reports.flatMap(r => r.report.objections);
      if (!decision.remainingObjections.length && !decision.nextVerificationSteps.length && !objections.length) { stopReason = 'issues_resolved'; break; }
      const positions = JSON.stringify({ participants: reports.map(r => ({ objections: r.report.objections.map(o => ({ id: o.id, claim: o.claim, assumptions: o.assumptions, missingVerification: o.missingVerification,
        evidenceHashes: (o.evidence || []).map(id => getRecord('artifact', id)?.sha256 || id).sort() })).sort((a, b) => String(a.id).localeCompare(String(b.id))), position: r.report.position, conclusions: r.report.conclusions })), decision });
      if (round > 1 && previousPositions.get('all') === positions) { stopReason = 'positions_stable'; break; }
      previousPositions.set('all', positions); priorArguments = { reports, mainResponse: response };
    }
    const remaining = [...new Set([...(decision?.remainingObjections || []), ...(transcript.at(-1)?.assessments || []).flatMap(assessment => (assessment.report?.objections || []).map(objection => objection.id || objection.claim || String(objection))),
      ...(!decision ? ['No complete decision record was returned.'] : []), ...(getRecord('debate-investigation', session.id)?.reports || []).filter(report => !report.report).map(report => `${report.participant.provider}: independent investigation returned no report.`)])];
    const result = { version: 1, material: { id: material.id, sha256: material.sha256 }, snapshotId: snapshot.id, transcript, decision,
      stopReason: coordinator.stopping || stopReason, unresolvedDisagreement: remaining,
      investigation: getRecord('debate-investigation', session.id), independentInvestigationPerformed: !options.reviewOnly, newVerificationPerformed: options.reviewOnly ? false : null, newVerificationDuringRounds: false, verificationReporting: options.reviewOnly ? 'No new tests in snapshot review.' : 'Independent workers report their tests and evidence before the read-only rounds. Test claims still require evidence review.', maxRounds: rounds, usage };
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
