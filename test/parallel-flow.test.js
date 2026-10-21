import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from '../src/cli.js';
import { chooseParallel, configuredParallel, applyParallelSelection } from '../src/parallel-setup.js';
import { createSession, loadSession, saveSession, sessions } from '../src/store.js';
import { BUILTINS } from '../src/providers.js';
import { prepareTask } from '../src/task.js';
import { root } from '../src/process.js';
import { ensureRuntime, runtimeInfo, runtimeRequest } from '../src/runtime.js';
import { identityAlive } from '../src/recovery.js';
import { events, getRecord } from '../src/database.js';
import { newGoal } from '../src/goals.js';
import { delay } from '../src/delegation.js';

let directory, previous;
test.beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-parallel-flow-'));
  previous = Object.fromEntries(['BZZY_HOME', 'BZZY_CODEX_HOME', 'BZZY_CODEX_BIN', 'BZZY_TEST_LOG', 'BZZY_TEST_ADVANCED'].map(key => [key, process.env[key]]));
  Object.assign(process.env, { BZZY_HOME: path.join(directory, 'private'), BZZY_CODEX_BIN: path.join(root, 'test/fixtures/models.mjs'), BZZY_TEST_LOG: path.join(directory, 'backend.jsonl') });
});
test.afterEach(async () => {
  const info = runtimeInfo();
  if (info && identityAlive(info.identity)) await runtimeRequest(info, 'POST', '/shutdown', {}).catch(() => {});
  for (let attempt = 0; attempt < 80 && info && identityAlive(info.identity); attempt++) await delay(20);
  for (const [key, value] of Object.entries(previous)) if (value == null) delete process.env[key]; else process.env[key] = value;
  fs.rmSync(directory, { recursive: true, force: true });
});

test('parallel accepts optional counts 2 or 3, defaults to 3 and preserves scripted agents', () => {
  assert.equal(parseArgs(['--parallel', '2']).options.parallelCount, 2);
  assert.equal(parseArgs(['--parallel=3']).options.parallelCount, 3);
  assert.deepEqual(parseArgs(['--parallel', '2', 'goal', 'Assess supplied project']).args, ['goal', 'Assess supplied project']);
  assert.equal(configuredParallel(parseArgs(['--parallel']).options).length, 3);
  assert.equal(configuredParallel(parseArgs(['--parallel', '2']).options).length, 2);
  assert.deepEqual(configuredParallel({ agents: 'codex:model-a,codex:model-b' }).map(agent => agent.model), ['model-a', 'model-b']);
  for (const count of ['0', '1', '4', '8', '-1', '2.5']) assert.throws(() => parseArgs(['--parallel', count]), /2 or 3/);
  for (const agents of ['codex', 'codex,claude,deepseek,codex']) assert.throws(() => configuredParallel({ agents }), /2 or 3/);
  assert.throws(() => configuredParallel({ parallelCount: 2, agents: 'codex,claude,deepseek' }), /must match/);
});

test('two and three parallel agent pickers retain each model and effort separately without launching work', async () => {
  for (const count of [2, 3]) {
    const titles = [], ui = { interactive: true, event() {}, async chooseOne(title, choices) {
      titles.push(title); const picker = await choices;
      if (title.includes('Choose provider')) return 'codex';
      assert.equal(picker.selectEffort, true);
      return title.startsWith('Agent 1') ? { value: 'fixture-brain', effort: 'xhigh' } : { value: 'fixture-light', effort: 'low' };
    } };
    const selections = await chooseParallel({ cwd: directory, parallelCount: count }, ui);
    assert.equal(selections.length, count); assert.equal(titles.length, count * 2);
    assert.equal(selections[0].effort, 'xhigh'); assert.ok(selections.slice(1).every(agent => agent.effort === 'low'));
    const session = createSession(BUILTINS.codex, directory); applyParallelSelection(session, selections);
    prepareTask(session, { mode: 'parallel' }, 'Same authorized objective for every independent peer');
    assert.deepEqual(loadSession(session.id).parallelAgents, selections); assert.equal(session.goal, null);
  }
  assert.doesNotMatch(fs.readFileSync(path.join(directory, 'backend.jsonl'), 'utf8'), /thread\/start|turn\/start/);
});

test('cancelling a later parallel picker creates no conversation or execution', async () => {
  const ui = { interactive: true, event() {}, async chooseOne(title, choices) {
    await choices;
    if (title.startsWith('Agent 2')) return null;
    return title.includes('Choose provider') ? 'codex' : { value: 'fixture-brain', effort: 'high' };
  } };
  assert.equal(await chooseParallel({ cwd: directory, parallelCount: 2 }, ui), null);
  assert.equal(sessions().length, 0);
});

test('parallel materializes separate chats and workspaces with each native effort preserved', { timeout: 25000 }, async () => {
  Object.assign(process.env, { BZZY_CODEX_BIN: path.join(root, 'test/fixtures/advanced-agent.mjs'), BZZY_CODEX_HOME: path.join(directory, 'codex'), BZZY_TEST_ADVANCED: 'conversation' });
  fs.writeFileSync(path.join(directory, 'source.txt'), 'Supplied local assessment inputs');
  const session = createSession(BUILTINS.codex, directory);
  const selections = [
    { provider: 'codex', model: 'fixture-brain', effort: 'xhigh', capabilities: { supportedEfforts: ['high', 'xhigh'] } },
    { provider: 'codex', model: 'fixture-brain', effort: 'high', capabilities: { supportedEfforts: ['high', 'xhigh'] } },
  ];
  applyParallelSelection(session, selections); prepareTask(session, { mode: 'parallel' }, 'Inspect the supplied source independently');
  session.goal = newGoal(session.contract.objective); saveSession(session);
  const info = await ensureRuntime(), owner = 'parallel-flow-owner';
  await runtimeRequest(info, 'POST', `/sessions/${session.id}/claim`, { owner });
  const started = await runtimeRequest(info, 'POST', `/sessions/${session.id}/execute`, { owner, prompt: session.goal.objective, options: {}, goal: true }, 'parallel-native-efforts');
  let execution;
  for (let attempt = 0; attempt < 450; attempt++) {
    execution = getRecord('execution', started.executionId);
    if (execution && !['queued', 'launching', 'running'].includes(execution.state)) break;
    await delay(40);
  }
  assert.equal(execution?.exitCode, 0, execution?.error);
  const group = getRecord('parallel', session.id); assert.equal(group.peers.length, 2);
  const children = group.peers.map(peer => loadSession(peer.sessionId));
  assert.notEqual(children[0].id, children[1].id); assert.notEqual(children[0].cwd, children[1].cwd);
  assert.deepEqual(children.map(child => child.selectedEffort), ['xhigh', 'high']);
  assert.deepEqual(children.map(child => child.reasoningEffort), ['xhigh', 'high']);
  assert.ok(children.every(child => child.goal.objective === session.goal.objective && child.goal.status === 'complete'));
  const usageEvents = events(session.id, 0, 1000).filter(event => event.type === 'parallel.usage');
  assert.ok(usageEvents.length > 0, 'parallel usage should stream to TUI and integration consumers');
  assert.equal(usageEvents.at(-1).data.agents.length, 2);
});
