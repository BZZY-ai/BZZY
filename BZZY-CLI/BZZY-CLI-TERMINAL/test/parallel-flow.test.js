import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { parseArgs } from '../src/cli.js';
import { chooseParallel, chooseParallelWithDefault, chooseParallelGoal, configuredParallel, applyParallelSelection } from '../src/parallel-setup.js';
import { createSession, loadSession, saveSession, sessions } from '../src/store.js';
import { BUILTINS, config, saveConfig, parallelDefault, saveDefaultSelection } from '../src/providers.js';
import { saveSessionDefaultSelection, savedDefaultMessage } from '../src/session-defaults.js';
import { prepareTask } from '../src/task.js';
import { root } from '../src/process.js';
import { ensureRuntime, runtimeInfo, runtimeRequest } from '../src/runtime.js';
import { identityAlive } from '../src/recovery.js';
import { events, getRecord, putRecord } from '../src/database.js';
import { newGoal } from '../src/goals.js';
import { delay } from '../src/delegation.js';

let directory, previous;
test.beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-parallel-flow-'));
  previous = Object.fromEntries(['BZZY_HOME', 'BZZY_CODEX_HOME', 'BZZY_CODEX_BIN', 'BZZY_CLAUDE_BIN', 'BZZY_TEST_LOG', 'BZZY_TEST_ADVANCED', 'DEEPSEEK_API_KEY'].map(key => [key, process.env[key]]));
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
    let configured = 0, menus = 0;
    const titles = [], ui = { interactive: true, event() {}, async chooseOne(title, choices) {
      const picker = await choices;
      if (title === 'Parallel · Select agents') {
        menus++;
        assert.equal(picker.choices.at(-1).value, 'continue', 'Continue remains the bottom option');
        assert.equal(picker.choices.at(-1).disabled, configured < 2);
        return configured < count ? `agent:${configured}` : 'continue';
      }
      titles.push(title);
      if (title.includes('Choose provider')) return 'codex';
      assert.equal(picker.selectEffort, true);
      configured++;
      return title.startsWith('Agent 1') ? { value: 'fixture-brain', effort: 'xhigh' } : { value: 'fixture-light', effort: 'low' };
    } };
    const selections = await chooseParallel({ cwd: directory, parallelCount: count }, ui);
    assert.equal(selections.length, count); assert.equal(titles.length, count * 2);
    assert.equal(menus, 3, count === 3 ? 'the third configured agent continues automatically' : 'two agents use the bottom Continue option');
    assert.equal(selections[0].effort, 'xhigh'); assert.ok(selections.slice(1).every(agent => agent.effort === 'low'));
    const session = createSession(BUILTINS.codex, directory); applyParallelSelection(session, selections);
    prepareTask(session, { mode: 'parallel' }, 'Same authorized objective for every independent peer');
    assert.deepEqual(loadSession(session.id).parallelAgents, selections); assert.equal(session.goal, null);
  }
  assert.doesNotMatch((fs.existsSync(path.join(directory, 'backend.jsonl')) ? fs.readFileSync(path.join(directory, 'backend.jsonl'), 'utf8') : ''), /thread\/start|turn\/start/);
});

test('cancelling a later parallel picker creates no conversation or execution', async () => {
  let configured = 0;
  const ui = { interactive: true, event() {}, async chooseOne(title, choices) {
    await choices;
    if (title === 'Parallel · Select agents') return `agent:${configured}`;
    if (title.startsWith('Agent 2')) return null;
    if (!title.includes('Choose provider')) configured++;
    return title.includes('Choose provider') ? 'codex' : { value: 'fixture-brain', effort: 'high' };
  } };
  assert.equal(await chooseParallel({ cwd: directory, parallelCount: 2 }, ui), null);
  assert.equal(sessions().length, 0);
});

test('/default in any parallel tab saves all current agent selections in group order', async () => {
  const single = saveDefaultSelection({ provider: 'claude', model: 'single-chat', selectedEffort: 'high' });
  const parent = createSession(BUILTINS.codex, directory);
  applyParallelSelection(parent, [{ provider: 'codex', model: 'old', effort: 'default' }, { provider: 'claude', effort: 'default' }]);
  saveSession(parent);
  const children = ['claude', 'codex'].map((provider, index) => {
    const child = createSession(BUILTINS[provider], directory);
    Object.assign(child, { parentSessionId: parent.id, model: `current-${index}`, selectedEffort: index ? 'xhigh' : 'low',
      modelCapabilities: { supportedEfforts: ['low', 'high', 'xhigh'] } });
    saveSession(child); return child;
  });
  putRecord('parallel', parent.id, { peers: children.map(child => ({ sessionId: child.id })) });
  const saved = saveSessionDefaultSelection(children[1]);
  assert.deepEqual(saved.parallelAgents.map(agent => [agent.provider, agent.model, agent.effort]),
    [['claude', 'current-0', 'low'], ['codex', 'current-1', 'xhigh']]);
  assert.deepEqual(parallelDefault(), saved.parallelAgents);
  assert.deepEqual(config().defaultSelection, single, 'parallel presets do not replace ordinary chat defaults');
  assert.match(savedDefaultMessage(saved), /Parallel default saved.*Agent 1: claude.*Agent 2: codex.*--parallel/s);
  assert.deepEqual(saveSessionDefaultSelection(parent), saved);
  const prompts = [];
  const selected = await chooseParallelWithDefault({}, { async chooseOne(title, picker) {
    prompts.push(title); assert.match(picker.description, /current-0.*current-1/s); return 'yes';
  } });
  assert.deepEqual(selected, saved.parallelAgents);
  assert.deepEqual(prompts, ['Parallel · Use saved combo?'], 'Yes skips every provider/model picker');
});

test('saved parallel combos support No, cancellation and explicit counts without replacing the preset', async () => {
  const parent = createSession(BUILTINS.codex, directory);
  applyParallelSelection(parent, [{ provider: 'codex', model: 'saved-a', effort: 'high' }, { provider: 'claude', model: 'saved-b', effort: 'low' }]);
  const saved = saveSessionDefaultSelection(parent);
  for (const [options, expected] of [[{}, ['Parallel · Use saved combo?', 'Parallel · Select agents']],
    [{ parallelCount: 3 }, ['Parallel · Select agents']]]) {
    const prompts = [];
    assert.equal(await chooseParallelWithDefault(options, { async chooseOne(title) {
      prompts.push(title); return title.includes('Use saved combo?') ? 'no' : null;
    } }), null);
    assert.deepEqual(prompts, expected);
    assert.deepEqual(parallelDefault(), saved.parallelAgents);
  }
  assert.equal(await chooseParallelWithDefault({}, { async chooseOne(title) {
    assert.equal(title, 'Parallel · Use saved combo?'); return null;
  } }), null);
});

test('invalid saved parallel combos fall back to the normal selector', async () => {
  for (const parallelDefault of [[{ provider: 'codex' }], [{ provider: 'missing' }, { provider: 'codex' }],
    [{ provider: 'codex', model: 'bad\nmodel' }, { provider: 'claude' }]]) {
    saveConfig({ ...config(), parallelDefault });
    assert.equal(await chooseParallelWithDefault({}, { async chooseOne(title) {
      assert.equal(title, 'Parallel · Select agents'); return null;
    } }), null);
  }
});

test('Continue needs two agents, and the optional third is not forced by bare --parallel', async () => {
  const actions = ['continue', 'agent:0', 'agent:1', 'continue'];
  const ui = { interactive: true, event() {}, async chooseOne(title, choices) {
    const picker = await choices;
    if (title === 'Parallel · Select agents') return actions.shift();
    if (title.includes('Choose provider')) return 'codex';
    assert.ok(!title.startsWith('Agent 3'));
    assert.equal(picker.selectEffort, true);
    return { value: 'fixture-brain', effort: 'high' };
  } };
  const selected = await chooseParallel({ cwd: directory }, ui);
  assert.equal(selected.length, 2); assert.equal(actions.length, 0);
  const inputs = [' ', '/goal Inspect the supplied project'], messages = [];
  const objective = await chooseParallelGoal(selected, { ask: async () => inputs.shift(), event(_type, data) { messages.push(data.message); } });
  assert.equal(objective, 'Inspect the supplied project');
  assert.match(messages[0], /Agent 1: codex.*Agent 2: codex/s);
  assert.match(messages[0], /own chat tab/);
  assert.equal(await chooseParallelGoal(selected, { ask: async () => null, event() {} }), null);
  assert.equal(sessions().length, 0, 'selection and goal entry do not execute a model');
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

const ptyAvailable = process.platform === 'linux' && spawnSync('script', ['--version'], { stdio: 'ignore' }).status === 0;
test('parallel terminal reuses a saved combo straight to goal entry, or configures a different explicit count', { skip: !ptyAvailable, timeout: 30000 }, async () => {
  const parent = createSession(BUILTINS.codex, directory);
  applyParallelSelection(parent, [{ provider: 'codex', model: 'saved-first', effort: 'xhigh' }, { provider: 'claude', model: 'saved-second', effort: 'high' }]);
  saveSessionDefaultSelection(parent);
  const existing = sessions().map(session => session.id);
  for (const useSaved of [true, false]) {
    const command = [process.execPath, path.join(root, 'bin/bzzy.js'), '--parallel', ...(useSaved ? [] : ['3']), '--no-pet'].map(value => `'${value.replaceAll("'", "'\\''")}'`).join(' ');
    const child = spawn('script', ['-qefc', command, '/dev/null'], { cwd: directory, env: { ...process.env, BZZY_DIRECT: '0', TERM: 'xterm-256color' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    const done = new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
    async function until(fragment) {
      for (let attempt = 0; attempt < 400; attempt++) {
        if (output.includes(fragment)) return;
        assert.equal(child.exitCode, null, output.slice(-2000));
        await delay(20);
      }
      throw new Error(`Missing ${fragment}: ${output.slice(-2000)}`);
    }
    try {
      assert.doesNotMatch(output, /Use saved combo/);
      await until(useSaved ? 'Parallel · Goal setup' : 'Parallel · Select agents');
      if (useSaved) assert.doesNotMatch(output, /Parallel · Select agents|Choose model|Choose provider/);
      child.stdin.write('\x1b');
      assert.equal(await done, 0, output.slice(-2000));
      assert.deepEqual(sessions().map(session => session.id), existing, 'cancelling setup never creates agent chats');
    } finally { if (child.exitCode == null) child.kill('SIGTERM'); await done.catch(() => {}); }
  }
});

for (const count of [2, 3]) {
  test(`parallel terminal: ${count === 2 ? 'bottom Continue with two agents' : 'third agent automatically continues'} → goal → independent chat tabs`, { skip: !ptyAvailable, timeout: 45000 }, async () => {
    Object.assign(process.env, { BZZY_CODEX_BIN: path.join(root, 'test/fixtures/advanced-agent.mjs'), BZZY_CLAUDE_BIN: path.join(root, 'test/fixtures/advanced-agent.mjs'),
      BZZY_CODEX_HOME: path.join(directory, 'codex'), BZZY_TEST_ADVANCED: 'slow', DEEPSEEK_API_KEY: 'fixture-only-key' });
    fs.mkdirSync(process.env.BZZY_HOME, { recursive: true });
    fs.writeFileSync(path.join(process.env.BZZY_HOME, 'config.json'), JSON.stringify({ version: 1, providers: {
      deepseek: { ...BUILTINS.deepseek, baseUrl: 'http://127.0.0.1:9' },
    } }));
    fs.writeFileSync(path.join(directory, 'source.txt'), 'Supplied local evidence');
    const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
    const command = [process.execPath, path.join(root, 'bin/bzzy.js'), '--parallel', '--no-pet', '--yolo'];
    const child = spawn('script', ['-qefc', command.map(quote).join(' '), '/dev/null'], { cwd: directory, env: { ...process.env, BZZY_DIRECT: '0', TERM: 'xterm-256color' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    const done = new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
    async function until(check, label) {
      for (let attempt = 0; attempt < 600; attempt++) {
        if (check()) return;
        assert.equal(child.exitCode, null, `CLI exited before ${label}: ${stderr} ${stdout.slice(-2000)}`);
        await delay(20);
      }
      throw new Error(`Timed out waiting for ${label}: ${stderr} ${stdout.slice(-2000)}`);
    }
    try {
      await until(() => stdout.includes('Parallel · Select agents'), 'agent list');
      for (let index = 0; index < count; index++) {
        let after = stdout.length;
        child.stdin.write(index === 2 ? '\x1b[A\r' : '\r');
        await until(() => stdout.slice(after).includes(`Agent ${index + 1}`) && stdout.slice(after).includes('Choose provider'), 'provider picker');
        after = stdout.length;
        child.stdin.write('\x1b[A'.repeat(index) + '\r');
        await until(() => stdout.slice(after).includes('Choose model') && stdout.slice(after).includes('Brain model'), 'loaded model picker');
        after = stdout.length;
        child.stdin.write('\x1b[B\r');
        await until(() => stdout.slice(after).includes(index === 2 ? 'Parallel · Goal setup' : 'Parallel · Select agents'), 'next setup step');
      }
      if (count === 2) {
        assert.match(stdout, /Continue with 2 agents/);
        child.stdin.write('\r');
        await until(() => stdout.includes('Parallel · Goal setup'), 'goal setup after Continue');
      }
      assert.equal(sessions().length, 0, 'nothing executes before the goal is entered');
      const objective = 'Inspect the supplied project independently';
      child.stdin.write(objective + '\r');
      await until(() => sessions().some(session => session.mode === 'parallel' && getRecord('parallel', session.id)?.peers.length === count), 'independent agent sessions');
      const parent = sessions().find(session => session.mode === 'parallel'), group = getRecord('parallel', parent.id);
      await until(() => stdout.includes(`Chat: ${group.peers[0].sessionId}`), 'first agent chat selected automatically');
      await until(() => stdout.includes(`${count} codex-${count}`), 'all agent tabs visible');
      assert.equal(loadSession(parent.id).goal.objective, objective);
      assert.ok(group.peers.every(peer => loadSession(peer.sessionId).goal.objective === objective));
      const after = stdout.length; child.stdin.write('\t');
      await until(() => stdout.slice(after).includes(`Chat: ${group.peers[1].sessionId}`), 'Tab switching to the second agent chat');
      await until(() => loadSession(parent.id).goal.status === 'complete', 'parallel goal completion');
      child.stdin.write('/default\r');
      await until(() => parallelDefault()?.length === count && stdout.includes('Parallel default saved'), 'saving the entire combo from the second agent tab');
      assert.deepEqual(parallelDefault().map(agent => agent.model), group.peers.map(peer => loadSession(peer.sessionId).model));
      child.stdin.write('/exit\r'); assert.equal(await done, 0, stderr + stdout.slice(-2000));
    } finally { if (child.exitCode == null) child.kill('SIGTERM'); await done.catch(() => {}); }
  });
}
