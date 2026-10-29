import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSession, saveSession } from '../src/engine/store.js';
import { BUILTINS } from '../src/engine/providers.js';
import { initializeProject, issue } from '../src/engine/project.js';
import { checkpoint } from '../src/engine/memory.js';
import { database, putRecord } from '../src/engine/database.js';
import { compactTaskState, contextFor, readTaskStateDetails } from '../src/engine/recovery.js';
import { updateInvestigation } from '../src/engine/session-investigation.js';

let directory, prior, session, context;
const bytes = value => Buffer.byteLength(JSON.stringify(value));
test.beforeEach(() => {
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-state-pressure-')));
  prior = process.env.BZZY_HOME; process.env.BZZY_HOME = path.join(directory, 'private');
  const cwd = path.join(directory, 'project'); fs.mkdirSync(cwd);
  session = createSession(BUILTINS.codex, cwd); initializeProject(session);
  session.goal = { id: randomUUID(), status: 'active', objective: 'ORBIT_FIXTURE '.repeat(100) };
  session.contract = { objective: session.goal.objective, constraints: Array.from({ length: 4 }, (_, index) => `${index}: ${'Keep offline scope. '.repeat(40)}`) };
  session.pendingInput = [{ text: 'Current owner instruction. '.repeat(40) }]; session.executionState = 'running'; saveSession(session);
  context = { runId: randomUUID(), goalMode: true };
  putRecord('run', session.id, { id: context.runId, state: 'running', goalId: session.goal.id, goalMode: true });
  checkpoint(session, { decisions: ['CURRENT_DECISION '.repeat(100)], completedWork: ['CURRENT_COMPLETED '.repeat(100)],
    pendingActions: ['CURRENT_ACTION '.repeat(100)], unresolvedQuestions: ['CURRENT_QUESTION '.repeat(100)] }, context);
});
test.afterEach(() => {
  if (prior === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = prior;
  fs.rmSync(directory, { recursive: true, force: true });
});

test('matching historical issues cannot displace the current checkpoint after compaction', () => {
  const original = compactTaskState(session, {}, context);
  for (let index = 0; index < 8; index++) issue(session, { title: `ORBIT_FIXTURE prior claim ${index}`, details: 'Historical observation. '.repeat(50) });
  session.nativeContext = { threadRef: 'fictional-native-thread', epoch: 2 }; saveSession(session);
  const state = compactTaskState(session, { knownRevision: original.revision, contextGeneration: original.contextGeneration }, context);
  assert.ok(bytes(state) <= 8192); assert.equal(state.notModified, false);
  assert.deepEqual(state.checkpoint, original.checkpoint, 'Historical matches yield space before current decisions and questions.');
  const changes = database().prepare('SELECT total_changes() AS count').get().count;
  const unchanged = compactTaskState(session, { knownRevision: state.revision, contextGeneration: state.contextGeneration }, context);
  assert.equal(unchanged.notModified, true); assert.equal(database().prepare('SELECT total_changes() AS count').get().count, changes);
});

test('Unicode pressure retains current categories and discoverable blocked branches with paged details', () => {
  session.goal.objective = 'ORBIT_FIXTURE 全体🙂'.repeat(200);
  session.contract = { objective: session.goal.objective, constraints: Array.from({ length: 4 }, () => '全体🙂'.repeat(200)) };
  session.nativeContext = { threadRef: 'long-native-reference-'.repeat(200), epoch: 3 }; saveSession(session);
  let branch = updateInvestigation(session, { action: 'declare', requestId: 'branch', hypothesis: 'Blocked fixture branch.', dependencies: [{ kind: 'session_input' }] }, context);
  for (let index = 0; index < 2; index++) branch = updateInvestigation(session, { action: 'block', requestId: `block-${index}`, id: branch.id,
    expectedRevision: branch.revision, blocker: { key: `owner-${index}`, kind: 'owner_input', resolver: 'owner',
      description: 'Missing supplied fixture 全体🙂 '.repeat(30), affectedWork: 'Offline verification.', neededChange: 'Supply the permitted fixture 全体🙂 '.repeat(20) } }, context);
  for (let index = 0; index < 8; index++) issue(session, { title: `ORBIT_FIXTURE historical issue ${index}`, details: 'Historical context. '.repeat(50) });
  const state = compactTaskState(session, {}, context);
  assert.ok(bytes(state) <= 8192); assert.ok(state.contextGeneration.length <= 256);
  for (const name of ['decisions', 'pendingActions', 'unresolvedQuestions', 'completedWork']) assert.ok(state.checkpoint[name], name);
  assert.ok(state.investigation.branches.some(item => item.id === branch.id));
  let text = '', offset = 0, sourceRevision;
  do {
    const page = readTaskStateDetails(session, { section: 'investigation', revision: state.revision, offset, limit: 300,
      ...(sourceRevision ? { sourceRevision } : {}) }, context);
    text += page.text; offset = page.nextOffset; sourceRevision = page.sourceRevision;
  } while (offset !== null);
  assert.ok(JSON.parse(text).branches.some(item => item.id === branch.id));
  assert.equal(compactTaskState(session, { knownRevision: state.revision, contextGeneration: state.contextGeneration }, context).notModified, true);
  assert.throws(() => compactTaskState(session, { unexpected: true }, context), /Invalid task-state/);
});

test('last-resort state retains recovery and scoped assignment status after compaction', () => {
  // Valid quoted/backslash text expands when previews are encoded in JSON.
  // Together with concurrent workers it exercises the final 8 KiB fallback.
  const dense = '"\\'.repeat(850);
  checkpoint(session, { decisions: [dense], completedWork: [dense], pendingActions: [dense], unresolvedQuestions: [dense] }, context);
  const jobs = Array.from({ length: 4 }, () => ({ id: randomUUID(), parentSessionId: session.id,
    goalId: session.goal.id, currentRound: 1, closure: 'open', role: 'executor',
    createdAt: new Date().toISOString(), contract: { objective: 'Inspect the offline fixture. '.repeat(40) } }));
  for (const job of [...jobs,
    { ...jobs[0], id: randomUUID(), parentSessionId: randomUUID() },
    { ...jobs[0], id: randomUUID(), goalId: randomUUID() }]) {
    putRecord('assignment', job.id, job);
    putRecord('round', `${job.id}:1`, { assignmentId: job.id, number: 1, state: 'needs_context' });
  }
  const operationId = randomUUID(), recovery = { state: 'reconciled', createdAt: new Date().toISOString(),
    uncertainOperations: [operationId], automaticallyReplayed: false, inspectionError: '全体🙂'.repeat(80) };
  putRecord('recovery', session.id, recovery);
  const state = compactTaskState(session, {}, context);
  assert.equal(state.compacted, true, 'Must exercise the last-resort form, not ordinary compaction.');
  assert.ok(bytes(state) <= 8192);
  assert.equal(state.recovery.state, 'reconciled'); assert.equal(state.recovery.uncertainOperationCount, 1);
  assert.equal(state.recovery.createdAt, recovery.createdAt); assert.equal(state.recovery.automaticallyReplayed, false);
  assert.match(state.recovery.lookup, /inspect.*before retry/i);
  assert.equal(state.assignments.total, 4); assert.equal(state.assignments.open, 4);
  assert.equal(state.liveAgents.truncated, true); assert.equal(state.liveAgents.assignments.length, 3);
  for (const item of state.liveAgents.assignments) {
    assert.ok(jobs.some(job => job.id === item.assignmentId));
    assert.equal(item.state, 'needs_context'); assert.equal(item.round, 1); assert.equal(item.closure, 'open');
    assert.equal(item.task, undefined);
  }
  const details = readTaskStateDetails(session, { section: state.recovery.detail, revision: state.revision }, context);
  assert.deepEqual(JSON.parse(details.text).uncertainOperations, [operationId]);
  const changes = database().prepare('SELECT total_changes() AS count').get().count;
  assert.equal(compactTaskState(session, { knownRevision: state.revision, contextGeneration: state.contextGeneration }, context).notModified, true);
  assert.equal(database().prepare('SELECT total_changes() AS count').get().count, changes);

  session.nativeContext = { threadRef: 'heavy-thread', epoch: 2 }; saveSession(session);
  const refreshed = compactTaskState(session, { knownRevision: state.revision, contextGeneration: state.contextGeneration }, context);
  assert.equal(refreshed.notModified, false); assert.equal(refreshed.compacted, true);
  assert.equal(refreshed.recovery.uncertainOperationCount, 1);
  const restricted = JSON.parse(contextFor(session, { ...context, compactDerived: true, restrictedTools: true }));
  assert.equal(restricted.currentState.compacted, true); assert.equal(restricted.currentState.assignments.open, 4);
  assert.match(restricted.currentState.assignments.lookup, /only the supplied Core tools/);

  putRecord('recovery', session.id, { ...recovery, uncertainOperations: [] });
  const changed = compactTaskState(session, { knownRevision: refreshed.revision, contextGeneration: refreshed.contextGeneration }, context);
  assert.equal(changed.notModified, false); assert.notEqual(changed.revision, refreshed.revision);
  assert.equal(changed.recovery.uncertainOperationCount, 0);
});
