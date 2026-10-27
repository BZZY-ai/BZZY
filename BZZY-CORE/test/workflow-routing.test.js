import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createSession, saveSession, loadSession } from '../src/engine/store.js';
import { getProvider } from '../src/engine/providers.js';
import { normalizeContract, normalizePolicy } from '../src/engine/contracts.js';
import { newGoal } from '../src/engine/goals.js';
import { getRecord, putRecord, listRecords, now, events, appendEvent } from '../src/engine/database.js';
import { saveWorkflow, selectWorkflow, preflightGoalWorkflow, normalizeWorkflow, importWorkflow } from '../src/engine/workflows.js';
import { saveSubagentDefinition, getSubagentDefinition, setSubagentEnabled } from '../src/engine/subagent-definitions.js';
import { declareWorkUnit, closeWorkUnit, routingStatus, assertRoutingCompletion, recordRoutingSpecialistRead, recordRoutingSkillRead } from '../src/engine/workflow-routing.js';
import { spawnSubagent } from '../src/engine/subagents.js';
import { artifact, snapshotWorkspace } from '../src/engine/evidence.js';
import { reviewAssignment, followupAssignment } from '../src/engine/delegation.js';
import { importSkill, setSkillEnabled, readSkill } from '../src/engine/skills.js';
import { ToolHost } from '../src/engine/tools.js';
import { specialistCatalogInstructions } from '../src/engine/specialist-catalog.js';
import { portableState } from '../src/engine/share-bundle-policy.js';
import { assessCompletion } from '../src/engine/verification.js';
import { conversationPrompt } from '../src/engine/conversation.js';

const pack = fileURLToPath(new URL('../assets/bug-bounty/', import.meta.url));
const packInput = () => JSON.parse(fs.readFileSync(path.join(pack, 'bug-bounty-methodology.json'), 'utf8'));
let directory, previousHome, parent, context, launches;
test.beforeEach(() => {
  previousHome = process.env.BZZY_HOME; directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-routing-')));
  process.env.BZZY_HOME = path.join(directory, 'private'); const cwd = path.join(directory, 'project'); fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd, 'fixture.txt'), 'Offline authorized baseline.');
  parent = createSession(getProvider('codex'), cwd, 'offline-routing-model'); parent.policy = normalizePolicy();
  parent.modelCapabilities = { contextWindow: 131072 }; parent.contract = normalizeContract({}, 'Assess the supplied offline fixture.');
  parent.goal = newGoal(parent.contract.objective, 200000); parent.executionState = 'running'; saveSession(parent);
  context = { goalMode: true, runId: randomUUID(), launch: (id, round) => launches.push({ id, round }) }; launches = [];
  putRecord('run', parent.id, { id: context.runId, sessionId: parent.id, state: 'running', goalMode: true, startedAt: now() });
});
test.afterEach(() => {
  if (previousHome === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previousHome;
  fs.rmSync(directory, { recursive: true, force: true });
});
function bind(input = packInput()) {
  const workflow = saveWorkflow(input, { cwd: parent.cwd });
  selectWorkflow(parent, workflow.name, { expectedRevision: 0 }); preflightGoalWorkflow(parent); return workflow;
}
function define(name = 'ssrf-agent', extra = {}) {
  return saveSubagentDefinition({ name, description: 'Inspect authorized offline request-forwarding observations.',
    instructions: 'Compare only the supplied offline baseline and control. Return evidence and uncertainty.', ...extra }, { cwd: parent.cwd });
}
const unitInput = (extra = {}) => ({ requestId: 'hypothesis-1', classId: 'ssrf', hypothesis: 'The supplied import fixture forwards an attacker-controlled URL.', ...extra });
function spawn(unit, extra = {}) {
  return spawnSubagent(parent, { name: 'ssrf-agent', requestId: 'assignment-1', objective: 'Compare the supplied offline request-forwarding baseline.', workUnitId: unit.id, ...extra }, context);
}
async function accepted(jobId) {
  const snapshot = snapshotWorkspace(parent), workspace = path.join(directory, 'isolated-worker'); fs.cpSync(parent.cwd, workspace, { recursive: true });
  const job = getRecord('assignment', jobId), worker = createSession(getProvider('codex'), workspace, 'offline-worker');
  Object.assign(worker, { role: 'executor', parentSessionId: parent.id, assignmentId: jobId, assignmentRound: 1, contract: job.contract,
    policy: job.contract.policy, missionContext: job.missionContext }); saveSession(worker);
  const evidence = artifact(worker, 'Supplied offline baseline and decisive negative control.', 'routing-proof');
  const round = { ...getRecord('round', `${jobId}:1`), state: 'awaiting_review', changes: [], report: { status: 'partial', evidence: [evidence.id] }, finishedAt: now() };
  putRecord('round', `${jobId}:1`, round); putRecord('assignment', jobId, { ...job, snapshotId: snapshot.id, workspace, workerSessionId: worker.id, latestReport: { ...round, round: 1 } });
  const host = new ToolHost(parent, { event() {} }, context); await host.call('read_artifact', { id: evidence.id });
  return reviewAssignment(parent, jobId, { outcome: 'accepted', rationale: 'Inspected the supplied baseline and decisive control; this accepts the bounded work only.', evidence: [evidence.id] });
}

test('the exact shipped v2 pack declares 25 explicit bounded routes without starting work', () => {
  const input = packInput(), workflow = normalizeWorkflow(input); assert.equal(workflow.schemaVersion, 2);
  assert.equal(workflow.routing.rules.length, 25); assert.ok(workflow.routing.rules.every(rule => rule.reportSkills[0] === 'vuln-report-writer'));
  assert.equal(workflow.instructions.trim(), fs.readFileSync(path.join(pack, 'bug-bounty-methodology.md'), 'utf8').trim());
  const imported = importWorkflow(path.join(pack, 'bug-bounty-methodology.json'), { cwd: parent.cwd, name: input.name });
  assert.deepEqual(imported.routing, input.routing); assert.equal(listRecords('assignment').length, 0);
  assert.throws(() => normalizeWorkflow({ ...input, routing: { ...input.routing, permission: 'all' } }), /Routing/);
  assert.throws(() => normalizeWorkflow({ ...input, routing: { ...input.routing, rules: [{ ...input.routing.rules[0], allowedDispositions: ['manual'] }] } }), /dispositions/);
});

test('legacy text workflows remain advisory across resume and never gain v2 routing from a new selection', () => {
  bind({ name: 'legacy', instructions: 'Use specialists when relevant.' });
  assert.deepEqual(routingStatus(parent), { enforced: false, goalId: parent.goal.id, reason: 'legacy-or-no-routing-contract' });
  assert.doesNotThrow(() => assertRoutingCompletion(parent));
  const next = saveWorkflow(packInput(), { cwd: parent.cwd }); selectWorkflow(parent, next.name, { expectedRevision: 1 });
  preflightGoalWorkflow(parent, { resumeGoal: true }); assert.equal(routingStatus(parent).enforced, false);
});

test('a required matching specialist is read, pinned, assigned once and actually reviewed before closure', async () => {
  define(); bind(); assert.throws(() => assertRoutingCompletion(parent), /declared/);
  const unit = declareWorkUnit(parent, unitInput(), context);
  assert.deepEqual(declareWorkUnit(parent, unitInput(), context), unit); assert.throws(() => declareWorkUnit(parent, unitInput({ hypothesis: 'Different bounded hypothesis.' }), context), /different input/);
  assert.throws(() => spawn(unit), /Read the admitted specialist/);
  recordRoutingSpecialistRead(parent, getSubagentDefinition('ssrf-agent', { cwd: parent.cwd }), context);
  const job = spawn(unit); assert.equal(job.subagentRouting.workUnitId, unit.id); assert.equal(launches.length, 1);
  assert.equal(spawn(unit).id, job.id); assert.equal(launches.length, 1);
  assert.throws(() => spawn(unit, { requestId: 'different-assignment' }), /already has an assignment/);
  assert.throws(() => closeWorkUnit(parent, { id: unit.id, outcome: 'investigated', rationale: 'The worker was merely started.', assignmentId: job.id }, context), /Finish or stop|accepted-evidence-reviewed/);
  await accepted(job.id);
  const closure = { id: unit.id, outcome: 'investigated', rationale: 'The bounded hypothesis was investigated with inspected evidence.', assignmentId: job.id };
  closeWorkUnit(parent, closure, context); closeWorkUnit(parent, closure, context); assert.doesNotThrow(() => assertRoutingCompletion(parent));
  assert.equal(events(parent.id, 0, 1000).filter(event => event.type === 'workflow.routing.closed').length, 1);
  assert.equal(events(parent.id, 0, 1000).filter(event => event.type === 'workflow.routing.reviewed').length, 1);
  assert.equal(listRecords('core.workflow.work-unit').length, 1);
});

test('missing and OFF specialists produce explicit permitted blockers, never fallback or automatic enablement', () => {
  const definition = define(); setSubagentEnabled(definition.name, false, { cwd: parent.cwd, expectedRevision: definition.revision }); bind();
  const unit = declareWorkUnit(parent, unitInput(), context); assert.equal(unit.specialist.available, false);
  assert.throws(() => spawn(unit), /disabled/); assert.throws(() => closeWorkUnit(parent, { id: unit.id, outcome: 'investigated', rationale: 'No specialist was called.' }, context), /consultation is incomplete/);
  closeWorkUnit(parent, { id: unit.id, outcome: 'blocked', rationale: 'The required specialist is disabled; no test result is inferred.' }, context);
  assert.equal(routingStatus(parent).blocked, 1); assert.equal(launches.length, 0);
  const missing = declareWorkUnit(parent, unitInput({ requestId: 'missing-idor', classId: 'idor' }), context); assert.equal(missing.specialist.reason, 'missing-or-disabled');
  closeWorkUnit(parent, { id: missing.id, outcome: 'not_applicable', rationale: 'The supplied offline fixture has no object-authorization operation.' }, context);
  assert.throws(() => assertRoutingCompletion(parent), /requires declared/);
  assert.equal(routingStatus(parent).covered, 0);
  const replacement = declareWorkUnit(parent, unitInput({ requestId: 'replacement-after-scope-review', supersedes: unit.id }), context);
  closeWorkUnit(parent, { id: replacement.id, outcome: 'policy_excluded', rationale: 'Current authorization excludes the request-forwarding operation; no test is claimed.' }, context);
  assert.doesNotThrow(() => assertRoutingCompletion(parent));
});

test('changed definitions require explicit replacement and closed units cannot restart their old worker', () => {
  const original = define(); bind(); const unit = declareWorkUnit(parent, unitInput(), context);
  recordRoutingSpecialistRead(parent, getSubagentDefinition('ssrf-agent', { cwd: parent.cwd }), context);
  const revised = saveSubagentDefinition({ name: original.name, description: original.description,
    instructions: 'Inspect the supplied revised offline baseline; preserve explicit uncertainty.' }, { cwd: parent.cwd, expectedRevision: original.revision });
  assert.throws(() => spawn(unit), /exact admitted enabled specialist/); assert.equal(launches.length, 0);
  closeWorkUnit(parent, { id: unit.id, outcome: 'blocked', rationale: 'The admitted definition changed before execution.' }, context);
  const replacement = declareWorkUnit(parent, unitInput({ requestId: 'revised-hypothesis', supersedes: unit.id }), context);
  assert.equal(replacement.specialist.version, revised.version);
  recordRoutingSpecialistRead(parent, getSubagentDefinition('ssrf-agent', { cwd: parent.cwd }), context);
  const job = spawn(replacement);
  assert.throws(() => closeWorkUnit(parent, { id: replacement.id, outcome: 'blocked', rationale: 'The active worker has not stopped.' }, context), /Finish or stop/);
  putRecord('round', `${job.id}:1`, { ...getRecord('round', `${job.id}:1`), state: 'interrupted', finishedAt: now() });
  closeWorkUnit(parent, { id: replacement.id, outcome: 'blocked', rationale: 'The worker stopped before obtaining the supplied baseline.' }, context);
  assert.throws(() => followupAssignment(parent, job.id, { requestId: 'forbidden-restart', feedback: 'Continue the old worker.', objective: 'Repeat the bounded check.' }, { launch: context.launch }), /closed or superseded/);
  assert.equal(launches.length, 1); assert.equal(routingStatus(parent).blocked, 1);
});

test('confirmed units need full pinned reporting-skill reads; partial reads and generic workers cannot satisfy consultation', async () => {
  define(); const reporter = importSkill(path.join(pack, 'vuln-report-writer'), { scope: 'global' }); setSkillEnabled(reporter.name, true, reporter.revision, { scope: 'global' }); bind();
  const unit = declareWorkUnit(parent, unitInput(), context); recordRoutingSpecialistRead(parent, getSubagentDefinition('ssrf-agent', { cwd: parent.cwd }), context);
  const job = spawn(unit); await accepted(job.id);
  const generic = { ...getRecord('assignment', job.id), id: randomUUID(), subagentRouting: null }; putRecord('assignment', generic.id, generic);
  const closure = { id: unit.id, outcome: 'confirmed', rationale: 'The supplied evidence supports the bounded fixture mechanism.', assignmentId: job.id };
  assert.throws(() => closeWorkUnit(parent, { ...closure, assignmentId: generic.id }, context), /matching-specialist/);
  const partial = readSkill(reporter.name, { session: parent, limit: 100 }); recordRoutingSkillRead(parent, partial, { offset: 0 }, context);
  assert.throws(() => closeWorkUnit(parent, closure, context), /read_skill:vuln-report-writer/);
  let offset = 100;
  while (offset !== null) { const skill = readSkill(reporter.name, { session: parent, offset, limit: 32768 }); recordRoutingSkillRead(parent, skill, { offset }, context); offset = skill.nextOffset; }
  closeWorkUnit(parent, closure, context); assert.doesNotThrow(() => assertRoutingCompletion(parent));
});

test('provider changes retain current-goal receipts but stops and new goals reject old work-unit authority', () => {
  define(); bind(); const unit = declareWorkUnit(parent, unitInput(), context);
  parent.provider = 'deepseek'; parent.backend = 'codex'; parent.model = 'deepseek-chat'; saveSession(parent);
  assert.equal(declareWorkUnit(parent, unitInput(), context).id, unit.id);
  parent.executionState = 'paused'; saveSession(parent);
  assert.throws(() => closeWorkUnit(parent, { id: unit.id, outcome: 'blocked', rationale: 'Stopped by the owner.' }, context), /current live goal/);
  parent.executionState = 'running'; parent.goal = newGoal(parent.contract.objective); saveSession(parent); preflightGoalWorkflow(parent);
  assert.throws(() => closeWorkUnit(parent, { id: unit.id, outcome: 'blocked', rationale: 'Old goal cannot satisfy this goal.' }, context), /another goal/);
});

test('durable owner stop intent blocks routing before the running session snapshot catches up', () => {
  define(); bind(); const unit = declareWorkUnit(parent, unitInput(), context), runtime = path.join(process.env.BZZY_HOME, 'runtime'); fs.mkdirSync(runtime, { recursive: true });
  fs.writeFileSync(path.join(runtime, 'operator-stop.json'), JSON.stringify({ stopped: true }));
  assert.throws(() => closeWorkUnit(parent, { id: unit.id, outcome: 'blocked', rationale: 'Owner stop is pending.' }, context), /durably stopped/);
  fs.rmSync(path.join(runtime, 'operator-stop.json'));
  putRecord('execution', 'synthetic-current-stop', { id: 'synthetic-current-stop', sessionId: parent.id, state: 'running', stopAction: 'cancel' });
  assert.throws(() => declareWorkUnit(parent, unitInput({ requestId: 'late-route' }), context), /durably stopped/);
  assert.equal(getRecord('core.workflow.work-unit', unit.id).state, 'open'); assert.equal(launches.length, 0);
});

test('deletion tombstones reject late direct routing writes and cannot report a passed completion gate', () => {
  define(); bind(); const unit = declareWorkUnit(parent, unitInput(), context), definition = getSubagentDefinition('ssrf-agent', { cwd: parent.cwd });
  putRecord('session-deletion', parent.id, { sessionId: parent.id, deletedAt: now() });
  assert.throws(() => declareWorkUnit(parent, unitInput({ requestId: 'late-deleted' }), context), /current live goal/);
  assert.throws(() => closeWorkUnit(parent, { id: unit.id, outcome: 'blocked', rationale: 'Late result after deletion.' }, context), /current live goal/);
  assert.equal(recordRoutingSpecialistRead(parent, definition, context), null); assert.equal(listRecords('core.workflow.consultation').length, 0);
  assert.equal(routingStatus(parent).reason, 'SESSION_DELETED'); assert.throws(() => assertRoutingCompletion(parent), /requires declared/);
  assert.equal(listRecords('core.workflow.work-unit').length, 1);
});

test('stored work-unit claims cannot replace requirements from the original workflow pin', () => {
  const workflow = packInput(); workflow.routing.rules = [{ ...workflow.routing.rules[0], allowedDispositions: ['blocked'] }]; bind(workflow);
  const unit = declareWorkUnit(parent, unitInput(), context), stored = getRecord('core.workflow.work-unit', unit.id);
  putRecord('core.workflow.work-unit', unit.id, { ...stored, state: 'closed', outcome: 'policy_excluded', allowedDispositions: ['policy_excluded'] });
  assert.throws(() => assertRoutingCompletion(parent), /original pinned workflow/);
});

test('routing cannot bypass worker budgets or policy and specialist catalog metadata stays bounded', () => {
  define('ssrf-agent', { capabilities: { version: 1, tags: ['ssrf', 'web-api'] } }); bind();
  const unit = declareWorkUnit(parent, unitInput(), context); recordRoutingSpecialistRead(parent, getSubagentDefinition('ssrf-agent', { cwd: parent.cwd }), context);
  parent.goal.tokenBudget = 0; saveSession(parent); assert.throws(() => spawn(unit), /budget/); assert.equal(launches.length, 0);
  parent.goal.tokenBudget = 200000; parent.policy.mode = 'read-only'; parent.contract.policy = parent.policy; saveSession(parent);
  // Changing execution policy invalidates a previously pinned mission only at
  // assignment admission; requests may narrow, never widen the actual parent.
  assert.throws(() => spawn(unit, { policy: { mode: 'workspace-write', writablePaths: ['.'] } }), /read-only|widen|policy|permission/i);
  const catalog = specialistCatalogInstructions(parent, { maxBytes: 1024 }); assert.ok(Buffer.byteLength(catalog) < 3000); assert.match(catalog, /web-api/);
  assert.equal(specialistCatalogInstructions({ ...parent, role: 'executor' }), ''); assert.equal(launches.length, 0);
});

test('model-facing tool dispatch creates real consultation receipts and common completion rejects missing routing', async () => {
  define(); bind(); const host = new ToolHost(parent, { event() {} }, context);
  assert.equal((await assessCompletion(parent)).passed, false);
  const unit = await host.call('declare_work_unit', unitInput()); assert.equal(unit.workUnitId, unit.id);
  await host.call('read_subagent', { name: 'ssrf-agent' });
  const job = await host.call('spawn_subagent', { name: 'ssrf-agent', requestId: 'model-spawn', workUnitId: unit.id,
    objective: 'Compare only the supplied offline baseline.', waitSeconds: 0 });
  await accepted(job.id);
  await host.call('close_work_unit', { id: unit.id, outcome: 'investigated', assignmentId: job.id,
    rationale: 'The supplied fixture was investigated with the required independent evidence review.' });
  assert.equal((await assessCompletion(parent)).routing.passed, true);
  const receipt = listRecords('core.workflow.consultation').find(value => value.kind === 'specialist'); assert.equal(receipt.goalId, parent.goal.id);
  assert.equal(listRecords('core.usage').filter(value => value.kind === 'skill').length, 0, 'host routing receipts never invent model skill usage');
  const shared = portableState({ records: [{ kind: 'assignment', id: job.id, data: { subagentRouting: { workUnitId: unit.id }, label: 'Historical assignment.' } },
    ...listRecords('core.workflow.work-unit').map(value => ({ kind: 'core.workflow.work-unit', id: value.id, data: value }))], events: [] });
  assert.equal(shared.records.length, 1); assert.equal(shared.records[0].data.subagentRouting, undefined);
});

test('native refresh always prepares current host context without requiring an existing memory summary', () => {
  bind(); parent.nativeContext = { epoch: 4, refresh: { state: 'pending', epoch: 4 } }; saveSession(parent);
  const request = 'Preserve this exact current request, controls and current goal.';
  const prepared = conversationPrompt(parent, request);
  assert.match(prepared, /BZZY CURRENT STATE CAPSULE/); assert.ok(prepared.includes(parent.goal.id)); assert.ok(prepared.includes(request));
  assert.equal(parent.nativeContext.refresh.state, 'pending'); assert.equal(parent.nativeContext.refresh.preparedEpoch, 4);
  assert.equal(conversationPrompt({ ...parent, role: 'learning-review' }, request), request);
  const worker = createSession(getProvider('codex'), parent.cwd, 'offline-worker');
  Object.assign(worker, { role: 'executor', parentSessionId: parent.id, nativeContext: { refresh: { state: 'pending', epoch: 4 } } }); saveSession(worker);
  assert.doesNotMatch(conversationPrompt(worker, request), /BZZY CURRENT STATE CAPSULE/);
  appendEvent(parent.id, 'message.user', { text: 'OLD_HANDOFF_ONLY_MARKER' }); parent.conversationHandoff = { pending: true,
    throughSeq: events(parent.id, 0, 1000).at(-1).seq };
  const compact = conversationPrompt(parent, request, { compactDerived: true });
  assert.ok(compact.includes(request)); assert.match(compact, /read_task_state_details/); assert.match(compact, /list_subagents/);
  assert.doesNotMatch(compact, /OLD_HANDOFF_ONLY_MARKER/); assert.equal(parent.conversationHandoff.pending, true);
});

test('empty-library chat preserves raw input and cannot inherit an older v2 goal routing instruction', () => {
  putRecord('run', parent.id, { ...getRecord('run', parent.id), goalMode: false });
  const plain = 'Repeat this exact empty-library request.';
  assert.equal(conversationPrompt(parent, plain), plain);
  bind(); parent.goal.status = 'paused'; saveSession(parent);
  const prepared = conversationPrompt(parent, plain);
  assert.equal(prepared, plain); assert.doesNotMatch(prepared, /BZZY STRUCTURED ROUTING|declare_work_unit/);
  assert.equal(routingStatus(parent).enforced, true, 'metrics may still inspect the saved historical goal without applying it to chat');
});
