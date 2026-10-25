import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseArgs } from '../src/cli.js';
import { createSession, lockSession, readJson, sessionPath, writeJson } from '../src/store.js';
import { BUILTINS, addProvider, getProvider } from '../src/providers.js';
import { newGoal, applyReport, continuationPrompt, readReport, writeReport } from '../src/goals.js';
import { claudeArgs, claudeEnvironment, ClaudeEngine } from '../src/engines/claude.js';
import { codexLaunch, codexSandboxMode } from '../src/engines/codex.js';
import { assessObjectionDispositions, formatInvestigation } from '../src/debate-format.js';
import { investigationConsensus, investigationReadiness } from '../src/investigation.js';
import { randomUUID } from 'node:crypto';

let dir;
test.beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-core-')); process.env.BZZY_HOME = dir; process.env.BZZY_CODEX_HOME = path.join(dir, 'codex'); });
test.afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); delete process.env.BZZY_HOME; delete process.env.BZZY_CODEX_HOME; });

test('yolo is opt-in on every invocation, including resume; malformed budgets fail early', () => {
  assert.equal(parseArgs(['--yolo', 'goal', 'finish']).options.yolo, true);
  assert.equal(parseArgs(['--minimal']).options.minimal, true);
  assert.throws(() => parseArgs(['--canvas']), /canvas interface was removed.*bzzy/i);
  assert.equal(parseArgs(['--settings']).options.settingsRequested, true);
  assert.equal(parseArgs([]).options.minimal, undefined);
  assert.equal(parseArgs(['resume', 'a']).options.yolo, false);
  for (const value of ['0', '-1', 'Infinity', '1.1', '9007199254740992']) assert.throws(() => parseArgs(['--token-budget', value]));
  assert.throws(() => parseArgs(['--provider', '--yolo']));
  assert.equal(parseArgs(['--resume', 'saved-session']).options.resume, 'saved-session');
  assert.throws(() => parseArgs(['--resume', 'saved', '--attach', 'other']), /Choose/);
});

test('provider and workflow shortcuts select chat backends and bounded modes directly', () => {
  assert.equal(parseArgs(['--delegate']).options.mode, 'delegate');
  assert.equal(parseArgs(['--delegate']).options.delegationSetup, true);
  for (const provider of ['codex', 'claude', 'deepseek']) assert.equal(parseArgs(['--' + provider]).options.provider, provider);
  assert.equal(parseArgs(['--parallel', '--claude']).options.mode, 'parallel');
  for (const effort of ['none', 'minimal']) assert.equal(parseArgs(['--provider', 'abliteration', '--effort', effort]).options.effort, effort);
  assert.equal(parseArgs(['--debate', '--rounds', '5']).options.mode, 'debate');
  assert.equal(parseArgs(['--validate', '--rounds', '5']).options.mode, 'debate');
  assert.equal(parseArgs(['--mode', 'validate']).options.mode, 'debate');
  assert.equal(parseArgs(['validate', 'Check the original goal.']).args[0], 'validate');
  assert.throws(() => parseArgs(['--debate', '--rounds', '6']), /Maximum 5/);
});

test('a positional instruction can accompany an exact --goal objective', () => {
  const parsed = parseArgs(['Read README.md first', '--goal', 'Implement the requested change', '--provider', 'codex']);
  assert.deepEqual(parsed.args, ['Read README.md first']);
  assert.equal(parsed.options.goal, 'Implement the requested change');
  assert.equal(parsed.options.provider, 'codex');
});

test('credentials and sessions are private, locks prevent a concurrent owner', () => {
  const session = createSession(BUILTINS.codex, dir);
  assert.equal(fs.statSync(sessionPath(session.id)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(sessionPath(session.id))).mode & 0o777, 0o700);
  const release = lockSession(session);
  assert.throws(() => lockSession(session), /already running/);
  release();
  lockSession(session)();
  assert.throws(() => sessionPath('../../outside'));
});

test('custom providers cannot embed credentials in URLs or redirect to plaintext remote hosts', () => {
  for (const baseUrl of ['http://remote.example', 'https://user:password@api.example', 'https://api.example?key=secret']) {
    assert.throws(() => addProvider('custom', { baseUrl, envKey: 'CUSTOM_KEY', model: 'model' }));
  }
  addProvider('custom', { baseUrl: 'https://api.example/v1', envKey: 'CUSTOM_KEY', model: 'model' });
  assert.equal(getProvider('custom').baseUrl, 'https://api.example/v1');
});

test('goal blockers require three consecutive matching turns and resume counters can reset', () => {
  const session = createSession(BUILTINS.claude, dir);
  session.goal = newGoal('Finish the full migration');
  const report = { status: 'blocked', blocker: 'External service unavailable', evidence: ['Live check failed.'] };
  applyReport(session, report, true, 10);
  applyReport(session, { ...report, blocker: 'Another condition' }, true, 10);
  applyReport(session, report, true, 10);
  assert.equal(session.goal.status, 'active');
  applyReport(session, report, true, 10);
  assert.equal(session.goal.status, 'active');
  applyReport(session, report, true, 10);
  assert.equal(session.goal.status, 'blocked');
});

test('goal reports are scoped to a single turn and incomplete reports cannot complete work', () => {
  const session = createSession(BUILTINS.claude, dir);
  const nonce = randomUUID();
  assert.throws(() => writeReport(session.id, nonce, { status: 'complete', evidence: [] }));
  writeReport(session.id, nonce, { status: 'complete', evidence: ['Ran the required tests.'] });
  assert.equal(readReport(session.id, randomUUID()), null);
  assert.equal(readReport(session.id, nonce).status, 'complete');
  assert.equal(readReport(session.id, nonce), null);
});

test('budgets and no-activity breakers stop continuation without claiming completion', () => {
  const session = createSession(BUILTINS.claude, dir);
  session.goal = newGoal('Verify everything', 20);
  applyReport(session, null, true, 21);
  assert.equal(session.goal.status, 'budget_limited');
  session.goal = newGoal('Verify everything');
  for (let i = 0; i < 3; i++) applyReport(session, null, false, 1);
  assert.equal(session.goal.status, 'blocked');
  assert.match(continuationPrompt(newGoal('Fix <all> & test')), /Fix &lt;all&gt; &amp; test/);
});

test('backend permission mappings are explicit and subscription launch does not inherit API credentials', () => {
  const session = createSession(BUILTINS.codex, dir);
  const normal = codexLaunch(BUILTINS.codex, session, {});
  const yolo = codexLaunch(BUILTINS.codex, session, { yolo: true });
  assert.ok(normal.args.includes('sandbox_mode="workspace-write"'));
  assert.ok(yolo.args.includes('sandbox_mode="danger-full-access"'));
  assert.equal(codexSandboxMode({ strictPolicy: true, policy: { mode: 'read-only', network: 'inherit' } }), 'danger-full-access');
  assert.equal(codexSandboxMode({ strictPolicy: true, policy: { mode: 'read-only', network: 'disabled' } }), 'read-only');
  assert.ok(yolo.args.includes('approval_policy="never"'));
  assert.equal(normal.env.OPENAI_API_KEY, undefined);
  assert.ok(claudeArgs(session, { yolo: true }, undefined, 1000).includes('--dangerously-skip-permissions'));
  assert.ok(!claudeArgs(session, { yolo: true }, undefined, 0).includes('--dangerously-skip-permissions'));
  assert.ok(!claudeArgs(session, { scopedAutonomy: true }, undefined, 0).includes('--dangerously-skip-permissions'));
  assert.ok(!claudeArgs(session, {}, undefined, 1000).includes('--dangerously-skip-permissions'));
  process.env.ANTHROPIC_API_KEY = 'test-sentinel';
  assert.equal(claudeEnvironment().ANTHROPIC_API_KEY, undefined);
  delete process.env.ANTHROPIC_API_KEY;
});

test('debate investigation failures show their durable reason', () => {
  assert.equal(formatInvestigation({ state: 'failed', error: 'Claude could not start\nunder this account.' }),
    'The check could not finish. Evidence remains incomplete.\nReason: Claude could not start under this account.');
  assert.equal(formatInvestigation({ state: 'awaiting_review', report: { summary: 'Evidence was recorded.' } }), 'Evidence was recorded.');
});

test('debate opens only when independent reports contain a usable conclusion and preserved evidence', () => {
  const good = provider => ({ participant: { provider }, state: 'awaiting_review', report: { status: 'complete', summary: 'Validated.', evidence: [`${provider}-proof`] },
    artifacts: [{ originalId: `${provider}-proof`, id: `${provider}-import` }] });
  assert.equal(investigationReadiness({ reports: [good('codex'), good('claude'), { participant: { provider: 'deepseek' }, state: 'timed_out', error: 'runtime_limit' }] }, 3).passed, true);
  const stopped = investigationReadiness({ reports: [
    { participant: { provider: 'codex' }, state: 'awaiting_review', report: { status: 'inconclusive', summary: 'No runnable evidence.', evidence: [] }, artifacts: [] },
    { participant: { provider: 'claude' }, state: 'timed_out', error: 'runtime_limit' },
    { participant: { provider: 'deepseek' }, state: 'awaiting_review', report: { status: 'blocked', summary: 'No target.', evidence: [] }, artifacts: [] },
  ] }, 3);
  assert.equal(stopped.passed, false); assert.equal(stopped.usable, 0); assert.match(stopped.reasons.join('\n'), /inconclusive|timed_out|blocked/);
});

test('resolved objections require inspected evidence while missing dispositions remain unresolved', () => {
  const reports = [{ report: { objections: [{ id: 'severity', claim: 'Severity should be Medium.' }] } }];
  const resolved = assessObjectionDispositions(reports, { remainingObjections: [], objectionDispositions: [{ id: 'severity', status: 'accepted', rationale: 'Severity corrected to Medium.' }] });
  assert.equal(resolved.complete, false); assert.ok(resolved.unresolved.length, 'a model-written acceptance without evidence cannot resolve an objection');
  const missing = assessObjectionDispositions(reports, { remainingObjections: [], objectionDispositions: [] });
  assert.equal(missing.complete, false); assert.match(missing.unresolved[0], /no main-agent disposition/);
});

test('two evidence-backed matching verdicts form consensus when the third agent times out', () => {
  const vote = (provider, verdict) => ({ participant: { provider }, state: 'awaiting_review', report: { status: 'complete', verdict, summary: `${verdict} finding`, evidence: [`${provider}-proof`] },
    artifacts: [{ originalId: `${provider}-proof`, id: `${provider}-import` }] });
  const consensus = investigationConsensus({ reports: [vote('codex', 'real'), { participant: { provider: 'claude' }, state: 'timed_out', error: 'runtime_limit' }, vote('deepseek', 'real')] }, 3);
  assert.equal(consensus.reached, true); assert.equal(consensus.verdict, 'real'); assert.equal(consensus.required, 2); assert.equal(consensus.counts.real, 2);
  assert.equal(consensus.votes.find(item => item.provider === 'claude').counted, false);
});

test('the DeepSeek key is passed only in the child environment, never in CLI args or model files', () => {
  const inherited = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    writeJson(path.join(dir, 'credentials.json'), { deepseek: 'secret-sentinel' });
    const session = createSession(BUILTINS.deepseek, dir);
    const launch = codexLaunch(BUILTINS.deepseek, session, {});
    assert.equal(launch.env.BZZY_PROVIDER_API_KEY, 'secret-sentinel');
    assert.ok(!launch.args.join(' ').includes('secret-sentinel'));
    const catalog = readJson(path.join(dir, 'runtime', `${session.id}-models.json`));
    assert.ok(!JSON.stringify(catalog).includes('secret-sentinel'));
    assert.equal(catalog.models[0].slug, 'deepseek-flash');
  } finally {
    if (inherited == null) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = inherited;
  }
});

test('Claude user questions collect actual answers, even in yolo mode, and never invent an answer headlessly', async () => {
  const request = { request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: {
    questions: [{ question: 'Which environment?', options: [{ label: 'Local' }] }],
  } } };
  const interactive = new ClaudeEngine(BUILTINS.claude, {}, { yolo: true }, { interactive: true, ask: async () => 'Local' });
  const answered = await interactive.handleControl(request);
  assert.equal(answered.updatedInput.answers['Which environment?'], 'Local');
  const headless = new ClaudeEngine(BUILTINS.claude, {}, { yolo: true }, { interactive: false });
  assert.equal((await headless.handleControl(request)).behavior, 'deny');
});
