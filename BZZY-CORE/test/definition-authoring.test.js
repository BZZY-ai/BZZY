import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSession, saveSession, loadSession } from '../src/engine/store.js';
import { getProvider, saveKey } from '../src/engine/providers.js';
import { listRecords } from '../src/engine/database.js';
import { captureDefinitionContext, authorDefinition, saveAuthoredDefinition, validateAuthoredDefinition } from '../src/engine/definition-authoring.js';
import { runRestrictedDocumentModel } from '../src/engine/document-model.js';
import { listSkills, readSkill } from '../src/engine/skills.js';
import { listSubagentDefinitions } from '../src/engine/subagent-definitions.js';

let root, previousHome, session;
test.beforeEach(() => {
  previousHome = process.env.BZZY_HOME;
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-definition-')));
  process.env.BZZY_HOME = path.join(root, 'private');
  const cwd = path.join(root, 'project'); fs.mkdirSync(cwd);
  session = createSession(getProvider('codex'), cwd, 'chosen-chat-model');
  session.selectedEffort = 'high'; saveSession(session);
});
test.afterEach(() => {
  if (previousHome === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previousHome;
  fs.rmSync(root, { recursive: true, force: true });
});
const definition = (name = 'response-reviewer') => ({ name, description: 'Analyze supplied HTTP responses and identify reproducible observations.',
  instructions: 'Inspect the user-supplied HTTP responses and compare controlled baselines. Preserve exact evidence references, identify uncertainty and missing inputs, and return a concise review without treating model assertions as verified results.' });
const args = kind => ({ kind, context: captureDefinitionContext(session), input: { name: 'response-reviewer', purpose: 'Review HTTP responses.', details: 'Input: response text. Output: evidence and uncertainty.' } });
const generated = async () => ({ text: JSON.stringify(definition()), tokens: 30, usageAvailable: true });

test('authoring uses the selected chat provider, resolved model and effort, without changing source state', async () => {
  session.provider = 'claude'; session.backend = 'claude'; session.model = null; session.resolvedModel = 'resolved-current-model';
  session.selectedEffort = 'low'; session.goal = { id: 'keep-goal', status: 'active' }; saveSession(session);
  const before = structuredClone(loadSession(session.id)); let call;
  const draft = await authorDefinition({ ...args('subagent'), runModel: async input => { call = input; return generated(); } });
  assert.deepEqual(call.selection, { provider: 'claude', model: 'resolved-current-model', effort: 'low', capabilities: null });
  assert.equal(call.source.id, session.id); assert.equal(call.budget.runtimeSeconds, 90);
  assert.match(call.instructions, /Return only a JSON object/); assert.doesNotMatch(call.prompt, /keep-goal/);
  assert.deepEqual(loadSession(session.id), before);
  assert.equal(listSubagentDefinitions({ cwd: session.cwd }).total, 0);
  assert.equal(listSkills({ session }).total, 0); assert.equal(listRecords('execution').length, 0);
  assert.equal(draft.definition.name, 'response-reviewer');
});

test('reviewed skills save with valid frontmatter and remain inactive until enabled; duplicate Save cannot replace', async () => {
  const draft = await authorDefinition({ ...args('skill'), runModel: generated });
  assert.equal(listSkills({ session }).total, 0);
  const saved = saveAuthoredDefinition(draft);
  assert.equal(saved.name, draft.definition.name); assert.equal(saved.enabled, false);
  const page = readSkill(saved.id, { session, enabledOnly: false });
  assert.match(page.text, /^---\nname: response-reviewer\ndescription:/);
  assert.match(page.text, /generation|credential/i);
  assert.throws(() => saveAuthoredDefinition(draft), /exists or changed/);
  assert.equal(listSkills({ session }).total, 1);
});

test('reviewed agents inherit invocation selection and CAS Save cannot replace an existing specialist', async () => {
  const draft = await authorDefinition({ ...args('subagent'), scope: 'global', runModel: generated });
  const saved = saveAuthoredDefinition(draft);
  assert.equal(saved.scope, 'global'); assert.equal(saved.provider, undefined); assert.equal(saved.model, undefined); assert.equal(saved.effort, undefined);
  assert.throws(() => saveAuthoredDefinition(draft), /exists or changed/);
  assert.equal(listSubagentDefinitions({ cwd: session.cwd }).total, 1);
});

test('model changes during generation and between preview and Save invalidate the draft', async () => {
  await assert.rejects(authorDefinition({ ...args('subagent'), runModel: async () => {
    session.model = 'different-model'; saveSession(session); return generated();
  } }), /selected model changed/);
  const draft = await authorDefinition({ ...args('subagent'), runModel: generated });
  session.selectedEffort = 'low'; saveSession(session);
  assert.throws(() => saveAuthoredDefinition(draft), /selected model changed/);
  assert.equal(listSubagentDefinitions({ cwd: session.cwd }).total, 0);
});

test('private input is rejected before generation and model secrets never reach draft or registry', async () => {
  let calls = 0;
  await assert.rejects(authorDefinition({ ...args('skill'), input: { ...args('skill').input, details: 'password=private-value' },
    runModel: async () => { calls++; return generated(); } }), /credentials/);
  assert.equal(calls, 0);
  saveKey('deepseek', 'fixture-known-private-credential');
  await assert.rejects(authorDefinition({ ...args('skill'), runModel: async () => ({ text: JSON.stringify({ ...definition(), instructions: definition().instructions + ' fixture-known-private-credential' }) }) }), /credential/);
  assert.throws(() => validateAuthoredDefinition(JSON.stringify({ ...definition(), tools: ['shell'] }), { kind: 'subagent', name: 'response-reviewer' }), /unsupported/);
  assert.equal(listSkills({ session }).total, 0);
});

test('document runner enforces no-tools options, selection and private cwd, closes backend and preserves source', async () => {
  const before = loadSession(session.id); let observed, closed = false;
  class Engine {
    constructor(provider, draft, options, ui) { observed = { provider, draft, options }; this.ui = ui; }
    async run(prompt, options) { assert.equal(options.goal, false); assert.equal(prompt, 'bounded input'); this.ui.event('text', { text: 'bounded output' }); return { tokens: 42 }; }
    async close() { closed = true; }
  }
  const result = await runRestrictedDocumentModel({ source: session, prompt: 'bounded input', instructions: 'Summarize the document.',
    selection: { provider: 'deepseek', model: 'chosen-compactor', effort: 'low' }, task: { kind: 'session-compaction', id: '1'.repeat(64) }, Engine });
  assert.deepEqual(result, { text: 'bounded output', tokens: 42, usageAvailable: true, resolvedModel: 'chosen-compactor' });
  assert.equal(observed.provider.id, 'deepseek'); assert.equal(observed.draft.model, 'chosen-compactor'); assert.equal(observed.draft.selectedEffort, 'low');
  assert.equal(observed.options.learningReview, true); assert.equal(observed.options.documentOnly, true);
  assert.equal(observed.options.documentTaskInstructions, 'Summarize the document.');
  assert.deepEqual(observed.options.policy, { mode: 'read-only', network: 'disabled', writablePaths: [] });
  assert.notEqual(observed.draft.cwd, session.cwd); assert.equal(observed.draft.role, 'learning-review');
  assert.equal(observed.draft.documentTaskKind, 'session-compaction'); assert.equal(observed.draft.documentTaskId, '1'.repeat(64));
  assert.equal(fs.existsSync(observed.draft.cwd), false); assert.equal(closed, true);
  assert.deepEqual(loadSession(session.id), before);
});

test('document cancellation, deadline and oversized output close even a backend that never finishes', async () => {
  for (const mode of ['cancel', 'deadline', 'output', 'operator-stop']) {
    let closed = false, interrupted = false;
    const controller = new AbortController();
    class Engine {
      constructor(provider, draft, options, ui) { this.ui = ui; }
      async run() {
        if (mode === 'output') this.ui.event('text', { text: 'x'.repeat(33000) });
        if (mode === 'cancel') controller.abort(new Error('Owner cancelled.'));
        if (mode === 'operator-stop') fs.writeFileSync(path.join(process.env.BZZY_HOME, 'runtime', 'operator-stop.json'), '{"stopped":true}');
        return new Promise(() => {});
      }
      async interrupt() { interrupted = true; }
      async close() { closed = true; }
    }
    await assert.rejects(runRestrictedDocumentModel({ source: session, prompt: 'input', instructions: 'instructions', signal: controller.signal,
      budget: { runtimeSeconds: mode === 'deadline' ? 0.02 : 1, tokenBudget: 100 }, Engine }), /cancelled|limit|Core state/);
    assert.equal(closed, true); assert.equal(interrupted, true);
    fs.rmSync(path.join(process.env.BZZY_HOME, 'runtime', 'operator-stop.json'), { force: true });
  }
});

test('creator cancellation discards even a model result that ignores its cancellation signal', async () => {
  const controller = new AbortController();
  await assert.rejects(authorDefinition({ ...args('skill'), signal: controller.signal, runModel: async () => {
    controller.abort(new Error('cancelled')); return generated();
  } }), /cancelled/);
  assert.equal(listSkills({ session }).total, 0);
});

test('native document generation verifies no-tool permissions and never resumes the source coding thread', async () => {
  const names = ['BZZY_CODEX_BIN', 'BZZY_CODEX_HOME', 'BZZY_TEST_LEARNING_LOG', 'BZZY_TEST_LEARNING_BAD_PROFILE', 'BZZY_ENV_ALLOW'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    process.env.BZZY_CODEX_BIN = fileURLToPath(new URL('./fixtures/learning-codex.mjs', import.meta.url));
    process.env.BZZY_CODEX_HOME = path.join(root, 'fixture-auth'); fs.mkdirSync(process.env.BZZY_CODEX_HOME, { mode: 0o700 });
    fs.writeFileSync(path.join(process.env.BZZY_CODEX_HOME, 'auth.json'), '{}', { mode: 0o600 });
    process.env.BZZY_TEST_LEARNING_LOG = path.join(root, 'native-calls.jsonl');
    process.env.BZZY_ENV_ALLOW = 'BZZY_TEST_LEARNING_LOG,BZZY_TEST_LEARNING_BAD_PROFILE';
    delete process.env.BZZY_TEST_LEARNING_BAD_PROFILE;
    session.engineThreadId = 'private-existing-coding-thread'; saveSession(session);
    const result = await runRestrictedDocumentModel({ source: session, prompt: 'Only this explicit input.', instructions: 'Return the requested authoring document.' });
    assert.equal(result.tokens, 75);
    const calls = fs.readFileSync(process.env.BZZY_TEST_LEARNING_LOG, 'utf8').trim().split('\n').map(JSON.parse);
    const start = calls.find(call => call.method === 'thread/start');
    assert.equal(start.params.permissions, 'bzzy_learning_review_v1'); assert.deepEqual(start.params.dynamicTools, []);
    assert.equal(start.params.ephemeral, true); assert.notEqual(start.params.cwd, session.cwd);
    assert.equal(calls.find(call => call.id === 900).result.decision, 'decline');
    assert.doesNotMatch(JSON.stringify(calls), /private-existing-coding-thread|"method":"thread\/resume"/);
    assert.match(JSON.stringify(calls), /Return the requested authoring document/);
    fs.rmSync(process.env.BZZY_TEST_LEARNING_LOG);
    process.env.BZZY_TEST_LEARNING_BAD_PROFILE = '1';
    await assert.rejects(runRestrictedDocumentModel({ source: session, prompt: 'Input.', instructions: 'Return a document.' }), /permission|profile/i);
    assert.doesNotMatch(fs.readFileSync(process.env.BZZY_TEST_LEARNING_LOG, 'utf8'), /"method":"turn\/start"|"method":"thread\/start"/);
  } finally {
    for (const name of names) if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
  }
});
