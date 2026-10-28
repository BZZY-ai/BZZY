import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSession, loadSession, saveSession } from '../src/engine/store.js';
import { getProvider } from '../src/engine/providers.js';
import { normalizePolicy } from '../src/engine/contracts.js';
import { initializeProject } from '../src/engine/project.js';
import { getRecord, putRecord, listRecords, now } from '../src/engine/database.js';
import { processIdentity } from '../src/engine/recovery.js';
import { getSubagentDefinition, listSubagentDefinitions, saveSubagentDefinition, setSubagentEnabled,
  getSubagentDefinitionVersion, assertSubagentDefinitionPin } from '../src/engine/subagent-definitions.js';
import { spawnSubagent, followupSubagent } from '../src/engine/subagents.js';
import { startAssignment, followupAssignment, runAssignment, recordWorkerReport } from '../src/engine/delegation.js';
import { ToolHost } from '../src/engine/tools.js';
import { subagentsCLI } from '../src/engine/subagents-cli.js';

let directory, previousHome, parent, launches;
test.beforeEach(() => {
  previousHome = process.env.BZZY_HOME;
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-agent-enablement-')));
  process.env.BZZY_HOME = path.join(directory, 'private');
  const cwd = path.join(directory, 'project'); fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd, 'supplied.txt'), 'Synthetic response for inspection.');
  parent = createSession(getProvider('codex'), cwd, 'offline-parent');
  parent.mode = 'solo'; parent.policy = normalizePolicy(); initializeProject(parent); saveSession(parent);
  launches = [];
});
test.afterEach(() => {
  if (previousHome === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previousHome;
  fs.rmSync(directory, { recursive: true, force: true });
});

const definition = (extra = {}) => ({ name: 'http-analyst', description: 'Inspect supplied HTTP evidence.',
  instructions: 'Inspect the supplied synthetic evidence and retain uncertainty.', ...extra });
const define = (extra = {}, options = {}) => saveSubagentDefinition(definition(extra), { cwd: parent.cwd, ...options });
const toggle = (record, value, options = {}) => setSubagentEnabled(record.name, value,
  { cwd: parent.cwd, scope: record.scope, expectedRevision: record.revision, ...options });
const request = (extra = {}) => ({ name: 'http-analyst', requestId: randomUUID(), objective: 'Inspect the supplied response.', waitSeconds: 0, ...extra });
function beginRun() {
  parent.executionState = 'running'; saveSession(parent);
  const run = { id: randomUUID(), sessionId: parent.id, state: 'running', runner: processIdentity(), startedAt: now() };
  putRecord('run', parent.id, run);
  return { goalMode: false, runId: run.id, prompt: 'Inspect the supplied response.', launch: (id, round) => launches.push({ id, round }) };
}
function finishRound(id) {
  const job = getRecord('assignment', id), round = { ...getRecord('round', `${id}:1`), state: 'awaiting_review',
    report: { status: 'partial', summary: 'Synthetic evidence remains for owner review.', evidence: [] },
    usage: { tokens: 0, available: true, accountingComplete: true, elapsedSeconds: 0 },
    changes: [], artifacts: [], finishedAt: now() };
  putRecord('round', `${id}:1`, round); putRecord('assignment', id, { ...job, latestReport: round });
}

test('CAS availability metadata defaults legacy agents on and preserves immutable pins, owner history and edits', () => {
  const created = define(), originalPin = getSubagentDefinitionVersion(created.id, created.version);
  assert.equal(created.enabled, true);
  const stored = getRecord('core.subagent.definition', created.id); delete stored.enabled;
  putRecord('core.subagent.definition', stored.id, stored);
  assert.equal(getSubagentDefinition(created.name, { cwd: parent.cwd }).enabled, true);
  const disabled = toggle(created, false);
  assert.equal(disabled.enabled, false); assert.equal(disabled.revision, 2); assert.equal(disabled.version, created.version);
  assert.equal(listSubagentDefinitions({ cwd: parent.cwd }).subagents[0].enabled, false);
  assert.deepEqual(getSubagentDefinitionVersion(created.id, created.version), originalPin);
  assert.deepEqual(assertSubagentDefinitionPin(created), created);
  assert.throws(() => toggle(created, true), { code: 'CONFLICT' });
  assert.throws(() => toggle(disabled, 'true')); assert.throws(() => toggle(disabled, true, { expectedRevision: 0 }));
  assert.equal(toggle(disabled, false).revision, disabled.revision, 'a no-op does not invent a catalog revision');
  const edited = define({ instructions: 'Inspect a narrowed synthetic baseline.' }, { expectedRevision: disabled.revision });
  assert.equal(edited.enabled, false); assert.notEqual(edited.version, created.version);
  const enabled = toggle(edited, true);
  assert.equal(enabled.enabled, true); assert.equal(enabled.version, edited.version);
  assert.equal(listRecords('core.subagent.definition.version').length, 2);
  assert.equal(listRecords('assignment').length, 0); assert.equal(listRecords('execution').length, 0);
});

test('disabled local overrides stay visible to the owner and never fall back to an enabled global specialist', async () => {
  const global = define({}, { scope: 'global' }), local = define({ instructions: 'Use this project-specific supplied baseline.' });
  const disabled = toggle(local, false), context = beginRun(), host = new ToolHost(parent, { event() {} }, context);
  assert.equal(listSubagentDefinitions({ cwd: parent.cwd }).subagents[0].id, disabled.id);
  assert.equal((await host.call('list_subagents', {})).total, 0);
  await assert.rejects(() => host.call('read_subagent', { name: local.name }), { code: 'SUBAGENT_DISABLED' });
  await assert.rejects(() => host.call('spawn_subagent', request()), { code: 'SUBAGENT_DISABLED' });
  assert.equal(listRecords('assignment').length, 0); assert.equal(launches.length, 0);
  const foreign = path.join(directory, 'foreign'); fs.mkdirSync(foreign);
  assert.equal(getSubagentDefinition(local.name, { cwd: foreign, enabledOnly: true }).id, global.id);
  assert.throws(() => setSubagentEnabled(local.name, true, { cwd: foreign, expectedRevision: disabled.revision }), { code: 'CONFLICT' });
  assert.equal(getSubagentDefinition(local.name, { cwd: parent.cwd }).enabled, false);
  toggle(disabled, true);
  assert.equal((await host.call('list_subagents', {})).subagents[0].id, local.id);
});

for (const providerId of ['codex', 'claude', 'deepseek', 'abliteration', 'orcarouter', 'experiential']) {
  test(`the current ${providerId} model cannot bypass an off specialist, and can invoke it after re-enable`, async () => {
    const created = define(), disabled = toggle(created, false), provider = getProvider(providerId);
    parent = createSession(provider, parent.cwd, provider.model || 'offline-model');
    parent.mode = 'solo'; parent.policy = normalizePolicy(); parent.selectedEffort = 'high';
    parent.modelCapabilities = { supportedEfforts: ['low', 'high'], contextWindow: 64000 }; saveSession(parent);
    const context = beginRun(), host = new ToolHost(parent, { event() {} }, context);
    assert.equal((await host.call('list_subagents', {})).total, 0);
    await assert.rejects(() => host.call('spawn_subagent', request()), { code: 'SUBAGENT_DISABLED' });
    assert.equal(launches.length, 0); assert.equal(listRecords('assignment').length, 0);
    toggle(disabled, true);
    const spawned = await host.call('spawn_subagent', request());
    assert.equal(launches.length, 1); assert.equal(getRecord('assignment', spawned.id).selection.provider, providerId);
  });
}

test('copied on metadata cannot bypass authoritative admission or start a queued worker after it was disabled', async () => {
  const created = define(), context = beginRun(), pending = spawnSubagent(parent, request(), context);
  assert.equal(launches.length, 1); const disabled = toggle(created, false);
  await runAssignment(pending.id, 1);
  assert.equal(getRecord('round', `${pending.id}:1`).state, 'paused');
  assert.match(getRecord('round', `${pending.id}:1`).reason, /disabled/i);
  assert.equal(getRecord('assignment', pending.id).workerSessionId, undefined);
  assert.equal(listRecords('session').length, 1); assert.equal(listRecords('worker-report').length, 0);
  assert.throws(() => startAssignment(parent, { requestId: 'forged-on-copy', objective: 'Inspect supplied evidence.', context: 'Bounded offline work.',
    acceptanceCriteria: ['Report uncertainty.'] }, { executor: { provider: 'codex', model: parent.model }, launch() { assert.fail('No backend may be launched.'); },
    subagent: { definition: { ...created, enabled: true }, chatRunId: context.runId } }), { code: 'SUBAGENT_DISABLED' });
  assert.equal(listRecords('assignment').length, 1);
  const enabled = toggle(disabled, true);
  const next = followupSubagent(parent, pending.id, { requestId: 'explicit-reenable', objective: 'Inspect the missing supplied baseline.', feedback: 'Continue after owner re-enabled this specialist.' }, context);
  assert.equal(next.round, 2); assert.equal(launches.length, 2); assert.equal(enabled.version, created.version);
});

test('disabled follow-ups cannot allocate a round through specialist or generic assignment APIs', () => {
  const created = define(), context = beginRun(), job = spawnSubagent(parent, request(), context); finishRound(job.id);
  const disabled = toggle(created, false), input = { requestId: 'continue-disabled', objective: 'Inspect further.', feedback: 'Resolve the missing supplied control.' };
  assert.throws(() => followupSubagent(parent, job.id, input, context), { code: 'SUBAGENT_DISABLED' });
  assert.throws(() => followupAssignment(parent, job.id, input, { launch() { assert.fail('Disabled follow-up launched.'); }, chatRunId: context.runId }), { code: 'SUBAGENT_DISABLED' });
  assert.equal(getRecord('assignment', job.id).currentRound, 1); assert.equal(getRecord('round', `${job.id}:2`), null);
  assert.equal(launches.length, 1); toggle(disabled, true);
  const next = followupSubagent(parent, job.id, input, context);
  assert.equal(next.round, 2); assert.equal(launches.length, 2);
});

test('turning an agent off does not cancel admitted work or reject its already-running worker report', () => {
  const created = define(), context = beginRun(), job = spawnSubagent(parent, request(), context);
  const worker = createSession(getProvider('codex'), parent.cwd, parent.model);
  Object.assign(worker, { role: 'executor', parentSessionId: parent.id, assignmentId: job.id, assignmentRound: 1,
    contract: job.contract, policy: job.contract.policy, missionContext: job.missionContext }); saveSession(worker);
  putRecord('assignment', job.id, { ...getRecord('assignment', job.id), workerSessionId: worker.id });
  const round = { ...getRecord('round', `${job.id}:1`), state: 'running', runner: processIdentity() }; putRecord('round', `${job.id}:1`, round);
  toggle(created, false);
  assert.deepEqual(getRecord('round', `${job.id}:1`), round); assert.equal(getRecord('assignment-control', job.id), null);
  const result = recordWorkerReport(worker, { status: 'partial', summary: 'The admitted worker preserved its observations for review.', evidence: [] });
  assert.equal(result.recorded, true); assert.equal(loadSession(parent.id).executionState, 'running');
});

test('owner CLI toggles the shown revision without embedding availability into portable instructions', () => {
  const created = define(), seen = [], ui = { event(type, data) { seen.push(data.result); } };
  assert.equal(subagentsCLI(['disable', created.name, '--revision', '1'], { cwd: parent.cwd }, ui), 0);
  assert.equal(seen.at(-1).enabled, false); assert.equal(seen.at(-1).version, created.version);
  assert.throws(() => subagentsCLI(['enable', created.name, '--revision', '1'], { cwd: parent.cwd }, ui), { code: 'CONFLICT' });
  subagentsCLI(['enable', created.name, '--revision', '2'], { cwd: parent.cwd }, ui);
  assert.equal(seen.at(-1).enabled, true);
  for (const command of ['enable', 'disable']) assert.throws(() => subagentsCLI([command, created.name], { cwd: parent.cwd }, ui), /Usage/);
});
