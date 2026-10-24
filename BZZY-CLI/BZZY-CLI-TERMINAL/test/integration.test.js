import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
let dir;
test.beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-integration-')); });
test.afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function run(args, env = {}, onOutput) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'bin/bzzy.js'), ...args], {
      cwd: dir, env: { ...process.env, BZZY_DIRECT: '1', BZZY_HOME: path.join(dir, 'home'), BZZY_CODEX_HOME: path.join(dir, 'codex'), BZZY_CODEX_BIN: path.join(root, 'test/fixtures/codex.mjs'),
        BZZY_CLAUDE_BIN: path.join(root, 'test/fixtures/claude.mjs'), BZZY_TEST_LOG: path.join(dir, 'backend.jsonl'), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`CLI timed out. stdout=${stdout} stderr=${stderr}`)); }, 15000);
    child.stdout.on('data', chunk => { stdout += chunk; onOutput?.(child, stdout); });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}
const stored = () => fs.readdirSync(path.join(dir, 'home', 'sessions')).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(dir, 'home', 'sessions', f), 'utf8')))
  .filter(session => !['skill-writer', 'learning-review', 'knowledge-review'].includes(session.role));
const logs = () => fs.readFileSync(path.join(dir, 'backend.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);

test('native Codex goal waits across automatic continuation turns and persists completion', async () => {
  const result = await run(['goal', 'Finish the full task', '--provider', 'codex', '--json']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Verified the full objective/);
  assert.equal(stored()[0].goal.status, 'complete');
  assert.equal(stored()[0].goal.tokensUsed, 42);
  assert.equal(stored()[0].turns, 2);
  assert.ok(logs().some(m => m.method === 'thread/goal/set' && m.params.origin === 'user'));
  assert.ok(!fs.existsSync(path.join(dir, 'home', 'sessions', `${stored()[0].id}.json.lock`)));
});

test('positional context runs first on the same conversation and --goal stays the exact durable objective', async () => {
  const context = 'Read README.md first and use it as background';
  const objective = 'Implement only the requested task and verify it';
  let result;
  try {
    result = await run([context, '--goal', objective, '--provider', 'codex', '--json'], { BZZY_DIRECT: '0' });
  } finally {
    await run(['service', 'stop', '--json'], { BZZY_DIRECT: '0' }).catch(() => {});
  }
  assert.equal(result.code, 0, result.stderr);
  const [session] = stored();
  assert.equal(session.goal.objective, objective);
  assert.equal(session.contract.objective, objective);
  assert.match(session.contract.context, /Initial instruction supplied before this goal:/);
  assert.match(session.contract.context, /Read README\.md first and use it as background/);

  const backend = logs();
  const contextTurn = backend.findIndex(entry => entry.method === 'turn/start' && entry.params?.input?.[0]?.text === context);
  const resumedThread = backend.findIndex(entry => entry.method === 'thread/resume' && entry.params?.threadId === 'native-thread');
  const nativeGoal = backend.findIndex(entry => entry.method === 'thread/goal/set' && entry.params?.status === 'active');
  assert.ok(contextTurn >= 0, 'the initial instruction was not sent as a chat turn');
  assert.ok(resumedThread > contextTurn, 'the durable goal did not resume the context conversation');
  assert.ok(nativeGoal > resumedThread, 'the durable goal started before the context turn finished');
  assert.equal(backend[nativeGoal].params.objective, objective);
  assert.doesNotMatch(backend[nativeGoal].params.objective, /README/);
  const messages = result.stdout.trim().split('\n').map(line => JSON.parse(line)).filter(event => event.type === 'message.user');
  assert.deepEqual(messages.map(event => [event.kind, event.text]), [['chat', context], ['goal', objective]]);
});

test('saved provider, model and effort become the next launch defaults while flags override them', async () => {
  const home = path.join(dir, 'home'); fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ version: 1, defaultProvider: 'codex', providers: {}, defaultSelection: {
    provider: 'codex', model: 'fixture-brain', effort: 'xhigh', capabilities: { supportedEfforts: ['high', 'xhigh'] },
  } }));
  const first = await run(['run', 'Use the saved launch selection', '--json']);
  assert.equal(first.code, 0, first.stderr);
  let created = stored().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  assert.equal(created[0].provider, 'codex'); assert.equal(created[0].model, 'fixture-brain'); assert.equal(created[0].selectedEffort, 'xhigh');
  assert.deepEqual(created[0].modelCapabilities.supportedEfforts, ['high', 'xhigh']);

  const second = await run(['run', 'Override the launch selection', '--model', 'explicit-model', '--effort', 'low', '--json']);
  assert.equal(second.code, 0, second.stderr);
  created = stored().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  assert.equal(created[1].model, 'explicit-model'); assert.equal(created[1].selectedEffort, 'low');
  assert.equal(created[1].modelCapabilities, undefined);
});

test('a delayed turn-start notification cannot cause an early exit', async () => {
  const result = await run(['run', 'Inspect this directory', '--provider', 'codex']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /First pass/);
  assert.equal(stored()[0].turns, 1);
});
test('native Codex and Claude web visits produce attributed HTTP-panel events without inventing measured status', async () => {
  for (const provider of ['codex', 'claude']) {
    const result = await run(['run', 'Inspect the supplied page footer', '--provider', provider, '--json'], { BZZY_TEST_SCENARIO: 'web' });
    assert.equal(result.code, 0, result.stderr);
    const visits = result.stdout.trim().split('\n').map(line => JSON.parse(line)).filter(event => event.type === 'network.backend');
    assert.equal(visits.length, 2); assert.equal(visits.at(-1).backendState, 'completed');
    assert.equal(visits.at(-1).provenance, 'backend-reported'); assert.equal(visits.at(-1).status, null);
    assert.equal(visits.at(-1).localRequestObserved, false); assert.match(visits.at(-1).url, /paypal\.com/);
    assert.doesNotMatch(JSON.stringify(visits), /fixture-secret/);
    const progress = result.stdout.trim().split('\n').map(line => JSON.parse(line)).filter(event => event.type === 'activity');
    assert.ok(progress.some(event => event.summary === 'Checking the footer on www.paypal.com' && /opening.*footer.*text/.test(event.details)));
    assert.doesNotMatch(JSON.stringify(progress), /fixture-secret|curl -|Authorization/);
  }
});

test('resuming a completed goal does not start unrequested work', async () => {
  await run(['goal', 'Finish this task', '--provider', 'codex']);
  const before = logs().length;
  const resumed = await run(['--resume', stored()[0].id]);
  assert.equal(resumed.code, 0);
  assert.match(resumed.stdout, /already complete/);
  assert.equal(logs().length, before);
  const goalResume = await run(['goal', 'resume', stored()[0].id]);
  assert.equal(goalResume.code, 1);
  assert.equal(logs().length, before);
});

test('noninteractive Codex approvals fail closed and yolo explicitly changes both controls', async () => {
  const denied = await run(['run', 'Do work', '--provider', 'codex'], { BZZY_TEST_SCENARIO: 'approval' });
  assert.match(denied.stdout, /decision:decline/);
  assert.match(denied.stderr, /Approval required/);
  const allowed = await run(['run', 'Do work', '--provider', 'codex', '--yolo'], { BZZY_TEST_SCENARIO: 'approval' });
  assert.match(allowed.stdout, /decision:accept/);
  assert.ok(logs().filter(m => m.args).some(m => m.args.includes('sandbox_mode="danger-full-access"')));
});

test('Ctrl+C pauses an active native goal and leaves a resumable session', async () => {
  let signalled = false;
  const result = await run(['goal', 'Wait for work', '--provider', 'codex', '--json'], { BZZY_TEST_SCENARIO: 'interrupt' }, (child, output) => {
    if (!signalled && output.includes('"status":"active"')) { signalled = true; setTimeout(() => child.kill('SIGINT'), 40); }
  });
  assert.equal(result.code, 130, result.stderr);
  assert.equal(stored()[0].goal.status, 'paused');
  const resumed = await run(['resume', stored()[0].id]);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(stored()[0].goal.status, 'complete');
});

test('Claude goal completion uses the unmodified CLI protocol and a scoped MCP report', async () => {
  const result = await run(['goal', 'Finish and verify', '--provider', 'claude', '--json'], { ANTHROPIC_API_KEY: 'must-not-use', ANTHROPIC_AUTH_TOKEN: 'must-not-use' });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(stored()[0].goal.status, 'complete');
  assert.equal(stored()[0].goal.tokensUsed, 15);
  assert.equal(logs()[0].apiKeyPresent, false);
  assert.equal(logs()[0].tokenPresent, false);
  assert.ok(logs()[0].args.includes('--permission-prompt-tool'));
});

test('Claude retries the same blocker across three turns, then emits a stalled event', async () => {
  const result = await run(['goal', 'Finish and verify', '--provider', 'claude'], { BZZY_TEST_SCENARIO: 'blocked' });
  assert.equal(result.code, 2, result.stderr);
  const session = stored()[0];
  assert.equal(session.goal.status, 'blocked');
  assert.equal(session.goal.turns, 3);
  const file = fs.readdirSync(path.join(dir, 'home', 'notifications'))[0];
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'home', 'notifications', file))).event.type, 'goal.stalled');
});

test('Claude goal no-activity breaker and turn limit preserve incomplete status', async () => {
  const limited = await run(['goal', 'Continue useful work', '--provider', 'claude', '--max-turns', '2'], { BZZY_TEST_SCENARIO: 'working' });
  assert.equal(limited.code, 2, limited.stderr);
  assert.equal(stored()[0].goal.status, 'paused');
  const empty = await run(['goal', 'Continue useful work', '--provider', 'claude'], { BZZY_TEST_SCENARIO: 'empty' });
  assert.equal(empty.code, 2, empty.stderr);
  assert.ok(stored().some(s => s.goal.status === 'blocked' && s.goal.turns === 3));
});

test('Claude permissions are denied when no user can answer; explicit yolo permits them', async () => {
  const denied = await run(['run', 'Do work', '--provider', 'claude'], { BZZY_TEST_SCENARIO: 'approval' });
  assert.match(denied.stdout, /decision:deny/);
  const allowed = await run(['run', 'Do work', '--provider', 'claude', '--yolo'], { BZZY_TEST_SCENARIO: 'approval' });
  assert.match(allowed.stdout, /decision:allow/);
});

test('backend failures persist blocked status instead of pretending the goal completed', async () => {
  const result = await run(['goal', 'Do work', '--provider', 'claude'], { BZZY_TEST_SCENARIO: 'error' });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /infrastructure failure/);
  assert.equal(stored()[0].goal.status, 'blocked');
});
