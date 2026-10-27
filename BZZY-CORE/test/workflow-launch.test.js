import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createChatSession, openOrCreateChatSession, createTaskSession, applyLaunchWorkflow, prepareResume } from '../src/engine/host-commands.js';
import { getProvider } from '../src/engine/providers.js';
import { saveWorkflow, deleteWorkflow, workflowSelection, getGoalWorkflow } from '../src/engine/workflows.js';
import { listRecords } from '../src/engine/database.js';
import { enqueueExecution } from '../src/engine/execution-queue.js';

let directory, previous;
test.beforeEach(() => {
  previous = process.env.BZZY_HOME; directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-launch-workflow-')));
  process.env.BZZY_HOME = path.join(directory, 'private');
});
test.afterEach(() => {
  if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
  fs.rmSync(directory, { recursive: true, force: true });
});
const options = () => ({ provider: 'codex', model: 'offline-model', cwd: directory });

test('workflow launch selects scoped instructions without starting work; named attachment can select or clear future workflows', async () => {
  const global = saveWorkflow({ name: 'review-process', instructions: 'GLOBAL_PROCESS: retain attribution.' }, { scope: 'global' });
  const project = saveWorkflow({ name: 'review-process', instructions: 'PROJECT_PROCESS: read supplied controls.' }, { cwd: directory });
  const opened = await openOrCreateChatSession('workflow-chat', { ...options(), workflow: project.name });
  assert.equal(workflowSelection(opened.session.id).selected.id, project.id); assert.equal(opened.session.goal, null);
  assert.equal(listRecords('execution').length, 0);
  const same = await openOrCreateChatSession('workflow-chat', { ...options(), workflow: 'none' });
  assert.equal(same.session.id, opened.session.id); assert.equal(workflowSelection(opened.session.id).selected, null);
  const standalone = createChatSession(getProvider('codex'), { ...options(), workflow: project.name });
  assert.equal(workflowSelection(standalone.id).selected.id, project.id);
  assert.notEqual(project.id, global.id);
});

for (const idempotent of [false, true]) test(`new goal launch pins its workflow before admission (${idempotent ? 'request ID' : 'ordinary'})`, () => {
  const first = saveWorkflow({ name: 'first-process', instructions: 'FIRST_PROCESS: inspect supplied original evidence.' }, { cwd: directory });
  const second = saveWorkflow({ name: 'second-process', instructions: 'SECOND_PROCESS: retain current criteria.' }, { cwd: directory });
  const settings = { ...options(), workflow: first.name, ...(idempotent ? { requestId: randomUUID() } : {}) };
  const created = createTaskSession(getProvider('codex'), settings, 'Inspect supplied response evidence', { goal: true });
  const queued = enqueueExecution(created.session.id, { prompt: created.session.goal.objective, goal: true, options: {} }, randomUUID(), { authorize() {} });
  assert.ok(queued.executionId); assert.equal(getGoalWorkflow(created.session.id).workflow.id, first.id);
  applyLaunchWorkflow(created.session, second.name);
  assert.equal(workflowSelection(created.session.id).selected.id, second.id);
  assert.equal(getGoalWorkflow(created.session.id).workflow.id, first.id, 'Changing launch selection cannot rewrite the running goal');
  assert.throws(() => prepareResume(created.session, { workflow: second.name }), /keep their saved workflow/);
  if (idempotent) {
    deleteWorkflow(first.name, { cwd: directory, expectedRevision: first.revision });
    const retry = createTaskSession(getProvider('codex'), settings, created.session.goal.objective, { goal: true });
    assert.equal(retry.session.id, created.session.id); assert.equal(retry.existingExecution, true);
    assert.equal(getGoalWorkflow(created.session.id).workflow.id, first.id);
    assert.equal(listRecords('session').length, 1);
  }
});

test('an unknown workflow fails before creating a chat, named chat or goal', async () => {
  assert.throws(() => createChatSession(getProvider('codex'), { ...options(), workflow: 'missing' }));
  await assert.rejects(openOrCreateChatSession('missing-workflow-chat', { ...options(), workflow: 'missing' }));
  assert.throws(() => createTaskSession(getProvider('codex'), { ...options(), workflow: 'missing', requestId: randomUUID() }, 'Inspect evidence', { goal: true }));
  assert.equal(listRecords('session').length, 0); assert.equal(listRecords('core.workflow.selection').length, 0);
  assert.equal(listRecords('execution').length, 0);
  assert.equal(fs.existsSync(path.join(directory, '.bzzy')), false);
});
