import fs from 'node:fs';
import path from 'node:path';
import { startAssignment, assignmentStatus, delay } from './delegation.js';
import { database, getRecord, putRecord, digest, now } from './database.js';
import { fileInfo, artifact } from './evidence.js';
import { formatInvestigation } from './debate-format.js';
import { debateEventUI } from './debate-events.js';
import { normalizeValidationAssessment, naturalValidationSummary, remapValidationAssessment } from './validation-assessment.js';
import { missionContextCurrent, missionSourceRevision, missionResultRevision, missionEvidenceCurrent } from './mission-context.js';

const selectionKey = choice => digest([choice?.provider, choice?.model || null, choice?.effort || 'default']);
const reportClaim = report => ({ status: report?.status, summary: report?.summary, evidence: report?.evidence,
  validationAssessment: report?.validationAssessment, objections: report?.objections || [], uncertainties: report?.uncertainties || [] });

function currentOriginalSource(parent) {
  const pin = parent.reviewSource;
  if (!pin) return true;
  const original = getRecord('session', pin.sessionId);
  return Boolean(original && !getRecord('session-deletion', pin.sessionId) && original.goal?.id === pin.goalId &&
    original.goal?.status === pin.claimedStatus && missionSourceRevision(original) === pin.sourceRevision &&
    (!pin.resultRevision || missionResultRevision(original) === pin.resultRevision) && (!pin.missionContextId || missionContextCurrent(original, pin.missionContextId)));
}

function checkedValidationParticipant(entry, index, parent, { objective, criteria }) {
  const value = { index, participant: entry?.participant || null, assignmentId: entry?.assignmentId || null, workerSessionId: null, round: null,
    valid: false, achieved: null, reportedAchieved: null, objective, criteria: [], evidence: [], summary: entry?.report?.summary || '', invalidReasons: [] };
  const invalid = reason => { value.invalidReasons.push(reason); return value; };
  if (!parent || !entry || entry.state !== 'awaiting_review' || !entry.report?.validationAssessment || !naturalValidationSummary(entry.report.summary)) return invalid('Missing or incomplete structured original-goal assessment.');
  const job = getRecord('assignment', entry.assignmentId), worker = job?.workerSessionId && getRecord('session', job.workerSessionId);
  const round = job && getRecord('round', `${job.id}:${job.currentRound}`);
  if (!job || !worker || getRecord('session-deletion', worker.id) || job.parentSessionId !== parent.id || job.goalId !== parent.goal?.id || job.closure !== 'open' ||
      worker.parentSessionId !== parent.id || worker.assignmentId !== job.id || worker.assignmentRound !== job.currentRound ||
      entry.round != null && entry.round !== job.currentRound || round?.state !== 'awaiting_review' || job.latestReport?.round !== job.currentRound ||
      selectionKey(job.selection) !== selectionKey(entry.participant) || !missionContextCurrent(parent, job.missionContext)) return invalid('The worker, round or source mission is stale or outside this validation.');
  value.workerSessionId = worker.id; value.round = job.currentRound;
  const created = database().prepare("SELECT data FROM events WHERE session_id=? AND type='assignment.created' AND json_extract(data,'$.id')=? ORDER BY seq LIMIT 1").get(parent.id, job.id);
  const initial = created && JSON.parse(created.data).missionContext;
  if (initial?.brief?.independent !== true || !missionContextCurrent(parent, initial)) return invalid('The assessment has no current independent initial mission.');
  const aliases = new Map(), originalEvidence = [];
  if (!Array.isArray(job.latestReport.report?.evidence)) return invalid('The bound worker report has no valid evidence inventory.');
  for (const id of job.latestReport.report?.evidence || []) {
    const reference = entry.artifacts?.find(item => !item.omitted && (item.id === id || item.originalId === id));
    const original = getRecord('artifact', id), copy = reference && getRecord('artifact', reference.id);
    if (!reference || !original || original.sessionId !== worker.id || !copy || copy.sessionId !== parent.id || copy.sha256 !== original.sha256 ||
        reference.sha256 !== copy.sha256 || copy.id !== original.id && (copy.importedFrom !== original.id || copy.importedSha256 !== original.sha256)) return invalid('A cited artifact was not preserved from this worker into the current evidence bundle.');
    aliases.set(id, copy.id); aliases.set(copy.id, copy.id); originalEvidence.push(original, copy);
  }
  if (!missionEvidenceCurrent(originalEvidence)) return invalid('Assessment evidence is missing, changed or stale.');
  try {
    const stored = job.latestReport.report, canonical = report => {
      const evidence = report.evidence.map(id => aliases.get(id) || id);
      const assessment = remapValidationAssessment(report.validationAssessment, aliases);
      return { ...reportClaim(report), evidence, validationAssessment: normalizeValidationAssessment(assessment, { objective, criteria, evidence }) };
    };
    const actual = canonical(entry.report), expected = canonical(stored);
    if (digest(actual) !== digest(expected)) return invalid('The published assessment differs from its bound worker report.');
    if (!Array.isArray(actual.objections) || !Array.isArray(actual.uncertainties)) return invalid('The assessment contains malformed concerns.');
    value.valid = true; value.reportedAchieved = actual.validationAssessment.achieved;
    value.achieved = actual.validationAssessment.achieved; value.criteria = actual.validationAssessment.criteria; value.evidence = actual.evidence;
    if (value.achieved !== null && (stored.status !== 'complete' || originalEvidence.some(item => item.size < 1))) {
      value.achieved = null; value.reason = 'The independent assessment is incomplete.';
    }
    // Structured criterion claims govern adaptive routing. Informational
    // limitations remain in the final review's objection ledger; their mere
    // presence does not contradict a supported original criterion.
    if (value.achieved === true && actual.objections.length) {
      value.achieved = null; value.reason = 'The agent retained unresolved objections.';
    }
    return value;
  } catch { return invalid('The assessment does not match the exact original goal, criteria or canonical evidence IDs.'); }
}

// A routing decision over scoped worker claims, never verified goal completion.
// Unknown/malformed/legacy reports stay null; vulnerability votes are not coerced.
export function assessValidationAgreement(investigation, totalAgents, { sessionId, objective, criteria } = {}) {
  if (!Number.isSafeInteger(totalAgents) || totalAgents < 2 || totalAgents > 3) throw new Error('Validation needs two or three independent assessments.');
  const parent = sessionId && getRecord('session', sessionId);
  objective ??= parent?.reviewSource?.objective || parent?.goal?.objective;
  criteria ??= parent?.contract?.acceptanceCriteria;
  const fresh = parent && !getRecord('session-deletion', parent.id) && !['paused', 'cancelled', 'failed'].includes(parent.executionState) && currentOriginalSource(parent) &&
    investigation?.protocol === 'tri-state-v1' && investigation.sessionId === parent.id && investigation.goalId === parent.goal?.id && investigation.sourceRevision === missionSourceRevision(parent);
  const participants = Array.from({ length: totalAgents }, (_, index) => checkedValidationParticipant(investigation?.reports?.[index], index, fresh ? parent : null, { objective, criteria }));
  const identities = new Set();
  for (const participant of participants) {
    const identity = participant.workerSessionId;
    if (identity && identities.has(identity)) { participant.valid = false; participant.achieved = null; participant.invalidReasons.push('A worker conversation cannot count as two independent assessments.'); }
    if (identity) identities.add(identity);
  }
  const counts = { true: participants.filter(item => item.valid && item.achieved === true).length,
    false: participants.filter(item => item.valid && item.achieved === false).length,
    null: participants.filter(item => !item.valid || item.achieved === null).length, invalid: participants.filter(item => !item.valid).length };
  return { version: 1, participants, assessments: participants, counts, usable: totalAgents - counts.invalid, total: totalAgents, required: 2,
    agreeTrue: counts.true === totalAgents, agreeFalse: counts.false === totalAgents, hasFalse: counts.false > 0, hasNull: counts.null > 0,
    disagreement: counts.true > 0 && counts.false > 0, assessmentOnly: true };
}

export function investigationReadiness(investigation, totalAgents, { sessionId } = {}) {
  const reports = investigation?.reports || [], required = Math.min(2, totalAgents);
  const usable = [], reasons = [];
  for (let index = 0; index < totalAgents; index++) {
    const entry = reports[index], label = entry?.participant?.provider || `agent ${index + 1}`;
    let reason;
    if (!entry) reason = 'no investigation result';
    else if (entry.state !== 'awaiting_review') reason = `ended ${entry.state}${entry.error ? `: ${String(entry.error).replace(/\s+/g, ' ').trim().slice(0, 500)}` : ''}`;
    else if (!entry.report) reason = 'returned no structured report';
    else if (!['complete', 'partial'].includes(entry.report.status)) reason = `${entry.report.status}: ${entry.report.summary}`;
    else if (!entry.report.evidence?.length) reason = `${entry.report.status} report cited no recorded evidence`;
    else {
      const imported = new Set(entry.artifacts?.flatMap(item => [item.id, item.originalId]).filter(Boolean));
      if (entry.report.evidence.some(id => !imported.has(id))) reason = 'report evidence was not preserved in the fixed bundle';
      if (!reason && sessionId) for (const id of entry.report.evidence) {
        const reference = entry.artifacts.find(item => item.id === id || item.originalId === id), copy = reference && getRecord('artifact', reference.id);
        try {
          if (!copy || copy.sessionId !== sessionId || copy.sha256 !== reference.sha256 || fileInfo(copy.path).sha256 !== copy.sha256) { reason = 'preserved investigation evidence failed its scope or integrity check'; break; }
        } catch { reason = 'preserved investigation evidence is unavailable'; break; }
      }
    }
    if (reason) reasons.push(`${label}: ${reason}`); else usable.push(entry);
  }
  return { passed: usable.length >= required, required, usable: usable.length, total: totalAgents, reasons };
}

export function investigationConsensus(investigation, totalAgents) {
  const reports = investigation?.reports || [], required = Math.floor(totalAgents / 2) + 1;
  const votes = reports.map((entry, index) => {
    const verdict = entry?.report?.verdict;
    const imported = new Set(entry?.artifacts?.flatMap(item => [item.id, item.originalId]).filter(Boolean));
    const evidence = entry?.report?.evidence || [];
    const counted = entry?.state === 'awaiting_review' && entry.report?.status === 'complete' && ['real', 'false_positive'].includes(verdict)
      && evidence.length > 0 && evidence.every(id => imported.has(id));
    return { index, provider: entry?.participant?.provider || `agent ${index + 1}`, verdict: counted ? verdict : null,
      reportedVerdict: verdict || null, state: entry?.state || 'missing', status: entry?.report?.status || null, counted };
  });
  const counts = { real: votes.filter(vote => vote.verdict === 'real').length, false_positive: votes.filter(vote => vote.verdict === 'false_positive').length };
  const verdict = counts.real >= required ? 'real' : counts.false_positive >= required ? 'false_positive' : null;
  return { reached: Boolean(verdict), verdict, required, total: totalAgents, counts, votes, assessmentOnly: true, maySkipChallenge: false };
}

export async function investigate(session, choices, snapshot, options, ui, coordinator) {
  ui = debateEventUI(session, ui, choices);
  const pending = new Map(), reports = []; let next = 0;
  const concurrency = Math.min(session.contract.limits.concurrency, choices.length);
  ui.event('debate.phase', { phase: 'investigation', agents: choices, status: 'started' });
  while ((next < choices.length || pending.size) && !coordinator.stopping) {
    while (next < choices.length && pending.size < concurrency) {
      const index = next++, selection = choices[index];
      const job = startAssignment(session, { requestId: `investigate-${session.id}-${index}`, objective: session.goal.objective,
        context: `INDEPENDENT GOAL CHECK
Assess whether the ORIGINAL user goal was achieved, using the exact original objective and EVERY original acceptance criterion in the immutable mission brief and BZZY_SELECTED_MATERIAL.txt. Return finish_assignment with validationAssessment:{objective:<exact original goal>,achieved:true|false|null,criteria:[{id:<each exact original criterion ID>,achieved:true|false|null,rationale,evidence:[artifact UUIDs]}]}. These fields are internal model claims, never permission or verified completion. For each known criterion outcome cite actual evidence; missing proof stays null. Overall true requires every original criterion supported; false needs a grounded failed original criterion. A failed request or missing control alone does not prove the goal false. For vulnerability goals distinguish actual required impact/severity from merely finding a real lower-impact issue. For ordinary fact goals state the actual corrected answer when known.
Write report.summary as a concise natural-language explanation, usually 2–4 sentences. Explain the actual answer, evidence limits and any remaining uncertainty; do not print booleans, JSON, voting counts or protocol fields in the summary. Assess only the original requirements: if missing evidence prevents an original criterion from being assessed, mark that criterion and the overall assessment null; a grounded failed criterion supports false. Preserve informational limitations in uncertainties without changing a supported criterion solely because a limitation exists. Record actual unresolved challenges in objections. Set status complete when the assessment is finished (including a supported negative conclusion), inconclusive/partial when required evidence is missing. An uncertain assessment is never forced into a yes/no answer.
Read all original source evidence through read_artifact, paging until complete. Save decisive files/observations with record_evidence. In evidence arrays use only canonical artifact UUIDs returned by record_evidence or the importedEvidenceId returned by read_artifact, never filenames, criterion IDs, ledger IDs, labels or invented IDs. Nested criterion evidence must also appear in the report's top-level evidence array.
Do not inspect other agents' reports during this independent check. Useful bounded tests are allowed only by the inherited task policy and original declared scope; never contact unlisted targets or use unspecified accounts. If selected material contains only the goal, the scoped workspace is supplied material. Source edits remain isolated. Return your assessment to the supervisor without starting more agents or claiming parent completion.`,
        acceptanceCriteria: ['Report actual analysis and permitted tests, cite recorded evidence, and identify what remains unverified.'],
        limits: { runtimeSeconds: Math.min(options.runtimeSeconds || 300, session.contract.limits.assignmentSeconds || 300) } },
      { executor: selection, snapshot, role: 'executor', allowDebate: true, independent: true, sharedEvidence: session.reviewSource?.evidenceIds || [] });
      pending.set(index, job.id);
      ui.event('debate.phase', { phase: 'investigation', status: 'running', participantIndex: index, assignmentId: job.id });
    }
    for (const [index, id] of pending) {
      const job = assignmentStatus(id);
      if (['starting', 'running'].includes(job.round.state)) continue;
      const report = { protocol: 'tri-state-v1', participant: choices[index], assignmentId: id, round: job.currentRound, state: job.round.state, error: job.round.error || job.latestReport?.stopReason || null, report: job.latestReport?.report || null, artifacts: job.latestReport?.artifacts || [], usage: job.latestReport?.usage || { available: false } };
      reports[index] = report; pending.delete(index);
      ui.event('debate.message', { participant: choices[index].provider, participantIndex: index, role: 'independent assessment', phase: 'independent_check', round: 0, maxRounds: options.rounds || 5, assignmentId: id,
        state: report.state, error: report.error, text: formatInvestigation(report) });
    }
    const agents = reports.filter(Boolean).map(report => ({ ...report.participant, role: 'investigation', assignmentId: report.assignmentId, tokens: report.usage.tokens ?? null, available: Boolean(report.usage.available) }));
    coordinator.checkBudget(agents.reduce((sum, agent) => sum + (agent.tokens || 0), 0));
    if (next < choices.length || pending.size) await delay(100);
  }
  const bundle = path.join(snapshot.directory, 'BZZY_INVESTIGATION_EVIDENCE');
  if (fs.existsSync(bundle)) throw new Error('Reserved investigation evidence path already exists.');
  fs.mkdirSync(bundle, { mode: 0o700 });
  const evidenceIndex = []; let bytes = 0;
  for (const [index, report] of reports.entries()) {
    if (!report) continue;
    const entry = { ...report, artifacts: [] };
    for (const [number, reference] of report.artifacts.entries()) {
      const item = getRecord('artifact', reference.id);
      if (!item) throw new Error('Investigation artifact is missing from the evidence store.');
      if (bytes + item.size > 50 * 1024 * 1024) { entry.artifacts.push({ id: item.id, omitted: 'Evidence bundle limit reached; the original artifact remains available.' }); continue; }
      const info = fileInfo(item.path);
      if (info.sha256 !== item.sha256) throw new Error('Investigation artifact changed after recording.');
      const relative = `BZZY_INVESTIGATION_EVIDENCE/agent-${index + 1}-${number + 1}.txt`;
      fs.copyFileSync(item.path, path.join(snapshot.directory, relative));
      snapshot.manifest[relative] = { size: info.size, sha256: info.sha256 }; bytes += info.size;
      const imported = artifact(session, fs.readFileSync(item.path), `investigation:${report.participant.provider}:${item.label}`, item.mediaType);
      Object.assign(imported, { importedFrom: item.id, importedSha256: item.sha256,
        ...(item.source ? { source: item.source, sourceWorkspace: item.sourceWorkspace, sourceSha256: item.sourceSha256 } : {}) }); putRecord('artifact', imported.id, imported);
      entry.artifacts.push({ id: imported.id, originalId: item.id, path: relative, sha256: item.sha256, label: item.label });
    }
    if (entry.report?.validationAssessment) {
      const aliases = new Map(entry.artifacts.filter(item => !item.omitted).map(item => [item.originalId || item.id, item.id]));
      entry.report = { ...entry.report, evidence: entry.report.evidence.map(id => aliases.get(id) || id),
        validationAssessment: remapValidationAssessment(entry.report.validationAssessment, aliases) };
    }
    evidenceIndex.push(entry);
  }
  const indexPath = 'BZZY_INVESTIGATION_REPORTS.json', content = JSON.stringify(evidenceIndex, null, 2);
  fs.writeFileSync(path.join(snapshot.directory, indexPath), content, { mode: 0o600 });
  snapshot.manifest[indexPath] = { size: Buffer.byteLength(content), sha256: digest(content) };
  snapshot.manifestHash = digest(snapshot.manifest); putRecord('snapshot', snapshot.id, snapshot);
  const result = { protocol: 'tri-state-v1', sessionId: session.id, goalId: session.goal.id, sourceRevision: missionSourceRevision(session),
    reports: evidenceIndex, snapshotHash: snapshot.manifestHash, createdAt: now(), independent: true, testsAreAgentReported: true };
  putRecord('debate-investigation', session.id, result);
  ui.event('debate.phase', { phase: 'investigation', status: 'finished', snapshotHash: snapshot.manifestHash });
  return reports.filter(Boolean).map(report => ({ ...report.participant, role: 'investigation', assignmentId: report.assignmentId, tokens: report.usage.tokens ?? null, available: Boolean(report.usage.available) }));
}
