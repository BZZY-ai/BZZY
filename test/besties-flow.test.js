import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chooseBesties, configuredBesties, applyBestiesSelection, describeBesties } from '../src/besties-setup.js';
import { createSession, saveSession, loadSession, sessions } from '../src/store.js';
import { BUILTINS } from '../src/providers.js';
import { prepareTask } from '../src/task.js';
import { newGoal } from '../src/goals.js';
import { putRecord, getRecord } from '../src/database.js';
import { artifact } from '../src/evidence.js';
import { contextFor } from '../src/recovery.js';
import { ToolHost, taskTools } from '../src/tools.js';
import { root } from '../src/process.js';

let directory, previous;
test.beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-besties-flow-'));
  previous = Object.fromEntries(['BZZY_HOME', 'BZZY_CODEX_BIN', 'BZZY_CLAUDE_BIN', 'BZZY_TEST_LOG'].map(key => [key, process.env[key]]));
  Object.assign(process.env, { BZZY_HOME: path.join(directory, 'private'), BZZY_CODEX_BIN: path.join(root, 'test/fixtures/models.mjs'), BZZY_CLAUDE_BIN: path.join(root, 'test/fixtures/models.mjs'), BZZY_TEST_LOG: path.join(directory, 'backend.jsonl') });
});
test.afterEach(() => {
  for (const [key, value] of Object.entries(previous)) if (value == null) delete process.env[key]; else process.env[key] = value;
  fs.rmSync(directory, { recursive: true, force: true });
});

test('besties wizard chooses both model/effort settings independently, including the same provider twice', async () => {
  const titles = [], ui = { interactive: true, event() {}, async chooseOne(title, choices) {
    titles.push(title); const view = await choices;
    if (title.includes('Choose provider')) return 'codex';
    assert.equal(view.selectEffort, true);
    return title.startsWith('Bestie 1') ? { value: 'fixture-brain', effort: 'xhigh' } : { value: 'fixture-light', effort: 'low' };
  } };
  const choices = await chooseBesties({ cwd: directory }, ui);
  assert.deepEqual(titles, ['Bestie 1 · 1/2 · Choose provider', 'Bestie 1 · 1/2 · Choose model · codex', 'Bestie 2 · 2/2 · Choose provider', 'Bestie 2 · 2/2 · Choose model · codex']);
  assert.equal(choices[0].provider, 'codex'); assert.equal(choices[1].provider, 'codex');
  assert.equal(choices[0].effort, 'xhigh'); assert.equal(choices[1].effort, 'low');
  const session = createSession(BUILTINS.codex, directory); applyBestiesSelection(session, choices); saveSession(session);
  assert.equal(session.goal, null, 'selecting a mode does not start a goal');
  prepareTask(session, { mode: 'besties' }, 'An explicitly requested objective');
  assert.deepEqual(loadSession(session.id).besties, choices);
  assert.equal(session.selectedEffort, 'xhigh'); assert.match(describeBesties(session), /Chat normally/);
  assert.match(describeBesties(session), /\/goal <objective>/);
  const log = fs.readFileSync(path.join(directory, 'backend.jsonl'), 'utf8');
  assert.doesNotMatch(log, /thread\/start|turn\/start/);
});

test('besties setup cancels cleanly and scripted configuration requires exactly two agents', async () => {
  const ui = { interactive: true, event() {}, async chooseOne(title, choices) {
    await choices;
    if (title.startsWith('Bestie 2')) return null;
    return title.includes('Choose provider') ? 'codex' : { value: 'fixture-brain', effort: 'high' };
  } };
  assert.equal(await chooseBesties({ cwd: directory }, ui), null);
  assert.equal(sessions().length, 0);
  assert.deepEqual(configuredBesties({ agents: 'codex:model-a,codex:model-b' }).map(choice => choice.model), ['model-a', 'model-b']);
  for (const agents of ['codex', 'codex,claude,deepseek']) assert.throws(() => configuredBesties({ agents }), /exactly two/);
  assert.throws(() => configuredBesties({ besties: [] }), /exactly two/);
});

test('CLI accepts the besties wizard flag and explicit scripted mode', async () => {
  const { parseArgs } = await import('../src/cli.js');
  const wizard = parseArgs(['--besties']).options; assert.equal(wizard.mode, 'besties'); assert.equal(wizard.bestiesSetup, true);
  const script = parseArgs(['goal', 'Solve supplied CTF', '--mode', 'besties', '--agents', 'codex:a,claude:b']);
  assert.equal(script.options.mode, 'besties'); assert.equal(script.options.agents, 'codex:a,claude:b');
  assert.deepEqual(script.args, ['goal', 'Solve supplied CTF']);
});

test('peer tools deliver actual selected evidence, require inspection for reviews and persist conversation context', async () => {
  const parent = createSession(BUILTINS.codex, directory); prepareTask(parent, { mode: 'besties' }, 'Establish the supported account-control behavior');
  parent.goal = newGoal(parent.contract.objective); saveSession(parent);
  const first = createSession(BUILTINS.codex, directory), second = createSession(BUILTINS.claude, directory);
  const peers = [{ namespace: 'codex-bestie-1', sessionId: first.id, selection: { provider: 'codex' } }, { namespace: 'claude-bestie-2', sessionId: second.id, selection: { provider: 'claude' } }];
  putRecord('besties', parent.id, { goalId: parent.goal.id, peers, cursors: {} });
  for (const peer of [first, second]) {
    Object.assign(peer, { role: 'bestie', bestiesSessionId: parent.id, projectRoot: directory, peers, contract: parent.contract }); saveSession(peer);
  }
  const firstHost = new ToolHost(first, { event() {} }), secondHost = new ToolHost(second, { event() {} });
  const historical = artifact(parent, 'Previously verified project observation', 'prior project evidence');
  assert.match((await secondHost.call('read_artifact', { id: historical.id })).content, /Previously verified/);
  const proof = artifact(first, 'Positive and negative account controls are recorded.', 'control comparison');
  await assert.rejects(secondHost.call('read_artifact', { id: proof.id }), /outside/);
  const message = await firstHost.call('peer_message', { text: 'Please inspect the positive and negative controls.', evidence: [proof.id], requestId: 'control-proof' });
  const inbox = await secondHost.call('peer_inbox', {}); assert.equal(inbox.items[0].id, message.id);
  assert.equal((await secondHost.call('peer_inbox', {})).items.length, 0, 'saved inbox cursor prevents full-history replay');
  const followup = await firstHost.call('peer_message', { text: 'The comparison includes the requested negative control.', requestId: 'control-clarification' });
  assert.equal((await secondHost.call('peer_inbox', {})).items[0].id, followup.id);
  assert.equal((await secondHost.call('peer_inbox', { after: 0, limit: 1 })).items[0].id, message.id);
  assert.equal(getRecord('peer-cursor', second.id).after, followup.seq, 'historical inspection must not rewind the unread cursor');
  assert.equal((await secondHost.call('peer_inbox', {})).items.length, 0);
  await assert.rejects(secondHost.call('peer_review', { messageId: message.id, assessment: 'supported', rationale: 'Review requires actual inspection', evidence: [proof.id] }), /Open current peer evidence/);
  const opened = await secondHost.call('read_artifact', { id: proof.id }); assert.match(opened.content, /Positive and negative/);
  const review = await secondHost.call('peer_review', { messageId: message.id, assessment: 'supported', rationale: 'Opened and checked the recorded comparison.', evidence: [proof.id] });
  assert.equal(review.peerSessionId, first.id); assert.ok(getRecord('artifact', opened.importedEvidenceId));
  const recovered = JSON.parse(contextFor(loadSession(second.id))); assert.equal(recovered.role, 'bestie');
  assert.equal(recovered.collaboration.reviews[0].messageId, message.id);
  assert.equal(recovered.collaboration.supported, false, 'one review cannot finish the shared goal');
  assert.equal(taskTools(parent).some(tool => tool.name === 'peer_message'), false, 'peer-only capability is not exposed to unrelated chats');
});

test('ordinary chat cannot start delegated work or report a persistent goal complete', async () => {
  const session = createSession(BUILTINS.codex, directory); prepareTask(session, { mode: 'delegate', executor: 'claude' }, 'Existing goal');
  session.goal = newGoal(session.contract.objective); saveSession(session);
  const host = new ToolHost(session, { event() {} }, { goalMode: false });
  assert.equal(taskTools(session, { goalMode: false }).some(tool => ['delegate', 'update_goal'].includes(tool.name)), false);
  await assert.rejects(host.call('delegate', {}), /not authorized/);
  await assert.rejects(host.call('update_goal', { status: 'complete', evidence: [] }), /not authorized/);
  assert.equal(loadSession(session.id).goal.status, 'active');
});
