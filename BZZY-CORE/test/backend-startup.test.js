import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createSession, saveSession, loadSession } from '../src/engine/store.js';
import { getProvider } from '../src/engine/providers.js';
import { listRecords, appendEvent } from '../src/engine/database.js';
import { projectIdentityForSession } from '../src/engine/project-identity.js';
import { CoreAssistant } from '../src/assistant.js';
import { backendStartupFailure } from '../src/engine/backend-startup.js';
import { newGoal } from '../src/engine/goals.js';
import { runRestrictedDocumentModel } from '../src/engine/document-model.js';
import { synthesizeDebateConsensus } from '../src/engine/debate-consensus.js';
import { queueLearningReview, runLearningJob, learningUsage } from '../src/engine/learning.js';

const names = ['BZZY_HOME', 'BZZY_CODEX_HOME', 'BZZY_CODEX_BIN', 'BZZY_ENV_ALLOW', 'BZZY_TEST_LEARNING_LOG',
  'BZZY_TEST_LEARNING_BAD_PROFILE', 'BZZY_TEST_LEARNING_STARTUP_FAILURE'];
let directory, previous, session;
test.beforeEach(() => {
  previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-startup-')));
  Object.assign(process.env, { BZZY_HOME: path.join(directory, 'private'), BZZY_CODEX_HOME: path.join(directory, 'auth'),
    BZZY_CODEX_BIN: fileURLToPath(new URL('./fixtures/learning-codex.mjs', import.meta.url)),
    BZZY_TEST_LEARNING_LOG: path.join(directory, 'calls.jsonl'),
    BZZY_ENV_ALLOW: 'BZZY_TEST_LEARNING_LOG,BZZY_TEST_LEARNING_BAD_PROFILE,BZZY_TEST_LEARNING_STARTUP_FAILURE' });
  delete process.env.BZZY_TEST_LEARNING_BAD_PROFILE; delete process.env.BZZY_TEST_LEARNING_STARTUP_FAILURE;
  const cwd = path.join(directory, 'project'); fs.mkdirSync(cwd); fs.mkdirSync(process.env.BZZY_CODEX_HOME);
  fs.writeFileSync(path.join(process.env.BZZY_CODEX_HOME, 'auth.json'), '{}', { mode: 0o600 });
  session = createSession(getProvider('codex'), cwd, 'offline-review-model'); session.projectRoot = cwd;
  session.goal = { ...newGoal('Review the supplied historical result.'), status: 'awaiting_review' };
  projectIdentityForSession(session, { create: true }); saveSession(session);
  new CoreAssistant().configure({ source: 'core', provider: 'codex', model: 'offline-review-model', effort: 'low' },
    { expectedRevision: 0, requestId: randomUUID() });
});
test.afterEach(() => {
  for (const name of names) if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
  fs.rmSync(directory, { recursive: true, force: true });
});
const calls = () => fs.existsSync(process.env.BZZY_TEST_LEARNING_LOG)
  ? fs.readFileSync(process.env.BZZY_TEST_LEARNING_LOG, 'utf8').trim().split('\n').map(JSON.parse) : [];
const assessment = { goalSatisfaction: 'inconclusive', assessment: { passed: false }, unresolvedDisagreement: ['Required evidence remains incomplete.'] };

test('native document startup failures retain only safe stage and numeric RPC code, before any model turn', async () => {
  const before = loadSession(session.id);
  for (const [method, stage] of [['initialize', 'initialize'], ['thread/start', 'thread_start']]) {
    process.env.BZZY_TEST_LEARNING_STARTUP_FAILURE = method;
    await assert.rejects(runRestrictedDocumentModel({ source: session, prompt: 'Only supplied text.', instructions: 'Summarize supplied text.' }), error => {
      assert.deepEqual(backendStartupFailure(error), { version: 1, backend: 'codex', stage, modelRequestStarted: false, rpcCode: -32602 });
      return true;
    });
    const draft = listRecords('session').find(item => item.role === 'learning-review' && item.backendFailure?.stage === stage);
    assert.equal(draft.executionState, 'idle'); assert.equal(draft.backendProcess, null); assert.equal(fs.existsSync(draft.cwd), false);
    assert.doesNotMatch(JSON.stringify(draft), /SYNTHETIC_PRIVATE_STARTUP_DETAIL/);
  }
  assert.equal(calls().some(call => call.method === 'turn/start'), false);
  assert.deepEqual(loadSession(session.id), before);
});

test('consensus reports a proven startup failure with zero model usage and cannot upgrade an inconclusive goal', async () => {
  process.env.BZZY_TEST_LEARNING_STARTUP_FAILURE = 'thread/start';
  const result = await synthesizeDebateConsensus(session, assessment);
  assert.equal(result.state, 'unavailable'); assert.equal(result.reason, 'consensus_backend_startup');
  assert.equal(result.backendFailure.stage, 'thread_start'); assert.equal(result.backendFailure.rpcCode, -32602);
  assert.equal(result.tokens, 0); assert.equal(result.chargedTokens, 0); assert.equal(result.usageAvailable, true); assert.equal(result.authoritative, false);
  assert.equal(calls().some(call => call.method === 'turn/start'), false);
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE_STARTUP_DETAIL/); assert.equal(loadSession(session.id).goal.status, 'awaiting_review');
});

test('learning retains a safe permission-profile startup failure and releases its unused reservation', async () => {
  process.env.BZZY_TEST_LEARNING_BAD_PROFILE = '1';
  const source = appendEvent(session.id, 'message.user', { text: 'Preserve controlled observations and required uncertainty.' });
  const job = queueLearningReview(session, { reason: 'explicit', sourceId: source.id });
  const result = await runLearningJob(job.id);
  assert.equal(result.state, 'failed'); assert.equal(result.error, 'LEARNING_REVIEW_FAILED');
  assert.deepEqual(result.backendFailure, { version: 1, backend: 'codex', stage: 'permission_profile', modelRequestStarted: false });
  assert.equal(result.tokensUsed, 0); assert.equal(learningUsage().tokensUsed, 0); assert.equal(learningUsage().reservedTokens, 0);
  assert.equal(calls().some(call => call.method === 'turn/start'), false);
});

test('unbranded failures cannot claim pre-dispatch zero usage or inject private diagnostics', async () => {
  const fake = Object.assign(new Error('SYNTHETIC_PRIVATE_STARTUP_DETAIL'), {
    backendFailure: { version: 1, backend: 'codex', stage: 'initialize', modelRequestStarted: false },
    modelRequestStarted: false, rpcCode: -32602,
  });
  assert.equal(backendStartupFailure(fake), null);
  const result = await synthesizeDebateConsensus(session, assessment, { runModel: async () => { throw fake; } });
  assert.equal(result.reason, 'consensus_failed'); assert.equal(result.chargedTokens, 20000); assert.equal(result.usageAvailable, false);
  assert.equal(result.backendFailure, undefined); assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE_STARTUP_DETAIL/);
  const source = appendEvent(session.id, 'message.user', { text: 'Preserve controlled observations and required uncertainty.' });
  const job = queueLearningReview(session, { reason: 'explicit', sourceId: source.id });
  const failed = await runLearningJob(job.id, { runReview: async () => { throw fake; } });
  assert.equal(failed.state, 'failed'); assert.equal(failed.backendFailure, undefined);
  assert.equal(learningUsage().tokensUsed, job.budget.tokenBudget);
});
