import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CoreKnowledge } from '../src/knowledge.js';
import { createSession, saveSession } from '../src/engine/store.js';
import { BUILTINS } from '../src/engine/providers.js';
import { appendEvent, listRecords, transaction } from '../src/engine/database.js';
import { initializeProject, issue } from '../src/engine/project.js';
import { prepareTask } from '../src/engine/task.js';
import { insertConversation } from '../src/conversations.js';
import { ToolHost, taskTools } from '../src/engine/tools.js';
import { conversationPrompt } from '../src/engine/conversation.js';
import { learningForTurn } from '../src/engine/learning-hooks.js';
import { createSkill, setSkillEnabled } from '../src/engine/skills.js';

let directory, prior, alpha, beta;
test.beforeEach(() => {
  prior = process.env.BZZY_HOME;
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-integration-')));
  process.env.BZZY_HOME = path.join(directory, 'private');
  alpha = path.join(directory, 'alpha'); beta = path.join(directory, 'beta'); fs.mkdirSync(alpha); fs.mkdirSync(beta);
});
test.afterEach(() => { if (prior === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = prior; fs.rmSync(directory, { recursive: true, force: true }); });
function saved(cwd, extra = {}) { const session = { ...createSession(BUILTINS.codex, cwd, 'fixture-model'), ...extra }; initializeProject(session); saveSession(session); return session; }

test('nested terminal and Core conversations keep their cwd, project identity and inherited constraints', () => {
  const parent = saved(alpha), nested = path.join(alpha, 'nested'); fs.mkdirSync(nested);
  fs.writeFileSync(path.join(alpha, '.bzzy', 'constraints.json'), JSON.stringify({ constraints: ['Use only the supplied offline fixture.'], policy: { mode: 'read-only' } }));
  const session = createSession(BUILTINS.codex, nested); prepareTask(session, {}, 'Inspect the offline fixture.');
  assert.equal(session.cwd, nested); assert.equal(session.projectRoot, alpha); assert.equal(session.projectId, parent.projectId);
  assert.ok(session.contract.constraints.includes('Use only the supplied offline fixture.')); assert.equal(session.policy.mode, 'read-only');
  assert.equal(fs.existsSync(path.join(nested, '.bzzy')), false);
  const core = transaction(db => insertConversation({ provider: 'codex', cwd: nested, model: 'fixture-model', effort: 'default' }, db));
  assert.equal(core.cwd, nested); assert.equal(core.projectId, parent.projectId);
  const agent = transaction(db => insertConversation({ provider: 'codex', cwd: nested, model: 'fixture-model', effort: 'default' }, db, { purpose: 'agent', agentId: randomUUID() }));
  assert.equal(agent.projectRoot, nested); assert.notEqual(agent.projectId, parent.projectId);
});

test('model tools search only the current engagement, trigger deduplicated reviews and expose no owner administration', async () => {
  const session = saved(alpha), other = saved(beta), host = new ToolHost(session, { event() {} });
  const foreign = new ToolHost(other, { event() {} });
  await foreign.call('remember', { kind: 'hypothesis', statement: 'FOREIGN_ENGAGEMENT_ONLY' });
  const record = await host.call('remember', { kind: 'failed_approach', statement: 'A banner match alone did not validate access.', requestId: 'failure-1' });
  await host.call('remember', { kind: 'failed_approach', statement: 'A banner match alone did not validate access.', requestId: 'failure-1' });
  assert.equal(listRecords('core.learning.job').length, 1);
  const result = await host.call('search_knowledge', { query: 'banner' }); assert.equal(result.items[0].sourceId, record.id);
  assert.equal((await host.call('search_knowledge', { query: 'FOREIGN_ENGAGEMENT_ONLY' })).items.length, 0);
  for (const name of ['candidate.accept', 'profile.update', 'learning.queue']) {
    assert.equal(taskTools(session).some(item => item.name === name), false); await assert.rejects(host.call(name, {}), /not authorized/);
  }
  const worker = saved(alpha, { role: 'executor', parentSessionId: session.id });
  await new ToolHost(worker, { event() {} }).call('remember', { kind: 'failed_approach', statement: 'A bounded worker observation.' });
  assert.equal(listRecords('core.learning.job').length, 1);
});

test('explicit correction and verified completion hooks queue no speculative or recursive learning', () => {
  const session = saved(alpha);
  appendEvent(session.id, 'message.user', { text: 'correction: keep a negative control.' });
  const correction = learningForTurn(session, 'correction: keep a negative control.'); assert.equal(correction.reason, 'user_correction');
  assert.equal(learningForTurn(session, 'correction: keep a negative control.').id, correction.id);
  assert.equal(learningForTurn(session, 'ordinary question'), null);
  session.goal = { id: randomUUID(), status: 'complete' }; saveSession(session);
  assert.equal(learningForTurn(session, 'done', { goal: true }), null);
  session.acceptance = { passed: true }; saveSession(session);
  assert.ok(learningForTurn(session, 'done', { goal: true }));
  assert.equal(learningForTurn({ ...session, role: 'learning-review' }, 'correction: change everything'), null);
  assert.equal(learningForTurn(session, 'correction: halted', { stopped: true }), null);
});

test('automatic historical briefs and enabled skills remain scoped across model changes without replaying the current prompt', () => {
  const source = saved(alpha), session = saved(alpha), other = saved(beta);
  appendEvent(source.id, 'text', { text: 'RAW_CHAT_ONLY tenant baseline speculation.' });
  issue(source, { title: 'Tenant baseline ownership control', details: 'The tenant baseline lacked an ownership control; historical claim awaiting verification.' });
  appendEvent(session.id, 'message.user', { text: 'Check the tenant baseline.' });
  appendEvent(other.id, 'text', { text: 'FOREIGN_CONVERSATION_PRIVATE' });
  const skill = createSkill({ name: 'tenant-baselines', description: 'Compare tenant baselines.', instructions: 'Compare ownership with controlled role observations.' }, { session });
  setSkillEnabled(skill.id, true, skill.revision, { session });
  for (const provider of ['codex', 'claude', 'deepseek']) {
    const prompt = conversationPrompt({ ...session, provider }, 'Check the tenant baseline.');
    assert.match(prompt, /ownership control/); assert.match(prompt, /tenant-baselines/);
    assert.doesNotMatch(prompt, /FOREIGN_CONVERSATION_PRIVATE|RAW_CHAT_ONLY/);
    assert.equal(prompt.split('Check the tenant baseline.').length - 1, 1);
  }
  assert.equal(conversationPrompt({ ...session, role: 'learning-review' }, 'JSON review'), 'JSON review');
});

test('owner knowledge operations require reviewed revisions and reject extra scope or dispatch fields', () => {
  const session = saved(alpha), admin = new CoreKnowledge();
  assert.equal(admin.request('status', { sessionId: session.id }).project.id, session.projectId);
  assert.throws(() => admin.request('search', { sessionId: session.id, projectId: 'foreign' }), /fields/);
  assert.throws(() => admin.request('profile.update', { target: 'user', text: 'Prefer short reports.' }), /Review/);
  const profile = admin.request('profile.update', { target: 'user', text: 'Prefer short reports.', reviewed: true });
  assert.equal(profile.revision, 1);
  assert.throws(() => admin.request('profile.update', { target: 'user', text: 'Overwrite without the current revision.', reviewed: true }), /changed/);
  assert.throws(() => admin.request('learning.settings', { settings: { enabled: false }, reviewed: true, expectedRevision: 99 }), /changed/);
  const disabled = admin.request('learning.settings', { settings: { enabled: false }, reviewed: true, expectedRevision: 0 });
  assert.equal(disabled.enabled, false); assert.equal(admin.request('profile.history', { target: 'user' }).items.length, 1);
  assert.throws(() => admin.request('__proto__', {}), /Unknown/);
});
