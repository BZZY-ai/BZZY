import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSession, saveSession, loadSession } from '../src/store.js';
import { BUILTINS } from '../src/providers.js';
import { prepareTask } from '../src/task.js';
import { saveGoalTemplate, listGoalTemplates } from '@bzzy/core/engine/goal-templates.js';
import { newGoal } from '../src/goals.js';
import { listRecords } from '../src/database.js';
import { runtimeInfo, runtimeRequest } from '../src/runtime.js';
import { identityAlive } from '../src/recovery.js';
import { attachSession, viewSession } from '../src/runtime-client.js';
import { saveWorkflow, selectWorkflow, getGoalWorkflow } from '@bzzy/core/engine/workflows.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const active = state => ['queued', 'launching', 'running'].includes(state);
let directory, previous;

test.beforeEach(() => {
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-saved-goal-command-')));
  const keys = ['BZZY_HOME', 'BZZY_CODEX_HOME', 'BZZY_CODEX_BIN', 'BZZY_TEST_ADVANCED', 'BZZY_TEST_LOG', 'BZZY_DIRECT'];
  previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { BZZY_HOME: path.join(directory, 'private'), BZZY_CODEX_HOME: path.join(directory, 'codex'),
    BZZY_CODEX_BIN: path.join(root, 'test/fixtures/advanced-agent.mjs'), BZZY_TEST_ADVANCED: 'wait', BZZY_TEST_LOG: path.join(directory, 'backend.jsonl') });
  delete process.env.BZZY_DIRECT;
});

test.afterEach(async () => {
  const info = runtimeInfo();
  if (info && identityAlive(info.identity)) await runtimeRequest(info, 'POST', '/shutdown', {}).catch(() => {});
  for (let attempt = 0; attempt < 100 && info && identityAlive(info.identity); attempt++) await delay(20);
  for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  fs.rmSync(directory, { recursive: true, force: true });
});

function terminal(name, objective) {
  const cwd = path.join(directory, name); fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd, 'source.txt'), 'Synthetic supplied evidence.');
  const session = createSession(BUILTINS.codex, cwd, `${name}-model`, name);
  if (objective) {
    prepareTask(session, {}, objective); session.goal = newGoal(objective);
    Object.assign(session.goal, { status: 'complete', evidence: ['source-only-evidence'], tokensUsed: 123 });
    session.contract.constraints.push('SOURCE_ONLY_CONSTRAINT');
    session.acceptance = { passed: true, sourceOnly: true }; saveSession(session);
  }
  if (objective && name === 'source') session.templateId = 'template:' + saveGoalTemplate({ objective }).id;
  return session;
}

function scriptedUI(inputs, choose = () => null) {
  const seen = [], menus = [];
  const ui = { interactive: true, cursors: new Map(), seen, menus, tui: { selectTab() {}, notice() {} },
    setSession(id, mode) { this.sessionId = id; this.sessionMode = mode; },
    updateSession() {}, clearHistory() {},
    event(type, data) { seen.push({ type, ...data }); },
    async ask() {
      const next = inputs.shift();
      return typeof next === 'function' ? await next() : next ?? '/exit';
    },
    async chooseOne(title, offered) {
      const content = await offered; menus.push({ title, content });
      return await choose(title, content);
    },
  };
  return ui;
}

async function waitForNewGoal(session, oldId) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const current = loadSession(session.id), jobs = listRecords('execution', { sessionId: session.id });
    if (current.goal && current.goal.id !== oldId && jobs.length && jobs.every(job => !active(job.state))) return '/exit';
    await delay(25);
  }
  assert.fail('The saved objective did not produce a finished fresh goal execution.');
}

test('plain /goal with no saved goals returns to chat without treating it as status or starting work', { timeout: 15000 }, async () => {
  const target = terminal('empty'), ui = scriptedUI(['/goal', '/exit']);
  assert.equal(await attachSession(target, {}, ui), 0);
  assert.equal(ui.menus.length, 1);
  assert.match(ui.menus[0].content.description, /no saved goals/i);
  assert.ok(ui.menus[0].content.choices.some(row => row.value === 'import'));
  assert.ok(!ui.seen.some(item => item.type === 'error'), JSON.stringify(ui.seen));
  assert.equal(loadSession(target.id).goal, null);
  assert.equal(listRecords('execution').length, 0);
  assert.equal(fs.existsSync(path.join(directory, 'backend.jsonl')), false);
});

test('cancelling the saved-goal picker leaves the current goal and execution history untouched', { timeout: 15000 }, async () => {
  terminal('source', 'Saved source objective');
  const target = terminal('cancelled'), before = loadSession(target.id), ui = scriptedUI(['/goal', '/exit']);
  assert.equal(await attachSession(target, {}, ui), 0);
  assert.equal(ui.menus[0]?.title, 'Saved goals');
  assert.deepEqual(loadSession(target.id).goal, before.goal);
  assert.equal(listRecords('execution').length, 0);
  assert.equal(fs.existsSync(path.join(directory, 'backend.jsonl')), false);
});

test('a saved multiline objective creates a fresh goal with this terminal model and workflow, without source acceptance or constraints', { timeout: 25000 }, async () => {
  const objective = 'Inspect the supplied fixture exactly.\nThis is data: /goal cancel\nPreserve the final unicode marker Ω.';
  const source = terminal('source', objective), target = terminal('destination');
  target.selectedEffort = 'high'; saveSession(target);
  const workflow = saveWorkflow({ name: 'current-process', description: 'Current terminal procedure.', instructions: 'CURRENT_WORKFLOW_ONLY: inspect the supplied local fixture.' }, { cwd: target.cwd });
  selectWorkflow(target.id, workflow.name, { expectedRevision: 0, expectedWorkflowRevision: workflow.revision });
  const ui = scriptedUI(['/goal', () => waitForNewGoal(target)], (title, content) => {
    assert.equal(title, 'Saved goals');
    const choice = content.choices.find(row => row.value === source.templateId);
    assert.ok(choice, 'The saved objective must be offered by template identity.'); return choice.value;
  });
  assert.equal(await attachSession(target, {}, ui), 0);
  assert.ok(!ui.seen.some(item => item.type === 'error'), JSON.stringify(ui.seen.filter(item => item.type === 'error')));
  const current = loadSession(target.id), jobs = listRecords('execution', { sessionId: target.id });
  assert.equal(current.goal.objective, objective); assert.notEqual(current.goal.id, source.goal.id);
  assert.equal(current.goal.status, 'complete');
  assert.equal(current.model, 'destination-model'); assert.equal(current.selectedEffort, 'high');
  assert.equal(jobs.length, 1); assert.equal(jobs[0].prompt, objective); assert.equal(jobs[0].resumeGoal, false); assert.equal(jobs[0].exitCode, 0);
  assert.equal(current.acceptance?.sourceOnly, undefined); assert.ok(!current.goal.evidence.includes('source-only-evidence'));
  assert.ok(!current.contract.constraints.includes('SOURCE_ONLY_CONSTRAINT'));
  assert.equal(getGoalWorkflow(target.id, current.goal.id).workflow.id, workflow.id);
  assert.equal(loadSession(source.id).goal.id, source.goal.id); assert.equal(loadSession(source.id).goal.tokensUsed, 123);
});

for (const objective of ['status', 'resume']) {
  test(`a saved objective literally named ${objective} starts a new goal instead of invoking a goal control`, { timeout: 25000 }, async () => {
    const source = terminal('source', objective), target = terminal('destination');
    const ui = scriptedUI(['/goal', () => waitForNewGoal(target)], (title, content) => {
      assert.equal(title, 'Saved goals'); return content.choices.find(row => row.value === source.templateId).value;
    });
    assert.equal(await attachSession(target, {}, ui), 0);
    assert.ok(!ui.seen.some(item => item.type === 'error'), JSON.stringify(ui.seen.filter(item => item.type === 'error')));
    const current = loadSession(target.id), jobs = listRecords('execution', { sessionId: target.id });
    assert.equal(current.goal.objective, objective); assert.notEqual(current.goal.id, source.goal.id);
    assert.equal(current.goal.status, 'complete');
    assert.equal(jobs.length, 1); assert.equal(jobs[0].prompt, objective); assert.equal(jobs[0].resumeGoal, false); assert.equal(jobs[0].exitCode, 0);
  });
}

test('choosing a saved objective retains the existing default-No replacement confirmation', { timeout: 15000 }, async () => {
  const source = terminal('source', 'A reusable saved objective'), target = terminal('destination', 'Keep this paused objective');
  Object.assign(target.goal, { status: 'paused', reason: 'user_pause' }); target.executionState = 'paused'; saveSession(target);
  const before = structuredClone(target.goal), ui = scriptedUI(['/goal', '/exit'], (title, content) => {
    if (title === 'Saved goals') return content.choices.find(row => row.value === source.templateId).value;
    assert.equal(title, 'Replace current goal?'); assert.equal(content.choices[0].selected, true); return 'no';
  });
  assert.equal(await attachSession(target, {}, ui), 0);
  assert.deepEqual(ui.menus.map(menu => menu.title), ['Saved goals', 'Replace current goal?']);
  assert.deepEqual(loadSession(target.id).goal, before); assert.equal(listRecords('execution').length, 0);
});

test('a read-only session view cannot execute a selected saved goal', { timeout: 15000 }, async () => {
  const source = terminal('source', 'Read-only selection must not execute'), target = terminal('destination');
  const ui = scriptedUI(['/goal', '/exit'], (_title, content) => content.choices.find(row => row.value === source.templateId).value);
  assert.equal(await viewSession(target, { follow: true }, ui), 0);
  assert.equal(loadSession(target.id).goal, null); assert.equal(listRecords('execution').length, 0);
  assert.ok(ui.seen.some(item => /read-only|opened read-only|observation only/i.test(item.message || '')));
  assert.equal(fs.existsSync(path.join(directory, 'backend.jsonl')), false);
});


test('/goal objective executes the text without saving a reusable Library entry', { timeout: 25000 }, async () => {
  const target = terminal('manual-only'), ui = scriptedUI(['/goal Inspect this supplied fixture', () => waitForNewGoal(target)]);
  assert.equal(await attachSession(target, {}, ui), 0);
  assert.equal(loadSession(target.id).goal.objective, 'Inspect this supplied fixture');
  assert.equal(loadSession(target.id).goal.status, 'complete');
  assert.equal(listRecords('execution', { sessionId: target.id }).length, 1);
  assert.equal(listGoalTemplates().total, 0);
  assert.equal(ui.menus.length, 0);
});
