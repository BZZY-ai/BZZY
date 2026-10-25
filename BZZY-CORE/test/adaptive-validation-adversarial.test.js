import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSession, saveSession, loadSession } from '../src/engine/store.js';
import { getProvider } from '../src/engine/providers.js';
import { prepareTask } from '../src/engine/task.js';
import { newGoal } from '../src/engine/goals.js';
import { captureEvidence } from '../src/engine/evidence.js';
import { getRecord, putRecord, removeRecord, appendEvent } from '../src/engine/database.js';
import { prepareChatDebate } from '../src/engine/chat-debate.js';
import { runDebate } from '../src/engine/debate.js';
import { goalValidationFor } from '../src/engine/goal-validation.js';
import { assessAdaptiveValidationProtocol, assessDebateCompletion } from '../src/engine/verification.js';
import { debateEvaluationActors } from './fixtures/orchestration-evaluation.mjs';

let directory, workspace, previous;
test.beforeEach(() => {
  previous = process.env.BZZY_HOME;
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-adaptive-adversarial-')));
  process.env.BZZY_HOME = path.join(directory, 'private');
  workspace = path.join(directory, 'project'); fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'observations.json'), JSON.stringify({ positive: 'synthetic field disclosed', negative: 'owned control denied' }));
});
test.afterEach(() => {
  if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
  fs.rmSync(directory, { recursive: true, force: true });
});

async function evaluate(scenario = 'complete', { count = 2, retries = 1, contextWindows = [], budget, mutateInvestigation, mutateFinalReport, objective } = {}) {
  const source = createSession(getProvider('codex'), workspace, 'offline-source');
  prepareTask(source, { mode: 'solo' }, objective || 'Assess the supplied synthetic controls.'); source.goal = newGoal(source.contract.objective);
  source.contract.limits.maxRetries = retries; saveSession(source);
  appendEvent(source.id, 'message.user', { text: source.goal.objective, kind: 'goal' });
  source.goal.evidence = [captureEvidence(source, 'observations.json', 'original control').id]; source.goal.status = 'complete'; saveSession(source);
  appendEvent(source.id, 'text', { text: 'Original goal was reported achieved.' });
  const selected = Array.from({ length: count }, (_, index) => ({ provider: 'codex', model: `independent-${index}`, effort: 'default',
    ...(contextWindows[index] ? { capabilities: { contextWindow: contextWindows[index] } } : {}) }));
  const prepared = prepareChatDebate(source, '', [], { debateAgents: selected, rounds: 1 });
  if (budget) { prepared.session.goal.tokenBudget = budget; saveSession(prepared.session); }
  const actors = debateEvaluationActors(prepared.session, { scenario, selectedArtifact: getRecord('artifact', prepared.session.reviewSource.evidenceIds[0]) });
  if (mutateInvestigation) {
    const original = actors.dependencies.investigate;
    actors.dependencies.investigate = async (...args) => {
      const usage = await original(...args), investigation = getRecord('debate-investigation', prepared.session.id);
      mutateInvestigation(investigation, prepared.session);
      putRecord('debate-investigation', prepared.session.id, investigation); return usage;
    };
  }
  if (mutateFinalReport) {
    const original = actors.dependencies.waitAssignment;
    actors.dependencies.waitAssignment = async (...args) => {
      const result = await original(...args), job = getRecord('assignment', args[1]);
      if (job.contract.context.startsWith('FINAL GOAL REVIEW')) {
        const round = getRecord('round', `${job.id}:${job.currentRound}`);
        mutateFinalReport(round.report); putRecord('round', `${job.id}:${job.currentRound}`, round);
        job.latestReport.report = structuredClone(round.report); putRecord('assignment', job.id, job);
      }
      return result;
    };
  }
  await runDebate(prepared.session, prepared.options, { event() {} }, actors.dependencies);
  return { source, review: loadSession(prepared.session.id), result: getRecord('debate', prepared.session.id), activity: actors.activity };
}

function amendReport(entry, edit) {
  edit(entry.report);
  const job = getRecord('assignment', entry.assignmentId), round = getRecord('round', `${job.id}:${job.currentRound}`);
  round.report = structuredClone(entry.report); putRecord('round', `${job.id}:${job.currentRound}`, round);
  job.latestReport.report = structuredClone(entry.report); putRecord('assignment', job.id, job);
}

const sourceLimitation = 'The supplied observations were not compared with an external source; the original criteria concern only the supplied controls.';

test('supported criteria with informational caveats go directly to a fresh reviewer who must disposition those caveats', async () => {
  const run = await evaluate('complete', { mutateInvestigation(investigation) {
    for (const entry of investigation.reports) amendReport(entry, report => { report.uncertainties = [sourceLimitation]; });
  } });
  assert.equal(run.result.agreement.agreeTrue, true); assert.equal(run.activity.followups.length, 0);
  assert.equal(run.activity.starts.length, 1); assert.ok(run.result.protocol.finalReviewer);
  assert.equal(run.result.objectionLedger.length, 2); assert.ok(run.result.objectionLedger.every(item => item.kind === 'uncertainty' && item.claim === sourceLimitation));
  assert.equal(run.result.objectionReview.complete, true); assert.equal(run.result.decision.objectionDispositions.length, 2);
  assert.equal(run.review.acceptance.passed, true); assert.equal(goalValidationFor(run.source.id).state, 'validated');
});

test('informational caveats cannot turn an explicitly missing original criterion into a supported assessment', async () => {
  const run = await evaluate('complete', { retries: 0, mutateInvestigation(investigation) {
    amendReport(investigation.reports[1], report => {
      report.validationAssessment.achieved = null; report.validationAssessment.criteria[0].achieved = null;
      report.validationAssessment.criteria[0].rationale = 'The original required negative control remains unavailable.';
      report.uncertainties = [sourceLimitation];
    });
  } });
  assert.equal(run.result.agreement.counts.true, 1); assert.equal(run.result.agreement.counts.null, 1); assert.equal(run.result.agreement.counts.invalid, 0);
  assert.equal(run.activity.starts.length, 0); assert.equal(run.activity.followups.length, 0);
  assert.notEqual(goalValidationFor(run.source.id).state, 'validated');
});

test('actual unresolved objections still block acceptance even when every structured criterion claims support', async () => {
  const run = await evaluate('complete', { retries: 0, mutateInvestigation(investigation) {
    amendReport(investigation.reports[1], report => { report.objections = [{ id: 'missing-required-control', claim: 'The required negative control has not been reconciled with the original conclusion.', evidence: report.evidence }]; });
  } });
  assert.equal(run.result.agreement.agreeTrue, false); assert.equal(run.result.agreement.participants[1].reportedAchieved, true);
  assert.equal(run.result.agreement.participants[1].achieved, null); assert.equal(run.activity.starts.length, 0);
  assert.ok(run.result.objectionLedger.some(item => item.originalId === 'missing-required-control'));
  assert.notEqual(goalValidationFor(run.source.id).state, 'validated');
});

test('a final reviewer cannot silently omit informational caveats from the persistent evidence review', async () => {
  const run = await evaluate('complete', { mutateInvestigation(investigation) {
    for (const entry of investigation.reports) amendReport(entry, report => { report.uncertainties = [sourceLimitation]; });
  }, mutateFinalReport(report) { report.decision.objectionDispositions = []; } });
  assert.equal(run.result.agreement.agreeTrue, true); assert.equal(run.activity.starts.length, 1);
  assert.equal(run.result.objectionReview.complete, false); assert.equal(run.result.objectionReview.missing.length, 2);
  assert.equal(run.result.assessment.passed, false); assert.notEqual(goalValidationFor(run.source.id).state, 'validated');
});

test('small final-review context or remaining token budget stops before any final provider dispatch', async () => {
  for (const limits of [{ contextWindows: [1024] }, { budget: 1000 }]) {
    const run = await evaluate('complete', limits);
    assert.equal(run.result.agreement.agreeTrue, true);
    assert.equal(run.activity.starts.length, 0); assert.equal(run.activity.followups.length, 0);
    assert.equal(run.result.validationPolicy.reason, 'missing_evidence');
    assert.equal(run.result.stopReason, 'input_budget');
    assert.notEqual(run.review.goal.status, 'complete'); assert.notEqual(goalValidationFor(run.source.id).state, 'validated');
    assert.equal(run.result.usage.totalTokens, 4);
  }
});

test('a small uncertain-worker context prevents private followup dispatch without truncating its own evidence', async () => {
  const run = await evaluate('null_resolved', { count: 3, contextWindows: [200000, 200000, 1024] });
  assert.equal(run.activity.followups.length, 0); assert.equal(run.activity.starts.length, 0);
  assert.equal(run.result.agreement.counts.null, 1); assert.equal(run.result.protocol.followups.length, 1);
  assert.equal(run.result.protocol.followups[0].participantIndex, 2);
  assert.equal(run.result.protocol.followups[0].reason, 'input_budget');
  assert.notEqual(goalValidationFor(run.source.id).state, 'validated');
});

test('a malformed false report remains uncertainty and cannot mint a rejection receipt', async () => {
  const run = await evaluate('one_false', { count: 3, retries: 0, mutateInvestigation(investigation) {
    const entry = investigation.reports[2], job = getRecord('assignment', entry.assignmentId);
    entry.report.validationAssessment.criteria[0].evidence = [];
    const round = getRecord('round', `${job.id}:1`); round.report = structuredClone(entry.report); putRecord('round', `${job.id}:1`, round);
    job.latestReport.report = structuredClone(entry.report); putRecord('assignment', job.id, job);
  } });
  assert.equal(run.result.agreement.counts.true, 2); assert.equal(run.result.agreement.counts.false, 0);
  assert.equal(run.result.agreement.counts.null, 1); assert.equal(run.result.agreement.participants[2].valid, false);
  assert.equal(run.activity.starts.length, 0); assert.equal(run.activity.followups.length, 0);
  assert.equal(run.result.validationPolicy.outcome, 'inconclusive');
  assert.notEqual(goalValidationFor(run.source.id).reason, 'agent_dissent');
});

test('a valid negative check stops before uncertain peers receive additional paid work', async () => {
  const run = await evaluate('one_false', { count: 3, mutateInvestigation(investigation) {
    const entry = investigation.reports[0], job = getRecord('assignment', entry.assignmentId);
    entry.report.validationAssessment.achieved = null;
    entry.report.validationAssessment.criteria.forEach(item => { item.achieved = null; });
    const round = getRecord('round', `${job.id}:1`); round.report = structuredClone(entry.report); putRecord('round', `${job.id}:1`, round);
    job.latestReport.report = structuredClone(entry.report); putRecord('assignment', job.id, job);
  } });
  assert.equal(run.result.agreement.counts.false, 1); assert.equal(run.result.agreement.counts.null, 1);
  assert.equal(run.activity.followups.length, 0); assert.equal(run.activity.starts.length, 0);
  assert.equal(run.result.validationPolicy.outcome, 'rejected'); assert.equal(goalValidationFor(run.source.id).reason, 'agent_dissent');
});

test('fresh final review still cannot accept uninspected original evidence or mismatched requested severity', async () => {
  for (const scenario of ['unsupported_resolution', 'wrong_severity']) {
    const run = await evaluate(scenario, { objective: 'Find a real HIGH severity vulnerability in the supplied synthetic controls.' });
    assert.equal(run.result.agreement.agreeTrue, true); assert.equal(run.activity.starts.length, 1);
    assert.notEqual(run.review.goal.status, 'complete'); assert.notEqual(goalValidationFor(run.source.id).state, 'validated');
    assert.equal(run.result.assessment.passed, false);
    const receipt = await assessDebateCompletion(run.review, run.result); assert.equal(receipt.passed, false);
  }
});

test('tampered initial and current independent report bindings cannot retain a checked direct protocol', async () => {
  const run = await evaluate('complete'); assert.equal(run.review.goal.status, 'complete');
  const forged = structuredClone(run.result);
  forged.protocol.initialInvestigation.reports[0].report.validationAssessment.achieved = false;
  assert.equal(assessAdaptiveValidationProtocol(run.review, forged).passed, false);
  const job = getRecord('assignment', run.result.protocol.finalAssignments[0].assignmentId);
  const round = getRecord('round', `${job.id}:${job.currentRound}`);
  round.report.summary = 'The worker report was changed after host acceptance.'; putRecord('round', `${job.id}:${job.currentRound}`, round);
  assert.equal(assessAdaptiveValidationProtocol(run.review, run.result).passed, false);
  assert.notEqual(goalValidationFor(run.source.id).state, 'validated');
});

test('a rejection receipt must retain its checked evidence rather than trusting an empty substituted manifest', async () => {
  const run = await evaluate('one_false', { count: 3 });
  assert.equal(goalValidationFor(run.source.id).reason, 'agent_dissent');
  const policy = getRecord('core.validation.policy', run.result.validationPolicy.receiptId); assert.ok(policy.evidence.length);
  putRecord('core.validation.policy', policy.id, { ...policy, evidence: [] });
  assert.notEqual(goalValidationFor(run.source.id).reason, 'agent_dissent');
});

test('one intact negative assessment remains decisive with an unavailable peer, while deleting its own worker invalidates the receipt', async () => {
  const run = await evaluate('one_false', { count: 3, mutateInvestigation(investigation) {
    const peer = getRecord('assignment', investigation.reports[0].assignmentId); removeRecord('session', peer.workerSessionId);
  } });
  assert.equal(run.result.agreement.counts.false, 1); assert.equal(run.result.agreement.counts.null, 1);
  assert.equal(run.activity.starts.length, 0); assert.equal(run.activity.followups.length, 0);
  assert.equal(goalValidationFor(run.source.id).reason, 'agent_dissent');
  const dissent = run.result.agreement.participants.find(item => item.achieved === false);
  removeRecord('session', dissent.workerSessionId);
  assert.notEqual(goalValidationFor(run.source.id).reason, 'agent_dissent');
  assert.notEqual(goalValidationFor(run.source.id).state, 'validated');
});

test('changing the final reviewer report after acceptance cannot retain a validated source badge', async () => {
  const run = await evaluate('complete'); assert.equal(goalValidationFor(run.source.id).state, 'validated');
  const pin = run.result.protocol.finalReviewer, round = getRecord('round', `${pin.assignmentId}:${pin.round}`);
  round.report.validationAssessment.achieved = false;
  round.report.validationAssessment.criteria[0].achieved = false;
  putRecord('round', `${pin.assignmentId}:${pin.round}`, round);
  assert.equal(assessAdaptiveValidationProtocol(run.review, run.result).passed, false);
  assert.notEqual(goalValidationFor(run.source.id).state, 'validated');
});
