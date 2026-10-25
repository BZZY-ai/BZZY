import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSession, saveSession } from '../src/engine/store.js';
import { getProvider } from '../src/engine/providers.js';
import { prepareTask } from '../src/engine/task.js';
import { newGoal } from '../src/engine/goals.js';
import { putRecord, appendEvent, listRecords } from '../src/engine/database.js';
import { createSkill, setSkillEnabled } from '../src/engine/skills.js';
import { saveSubagentDefinition, setSubagentEnabled, listSubagentDefinitions } from '../src/engine/subagent-definitions.js';
import { ToolHost } from '../src/engine/tools.js';
import { sessionMetrics } from '../src/engine/session-metrics.js';

let directory, previous;
test.beforeEach(() => {
  previous = process.env.BZZY_HOME;
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-library-goal-')));
  process.env.BZZY_HOME = path.join(directory, 'private');
});
test.afterEach(() => {
  if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
  fs.rmSync(directory, { recursive: true, force: true });
});

test('enabled Library methods serve live goals across providers and Metrics count admitted uses without disabled attempts or replays', async () => {
  let skill = createSkill({ name: 'response-method', description: 'Inspect supplied offline response evidence.',
    instructions: 'Compare only the supplied synthetic response controls and preserve uncertainty.' }, { scope: 'global' });
  skill = setSkillEnabled(skill.id, true, skill.revision, { scope: 'global' });
  let specialist = saveSubagentDefinition({ name: 'response-analyst', description: 'Review supplied offline response controls.',
    instructions: 'Return observations from the assigned synthetic controls with evidence and limitations.' }, { scope: 'global' });
  for (const providerId of ['codex', 'claude', 'deepseek', 'abliteration', 'orcarouter']) {
    const cwd = path.join(directory, providerId); fs.mkdirSync(cwd);
    const provider = getProvider(providerId), parent = createSession(provider, cwd, provider.model || 'fixture-model');
    prepareTask(parent, { mode: 'solo' }, 'Review the supplied offline response controls.');
    parent.goal = newGoal(parent.contract.objective); parent.executionState = 'running';
    parent.contract.limits.concurrency = 3; saveSession(parent);
    appendEvent(parent.id, 'message.user', { text: parent.goal.objective, kind: 'goal' });
    let admitted = 0;
    const host = () => {
      const runId = randomUUID();
      putRecord('run', parent.id, { id: runId, sessionId: parent.id, state: 'running', goalMode: true, goalId: parent.goal.id });
      return new ToolHost(parent, { event() {} }, { goalMode: true, runId, prompt: parent.goal.objective, launch() { admitted++; } });
    };
    let tools = host();
    assert.ok((await tools.call('list_skills', {})).skills.some(item => item.id === skill.id));
    assert.ok((await tools.call('list_subagents', {})).subagents.some(item => item.name === specialist.name));
    await tools.call('read_skill', { name: skill.id }); await tools.call('read_skill', { name: skill.id });
    const input = { name: specialist.name, requestId: 'first-check', objective: parent.goal.objective, waitSeconds: 0 };
    const first = await tools.call('spawn_subagent', input);
    await tools.call('spawn_subagent', input);
    assert.equal(admitted, 1);
    const job = listRecords('assignment', { parentSessionId: parent.id })[0];
    assert.equal(job.selection.provider, providerId); assert.equal(job.selection.model, parent.model);
    let metrics = sessionMetrics(parent.id), goal = metrics.goals.find(item => item.id === parent.goal.id);
    assert.equal(goal.skillInvocations, 1); assert.equal(goal.subagentInvocations, 1);
    assert.equal(metrics.session.skillInvocations, 1); assert.equal(metrics.session.agentRows[0].count, 1);

    skill = setSkillEnabled(skill.id, false, skill.revision, { scope: 'global' });
    specialist = setSubagentEnabled(specialist.name, false, { scope: 'global', expectedRevision: specialist.revision });
    assert.equal((await tools.call('list_skills', {})).skills.some(item => item.id === skill.id), false);
    assert.equal((await tools.call('list_subagents', {})).subagents.some(item => item.name === specialist.name), false);
    assert.equal(listSubagentDefinitions({ scope: 'global' }).subagents.find(item => item.name === specialist.name).enabled, false);
    await assert.rejects(tools.call('read_skill', { name: skill.id }));
    await assert.rejects(tools.call('spawn_subagent', { ...input, requestId: 'disabled-check' }), /disabled|enabled/i);
    await assert.rejects(tools.call('read_subagent', { name: specialist.name }), /disabled|enabled/i);
    assert.equal(admitted, 1); metrics = sessionMetrics(parent.id);
    assert.equal(metrics.session.skillInvocations, 1); assert.equal(metrics.session.subagentInvocations, 1);

    skill = setSkillEnabled(skill.id, true, skill.revision, { scope: 'global' });
    specialist = setSubagentEnabled(specialist.name, true, { scope: 'global', expectedRevision: specialist.revision });
    tools = host(); await tools.call('read_skill', { name: skill.id });
    const second = await tools.call('spawn_subagent', { ...input, requestId: 'second-check' });
    assert.notEqual(first.id, second.id); assert.equal(admitted, 2);
    metrics = sessionMetrics(parent.id); goal = metrics.goals.find(item => item.id === parent.goal.id);
    assert.equal(goal.skillInvocations, 2); assert.equal(goal.subagentInvocations, 2);
    assert.equal(metrics.session.skillRows.find(item => item.id === skill.id).count, 2);
    assert.equal(metrics.session.agentRows.find(item => item.name === specialist.name).count, 2);
  }
});
