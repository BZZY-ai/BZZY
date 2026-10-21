import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSession, saveSession } from '../src/store.js';
import { BUILTINS } from '../src/providers.js';
import { prepareTask } from '../src/task.js';
import { newGoal } from '../src/goals.js';
import { getRecord, putRecord, listRecords } from '../src/database.js';
import { artifact, readArtifact } from '../src/evidence.js';
import { contextFor, processIdentity } from '../src/recovery.js';
import { ToolHost, taskTools } from '../src/tools.js';
import { compactAssignmentRound } from '../src/assignment-views.js';
import { assignmentStatus } from '../src/delegation.js';

let dir, previousHome, parent;
test.beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-context-')); previousHome = process.env.BZZY_HOME;
  process.env.BZZY_HOME = path.join(dir, 'private');
  parent = createSession(BUILTINS.codex, dir); prepareTask(parent, { mode: 'delegate' }, 'Solve the supplied local CTF');
  parent.goal = newGoal(parent.contract.objective); saveSession(parent);
});
test.afterEach(() => {
  if (previousHome === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previousHome;
  fs.rmSync(dir, { recursive: true, force: true });
});
function assignment(round = {}, closure = 'open') {
  const id = randomUUID(), job = { id, parentSessionId: parent.id, goalId: parent.goal.id, selection: { provider: 'deepseek', model: 'deepseek-chat' },
    closure, currentRound: 1, createdAt: new Date().toISOString(), latestReport: round };
  putRecord('assignment', id, job); putRecord('round', `${id}:1`, { assignmentId: id, number: 1, state: 'awaiting_review', ...round });
  return job;
}

test('worker recovery includes only its contract, checkpoint and explicitly selected evidence', () => {
  const selected = artifact(parent, 'Only this observation is relevant', 'selected evidence');
  const worker = createSession(BUILTINS.deepseek, dir); worker.role = 'executor'; worker.projectRoot = dir;
  worker.contract = { objective: 'Inspect the supplied response', context: 'Compare the two approved account controls', constraints: ['Keep scope fixed'] };
  worker.allowedArtifactIds = [selected.id]; worker.assignmentId = randomUUID();
  putRecord('checkpoint', worker.id, { pendingActions: ['Read the supplied response'] });
  fs.mkdirSync(path.join(dir, '.bzzy', 'memory'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.bzzy', 'memory', randomUUID() + '.json'), JSON.stringify({ statement: 'UNRELATED-PARENT-LEDGER', rationale: 'x'.repeat(100000) }));
  const context = JSON.parse(contextFor(worker));
  assert.deepEqual(context.contract, worker.contract); assert.equal(context.selectedEvidence[0].id, selected.id);
  assert.equal(context.checkpoint.pendingActions[0], 'Read the supplied response');
  assert.equal(context.relevantMemory, undefined); assert.equal(context.projectContext, undefined); assert.equal(context.assignments, undefined);
  assert.doesNotMatch(JSON.stringify(context), /UNRELATED-PARENT-LEDGER/);
  assert.ok(JSON.stringify(context).length < 2500);
});

test('model status and waits stay bounded while full immutable report remains readable', async () => {
  const worker = createSession(BUILTINS.deepseek, dir); worker.role = 'executor';
  const evidence = artifact(worker, 'Decisive account comparison', 'worker-evidence');
  const raw = { state: 'awaiting_review', summary: 's'.repeat(100000), workerClaim: 'complete',
    report: { status: 'complete', summary: 's'.repeat(100000), evidence: [evidence.id], uncertainties: Array(100).fill('u'.repeat(2000)),
      objections: Array(100).fill({ description: 'o'.repeat(5000), nested: { detail: 'n'.repeat(5000) } }) },
    artifacts: [...Array.from({ length: 250 }, () => ({ id: randomUUID(), label: 'old artifact', size: 100 })), evidence],
    changes: Array.from({ length: 250 }, (_, i) => ({ path: `result-${i}.txt`, before: null, after: { size: 3, sha256: 'abc' } })),
    usage: { tokens: 1200, available: true, modelUsage: { giant: 'm'.repeat(100000) } } };
  const full = artifact(worker, JSON.stringify(raw), 'assignment-report', 'application/json'); raw.reportArtifactId = full.id;
  const job = assignment(raw); job.workerSessionId = worker.id; putRecord('assignment', job.id, job);
  const host = new ToolHost(parent, { event() {} }), status = await host.call('assignment_status', { id: job.id });
  const waited = await host.call('wait_assignment', { id: job.id, timeoutSeconds: 0 });
  assert.equal(status.round.state, 'awaiting_review'); assert.equal(waited.terminal, true);
  assert.equal(status.round.artifactCount, 251); assert.equal(status.round.artifacts.length, 16);
  assert.equal(status.round.artifacts[0].id, evidence.id); assert.equal(status.round.changes.length, 12);
  assert.equal(status.round.reportArtifactId, full.id); assert.ok(JSON.stringify(status).length < 24000);
  assert.ok(JSON.stringify(waited).length < 24000);
  assert.equal(assignmentStatus(job.id).round.artifacts.length, 251, 'public status preserves the complete durable record');
  const opened = await host.call('read_artifact', { id: full.id, limit: 1024 });
  assert.equal(opened.truncated, true); assert.equal(opened.nextOffset, 1024);
  assert.ok(readArtifact(full.id).size > 100000);
  assert.ok(compactAssignmentRound(raw).fullReport.includes('read_artifact'));
});

test('long-running supervisor context keeps active and recent assignments, with paginated older IDs', async () => {
  const active = assignment({ state: 'running', runner: processIdentity(), summary: 'Current bounded task' });
  for (let i = 0; i < 70; i++) assignment({ state: 'awaiting_review', summary: 'r'.repeat(100000), artifacts: Array(200).fill({ id: randomUUID(), label: 'noise' }) }, 'accepted');
  const context = JSON.parse(contextFor(parent));
  assert.equal(context.assignments.length, 12); assert.equal(context.assignments[0].id, active.id);
  assert.equal(context.assignmentHistory.total, 71); assert.equal(context.assignmentHistory.omitted, 59);
  assert.ok(context.assignmentHistory.moreIds.length <= 32); assert.ok(JSON.stringify(context).length < 22000);
  const host = new ToolHost(parent, { event() {} }), first = await host.call('list_assignments', { limit: 20 });
  const second = await host.call('list_assignments', { offset: first.nextOffset, limit: 20 });
  assert.equal(first.total, 71); assert.equal(first.items.length, 20); assert.equal(second.items.length, 20);
  assert.equal(first.items.some(a => second.items.some(b => a.id === b.id)), false);
  assert.ok(JSON.stringify(first).length < 25000);
  await assert.rejects(host.call('list_assignments', { limit: 21 }), /limit/);
});

test('repeated slice inspection imports one immutable copy and retains source provenance', async () => {
  const worker = createSession(BUILTINS.deepseek, dir); worker.role = 'executor';
  const item = artifact(worker, 'abc'.repeat(10000), 'response');
  Object.assign(item, { source: 'response.txt', sourceWorkspace: dir, sourceSha256: item.sha256 }); putRecord('artifact', item.id, item);
  const job = assignment({ state: 'awaiting_review' }); job.workerSessionId = worker.id; putRecord('assignment', job.id, job);
  const host = new ToolHost(parent, { event() {} });
  const first = await host.call('read_artifact', { id: item.id, limit: 100 });
  const second = await host.call('read_artifact', { id: item.id, offset: 100, limit: 100 });
  assert.equal(first.importedEvidenceId, second.importedEvidenceId);
  assert.equal(listRecords('artifact-import').length, 1);
  assert.equal(listRecords('artifact').filter(a => a.sessionId === parent.id).length, 1);
  assert.equal(getRecord('artifact', first.importedEvidenceId).sourceSha256, item.sha256);
  assert.equal(listRecords('artifact-read').length, 2, 'each actually inspected slice remains recorded');
});

test('explicitly shared evidence is readable by the worker, unrelated evidence and invalid waits are rejected', async () => {
  const selected = artifact(parent, 'Shared response', 'selected');
  const other = artifact(parent, 'Not assigned', 'unselected');
  const worker = createSession(BUILTINS.deepseek, dir); worker.role = 'executor'; worker.projectRoot = dir; worker.allowedArtifactIds = [selected.id];
  const child = new ToolHost(worker, { event() {} });
  assert.equal((await child.call('read_artifact', { id: selected.id })).content, 'Shared response');
  await assert.rejects(child.call('read_artifact', { id: other.id }), /outside/);
  const host = new ToolHost(parent, { event() {} });
  const foreignDir = path.join(dir, 'other'); fs.mkdirSync(foreignDir);
  const foreign = artifact(createSession(BUILTINS.codex, foreignDir), 'Private other project evidence', 'foreign');
  const input = { requestId: 'should-not-start', objective: 'Inspect response', context: 'Only compare scoped evidence', acceptanceCriteria: ['Describe the observation'] };
  await assert.rejects(host.call('delegate', { ...input, evidence: [foreign.id] }), /outside/);
  await assert.rejects(host.call('delegate', { ...input, evidence: [selected.id], waitSeconds: 31 }), /waitSeconds/);
  await assert.rejects(host.call('delegate', { ...input, evidence: Array(33).fill(selected.id) }), /at most 32/);
  assert.equal(listRecords('assignment').length, 0);
  const schema = taskTools(parent).find(tool => tool.name === 'delegate').inputSchema;
  assert.equal(schema.properties.evidence.maxItems, 32); assert.equal(schema.properties.waitSeconds.maximum, 30);
});
