import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createSession, saveSession } from '../src/engine/store.js';
import { getProvider } from '../src/engine/providers.js';
import { projectIdentityForSession } from '../src/engine/project-identity.js';
import { appendEvent, getRecord, putRecord, listRecords } from '../src/engine/database.js';
import { inspectSkill, inspectSkillCandidate, listSkills, setSkillEnabled, createSkill, stageSkillCandidate, acceptSkillCandidate } from '../src/engine/skills.js';
import { queueLearningReview, inspectLearningJob, listLearningJobs, runLearningJob, processLearningReviews,
  pauseLearningForSession, recoverLearningJobs, controlLearningJob, learningMaterial, configureLearning, learningUsage } from '../src/engine/learning.js';
import { registerLearningFixtures, evaluateLearningCandidate, runLearningEvaluationJob, inspectLearningEvaluation, revokeLearningFixtures } from '../src/engine/learning-evaluation.js';
import { codexLaunch } from '../src/engine/engines/codex.js';
import { claudeArgs } from '../src/engine/engines/claude.js';
import { learningWorkingDirectory } from '../src/engine/learning-backend.js';
import { knowledgeProfileProposals, listKnowledgeProfiles } from '../src/engine/knowledge.js';
import { processIdentity, identityAlive } from '../src/engine/process-identity.js';

let root, session, prior;
const names = ['BZZY_HOME', 'BZZY_CODEX_HOME', 'BZZY_CODEX_BIN', 'BZZY_ENV_ALLOW', 'BZZY_TEST_LEARNING_LOG', 'BZZY_TEST_LEARNING_BAD_PROFILE'];
test.beforeEach(() => {
  prior = Object.fromEntries(names.map(name => [name, process.env[name]]));
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-learning-')));
  process.env.BZZY_HOME = path.join(root, 'private');
  process.env.BZZY_CODEX_HOME = path.join(root, 'fixture-auth'); fs.mkdirSync(process.env.BZZY_CODEX_HOME, { mode: 0o700 });
  fs.writeFileSync(path.join(process.env.BZZY_CODEX_HOME, 'auth.json'), '{}', { mode: 0o600 });
  const cwd = path.join(root, 'project'); fs.mkdirSync(cwd);
  session = createSession(getProvider('codex'), cwd, 'offline-review-model'); session.projectRoot = cwd;
  projectIdentityForSession(session, { create: true }); saveSession(session);
});
test.afterEach(() => { for (const name of names) if (prior[name] === undefined) delete process.env[name]; else process.env[name] = prior[name]; fs.rmSync(root, { recursive: true, force: true }); });
const message = (text = 'Compare owner and anonymous baselines; keep missing proof inconclusive.') => appendEvent(session.id, 'message.user', { text });
const queued = (reason = 'explicit') => queueLearningReview(session, { reason, sourceId: message().id });
const noChange = async () => ({ text: '{"lessons":[],"skills":[],"profiles":[]}', tokens: 100 });
const fixtureDefinition = () => ({ name: 'Held-out decision cases', cases: [
  { id: 'confirmed-case', observations: 'A controlled unauthorized account repeatedly obtained another account’s private resource. The authorized baseline and resource ownership were verified.', expected: 'real' },
  { id: 'disproved-case', observations: 'The scanner matched a login page, not the private resource. Repeated role-controlled tests verified the resource was withheld.', expected: 'false_positive' },
  { id: 'missing-proof', observations: 'The test could not authenticate or reach the relevant resource. No controlled authorization comparison was possible.', expected: 'inconclusive' },
] });
const expectedOutput = () => ({ text: JSON.stringify({ results: fixtureDefinition().cases.map(item => ({ id: item.id, verdict: item.expected })) }), tokens: 100 });
const candidate = (name = 'authorization-review') => stageSkillCandidate({ name, description: 'Validate authorization claims with controls.', instructions: 'Compare resource ownership and authorized, unauthorized and anonymous observations. Classify unavailable proof as inconclusive. Require repeatable decisive evidence.' }, { session });

test('automatic triggers coalesce, keep idempotent receipts, and preserve stopped learning without inferred resume', async () => {
  const first = message(), a = queueLearningReview(session, { reason: 'finding_outcome', sourceId: first.id, requestId: 'once' });
  const duplicate = queueLearningReview(session, { reason: 'finding_outcome', sourceId: first.id, requestId: 'once' });
  assert.equal(a.id, duplicate.id);
  const b = queueLearningReview(session, { reason: 'recorded_lesson', sourceId: message('A useful verified fix.').id });
  assert.equal(a.id, b.id); assert.equal(b.triggerCount, 2); assert.equal(listLearningJobs(session).length, 1);
  pauseLearningForSession(session.id); session.executionState = 'idle'; saveSession(session);
  let calls = 0; assert.deepEqual(await processLearningReviews({ runReview: async () => { calls++; return noChange(); } }), []);
  assert.equal(calls, 0); assert.equal(inspectLearningJob(a.id).state, 'paused');
  const fresh = queued(); assert.deepEqual(recoverLearningJobs(), [fresh.id]);
  assert.equal(inspectLearningJob(fresh.id).reasonPaused, 'recovery_required');
});

test('review material is bounded own-session visible data and excludes credentials, raw tools and private reasoning', () => {
  message('Use password=fixture-private-value only through the account gateway.');
  message('Fixtures: {"api_key":"quoted-private-value"}; password: \'quoted-password-value\'; https://owner:url-private-value@example.invalid/path');
  appendEvent(session.id, 'backend', { params: { reasoning: 'HIDDEN REASONING' } });
  appendEvent(session.id, 'tool', { output: 'RAW TOOL PRIVATE DATA' });
  const other = createSession(getProvider('codex'), path.join(root, 'private'), 'other'); appendEvent(other.id, 'text', { text: 'OTHER PROJECT CONTENT' });
  const job = queued(), material = JSON.stringify(learningMaterial(job).material);
  assert.match(material, /redacted/); assert.doesNotMatch(material, /fixture-private-value|quoted-private-value|quoted-password-value|url-private-value|HIDDEN REASONING|RAW TOOL|OTHER PROJECT/);
  assert.ok(Buffer.byteLength(material) <= 17000);
});

test('a bounded review adds attributed hypotheses, pending profile proposals and enabled project library skills', async () => {
  const source = message('For reports, use concise reproducible steps and mark uncertainty.');
  const job = queueLearningReview(session, { reason: 'user_correction', sourceId: source.id });
  const result = await runLearningJob(job.id, { runReview: async () => ({ tokens: 200, text: JSON.stringify({
    lessons: [{ kind: 'hypothesis', statement: 'A controlled baseline comparison may prevent a repeated false positive.', rationale: 'The user requested explicit uncertainty and reproducibility.', evidence: [], sourceIds: [source.id] }],
    skills: [{ name: 'compare-auth-baselines', description: 'Review authorization observations.', instructions: 'Compare ownership, authorized and unauthorized baselines. Verify resource content. Preserve inconclusive outcomes when decisive evidence is unavailable.', sourceIds: [source.id] }],
    profiles: [{ target: 'user', text: 'Prefer concise reports with reproducible steps and explicit uncertainty.', reason: 'The user explicitly requested this report style.', sourceId: source.id }],
  }) }) });
  assert.equal(result.state, 'completed'); assert.equal(result.result.lessonIds.length, 1); assert.equal(result.result.candidateIds.length, 0);
  const lesson = getRecord('memory', result.result.lessonIds[0]); assert.equal(lesson.truth, 'hypothesis'); assert.equal(lesson.provenance.jobId, job.id);
  const learned = inspectSkill(result.result.skillIds[0], { session }); assert.equal(learned.scope, 'project'); assert.equal(learned.enabled, true);
  assert.equal(learned.provenance.kind, 'learning'); assert.equal(learned.provenance.jobId, job.id);
  assert.equal(listSkills({ session, enabledOnly: true }).total, 1);
  assert.equal(knowledgeProfileProposals().items.length, 1); assert.ok(listKnowledgeProfiles().every(item => !item.text));
  assert.equal(listRecords('execution').length, 0);
});

test('model assertions and foreign source references fail before any learned record is published', async () => {
  const job = queued(), source = message('Later source is outside this review snapshot.');
  const result = await runLearningJob(job.id, { runReview: async () => ({ tokens: 50, text: JSON.stringify({ lessons: [{ kind: 'conclusion', truth: 'confirmed', statement: 'Unsupported claim.', rationale: 'Repeated model agreement.', evidence: [], sourceIds: [source.id] }], skills: [] }) }) });
  assert.equal(result.state, 'failed'); assert.equal(listRecords('memory').length, 0); assert.equal(listRecords('core.skill.candidate').length, 0);
});

test('explicit crash recovery finishes identical cached proposals without another model request or duplicate lessons', async () => {
  const source = message(), job = queueLearningReview(session, { reason: 'user_correction', sourceId: source.id });
  const completed = await runLearningJob(job.id, { runReview: async () => ({ tokens: 100, text: JSON.stringify({
    lessons: [{ kind: 'hypothesis', statement: 'Retain a controlled baseline before classifying the result.', rationale: 'The user requested baseline controls.', evidence: [], sourceIds: [source.id] }], skills: [],
  }) }) });
  const interrupted = getRecord('core.learning.job', job.id);
  // Model a process loss after side effects and before its completed marker.
  putRecord('core.learning.job', job.id, { ...interrupted, state: 'running', runner: null,
    totalTokensUsed: interrupted.budget.tokenBudget, timeUsedMs: interrupted.budget.runtimeSeconds * 1000 });
  assert.deepEqual(recoverLearningJobs(), [job.id]);
  const paused = inspectLearningJob(job.id); controlLearningJob(job.id, 'resume', { expectedRevision: paused.revision });
  const resumed = await runLearningJob(job.id, { runReview: async () => assert.fail('An inspected result is not reviewed twice') });
  assert.equal(resumed.state, 'completed'); assert.deepEqual(resumed.result.lessonIds, completed.result.lessonIds);
  assert.equal(listRecords('memory').length, 1); assert.equal(learningUsage().tokensUsed, 100);
});

test('pause while the model is pending rejects late output and safely settles a daily reservation', async () => {
  const job = queued(); let started, release;
  const began = new Promise(resolve => { started = resolve; }), held = new Promise(resolve => { release = resolve; });
  const running = runLearningJob(job.id, { runReview: async () => { started(); return held; } });
  await began; pauseLearningForSession(session.id); release(await noChange());
  const result = await running; assert.equal(result.state, 'paused'); assert.equal(listRecords('memory').length, 0);
  assert.equal(learningUsage().reservedTokens, 0); assert.ok(learningUsage().tokensUsed >= 100);
});

test('the learning pump waits for an interrupted adapter to finish closing before shutdown completes', async () => {
  const job = queued(); let began, closed = false;
  const started = new Promise(resolve => { began = resolve; });
  const running = runLearningJob(job.id, { runReview: ({ signal }) => new Promise(resolve => {
    began(); signal.addEventListener('abort', () => setTimeout(async () => { closed = true; resolve(await noChange()); }, 20), { once: true });
  }) });
  await started; pauseLearningForSession(session.id); const result = await running;
  assert.equal(closed, true); assert.equal(result.state, 'paused'); assert.equal(listRecords('memory').length, 0);
});

test('daily token reservations and pending limits apply to explicit work too', async () => {
  configureLearning({ tokenBudget: 1000, dailyTokenBudget: 1000, maxPendingPerProject: 1 }, { expectedRevision: 0 });
  const first = queued(), overflow = queued(); assert.equal(overflow.state, 'paused'); assert.equal(overflow.reasonPaused, 'queue_limit');
  const completed = await runLearningJob(first.id, { runReview: async () => ({ text: '{"lessons":[],"skills":[]}', tokens: 1000 }) });
  assert.equal(completed.state, 'completed'); assert.equal(learningUsage().remainingTokens, 0);
  const next = queued(), stopped = await runLearningJob(next.id, { runReview: async () => { assert.fail('No model call after daily exhaustion'); } });
  assert.equal(stopped.state, 'paused'); assert.equal(stopped.reasonPaused, 'daily_budget');
});

test('explicit reviews and evaluations requested while learning is disabled remain paused after it is enabled', async () => {
  configureLearning({ enabled: false }, { expectedRevision: 0 });
  const automatic = queueLearningReview(session, { reason: 'finding_outcome', sourceId: message().id }); assert.equal(automatic, null);
  const explicit = queued(); assert.equal(explicit.state, 'paused'); assert.equal(explicit.reasonPaused, 'owner_disabled');
  const draft = candidate(), dataset = registerLearningFixtures(fixtureDefinition(), { session, reviewed: true });
  const evaluation = await evaluateLearningCandidate(draft.id, { session, datasetId: dataset.id, expectedRevision: draft.revision,
    runReview: async () => assert.fail('Disabled learning cannot run an explicit evaluation') });
  assert.equal(evaluation.state, 'paused'); assert.equal(evaluation.reasonPaused, 'owner_disabled');
  configureLearning({ enabled: true }, { expectedRevision: 1 });
  await processLearningReviews({ runReview: async () => assert.fail('Enabling learning must not infer a job resume') });
  assert.equal(inspectLearningJob(explicit.id).state, 'paused'); assert.equal(inspectLearningJob(evaluation.id).state, 'paused');
  controlLearningJob(explicit.id, 'resume', { expectedRevision: explicit.revision });
  assert.equal((await runLearningJob(explicit.id, { runReview: noChange })).state, 'completed');
});

test('parent pause is reconciled while foreground work blocks the pump and later idle never resumes that review', async () => {
  const job = queued(); session.executionState = 'paused'; saveSession(session);
  await processLearningReviews({ canRun: () => false }); assert.equal(inspectLearningJob(job.id).state, 'paused');
  session.executionState = 'idle'; saveSession(session);
  await processLearningReviews({ runReview: async () => assert.fail('Owner pause needs an explicit learning resume') });
  assert.equal(inspectLearningJob(job.id).state, 'paused');
});

test('recovery terminates only a verified orphan review backend and never dispatches its historical task', async () => {
  const job = queued(), child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  const closed = new Promise(resolve => child.once('close', resolve)); await new Promise(resolve => child.once('spawn', resolve));
  const native = processIdentity(child.pid); assert.ok(native);
  try {
    const review = createSession(getProvider('codex'), root, 'no-model');
    Object.assign(review, { role: 'learning-review', learningJobId: job.id, backendProcess: native }); saveSession(review);
    putRecord('core.learning.job', job.id, { ...getRecord('core.learning.job', job.id), state: 'paused', reviewSessionId: review.id });
    assert.deepEqual(recoverLearningJobs(), []); await closed;
    assert.equal(identityAlive(native), false); assert.equal(inspectLearningJob(job.id).state, 'paused'); assert.equal(listRecords('execution').length, 0);
  } finally { if (identityAlive(native)) process.kill(child.pid, 'SIGKILL'); }
});

test('approved held-out fixtures keep labels out of prompts and host comparisons gate owner activation', async () => {
  const draft = candidate(), dataset = registerLearningFixtures(fixtureDefinition(), { session, reviewed: true });
  const result = await evaluateLearningCandidate(draft.id, { session, datasetId: dataset.id, expectedRevision: draft.revision,
    runReview: async ({ prompt }) => {
      assert.doesNotMatch(prompt, /"expected"\s*:/); assert.match(prompt, /expected labels are deliberately withheld/);
      return expectedOutput();
    } });
  const evaluation = inspectLearningEvaluation(result.result.evaluationId, { session });
  assert.equal(evaluation.status, 'passed'); assert.equal(evaluation.mode, 'semantic-fixture'); assert.equal(evaluation.metrics.baselineAvailable, false); assert.equal(evaluation.metrics.improvementDemonstrated, false);
  const evaluated = inspectSkillCandidate(draft.id, { session });
  assert.equal(listSkills({ session, enabledOnly: true }).total, 0);
  assert.throws(() => acceptSkillCandidate(draft.id, { expectedRevision: evaluated.revision, expectedSkillRevision: 0, expectedEvaluationId: evaluation.id, activate: true }, { session }), /review/i);
  const accepted = acceptSkillCandidate(draft.id, { expectedRevision: evaluated.revision, expectedSkillRevision: 0, expectedEvaluationId: evaluation.id, activate: true, reviewed: true }, { session });
  assert.equal(accepted.enabled, true);
});

test('wrong fixture answers and revoked datasets cannot authorize a skill', async () => {
  const draft = candidate(), dataset = registerLearningFixtures(fixtureDefinition(), { session, reviewed: true });
  const result = await evaluateLearningCandidate(draft.id, { session, datasetId: dataset.id, expectedRevision: draft.revision,
    runReview: async () => ({ tokens: 50, text: JSON.stringify({ results: fixtureDefinition().cases.map(item => ({ id: item.id, verdict: 'real' })) }) }) });
  const evaluation = inspectLearningEvaluation(result.result.evaluationId, { session }); assert.equal(evaluation.status, 'failed');
  const shown = inspectSkillCandidate(draft.id, { session });
  assert.throws(() => acceptSkillCandidate(draft.id, { expectedRevision: shown.revision, expectedSkillRevision: 0, expectedEvaluationId: evaluation.id, activate: true, reviewed: true }, { session }), /pass/i);
  revokeLearningFixtures(dataset.id, { session, expectedRevision: dataset.revision });
  await assert.rejects(evaluateLearningCandidate(draft.id, { session, datasetId: dataset.id, expectedRevision: shown.revision }), /approved/);
});

test('an interrupted host evaluation is rebound from its immutable comparisons without repeating the fixtures', async () => {
  const draft = candidate(), dataset = registerLearningFixtures(fixtureDefinition(), { session, reviewed: true });
  const completed = await evaluateLearningCandidate(draft.id, { session, datasetId: dataset.id, expectedRevision: draft.revision, runReview: expectedOutput });
  const evaluation = inspectLearningEvaluation(completed.result.evaluationId, { session });
  const stored = getRecord('core.skill.candidate', draft.id); putRecord('core.skill.candidate', draft.id,
    { ...stored, revision: evaluation.candidateRevision, state: 'pending', evaluation: null });
  const job = getRecord('core.learning.job', completed.id); putRecord('core.learning.job', job.id,
    { ...job, state: 'running', runner: null, totalTokensUsed: job.budget.tokenBudget });
  assert.deepEqual(recoverLearningJobs(), [job.id]);
  const paused = inspectLearningJob(job.id); controlLearningJob(job.id, 'resume', { expectedRevision: paused.revision });
  const resumed = await runLearningEvaluationJob(job.id, { session, runReview: async () => assert.fail('Host comparisons survive a process loss') });
  assert.equal(resumed.state, 'completed'); assert.equal(inspectSkillCandidate(draft.id, { session }).evaluation.id, evaluation.id);
  assert.equal(learningUsage().tokensUsed, 100); assert.equal(listSkills({ session, enabledOnly: true }).total, 0);
});

test('candidate and approved baseline share the same held-out corpus and cumulative budget, with measured gains kept separate from a pass', async () => {
  const base = createSkill({ name: 'authorization-review', description: 'Classify observations.', instructions: 'OLD PROCEDURE: classify every missing detail as inconclusive.' }, { session, scope: 'project' });
  setSkillEnabled(base.id, true, base.revision, { session });
  const draft = candidate(), dataset = registerLearningFixtures(fixtureDefinition(), { session, reviewed: true }), budgets = [];
  const result = await evaluateLearningCandidate(draft.id, { session, datasetId: dataset.id, expectedRevision: draft.revision,
    runReview: async ({ prompt, budget }) => {
      budgets.push(budget.tokenBudget); assert.doesNotMatch(prompt, /"expected"\s*:/);
      return prompt.includes('OLD PROCEDURE') ? { tokens: 100, text: JSON.stringify({ results: fixtureDefinition().cases.map(item => ({ id: item.id, verdict: 'inconclusive' })) }) } : expectedOutput();
    } });
  const evaluation = inspectLearningEvaluation(result.result.evaluationId, { session });
  assert.equal(evaluation.metrics.baselineAvailable, true); assert.equal(evaluation.metrics.improvementDemonstrated, true);
  assert.equal(evaluation.metrics.candidateAccuracy, 1); assert.equal(evaluation.metrics.baselineAccuracy, 1 / 3);
  assert.equal(evaluation.metrics.improvedCaseIds.length, 2); assert.deepEqual(evaluation.metrics.regressedCaseIds, []);
  assert.deepEqual(budgets, [12000, 11900]); assert.equal(result.tokensUsed, 200); assert.equal(learningUsage().tokensUsed, 200);
});

test('a global candidate compares its approved global baseline even when this project has a same-named override', async () => {
  const name = 'shared-authorization-review';
  const global = createSkill({ name, description: 'Global authorization procedure.', instructions: 'GLOBAL OLD PROCEDURE: retain every undecided observation as inconclusive.' });
  setSkillEnabled(global.id, true, global.revision);
  const local = createSkill({ name, description: 'This project override.', instructions: 'LOCAL OVERRIDE MUST NOT BECOME THE GLOBAL BASELINE.' }, { session, scope: 'project' });
  setSkillEnabled(local.id, true, local.revision, { session });
  const draft = stageSkillCandidate({ name, description: 'Updated global authorization procedure.',
    instructions: 'GLOBAL CANDIDATE: compare ownership with controlled baselines; retain unavailable proof as inconclusive.' }, { scope: 'global' });
  const dataset = registerLearningFixtures(fixtureDefinition(), { session, reviewed: true, scope: 'global' }), observed = [];
  const result = await evaluateLearningCandidate(draft.id, { session, datasetId: dataset.id, expectedRevision: draft.revision,
    runReview: async ({ prompt }) => {
      assert.doesNotMatch(prompt, /LOCAL OVERRIDE/);
      observed.push(prompt.includes('GLOBAL OLD PROCEDURE') ? 'global-baseline' : 'candidate');
      return prompt.includes('GLOBAL OLD PROCEDURE') ? { tokens: 100, text: JSON.stringify({ results: fixtureDefinition().cases.map(item => ({ id: item.id, verdict: 'inconclusive' })) }) } : expectedOutput();
    } });
  const evaluation = inspectLearningEvaluation(result.result.evaluationId, { session });
  assert.deepEqual(observed, ['candidate', 'global-baseline']);
  assert.equal(evaluation.baseline.version, global.version); assert.equal(evaluation.metrics.baselineAvailable, true);
  assert.equal(evaluation.metrics.baselineAccuracy, 1 / 3); assert.equal(evaluation.metrics.improvementDemonstrated, true);
});

test('changing fixture observations outside approval invalidates evaluation before a model is called', async () => {
  const draft = candidate(), dataset = registerLearningFixtures(fixtureDefinition(), { session, reviewed: true });
  const stored = getRecord('core.learning.fixtures', dataset.id); stored.cases[0].observations = 'Unreviewed replacement.';
  putRecord('core.learning.fixtures', dataset.id, stored);
  await assert.rejects(evaluateLearningCandidate(draft.id, { session, datasetId: dataset.id, expectedRevision: draft.revision,
    runReview: async () => assert.fail('Tampered fixtures cannot run') }), /content changed/);
});

test('the native Codex adapter verifies the isolated profile and denies tool approval without reusing source context', async () => {
  process.env.BZZY_CODEX_BIN = fileURLToPath(new URL('./fixtures/learning-codex.mjs', import.meta.url));
  process.env.BZZY_TEST_LEARNING_LOG = path.join(root, 'calls.jsonl');
  process.env.BZZY_ENV_ALLOW = 'BZZY_TEST_LEARNING_LOG,BZZY_TEST_LEARNING_BAD_PROFILE';
  session.engineThreadId = 'old-source-thread'; saveSession(session);
  const skill = createSkill({ name: 'unrelated-global-knowledge', description: 'Private synthetic global marker.', instructions: 'FOREIGN GLOBAL CATALOG MARKER' }); setSkillEnabled(skill.name, true, skill.revision);
  const result = await runLearningJob(queued().id); assert.equal(result.state, 'completed'); assert.equal(result.tokensUsed, 75);
  const calls = fs.readFileSync(process.env.BZZY_TEST_LEARNING_LOG, 'utf8').trim().split('\n').map(JSON.parse);
  const start = calls.find(call => call.method === 'thread/start'); assert.equal(start.params.permissions, 'bzzy_learning_review_v1'); assert.deepEqual(start.params.dynamicTools, []);
  assert.equal(start.params.ephemeral, true); assert.notEqual(start.params.cwd, session.cwd);
  assert.ok(!calls.some(call => call.method === 'thread/resume'));
  assert.equal(calls.find(call => call.id === 900).result.decision, 'decline');
  assert.doesNotMatch(JSON.stringify(calls), /FOREIGN GLOBAL CATALOG MARKER|old-source-thread/);
  const args = calls.find(call => call.args).args.join(' '); assert.match(args, /web_search="disabled"/); assert.match(args, /features\.hooks=false/); assert.match(args, /project_doc_max_bytes=0/);
  const own = listRecords('session').find(item => item.role === 'learning-review'); assert.equal(own.executionState, 'idle');
});

test('a backend without the named learning permission profile fails before any native turn', async () => {
  process.env.BZZY_CODEX_BIN = fileURLToPath(new URL('./fixtures/learning-codex.mjs', import.meta.url));
  process.env.BZZY_TEST_LEARNING_LOG = path.join(root, 'calls.jsonl'); process.env.BZZY_TEST_LEARNING_BAD_PROFILE = '1';
  process.env.BZZY_ENV_ALLOW = 'BZZY_TEST_LEARNING_LOG,BZZY_TEST_LEARNING_BAD_PROFILE';
  const result = await runLearningJob(queued().id); assert.equal(result.state, 'failed');
  const calls = fs.readFileSync(process.env.BZZY_TEST_LEARNING_LOG, 'utf8'); assert.doesNotMatch(calls, /"method":"turn\/start"|"method":"thread\/start"/);
});

test('Claude reviews disable project customizations, hooks, memory, tools and persistence while preserving the existing auth route', () => {
  const draft = createSession(getProvider('claude'), root, 'fixture-model'); draft.cwd = learningWorkingDirectory(draft.id);
  const args = claudeArgs(draft, { learningReview: true, documentOnly: true, policy: { mode: 'read-only', network: 'disabled' } });
  for (const flag of ['--safe-mode', '--restricted', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands']) assert.ok(args.includes(flag));
  assert.equal(args[args.indexOf('--tools') + 1], ''); assert.equal(args[args.indexOf('--setting-sources') + 1], '');
  assert.deepEqual(JSON.parse(args[args.indexOf('--settings') + 1]), { disableAllHooks: true, autoMemoryEnabled: false });
  assert.ok(!args.includes('--bare')); assert.throws(() => claudeArgs(session, { learningReview: true }), /private working directory|project working directory/);
});
