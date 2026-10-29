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
import { compactTaskState, readTaskStateDetails } from '../src/engine/recovery.js';
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
