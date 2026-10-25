import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSession, saveSession } from '../src/engine/store.js';
import { getProvider } from '../src/engine/providers.js';
import { getRecord, putRecord, listRecords } from '../src/engine/database.js';
import { prepareTask } from '../src/engine/task.js';
import { newGoal } from '../src/engine/goals.js';
import { captureEvidence, artifact, snapshotWorkspace } from '../src/engine/evidence.js';
import { startAssignment, followupAssignment, recordWorkerReport } from '../src/engine/delegation.js';
import { missionSourceRevision } from '../src/engine/mission-context.js';
import { normalizeValidationAssessment } from '../src/engine/validation-assessment.js';
import { assessValidationAgreement } from '../src/engine/investigation.js';
import { formatValidationAssessment, formatInvestigation } from '../src/engine/debate-format.js';
import { taskTools } from '../src/engine/tools.js';

let directory, workspace, previousHome, parent, snapshot;
const objective = 'Determine the person’s age from the supplied birth and observation dates.';
const criteria = [{ id: 'correct-age', description: 'Calculate the correct age.' }, { id: 'source-record', description: 'Support the answer with the supplied record.' }];
test.beforeEach(() => {
  previousHome = process.env.BZZY_HOME; directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-tristate-')));
  process.env.BZZY_HOME = path.join(directory, 'private'); workspace = path.join(directory, 'project'); fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'age.json'), JSON.stringify({ birthDate: '1990-05-14', asOf: '2026-05-14', age: 36 }));
  parent = createSession(getProvider('codex'), workspace, 'offline-age-check'); prepareTask(parent, { mode: 'debate' }, objective);
  parent.goal = newGoal(objective); parent.contract.acceptanceCriteria = criteria;
  parent.contract.limits = { ...parent.contract.limits, concurrency: 3, maxAssignments: 12, maxRetries: 2 }; saveSession(parent);
  snapshot = snapshotWorkspace(parent, 'offline-validation');
});
test.afterEach(() => {
  if (previousHome === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previousHome;
  fs.rmSync(directory, { recursive: true, force: true });
});
const assessment = (achieved, evidence) => ({ objective, achieved, criteria: criteria.map((item, index) => ({ id: item.id,
  achieved: index === 0 ? achieved : true, rationale: 'The supplied dated record establishes this observation.', evidence })) });
const envelope = reports => ({ protocol: 'tri-state-v1', sessionId: parent.id, goalId: parent.goal.id,
  sourceRevision: missionSourceRevision(parent), independent: true, reports });
const agreement = reports => assessValidationAgreement(envelope(reports), reports.length, { sessionId: parent.id });
function newWorker(index) {
  const selection = { provider: 'codex', model: 'same-offline-model', effort: 'default' };
  const job = startAssignment(parent, { requestId: 'independent-age-' + index, objective, context: 'INDEPENDENT GOAL CHECK. Use only the supplied dates.',
    acceptanceCriteria: ['Assess the original goal, preserving missing evidence.'] }, { executor: selection, snapshot, role: 'executor', allowDebate: true, independent: true, launch() {} });
  const cwd = path.join(directory, 'worker-' + index); fs.cpSync(snapshot.directory, cwd, { recursive: true });
  const worker = createSession(getProvider('codex'), cwd, selection.model);
  Object.assign(worker, { parentSessionId: parent.id, assignmentId: job.id, assignmentRound: 1, role: 'executor',
    missionContext: job.missionContext, contract: job.contract, policy: job.contract.policy, projectRoot: workspace }); saveSession(worker);
  putRecord('assignment', job.id, { ...getRecord('assignment', job.id), workerSessionId: worker.id, workspace: cwd });
  return { jobId: job.id, worker, selection };
}
function publish(actor, achieved, extra = {}) {
  const item = captureEvidence(actor.worker, 'age.json', 'dated-age-source');
  const report = { status: achieved === null ? 'inconclusive' : 'complete',
    summary: achieved === true ? 'The supplied dates establish that the person is 36 years old. Both the birth date and observation date are available.'
      : achieved === false ? 'The requested age is not supported. The supplied record establishes a different answer.'
        : 'The available evidence does not settle the requested age. The missing date needs to be checked.',
    evidence: [item.id], validationAssessment: assessment(achieved, [item.id]), objections: [], uncertainties: [], verdict: 'real', ...extra };
  recordWorkerReport(actor.worker, report);
  const bound = getRecord('worker-report', actor.worker.id), job = getRecord('assignment', actor.jobId);
  const round = { ...getRecord('round', `${job.id}:${job.currentRound}`), state: 'awaiting_review', round: job.currentRound,
    report: bound, artifacts: [item], usage: { tokens: 20, available: true } };
  putRecord('round', `${job.id}:${job.currentRound}`, round); putRecord('assignment', job.id, { ...job, latestReport: round });
  const copy = artifact(parent, fs.readFileSync(item.path), 'preserved-age-source');
  Object.assign(copy, { importedFrom: item.id, importedSha256: item.sha256, source: item.source, sourceWorkspace: item.sourceWorkspace, sourceSha256: item.sourceSha256 }); putRecord('artifact', copy.id, copy);
  return { protocol: 'tri-state-v1', participant: actor.selection, assignmentId: job.id, round: job.currentRound, state: 'awaiting_review', report: bound,
    artifacts: [{ id: copy.id, originalId: item.id, sha256: copy.sha256 }] };
}

test('the report protocol accepts native true/false/null and rejects coerced, contradictory or incomplete original-goal claims', () => {
  const id = '11111111-1111-1111-1111-111111111111';
  for (const value of [true, false, null]) assert.equal(normalizeValidationAssessment(assessment(value, [id]), { objective, criteria, evidence: [id] }).achieved, value);
  for (const value of ['true', 'false', 1, 0, {}, undefined]) assert.throws(() => normalizeValidationAssessment(assessment(value, [id]), { objective, criteria, evidence: [id] }), { code: 'INVALID_VALIDATION_ASSESSMENT' });
  for (const value of [
    { ...assessment(true, [id]), objective: 'An easier substituted objective.' },
    { ...assessment(true, [id]), criteria: [] },
    { ...assessment(true, [id]), criteria: [assessment(true, [id]).criteria[0], assessment(true, [id]).criteria[0]] },
    { ...assessment(true, [id]), achieved: false },
    { ...assessment(false, [id]), achieved: true },
    { ...assessment(true, [id]), permissions: 'unlimited' },
    { ...assessment(true, [id]), criteria: assessment(true, [id]).criteria.map(item => ({ ...item, evidence: ['22222222-2222-2222-2222-222222222222'] })) },
  ]) assert.throws(() => normalizeValidationAssessment(value, { objective, criteria, evidence: [id] }), { code: 'INVALID_VALIDATION_ASSESSMENT' });
});

test('two independent supported reports agree provisionally without completing the parent or requiring different models', () => {
  const a = publish(newWorker(0), true), b = publish(newWorker(1), true), result = agreement([a, b]);
  assert.equal(result.agreeTrue, true); assert.equal(result.hasFalse, false); assert.equal(result.hasNull, false);
  assert.equal(result.counts.true, 2); assert.notEqual(result.participants[0].workerSessionId, result.participants[1].workerSessionId);
  assert.ok(result.participants.every(item => item.evidence.every(id => getRecord('artifact', id).sessionId === parent.id)));
  const canonical = [a, b].map(entry => {
    const alias = new Map(entry.artifacts.map(item => [item.originalId, item.id]));
    return { ...entry, report: { ...entry.report, evidence: entry.report.evidence.map(id => alias.get(id)), validationAssessment: {
      ...entry.report.validationAssessment, criteria: entry.report.validationAssessment.criteria.map(item => ({ ...item, evidence: item.evidence.map(id => alias.get(id)) })),
    } } };
  });
  assert.equal(agreement(canonical).agreeTrue, true, 'published bundle aliases preserve the same canonical assessment');
  assert.equal(getRecord('session', parent.id).goal.status, 'active'); assert.equal(listRecords('execution').length, 0);
});

test('one grounded false defeats two true claims while a missing or malformed report stays null', () => {
  const reports = [publish(newWorker(0), true), publish(newWorker(1), true), publish(newWorker(2), false)];
  const result = agreement(reports); assert.equal(result.hasFalse, true); assert.equal(result.agreeTrue, false); assert.deepEqual(result.counts, { true: 2, false: 1, null: 0, invalid: 0 });
  const malformed = structuredClone(reports); malformed[2].report.validationAssessment.achieved = 'false';
  const unknown = agreement(malformed); assert.equal(unknown.hasFalse, false); assert.equal(unknown.hasNull, true); assert.equal(unknown.participants[2].achieved, null);
});

test('informational limitations do not override supported original criteria, while legacy votes remain unknown', () => {
  const first = publish(newWorker(0), true), second = publish(newWorker(1), true, { uncertainties: ['The supplied observation date was not checked against an external source; both original criteria concern the supplied record.'] });
  const result = agreement([first, second]); assert.equal(result.agreeTrue, true); assert.equal(result.hasNull, false);
  assert.equal(result.participants[1].reportedAchieved, true); assert.equal(result.participants[1].achieved, true);
  assert.ok(second.report.uncertainties.length, 'The limitation stays in the bound report for final evidence review.');
  const legacy = structuredClone(first); delete legacy.report.validationAssessment;
  assert.equal(agreement([legacy, second]).participants[0].achieved, null); assert.equal(agreement([legacy, second]).hasFalse, false);
});

test('an unresolved original-criterion objection still prevents a true claim from advancing to final review', () => {
  const first = publish(newWorker(0), true), second = publish(newWorker(1), true, {
    objections: [{ id: 'unverified-source-record', claim: 'The required supplied source record has not been reconciled with the answer.' }],
  });
  const result = agreement([first, second]); assert.equal(result.agreeTrue, false); assert.equal(result.hasNull, true);
  assert.equal(result.participants[1].reportedAchieved, true); assert.equal(result.participants[1].achieved, null);
  assert.match(result.participants[1].reason, /unresolved objections/);
});

test('duplicated workers, foreign evidence, changed bytes and source instructions cannot count as agreement', () => {
  const reports = [publish(newWorker(0), true), publish(newWorker(1), true)];
  assert.equal(agreement([reports[0], reports[0]]).agreeTrue, false);
  const foreign = structuredClone(reports); foreign[1].artifacts = reports[0].artifacts;
  assert.equal(agreement(foreign).participants[1].achieved, null);
  const tampered = getRecord('artifact', reports[1].artifacts[0].id); fs.writeFileSync(tampered.path, 'Changed preserved bytes.');
  assert.equal(agreement(reports).participants[1].achieved, null);
  const original = envelope(reports); parent.contract.constraints.push('Changed original scope.'); saveSession(parent);
  assert.equal(assessValidationAgreement(original, 2, { sessionId: parent.id }).agreeTrue, false);
});

test('a targeted private follow-up reuses the independent worker and validates its fresh round rather than its old null', () => {
  const a = newWorker(0), b = newWorker(1), first = publish(a, true), uncertain = publish(b, null);
  assert.equal(agreement([first, uncertain]).hasNull, true);
  followupAssignment(parent, b.jobId, { requestId: 'only-missing-date', objective, feedback: 'INDEPENDENT GOAL CHECK. Resolve your own missing date; no other report is supplied.' }, { launch() {} });
  const next = getRecord('assignment', b.jobId); b.worker.assignmentRound = next.currentRound; b.worker.missionContext = next.missionContext; saveSession(b.worker);
  const completed = publish(b, true); assert.equal(completed.round, 2);
  assert.equal(agreement([first, completed]).agreeTrue, true); assert.equal(agreement([first, uncertain]).agreeTrue, false);
});

test('optional structured reports are validated before persistence and schema exposes internal booleans without rendering them', () => {
  const actor = newWorker(0), item = captureEvidence(actor.worker, 'age.json');
  assert.throws(() => recordWorkerReport(actor.worker, { status: 'complete', summary: 'true', evidence: [item.id], validationAssessment: assessment(true, [item.id]) }), { code: 'INVALID_VALIDATION_ASSESSMENT' });
  assert.equal(getRecord('worker-report', actor.worker.id), null);
  const tool = taskTools(actor.worker).find(item => item.name === 'finish_assignment');
  assert.deepEqual(tool.inputSchema.properties.validationAssessment.properties.achieved.enum, [true, false, null]);
  const entry = publish(actor, true), body = formatValidationAssessment(entry);
  assert.match(body, /36 years old/); assert.doesNotMatch(body, /achieved|true|false|validationAssessment|criteria|\{/);
  assert.doesNotMatch(formatInvestigation({ protocol: 'tri-state-v1', state: 'awaiting_review', report: { summary: '{"achieved":true}' } }), /awaiting_review|achieved|true|\{/);
});
