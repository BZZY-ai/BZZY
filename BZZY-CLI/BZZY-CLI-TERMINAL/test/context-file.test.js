import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../src/cli.js';
import { readContextFile, prepareTask } from '../src/task.js';
import { createSession, loadSession, saveSession } from '../src/store.js';
import { BUILTINS } from '../src/providers.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const objective = 'find a new XSS';
// Exceeds both Linux's per-argument limit and the runtime's 256 KiB request limit.
const briefing = '  Scope: https://approved.example.test only; exclude accounts.\r\n'
  + 'Workflow: record observations, verify impact, preserve uncertainty.\n'.repeat(4500)
  + 'Submission format: résumé / 世界, reproduction, evidence, impact, remediation.\n  ';
let directory, env, previousHome;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const records = () => {
  if (!fs.existsSync(env.BZZY_TEST_LOG)) return [];
  const text = fs.readFileSync(env.BZZY_TEST_LOG, 'utf8');
  // A backend may still be appending a large record when this poll reads it.
  return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(JSON.parse);
};
const sessions = () => {
  const dir = path.join(env.BZZY_HOME, 'sessions');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter(name => name.endsWith('.json')).map(name => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))) : [];
};

function launch(args, { extraEnv = {}, pty = false } = {}) {
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const command = [process.execPath, path.join(root, 'bin/bzzy.js'), ...args];
  const child = spawn(pty ? 'script' : command[0], pty ? ['-qefc', command.map(quote).join(' '), '/dev/null'] : command.slice(1), {
    cwd: directory, env: { ...env, ...extraEnv }, stdio: [pty ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });
  const state = { child, stdout: '', stderr: '' };
  child.stdout.on('data', chunk => { state.stdout += chunk; });
  child.stderr.on('data', chunk => { state.stderr += chunk; });
  state.done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`CLI timed out: ${state.stdout.slice(-2500)} ${state.stderr}`)); }, 25000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout: state.stdout, stderr: state.stderr }); });
  });
  return state;
}
const run = (args, options) => launch(args, options).done;
async function until(check, label) {
  for (let attempt = 0; attempt < 600; attempt++) { if (check()) return; await delay(20); }
  throw new Error(`Timed out waiting for ${label}`);
}
function taskContext(instructions) {
  return JSON.parse(instructions.split('DURABLE TASK CONTEXT:\n')[1]).contract.context;
}
function nativeInstructions(provider) {
  return provider === 'claude' ? records().filter(record => record.systemPrompt).map(record => record.systemPrompt)
    : records().filter(record => ['thread/start', 'thread/resume'].includes(record.method)).map(record => record.params.developerInstructions);
}

test.beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-context-file-'));
  previousHome = process.env.BZZY_HOME;
  env = { ...process.env, BZZY_HOME: path.join(directory, 'private'), BZZY_DIRECT: '0',
    BZZY_CODEX_HOME: path.join(directory, 'codex'), BZZY_CLAUDE_HOME: path.join(directory, 'claude'),
    BZZY_CODEX_BIN: path.join(root, 'test/fixtures/codex.mjs'), BZZY_CLAUDE_BIN: path.join(root, 'test/fixtures/claude.mjs'),
    BZZY_TEST_LOG: path.join(directory, 'backend.jsonl'), BZZY_TEST_CAPTURE_TASK: '1', BZZY_TEST_SCENARIO: 'complete',
    DEEPSEEK_API_KEY: 'fixture-only-key', TERM: 'xterm-256color' };
  process.env.BZZY_HOME = env.BZZY_HOME;
  // Interactive quota refreshes also stay local; all model execution is mocked.
  fs.mkdirSync(env.BZZY_HOME, { recursive: true });
  fs.writeFileSync(path.join(env.BZZY_HOME, 'config.json'), JSON.stringify({ version: 1, providers: {
    deepseek: { ...BUILTINS.deepseek, baseUrl: 'http://127.0.0.1:9' },
  } }));
  fs.writeFileSync(path.join(directory, 'bzzy_init.txt'), briefing);
});
test.afterEach(async () => {
  await run(['service', 'stop', '--json']).catch(() => {});
  if (previousHome == null) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previousHome;
  fs.rmSync(directory, { recursive: true, force: true });
});

test('context-file parses both flag forms, preserves UTF-8 text and merges contract instructions', () => {
  assert.equal(parseArgs(['--context-file=bzzy_init.txt', '--goal', objective]).options.contextFile, 'bzzy_init.txt');
  assert.equal(parseArgs(['--context-file', 'bzzy_init.txt', '--goal', objective]).options.goal, objective);
  assert.throws(() => parseArgs(['--context-file', '--goal', objective]), /requires a value/);
  assert.equal(readContextFile('bzzy_init.txt', directory), briefing);
  const contractFile = path.join(directory, 'contract.json');
  fs.writeFileSync(contractFile, JSON.stringify({ context: 'Existing acceptance and reporting rules.' }));
  const session = createSession(BUILTINS.codex, directory);
  prepareTask(session, { contract: contractFile, contextFileText: briefing }, objective);
  assert.equal(session.contract.context, 'Existing acceptance and reporting rules.\n\n' + briefing);
  saveSession(session);
  assert.equal(loadSession(session.id).contract.context, 'Existing acceptance and reporting rules.\n\n' + briefing);
});

test('invalid context and ambiguous positional initialization fail before backend or session creation', async () => {
  const cases = [
    ['missing.txt', /Cannot load --context-file.*ENOENT/],
    ['.', /regular text file/],
    ['empty.txt', /file is empty/],
    ['binary.txt', /UTF-8|encoded data|encoding/],
    ['nul.txt', /NUL/],
    ['oversize.txt', /exceeds 1 MiB/],
  ];
  fs.writeFileSync(path.join(directory, 'empty.txt'), ' \r\n\t');
  fs.writeFileSync(path.join(directory, 'binary.txt'), Buffer.from([0xff, 0xfe]));
  fs.writeFileSync(path.join(directory, 'nul.txt'), 'invalid\0text');
  fs.writeFileSync(path.join(directory, 'oversize.txt'), Buffer.alloc(1024 * 1024 + 1, 65));
  if (process.getuid?.() !== 0) {
    fs.writeFileSync(path.join(directory, 'unreadable.txt'), 'private', { mode: 0 });
    cases.push(['unreadable.txt', /EACCES|permission denied/]);
  }
  for (const [file, error] of cases) {
    const result = await run(['--context-file', file, '--goal', objective, '--codex', '--json']);
    assert.equal(result.code, 1); assert.match(result.stderr, error);
  }
  const conflict = await run(['Positional chat first', '--context-file', 'bzzy_init.txt', '--goal', objective, '--codex', '--json']);
  assert.equal(conflict.code, 1); assert.match(conflict.stderr, /Choose --context-file or positional/);
  assert.deepEqual(records(), []); assert.deepEqual(sessions(), []);
});

for (const provider of ['codex', 'deepseek', 'claude']) {
  test(`${provider}: persists the goal before execution and sends the full long context in the first native instructions`, { timeout: 30000 }, async () => {
    const result = await run(['--context-file', 'bzzy_init.txt', '--goal', objective, '--provider', provider, '--yolo', '--json']);
    assert.equal(result.code, 0, result.stderr + result.stdout.slice(-2000));
    const [session] = sessions();
    assert.equal(session.contract.objective, objective); assert.equal(session.goal.objective, objective);
    assert.equal(session.contract.context, briefing); assert.equal(session.goal.status, 'complete');
    const launchState = records().find(record => record.savedTask).savedTask;
    assert.equal(launchState.goal.objective, objective); assert.equal(launchState.goal.status, 'active');
    assert.equal(launchState.contract.context, briefing);
    assert.equal(taskContext(nativeInstructions(provider)[0]), briefing);
    assert.equal(records().filter(record => record.method === 'turn/start').length, 0, 'no ordinary initialization chat');
    const userEvents = result.stdout.trim().split('\n').map(JSON.parse).filter(event => event.type === 'message.user');
    assert.ok(userEvents.every(event => event.kind === 'goal' && event.text === objective));
    if (provider === 'claude') {
      const invocation = records().find(record => record.systemPrompt);
      assert.ok(invocation.args.includes('--append-system-prompt-file'));
      assert.equal(invocation.promptFileMode, 0o600);
      assert.ok(!fs.existsSync(invocation.args[invocation.args.indexOf('--append-system-prompt-file') + 1]), 'temporary prompt removed');
    } else {
      assert.equal(records().find(record => record.method === 'thread/goal/set' && record.params.status === 'active').params.objective, objective);
    }
  });
}

test('request IDs reject changed context and reuse identical contents without launching twice', async () => {
  const args = ['--context-file', 'bzzy_init.txt', '--goal', objective, '--codex', '--json', '--request-id', 'context-idempotency'];
  assert.equal((await run(args)).code, 0);
  const before = records().length;
  assert.equal((await run(args)).code, 0);
  assert.equal(records().length, before);
  fs.appendFileSync(path.join(directory, 'bzzy_init.txt'), '\nChanged scope and submission instructions.');
  const changed = await run(args);
  assert.equal(changed.code, 1); assert.match(changed.stderr, /Idempotency conflict/);
  assert.equal(records().length, before); assert.equal(sessions().length, 1);
  assert.equal(sessions()[0].contract.context, briefing);
});

for (const provider of ['codex', 'claude']) {
  test(`${provider}: pause during backend preparation retains a real goal and resume uses its saved instructions`, { timeout: 30000 }, async () => {
    const gate = path.join(directory, 'preparation-gate'); fs.writeFileSync(gate, 'wait');
    const active = launch(['--context-file', 'bzzy_init.txt', '--goal', objective, '--provider', provider, '--yolo', '--json'], {
      extraEnv: { BZZY_DIRECT: '1', BZZY_TEST_PREPARATION_GATE: gate },
    });
    try {
      await until(() => records().some(record => record.preparing), 'backend preparation');
      const [session] = sessions(); assert.equal(session.goal.objective, objective);
      const status = await run(['goal', 'status', session.id, '--json']);
      assert.equal(status.code, 0); assert.match(status.stdout, /find a new XSS/);
      active.child.kill('SIGINT');
      const paused = await active.done; assert.equal(paused.code, 130, paused.stderr);
      assert.equal(sessions()[0].goal.status, 'paused'); assert.equal(sessions()[0].goal.objective, objective);
      fs.writeFileSync(path.join(directory, 'bzzy_init.txt'), 'CHANGED FILE MUST NOT REPLACE SAVED CONTEXT');
      const resumed = await run(['--resume', session.id, '--yolo', '--json'], { extraEnv: { BZZY_DIRECT: '1' } });
      assert.equal(resumed.code, 0, resumed.stderr);
      assert.equal(sessions()[0].goal.objective, objective); assert.equal(sessions()[0].contract.context, briefing);
      assert.ok(nativeInstructions(provider).every(instructions => taskContext(instructions) === briefing));
    } finally { if (active.child.exitCode == null) active.child.kill('SIGKILL'); await active.done.catch(() => {}); }
  });
}

const ptyAvailable = process.platform === 'linux' && spawnSync('script', ['--version'], { stdio: 'ignore' }).status === 0;
test('interactive DeepSeek PTY: /goal status works during preparation, pause retains the goal, resume needs no source file', { skip: !ptyAvailable, timeout: 35000 }, async () => {
  const gate = path.join(directory, 'preparation-gate'); fs.writeFileSync(gate, 'wait');
  const active = launch(['--context-file', 'bzzy_init.txt', '--goal', objective, '--deepseek', '--yolo', '--no-pet'], {
    pty: true, extraEnv: { BZZY_TEST_PREPARATION_GATE: gate },
  });
  try {
    await until(() => records().some(record => record.preparing), 'interactive backend preparation');
    const [session] = sessions(); assert.equal(session.goal.objective, objective);
    active.child.stdin.write('/goal status\r');
    await until(() => active.stdout.includes('tokens used.'), '/goal status output');
    assert.ok(active.stdout.includes('Goal active')); assert.ok(active.stdout.includes(objective));
    active.child.stdin.write('/pause\r');
    const paused = await active.done; assert.equal(paused.code, 130, paused.stderr + paused.stdout.slice(-2000));
    assert.equal(sessions()[0].goal.status, 'paused'); assert.equal(sessions()[0].contract.context, briefing);
    fs.rmSync(gate); fs.rmSync(path.join(directory, 'bzzy_init.txt'));
    const resumedChat = launch(['--resume', session.id, '--yolo', '--no-pet'], { pty: true });
    await until(() => sessions()[0]?.goal?.status === 'complete' && resumedChat.stdout.includes('/providers · /models'), 'resumed goal returning to chat');
    resumedChat.child.stdin.write('/exit\r');
    const resumed = await resumedChat.done;
    assert.equal(resumed.code, 0, resumed.stderr + resumed.stdout.slice(-2000));
    assert.equal(sessions()[0].goal.status, 'complete'); assert.equal(sessions()[0].goal.objective, objective);
    assert.equal(sessions()[0].contract.context, briefing);
    assert.equal(taskContext(nativeInstructions('deepseek').at(-1)), briefing);
    assert.equal(records().filter(record => record.method === 'turn/start').length, 0);
  } finally { if (active.child.exitCode == null) active.child.kill('SIGKILL'); await active.done.catch(() => {}); }
});
