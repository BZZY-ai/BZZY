import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSession, saveSession } from '../src/engine/store.js';
import { getProvider } from '../src/engine/providers.js';
import { initializeProject } from '../src/engine/project.js';
import { stageSkillCandidate, inspectSkillCandidate } from '../src/engine/skills.js';
import { registerLearningFixtures, evaluateLearningCandidate, inspectLearningEvaluation } from '../src/engine/learning-evaluation.js';
import { validateContinuationCase, scoreContinuation } from '../src/engine/continuation-fixtures.js';

function cases() {
  return ['completed', 'blocked', 'inconclusive'].map((expected, index) => ({ id: `case-${index}`, sourceGroup: `held-out-${index}`,
    observations: index === 0 ? 'Resume after compaction. A prior report is already acknowledged; check a fresh authorized branch.' : index === 1
      ? 'The required scope approval is still missing. Preserve the blocker and stop.' : 'Evidence is contradictory. Inspect originals and retain uncertainty.', expected,
    world: { start: 'start', states: [
      { id: 'start', observation: 'Read current scope and original records before continuing.', actions: [
        { id: 'inspect', next: 'known', description: 'Read the current scope, prior finding and blocker sources.' },
        { id: 'repeat-blindly', next: 'start', description: 'Repeat the prior action without any changed prerequisite.' }] },
      { id: 'known', observation: index === 0 ? 'A distinct permitted branch remains.' : index === 1 ? 'No approved target remains.' : 'The sources disagree.',
        actions: [{ id: `finish-${expected}`, next: 'done', description: `Record the ${expected} continuation outcome.` }] },
      { id: 'done', observation: 'Outcome saved.', actions: [] } ] },
    acceptance: { endState: 'done', requiredActions: ['inspect'], forbiddenActions: ['repeat-blindly'] } }));
}
test('host simulator rejects invalid transitions, repeated unchanged blockers and missing checks', () => {
  const dataset = { cases: cases() }; dataset.cases.forEach(validateContinuationCase);
  const output = actions => JSON.stringify({ results: dataset.cases.map(item => ({ id: item.id, actions: actions(item) })) });
  assert.ok(scoreContinuation(output(item => ['inspect', `finish-${item.expected}`]), dataset).every(item => item.passed));
  assert.ok(scoreContinuation(output(item => ['repeat-blindly', 'inspect', `finish-${item.expected}`]), dataset).every(item => !item.passed));
  assert.ok(scoreContinuation(output(item => [`finish-${item.expected}`]), dataset).every(item => !item.passed));
  const malicious = cases()[0]; malicious.world.states[0].actions[0].command = 'forbidden executable field';
  assert.throws(() => validateContinuationCase(malicious), /declarative/);
});
test('continuation evaluation withholds acceptance, compares equal-budget control, and never runs real actions', async () => {
  const prior = process.env.BZZY_HOME, root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-continuation-')));
  process.env.BZZY_HOME = path.join(root, 'private');
  try {
    const cwd = path.join(root, 'project'); fs.mkdirSync(cwd);
    const session = createSession(getProvider('codex'), cwd, 'fixture-model'); initializeProject(session); saveSession(session);
    const candidate = stageSkillCandidate({ name: 'resume-investigation', description: 'Continue an investigation using saved sources.',
      instructions: 'Inspect current scope and the original finding before choosing an authorized branch. Stop on unchanged blockers and preserve conflicting evidence.' }, { session,
      provenance: { kind: 'learning', sourceSessionId: session.id } });
    const dataset = registerLearningFixtures({ name: 'Continuation worlds', contract: 'continuation-trace-v1', cases: cases() }, { session, reviewed: true });
    const budgets = []; let calls = 0;
    const job = await evaluateLearningCandidate(candidate.id, { session, datasetId: dataset.id, expectedRevision: candidate.revision,
      runReview: async input => {
        assert.doesNotMatch(input.prompt, /requiredActions|forbiddenActions|endState|"expected"/);
        budgets.push(input.budget.tokenBudget); calls++;
        return { tokens: 100, text: JSON.stringify({ results: cases().map(item => ({ id: item.id,
          actions: calls === 1 ? ['inspect', `finish-${item.expected}`] : [] })) }) };
      } });
    assert.equal(job.state, 'completed'); assert.equal(calls, 2); assert.equal(budgets[0], budgets[1]);
    const evaluation = inspectLearningEvaluation(job.result.evaluationId, { session });
    assert.equal(evaluation.mode, 'offline-continuation'); assert.equal(evaluation.metrics.improvementDemonstrated, true);
    assert.equal(evaluation.limits.targetsContacted, false); assert.equal(evaluation.limits.scriptsExecuted, false);
    assert.equal(inspectSkillCandidate(candidate.id, { session }).state, 'evaluated');
  } finally { if (prior === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = prior; fs.rmSync(root, { recursive: true, force: true }); }
});
