import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSession, saveSession } from '../src/engine/store.js';
import { BUILTINS } from '../src/engine/providers.js';
import { artifact } from '../src/engine/evidence.js';
import { ToolHost } from '../src/engine/tools.js';
import { accumulateDebateObjections, assessObjectionDispositions } from '../src/engine/debate-format.js';

let directory, previousHome, parent, reviewer, host, source, originalId, evidenceContext;
const objective = 'Calculate age using the supplied birth and observation dates.';
const caveat = 'The supplied birth date has no external citation; the original criterion only requires the supplied-date calculation.';

test.beforeEach(() => {
  previousHome = process.env.BZZY_HOME;
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-tri-state-objections-')));
  process.env.BZZY_HOME = path.join(directory, 'private');
  const workspace = path.join(directory, 'project'); fs.mkdirSync(workspace);
  parent = createSession(BUILTINS.codex, workspace); parent.policy = { mode: 'read-only' }; saveSession(parent);
  source = artifact(parent, 'Synthetic dates and their deterministic age calculation.', 'supplied-date calculation');
  originalId = randomUUID();
  reviewer = createSession(BUILTINS.codex, workspace);
  Object.assign(reviewer, { role: 'reviewer', parentSessionId: parent.id, allowedArtifactIds: [source.id], policy: parent.policy });
  saveSession(reviewer); host = new ToolHost(reviewer, {});
  evidenceContext = { sessionId: parent.id, defenderSessionId: reviewer.id, allowedArtifactIds: [source.id] };
});
test.afterEach(() => {
  if (previousHome === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previousHome;
  fs.rmSync(directory, { recursive: true, force: true });
});

function entry() {
  return { protocol: 'tri-state-v1', assignmentId: randomUUID(), participant: { provider: 'codex', model: 'offline-fixture' },
    state: 'awaiting_review', round: 1, artifacts: [{ id: source.id, originalId }], report: {
      status: 'complete', summary: 'The answer gives the correct age for the supplied dates.', evidence: [originalId],
      validationAssessment: { objective, achieved: true, criteria: [{ id: 'objective', achieved: true,
        rationale: 'The date calculation reproduces the recorded answer.', evidence: [originalId] }] },
      uncertainties: [caveat],
    } };
}
const decision = dispositions => ({ acceptedConclusions: [], rejectedClaims: [], corrections: [], remainingObjections: [],
  nextVerificationSteps: [], objectionDispositions: dispositions });

test('valid structured reports may omit empty concern arrays without fabricating malformed assessments', () => {
  for (const protocol of ['tri-state-v1', undefined]) {
    const report = entry(); if (protocol === undefined) delete report.protocol;
    delete report.report.uncertainties;
    const original = structuredClone(report);
    assert.deepEqual(accumulateDebateObjections([], [report], { phase: 'investigation' }), []);
    assert.deepEqual(report, original, 'ledger projection does not rewrite the durable worker claim');
  }
});

test('omitted objections preserve each independent caveat and still require an inspected evidence disposition', async () => {
  const reports = [entry(), entry()], original = structuredClone(reports);
  const ledger = accumulateDebateObjections([], reports, { phase: 'investigation' });
  assert.equal(ledger.length, 2); assert.notEqual(ledger[0].id, ledger[1].id);
  assert.ok(ledger.every(item => item.kind === 'uncertainty' && item.claim === caveat && item.invalid === false));
  assert.deepEqual(ledger.map(item => item.evidence), [[source.id], [source.id]]);
  assert.deepEqual(ledger.map(item => item.sources[0].assignmentId), reports.map(item => item.assignmentId));
  assert.deepEqual(reports, original);
  assert.equal(assessObjectionDispositions(ledger, decision([]), evidenceContext).complete, false);
  const dispositions = ledger.map(item => ({ id: item.id, status: 'resolved',
    rationale: 'The supplied-date criterion is supported; an external citation was not required.', evidence: [source.id] }));
  assert.equal(assessObjectionDispositions(ledger, decision(dispositions), evidenceContext).complete, false);
  await host.call('read_artifact', { id: source.id });
  const checked = assessObjectionDispositions(ledger, decision(dispositions), evidenceContext);
  assert.equal(checked.complete, true); assert.deepEqual(checked.unresolved, []);
});

test('supplied malformed concern fields remain invalid even when the structured assessment is supported', () => {
  for (const field of ['objections', 'uncertainties']) for (const value of [null, false, 0, '', {}, 'missing']) {
    const report = entry(); report.report[field] = value;
    const ledger = accumulateDebateObjections([], [report], { phase: 'investigation' });
    assert.ok(ledger.some(item => item.kind === 'malformed' && item.invalid), `${field}=${JSON.stringify(value)} cannot disappear`);
    assert.equal(assessObjectionDispositions(ledger, decision([]), evidenceContext).complete, false);
  }
});

test('missing or malformed structured assessments cannot use the optional-array exemption', () => {
  const changes = [
    report => { delete report.validationAssessment; },
    report => { report.validationAssessment = null; },
    report => { report.validationAssessment.achieved = 'true'; },
    report => { report.validationAssessment.criteria = []; },
    report => { report.validationAssessment.criteria[0].achieved = false; },
    report => { report.validationAssessment.criteria[0].evidence = [randomUUID()]; },
    report => { report.validationAssessment.extra = 'unreviewed field'; },
    report => { report.summary = 'true'; },
  ];
  for (const change of changes) {
    const report = entry(); change(report.report);
    for (const suppliedEmptyArray of [false, true]) {
      if (suppliedEmptyArray) report.report.objections = [];
      const ledger = accumulateDebateObjections([], [report], { phase: 'investigation' });
      assert.ok(ledger.some(item => item.kind === 'malformed' && item.invalid));
    }
  }
});

test('legacy missing objections remain malformed, while actual objections and append-only history survive', () => {
  const legacy = entry(); delete legacy.protocol; delete legacy.report.validationAssessment;
  assert.ok(accumulateDebateObjections([], [legacy]).some(item => item.kind === 'malformed' && item.invalid));
  const structured = entry(); structured.report.objections = [{ id: 'missing-control', claim: 'The original control has not been demonstrated.', evidence: [originalId] }];
  const ledger = accumulateDebateObjections([], [structured], { phase: 'investigation' });
  assert.ok(ledger.some(item => item.id === 'missing-control' && item.kind === 'objection'));
  assert.ok(ledger.some(item => item.kind === 'uncertainty' && item.claim === caveat));
  const revised = entry(); delete revised.report.uncertainties;
  assert.deepEqual(accumulateDebateObjections(ledger, [revised]), ledger, 'a cleaner later report cannot erase earlier dissent');
  assert.ok(assessObjectionDispositions(ledger, decision([]), evidenceContext).missing.includes('missing-control'));
});
