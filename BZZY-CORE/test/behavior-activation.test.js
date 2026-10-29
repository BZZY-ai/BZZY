import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSession, saveSession } from '../src/engine/store.js';
import { BUILTINS } from '../src/engine/providers.js';
import { initializeProject } from '../src/engine/project.js';
import { appendEvent } from '../src/engine/database.js';
import { stageSkillCandidate, inspectSkillCandidate, acceptSkillCandidate } from '../src/engine/skills.js';
import { registerLearningFixtures, evaluateLearningCandidate, revokeLearningFixtures } from '../src/engine/learning-evaluation.js';

let directory, prior, session, candidate;
test.beforeEach(() => {
  prior = process.env.BZZY_HOME; directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-behavior-')));
  process.env.BZZY_HOME = path.join(directory, 'private');
  const cwd = path.join(directory, 'project'); fs.mkdirSync(cwd);
  session = createSession(BUILTINS.codex, cwd, 'offline-fixture'); initializeProject(session); saveSession(session);
  const event = appendEvent(session.id, 'message.user', { text: 'Author a procedure using only this fictional training example.' });
  candidate = stageSkillCandidate({ name: 'fictional-continuation', description: 'Preserve uncertainty when continuing.',
    instructions: 'Inspect original evidence, retain unresolved contradictions, and stop when authorization is missing.' },
  { session, provenance: { kind: 'learning', sourceSessionId: session.id, sourceIds: [event.id] } });
});
test.afterEach(() => {
  if (prior == null) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = prior;
  fs.rmSync(directory, { recursive: true, force: true });
});
function semanticCases() {
  return ['real', 'false_positive', 'inconclusive'].map((expected, index) => ({ id: `s${index}`, sourceGroup: `heldout-s${index}`,
    observations: `Independent fictional observation ${index}.`, expected }));
}
function behaviorCases() {
  return ['completed', 'blocked', 'inconclusive'].map((expected, index) => ({ id: `b${index}`, sourceGroup: `heldout-b${index}`,
    observations: `Independent fictional continuation ${index}.`, expected,
    world: { start: 'start', states: [{ id: 'start', observation: 'Inspect the current allowed state.', actions: [{ id: 'inspect', next: 'end', description: 'Read the original state and stop.' }] },
      { id: 'end', observation: 'The authorized continuation is complete.', actions: [] }] },
    acceptance: { endState: 'end', requiredActions: ['inspect'], forbiddenActions: [] } }));
}
async function evaluate(behavior, pass = true) {
  const cases = behavior ? behaviorCases() : semanticCases();
  const fixture = registerLearningFixtures({ name: behavior ? 'Continuation fixtures' : 'Safety fixtures', cases,
    contract: behavior ? 'continuation-trace-v1' : 'security-decision-v1' }, { session, reviewed: true });
  candidate = inspectSkillCandidate(candidate.id, { session });
  const result = await evaluateLearningCandidate(candidate.id, { session, datasetId: fixture.id, expectedRevision: candidate.revision,
    runReview: async () => ({ tokens: 20, text: JSON.stringify({ results: cases.map(item => ({ id: item.id,
      ...(behavior ? { actions: pass ? ['inspect'] : [] } : { verdict: item.expected }) })) }) }) });
  assert.equal(result.state, 'completed'); candidate = inspectSkillCandidate(candidate.id, { session });
  return { fixture, result };
}
const accept = () => acceptSkillCandidate(candidate.id, { expectedRevision: candidate.revision, expectedSkillRevision: 0,
  expectedEvaluationId: candidate.evaluation?.id || candidate.behaviorEvaluation?.id, reviewed: true }, { session });

test('behavior-only cannot replace safety coverage; both evaluations bind unchanged candidate content', async () => {
  await evaluate(true); assert.equal(candidate.evaluation, null); assert.ok(candidate.behaviorEvaluation);
  assert.throws(accept, /exact candidate evaluation|safety|host-executed/);
  const behaviorId = candidate.behaviorEvaluation.id;
  await evaluate(false);
  assert.equal(candidate.behaviorEvaluation.id, behaviorId); assert.ok(candidate.evaluation);
  assert.equal(candidate.evaluation.boundRevision, candidate.revision); assert.equal(candidate.behaviorEvaluation.boundRevision, candidate.revision);
  const accepted = accept(); assert.equal(accepted.enabled, true);
});

test('a failing supplemental continuation blocks activation without erasing passing safety evidence', async () => {
  await evaluate(false); const safetyId = candidate.evaluation.id;
  await evaluate(true, false);
  assert.equal(candidate.evaluation.id, safetyId); assert.equal(candidate.evaluation.status, 'passed');
  assert.equal(candidate.behaviorEvaluation.status, 'failed');
  assert.throws(accept, /supplemental behavior/);
});

test('revoked behavioral fixture is checked again at activation', async () => {
  await evaluate(false); const { fixture } = await evaluate(true);
  revokeLearningFixtures(fixture.id, { session, expectedRevision: fixture.revision });
  assert.throws(accept, /revoked|Approved fixture/);
});
