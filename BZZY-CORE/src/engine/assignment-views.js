import { database } from './database.js';
import { assignmentFilter, assignmentParameters } from './delegation-usage.js';

// Model-facing views stay small; durable records and the local API retain the
// full result. The supervisor opens decisive evidence or the report artifact.
const text = (value, limit = 1500) => typeof value === 'string' ? value.slice(0, limit) : undefined;
const list = (value, count = 8, limit = 320) => Array.isArray(value) ? value.slice(0, count).map(item => text(item, limit)).filter(value => value !== undefined) : [];
const clean = value => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
export function compactAssignmentContextRequest(request) {
  if (!request) return null;
  return clean({ id: request.id, revision: request.revision, state: request.state, round: request.round,
    sourceGoalId: request.sourceGoalId, sourceGoalRevision: request.sourceGoalRevision,
    questions: (request.questions || []).slice(0, 6).map(question => clean({ id: question.id, question: text(question.question, 1000), reason: text(question.reason, 320) })),
    answers: (request.answers || []).slice(0, 6).map(answer => ({ questionId: answer.questionId, text: text(answer.text, 1000), evidence: list(answer.evidence, 16, 80) })),
    rationale: text(request.rationale, 700) });
}

function limitedValue(value, depth = 0) {
  if (typeof value === 'string') return value.slice(0, 320);
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (depth >= 2) return '[Open the full report artifact for this detail.]';
  if (Array.isArray(value)) return value.slice(0, 6).map(item => limitedValue(item, depth + 1));
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 8).map(([key, item]) => [key.slice(0, 80), limitedValue(item, depth + 1)]));
  return undefined;
}

function smallObject(value, limit = 1000) {
  const projected = limitedValue(value), encoded = JSON.stringify(projected);
  return encoded?.length > limit ? { preview: encoded.slice(0, limit - 80), truncated: true } : projected;
}

function compactReport(report) {
  if (!report) return null;
  return clean({ status: text(report.status, 32), summary: text(report.summary), evidence: list(report.evidence, 16, 80),
    contextRequestId: text(report.contextRequestId, 80),
    questions: Array.isArray(report.questions) ? report.questions.slice(0, 6).map(question => ({ id: question.id, question: text(question.question, 1000), reason: text(question.reason, 320) })) : undefined,
    nextSteps: list(report.nextSteps, 4, 240), uncertainties: list(report.uncertainties, 4, 240), conclusions: list(report.conclusions, 4, 240),
    objections: Array.isArray(report.objections) ? report.objections.slice(0, 4).map(item => smallObject(item, 800)) : undefined,
    position: text(report.position, 640), changedBecause: text(report.changedBecause, 640), decision: smallObject(report.decision, 1200) });
}

export function compactAssignmentRound(round) {
  if (!round) return null;
  const artifacts = Array.isArray(round.artifacts) ? round.artifacts : [];
  const decisive = new Set([...(round.report?.evidence || []), round.reportArtifactId].filter(Boolean));
  const ordered = [...artifacts.filter(item => decisive.has(item.id)), ...artifacts.filter(item => !decisive.has(item.id))];
  const selected = ordered.slice(0, 16), changes = Array.isArray(round.changes) ? round.changes : [];
  const report = compactReport(round.report);
  return clean({ assignmentId: text(round.assignmentId, 80), round: round.round ?? round.number, number: round.number,
    state: text(round.state, 40), stopReason: text(round.stopReason, 320), reason: text(round.reason, 640), error: text(round.error, 640),
    workerClaim: text(round.workerClaim, 40), summary: text(round.summary || round.report?.summary), report,
    contextRequest: compactAssignmentContextRequest(round.contextRequest),
    reportArtifactId: text(round.reportArtifactId, 80), missingReport: round.missingReport,
    artifacts: selected.map(item => clean({ id: text(item.id, 80), label: text(item.label, 160), size: item.size, sha256: text(item.sha256, 80) })),
    artifactCount: artifacts.length, omittedArtifacts: Math.max(0, artifacts.length - selected.length),
    changes: changes.slice(0, 12).map(item => clean({ path: text(item.path, 320), before: item.before ? { size: item.before.size, sha256: text(item.before.sha256, 80) } : null,
      after: item.after ? { size: item.after.size, sha256: text(item.after.sha256, 80) } : null })),
    changeCount: changes.length, omittedChanges: Math.max(0, changes.length - 12),
    usage: round.usage ? clean({ tokens: round.usage.tokens, available: round.usage.available, elapsedSeconds: round.usage.elapsedSeconds,
      estimatedConversationCostUsd: round.usage.estimatedConversationCostUsd, source: text(round.usage.source, 80) }) : null,
    exitCode: round.exitCode, startedAt: text(round.startedAt, 40), finishedAt: text(round.finishedAt, 40),
    fullReport: round.reportArtifactId ? 'Use read_artifact with reportArtifactId and bounded offset/limit for the full report and manifest.' : undefined });
}

export function compactAssignmentStatus(job) {
  return clean({ id: job.id, closure: text(job.closure, 40), currentRound: job.currentRound, workspace: text(job.workspace, 640),
    contextRequest: compactAssignmentContextRequest(job.contextRequest),
    selection: job.selection ? clean({ provider: text(job.selection.provider, 80), model: text(job.selection.model, 160), effort: text(job.selection.effort, 40) }) : undefined,
    round: compactAssignmentRound(job.round || job.latestReport) });
}

export function compactAssignmentWait(result) {
  return { id: result.id, round: compactAssignmentRound(result.round), closure: result.closure, terminal: result.terminal };
}

export function compactAssignmentContext(job) {
  const round = job.round || job.latestReport;
  return clean({ id: job.id, closure: text(job.closure, 40), currentRound: job.currentRound,
    contextRequest: compactAssignmentContextRequest(job.contextRequest),
    state: text(round?.state, 40), workerClaim: text(round?.workerClaim, 40), summary: text(round?.summary || round?.report?.summary, 700),
    evidence: list(round?.report?.evidence, 4, 80), reportArtifactId: text(round?.reportArtifactId, 80),
    tokens: round?.usage?.tokens, reportRound: round?.round ?? round?.number, reportAvailable: Boolean(round?.reportArtifactId || round?.workerClaim || round?.summary),
    next: 'Use assignment_status with this ID for the latest bounded status; read_artifact opens full evidence and reports.' });
}

export function assignmentContextPage(session, { offset = 0, limit = 12, prioritizeOpen = false, includeMoreIds = false } = {}) {
  const db = database(), filter = assignmentFilter(session, 'a.data'), parameters = assignmentParameters(session);
  const joined = `FROM records a LEFT JOIN records r ON r.kind='round' AND r.id=a.id || ':' || json_extract(a.data,'$.currentRound') WHERE a.kind='assignment' AND ${filter}`;
  const state = `coalesce(json_extract(r.data,'$.state'),json_extract(a.data,'$.latestReport.state'))`;
  const order = `${prioritizeOpen ? `CASE WHEN ${state} IN ('starting','running') THEN 0 WHEN json_extract(a.data,'$.closure')='open' THEN 1 ELSE 2 END,` : ''} a.updated_at DESC,a.id`;
  const stats = db.prepare(`SELECT count(*) AS total, sum(json_extract(a.data,'$.closure')='open') AS open FROM records a WHERE a.kind='assignment' AND ${filter}`).get(...parameters);
  // Extract only the bounded fields the model sees. In particular, do not load
  // every old report/patch into JavaScript just to list a handful of IDs.
  const rows = db.prepare(`SELECT a.id, json_extract(a.data,'$.closure') AS closure, json_extract(a.data,'$.currentRound') AS currentRound,
    json_extract(a.data,'$.contextRequest') AS contextRequest,
    ${state} AS state, coalesce(json_extract(r.data,'$.round'),json_extract(a.data,'$.latestReport.round')) AS reportRound,
    coalesce(json_extract(r.data,'$.workerClaim'),json_extract(a.data,'$.latestReport.workerClaim')) AS workerClaim,
    substr(coalesce(json_extract(r.data,'$.summary'),json_extract(r.data,'$.error'),json_extract(r.data,'$.reason'),json_extract(a.data,'$.latestReport.summary'),''),1,700) AS summary,
    coalesce(json_extract(r.data,'$.reportArtifactId'),json_extract(a.data,'$.latestReport.reportArtifactId')) AS reportArtifactId,
    coalesce(json_extract(r.data,'$.usage.tokens'),json_extract(a.data,'$.latestReport.usage.tokens')) AS tokens,
    (SELECT json_group_array(value) FROM (SELECT value FROM json_each(coalesce(json_extract(r.data,'$.report.evidence'),json_extract(a.data,'$.latestReport.report.evidence'),'[]')) LIMIT 4)) AS evidence
    ${joined} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...parameters, limit, offset);
  const items = rows.map(row => compactAssignmentContext({ id: row.id, closure: row.closure, currentRound: row.currentRound,
    contextRequest: row.contextRequest ? JSON.parse(row.contextRequest) : null,
    round: { state: row.state, round: row.reportRound, workerClaim: row.workerClaim, summary: row.summary, reportArtifactId: row.reportArtifactId,
      usage: { tokens: row.tokens }, report: { evidence: JSON.parse(row.evidence || '[]') } } }));
  const moreIds = includeMoreIds ? db.prepare(`SELECT a.id ${joined} ORDER BY ${order} LIMIT 32 OFFSET ?`).all(...parameters, offset + rows.length).map(row => row.id) : undefined;
  return clean({ items, total: stats.total, open: stats.open || 0, nextOffset: offset + rows.length < stats.total ? offset + rows.length : null, moreIds });
}
