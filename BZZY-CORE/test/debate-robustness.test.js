import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSession, saveSession } from '../src/engine/store.js';
import { BUILTINS } from '../src/engine/providers.js';
import { artifact, captureEvidence } from '../src/engine/evidence.js';
import { database, putRecord, listRecords } from '../src/engine/database.js';
import { ToolHost } from '../src/engine/tools.js';
import { accumulateDebateObjections, assessObjectionDispositions, assessDebateGoal, assessDebateEvidenceCoverage, formatDecision, formatPosition } from '../src/engine/debate-format.js';
import { investigationConsensus, investigationReadiness } from '../src/engine/investigation.js';

let directory, previous, parent, defender, host, evidenceContext;
test.beforeEach(() => {
  previous = process.env.BZZY_HOME; directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-debate-robust-')));
  process.env.BZZY_HOME = path.join(directory, 'private');
  const workspace = path.join(directory, 'project'); fs.mkdirSync(workspace); fs.writeFileSync(path.join(workspace, 'control.txt'), 'Synthetic positive and negative controls.');
  parent = createSession(BUILTINS.codex, workspace); parent.policy = { mode: 'read-only' };
  parent.goal = { id: randomUUID(), objective: 'Find a real HIGH severity vulnerability.' };
  parent.contract = { acceptanceCriteria: [{ id: 'impact', description: 'Demonstrate high severity and reliable controls.' }] }; saveSession(parent);
  defender = createSession(BUILTINS.codex, workspace); Object.assign(defender, { role: 'reviewer', parentSessionId: parent.id, projectRoot: workspace, policy: parent.policy }); saveSession(defender);
  host = new ToolHost(defender, {}); evidenceContext = { sessionId: parent.id, defenderSessionId: defender.id, allowedArtifactIds: [] };
});
test.afterEach(() => { if (previous == null) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous; fs.rmSync(directory, { recursive: true, force: true }); });
const report = (id = 'control', claim = 'The account control must be checked.') => [{ assignmentId: 'challenger-one', report: { status: 'complete', objections: [{ id, claim }], uncertainties: [] } }];
const decision = dispositions => ({ acceptedConclusions: [], rejectedClaims: [], corrections: [], remainingObjections: [], nextVerificationSteps: [], objectionDispositions: dispositions });
const disposition = (evidence, extra = {}) => ({ id: 'control', status: 'resolved', rationale: 'The independently recorded control was opened and compared.', evidence, ...extra });
async function inspected() {
  const item = captureEvidence(defender, 'control.txt', 'synthetic-control');
  await host.call('read_artifact', { id: item.id }); evidenceContext.allowedArtifactIds.push(item.id); return item;
}

test('a resolved objection needs a reason and scoped evidence that the main agent actually opened', async () => {
  const item = captureEvidence(defender, 'control.txt'); evidenceContext.allowedArtifactIds.push(item.id);
  assert.equal(assessObjectionDispositions(report(), decision([disposition([item.id])]), evidenceContext).complete, false);
  await host.call('read_artifact', { id: item.id });
  assert.equal(assessObjectionDispositions(report(), decision([disposition([item.id])]), evidenceContext).complete, true);
  assert.equal(assessObjectionDispositions(report(), decision([disposition([item.id])])).complete, false);
  for (const entries of [[disposition([item.id], { rationale: ' ' })], [disposition([])], [disposition([item.id]), disposition([item.id])], [disposition([item.id]), disposition([item.id], { id: 'invented' })]]) {
    assert.equal(assessObjectionDispositions(report(), decision(entries), evidenceContext).complete, false);
  }
});

test('unresolved, malformed and missing dispositions never silently erase dissent', () => {
  const unresolved = assessObjectionDispositions(report(), decision([disposition([], { status: 'unresolved' })]), evidenceContext);
  assert.equal(unresolved.complete, true); assert.deepEqual(unresolved.unresolved, ['control']);
  assert.equal(assessObjectionDispositions(report(), decision([]), evidenceContext).complete, false);
  const malformed = accumulateDebateObjections([], [{ assignmentId: 'missing', report: { status: 'complete', objections: null } }]);
  assert.ok(malformed[0].invalid);
  assert.equal(assessObjectionDispositions(malformed, decision([{ ...disposition([], { status: 'unresolved' }), id: malformed[0].id }]), evidenceContext).complete, false);
  assert.doesNotThrow(() => formatPosition({ objections: { invalid: true }, summary: 'Partial report.' }));
  assert.doesNotThrow(() => formatDecision({ acceptedConclusions: 'invalid', remainingObjections: null }));
});

test('artifact tampering, stale tracked inputs and foreign-session evidence invalidate claimed resolutions', async () => {
  const item = await inspected(); fs.writeFileSync(item.path, 'Changed immutable bytes.');
  assert.equal(assessObjectionDispositions(report(), decision([disposition([item.id])]), evidenceContext).complete, false);
  const current = await inspected(); fs.writeFileSync(path.join(defender.cwd, 'control.txt'), 'A different control version.');
  assert.equal(assessObjectionDispositions(report(), decision([disposition([current.id])]), evidenceContext).complete, false);
  const outsider = createSession(BUILTINS.codex, defender.cwd); outsider.policy = { mode: 'read-only' }; saveSession(outsider);
  const foreign = artifact(outsider, 'An unrelated private assessment.', 'unrelated'); evidenceContext.allowedArtifactIds.push(foreign.id);
  putRecord('artifact-read', 'forged-fixture', { sessionId: defender.id, artifactId: foreign.id, sha256: foreign.sha256, offset: 0, nextOffset: foreign.size });
  assert.equal(assessObjectionDispositions(report(), decision([disposition([foreign.id])]), evidenceContext).complete, false);
});

test('imported evidence preserves the original scoped inspection and hash provenance', async () => {
  const original = artifact(parent, 'The synthetic scoped control result.', 'shared-control');
  defender.allowedArtifactIds = [original.id]; saveSession(defender);
  const read = await host.call('read_artifact', { id: original.id });
  assert.ok(read.importedEvidenceId); evidenceContext.allowedArtifactIds.push(original.id, read.importedEvidenceId);
  assert.equal(assessObjectionDispositions(report(), decision([disposition([read.importedEvidenceId])]), evidenceContext).complete, true);
  const receipt = listRecords('artifact-read').find(item => item.artifactId === original.id);
  const row = database().prepare("SELECT id FROM records WHERE kind='artifact-read' AND json_extract(data,'$.sessionId')=? AND json_extract(data,'$.artifactId')=?").get(defender.id, original.id);
  putRecord('artifact-read', row.id, { ...receipt, sha256: 'bad-hash' });
  assert.equal(assessObjectionDispositions(report(), decision([disposition([read.importedEvidenceId])]), evidenceContext).complete, false);
});

test('all-evidence coverage requires contiguous complete read ranges, rather than a manifest or first page', async () => {
  const item = artifact(defender, 'synthetic-control\n'.repeat(3000), 'multi-page-evidence'); evidenceContext.allowedArtifactIds.push(item.id);
  await host.call('read_artifact', { id: item.id, offset: 0, limit: 1000 });
  assert.equal(assessDebateEvidenceCoverage([item.id], evidenceContext).complete, false);
  await host.call('read_artifact', { id: item.id, offset: 2000, limit: 32768 });
  assert.equal(assessDebateEvidenceCoverage([item.id], evidenceContext).complete, false, 'a gap cannot be hidden by later reads');
  await host.call('read_artifact', { id: item.id, offset: 1000, limit: 1000 });
  for (let offset = 34768; offset < item.size; offset += 32768) await host.call('read_artifact', { id: item.id, offset, limit: 32768 });
  assert.deepEqual(assessDebateEvidenceCoverage([item.id], evidenceContext).reviewed, [item.id]);
  const receiptCount = listRecords('artifact-read').length;
  await host.call('read_artifact', { id: item.id, offset: item.size + 10, limit: 1000 });
  assert.equal(listRecords('artifact-read').length, receiptCount + 1);
  const emptyRead = listRecords('artifact-read').find(read => read.offset === item.size + 10); assert.equal(emptyRead.bytesRead, 0);
  const empty = artifact(defender, '', 'empty-reference'); evidenceContext.allowedArtifactIds.push(empty.id);
  assert.equal(assessDebateEvidenceCoverage([empty.id], evidenceContext).complete, false);
  await host.call('read_artifact', { id: empty.id });
  assert.equal(assessDebateEvidenceCoverage([empty.id], evidenceContext).complete, true, 'an inspected empty reference is covered, while it still cannot resolve a factual objection');
  assert.equal(assessObjectionDispositions(report(), decision([disposition([empty.id])]), evidenceContext).complete, false);
});

test('the persistent objection ledger retains dropped points, changed claims and originating participants', () => {
  const first = accumulateDebateObjections([], report(), { round: 1 });
  const second = accumulateDebateObjections(first, [{ ...report()[0], assignmentId: 'challenger-two' }], { round: 2 });
  assert.equal(second.length, 1); assert.equal(second[0].sources.length, 2);
  const changed = accumulateDebateObjections(second, report('control', 'The severity has no demonstrated account impact.'), { round: 3 });
  assert.equal(changed.length, 2); assert.equal(changed[0].id, first[0].id); assert.notEqual(changed[1].id, changed[0].id);
  assert.deepEqual(accumulateDebateObjections(changed, [], { round: 4 }), changed);
  const unresolved = assessObjectionDispositions(changed, decision([disposition([], { status: 'unresolved' })]), evidenceContext);
  assert.equal(unresolved.complete, false); assert.ok(unresolved.missing.includes(changed[1].id));
});

test('majority agreement is descriptive while minority findings and uncertainty remain challenge obligations', () => {
  const entry = (index, verdict) => ({ assignmentId: `investigator-${index}`, participant: { provider: `fixture-${index}` }, state: 'awaiting_review',
    report: { status: 'complete', verdict, summary: 'An independent synthetic result.', evidence: [`proof-${index}`], objections: [], uncertainties: index === 2 ? ['Impact cannot be established.'] : [] }, artifacts: [{ originalId: `proof-${index}`, id: `import-${index}` }] });
  const investigation = { reports: [entry(0, 'real'), entry(1, 'real'), entry(2, 'false_positive')] }, consensus = investigationConsensus(investigation, 3);
  assert.equal(consensus.reached, true); assert.equal(consensus.maySkipChallenge, false);
  const ledger = accumulateDebateObjections([], investigation.reports, { phase: 'investigation', consensus });
  assert.ok(ledger.some(item => item.kind === 'minority')); assert.ok(ledger.some(item => item.kind === 'uncertainty'));
  assert.equal(assessObjectionDispositions(ledger, decision([]), evidenceContext).complete, false);
  assert.equal(investigationReadiness(investigation, 3, { sessionId: parent.id }).passed, false, 'invented artifact references cannot pass the host readiness check');
});

test('a real lower-impact finding cannot certify an original HIGH severity objective', async () => {
  const item = await inspected(), goalAssessment = { objective: parent.goal.objective, rationale: 'The fixture controls were inspected.', evidence: [item.id],
    criteria: [{ id: 'impact', status: 'supported', rationale: 'The recorded impact was compared.', evidence: [item.id] }],
    severity: { requested: 'high', assessed: 'low', rationale: 'Only low impact was observed.', evidence: [item.id] } };
  const proposed = { goalSatisfaction: 'supported', goalAssessment };
  assert.equal(assessDebateGoal(parent, proposed, evidenceContext).goalSatisfaction, 'inconclusive');
  goalAssessment.severity.assessed = 'high'; assert.equal(assessDebateGoal(parent, proposed, evidenceContext).passed, true);
  goalAssessment.objective = 'A simpler replacement objective.'; assert.equal(assessDebateGoal(parent, proposed, evidenceContext).passed, false);
  goalAssessment.objective = parent.goal.objective; goalAssessment.criteria = []; assert.equal(assessDebateGoal(parent, proposed, evidenceContext).passed, false);
  assert.equal(assessDebateGoal(parent, { goalSatisfaction: 'unsupported', goalAssessment }, evidenceContext).goalSatisfaction, 'unsupported');
  assert.doesNotThrow(() => assessDebateGoal(parent, { goalAssessment: { evidence: {}, severity: { requested: 1 } } }, evidenceContext));
});
