import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createSession, loadSession, saveSession } from '../src/store.js';
import { BUILTINS } from '../src/providers.js';
import { prepareTask } from '../src/task.js';
import { newGoal } from '../src/goals.js';
import { getRecord, putRecord, now, listRecords } from '../src/database.js';
import { captureEvidence } from '../src/evidence.js';
import { ToolHost } from '../src/tools.js';
import { sendPeerMessage, peerInbox, peerArtifactAllowed, reviewPeerEvidence, peerCollaborationState } from '../src/peer-collaboration.js';
import { ensureRuntime, runtimeInfo, runtimeRequest } from '../src/runtime.js';
import { identityAlive } from '../src/recovery.js';
import { delay } from '../src/delegation.js';
import { runBesties } from '../src/besties.js';
import { runParallel } from '../src/parallel.js';
import { runDebate } from '../src/debate.js';
import { assessCompletion, assessRequirement, assessGroupCompletion } from '../src/verification.js';

let directory, environment;
const keys = ['BZZY_HOME', 'BZZY_CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'BZZY_CODEX_BIN', 'BZZY_CLAUDE_BIN', 'BZZY_TEST_ADVANCED'];
test.beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-besties-'));
  environment = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const fixture = fileURLToPath(new URL('fixtures/advanced-agent.mjs', import.meta.url));
  Object.assign(process.env, { BZZY_HOME: path.join(directory, 'private'), BZZY_CODEX_HOME: path.join(directory, 'codex'), CLAUDE_CONFIG_DIR: path.join(directory, 'claude'), BZZY_CODEX_BIN: fixture, BZZY_CLAUDE_BIN: fixture });
  delete process.env.BZZY_TEST_ADVANCED;
});
test.afterEach(async () => {
  const info = runtimeInfo();
  if (info && identityAlive(info.identity)) await runtimeRequest(info, 'POST', '/shutdown', {}).catch(() => {});
  for (let index = 0; index < 100 && info && identityAlive(info.identity); index++) await delay(20);
  for (const [key, value] of Object.entries(environment)) if (value == null) delete process.env[key]; else process.env[key] = value;
  fs.rmSync(directory, { recursive: true, force: true });
});
function parent() {
  const project = path.join(directory, 'project'); fs.mkdirSync(project); fs.writeFileSync(path.join(project, 'source.txt'), 'a supplied local challenge');
  const session = createSession(BUILTINS.codex, project);
  prepareTask(session, { mode: 'besties', besties: [{ provider: 'codex', model: 'fixture-brain', effort: 'xhigh' }, { provider: 'claude', model: 'opus', effort: 'high' }] }, 'Solve and independently verify the supplied challenge');
  session.goal = newGoal(session.contract.objective); saveSession(session); return session;
}
function peers(session) {
  const result = session.besties.map((selection, index) => {
    const work = path.join(directory, `peer-${index}`); fs.mkdirSync(work); fs.writeFileSync(path.join(work, 'proof.txt'), 'local control evidence ' + index);
    const child = createSession(BUILTINS[selection.provider], work, selection.model);
    Object.assign(child, { bestiesSessionId: session.id, parentSessionId: session.id, role: 'bestie', contract: session.contract, policy: session.policy, agentNamespace: `peer-${index}`, projectRoot: session.cwd }); saveSession(child);
    return child;
  });
  putRecord('besties', session.id, { goalId: session.goal.id, peers: result.map(child => ({ sessionId: child.id, selection: { provider: child.provider }, namespace: child.agentNamespace })), cursors: {}, createdAt: now() });
  return result;
}

for (const [mode, run] of [['besties', runBesties], ['parallel', runParallel], ['debate', runDebate]]) {
  test(`${mode} snapshot limit pauses the same goal without launching model work`, async () => {
    const session = parent(), goalId = session.goal.id;
    session.mode = mode; session.parallelAgents = session.besties; session.debateAgents = session.besties; saveSession(session);
    fs.writeFileSync(path.join(process.env.BZZY_HOME, 'config.json'), JSON.stringify({ snapshotLimits: { maxFileMiB: 1 } }));
    const fd = fs.openSync(path.join(session.cwd, 'tool-output.bin'), 'w'); fs.ftruncateSync(fd, 2 * 1024 * 1024); fs.closeSync(fd);
    const messages = [];
    assert.equal(await run(session, {}, { event(type, data) { messages.push({ type, ...data }); } }), 130);
    const paused = loadSession(session.id);
    assert.equal(paused.goal.id, goalId); assert.equal(paused.goal.status, 'paused');
    assert.equal(paused.goal.reason, 'snapshot_limit'); assert.equal(paused.executionState, 'paused');
    assert.ok(messages.some(event => event.type === 'error' && /snapshotLimits.maxFileMiB/.test(event.message)));
    assert.equal(listRecords('execution').length, 0); assert.equal(listRecords('assignment').length, 0);
  });
}

test('peer messages are durable, idempotent and grant only explicitly shared evidence', async () => {
  const session = parent(), [a, b] = peers(session), evidence = captureEvidence(a, 'proof.txt');
  const input = { requestId: 'proof-once', text: 'I inspected the local control; please check this evidence.', evidence: [evidence.id] };
  const message = sendPeerMessage(a, input); assert.equal(sendPeerMessage(a, input).id, message.id);
  assert.equal(peerArtifactAllowed(b, evidence.id), true); assert.equal(peerArtifactAllowed(a, evidence.id), false);
  const inbox = peerInbox(b); assert.equal(inbox.items.length, 1); assert.equal(inbox.items[0].id, message.id); assert.equal(peerInbox(b).items.length, 0);
  assert.equal(peerInbox(b, { after: 0 }).items.length, 1);
  sendPeerMessage(a, { text: 'A later planning clarification' }); peerInbox(b);
  assert.equal(peerInbox(b, { after: 0, limit: 1 }).items[0].id, message.id);
  assert.equal(peerInbox(b).items.length, 0, 'historical inspection never rewinds the unread cursor');
  assert.throws(() => sendPeerMessage(a, { ...input, to: randomUUID() }), /other bestie/);
  assert.throws(() => reviewPeerEvidence(b, { messageId: message.id, assessment: 'supported', rationale: 'Uninspected assertion', evidence: [evidence.id] }), /Open current peer evidence/);
  const host = new ToolHost(b, { event() {} }); const read = await host.call('read_artifact', { id: evidence.id }); assert.match(read.content, /local control/);
  assert.equal(reviewPeerEvidence(b, { messageId: message.id, assessment: 'supported', rationale: 'Independently inspected this local control evidence', evidence: [evidence.id] }).assessment, 'supported');
});
test('completion requires mutual current evidence review and preserves disagreement and changed inputs', async () => {
  const session = parent(), [a, b] = peers(session), first = captureEvidence(a, 'proof.txt'), second = captureEvidence(b, 'proof.txt');
  const ma = sendPeerMessage(a, { text: 'Proof A', evidence: [first.id] }), mb = sendPeerMessage(b, { text: 'Proof B', evidence: [second.id] });
  for (const [reviewer, message, evidence] of [[a, mb, second], [b, ma, first]]) {
    await new ToolHost(reviewer, { event() {} }).call('read_artifact', { id: evidence.id });
    reviewPeerEvidence(reviewer, { messageId: message.id, assessment: 'supported', rationale: 'Inspected the cited evidence', evidence: [evidence.id] });
  }
  assert.equal(peerCollaborationState(session).supported, true);
  reviewPeerEvidence(a, { messageId: mb.id, assessment: 'disputed', rationale: 'The control does not establish the claimed result', evidence: [second.id] });
  assert.equal(peerCollaborationState(session).supported, false);
  assert.ok(peerCollaborationState(session).reviews.some(review => review.assessment === 'disputed'));
  reviewPeerEvidence(a, { messageId: mb.id, assessment: 'supported', rationale: 'The corrected interpretation is now supported', evidence: [second.id] });
  fs.writeFileSync(path.join(b.cwd, 'proof.txt'), 'changed input'); assert.equal(peerCollaborationState(session).supported, false);
  session.goal = newGoal('A new assessment'); saveSession(session);
  assert.throws(() => sendPeerMessage(a, { text: 'Stale group message' }), /outside this active besties objective/);
});

test('coordinated cancellation stops queued peers and explicit resume retains their workspaces and histories', async () => {
  const session = parent();
  const ui = { event(type) { if (type === 'besties.turn') { const id = randomUUID(); putRecord('control', id, { id, sessionId: session.id, action: 'cancel', state: 'queued' }); } } };
  assert.equal(await runBesties(session, {}, ui), 130);
  const first = getRecord('besties', session.id), peerIds = first.peers.map(peer => peer.sessionId);
  assert.equal(first.peers.length, 2); assert.equal(session.goal.status, 'cancelled');
  assert.ok(listRecords('execution').filter(job => peerIds.includes(job.sessionId)).every(job => job.state === 'stopped'));
  assert.equal(loadSession(peerIds[0]).selectedEffort, 'xhigh'); assert.equal(loadSession(peerIds[1]).selectedEffort, 'high');
  assert.equal(session.contract.limits.runtimeSeconds, undefined);
  assert.equal(await runBesties(session, { bestiesResume: true, bestiesRunId: randomUUID() }, ui), 130);
  assert.deepEqual(getRecord('besties', session.id).peers.map(peer => peer.sessionId), peerIds);
  assert.equal(listRecords('execution').filter(job => peerIds.includes(job.sessionId)).length, 4);
});

test('group acceptance requires declared artifacts in the original workspace despite successful peer copies', async () => {
  const session = parent(); session.contract.artifacts = [{ path: 'report.txt' }];
  session.contract.acceptanceCriteria = [{ id: 'report', description: 'Record the independently inspected report' }]; saveSession(session);
  const children = peers(session);
  for (const child of children) {
    fs.writeFileSync(path.join(child.cwd, 'report.txt'), 'verified local report');
    const proof = captureEvidence(child, 'report.txt'); child.goal = newGoal(session.goal.objective); child.goal.status = 'complete';
    assessRequirement(child, { id: 'report', status: 'supported', rationale: 'Inspected the local report', evidence: [proof.id] });
    child.acceptance = await assessCompletion(child); assert.equal(child.acceptance.passed, true); saveSession(child);
  }
  const missing = await assessGroupCompletion(session, children); assert.equal(missing.passed, false);
  assert.equal(missing.artifacts[0].passed, false); assert.equal(missing.requirements[0].passed, true);
  assert.ok(getRecord('artifact', missing.aggregateEvidenceId));
  fs.writeFileSync(path.join(session.cwd, 'report.txt'), 'verified final original-workspace report');
  assert.equal((await assessGroupCompletion(session, children)).passed, true);
});

async function finished(id) {
  for (let index = 0; index < 600; index++) { const job = getRecord('execution', id); if (job && !['queued', 'launching', 'running'].includes(job.state)) return job; await delay(30); }
  throw new Error('Besties execution timed out');
}
test('besties creates two isolated peer chats with independent effort and refuses completion without cross-review', async () => {
  const session = parent(), info = await ensureRuntime(), owner = randomUUID();
  await runtimeRequest(info, 'POST', `/sessions/${session.id}/claim`, { owner });
  const launch = await runtimeRequest(info, 'POST', `/sessions/${session.id}/execute`, { owner, prompt: session.goal.objective, goal: true, options: {} }, randomUUID());
  const job = await finished(launch.executionId); assert.equal(job.exitCode, 2, job.error);
  const group = getRecord('besties', session.id); assert.equal(group.peers.length, 2); assert.notEqual(group.peers[0].sessionId, group.peers[1].sessionId);
  assert.equal(loadSession(group.peers[0].sessionId).selectedEffort, 'xhigh'); assert.equal(loadSession(group.peers[1].sessionId).selectedEffort, 'high');
  assert.equal(loadSession(session.id).goal.status, 'awaiting_review'); assert.equal(getRecord('besties-result', session.id).collaboration.supported, false);
  const view = await runtimeRequest(info, 'GET', `/sessions/${session.id}`); assert.equal(view.capabilities.chatTabs, true); assert.equal(view.children.length, 2);
  const before = listRecords('execution').length;
  const ordinary = await runtimeRequest(info, 'POST', `/sessions/${session.id}/execute`, { owner, prompt: 'Explain your uncertainty', goal: false, options: {} }, randomUUID());
  assert.equal((await finished(ordinary.executionId)).exitCode, 0);
  assert.equal(listRecords('execution').length, before + 1, 'ordinary parent chat does not restart the two-peer goal');
});

for (const count of [2, 3]) for (const disputed of [false, true]) test(`native besties (${count} peers) ${disputed ? 'preserves unresolved peer disagreement' : 'shares and mutually verifies evidence before completing'}`, async () => {
  process.env.BZZY_TEST_ADVANCED = disputed ? 'besties-disputed' : 'besties';
  const session = parent(), info = await ensureRuntime(), owner = randomUUID();
  if (count === 3) { session.besties.push({ provider: 'codex', model: null, effort: 'high' }); saveSession(session); }
  await runtimeRequest(info, 'POST', `/sessions/${session.id}/claim`, { owner });
  const launch = await runtimeRequest(info, 'POST', `/sessions/${session.id}/execute`, { owner, prompt: session.goal.objective, goal: true, options: {} }, randomUUID());
  const job = await finished(launch.executionId); assert.equal(job.exitCode, disputed ? 2 : 0, job.error || JSON.stringify(getRecord('besties-result', session.id)));
  const result = getRecord('besties-result', session.id);
  assert.equal(result.collaboration.latestClaims.length, count); assert.equal(result.collaboration.reviews.length, count);
  assert.equal(result.collaboration.supported, !disputed);
  assert.equal(loadSession(session.id).goal.status, disputed ? 'awaiting_review' : 'complete');
  assert.ok(result.collaboration.reviews.every(review => review.assessment === (disputed ? 'disputed' : 'supported')));
  assert.ok(listRecords('execution').filter(execution => execution.sessionId !== session.id).length <= count * 2, 'stable messages do not cause runaway inference');
  const group = getRecord('besties', session.id), newOwner = randomUUID();
  await runtimeRequest(info, 'POST', `/sessions/${session.id}/claim`, { owner: newOwner, takeover: true });
  for (const peer of group.peers) assert.equal((await runtimeRequest(info, 'GET', `/sessions/${peer.sessionId}`)).inputOwner.owner, newOwner);
});

test('besties stops unseen-feedback ping-pong at the per-peer exchange cap', async () => {
  const session = parent(), children = peers(session);
  const group = getRecord('besties', session.id); group.started = {}; group.exchanges = {};
  for (const child of children) {
    child.goal = newGoal(session.goal.objective); child.goal.status = 'complete'; saveSession(child);
    group.started[child.id] = true; group.exchanges[child.id] = 6;
  }
  putRecord('besties', session.id, group);
  for (const child of children) sendPeerMessage(child, { text: 'Unresolved feedback requires another exchange.' });
  assert.equal(await runBesties(session, {}, { event() {} }), 130);
  assert.equal(session.goal.status, 'paused'); assert.equal(session.goal.reason, 'exchange_limit');
  assert.equal(listRecords('execution', { sessionIds: children.map(child => child.id) }).length, 0, 'the limit must stop before another backend is queued');
  assert.deepEqual(getRecord('besties', session.id).exchanges, group.exchanges);
});
