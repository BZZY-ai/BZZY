import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSession, saveSession, loadSession } from '../src/engine/store.js';
import { getProvider } from '../src/engine/providers.js';
import { prepareTask } from '../src/engine/task.js';
import { newGoal } from '../src/engine/goals.js';
import { enqueueExecution } from '../src/engine/execution-queue.js';
import { getRecord, putRecord, listRecords, digest, events } from '../src/engine/database.js';
import { executeJob, claimInput } from '../src/engine/runtime.js';
import { enqueueGoalTurn } from '../src/engine/session-operations.js';
import { createMissionContext } from '../src/engine/mission-context.js';
import { saveWorkflow, selectWorkflow, deleteWorkflow, getGoalWorkflow, assertGoalWorkflowAdmission } from '../src/engine/workflows.js';

let previous, directory, project, session;
const text = 'FIRST_WORKFLOW_MARKER\n' + 'Preserve bounded evidence and the original requirement. '.repeat(400) + '\nFINAL_WORKFLOW_MARKER';
const definition = (instructions = text) => ({ name: 'review-process', description: 'Follow a complete reusable process.', instructions });
test.beforeEach(() => {
  previous = process.env.BZZY_HOME; directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-workflow-admit-')));
  process.env.BZZY_HOME = path.join(directory, 'private'); project = path.join(directory, 'project'); fs.mkdirSync(project);
  session = createSession(getProvider('codex'), project, 'offline-model'); prepareTask(session, {}, 'Inspect the supplied fixture.');
  session.goal = newGoal(session.contract.objective); saveSession(session);
});
test.afterEach(() => { if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous; fs.rmSync(directory, { recursive: true, force: true }); });
const queue = (value = session, extra = {}) => enqueueExecution(value.id, { prompt: value.goal.objective, options: {}, goal: true, ...extra }, randomUUID(), { authorize() {} });
const settle = id => putRecord('execution', id, { ...getRecord('execution', id), state: 'finished' });
function selected() {
  const workflow = saveWorkflow(definition(), { cwd: project }); selectWorkflow(session, workflow.name, { expectedRevision: 0 }); return workflow;
}

test('a complete selected workflow is pinned after the goal exists and before its first execution is queued', () => {
  const workflow = selected(), policy = structuredClone(session.policy), objective = session.goal.objective;
  const result = queue(), job = getRecord('execution', result.executionId), saved = loadSession(session.id);
  assert.equal(job.state, 'queued'); assert.equal(job.workflowAdmission.goalId, saved.goal.id);
  assert.equal(job.workflowAdmission.workflowVersion, workflow.version);
  assert.ok(saved.contract.context.includes(text)); assert.match(saved.contract.context, /Build reusable behavior separately/);
  assert.deepEqual(saved.policy, policy); assert.equal(saved.goal.objective, objective); assert.equal(saved.provider, 'codex');
  assert.equal(listRecords('run').length, 0); assertGoalWorkflowAdmission(saved, job.workflowAdmission);
  assert.equal(getGoalWorkflow(session.id).workflow.version, workflow.version);
  const mission = createMissionContext(saved); assert.ok(mission.brief.instructions.includes(text));
  const notices = events(saved.id).filter(event => event.type === 'info' && event.data.message.startsWith('Workflow loaded:'));
  assert.equal(notices.length, 1); assert.equal(notices[0].data.message, `Workflow loaded: ${workflow.name} · ${workflow.version.slice(0, 8)}`);
  assert.equal(notices[0].data.message.includes('FIRST_WORKFLOW_MARKER'), false);
});

test('resuming a pinned goal retains its original workflow after editing, deleting and clearing the future selection', () => {
  const workflow = selected(), first = queue(); settle(first.executionId);
  const saved = loadSession(session.id), originalContext = saved.contract.context; saved.goal.status = 'paused'; saveSession(saved);
  const edited = saveWorkflow(definition('A different process for future goals.'), { cwd: project, expectedRevision: workflow.revision });
  deleteWorkflow(workflow.name, { cwd: project, expectedRevision: edited.revision }); selectWorkflow(saved, null, { expectedRevision: 1 });
  const resumed = queue(saved, { resumeGoal: true }), job = getRecord('execution', resumed.executionId), current = loadSession(session.id);
  assert.equal(current.contract.context, originalContext); assert.equal(job.workflowAdmission.workflowVersion, workflow.version);
  assertGoalWorkflowAdmission(current, job.workflowAdmission);
  assert.equal(events(current.id).filter(event => event.type === 'info' && event.data.message.startsWith('Workflow loaded:')).length, 1);
});

test('a none admission and legacy resume never load a later workflow selection retroactively', () => {
  const first = queue(), empty = getRecord('execution', first.executionId); settle(first.executionId); selected();
  const current = loadSession(session.id); assertGoalWorkflowAdmission(current, empty.workflowAdmission);
  assert.equal(current.contract.context, ''); assert.equal(empty.workflowAdmission.workflowVersion, null);
  const legacy = createSession(getProvider('codex'), project, 'legacy'); prepareTask(legacy, {}, 'Continue the old fixture.');
  legacy.goal = newGoal(legacy.contract.objective); legacy.goal.status = 'paused'; saveSession(legacy);
  selectWorkflow(legacy, 'review-process', { expectedRevision: 0 }); const resumed = queue(legacy, { resumeGoal: true });
  assert.equal(getRecord('execution', resumed.executionId).workflowAdmission.workflowVersion, null);
  assert.equal(loadSession(legacy.id).contract.context, ''); assert.equal(getGoalWorkflow(legacy.id).state, 'legacy');
});

test('deleted selected workflows reject a new /goal atomically without execution or changing the old goal', async () => {
  const workflow = selected(), owner = randomUUID(); claimInput(session.id, owner, true);
  deleteWorkflow(workflow.name, { cwd: project, expectedRevision: workflow.revision }); const before = getRecord('session', session.id);
  await assert.rejects(enqueueGoalTurn(session.id, owner, {}, { objective: 'A new bounded goal.', replaceGoalId: session.goal.id,
    request: async () => ({ execution: null, capabilities: { chatTabs: false }, children: [] }) }), { code: 'WORKFLOW_UNAVAILABLE' });
  assert.deepEqual(getRecord('session', session.id), before); assert.equal(listRecords('execution').length, 0);
  assert.equal(listRecords('core.workflow.goal-binding').length, 0);
});

test('queued workflow instruction changes stop before opening a backend, even when the full workflow block remains', async () => {
  selected(); const queued = queue(), current = loadSession(session.id);
  current.contract.context += '\nA later changed instruction.'; saveSession(current);
  const code = await executeJob(queued.executionId);
  assert.equal(code, 1); assert.equal(getRecord('execution', queued.executionId).state, 'stopped');
  assert.match(getRecord('execution', queued.executionId).error, /complete pinned workflow/);
  assert.equal(listRecords('worker-report').length, 0); assert.equal(loadSession(session.id).engineThreadId, null);
});

test('forged admission metadata, changed versions and changed goal identity cannot establish a host pin', () => {
  const workflow = selected(), queued = queue(), job = getRecord('execution', queued.executionId), current = loadSession(session.id);
  assert.throws(() => assertGoalWorkflowAdmission(current, { ...job.workflowAdmission, fingerprint: '0'.repeat(64) }), { code: 'WORKFLOW_PIN_INVALID' });
  assert.throws(() => assertGoalWorkflowAdmission({ ...current, goal: { ...current.goal, id: randomUUID() } }, job.workflowAdmission), { code: 'WORKFLOW_PIN_INVALID' });
  const version = getRecord('core.workflow.version', digest([workflow.id, workflow.version]));
  putRecord('core.workflow.version', digest([workflow.id, workflow.version]), { ...version, instructions: 'Changed raw instructions.' });
  assert.throws(() => assertGoalWorkflowAdmission(current, job.workflowAdmission), { code: 'WORKFLOW_PIN_INVALID' });
});

test('client workflow receipts are rejected and a later new goal alone adopts a changed selection', () => {
  for (const key of ['workflowAdmission', 'workflowSelection', 'workflowBinding', 'goalWorkflow']) {
    assert.throws(() => queue(session, { options: { [key]: { forged: true } } }), { code: 'INVALID_WORKFLOW' });
  }
  const first = queue(); settle(first.executionId); selected();
  const fresh = loadSession(session.id); prepareTask(fresh, {}, 'A distinct next goal.'); fresh.goal = newGoal(fresh.contract.objective); saveSession(fresh);
  const next = queue(fresh), job = getRecord('execution', next.executionId);
  assert.notEqual(job.workflowAdmission.goalId, getRecord('execution', first.executionId).workflowAdmission.goalId);
  assert.notEqual(job.workflowAdmission.workflowVersion, null); assert.ok(loadSession(session.id).contract.context.includes(text));
});

test('known model context limits reject unfit workflows before queueing and again before dispatch', async () => {
  selected(); session.modelCapabilities = { contextWindow: 1000 }; saveSession(session);
  assert.throws(() => queue(), { code: 'WORKFLOW_CONTEXT_LIMIT' });
  assert.equal(listRecords('execution').length, 0); assert.equal(listRecords('core.workflow.goal-binding').length, 0);
  session.modelCapabilities.contextWindow = 200000; saveSession(session);
  const queued = queue(), current = loadSession(session.id); current.modelCapabilities.contextWindow = 1000; saveSession(current);
  assert.equal(await executeJob(queued.executionId), 1);
  assert.match(getRecord('execution', queued.executionId).error, /conservative input budget/);
  assert.equal(loadSession(session.id).engineThreadId, null);
  assert.throws(() => queue(loadSession(session.id), { resumeGoal: true }), { code: 'WORKFLOW_CONTEXT_LIMIT' });
});

test('optional none and legacy resumes do not add workflow context restrictions', () => {
  session.modelCapabilities = { contextWindow: 1 }; saveSession(session);
  const queued = queue(); assert.equal(getRecord('execution', queued.executionId).workflowAdmission.workflowVersion, null);
  settle(queued.executionId); selected();
  const legacy = createSession(getProvider('codex'), project, 'legacy'); prepareTask(legacy, {}, 'Continue the old fixture.');
  legacy.goal = newGoal(legacy.contract.objective); legacy.goal.status = 'paused'; legacy.modelCapabilities = { contextWindow: 1 }; saveSession(legacy);
  selectWorkflow(legacy, 'review-process', { expectedRevision: 0 });
  const resumed = queue(legacy, { resumeGoal: true }); assert.equal(getRecord('execution', resumed.executionId).workflowAdmission.workflowVersion, null);
});
