import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createSession, saveSession } from '../src/engine/store.js';
import { BUILTINS } from '../src/engine/providers.js';
import { getRecord, putRecord, listRecords } from '../src/engine/database.js';
import { initializeProject } from '../src/engine/project.js';
import { checkpoint, checkpointState } from '../src/engine/memory.js';
import { compactTaskState, contextFor, readTaskStateDetails } from '../src/engine/recovery.js';

let directory, oldHome, session;
test.beforeEach(() => {
  oldHome = process.env.BZZY_HOME;
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-checkpoint-')));
  process.env.BZZY_HOME = path.join(directory, 'private');
  const project = path.join(directory, 'project'); fs.mkdirSync(project);
  session = createSession(BUILTINS.codex, project); initializeProject(session); saveSession(session);
});
test.afterEach(() => {
  if (oldHome == null) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = oldHome;
  fs.rmSync(directory, { recursive: true, force: true });
});
const goal = (objective = 'Find one new issue.') => ({ id: randomUUID(), objective, status: 'active' });

test('fresh goals with identical text never inherit earlier completion, decisions or constraints', () => {
  session.goal = goal(); session.contract = { objective: session.goal.objective, constraints: ['Use recorded evidence.'] }; saveSession(session);
  const old = checkpoint(session, { completedWork: ['Treat the objective complete.'], decisions: ['Use the old conclusion.'], constraints: ['Old goal only.'] });
  const stale = structuredClone(session);
  session.goal = goal(); saveSession(session);
  const before = checkpointState(session);
  assert.equal(before.current, null); assert.equal(before.historical.reason, 'different-execution-scope');
  assert.equal(JSON.parse(contextFor(session)).checkpoint, null);
  assert.throws(() => compactTaskState(stale), /goal changed/);
  assert.throws(() => checkpoint(stale, { pendingActions: ['Late old-goal write.'] }), /goal changed/);
  const fresh = checkpoint(session, { pendingActions: ['Inspect the new controls.'], expectedRevision: 0 });
  assert.equal(fresh.revision, old.revision + 1); assert.equal(fresh.completedWork, undefined); assert.equal(fresh.decisions, undefined);
  assert.deepEqual(fresh.constraints, ['Use recorded evidence.']);
  assert.deepEqual(getRecord('core.checkpoint.revision', `${session.id}:${old.revision}`), old);
  session.goal = stale.goal; saveSession(session);
  assert.deepEqual(checkpointState(session).current, old);
});

test('legacy, unrevisioned and imported progress remains historical and is retained before local writes', () => {
  session.goal = goal(); saveSession(session);
  const legacy = { sessionId: session.id, objective: session.goal.objective, completedWork: ['LEGACY-COMPLETED'], decisions: ['Legacy decision.'] };
  putRecord('checkpoint', session.id, legacy);
  assert.equal(checkpointState(session).current, null);
  assert.equal(checkpointState(session).historical.reason, 'legacy-or-imported-unattributed');
  const saved = checkpoint(session, { pendingActions: ['New task remains open.'] });
  assert.equal(saved.completedWork, undefined);
  assert.ok(listRecords('core.checkpoint.revision', { sessionId: session.id }).some(item => JSON.stringify(item) === JSON.stringify(legacy)));
  const imported = { ...saved, importedUntrusted: true, importProvenance: { source: 'fixture' }, revision: saved.revision + 1 };
  putRecord('checkpoint', session.id, imported);
  // A valid earlier local scope can still be resumed; the forged latest import
  // cannot replace its current progress or create local completion authority.
  assert.equal(checkpointState(session).current.revision, saved.revision);
  assert.equal(checkpointState(session).historical.reason, 'legacy-or-imported-unattributed');
  session.goal = goal(); saveSession(session);
  assert.equal(checkpointState(session).current, null);
  assert.throws(() => checkpoint(session, { goalId: session.goal.id, completedWork: ['Forged.'] }), /host-owned/);
});

test('ordinary chat separates the old saved goal and each run while retaining goal progress', () => {
  session.goal = goal(); session.contract = { objective: 'OLD-GOAL-OBJECTIVE', context: 'OLD-GOAL-WORKFLOW', constraints: ['Retain scope.'] }; saveSession(session);
  const original = checkpoint(session, { completedWork: ['OLD-GOAL-COMPLETION'] });
  const chat = { goalMode: false, runId: 'chat-run-1' };
  const state = compactTaskState(session, {}, chat);
  assert.equal(state.currentGoal, null); assert.equal(state.checkpoint, null);
  assert.doesNotMatch(JSON.stringify(state), /OLD-GOAL-(?:OBJECTIVE|WORKFLOW|COMPLETION)/);
  const saved = checkpoint(session, { pendingActions: ['Answer the current request.'] }, chat);
  assert.equal(saved.objective, undefined); assert.equal(saved.goalId, null); assert.equal(saved.scope.kind, 'chat');
  assert.equal(checkpointState(session, { goalMode: false, runId: 'chat-run-2' }).current, null);
  assert.equal(checkpointState(session).current.revision, original.revision);
});

test('checkpoint CAS, request retries, run ownership and assignment rounds reject stale writers', () => {
  session.goal = goal(); saveSession(session);
  putRecord('run', session.id, { id: 'run-1', sessionId: session.id, state: 'running' });
  const context = { goalMode: true, runId: 'run-1' };
  const input = { decisions: ['A durable decision.'], expectedRevision: 0, requestId: 'first-write' };
  const first = checkpoint(session, input, context);
  assert.deepEqual(checkpoint(session, input, context), first);
  assert.throws(() => checkpoint(session, { ...input, decisions: ['Changed retry.'] }, context), /reused/);
  assert.throws(() => checkpoint(session, { pendingActions: ['Stale write.'], expectedRevision: 0 }, context), /changed/);
  putRecord('run', session.id, { id: 'run-2', sessionId: session.id, state: 'running' });
  assert.throws(() => checkpoint(session, { pendingActions: ['Wrong run.'] }, context), /no longer active/);
  const worker = { ...createSession(BUILTINS.codex, session.cwd), role: 'executor', parentSessionId: session.id, assignmentId: randomUUID(), assignmentRound: 1 };
  initializeProject(worker); saveSession(worker);
  putRecord('assignment', worker.assignmentId, { id: worker.assignmentId, workerSessionId: worker.id, currentRound: 1, closure: 'open' });
  const round1 = checkpoint(worker, { completedWork: ['First round claim.'] });
  const staleWorker = structuredClone(worker); worker.assignmentRound = 2; saveSession(worker);
  putRecord('assignment', worker.assignmentId, { id: worker.assignmentId, workerSessionId: worker.id, currentRound: 2, closure: 'open' });
  assert.throws(() => checkpoint(staleWorker, { pendingActions: ['Late first round.'] }), /assignment changed/);
  const round2 = checkpoint(worker, { pendingActions: ['Answer the follow-up.'], expectedRevision: 0 });
  assert.equal(round2.completedWork, undefined); assert.equal(round2.revision, round1.revision + 1);
});

test('independent database hosts serialize concurrent expected-revision writes', async () => {
  session.goal = goal(); saveSession(session);
  const first = checkpoint(session, { pendingActions: ['Baseline.'] });
  const memoryURL = new URL('../src/engine/memory.js', import.meta.url).href, databaseURL = new URL('../src/engine/database.js', import.meta.url).href;
  const source = `import {checkpoint} from ${JSON.stringify(memoryURL)}; import {getRecord} from ${JSON.stringify(databaseURL)};
    try { const result=checkpoint(getRecord('session',process.env.BZZY_CHECKPOINT_SESSION),{pendingActions:['Concurrent update.'],expectedRevision:${first.revision}}); console.log(JSON.stringify({ok:true,revision:result.revision})); }
    catch(error) { console.log(JSON.stringify({ok:false,error:error.message})); }`;
  const write = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { env: { ...process.env, BZZY_CHECKPOINT_SESSION: session.id } });
    let output = '', errors = ''; child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => errors += chunk);
    child.on('error', reject); child.on('close', code => code ? reject(new Error(errors)) : resolve(JSON.parse(output.trim())));
  });
  const writes = await Promise.all([write(), write()]);
  assert.equal(writes.filter(item => item.ok).length, 1); assert.match(writes.find(item => !item.ok).error, /changed/);
  assert.equal(getRecord('checkpoint', session.id).revision, first.revision + 1);
});

test('compact state bounds large recovery and contracts, with exact revisioned UTF-8 detail pages', () => {
  session.goal = goal('A current objective '.repeat(500));
  session.contract = { objective: session.goal.objective, context: '全体の要件🙂'.repeat(4000), constraints: ['Keep the whole contract.'] };
  session.nativeContext = { threadRef: 'thread-a', epoch: 2 }; saveSession(session);
  putRecord('recovery', session.id, { state: 'reconciled', workspaceChanges: Array.from({ length: 500 }, (_, index) => ({ path: `${index}.txt`, detail: 'x'.repeat(1000) })), automaticallyReplayed: false });
  const state = compactTaskState(session);
  assert.ok(Buffer.byteLength(JSON.stringify(state)) <= 8192); assert.equal(state.recovery.workspaceChangeCount, 500);
  assert.equal(JSON.parse(contextFor(session)).contract.context, session.contract.context);
  const stable = compactTaskState(session, { knownRevision: state.revision, contextGeneration: state.contextGeneration });
  assert.equal(stable.notModified, true);
  session.goal.tokensUsed = 123; session.goal.runtimeUsedSeconds = 100; session.usage = { tokens: 400 }; saveSession(session);
  assert.equal(compactTaskState(session).revision, state.revision);
  session.nativeContext.epoch++; saveSession(session);
  assert.equal(compactTaskState(session, { knownRevision: state.revision, contextGeneration: state.contextGeneration }).notModified, false);
  const afterCompaction = compactTaskState(session);
  session.nativeBackendReadiness = { threadRef: 'replacement-thread' }; saveSession(session);
  assert.equal(compactTaskState(session, { knownRevision: afterCompaction.revision, contextGeneration: afterCompaction.contextGeneration }).notModified, false);
  let offset = 0, sourceRevision, full = '';
  do {
    const page = readTaskStateDetails(session, { section: 'contract', revision: state.revision, offset, limit: 997, ...(sourceRevision ? { sourceRevision } : {}) });
    assert.ok(Buffer.byteLength(page.text) <= 997); full += page.text; sourceRevision = page.sourceRevision; offset = page.nextOffset;
  } while (offset != null);
  assert.deepEqual(JSON.parse(full), session.contract);
  assert.throws(() => readTaskStateDetails(session, { section: 'contract', revision: state.revision, offset: 10 }), /revision is missing/);
  checkpoint(session, { pendingActions: ['Changed since the capsule.'] });
  assert.throws(() => readTaskStateDetails(session, { section: 'contract', revision: state.revision }), /Task state changed/);
});
