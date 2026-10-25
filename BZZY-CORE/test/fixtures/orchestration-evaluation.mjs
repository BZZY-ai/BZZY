// Offline orchestration actors. These adapters never launch a provider process;
// Core still owns the actual protocol, mission records, artifacts and receipts.
import fs from 'node:fs';
import path from 'node:path';
import { createSession, saveSession } from '../../src/engine/store.js';
import { getRecord, putRecord, now } from '../../src/engine/database.js';
import { artifact, captureEvidence } from '../../src/engine/evidence.js';
import { home } from '../../src/engine/files.js';
import { BUILTINS } from '../../src/engine/providers.js';
import { ToolHost } from '../../src/engine/tools.js';
import * as delegation from '../../src/engine/delegation.js';

export function debateEvaluationActors(parent, { scenario = 'complete', selectedArtifact } = {}) {
  const activity = { starts: [], followups: [], waits: 0, reports: [], decisions: [], finishes: [], mutated: false };
  const noLaunch = () => {};
  class Coordinator {
    constructor(session) { this.session = session; this.tokenOffset = 0; this.stopping = null; this.abort = new AbortController(); }
    start() { this.session.executionState = 'running'; this.session.goal.status = 'active'; saveSession(this.session); }
    checkBudget(tokens) {
      if (this.session.goal.tokenBudget != null && tokens >= this.session.goal.tokenBudget) { this.stopping = 'token_limit'; this.abort.abort(); }
      return !this.stopping;
    }
    async finish(requested, record, usage, { afterAssessment } = {}) {
      let status = this.stopping === 'token_limit' ? 'budget_limited' : requested;
      if (status === 'complete') {
        const { assessDebateCompletion } = await import('../../src/engine/verification.js');
        this.session.acceptance = await assessDebateCompletion(this.session, record, { signal: this.abort.signal });
        if (!this.session.acceptance.passed) status = 'awaiting_review';
      }
      if (afterAssessment && !this.stopping) {
        const checked = await afterAssessment(record, status);
        if (checked?.status === 'awaiting_review' && status === 'complete') status = 'awaiting_review';
      }
      if (this.stopping) status = this.stopping === 'token_limit' ? 'budget_limited' : this.stopping === 'cancelled' ? 'cancelled' : 'paused';
      Object.assign(this.session.goal, { status, reason: this.stopping || record.stopReason || null });
      this.session.executionState = 'idle'; this.session.summary = { usage }; saveSession(this.session);
      activity.finishes.push({ requested, status, record });
      return status === 'complete' ? 0 : 2;
    }
  }

  function childFor(job, snapshot) {
    const work = path.join(home(), 'evaluation-workers', job.id);
    fs.mkdirSync(path.dirname(work), { recursive: true }); fs.cpSync(snapshot.directory, work, { recursive: true });
    const child = createSession(BUILTINS.codex, work, job.selection.model);
    Object.assign(child, { role: job.role, parentSessionId: parent.id, projectRoot: parent.projectRoot, projectId: parent.projectId,
      assignmentId: job.id, assignmentRound: job.currentRound, allowedArtifactIds: job.sharedEvidence || [],
      missionContext: job.missionContext, contract: job.contract, policy: job.contract.policy });
    saveSession(child); putRecord('assignment', job.id, { ...job, workerSessionId: child.id, workspace: work });
    return child;
  }

  function startAssignment(session, input, options) {
    const job = delegation.startAssignment(session, input, { ...options, launch: noLaunch });
    childFor(job, options.snapshot); activity.starts.push({ id: job.id, requestId: input.requestId, role: options.role }); return delegation.assignmentStatus(job.id);
  }
  function followupAssignment(session, id, input, options) {
    const result = delegation.followupAssignment(session, id, input, { ...options, launch: noLaunch });
    const job = getRecord('assignment', id), child = getRecord('session', job.workerSessionId);
    Object.assign(child, { assignmentRound: result.round, allowedArtifactIds: job.sharedEvidence || [], missionContext: job.missionContext }); saveSession(child);
    activity.followups.push({ id, input }); return result;
  }

  async function waitAssignment(_parentId, id) {
    activity.waits++;
    const job = delegation.assignmentStatus(id);
    if (job.round.state === 'awaiting_review') return { terminal: true, round: job.round };
    const child = getRecord('session', job.workerSessionId), isMain = activity.starts.find(item => item.id === id).requestId.startsWith('debate-main-');
    const own = captureEvidence(child, 'observations.json', 'synthetic offline participant record');
    const objection = { id: 'ownership-control', claim: 'The foreign-object disclosure must be compared with the owned negative control.', evidence: [own.id] };
    const report = { status: 'complete', summary: 'The supplied synthetic records were assessed without network access.', evidence: [own.id],
      objections: isMain ? [] : [objection], uncertainties: [], conclusions: ['The fixture is a synthetic ownership observation.'], position: 'Preserve the original goal and evidence.' };
    if (isMain) {
      const ledger = getRecord('debate-objections', parent.id)?.entries || [], evidence = [selectedArtifact.id];
      const inspect = scenario !== 'unsupported_resolution';
      if (inspect) await new ToolHost(child, { event() {} }).call('read_artifact', { id: selectedArtifact.id });
      // The wrong-severity actor overclaims success deliberately. The host must
      // reject its LOW impact for the original HIGH goal even when every actor
      // labels the goal and its criteria "supported".
      report.goalSatisfaction = scenario === 'minority' ? 'inconclusive' : 'supported';
      report.decision = {
        acceptedConclusions: [scenario === 'wrong_severity' ? 'A real low-impact observation is supported; HIGH severity is not established.' : 'The synthetic observation is supported within the declared goal.'],
        rejectedClaims: [], corrections: [], remainingObjections: [], nextVerificationSteps: [],
        objectionDispositions: ledger.map(item => ({ id: item.id, status: scenario === 'minority' ? 'unresolved' : 'resolved',
          rationale: scenario === 'unsupported_resolution' ? 'The majority agreed.' : 'The bounded fixture controls were compared with the cited original evidence.',
          evidence: inspect ? evidence : [] })),
        goalSatisfaction: report.goalSatisfaction,
        goalAssessment: { objective: parent.reviewSource?.objective || parent.goal.objective,
          rationale: scenario === 'wrong_severity' ? 'The observed effect is low impact; the original HIGH impact requirement is unsupported.' : 'The complete original objective and its declared criteria were compared with the offline fixture.',
          evidence, criteria: parent.contract.acceptanceCriteria.map(item => ({ id: item.id,
            status: report.goalSatisfaction,
            rationale: 'The supplied offline fixture defines the limits of this assessment.', evidence })),
          ...(scenario === 'wrong_severity' ? { severity: { requested: 'high', assessed: 'low',
            rationale: 'The synthetic observation demonstrates only a low-impact private field; the requested HIGH impact is unsupported.', evidence } } : {}) },
      };
      activity.decisions.push(report.decision);
      if (scenario === 'stale_source' && job.currentRound > 1 && !activity.mutated) {
        fs.writeFileSync(path.join(parent.cwd, 'observations.json'), '{"scope":"changed after main-agent evidence inspection"}'); activity.mutated = true;
      }
      if (scenario === 'changed_source_goal' && job.currentRound > 1 && !activity.mutated) {
        const source = getRecord('session', parent.reviewSource.sessionId);
        source.contract.context += ' The owner supplied a new required control after the review began.';
        saveSession(source); activity.mutated = true;
      }
    }
    delegation.recordWorkerReport(child, report);
    const result = { assignmentId: id, round: job.currentRound, state: 'awaiting_review', report,
      artifacts: [own], changes: [], summary: report.summary, workerClaim: report.status, usage: { tokens: 2 * job.currentRound, available: true }, finishedAt: now() };
    putRecord('round', `${id}:${job.currentRound}`, { ...job.round, ...result });
    putRecord('assignment', id, { ...getRecord('assignment', id), latestReport: result }); activity.reports.push(result);
    return { terminal: true, round: result };
  }

  async function investigate(session, choices, snapshot) {
    const reports = choices.map((participant, index) => {
      const minority = scenario === 'minority' && index === choices.length - 1;
      const job = delegation.startAssignment(session, { requestId: `offline-investigation-${index}`, objective: session.goal.objective,
        context: 'Independently classify the supplied synthetic records. No tools or network are executed by this fixture.',
        acceptanceCriteria: ['Preserve the supplied positive/negative controls and uncertainty.'] },
      { executor: participant, snapshot, role: 'executor', allowDebate: true, independent: true, launch: noLaunch });
      const worker = childFor(job, snapshot), item = captureEvidence(worker, 'observations.json', `independent fixture observation ${index + 1}`);
      const report = { status: 'complete', verdict: scenario === 'minority' && !minority ? 'false_positive' : 'real',
        summary: minority ? 'A minority counterexample preserves the real foreign-object disclosure despite two misleading votes.' : 'The offline observation was independently classified.',
        evidence: [item.id], uncertainties: [], objections: minority ? [{ id: 'minority-counterexample', claim: 'A foreign-object private field is disclosed in the counterexample.', evidence: [item.id] }] : [] };
      delegation.recordWorkerReport(worker, report);
      const result = { round: 1, state: 'awaiting_review', report, changes: [], artifacts: [item], usage: { tokens: 2, available: true } };
      putRecord('round', `${job.id}:1`, { ...getRecord('round', `${job.id}:1`), ...result });
      putRecord('assignment', job.id, { ...getRecord('assignment', job.id), latestReport: result });
      const copied = artifact(session, fs.readFileSync(item.path), `preserved independent fixture ${index + 1}`);
      Object.assign(copied, { importedFrom: item.id, importedSha256: item.sha256, source: item.source, sourceWorkspace: item.sourceWorkspace, sourceSha256: item.sourceSha256 });
      putRecord('artifact', copied.id, copied);
      return { participant, assignmentId: job.id, state: 'awaiting_review', report, artifacts: [{ id: copied.id, originalId: item.id, sha256: copied.sha256 }], usage: { tokens: 2, available: true } };
    });
    // The selected material is part of the same permitted evidence set.
    for (const report of reports) report.artifacts.push({ id: selectedArtifact.id, originalId: selectedArtifact.id, sha256: selectedArtifact.sha256 });
    putRecord('debate-investigation', parent.id, { reports, snapshotHash: snapshot.manifestHash, independent: true, testsAreAgentReported: true, createdAt: now() });
    return reports.map(item => ({ ...item.participant, tokens: 2, available: true }));
  }

  return { activity, dependencies: { Coordinator, startAssignment, followupAssignment, waitAssignment, assignmentStatus: delegation.assignmentStatus, investigate } };
}
