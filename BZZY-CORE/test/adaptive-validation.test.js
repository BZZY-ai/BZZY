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
import { getRecord, putRecord, appendEvent } from '../src/engine/database.js';
import { prepareChatDebate } from '../src/engine/chat-debate.js';
import { runDebate } from '../src/engine/debate.js';
import { goalValidationFor } from '../src/engine/goal-validation.js';
import { assessDebateCompletion } from '../src/engine/verification.js';
import { debateEvaluationActors } from './fixtures/orchestration-evaluation.mjs';

let directory, workspace, previous;
test.beforeEach(() => {
  previous = process.env.BZZY_HOME; directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-adaptive-validation-')));
  process.env.BZZY_HOME = path.join(directory, 'private'); workspace = path.join(directory, 'project'); fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'observations.json'), JSON.stringify({ positive: 'synthetic field disclosed', negative: 'owned control denied' }));
});
test.afterEach(() => {
  if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
  fs.rmSync(directory, { recursive: true, force: true });
});
async function evaluate(scenario = 'complete', { count = 2, retries = 1, budget, blocked = false, canonical = false } = {}) {
  const source = createSession(getProvider('codex'), workspace, 'source-model');
  prepareTask(source, { mode: 'solo' }, 'Assess the supplied synthetic controls.'); source.goal = newGoal(source.contract.objective);
  source.contract.limits.maxRetries = retries; saveSession(source); appendEvent(source.id, 'message.user', { text: source.goal.objective, kind: 'goal' });
  source.goal.evidence = [captureEvidence(source, 'observations.json', 'original control').id]; source.goal.status = 'complete'; saveSession(source);
  appendEvent(source.id, 'text', { text: 'The original goal was reported achieved.' });
  const selected = Array.from({ length: count }, (_, index) => ({ provider: 'codex', model: `independent-${index}`, effort: 'default' }));
  const prepared = prepareChatDebate(source, '', [], { debateAgents: selected, rounds: 1 });
  if (budget) { prepared.session.goal.tokenBudget = budget; saveSession(prepared.session); }
  const actors = debateEvaluationActors(prepared.session, { scenario, selectedArtifact: getRecord('artifact', prepared.session.reviewSource.evidenceIds[0]) });
  if (blocked) actors.dependencies.followupAssignment = () => { throw new Error('Synthetic unresolved context requires an explicit owner answer.'); };
  if (canonical) {
    const original = actors.dependencies.investigate;
    actors.dependencies.investigate = async (...args) => {
      const usage = await original(...args), investigation = getRecord('debate-investigation', prepared.session.id);
      for (const entry of investigation.reports) {
        const aliases = new Map(entry.artifacts.map(item => [item.originalId, item.id]));
        entry.report.evidence = entry.report.evidence.map(id => aliases.get(id) || id);
        for (const criterion of entry.report.validationAssessment.criteria) criterion.evidence = criterion.evidence.map(id => aliases.get(id) || id);
      }
      putRecord('debate-investigation', prepared.session.id, investigation); return usage;
    };
  }
  const observed = [];
  await runDebate(prepared.session, prepared.options, { event(type, data) { observed.push({ type, data }); } }, actors.dependencies);
  return { source, review: loadSession(prepared.session.id), result: getRecord('debate', prepared.session.id), activity: actors.activity, observed };
}

test('two or three true checks proceed directly to one fresh evidence reviewer without redundant challenge rounds', async () => {
  for (const count of [2, 3]) {
    const run = await evaluate('complete', { count });
    assert.equal(run.review.goal.status, 'complete'); assert.equal(run.result.protocol.kind, 'direct-review');
    assert.equal(run.result.assessment.challengeRounds, 0); assert.equal(run.result.transcript.length, 0);
    assert.equal(run.activity.starts.length, 1); assert.ok(run.activity.starts[0].requestId.startsWith('validation-final-'));
    assert.equal(run.activity.followups.length, 0); assert.equal(run.result.usage.totalTokens, count * 2 + 2);
    assert.ok(run.result.protocol.independentAssignments.every(item => item.workerSessionId !== run.result.protocol.finalReviewer.workerSessionId));
    assert.equal(goalValidationFor(run.source.id).state, 'validated');
    assert.ok(!run.observed.some(item => item.type === 'debate.phase' && ['opening', 'challenge', 'response'].includes(item.data.phase)));
  }
});

test('one explicit false blocks a true majority and yields policy rejection without claiming the original goal false', async () => {
  const run = await evaluate('one_false', { count: 3 });
  assert.equal(run.result.agreement.counts.true, 2); assert.equal(run.result.agreement.counts.false, 1);
  assert.equal(run.activity.starts.length, 0); assert.equal(run.activity.followups.length, 0);
  assert.equal(run.result.validationPolicy.outcome, 'rejected'); assert.equal(run.result.goalSatisfaction, 'inconclusive');
  assert.equal(goalValidationFor(run.source.id).state, 'not_validated'); assert.equal(goalValidationFor(run.source.id).reason, 'agent_dissent');
  assert.equal(loadSession(run.source.id).goal.status, 'complete');
});

test('two false assessments stop without another model and cannot create a positive acceptance receipt', async () => {
  const run = await evaluate('false');
  assert.equal(run.activity.starts.length, 0); assert.equal(run.activity.followups.length, 0);
  assert.equal(run.result.agreement.counts.false, 2); assert.equal(run.result.validationPolicy.outcome, 'rejected');
  assert.notEqual(run.review.acceptance?.passed, true); assert.equal(goalValidationFor(run.source.id).state, 'not_validated');
});

test('only the uncertain worker receives one private focused followup before a successful final review', async () => {
  const run = await evaluate('null_resolved', { count: 3 });
  assert.equal(run.activity.followups.length, 1); const retry = run.activity.followups[0];
  assert.equal(retry.id, run.result.protocol.independentAssignments[2].assignmentId);
  assert.match(retry.input.feedback, /INDEPENDENT GOAL CHECK/); assert.match(retry.input.feedback, /Independent check 3/);
  assert.doesNotMatch(retry.input.feedback, /Independent check 1|Independent check 2|INDEPENDENT REPORTS/);
  assert.equal(run.result.protocol.kind, 'targeted-followup'); assert.equal(run.activity.starts.length, 1,
    JSON.stringify(run.result.agreement.participants.map(item => ({ index: item.index, valid: item.valid, achieved: item.achieved, reasons: item.invalidReasons }))));
  assert.equal(run.review.goal.status, 'complete'); assert.equal(goalValidationFor(run.source.id).state, 'validated');
});

test('persistent null, zero retries, blocked context and exhausted budget never force certainty or launch a final reviewer', async () => {
  for (const options of [{}, { retries: 0 }, { blocked: true }, { budget: 3 }]) {
    const run = await evaluate('null', options);
    assert.equal(run.activity.starts.length, 0); assert.notEqual(goalValidationFor(run.source.id).state, 'validated');
    assert.ok(run.activity.followups.length <= 2); assert.equal(run.result.goalSatisfaction, 'inconclusive');
    if (options.retries === 0 || options.blocked || options.budget) assert.equal(run.activity.followups.length, 0);
    else assert.equal(run.activity.followups.length, 2);
    assert.equal(run.result.assessment.challengeRounds, 0);
  }
});

test('canonical parent evidence references and raw worker evidence references produce the same checked direct protocol', async () => {
  const run = await evaluate('complete', { canonical: true });
  assert.equal(run.review.goal.status, 'complete'); assert.equal(run.review.acceptance.passed, true);
  assert.equal(goalValidationFor(run.source.id).state, 'validated');
});

test('forged direct-review metadata or a reviewer reused from an independent check cannot bypass host completion', async () => {
  const run = await evaluate('complete'), forged = structuredClone(run.result);
  forged.protocol.finalReviewer.workerSessionId = forged.protocol.independentAssignments[0].workerSessionId;
  const receipt = await assessDebateCompletion(run.review, forged);
  assert.equal(receipt.passed, false); assert.ok(receipt.debate.reasons.some(reason => /fresh|reviewer/.test(reason)));
});

test('a supported natural-language final decision cannot override a false or uncertain final criterion assessment', async () => {
  for (const scenario of ['final_false', 'final_null']) {
    const run = await evaluate(scenario);
    assert.equal(run.result.agreement.agreeTrue, true); assert.equal(run.activity.starts.length, 1);
    assert.equal(run.result.decision.goalSatisfaction, 'supported'); assert.equal(run.result.assessment.passed, false);
    assert.notEqual(goalValidationFor(run.source.id).state, 'validated');
    const receipt = await assessDebateCompletion(run.review, { ...run.result, assessment: { ...run.result.assessment, passed: true }, goalSatisfaction: 'supported' });
    assert.equal(receipt.passed, false); assert.ok(receipt.debate.reasons.some(reason => /original criterion/.test(reason)));
  }
});
