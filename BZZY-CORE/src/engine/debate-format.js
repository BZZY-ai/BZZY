import fs from 'node:fs';
import { getRecord, listRecords, digest } from './database.js';
import { fileInfo, inside } from './evidence.js';

const describe = item => typeof item === 'string' ? item : item?.claim || item?.summary || item?.description || '';

const concise = value => String(value || '').replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000);

export function formatInvestigation(report) {
  const summary = typeof report?.report?.summary === 'string' ? report.report.summary.trim() : '';
  const state = report?.state || 'incomplete';
  const failed = !['awaiting_review', 'complete'].includes(state);
  if (!failed && summary) return summary;
  const message = summary
    ? `${summary}\nInvestigation ended: ${state}.`
    : `Investigation ended: ${state}. Evidence remains incomplete.`;
  const reason = concise(report?.error);
  return reason ? `${message}\nReason: ${reason}` : message;
}

const text = value => typeof value === 'string' && value.trim() && value.length <= 8000 && !/[\x00-\x08\x0b-\x1f\x7f]/.test(value);
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value);

// Append-only within a debate. A repeated ID with a changed claim gets another
// host ID, rather than replacing the original dissent. Identical points may
// share an ID, while every originating participant remains attributed.
export function accumulateDebateObjections(previous = [], reports = [], { phase = 'challenge', round = 0, consensus } = {}) {
  const entries = previous.map(item => structuredClone(item));
  const add = (entry, raw, index, kind = 'objection') => {
    const source = entry.assignmentId || `${entry.participant?.provider || 'agent'}:${index}`;
    const originalId = kind === 'objection' && validId(raw?.id) ? raw.id : `${kind}:${digest([source, raw]).slice(0, 20)}`;
    const claim = typeof raw === 'string' ? raw : raw?.claim;
    const invalid = !text(claim) || kind === 'objection' && !validId(raw?.id) || kind === 'malformed';
    const meaning = digest({ claim: claim || null, assumptions: raw?.assumptions || null, missingVerification: raw?.missingVerification || null });
    const same = entries.find(item => item.originalId === originalId && item.meaning === meaning);
    const alias = new Map((entry.artifacts || []).filter(item => !item.omitted).map(item => [item.originalId || item.id, item.id]));
    const evidence = (Array.isArray(raw?.evidence) ? raw.evidence : Array.isArray(entry.report?.evidence) ? entry.report.evidence : []).filter(id => typeof id === 'string').map(id => alias.get(id) || id);
    const origin = { assignmentId: entry.assignmentId || null, participant: entry.participant || null, phase, round };
    if (same) {
      if (!same.sources.some(item => digest(item) === digest(origin))) same.sources.push(origin);
      same.evidence = [...new Set([...same.evidence, ...evidence])]; same.lastRound = round; return;
    }
    const id = entries.some(item => item.id === originalId) ? `${originalId.slice(0, 105)}:${meaning.slice(0, 20)}` : originalId;
    entries.push({ id, originalId, claim: text(claim) ? claim.trim() : 'Malformed or missing assessment; the original report requires review.',
      kind, invalid: Boolean(invalid), meaning, evidence: [...new Set(evidence)], sources: [origin], firstRound: round, lastRound: round });
  };
  for (const [index, entry] of reports.entries()) {
    const report = entry.report;
    if (!report || !Array.isArray(report.objections) || !Array.isArray(report.uncertainties || [])) {
      add(entry, { claim: 'Missing or malformed participant assessment.' }, index, 'malformed'); continue;
    }
    for (const objection of report.objections) add(entry, objection, index);
    for (const uncertainty of report.uncertainties || []) add(entry, uncertainty, index, 'uncertainty');
    if (['partial', 'inconclusive'].includes(report.status) && !report.objections.length && !(report.uncertainties || []).length) {
      add(entry, { claim: `Participant explicitly returned ${report.status}: ${report.summary || 'The assessment is incomplete.'}`, evidence: report.evidence }, index, 'uncertainty');
    }
    if (phase === 'investigation' && consensus?.reached && report.verdict && report.verdict !== consensus.verdict) {
      add(entry, { claim: `Independent assessment differs from the ${consensus.verdict} majority: ${report.verdict}. ${report.summary || ''}`, evidence: report.evidence }, index, 'minority');
    }
    if (!['complete', 'partial', 'inconclusive'].includes(report.status)) add(entry, { claim: `Participant returned ${report.status || 'no status'}; the claim remains unassessed.` }, index, 'malformed');
  }
  return entries;
}

function inspectedEvidence(id, { sessionId, defenderSessionId, allowedArtifactIds = [], allowEmpty = false }) {
  const item = typeof id === 'string' && getRecord('artifact', id), allowed = new Set(allowedArtifactIds);
  if (!item || !sessionId || !defenderSessionId || !allowed.has(id)) return false;
  const defender = getRecord('session', defenderSessionId);
  if (!defender || defender.parentSessionId !== sessionId) return false;
  const source = item.importedFrom && getRecord('artifact', item.importedFrom);
  const owner = getRecord('session', item.sessionId);
  if (item.sessionId !== sessionId && item.sessionId !== defenderSessionId && owner?.parentSessionId !== sessionId) return false;
  try {
    if (fs.lstatSync(item.path).isSymbolicLink() || fileInfo(item.path).sha256 !== item.sha256) return false;
    if (source && (source.sha256 !== item.importedSha256 || fileInfo(source.path).sha256 !== source.sha256 || item.sha256 !== source.sha256)) return false;
    for (const tracked of [item, source].filter(Boolean)) if (tracked.source && tracked.sourceSha256 &&
      fileInfo(inside(tracked.sourceWorkspace, tracked.source)).sha256 !== tracked.sourceSha256) return false;
  } catch { return false; }
  return listRecords('artifact-read').some(read => read.sessionId === defenderSessionId &&
    (read.artifactId === item.id && read.sha256 === item.sha256 || source && read.artifactId === source.id && read.sha256 === source.sha256) &&
    (read.bytesRead > 0 && read.nextOffset > (read.offset || 0) || allowEmpty && item.size === 0 && read.offset === 0 && read.nextOffset === 0 && read.bytesRead === 0));
}

export function assessDebateEvidenceCoverage(ids, evidenceContext = {}) {
  const missing = [], partial = [], reviewed = [];
  const receipts = listRecords('artifact-read').filter(read => read.sessionId === evidenceContext.defenderSessionId && read.bytesRead > 0);
  for (const id of [...new Set(ids)]) {
    const item = getRecord('artifact', id);
    if (!item || !inspectedEvidence(id, { ...evidenceContext, allowEmpty: true })) { missing.push(id); continue; }
    const ranges = receipts.filter(read => read.artifactId === id && read.sha256 === item.sha256 && Number.isSafeInteger(read.offset) && Number.isSafeInteger(read.nextOffset) && read.offset >= 0 && read.nextOffset > read.offset)
      .map(read => [read.offset, Math.min(item.size, read.nextOffset)]).sort((a, b) => a[0] - b[0]);
    let through = 0;
    for (const [start, end] of ranges) { if (start > through) break; through = Math.max(through, end); }
    if (through >= item.size) reviewed.push(id); else partial.push({ id, reviewedThrough: through, bytes: item.size });
  }
  return { complete: missing.length === 0 && partial.length === 0, reviewed, missing, partial };
}

export function assessDebateGoal(session, decision, evidenceContext = {}) {
  const reported = decision?.goalSatisfaction, assessment = decision?.goalAssessment, reasons = [];
  const objective = session.reviewSource?.objective || session.goal?.objective;
  if (!['supported', 'unsupported', 'inconclusive'].includes(reported)) reasons.push('Original goal satisfaction was not assessed.');
  if (!assessment || assessment.objective !== objective || !text(assessment.rationale)) reasons.push('The exact original goal and its rationale require review.');
  const validEvidence = ids => Array.isArray(ids) && ids.length > 0 && ids.length <= 32 && ids.every(id => inspectedEvidence(id, evidenceContext));
  if (!validEvidence(assessment?.evidence)) reasons.push('Original goal assessment lacks scoped, intact, inspected evidence.');
  const criteria = Array.isArray(assessment?.criteria) ? assessment.criteria : [], requirements = session.contract?.acceptanceCriteria || [];
  if (criteria.some(item => !requirements.some(requirement => requirement.id === item?.id))) reasons.push('Goal assessment contains an unknown acceptance criterion.');
  for (const requirement of requirements) {
    const matches = criteria.filter(item => item?.id === requirement.id), item = matches[0];
    if (matches.length !== 1 || item.status !== 'supported' || !text(item.rationale) || !validEvidence(item.evidence)) reasons.push(`Original acceptance criterion ${requirement.id} is not supported by inspected evidence.`);
  }
  const requestedSeverity = /\b(critical|high|medium|low)\b(?=[\s\S]{0,48}\b(?:severity|vulnerabilit\w*|finding|security\s+issue|impact)\b)/i.exec(objective || '')?.[1]?.toLowerCase();
  if (requestedSeverity) {
    const severity = assessment?.severity, ranks = { low: 1, medium: 2, high: 3, critical: 4 };
    if (!severity || typeof severity.requested !== 'string' || severity.requested.toLowerCase() !== requestedSeverity || typeof severity.assessed !== 'string' || !(ranks[severity.assessed.toLowerCase()] >= ranks[requestedSeverity]) ||
        !text(severity.rationale) || !validEvidence(severity.evidence)) reasons.push(`Requested ${requestedSeverity} severity is not supported by a separate impact assessment.`);
  }
  return { passed: reported === 'supported' && reasons.length === 0, goalSatisfaction: reported === 'unsupported' ? 'unsupported' : reported === 'supported' && !reasons.length ? 'supported' : 'inconclusive',
    reasons, assessment: assessment || null, inspectedEvidence: [...new Set([...(Array.isArray(assessment?.evidence) ? assessment.evidence : []), ...criteria.flatMap(item => Array.isArray(item?.evidence) ? item.evidence : []), ...(Array.isArray(assessment?.severity?.evidence) ? assessment.severity.evidence : [])])],
    semanticVerification: 'not-automated' };
}

export function assessObjectionDispositions(reports, decision, evidenceContext = {}) {
  const ledger = reports.every(item => item && typeof item.id === 'string' && 'claim' in item)
    ? reports : accumulateDebateObjections([], reports);
  const ids = ledger.map(item => item.id), dispositions = Array.isArray(decision?.objectionDispositions) ? decision.objectionDispositions : [];
  const missing = [], invalid = [], unresolved = [];
  const arrays = ['acceptedConclusions', 'rejectedClaims', 'corrections', 'remainingObjections', 'nextVerificationSteps', 'objectionDispositions'];
  if (!decision || arrays.some(key => !Array.isArray(decision[key]) || decision[key].length > 128) ||
      arrays.slice(0, -1).some(key => (decision?.[key] || []).some(item => !text(describe(item))))) invalid.push('Malformed main-agent decision.');
  for (const item of dispositions) if (!item || !ids.includes(item.id)) invalid.push('Unknown objection disposition.');
  for (const objection of ledger) {
    const matches = dispositions.filter(item => item?.id === objection.id), item = matches[0];
    if (!matches.length) { missing.push(objection.id); unresolved.push(`${objection.id}: no main-agent disposition`); continue; }
    if (matches.length !== 1 || !['accepted', 'resolved', 'rejected', 'unresolved'].includes(item.status) || !text(item.rationale) || !Array.isArray(item.evidence) || item.evidence.length > 32) {
      invalid.push(objection.id); unresolved.push(`${objection.id}: malformed disposition`); continue;
    }
    if (objection.invalid) { invalid.push(objection.id); unresolved.push(`${objection.id}: original assessment requires review`); continue; }
    if (item.status === 'unresolved') { unresolved.push(objection.id); continue; }
    if (!item.evidence.length || item.evidence.some(id => !inspectedEvidence(id, evidenceContext))) {
      invalid.push(objection.id); unresolved.push(`${objection.id}: disposition lacks scoped, intact evidence actually inspected by the main agent`);
    }
  }
  unresolved.push(...(Array.isArray(decision?.remainingObjections) ? decision.remainingObjections.map(describe).filter(Boolean) : []));
  return { complete: missing.length === 0 && invalid.length === 0, objectionCount: ids.length, missing, invalid: invalid.length,
    invalidReasons: invalid, unresolved: [...new Set(unresolved)], evidenceValidated: missing.length === 0 && invalid.length === 0,
    semanticVerification: 'not-automated' };
}

export function formatPosition(report) {
  if (!report) return 'No complete report was returned; this assessment remains unresolved.';
  const objections = (Array.isArray(report.objections) ? report.objections : []).map(item => typeof item === 'string' ? item : `${item?.id || 'objection'}: ${describe(item)}`);
  return [report.summary, report.position, ...objections.map(item => '• ' + item)].filter(Boolean).join('\n');
}

export function formatDecision(decision, unresolved = []) {
  if (!decision) return 'No final decision was returned. Review the partial evidence before continuing.';
  const lines = [];
  for (const [key, label] of [['acceptedConclusions', 'Supported'], ['rejectedClaims', 'Rejected'], ['corrections', 'Corrections'], ['remainingObjections', 'Unresolved'], ['nextVerificationSteps', 'Next verification']]) {
    const entries = Array.isArray(decision[key]) ? decision[key] : [];
    const items = key === 'remainingObjections' ? [...new Set([...entries.map(describe), ...unresolved.map(describe)])] : entries.map(describe);
    if (items.length) lines.push(`${label}:`, ...items.map(item => `• ${item}`));
  }
  return lines.join('\n') || 'No additional conclusions or verification steps were recorded.';
}
