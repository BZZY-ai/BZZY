import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { putRecord, appendEvent, digest, database, transaction } from '../src/engine/database.js';
import { sessionMetrics, resolveSessionMetricsScope } from '../src/engine/session-metrics.js';

let directory, previous;
test.beforeEach(() => {
  previous = process.env.BZZY_HOME; directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-session-metrics-')));
  process.env.BZZY_HOME = path.join(directory, 'private');
});
test.afterEach(() => {
  if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
  fs.rmSync(directory, { recursive: true, force: true });
});
function session(extra = {}) {
  const value = { id: randomUUID(), cwd: directory, executionState: 'idle', goal: { id: randomUUID(), objective: 'A bounded goal label',
    status: 'active', createdAt: new Date().toISOString() }, ...extra };
  putRecord('session', value.id, value); return value;
}
function skill(source, { goalMode = true, name = 'http-analysis', version = digest(name), runId = randomUUID(), scope = 'global', receipt = true } = {}) {
  const skillId = scope === 'global' ? name : `project:${digest(directory)}:${name}`, goalId = goalMode ? source.goal?.id || null : null;
  const record = { id: digest([source.id, runId, skillId, version]), version: 1, kind: 'skill', sessionId: source.id, runId, goalId,
    skillId, name, skillVersion: version, scope, ...resolveSessionMetricsScope(source.id, { goalMode, goalId }), createdAt: new Date().toISOString() };
  appendEvent(source.id, 'skill.loaded', { usageId: record.id, file: 'SKILL.md', offset: 0, name, bytes: 100 });
  if (receipt) putRecord('core.usage', record.id, record);
  appendEvent(source.id, 'core.usage', record); return record;
}
function job(parent, { named = false, chat = false, role = 'executor', createWorker = true } = {}) {
  const record = { id: randomUUID(), parentSessionId: parent.id, goalId: chat ? null : parent.goal.id, role, currentRound: 1,
    ...(chat ? { chatRunId: randomUUID(), sourceGoalId: parent.goal.id } : {}),
    ...(named ? { subagentDefinition: { id: digest('http-specialist'), name: 'http-specialist', version: digest('definition') } } : {}) };
  let worker;
  if (createWorker) { worker = session({ parentSessionId: parent.id, assignmentId: record.id, role, goal: null }); record.workerSessionId = worker.id; }
  putRecord('assignment', record.id, record); appendEvent(parent.id, 'assignment.created', record); return { record, worker };
}

test('durable exact skill uses are idempotent per receipt and separate current goals, prior goals and ordinary chat', async () => {
  const source = session(), first = skill(source), oldGoal = structuredClone(source.goal);
  appendEvent(source.id, 'core.usage', first);
  appendEvent(source.id, 'skill.loaded', { usageId: first.id, file: 'SKILL.md', offset: 0, bytes: 100 });
  appendEvent(source.id, 'skill.loaded', { file: 'references/details.md', offset: 0, bytes: 100 });
  appendEvent(source.id, 'skill.loaded', { file: 'SKILL.md', offset: 100, bytes: 100 });
  putRecord('goal-history', oldGoal.id, { sessionId: source.id, ...oldGoal, status: 'complete' });
  source.goal = { ...oldGoal, id: randomUUID(), objective: 'The next goal' }; putRecord('session', source.id, source);
  skill(source, { name: 'second-skill', scope: 'project' }); skill(source, { goalMode: false });
  const before = database().prepare('SELECT count(*) AS n FROM events').get().n;
  const metrics = sessionMetrics(source.id);
  assert.equal(metrics.session.skillInvocations, 3); assert.equal(metrics.chat.skillInvocations, 1);
  assert.equal(metrics.goals.find(item => item.id === oldGoal.id).skillInvocations, 1);
  assert.equal(metrics.goals.find(item => item.id === source.goal.id).skillInvocations, 1);
  assert.equal(metrics.coverage.legacySkillReads, 0); assert.equal(metrics.coverage.complete, true);
  assert.equal(metrics.session.skillRows.find(row => row.name === 'second-skill').scope, 'project');
  assert.deepEqual(sessionMetrics(source), metrics); assert.equal(database().prepare('SELECT count(*) AS n FROM events').get().n, before);
  const rebuilt = await import(`../src/engine/session-metrics.js?rebuild=${randomUUID()}`);
  assert.deepEqual(rebuilt.sessionMetrics(source.id), metrics);
});

test('named specialist invocations and explicit followups are separate from orchestration workers and their skill loads', () => {
  const source = session(), named = job(source, { named: true }), delegated = job(source), chat = job(source, { named: true, chat: true });
  skill(named.worker, { goalMode: false }); skill(delegated.worker, { goalMode: false }); skill(chat.worker, { goalMode: false });
  for (const item of [named, delegated, chat]) {
    appendEvent(source.id, 'assignment.followup', { id: item.record.id, round: 2 });
    appendEvent(source.id, 'assignment.followup', { id: item.record.id, round: 2 });
  }
  appendEvent(source.id, 'coordination.tool', { name: 'read_subagent', input: { name: 'http-specialist' } });
  const metrics = sessionMetrics(source.id), goal = metrics.goals.find(item => item.id === source.goal.id);
  assert.equal(metrics.session.subagentInvocations, 2); assert.equal(metrics.session.workerAssignments, 1);
  assert.equal(metrics.session.subagentFollowups, 2); assert.equal(metrics.session.workerFollowups, 1);
  assert.equal(goal.subagentInvocations, 1); assert.equal(goal.skillInvocations, 2);
  assert.equal(metrics.chat.subagentInvocations, 1); assert.equal(metrics.chat.skillInvocations, 1);
  assert.equal(metrics.session.agentRows[0].count, 2); assert.equal(metrics.session.agentRows[0].followups, 2);
});

test('linked Validate descendants map to the original goal while unrelated same-directory sessions never contribute', () => {
  const source = session(), review = session({ parentSessionId: source.id, mode: 'debate', reviewSource: { sessionId: source.id, goalId: source.goal.id } });
  const independent = job(review), final = job(review, { role: 'reviewer' });
  skill(independent.worker, { goalMode: false }); skill(final.worker, { goalMode: false });
  const other = session(); skill(other); job(other, { named: true });
  const metrics = sessionMetrics(source.id);
  assert.equal(metrics.session.skillInvocations, 2); assert.equal(metrics.session.workerAssignments, 2);
  assert.equal(metrics.goals.find(item => item.id === source.goal.id).skillInvocations, 2);
  assert.equal(metrics.goals.some(item => item.id === review.goal.id), false);
  assert.equal(sessionMetrics(review.id).goals.find(item => item.id === review.goal.id).skillInvocations, 2);
});

test('stamped worker attribution survives later goal replacement and unknown ancestry never guesses by cwd or objective', () => {
  const source = session(), peer = session({ parentSessionId: source.id, role: 'peer' });
  putRecord('parallel', source.id, { goalId: source.goal.id, peers: [{ sessionId: peer.id }] }); skill(peer);
  const originalGoal = source.goal.id;
  putRecord('parallel', source.id, { goalId: randomUUID(), peers: [] });
  source.goal.id = randomUUID(); putRecord('session', source.id, source);
  const unknown = session({ parentSessionId: source.id, role: 'peer' }); skill(unknown);
  const brokenReview = session({ parentSessionId: source.id, reviewSource: { sessionId: source.id, goalId: originalGoal } });
  const broken = session({ parentSessionId: brokenReview.id, assignmentId: randomUUID(), role: 'executor' });
  assert.equal(resolveSessionMetricsScope(broken.id, { goalId: broken.goal.id, goalMode: true }).attribution, 'unattributed');
  const metrics = sessionMetrics(source.id);
  assert.equal(metrics.goals.find(item => item.id === originalGoal).skillInvocations, 1);
  assert.equal(metrics.unattributed.skillInvocations, 1); assert.equal(metrics.goals.find(item => item.id === source.goal.id).skillInvocations, 0);
  assert.ok(metrics.coverage.reasons.includes('unknown_goal_attribution'));
});

test('legacy loads and imported history remain labeled coverage gaps and cannot fabricate local exact invocations', () => {
  const source = session(); skill(source); job(source, { named: true });
  appendEvent(source.id, 'project.imported', { sourceSessionId: randomUUID() });
  appendEvent(source.id, 'skill.loaded', { file: 'SKILL.md', offset: 0, bytes: 100, name: 'legacy' });
  skill(source, { receipt: false, name: 'unbound-read' });
  skill(source, { goalMode: false, name: 'local' });
  const metrics = sessionMetrics(source.id);
  assert.equal(metrics.session.skillInvocations, 1); assert.equal(metrics.session.subagentInvocations, 0);
  assert.equal(metrics.coverage.legacySkillReads, 2); assert.ok(metrics.coverage.historicalEvents >= 3);
  assert.equal(metrics.coverage.complete, false);
});

test('the projection contains only bounded usage and goal metadata and does not parse private tool or skill bodies', () => {
  const source = session(); source.goal.objective = 'x'.repeat(9000); putRecord('session', source.id, source);
  skill(source); appendEvent(source.id, 'coordination.tool', { name: 'read_skill', input: { secret: 'private-prompt-marker' } });
  appendEvent(source.id, 'text', { text: 'private-response-marker' });
  const metrics = sessionMetrics(source.id), text = JSON.stringify(metrics);
  assert.equal(metrics.goals[0].objective.length, 2000); assert.doesNotMatch(text, /private-prompt-marker|private-response-marker|cwd|runId|resourceBody/);
  putRecord('session-deletion', source.id, { id: source.id }); assert.equal(sessionMetrics(source.id).available, false);
});

test('goal-less assignment turns follow canonical mission scope while ordinary root and peer chat stay outside goals', () => {
  const source = session(), delegated = job(source), namedGoal = job(source, { named: true }), namedChat = job(source, { named: true, chat: true });
  for (const item of [delegated, namedGoal]) assert.deepEqual(resolveSessionMetricsScope(item.worker.id, { goalId: null, goalMode: false }), {
    rootSessionId: source.id, rootGoalId: source.goal.id, attribution: 'goal' });
  assert.deepEqual(resolveSessionMetricsScope(namedChat.worker.id, { goalId: null, goalMode: false }), {
    rootSessionId: source.id, rootGoalId: null, attribution: 'chat' });
  const review = session({ parentSessionId: source.id, reviewSource: { sessionId: source.id, goalId: source.goal.id } }), reviewer = job(review, { role: 'reviewer' });
  assert.deepEqual(resolveSessionMetricsScope(reviewer.worker.id, { goalId: null, goalMode: false }), {
    rootSessionId: source.id, rootGoalId: source.goal.id, attribution: 'goal' });
  assert.equal(resolveSessionMetricsScope(source.id, { goalMode: false }).attribution, 'chat');
  const peer = session({ parentSessionId: source.id, role: 'peer' }); putRecord('parallel', source.id, { goalId: source.goal.id, peers: [{ sessionId: peer.id }] });
  assert.equal(resolveSessionMetricsScope(peer.id, { goalMode: false }).attribution, 'chat');
});

test('caller edits cannot poison cached row counts and unresolved historical followups are disclosed', () => {
  const source = session(); skill(source); const named = job(source, { named: true });
  const first = sessionMetrics(source.id); first.session.skillRows[0].count = 999; first.session.agentRows[0].count = 999;
  first.goals[0].skillRows[0].name = 'mutated-by-caller';
  const second = sessionMetrics(source.id);
  assert.equal(second.session.skillRows[0].count, 1); assert.equal(second.session.agentRows[0].count, 1);
  assert.equal(second.goals[0].skillRows[0].name, 'http-analysis');
  database().prepare("DELETE FROM records WHERE kind='assignment' AND id=?").run(named.record.id);
  appendEvent(source.id, 'assignment.followup', { id: named.record.id, round: 2 });
  appendEvent(source.id, 'assignment.followup', { id: named.record.id, round: 2 });
  const incomplete = sessionMetrics(source.id);
  assert.equal(incomplete.coverage.complete, false); assert.equal(incomplete.coverage.unattributedFollowups, 1);
  assert.ok(incomplete.coverage.reasons.includes('followup_attribution_unavailable'));
});

test('large histories backfill in bounded pages and disclose row limits while retaining exact processed totals', () => {
  const source = session();
  transaction(() => { for (let index = 0; index < 4097; index++) skill(source, { version: digest(`revision-${index}`) }); });
  let metrics = sessionMetrics(source.id);
  assert.ok(metrics.session.skillInvocations < 4097); assert.ok(metrics.coverage.reasons.includes('event_backfill_pending'));
  for (let count = 0; count < 10 && metrics.coverage.reasons.includes('event_backfill_pending'); count++) metrics = sessionMetrics(source.id);
  assert.equal(metrics.session.skillInvocations, 4097); assert.equal(metrics.session.skillRows.length, 4096);
  assert.equal(metrics.coverage.reasons.includes('event_backfill_pending'), false);
  assert.ok(metrics.coverage.reasons.includes('row_limit')); assert.equal(metrics.coverage.complete, false);
  assert.equal(sessionMetrics(source.id).session.skillInvocations, 4097);
});
