import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { database, getRecord, putRecord, events, listRecords, digest } from '../src/engine/database.js';
import { sessionInvocations } from '../src/engine/invocation-state.js';
import { processIdentity } from '../src/engine/process-identity.js';
import { recordModelSkillUse } from '../src/engine/skill-usage.js';
import { sessionMetrics } from '../src/engine/session-metrics.js';
import { BzzyCore, BzzyClient } from '../src/index.js';
import { runtimeInfo, runtimeRequest } from '../src/engine/runtime.js';
import { identityAlive } from '../src/engine/process-identity.js';
import { setTimeout as delay } from 'node:timers/promises';

let directory, previous, parent;
const definition = { name: 'http-analyst', instructions: 'PRIVATE_METHOD_BODY' };
const skill = { id: 'controlled-review', name: 'controlled-review', version: digest('fixture-method'), scope: 'global', file: 'SKILL.md', text: 'Use the supplied control.' };
function session(extra = {}) {
  const value = { id: randomUUID(), cwd: directory, provider: 'codex', executionState: 'idle',
    goal: { id: randomUUID(), objective: 'PRIVATE_GOAL_BODY', status: 'active', createdAt: new Date().toISOString() }, ...extra };
  putRecord('session', value.id, value); return value;
}
function assignment(extra = {}, roundExtra = {}) {
  const value = { id: randomUUID(), parentSessionId: parent.id, currentRound: 1, closure: 'open', role: 'executor',
    selection: { provider: 'codex', model: 'fixture-model' }, subagentDefinition: definition,
    contract: { objective: 'PRIVATE_ASSIGNMENT_BODY' }, workspace: '/private/PRIVATE_WORKSPACE', ...extra };
  putRecord('assignment', value.id, value);
  putRecord('round', `${value.id}:${value.currentRound}`, { assignmentId: value.id, number: value.currentRound, state: 'awaiting_review',
    createdAt: new Date().toISOString(), error: 'PRIVATE_RAW_ERROR', report: { summary: 'PRIVATE_REPORT_BODY' }, ...roundExtra });
  return value;
}
function worker(extra = {}) {
  const child = session({ goal: null, parentSessionId: parent.id, role: 'executor', ...extra });
  const job = assignment({ workerSessionId: child.id, goalId: parent.goal.id, ...extra.assignment });
  child.assignmentId = job.id; child.assignmentRound = 1; putRecord('session', child.id, child);
  return child;
}
function loadSkill(source, runId = randomUUID()) {
  return recordModelSkillUse(source, skill, { sessionId: source.id, runId, goalId: null, goalMode: false });
}
const usage = id => events(id, 0, 1000).filter(event => event.type === 'core.usage');
test.beforeEach(() => {
  previous = process.env.BZZY_HOME; directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-invocations-')));
  process.env.BZZY_HOME = path.join(directory, 'private'); parent = session();
});
test.afterEach(() => {
  if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
  fs.rmSync(directory, { recursive: true, force: true });
});

test('the bounded invocation projection shows only direct-parent safe metadata and the current round', () => {
  const named = assignment(), generic = assignment({ subagentDefinition: undefined, role: 'reviewer', currentRound: 2 }, { state: 'needs_context' });
  putRecord('round', `${generic.id}:1`, { state: 'running', runner: processIdentity() });
  const other = session(); assignment({ parentSessionId: other.id });
  const before = database().prepare('SELECT total_changes() AS n').get().n;
  const value = sessionInvocations(parent.id);
  assert.equal(value.version, 1); assert.equal(value.truncated, false); assert.equal(value.agents.length, 2);
  const a = value.agents.find(item => item.id === named.id), b = value.agents.find(item => item.id === generic.id);
  assert.deepEqual(a, { id: named.id, parentSessionId: parent.id, name: 'http-analyst', specialist: true,
    provider: 'codex', model: 'fixture-model', round: 1, state: 'awaiting_review', closure: 'open' });
  assert.equal(b.name, 'Reviewer'); assert.equal(b.specialist, false); assert.equal(b.round, 2); assert.equal(b.state, 'needs_context');
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE_|instructions|contract|workspace|report|error/);
  assert.equal(database().prepare('SELECT total_changes() AS n').get().n, before);
  assert.equal(listRecords('execution').length, 0);
});

test('explicit paused, stopped and reviewed outcomes remain distinct without changing durable records', () => {
  for (const state of ['paused', 'cancelled', 'interrupted', 'failed', 'timed_out', 'budget_limited', 'needs_context', 'awaiting_review']) {
    const job = assignment({}, { state }); assert.equal(sessionInvocations(parent.id).agents.find(item => item.id === job.id).state, state);
  }
  for (const closure of ['accepted', 'rejected', 'inconclusive', 'abandoned']) {
    const job = assignment({ closure }); assert.equal(sessionInvocations(parent.id).agents.find(item => item.id === job.id).state, closure);
  }
  const missing = assignment(); database().prepare("DELETE FROM records WHERE kind='round' AND id=?").run(`${missing.id}:1`);
  assert.equal(sessionInvocations(parent.id).agents.find(item => item.id === missing.id).state, 'unknown');
});

test('verified active process identities distinguish running, starting, cancelled and interrupted workers', () => {
  const identity = processIdentity(), running = assignment({}, { state: 'running', runner: identity });
  const dead = assignment({}, { state: 'running', runner: { ...identity, start: 'different-process-birth' } });
  const starting = assignment({}, { state: 'starting' });
  const stale = assignment({}, { state: 'starting', createdAt: new Date(Date.now() - 60000).toISOString() });
  const pending = assignment({ contextRequest: { state: 'pending' } }, { state: 'running', runner: identity });
  const cancelling = assignment({}, { state: 'running', runner: identity });
  putRecord('assignment-control', cancelling.id, { action: 'cancel', round: 1 });
  const cancelled = assignment({}, { state: 'running', runner: { ...identity, start: 'another-process-birth' } });
  putRecord('assignment-control', cancelled.id, { action: 'cancel', round: 1 });
  const states = new Map(sessionInvocations(parent.id).agents.map(item => [item.id, item.state]));
  assert.equal(states.get(running.id), 'running'); assert.equal(states.get(dead.id), 'interrupted');
  assert.equal(states.get(starting.id), 'starting'); assert.equal(states.get(stale.id), 'interrupted');
  assert.equal(states.get(pending.id), 'needs_context'); assert.equal(states.get(cancelling.id), 'cancelling'); assert.equal(states.get(cancelled.id), 'cancelled');
  assert.equal(getRecord('round', `${dead.id}:1`).state, 'running', 'Presentation never reconciles or mutates an interrupted worker.');
  const legacy = assignment({}, { state: 'running', runner: { pid: process.pid, start: 'platform-unverified' } });
  assert.equal(sessionInvocations(parent.id).agents.find(item => item.id === legacy.id).state, 'unknown');
});

test('malformed invocation metadata cannot expose paths, arbitrary objects or terminal control bytes', () => {
  const job = assignment({ subagentDefinition: { name: 'bad\x1b[31mPRIVATE_NAME' }, selection: { provider: 'bad\nPRIVATE_PROVIDER', model: '/private/PRIVATE_MODEL' } });
  const value = sessionInvocations(parent.id).agents.find(item => item.id === job.id);
  assert.equal(value.name, 'Executor'); assert.equal(value.provider, null); assert.equal(value.model, null);
  putRecord('assignment', job.id, { ...getRecord('assignment', job.id), selection: { provider: 'codex', model: { privatePath: '/private/PRIVATE_MODEL' } } });
  assert.equal(sessionInvocations(parent.id).agents.find(item => item.id === job.id).model, null);
  assert.doesNotMatch(JSON.stringify(sessionInvocations(parent.id)), /PRIVATE_|\x1b/);
});

test('invocation pages disclose truncation, reject invalid IDs and hide deleted or missing sessions', () => {
  for (let index = 0; index < 70; index++) assignment();
  const value = sessionInvocations(parent.id); assert.equal(value.agents.length, 64); assert.equal(value.truncated, true);
  assert.throws(() => sessionInvocations('not-a-session'));
  assert.deepEqual(sessionInvocations(randomUUID()), { version: 1, agents: [], truncated: false });
  putRecord('session-deletion', parent.id, { id: parent.id });
  assert.deepEqual(sessionInvocations(parent.id), { version: 1, agents: [], truncated: false });
});

test('worker skill receipts mirror identically into the validated root feed and count only once', () => {
  const child = worker(), runId = randomUUID(), receipt = loadSkill(child, runId);
  assert.equal(receipt.rootSessionId, parent.id); assert.equal(receipt.rootGoalId, parent.goal.id);
  assert.deepEqual(usage(child.id)[0].data, receipt); assert.deepEqual(usage(parent.id)[0].data, receipt);
  assert.equal(usage(child.id).length, 1); assert.equal(usage(parent.id).length, 1);
  loadSkill(child, runId); assert.equal(listRecords('core.usage').length, 1); assert.equal(usage(parent.id).length, 1);
  const metrics = sessionMetrics(parent.id); assert.equal(metrics.session.skillInvocations, 1);
  assert.equal(metrics.goals.find(item => item.id === parent.goal.id).skillInvocations, 1);
  const chatChild = worker({ assignment: { goalId: null, chatRunId: randomUUID() } }), chat = loadSkill(chatChild);
  assert.equal(chat.attribution, 'chat'); assert.equal(chat.rootGoalId, null);
  assert.equal(usage(parent.id).length, 2); assert.equal(sessionMetrics(parent.id).chat.skillInvocations, 1);
});

test('nested review workers mirror to their original root without leaking to unrelated same-directory chats', () => {
  const other = session(), review = session({ parentSessionId: parent.id, reviewSource: { sessionId: parent.id, goalId: parent.goal.id } });
  const child = worker({ parentSessionId: review.id });
  const job = getRecord('assignment', child.assignmentId); putRecord('assignment', job.id, { ...job, parentSessionId: review.id, goalId: review.goal.id });
  const receipt = loadSkill(child);
  assert.equal(receipt.rootSessionId, parent.id); assert.equal(receipt.rootGoalId, parent.goal.id);
  assert.equal(usage(parent.id).length, 1); assert.equal(usage(other.id).length, 0);
  assert.equal(sessionMetrics(parent.id).session.skillInvocations, 1);
});

test('unknown or mismatched worker ancestry never manufactures a parent skill invocation', () => {
  const other = session(), child = worker();
  const job = getRecord('assignment', child.assignmentId); putRecord('assignment', job.id, { ...job, parentSessionId: other.id });
  const receipt = loadSkill({ ...child, parentSessionId: parent.id });
  assert.equal(receipt.attribution, 'unattributed'); assert.equal(usage(parent.id).length, 0); assert.equal(usage(other.id).length, 0);
  assert.equal(usage(child.id).length, 1);
  loadSkill(parent); assert.equal(usage(parent.id).length, 1, 'Direct parent loads emit one receipt, not a mirror duplicate.');
});

test('a failed root mirror rolls back its receipt and child event atomically', () => {
  const child = worker(), runId = randomUUID();
  database().exec(`CREATE TRIGGER reject_root_usage BEFORE INSERT ON events WHEN NEW.session_id='${parent.id}' AND NEW.type='core.usage' BEGIN SELECT RAISE(ABORT,'synthetic mirror failure'); END;`);
  assert.throws(() => loadSkill(child, runId), /synthetic mirror failure/);
  assert.equal(listRecords('core.usage').length, 0); assert.equal(usage(child.id).length, 0); assert.equal(usage(parent.id).length, 0);
  database().exec('DROP TRIGGER reject_root_usage');
  loadSkill(child, runId); assert.equal(usage(parent.id).length, 1); assert.equal(usage(child.id).length, 1);
});

test('the existing authorized session API includes invocation state without inference or cross-session access', { timeout: 15000 }, async () => {
  const core = new BzzyCore(), current = core.createConversation({ provider: 'codex', cwd: directory }, { requestId: randomUUID() });
  const job = assignment({ parentSessionId: current.id }, { state: 'paused' });
  await core.start(); const info = runtimeInfo();
  try {
    const snapshot = await core.session(current.id);
    assert.equal(snapshot.invocations.version, 1); assert.equal(snapshot.invocations.agents[0].id, job.id);
    assert.equal(snapshot.invocations.agents[0].state, 'paused');
    const grant = await core.grantSession({ sessionId: current.id }), observer = new BzzyClient({ url: info.url, token: grant.token });
    assert.deepEqual((await observer.session(current.id)).invocations, snapshot.invocations);
    await assert.rejects(observer.session(parent.id), { status: 403 });
    assert.equal(listRecords('execution').length, 0); assert.equal(listRecords('run').length, 0);
  } finally {
    await runtimeRequest(info, 'POST', '/shutdown', {}).catch(() => {});
    for (let attempt = 0; identityAlive(info.identity) && attempt < 100; attempt++) await delay(20);
    assert.equal(identityAlive(info.identity), false);
  }
});
