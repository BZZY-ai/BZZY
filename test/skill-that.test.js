import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createSession, saveSession, loadSession } from '../src/store.js';
import { BUILTINS } from '../src/providers.js';
import { newGoal } from '../src/goals.js';
import { appendEvent, putRecord, listRecords } from '../src/database.js';
import { captureEvidence } from '../src/evidence.js';
import { remember, checkpoint } from '../src/memory.js';
import { skillThat, goalSkillSources } from '../src/skill-that.js';
import { commandSuggestions } from '../src/terminal-commands.js';
import { CodexEngine } from '../src/engines/codex.js';
import { ClaudeEngine, claudeArgs } from '../src/engines/claude.js';
import { root } from '../src/process.js';
import { runtimeInfo, runtimeRequest } from '../src/runtime.js';
import { identityAlive } from '../src/recovery.js';

let directory, work, previous;
test.beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-skill-test-')); work = path.join(directory, 'project'); fs.mkdirSync(work);
  const keys = ['BZZY_HOME', 'BZZY_CODEX_HOME', 'BZZY_CODEX_BIN', 'BZZY_CLAUDE_BIN', 'BZZY_TEST_LOG', 'DEEPSEEK_API_KEY'];
  previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { BZZY_HOME: path.join(directory, 'private'), BZZY_CODEX_HOME: path.join(directory, 'native'),
    BZZY_CODEX_BIN: path.join(root, 'test/fixtures/document.mjs'), BZZY_CLAUDE_BIN: path.join(root, 'test/fixtures/document.mjs'),
    BZZY_TEST_LOG: path.join(directory, 'backend.jsonl'), DEEPSEEK_API_KEY: 'fixture-api-key' });
});
test.afterEach(async () => {
  const info = runtimeInfo();
  if (info && identityAlive(info.identity)) await runtimeRequest(info, 'POST', '/shutdown', {}).catch(() => {});
  for (let index = 0; index < 100 && info && identityAlive(info.identity); index++) await new Promise(resolve => setTimeout(resolve, 20));
  for (const [key, value] of Object.entries(previous)) if (value == null) delete process.env[key]; else process.env[key] = value;
  fs.rmSync(directory, { recursive: true, force: true });
});
function source(provider = 'codex') {
  fs.writeFileSync(path.join(work, 'control.txt'), 'positive and negative control outputs');
  const session = createSession(BUILTINS[provider], work, null, 'completed-work');
  session.goal = newGoal('Validate both controls'); session.goal.status = 'complete'; session.goal.tokensUsed = 123;
  session.acceptance = { passed: true }; saveSession(session);
  const evidence = captureEvidence(session, 'control.txt', 'observed-controls');
  remember(session, { kind: 'failed_approach', statement: 'Initial filter guessed wrong; the negative control disproved it.' });
  checkpoint(session, { completedWork: ['Compared both controls'], evidence: [evidence.id] });
  appendEvent(session.id, 'backend', { method: 'item/completed', params: { item: { type: 'commandExecution', command: 'python3 verify.py --target TARGET', exitCode: 0, aggregatedOutput: 'controls matched' } } });
  return { session, evidence };
}
const markdown = name => `---\nname: ${name}\ndescription: Verify a claim by comparing positive and negative controls.\n---\n\n# Verification\n\nSupply the target and environment variables. Reproduce the baseline, then compare the positive control against the negative control and record the observed outputs. Stop with an inconclusive result if the required inputs are unavailable. Read [the full recorded work](references/run-records.jsonl) and [evidence](references/evidence.json) for the concrete commands and failed approaches.\n`;

test('/skill_that preserves all recorded steps and evidence without changing the completed goal', async () => {
  const { session, evidence } = source(), before = structuredClone(loadSession(session.id));
  const unrelated = createSession(BUILTINS.codex, work); appendEvent(unrelated.id, 'text', { text: 'UNRELATED_TASK_MUST_NOT_APPEAR' });
  const child = createSession(BUILTINS.codex, work); child.parentSessionId = session.id; saveSession(child);
  appendEvent(child.id, 'activity', { summary: 'Worker independently checked the control' });
  let prompt;
  const skill = await skillThat(session, 'verify-controls', null, { async generate(input) { prompt = input; return markdown('verify-controls'); } });
  assert.match(prompt, /Initial filter guessed wrong/); assert.match(prompt, /python3 verify.py/); assert.match(prompt, /Worker independently/);
  assert.ok(!prompt.includes('UNRELATED_TASK_MUST_NOT_APPEAR'));
  assert.deepEqual(loadSession(session.id).goal, before.goal); assert.deepEqual(loadSession(session.id).acceptance, before.acceptance);
  assert.equal(fs.readFileSync(skill.path, 'utf8'), markdown('verify-controls'));
  const refs = path.join(path.dirname(skill.path), 'references'), index = JSON.parse(fs.readFileSync(path.join(refs, 'evidence.json'), 'utf8'));
  assert.ok(fs.readFileSync(path.join(refs, 'run-records.jsonl'), 'utf8').includes('controls matched'));
  assert.equal(index[0].id, evidence.id); assert.equal(fs.readFileSync(path.join(refs, index[0].path), 'utf8'), 'positive and negative control outputs');
  const next = await skillThat(session, 'verify-controls', null, { async generate(input) { return markdown(/frontmatter name: ([a-z0-9-]+)/.exec(input)[1]); } });
  assert.notEqual(next.path, skill.path); assert.equal(listRecords('execution').length, 0);
  assert.ok(commandSuggestions('/skill_').some(item => item.command === '/skill_that'));
});

test('skill generation requires completed work, validates the result and leaves no partial skill on failure', async () => {
  const { session } = source(); session.goal.status = 'active'; saveSession(session);
  await assert.rejects(skillThat(session, '', null, { generate() { throw new Error('Must not call a model'); } }), /completed goal/);
  session.goal.status = 'complete'; saveSession(session);
  let attempts = 0;
  await assert.rejects(skillThat(session, 'bad-output', null, { async generate() { attempts++; return 'incomplete'; } }), /complete SKILL.md/);
  assert.equal(attempts, 2); assert.deepEqual(fs.readdirSync(path.join(work, '.bzzy', 'skills')), []);
  putRecord('execution', randomUUID(), { sessionId: session.id, state: 'queued' });
  assert.throws(() => goalSkillSources(session), /still running/);
});

test('long runs retain the full reference while evidence extraction stays bounded', async () => {
  const { session } = source();
  for (let index = 0; index < 8; index++) appendEvent(session.id, 'text', { text: `${index}: ` + 'recorded-output '.repeat(1000) });
  let extracts = 0;
  const skill = await skillThat(session, 'long-run', null, { async generate(prompt) {
    assert.ok(prompt.length < 70000);
    if (prompt.includes('This is an evidence extraction pass')) { extracts++; return 'Recorded commands and controls retained; the raw reference contains full output.'; }
    return markdown('long-run');
  } });
  assert.ok(extracts > 1);
  const reference = fs.readFileSync(path.join(path.dirname(skill.path), 'references', 'run-records.jsonl'), 'utf8');
  assert.ok(reference.includes('7: recorded-output')); assert.ok(reference.length > 100000);
});

test('documentation mode denies tool requests and Claude disables built-in and configured tools', async () => {
  const codex = new CodexEngine(BUILTINS.codex, {}, { documentOnly: true }, {});
  assert.deepEqual(await codex.request('item/commandExecution/requestApproval', {}), { decision: 'decline' });
  await assert.rejects(codex.request('item/tool/call', { tool: 'http_request' }), /no tool access/);
  const claude = new ClaudeEngine(BUILTINS.claude, {}, { documentOnly: true }, {});
  assert.equal((await claude.handleControl({ request: { subtype: 'can_use_tool', tool_name: 'Bash' } })).behavior, 'deny');
  const args = claudeArgs({ provider: 'claude', id: randomUUID() }, { documentOnly: true });
  assert.equal(args[args.indexOf('--tools') + 1], ''); assert.ok(args.includes('--strict-mcp-config')); assert.ok(!args.includes('--dangerously-skip-permissions'));
});

for (const provider of ['codex', 'claude', 'deepseek']) {
  test(`skill drafting uses ${provider} for documentation without resuming the original goal`, async () => {
    const { session } = source(provider), goalBefore = structuredClone(session.goal);
    const skill = await skillThat(session, 'verify-controls');
    assert.match(fs.readFileSync(skill.path, 'utf8'), /name: verify-controls/);
    assert.deepEqual(loadSession(session.id).goal, goalBefore);
    const log = fs.readFileSync(process.env.BZZY_TEST_LOG, 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(!log.some(item => item.method?.startsWith('thread/goal/')));
    if (provider !== 'claude') {
      assert.equal(log.find(item => item.method === 'thread/start').params.sandbox, 'read-only');
      const args = log.find(item => item.args).args;
      assert.ok(args.includes('features.shell_tool=false')); assert.ok(args.includes('mcp_servers={}'));
    }
    else assert.ok(log.find(item => item.args).args.includes('--tools'));
    assert.equal(listRecords('execution').length, 0);
  });
}

const ptyAvailable = process.platform === 'linux' && spawnSync('script', ['--version'], { stdio: 'ignore' }).status === 0;
test('attached terminal /skill_that creates a portable skill and keeps the original goal completed', { skip: !ptyAvailable, timeout: 20000 }, async () => {
  const { session } = source();
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const command = [process.execPath, path.join(root, 'bin/bzzy.js'), '--attach', session.alias, '--no-pet'].map(quote).join(' ');
  const child = spawn('script', ['-qefc', command, '/dev/null'], { cwd: directory, env: { ...process.env, TERM: 'xterm-256color' }, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const done = new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
  async function until(check) {
    for (let index = 0; index < 500; index++) { if (check()) return; assert.equal(child.exitCode, null, output.slice(-2000)); await new Promise(resolve => setTimeout(resolve, 20)); }
    throw new Error('Missing terminal state: ' + output.slice(-2000));
  }
  try {
    await until(() => output.includes('completed-work'));
    child.stdin.write('/skill_that verify-controls\r');
    await until(() => fs.existsSync(path.join(work, '.bzzy', 'skills', 'verify-controls', 'SKILL.md')) && output.includes('Skill created:'));
    child.stdin.write('/exit\r'); assert.equal(await done, 0, output.slice(-2000));
    assert.equal(loadSession(session.id).goal.status, 'complete'); assert.equal(listRecords('execution').length, 0);
  } finally { if (child.exitCode == null) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} } await done.catch(() => {}); }
});
