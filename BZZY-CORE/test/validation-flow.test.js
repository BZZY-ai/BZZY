import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSession, saveSession, loadSession, sessionPath, lockOwner } from '../src/engine/store.js';
import { getProvider } from '../src/engine/providers.js';
import { getRecord, appendEvent, events, listRecords, putRecord } from '../src/engine/database.js';
import { Coordinator } from '../src/engine/coordination.js';
import { prepareTask } from '../src/engine/task.js';
import { newGoal } from '../src/engine/goals.js';
import { captureEvidence } from '../src/engine/evidence.js';
import { prepareChatDebate, finishChatDebate, defaultChatDebateAgents } from '../src/engine/chat-debate.js';
import { runDebate } from '../src/engine/debate.js';
import { debateEventUI } from '../src/engine/debate-events.js';
import { synthesizeDebateConsensus } from '../src/engine/debate-consensus.js';
import { CoreAssistant } from '../src/assistant.js';
import { debateEvaluationActors } from './fixtures/orchestration-evaluation.mjs';
import { finishCanvasReviews } from '../src/engine/canvas.js';

let directory, workspace, previousHome;
test.beforeEach(() => {
  previousHome = process.env.BZZY_HOME;
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-validation-')));
  process.env.BZZY_HOME = path.join(directory, 'private'); workspace = path.join(directory, 'project'); fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'observations.json'), JSON.stringify({ ownedControl: 'denied', foreignControl: 'minor field disclosed', severity: 'LOW' }));
});
test.afterEach(() => {
  if (previousHome === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previousHome;
  fs.rmSync(directory, { recursive: true, force: true });
});
function source() {
  const session = createSession(getProvider('codex'), workspace, 'current-chat-model', 'Achieved goal');
  const objective = 'Find a real HIGH severity vulnerability in the supplied synthetic records.';
  prepareTask(session, { mode: 'solo' }, objective); session.goal = newGoal(objective);
  session.contract.acceptanceCriteria = [{ id: 'high-impact', description: 'Demonstrate HIGH severity with reproducible controls.' }];
  session.contract.constraints = ['Only supplied synthetic records; no external target access.']; saveSession(session);
  appendEvent(session.id, 'message.user', { text: objective, kind: 'goal' });
  appendEvent(session.id, 'message.user', { text: 'Also preserve the owned-account negative control and report uncertainty.' });
  session.goal.evidence = [captureEvidence(session, 'observations.json', 'synthetic-low-impact-control').id];
  session.goal.status = 'complete'; saveSession(session);
  appendEvent(session.id, 'text', { text: 'A real observation was found. Goal achieved.' });
  return session;
}
const configureCore = () => new CoreAssistant().configure({ source: 'core', provider: 'deepseek', model: 'independent-core-model', effort: 'low' }, { expectedRevision: 0, requestId: randomUUID() });

test('achieved validation defaults repeat the current model independently and carry original user goal directives', () => {
  const saved = source(), choices = defaultChatDebateAgents(saved);
  assert.equal(choices.length, 2); assert.ok(choices.every(choice => choice.provider === 'codex' && choice.model === 'current-chat-model'));
  const prepared = prepareChatDebate(saved, '', []);
  assert.equal(prepared.session.goal.objective, saved.goal.objective);
  const mission = getRecord('core.mission.context', prepared.session.reviewSource.missionContextId);
  assert.ok(mission.brief.directives.some(item => /negative control/.test(item.text)));
  assert.ok(mission.brief.directives.every(item => item.sourceId.startsWith(saved.id + ':')));
  assert.equal(listRecords('execution').length, 0);
});

test('validation reports unavailable original proof before creating a review and retains the saved artifact', () => {
  const saved = source(), proof = getRecord('artifact', saved.goal.evidence[0]);
  const captured = fs.readFileSync(proof.path), count = listRecords('session').length;
  fs.unlinkSync(path.join(workspace, 'observations.json'));
  assert.throws(() => prepareChatDebate(saved, '', []), error => {
    assert.equal(error.code, 'VALIDATION_EVIDENCE_UNAVAILABLE');
    assert.match(error.message, /Validation could not start.*original evidence.*Restore.*retry \/validate.*copies were kept/);
    return true;
  });
  assert.deepEqual(fs.readFileSync(proof.path), captured);
  assert.equal(loadSession(saved.id).goal.status, 'complete');
  assert.equal(listRecords('session').length, count);
  assert.equal(listRecords('execution').length, 0);
  assert.equal(events(saved.id).filter(event => event.type === 'debate.linked').length, 0);
});

test('stable validation events distinguish same-provider participants and mirror child reviews once into source history', async () => {
  const saved = source(), agents = [0, 1, 2].map(index => ({ provider: 'codex', model: `review-model-${index}`, effort: 'default' }));
  const prepared = prepareChatDebate(saved, '', [], { debateAgents: agents, rounds: 1 });
  const actors = debateEvaluationActors(prepared.session, { scenario: 'wrong_severity', selectedArtifact: getRecord('artifact', prepared.session.reviewSource.evidenceIds[0]) });
  const observed = [];
  await runDebate(prepared.session, prepared.options, { event(type, data) { observed.push({ type, data }); } }, actors.dependencies);
  const typed = observed.filter(item => ['debate.started', 'debate.phase', 'debate.message', 'debate.result'].includes(item.type));
  assert.ok(typed.length >= 5); assert.ok(typed.every(item => item.data.debateId === prepared.session.goal.id));
  const started = typed.find(item => item.type === 'debate.started').data;
  assert.equal(new Set(started.participants.map(item => item.id)).size, 3);
  for (const item of typed.filter(item => item.type === 'debate.message')) {
    if (item.data.phase === 'final_review') {
      assert.equal(item.data.participantId, `${prepared.session.goal.id}:final-review`);
      assert.equal(item.data.participantIndex, agents.length); assert.equal(item.data.model, agents[0].model);
      assert.equal(item.data.maxRounds, 0); continue;
    }
    assert.equal(item.data.participantId, started.participants[item.data.participantIndex].id);
    assert.equal(item.data.provider, 'codex'); assert.equal(item.data.model, agents[item.data.participantIndex].model);
    assert.equal(item.data.maxRounds, 1); assert.ok(Number.isSafeInteger(item.data.round)); assert.ok(item.data.assignmentId);
  }
  const result = typed.find(item => item.type === 'debate.result').data;
  assert.equal(result.status, 'awaiting_review'); assert.notEqual(result.goalSatisfaction, 'supported');
  assert.ok(events(saved.id).some(item => item.type === 'debate.message' && item.data.debateId === prepared.session.goal.id));
  finishChatDebate(saved.id, prepared.session.id); finishChatDebate(saved.id, prepared.session.id);
  assert.equal(events(saved.id).filter(item => item.type === 'debate.result' && item.data.debateId === prepared.session.goal.id).length, 1);
});

test('Core consensus uses its own selected model and cannot upgrade an unsupported original HIGH goal', async () => {
  configureCore(); const saved = source(), prepared = prepareChatDebate(saved, '', [], { rounds: 1 });
  const actors = debateEvaluationActors(prepared.session, { scenario: 'wrong_severity', selectedArtifact: getRecord('artifact', prepared.session.reviewSource.evidenceIds[0]) });
  let called = false, checkedStatus;
  actors.dependencies.synthesizeConsensus = (session, result, options) => synthesizeDebateConsensus(session, result, { ...options, runModel: async input => {
    called = true; checkedStatus = JSON.parse(input.prompt).checkedStatus;
    assert.equal(input.selection.provider, 'deepseek'); assert.equal(input.selection.model, 'independent-core-model'); assert.equal(input.selection.effort, 'low');
    assert.match(input.prompt, /Find a real HIGH severity/); assert.match(input.instructions, /never upgrade/);
    return { text: 'The model claims everything is complete, although HIGH severity remains unsupported.', tokens: 50, usageAvailable: true };
  } });
  await runDebate(prepared.session, prepared.options, { event() {} }, actors.dependencies);
  const result = getRecord('debate', prepared.session.id), final = loadSession(prepared.session.id);
  assert.equal(called, true); assert.equal(checkedStatus, 'awaiting_review'); assert.equal(final.goal.status, 'awaiting_review');
  assert.notEqual(result.goalSatisfaction, 'supported'); assert.equal(result.assessment.passed, false);
  assert.equal(result.consensus.authoritative, false); assert.equal(result.consensus.state, 'ready');
  assert.equal(result.consensus.checkedStatus, 'awaiting_review'); assert.ok(result.usage.agents.some(agent => agent.role === 'consensus' && agent.provider === 'deepseek'));
  assert.equal(loadSession(saved.id).goal.status, 'complete'); assert.equal(loadSession(saved.id).goal.objective, saved.goal.objective);
});

test('unconfigured Core and private synthesis outputs preserve checked results without provider fallback', async () => {
  const saved = source(), result = { goalSatisfaction: 'inconclusive', assessment: { passed: false }, unresolvedDisagreement: ['HIGH severity unsupported.'] };
  let calls = 0;
  const unavailable = await synthesizeDebateConsensus(saved, result, { runModel: async () => { calls++; } });
  assert.equal(unavailable.reason, 'core_not_configured'); assert.equal(calls, 0);
  configureCore(); const before = structuredClone(result);
  for (const text of ['password=synthetic-private-value', 'x'.repeat(8193), '']) {
    const response = await synthesizeDebateConsensus(saved, result, { runModel: async () => ({ text, tokens: 40, usageAvailable: true }) });
    assert.equal(response.state, 'unavailable'); assert.equal(response.reason, 'invalid_consensus_output'); assert.equal(response.text, undefined);
  }
  assert.deepEqual(result, before);
});

test('validation summary identity is attached only by the review event wrapper', () => {
  const saved = source(), observed = [], wrapped = debateEventUI(saved, { event(type, data) { observed.push({ type, data }); } }, defaultChatDebateAgents(saved));
  wrapped.event('summary', { message: 'Completed validation review.' }); assert.equal(observed[0].data.debateId, saved.goal.id);
});

test('source instructions or evidence changed during consensus invalidate a previously supported assessment', async () => {
  configureCore();
  for (const change of ['instructions', 'evidence']) {
    const saved = source(); saved.goal.objective = 'Assess the supplied synthetic controls.'; saveSession(saved);
    const prepared = prepareChatDebate(saved, '', [], { rounds: 1 });
    const actors = debateEvaluationActors(prepared.session, { scenario: 'complete', selectedArtifact: getRecord('artifact', prepared.session.reviewSource.evidenceIds[0]) });
    let checked;
    actors.dependencies.synthesizeConsensus = (session, result, options) => synthesizeDebateConsensus(session, result, { ...options, runModel: async input => {
      checked = JSON.parse(input.prompt).checkedStatus;
      if (change === 'instructions') { saved.contract.context += ' Owner changed the mandatory original scope.'; saveSession(saved); }
      else fs.writeFileSync(path.join(workspace, 'observations.json'), 'Source evidence changed during consensus.');
      return { text: 'The earlier checked assessment was supported.', tokens: 30, usageAvailable: true };
    } });
    await runDebate(prepared.session, prepared.options, { event() {} }, actors.dependencies);
    const result = getRecord('debate', prepared.session.id);
    assert.equal(checked, 'complete', JSON.stringify(result.acceptance)); assert.equal(loadSession(prepared.session.id).goal.status, 'awaiting_review');
    assert.equal(result.assessment.passed, false); assert.equal(result.assessment.postConsensusCurrent, false);
    assert.equal(result.goalSatisfaction, 'inconclusive'); assert.equal(result.consensus.reason, 'source_changed'); assert.equal(result.consensus.text, undefined);
    fs.writeFileSync(path.join(workspace, 'observations.json'), JSON.stringify({ ownedControl: 'denied', foreignControl: 'minor field disclosed', severity: 'LOW' }));
  }
});

test('missing Core API authentication is detected before dispatch and incurs no conservative model charge', async () => {
  const previous = process.env.DEEPSEEK_API_KEY; delete process.env.DEEPSEEK_API_KEY;
  try {
    configureCore(); const response = await synthesizeDebateConsensus(source(), { goalSatisfaction: 'supported', assessment: { passed: true } });
    assert.equal(response.reason, 'auth_required'); assert.equal(response.chargedTokens, undefined);
  } finally { if (previous !== undefined) process.env.DEEPSEEK_API_KEY = previous; }
});

test('native coordinator keeps the run lock and cancellation timer active through consensus, before final notification', async t => {
  const saved = source(); saved.mode = 'debate'; saved.goal = newGoal('Review the supplied controls.'); saveSession(saved);
  const observed = [], coordinator = new Coordinator(saved, { event(type, data) { observed.push({ type, data }); } }, { runtimeSeconds: 5 });
  try { coordinator.start(); }
  catch (error) { if (error.code === 'UNSUPPORTED_POLICY') { t.skip('OS sandbox unavailable'); return; } throw error; }
  const record = { outcome: 'unresolved', goalSatisfaction: 'inconclusive', assessment: { passed: false }, unresolvedDisagreement: ['Evidence incomplete.'] };
  const worker = createSession(getProvider('codex'), workspace, 'offline-worker'); worker.parentSessionId = saved.id; worker.usage = { tokens: 3 }; saveSession(worker);
  const usage = { agents: [{ sessionId: worker.id, tokens: 3, available: true }, { role: 'consensus', tokens: null, chargedTokens: 8000, available: false }], totalTokens: 8003, complete: false };
  const code = await coordinator.finish('awaiting_review', record, usage, { afterAssessment: async (_record, status) => {
    assert.equal(status, 'awaiting_review'); assert.equal(loadSession(saved.id).goal.status, 'active');
    assert.ok(lockOwner(`${sessionPath(saved.id)}.lock`));
    assert.ok(!observed.some(item => item.type === 'summary'));
    const id = randomUUID(); putRecord('control', id, { id, sessionId: saved.id, action: 'cancel', state: 'queued' });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Consensus phase failed to observe cancellation.')), 1000);
      coordinator.abort.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    assert.equal(coordinator.stopping, 'cancelled');
  } });
  assert.equal(code, 130); assert.equal(loadSession(saved.id).goal.status, 'cancelled');
  assert.equal(loadSession(saved.id).goal.tokensUsed, 8003);
  assert.equal(lockOwner(`${sessionPath(saved.id)}.lock`), null);
  assert.ok(observed.some(item => item.type === 'summary' && item.data.status === 'cancelled'));
});

test('consensus rejects oversized context before dispatch and charges safe reported overages in full', async () => {
  configureCore(); const saved = source(); let calls = 0;
  const detailed = await synthesizeDebateConsensus(saved, { decision: { rationale: 'x'.repeat(6000) }, unresolvedDisagreement: ['Retain this minority objection.'] }, { runModel: async input => {
    calls++; assert.match(input.prompt, /Retain this minority objection/); assert.equal(input.budget.tokenBudget, 20000);
    return { text: 'The detailed assessment preserves unresolved dissent.', tokens: 200, usageAvailable: true };
  } });
  assert.equal(detailed.state, 'ready'); assert.equal(calls, 1); calls = 0;
  const result = await synthesizeDebateConsensus(saved, { decision: { rationale: 'x'.repeat(20000) } }, { runModel: async () => { calls++; } });
  assert.equal(result.reason, 'consensus_input_budget'); assert.equal(result.chargedTokens, undefined); assert.equal(calls, 0);
  const overage = await synthesizeDebateConsensus(saved, { goalSatisfaction: 'inconclusive' }, { runModel: async () => {
    throw Object.assign(new Error('Safe host budget error.'), { code: 'DOCUMENT_BUDGET', tokens: 23000, usageAvailable: true });
  } });
  assert.equal(overage.chargedTokens, 23000); assert.equal(overage.tokens, 23000); assert.equal(overage.usageAvailable, true);
});

test('Canvas waits for a durable typed final after goal completion and atomically deduplicates a racing observer', () => {
  const saved = source(), prepared = prepareChatDebate(saved, '', [], { rounds: 1 }), review = prepared.session;
  review.goal.status = 'complete'; review.goal.runtimeUsedSeconds = 12;
  review.summary = { usage: { totalTokens: 321, complete: true, agents: [] } }; saveSession(review);
  putRecord('debate', review.id, { debateId: review.goal.id, goalSatisfaction: 'supported', decision: null });
  putRecord('execution', 'race-execution', { id: 'race-execution', sessionId: review.id, state: 'running' });
  putRecord('terminal.canvas', saved.id, { id: saved.id, sessionId: saved.id, revision: 1,
    nodes: [{ id: 'lead', sessionId: saved.id }], groups: [{ id: 'review', lead: 'lead', members: ['lead'], reviewSessionId: review.id, reviewFinished: false }] });
  assert.equal(finishChatDebate(saved.id, review.id).pending, true);
  finishCanvasReviews(saved.id);
  assert.equal(getRecord('terminal.canvas', saved.id).groups[0].reviewFinished, false);
  assert.equal(events(saved.id).filter(item => item.type === 'debate.result').length, 0);
  const body = 'Original final consensus body\nAll checked conditions are recorded separately.';
  const ui = debateEventUI(review, { event(type) {
    if (type === 'debate.result') finishCanvasReviews(saved.id); // Observer races between child persistence and source mirroring.
  } }, review.debateAgents);
  ui.event('debate.result', { status: 'complete', goalSatisfaction: 'supported', message: body });
  finishCanvasReviews(saved.id); finishChatDebate(saved.id, review.id);
  const finals = events(saved.id).filter(item => item.type === 'debate.result');
  assert.equal(finals.length, 1); assert.equal(finals[0].data.message, body);
  assert.equal(finals[0].data.elapsedSeconds, 12); assert.equal(finals[0].data.usage.totalTokens, 321);
  assert.equal(getRecord('conversation-debate', saved.id).message, body);
  assert.equal(getRecord('terminal.canvas', saved.id).groups[0].reviewFinished, true);
});
