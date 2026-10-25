import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSession, saveSession } from '../src/engine/store.js';
import { getProvider } from '../src/engine/providers.js';
import { prepareTask } from '../src/engine/task.js';
import { newGoal } from '../src/engine/goals.js';
import { getRecord, putRecord } from '../src/engine/database.js';
import { captureEvidence, snapshotWorkspace } from '../src/engine/evidence.js';
import { startAssignment, recordWorkerReport } from '../src/engine/delegation.js';
import { taskTools, ToolHost } from '../src/engine/tools.js';
import { validateSchema, schemaErrors } from '../src/engine/contracts.js';
import { finalValidationReportProtocol, normalizeValidationDecision, validationDecisionSchema, requestedValidationSeverity } from '../src/engine/validation-decision.js';

const objective = 'Determine age from the supplied birth and observation dates.';
const criteria = [{ id: 'objective', description: objective }];
const statusFor = achieved => achieved === true ? 'supported' : achieved === false ? 'unsupported' : 'inconclusive';
const assessment = (achieved, evidence) => ({ objective, achieved, criteria: [{ id: 'objective', achieved, rationale: 'The supplied record establishes the available dates.', evidence }] });
const decision = (achieved, evidence) => ({ acceptedConclusions: [], rejectedClaims: [], corrections: [], remainingObjections: [], nextVerificationSteps: [],
  objectionDispositions: [], goalSatisfaction: statusFor(achieved), goalAssessment: { objective, rationale: 'The recorded dates were assessed against the original question.', evidence,
    criteria: [{ id: 'objective', status: statusFor(achieved), rationale: 'The criterion was assessed using the supplied dates.', evidence }] } });
const normalize = (value, achieved = true, evidence = [id]) => normalizeValidationDecision(value, { objective, criteria, evidence, validationAssessment: assessment(achieved, evidence) });
const id = '11111111-1111-1111-1111-111111111111';

test('final decisions retain supported, unsupported and inconclusive claims without coercing booleans or disposition aliases', () => {
  for (const achieved of [true, false, null]) assert.equal(normalize(decision(achieved, [id]), achieved).goalSatisfaction, statusFor(achieved));
  assert.equal(normalize(decision(null, []), null, []).goalSatisfaction, 'inconclusive');
  for (const value of [true, false, null, 'true', 1]) assert.throws(() => normalize({ ...decision(true, [id]), goalSatisfaction: value }), { code: 'INVALID_VALIDATION_DECISION' });
  const alias = decision(true, [id]); alias.objectionDispositions = [{ id: 'source-caveat', disposition: 'rejected', rationale: 'The caveat is nonblocking.', evidence: [id] }];
  assert.throws(() => normalize(alias), /use status, never disposition/);
  alias.objectionDispositions[0].status = 'rejected'; delete alias.objectionDispositions[0].disposition;
  assert.equal(normalize(alias).objectionDispositions[0].status, 'rejected');
});

test('final claim contracts reject contradictory, substituted, duplicate, oversized and out-of-report evidence', () => {
  const changes = [
    value => { value.goalSatisfaction = 'unsupported'; },
    value => { value.goalAssessment.objective = 'A different question.'; },
    value => { value.goalAssessment.criteria[0].status = 'unsupported'; },
    value => { value.goalAssessment.criteria.push(structuredClone(value.goalAssessment.criteria[0])); },
    value => { value.goalAssessment.evidence = [randomUUID()]; },
    value => { value.goalAssessment.criteria[0].evidence = [randomUUID()]; },
    value => { value.permissions = 'unrestricted'; },
    value => { value.goalAssessment.rationale = 'x'.repeat(2001); },
    value => { value.objectionDispositions = [{ id: 'caveat', status: 'resolved', rationale: 'Inspected.', evidence: [id] }, { id: 'caveat', status: 'rejected', rationale: 'Duplicated.', evidence: [id] }]; },
    value => { value.acceptedConclusions = [{ text: 'An untyped conclusion.' }]; },
  ];
  for (const edit of changes) { const value = decision(true, [id]); edit(value); assert.throws(() => normalize(value), { code: 'INVALID_VALIDATION_DECISION' }); }
});

test('requested severity requires a separate supported impact claim but permits truthful inconclusive reporting', () => {
  const requested = 'Find a real HIGH severity vulnerability.';
  assert.equal(requestedValidationSeverity(requested), 'high'); assert.equal(requestedValidationSeverity(objective), undefined);
  const validate = (value, achieved) => normalizeValidationDecision(value, { objective: requested, criteria, evidence: [id], validationAssessment: assessment(achieved, [id]) });
  const value = decision(true, [id]); value.goalAssessment.objective = requested;
  assert.throws(() => validate(value, true), /separate impact assessment/);
  value.goalAssessment.severity = { requested: 'high', assessed: 'low', rationale: 'The inspected impact is low; host acceptance must still reject HIGH.', evidence: [id] };
  assert.equal(validate(value, true).goalAssessment.severity.assessed, 'low');
  const unknown = decision(null, []); unknown.goalAssessment.objective = requested;
  assert.equal(validate(unknown, null).goalSatisfaction, 'inconclusive');
});

test('typed tool schema enum arrays cannot mutate the trusted decision parser', () => {
  const schema = validationDecisionSchema({ objective, criteria }); schema.properties.goalSatisfaction.enum.push(true);
  assert.throws(() => normalize({ ...decision(true, [id]), goalSatisfaction: true }), { code: 'INVALID_VALIDATION_DECISION' });
});

let directory, previous, parent, snapshot;
test.beforeEach(() => {
  previous = process.env.BZZY_HOME;
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-final-decision-'))); process.env.BZZY_HOME = path.join(directory, 'private');
  const workspace = path.join(directory, 'project'); fs.mkdirSync(workspace); fs.writeFileSync(path.join(workspace, 'record.txt'), 'Synthetic birth and observation dates.');
  parent = createSession(getProvider('codex'), workspace, 'offline-final-review'); prepareTask(parent, { mode: 'debate' }, objective);
  parent.goal = newGoal(objective); parent.contract.acceptanceCriteria = criteria; parent.contract.limits.concurrency = 4; saveSession(parent);
  snapshot = snapshotWorkspace(parent, 'final-review-contract');
});
test.afterEach(() => { if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous; fs.rmSync(directory, { recursive: true, force: true }); });

function actor({ final = true, spoof = false } = {}) {
  const selection = { provider: 'codex', model: 'offline-final-review' };
  const job = startAssignment(parent, { objective, context: 'Review original evidence and return the declared report.', acceptanceCriteria: [objective],
    policy: { mode: 'read-only', writablePaths: [] } }, { executor: selection, snapshot, role: 'reviewer', allowDebate: true, launch() {}, ...(final ? { reportProtocol: finalValidationReportProtocol } : {}) });
  const worker = createSession(getProvider('codex'), parent.cwd, selection.model);
  Object.assign(worker, { role: 'reviewer', parentSessionId: parent.id, assignmentId: job.id, assignmentRound: 1, missionContext: job.missionContext,
    contract: job.contract, policy: job.contract.policy, ...(spoof ? { reportProtocol: final ? 'generic' : finalValidationReportProtocol } : {}) }); saveSession(worker);
  putRecord('assignment', job.id, { ...getRecord('assignment', job.id), workerSessionId: worker.id, workspace: worker.cwd });
  return { worker, job, item: captureEvidence(worker, 'record.txt', 'supplied dates') };
}
const report = (actor, achieved = true) => ({ status: achieved === null ? 'inconclusive' : 'complete', summary: 'The supplied dates were assessed against the exact original age question.',
  evidence: [actor.item.id], validationAssessment: assessment(achieved, [actor.item.id]), decision: decision(achieved, [actor.item.id]) });

test('live final-review job requires typed claims and lets the same worker repair rejected reports before publication', async () => {
  const current = actor({ spoof: true }), host = new ToolHost(current.worker, {});
  const invalid = report(current); invalid.decision.goalSatisfaction = true;
  await assert.rejects(host.call('finish_assignment', invalid), /decision.goalSatisfaction must be the string/);
  assert.equal(getRecord('worker-report', current.worker.id), null);
  const alias = report(current); alias.decision.objectionDispositions = [{ id: 'caveat', disposition: 'rejected', rationale: 'Nonblocking evidence caveat.', evidence: [current.item.id] }];
  await assert.rejects(host.call('finish_assignment', alias), /use status, never disposition/);
  assert.equal(getRecord('worker-report', current.worker.id), null);
  for (const status of ['complete', 'partial', 'inconclusive']) {
    const missing = report(current); missing.status = status; delete missing.decision;
    await assert.rejects(host.call('finish_assignment', missing), /requires both validationAssessment and decision/);
    assert.equal(getRecord('worker-report', current.worker.id), null);
  }
  assert.equal(getRecord('assignment', current.job.id).currentRound, 1);
  await host.call('finish_assignment', report(current));
  assert.equal(getRecord('worker-report', current.worker.id).decision.goalSatisfaction, 'supported');
  assert.equal(getRecord('session', parent.id).goal.status, 'active', 'A recorded final claim never accepts the parent goal.');
});

test('final job schema derives from the host record and generic workers retain their existing report contract', () => {
  const final = actor({ spoof: true }), tool = taskTools(final.worker).find(item => item.name === 'finish_assignment');
  assert.deepEqual(tool.inputSchema.properties.decision.properties.goalSatisfaction.enum, ['supported', 'unsupported', 'inconclusive']);
  assert.deepEqual(tool.inputSchema.properties.decision.properties.objectionDispositions.items.properties.status.enum, ['accepted', 'resolved', 'rejected', 'unresolved']);
  assert.equal(tool.inputSchema.properties.decision.properties.goalAssessment.properties.objective.const, objective);
  assert.match(tool.description, /complete\/partial\/inconclusive reports require validationAssessment and the typed decision/);
  assert.doesNotThrow(() => validateSchema(tool.inputSchema));
  assert.deepEqual(schemaErrors(report(final), tool.inputSchema), []);
  assert.deepEqual(schemaErrors({ status: 'blocked', summary: 'The required source is unavailable.', evidence: [] }, tool.inputSchema), []);
  const generic = actor({ final: false, spoof: true }), genericTool = taskTools(generic.worker).find(item => item.name === 'finish_assignment');
  assert.deepEqual(genericTool.inputSchema.properties.decision, { type: 'object' });
  recordWorkerReport(generic.worker, { status: 'complete', summary: 'A generic bounded review claim remains supported.', evidence: [generic.item.id], decision: { applicationSpecific: true } });
  assert.equal(getRecord('worker-report', generic.worker.id).decision.applicationSpecific, true);
});

test('final review permits unsupported and inconclusive claims and blocked reports without fabricated support', () => {
  for (const achieved of [false, null]) {
    const current = actor(); recordWorkerReport(current.worker, report(current, achieved));
    assert.equal(getRecord('worker-report', current.worker.id).validationAssessment.achieved, achieved);
  }
  const blocked = actor(); recordWorkerReport(blocked.worker, { status: 'blocked', summary: 'The required source is unavailable within the existing permissions.', evidence: [] });
  assert.equal(getRecord('worker-report', blocked.worker.id).status, 'blocked');
  const needs = actor(); recordWorkerReport(needs.worker, { status: 'needs_context', summary: 'The assigned check needs a missing original date.', evidence: [], requestId: 'missing-original-date',
    questions: [{ id: 'date', question: 'Which supplied record contains the missing original observation date?' }] });
  assert.equal(getRecord('worker-report', needs.worker.id).status, 'needs_context');
});

test('untrusted assignment input cannot select a final protocol and internal protocol use requires the scoped reviewer', () => {
  const selection = { provider: 'codex', model: 'offline-final-review' };
  const input = { objective, context: 'A bounded generic task.', acceptanceCriteria: [objective], reportProtocol: finalValidationReportProtocol };
  const generic = startAssignment(parent, input, { executor: selection, snapshot, role: 'executor', allowDebate: true, launch() {} });
  assert.equal(generic.reportProtocol, undefined);
  for (const options of [{ role: 'executor', reportProtocol: finalValidationReportProtocol }, { role: 'reviewer', reportProtocol: 'unknown-protocol' }]) {
    assert.throws(() => startAssignment(parent, input, { executor: selection, snapshot, allowDebate: true, launch() {}, ...options }), /requires a host-created read-only Validate reviewer/);
  }
});
