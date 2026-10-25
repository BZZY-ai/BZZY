import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSession, saveSession } from '../src/engine/store.js';
import { getProvider } from '../src/engine/providers.js';
import { importSkill, setSkillEnabled, readSkill } from '../src/engine/skills.js';
import { newGoal } from '../src/engine/goals.js';
import { putRecord, listRecords, events } from '../src/engine/database.js';
import { ToolHost } from '../src/engine/tools.js';
import { sessionMetrics } from '../src/engine/session-metrics.js';

let directory, workspace, previous, skill;
test.beforeEach(() => {
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-skill-usage-')));
  previous = process.env.BZZY_HOME; process.env.BZZY_HOME = path.join(directory, 'private');
  workspace = path.join(directory, 'project'); fs.mkdirSync(workspace);
  const source = path.join(directory, 'source'); fs.mkdirSync(path.join(source, 'references'), { recursive: true });
  fs.writeFileSync(path.join(source, 'SKILL.md'), '---\nname: controlled-review\ndescription: Review supplied local fixture responses.\n---\nInspect the supplied fixture and report uncertainty.\n');
  fs.writeFileSync(path.join(source, 'references', 'guide.txt'), 'Inspect a positive and negative control.');
  const imported = importSkill(source); skill = setSkillEnabled(imported.id, true, imported.revision);
});
test.afterEach(() => {
  if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
  fs.rmSync(directory, { recursive: true, force: true });
});
function hostFor(session, goalMode, runId = randomUUID()) {
  session.executionState = 'running'; saveSession(session);
  putRecord('run', session.id, { id: runId, sessionId: session.id, state: 'running', goalMode, goalId: goalMode ? session.goal.id : null });
  return new ToolHost(session, { event() {} }, { goalMode, runId });
}

test('successful main skill loads count once per model run while previews, discovery and pages do not inflate use', async () => {
  const session = createSession(getProvider('codex'), workspace), host = hostFor(session, false);
  readSkill(skill.id, { enabledOnly: false });
  await host.call('list_skills', {});
  await host.call('read_skill', { name: skill.id, file: 'references/guide.txt' });
  await host.call('read_skill', { name: skill.id, offset: 2 });
  assert.equal(listRecords('core.usage').length, 0);
  const first = await host.call('read_skill', { name: skill.id, limit: 25 });
  assert.ok(first.nextOffset);
  await host.call('read_skill', { name: skill.id, offset: first.nextOffset });
  await Promise.all([host.call('read_skill', { name: skill.id }), host.call('read_skill', { name: skill.id })]);
  assert.equal(listRecords('core.usage').length, 1);
  assert.equal(events(session.id).filter(event => event.type === 'core.usage').length, 1);
  const record = listRecords('core.usage')[0];
  assert.equal(record.skillVersion, skill.version); assert.equal(record.attribution, 'chat'); assert.equal(record.rootGoalId, null);
  const reads = events(session.id).filter(event => event.type === 'skill.loaded');
  assert.ok(reads.every(event => event.data.usageProtocol === 1 && event.data.runId === record.runId));
  assert.ok(reads.every(event => event.data.usageId === record.id));
  await hostFor(session, false).call('read_skill', { name: skill.id });
  assert.equal(listRecords('core.usage').length, 2);
});

test('all provider tool hosts distinguish an active goal from ordinary chat with an older achieved goal', async () => {
  for (const provider of ['codex', 'claude', 'deepseek', 'abliteration', 'orcarouter']) {
    const session = createSession(getProvider(provider), workspace); session.goal = newGoal('Inspect supplied fixtures.');
    await hostFor(session, true).call('read_skill', { name: skill.id });
    session.goal.status = 'complete';
    await hostFor(session, false).call('read_skill', { name: skill.id });
    const used = listRecords('core.usage', { sessionId: session.id });
    assert.equal(used.length, 2);
    assert.equal(used.filter(record => record.rootGoalId === session.goal.id && record.attribution === 'goal').length, 1);
    assert.equal(used.filter(record => record.goalId === null && record.rootGoalId === null && record.attribution === 'chat').length, 1);
  }
});

test('failed, stale or unbound tool reads cannot manufacture an exact model invocation count', async () => {
  const session = createSession(getProvider('codex'), workspace), host = hostFor(session, false);
  await assert.rejects(host.call('read_skill', { name: 'does-not-exist' }));
  await assert.rejects(host.call('read_skill', { name: skill.id, file: '../private' }));
  const disabled = setSkillEnabled(skill.id, false, skill.revision);
  await assert.rejects(host.call('read_skill', { name: skill.id }));
  skill = setSkillEnabled(skill.id, true, disabled.revision);
  await new ToolHost(session, { event() {} }).call('read_skill', { name: skill.id, modelUsage: { runId: randomUUID(), goalMode: true } });
  const stale = hostFor(session, false); hostFor(session, false);
  await stale.call('read_skill', { name: skill.id });
  assert.equal(listRecords('core.usage').length, 0);
  assert.equal(events(session.id).filter(event => event.type === 'core.usage').length, 0);
});

test('assignment workers without their own goal attribute real model loads to the parent goal or explicit chat run', async () => {
  const parent = createSession(getProvider('codex'), workspace); parent.goal = newGoal('Review the supplied controlled responses.'); saveSession(parent);
  const worker = chat => {
    const child = createSession(getProvider('codex'), workspace), assignmentId = randomUUID();
    Object.assign(child, { parentSessionId: parent.id, assignmentId, assignmentRound: 1, role: 'executor' }); saveSession(child);
    putRecord('assignment', assignmentId, { id: assignmentId, parentSessionId: parent.id, workerSessionId: child.id,
      goalId: chat ? null : parent.goal.id, chatRunId: chat ? randomUUID() : null, currentRound: 1 });
    return child;
  };
  // The actual assignment runner calls runSession without goal:true. Its task
  // belongs to the parent's goal even though the worker has no goal of its own.
  await hostFor(worker(false), false).call('read_skill', { name: skill.id });
  await hostFor(worker(true), false).call('read_skill', { name: skill.id });
  const metrics = sessionMetrics(parent.id);
  assert.equal(metrics.session.skillInvocations, 2);
  assert.equal(metrics.goals.find(goal => goal.id === parent.goal.id).skillInvocations, 1);
  assert.equal(metrics.chat.skillInvocations, 1);
});
