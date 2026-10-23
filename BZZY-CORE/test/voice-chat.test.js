import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CoreVoiceChat } from '../src/engine/voice-chat.js';
import { CoreAssistant } from '../src/assistant.js';
import { CoreWorkspaces } from '../src/workspaces.js';
import { getRecord, putRecord, listRecords, digest, appendEvent, transaction, database } from '../src/engine/database.js';
import { sessionPermissions, activeAccess, createSessionAccess } from '../src/engine/session-access.js';
import { enqueueExecution } from '../src/engine/execution-queue.js';
import { validateRequest, permissionFor } from '../src/relay/protocol.js';

let directory, previous;
test.beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-core-voice-')); previous = process.env.BZZY_HOME;
  process.env.BZZY_HOME = path.join(directory, 'private');
  const root = path.join(directory, 'workspace'); fs.mkdirSync(root);
  new CoreWorkspaces().configure({ path: root }, { expectedRevision: 0, requestId: randomUUID() });
  new CoreAssistant().configure({ source: 'core', provider: 'codex', model: 'core-voice-model', effort: 'default' }, { expectedRevision: 0, requestId: randomUUID() });
});
test.afterEach(() => { if (previous == null) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous; fs.rmSync(directory, { recursive: true, force: true }); });
function phone() {
  const certificate = { id: randomUUID() }, token = randomUUID();
  const row = { id: randomUUID(), peerId: certificate.id, hostId: 'host', resource: randomUUID(), sessionId: randomUUID(),
    peerDigest: digest(certificate), token, coreGrantId: randomUUID(), permissions: [...sessionPermissions],
    sessionAccess: true, agentAccess: true, shareAccess: true, expiresAt: Date.now() + 3600000 };
  putRecord('core.relay.pin', row.peerId, { certificate, hostId: row.hostId });
  putRecord('access-token', digest(token), { id: row.coreGrantId, sessionId: row.sessionId, includeChildren: false, permissions: [...sessionPermissions], expiresAt: row.expiresAt });
  putRecord('core.relay.grant', row.id, row); return row;
}
function service(extra = {}) {
  return new CoreVoiceChat({ client: async context => ({
    session: async id => ({ session: getRecord('session', id), execution: listRecords('execution', { sessionId: id, limit: 1 })[0], questions: listRecords('question', { sessionId: id, state: 'pending' }) }),
    claim: async () => {},
    execute: async (id, input) => enqueueExecution(id, input, input.requestId, { authorize: () => assert.equal(activeAccess(getRecord('access-token', digest(context.token))), true) }),
    control: async () => {}, ...extra,
  }) });
}
test('voice status never starts inference; explicit sends use only Core defaults and retry without duplicate turns', async () => {
  const row = phone(), voice = service();
  assert.equal(voice.status(row).configured, true); assert.equal(listRecords('session').length, 0);
  const result = await voice.send(row, 'Tell me something.', 'voice-request');
  assert.deepEqual(await voice.send(row, 'Tell me something.', 'voice-request'), result);
  assert.equal(listRecords('execution').length, 1); assert.equal(listRecords('session')[0].model, 'core-voice-model');
  assert.equal(listRecords('session')[0].purpose, 'core-assistant');
  assert.equal(listRecords('session')[0].voiceAssistant, true);
  assert.equal(listRecords('core.relay.context')[0].kind, 'voice');
  await assert.rejects(voice.send(row, 'Different words', 'voice-request'), { code: 'CONFLICT' });
});
test('voice readiness validates the actual folder before enabling the microphone', () => {
  const row = phone(), voice = service(), root = new CoreWorkspaces().settings().root.path;
  fs.renameSync(root, root + '-old'); fs.mkdirSync(root);
  assert.throws(() => voice.status(row), { code: 'WORKSPACE_CHANGED' });
  assert.equal(listRecords('execution').length, 0);
});
test('voice replies are paginated plain speech from only the accepted execution; later turns never enter its result', async () => {
  const row = phone(), voice = service(); await voice.send(row, 'Speak this reply.', 'first');
  const job = listRecords('execution')[0], text = '漢字 🐝 '.repeat(1500);
  appendEvent(job.sessionId, 'text', { text: `<message version="1"><p>${text}</p></message>` });
  appendEvent(job.sessionId, 'execution.finished', { id: job.id }); putRecord('execution', job.id, { ...job, state: 'finished' });
  let cursor = 0, spoken = '', page;
  do { page = voice.poll(row, 'first', cursor); spoken += page.text; cursor = page.cursor; assert.ok(Buffer.byteLength(page.text) <= 6000); } while (page.hasMore);
  assert.equal(spoken.trimEnd(), text.trimEnd()); assert.doesNotMatch(spoken, /<message|<p>/);
  appendEvent(job.sessionId, 'text', { text: 'An unrelated later answer.' });
  assert.doesNotMatch(voice.poll(row, 'first').text, /unrelated/);
  const stranger = phone(); assert.equal(voice.poll(stranger, 'first').state, 'unknown');
});
test('revoked, scoped or stale workspace access cannot start or inspect owner voice chat', async () => {
  const row = phone(), voice = service();
  assert.throws(() => voice.status({ ...row, relayGrantId: row.id }), { code: 'FORBIDDEN' });
  putRecord('core.relay.grant', row.id, { ...row, shareAccess: false });
  await assert.rejects(voice.send(row, 'No permission', 'denied'), { code: 'FORBIDDEN' });
  putRecord('core.relay.grant', row.id, row); await voice.send(row, 'Permitted', 'accepted');
  putRecord('core.relay.grant', row.id, { ...row, revokedAt: new Date().toISOString() });
  assert.throws(() => voice.poll(row, 'accepted'), { code: 'FORBIDDEN' });
  assert.equal(listRecords('execution').length, 1);
});
test('voice transport rejects arbitrary model, path, command and audio payloads', () => {
  const frame = (op, params) => ({ v: 1, protocol: 'bzzy-core', type: 'request', id: 'request', resource: 'resource', op, params });
  assert.equal(permissionFor(validateRequest(frame('voice.send', { text: 'Hello' }))), 'execute');
  assert.equal(permissionFor(validateRequest(frame('voice.cancel', { requestId: 'original' }))), 'pause');
  for (const key of ['provider', 'model', 'cwd', 'command', 'audio', 'token']) assert.throws(() => validateRequest(frame('voice.send', { text: 'Hello', [key]: 'untrusted' })), { code: 'INVALID_REQUEST' });
});
test('spoken questions finish one turn and explicit answers continue its existing execution', async () => {
  const row = phone();
  const voice = service({ answer: async (sessionId, input) => {
    const question = getRecord('question', input.questionId);
    assert.equal(input.answer, 'Yes'); putRecord('question', question.id, { ...question, state: 'answered' });
    appendEvent(sessionId, 'question.answered', { id: question.id, answer: input.answer });
  } });
  await voice.send(row, 'Please help', 'question-turn');
  const execution = listRecords('execution')[0]; putRecord('execution', execution.id, { ...execution, state: 'running' });
  appendEvent(execution.sessionId, 'text', { text: 'I have one question.' });
  const question = { id: randomUUID(), sessionId: execution.sessionId, state: 'pending', question: 'Continue?' };
  putRecord('question', question.id, question); appendEvent(execution.sessionId, 'question', question);
  const first = voice.poll(row, 'question-turn'); assert.equal(first.state, 'waiting_for_input'); assert.equal(first.question, 'Continue?');
  await voice.send(row, 'Yes', 'answer-turn');
  appendEvent(execution.sessionId, 'text', { text: 'Here is the final answer.' });
  putRecord('execution', execution.id, { ...execution, state: 'finished' }); appendEvent(execution.sessionId, 'execution.finished', { id: execution.id });
  assert.deepEqual(voice.poll(row, 'question-turn'), first, 'A later answer must not change the previous spoken turn');
  assert.equal(voice.poll(row, 'answer-turn').text, 'Here is the final answer.');
  assert.equal(listRecords('execution').length, 1, 'Answering resumes work rather than executing the answer as another prompt');
});
test('lost acceptance recovers its durable execution without submitting another prompt', async () => {
  const row = phone(), voice = service({ execute: async (id, input) => {
    enqueueExecution(id, input, input.requestId, { authorize: () => {} });
    throw Object.assign(new Error('Connection ended after acceptance'), { status: 503 });
  } });
  await assert.rejects(voice.send(row, 'Only once', 'lost-ack'));
  assert.equal(voice.poll(row, 'lost-ack').state, 'queued');
  assert.equal((await voice.send(row, 'Only once', 'lost-ack')).state, 'accepted');
  assert.equal(listRecords('execution').length, 1);
});
test('revocation or workspace changes during attachment prevent execution', async () => {
  const row = phone(), voice = service({ claim: async () => { putRecord('core.relay.grant', row.id, { ...row, revokedAt: new Date().toISOString() }); } });
  await assert.rejects(voice.send(row, 'Must not run', 'revoked-during-claim'), { code: 'FORBIDDEN' });
  assert.equal(listRecords('execution').length, 0);
  putRecord('core.relay.grant', row.id, row);
  const moved = path.join(directory, 'another-root'); fs.mkdirSync(moved);
  const changed = service({ claim: async () => {
    const workspaces = new CoreWorkspaces(); workspaces.configure({ path: moved }, { expectedRevision: workspaces.settings().revision, requestId: randomUUID() });
  } });
  await assert.rejects(changed.send(row, 'Still must not run', 'root-changed'), { code: 'WORKSPACE_CHANGED' });
  assert.equal(listRecords('execution').length, 0);
});
test('stopping a completed voice turn cannot pause a newer response', async () => {
  let controls = 0;
  const row = phone(), voice = service({ control: async () => { controls++; } });
  await voice.send(row, 'First', 'old');
  const first = listRecords('execution')[0]; putRecord('execution', first.id, { ...first, state: 'finished' });
  appendEvent(first.sessionId, 'execution.finished', { id: first.id });
  await voice.send(row, 'Next', 'new');
  assert.equal((await voice.cancel(row, 'old', 'stop-old')).stopped, true); assert.equal(controls, 0);
  await voice.cancel(row, 'new', 'stop-new'); assert.equal(controls, 1);
});
test('narrow authorization and its audit events roll back with the caller transaction', async () => {
  const row = phone(), voice = service(); await voice.send(row, 'Create context', 'context');
  const sessionId = listRecords('session')[0].id, before = listRecords('access-token').length;
  const events = database().prepare('SELECT COUNT(*) AS count FROM events').get().count;
  assert.throws(() => transaction(db => {
    createSessionAccess({ sessionId, recipient: 'rollback_test' }, db); throw new Error('rollback');
  }), /rollback/);
  assert.equal(listRecords('access-token').length, before);
  assert.equal(database().prepare('SELECT COUNT(*) AS count FROM events').get().count, events);
});
