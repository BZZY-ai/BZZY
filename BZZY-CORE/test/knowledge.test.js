import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSession, saveSession } from '../src/engine/store.js';
import { BUILTINS } from '../src/engine/providers.js';
import { database, getRecord, putRecord, removeRecord, appendEvent, transaction } from '../src/engine/database.js';
import { initializeProject, writeProjectRecord, projectContext } from '../src/engine/project.js';
import { resolveProjectIdentity, projectIdentityForSession } from '../src/engine/project-identity.js';
import { remember, recall, reviewMemory, invalidateMemory, memoryHistory, rollbackMemory, checkpoint } from '../src/engine/memory.js';
import { artifact } from '../src/engine/evidence.js';
import { searchProjectKnowledge, knowledgeContextFor, updateKnowledgeProfile, listKnowledgeProfiles,
  proposeKnowledgeProfile, reviewKnowledgeProfileProposal, knowledgeProfileHistory, rollbackKnowledgeProfile } from '../src/engine/knowledge.js';
import { CoreAgents } from '../src/agents.js';
import { CoreWorkspaces } from '../src/workspaces.js';
let directory, previousHome, alpha, beta;
test.beforeEach(() => {
 previousHome = process.env.BZZY_HOME; directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-knowledge-')));
 process.env.BZZY_HOME = path.join(directory, 'private');
 alpha = path.join(directory, 'alpha'); beta = path.join(directory, 'beta'); fs.mkdirSync(alpha); fs.mkdirSync(beta);
});
test.afterEach(() => { if (previousHome == null) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previousHome; fs.rmSync(directory, { recursive: true, force: true }); });
function sessionAt(root, options = {}) { const session = { ...createSession(BUILTINS.codex, root), ...options }; initializeProject(session); saveSession(session); return session; }

test('checkpoints preserve structured decisions and authorized evidence while retaining legacy string decisions', () => {
 const session = sessionAt(alpha), other = sessionAt(beta), control = artifact(session, 'negative ownership control', 'baseline'), foreign = artifact(other, 'foreign control', 'other');
 const decisions = [{ decision: 'Do not accept the worker claim until controls are inspected.', rationale: 'The anonymous control is missing.', evidence: [control.id], conditions: { reviewed: false } }, 'Retain the original negative control.'];
 const saved = checkpoint(session, { decisions, pendingActions: ['Inspect the control.'] });
 assert.deepEqual(saved.decisions, decisions); assert.deepEqual(getRecord('checkpoint', session.id).decisions, decisions);
 assert.deepEqual(checkpoint(session, { completedWork: ['Recorded the candidate.'] }).decisions, decisions);
 assert.ok(searchProjectKnowledge(session, { query: 'anonymous control', types: ['checkpoint'] }).items.length);
 const before = getRecord('checkpoint', session.id).revision;
 for (const invalid of [[{ decision: 'Wrong engagement.', evidence: [foreign.id] }], [{ decision: 'password=private-fixture-secret' }], [{ decision: 'Unbounded text.', rationale: 'x'.repeat(2001) }]]) {
   assert.throws(() => checkpoint(session, { decisions: invalid }));
   assert.equal(getRecord('checkpoint', session.id).revision, before);
 }
 const worker = sessionAt(alpha, { role: 'executor', parentSessionId: session.id });
 assert.throws(() => checkpoint(worker, { decisions: [{ decision: 'Unselected supervisor evidence.', evidence: [control.id] }] }), /authorized project evidence/);
});

test('unattributed legacy projections stay private and cannot break indexed or automatic model recall', () => {
 const session = sessionAt(alpha), marker = 'PRIVATE-NOTE-DO-NOT-FORWARD';
 for (const kind of ['memory', 'issues', 'checkpoints', 'goals']) writeProjectRecord(session, kind, randomUUID(), { statement: marker });
 const id = randomUUID(); putRecord('memory', id, { id, project: alpha, projectId: session.projectId, statement: marker });
 const safe = remember(session, { kind: 'hypothesis', statement: 'An attributed project observation remains available.' });
 assert.deepEqual(recall(alpha, marker), []);
 assert.deepEqual(searchProjectKnowledge(session, { query: marker }).items, []);
 assert.doesNotMatch(JSON.stringify(knowledgeContextFor(session, marker)), new RegExp(marker));
 assert.doesNotMatch(JSON.stringify(projectContext(alpha, { session })), new RegExp(marker));
 assert.ok(searchProjectKnowledge(session, { query: 'attributed observation' }).items.some(item => item.sourceId === safe.id));
 const worker = sessionAt(alpha, { role: 'executor', parentSessionId: session.id });
 assert.deepEqual(searchProjectKnowledge(worker, { query: marker }).items, []);
});

test('project identity supports subfolders, same-directory moves, independent copies and read-only initialization inside Core transactions', () => {
 const owner = sessionAt(alpha), identity = resolveProjectIdentity(alpha), nested = path.join(alpha, 'nested'); fs.mkdirSync(nested);
 const prior = remember(owner, { kind: 'hypothesis', statement: 'A retained engagement observation survives its directory move.' });
 assert.equal(resolveProjectIdentity(nested).id, identity.id); assert.equal(createSession(BUILTINS.claude, nested).cwd, nested);
 const moved = path.join(directory, 'moved'); fs.renameSync(alpha, moved);
 const relocated = resolveProjectIdentity(moved); assert.equal(relocated.id, identity.id); assert.ok(relocated.aliases.includes(alpha));
 assert.ok(searchProjectKnowledge(sessionAt(moved), { query: 'retained engagement' }).items.some(item => item.sourceId === prior.id));
 fs.cpSync(moved, beta, { recursive: true }); const fork = resolveProjectIdentity(beta);
 assert.notEqual(fork.id, identity.id); assert.equal(resolveProjectIdentity(beta).id, fork.id);
 transaction(() => resolveProjectIdentity(beta, { create: true }));
 assert.equal(JSON.parse(fs.readFileSync(path.join(beta, '.bzzy', 'project.json'))).id, fork.id); assert.equal(owner.projectId, identity.id);
 const empty = path.join(directory, 'empty'); fs.mkdirSync(empty);
 const readonly = sessionAt(empty, { policy: { mode: 'read-only' } }); assert.ok(readonly.projectId); assert.equal(fs.existsSync(path.join(empty, '.bzzy')), false);
 fs.symlinkSync(beta, path.join(empty, '.bzzy')); assert.throws(() => resolveProjectIdentity(empty), /real directory/);
});

test('project full-text search retrieves attributed visible history and memory without cross-project or raw-tool leakage', () => {
 const first = sessionAt(alpha), second = sessionAt(alpha), other = sessionAt(beta);
 remember(first, { kind: 'hypothesis', statement: 'Inspect ownership authorization baselines.' });
 appendEvent(first.id, 'message.user', { text: 'An exported invoice has an unexpected tenant identifier.' });
 const reply = appendEvent(first.id, 'text', { text: 'Compare anonymous, owner, and foreign tenant controls.' });
 appendEvent(first.id, 'backend', { text: 'HIDDEN_REASONING' }); appendEvent(first.id, 'tool', { detail: 'PRIVATE_TOOL_RESULT' });
 appendEvent(first.id, 'text', { text: 'Visible answer <think>PRIVATE_CHAIN</think> remains useful.' });
 appendEvent(first.id, 'message.user', { text: 'api_key=privatefixturecredentialvalue token here.' });
 appendEvent(first.id, 'text', { text: 'A JSON response: {"api_key":"jsonfixturecredentialvalue"}. URL https://fixture-user:fixture-password@localhost/.' });
 appendEvent(other.id, 'text', { text: 'INDEPENDENT_CLIENT invoice tenant facts.' });
 const found = searchProjectKnowledge(second, { query: 'tenant' }); assert.ok(found.items.some(item => item.sourceId === reply.id));
 assert.ok(found.items.every(item => item.projectId === first.projectId));
 assert.equal(searchProjectKnowledge(second, { query: 'INDEPENDENT_CLIENT HIDDEN_REASONING PRIVATE_TOOL_RESULT PRIVATE_CHAIN' }).items.length, 0);
 const indexed = database().prepare('SELECT body,payload FROM knowledge_documents').all();
 assert.doesNotMatch(JSON.stringify(indexed), /privatefixturecredentialvalue|jsonfixturecredentialvalue|fixture-password|fixture-user|PRIVATE_CHAIN|PRIVATE_TOOL_RESULT|HIDDEN_REASONING/);
 assert.ok(Buffer.byteLength(JSON.stringify(knowledgeContextFor(second, 'tenant'))) <= 12000);
});

test('truth and freshness require evidence and reviewed receipts, preserve contradictions and idempotent revision history', () => {
 const session = sessionAt(alpha), evidence = artifact(session, 'baseline response', 'positive control'); fs.writeFileSync(path.join(alpha, 'source.txt'), 'version one');
 const input = { kind: 'observation', statement: 'The response includes an owner field.', evidence: [evidence.id], inputs: ['source.txt'], requestId: 'observation-1' };
 const original = remember(session, input); assert.equal(remember(session, input).id, original.id);
 assert.throws(() => remember(session, { ...input, statement: 'Changed input.' }), /reused/);
 assert.throws(() => remember(session, { kind: 'conclusion', statement: 'Confirmed because the model says so.', evidence: [evidence.id], truth: 'confirmed' }), /cannot confirm/);
 const claim = remember(session, { kind: 'disproved', statement: 'Agent claims this finding is disproved.', evidence: [evidence.id] });
 assert.equal(claim.truth, 'inconclusive'); assert.equal(claim.claimedTruth, 'disproved');
 const reviewed = reviewMemory(session, claim.id, { truth: 'disproved', expectedRevision: 1, rationale: 'Inspected the differential controls.', explicit: true }); assert.equal(reviewed.revision, 2);
 assert.throws(() => reviewMemory(session, claim.id, { truth: 'confirmed', expectedRevision: 1, rationale: 'stale review', explicit: true }), /revision/);
 const replacement = remember(session, { kind: 'hypothesis', statement: 'Revisit ownership after the update.', supersedes: original.id, expectedRevision: 1, contradictions: [claim.id] });
 assert.ok(recall(alpha, 'disproved').find(item => item.id === claim.id).contradictions.includes(replacement.id));
 fs.writeFileSync(path.join(alpha, 'source.txt'), 'version two');
 const old = recall(alpha, 'owner').find(item => item.id === original.id); assert.equal(old.stale, true); assert.equal(old.supersededBy, replacement.id);
 assert.ok(old.staleReasons.includes('recorded-input-changed'));
 assert.equal(searchProjectKnowledge(session, { query: 'owner', types: ['memory'] }).items.some(item => item.sourceId === original.id), false);
 assert.equal(searchProjectKnowledge(session, { query: 'owner', types: ['memory'], includeStale: true }).items.some(item => item.sourceId === original.id), true);
 assert.ok(getRecord('core.memory.revision', `${claim.id}:1`)); invalidateMemory(claim.id, 'Deployment changed.', { session, expectedRevision: 2 });
 assert.equal(getRecord('memory', claim.id).truth, 'stale');
 const restored = rollbackMemory(session, claim.id, { fromRevision: 2, expectedRevision: 3, explicit: true });
 assert.equal(restored.revision, 4); assert.equal(restored.truth, 'inconclusive'); assert.equal(restored.verification, null);
 assert.deepEqual(memoryHistory(session, claim.id).items.map(item => item.revision), [4, 3, 2, 1]);
 const other = sessionAt(beta); assert.throws(() => remember(other, { kind: 'hypothesis', statement: 'Wrong scope.', supersedes: original.id, expectedRevision: 1 }), /same authorized engagement/);
 assert.throws(() => remember(other, { kind: 'observation', statement: 'Wrong evidence.', evidence: [evidence.id] }), /authorized project evidence/);
});

test('executor and registered Agent knowledge remains in the authorized session, even beneath a marked parent project', () => {
 const owner = sessionAt(alpha); appendEvent(owner.id, 'text', { text: 'PARENT_PRIVATE_HISTORY' }); remember(owner, { kind: 'hypothesis', statement: 'PARENT_ENGAGEMENT_ONLY' });
 const worker = sessionAt(alpha, { role: 'executor', parentSessionId: owner.id, projectRoot: alpha }); appendEvent(worker.id, 'text', { text: 'WORKER_OWN_RESULT' });
 const workerNote = remember(worker, { kind: 'hypothesis', statement: 'WORKER_LOCAL_NOTE' });
 const parentNote = remember(owner, { kind: 'hypothesis', statement: 'PARENT_REVIEW_ONLY', contradictions: [workerNote.id], supersedes: workerNote.id, expectedRevision: 1 });
 const workerHit = searchProjectKnowledge(worker, { query: 'WORKER_LOCAL_NOTE' }).items[0];
 assert.ok(workerHit); assert.deepEqual(workerHit.contradictions, []); assert.equal(workerHit.supersededBy, null);
 assert.equal(searchProjectKnowledge(worker, { query: 'PARENT_PRIVATE_HISTORY' }).items.length, 0); assert.equal(searchProjectKnowledge(worker, { query: 'WORKER_OWN_RESULT' }).items.length, 1);
 assert.throws(() => searchProjectKnowledge({ ...worker, role: undefined }, { query: 'Parent' }), /identity changed/);
 new CoreWorkspaces().configure({ path: path.join(alpha, 'managed'), create: true }, { requestId: randomUUID(), expectedRevision: 0 });
 const agent = new CoreAgents().create({ name: 'Bounded helper', instructions: 'Inspect this project only.', provider: 'codex', model: 'fixture', effort: 'default' }, { requestId: randomUUID() });
 const session = getRecord('session', agent.sessionId), identity = projectIdentityForSession(session);
 assert.equal(identity.root, agent.cwd); assert.notEqual(identity.id, owner.projectId);
 assert.equal(searchProjectKnowledge(session, { query: 'PARENT_ENGAGEMENT_ONLY' }).items.length, 0);
 updateKnowledgeProfile('user', { text: 'Prefer compact evidence-first reports.' }, { explicit: true });
 assert.deepEqual(knowledgeContextFor(worker, 'result').profiles, {}); assert.deepEqual(knowledgeContextFor(session, 'anything').profiles, {});
 assert.throws(() => proposeKnowledgeProfile(worker, { target: 'user', text: 'Change preferences.', reason: 'model request' }), /cannot propose/);
});

test('explicit owner profile approval is revisioned and host facts expire without entering project exports', () => {
 const session = sessionAt(alpha); assert.throws(() => updateKnowledgeProfile('user', { text: 'Set this silently.' }), /Explicit owner/);
 const user = updateKnowledgeProfile('user', { text: 'Use concise reports with separate inconclusive findings.' }, { explicit: true });
 assert.throws(() => updateKnowledgeProfile('user', { text: 'Overwrite stale settings.' }, { explicit: true }), /changed/);
 const source = appendEvent(session.id, 'message.user', { text: 'Lead with evidence and exact reproduction conditions.' });
 const proposal = proposeKnowledgeProfile(session, { target: 'user', text: 'Lead with evidence and exact reproduction conditions.', reason: 'An explicit correction.', sourceId: source.id });
 assert.equal(listKnowledgeProfiles()[0].text, user.text);
 assert.equal(reviewKnowledgeProfileProposal(proposal.id, { action: 'accept', expectedRevision: proposal.revision, explicit: true }).profile.revision, 2);
 updateKnowledgeProfile('host', { text: 'The local proxy service is available.' }, { explicit: true }); assert.ok(knowledgeContextFor(session, 'proxy').profiles.host);
 const hostname = os.hostname;
 try {
   os.hostname = () => hostname() + '-another-host';
   assert.equal(listKnowledgeProfiles().find(profile => profile.target === 'host').stale, true);
   assert.equal(knowledgeContextFor(session, 'proxy').profiles.host, undefined);
   assert.equal(listKnowledgeProfiles().find(profile => profile.target === 'user').stale, false);
 } finally { os.hostname = hostname; }
 const host = getRecord('core.knowledge.profile', 'host'); putRecord('core.knowledge.profile', 'host', { ...host, expiresAt: '2000-01-01T00:00:00Z' });
 putRecord('core.knowledge.profile.revision', 'host:1', { ...host, expiresAt: '2000-01-01T00:00:00Z' });
 assert.equal(knowledgeContextFor(session, 'proxy').profiles.host, undefined);
 updateKnowledgeProfile('host', { text: 'Updated current environment facts.' }, { explicit: true, expectedRevision: 1 });
 const restored = rollbackKnowledgeProfile('host', { fromRevision: 1, expectedRevision: 2, explicit: true });
 assert.equal(restored.revision, 3); assert.equal(restored.stale, true);
 assert.equal(knowledgeContextFor(session, 'proxy').profiles.host, undefined);
 assert.deepEqual(knowledgeProfileHistory('host').items.map(item => item.revision), [3, 2, 1]);
 assert.throws(() => updateKnowledgeProfile('user', { text: 'password=do-not-persist-this' }, { explicit: true, expectedRevision: 2 }), /authentication|credential/);
 assert.equal(fs.existsSync(path.join(alpha, '.bzzy', 'user.json')), false);
});

test('history backfill remains bounded while indexing the recent tail, and deleted sessions cannot be recalled', () => {
 const source = sessionAt(alpha), target = sessionAt(alpha);
 transaction(() => { for (let i = 0; i < 2100; i++) appendEvent(source.id, 'text', { text: `Historical baseline ${i}.` }); });
 const latest = appendEvent(source.id, 'text', { text: 'RECENT_TAIL_SIGNAL' });
 const first = searchProjectKnowledge(target, { query: 'RECENT_TAIL_SIGNAL' });
 assert.equal(first.indexing.remaining, true); assert.ok(first.items.some(item => item.sourceId === latest.id));
 assert.equal(searchProjectKnowledge(target, { query: 'baseline 2050' }).indexing.remaining, false);
 remember(source, { kind: 'hypothesis', statement: 'DELETED_SESSION_FACT' });
 assert.equal(searchProjectKnowledge(target, { query: 'DELETED_SESSION_FACT' }).items[0].kind, 'memory');
 putRecord('session-deletion', source.id, { id: source.id });
 assert.equal(searchProjectKnowledge(target, { query: 'DELETED_SESSION_FACT RECENT_TAIL_SIGNAL' }).items.length, 0);
});

test('copied invalid projections do not break recall and imported verification receipts cannot certify new memories', () => {
 const session = sessionAt(alpha), evidence = artifact(session, 'baseline', 'control'), acceptanceId = randomUUID();
 putRecord('acceptance', acceptanceId, { id: acceptanceId, sessionId: session.id, passed: true,
   importProvenance: { observation: 'imported-history' }, checks: [{ passed: true }],
   requirements: [{ id: 'ownership', passed: true, assessment: { status: 'supported', evidence: [evidence.id] } }] });
 assert.throws(() => remember(session, { kind: 'conclusion', statement: 'Pretend the imported check ran here.', truth: 'confirmed', evidence: [evidence.id],
   verificationId: acceptanceId, requirementId: 'ownership' }), /matching accepted evidence/);
 fs.mkdirSync(path.join(alpha, '.bzzy', 'memory'), { recursive: true }); fs.writeFileSync(path.join(alpha, '.bzzy', 'memory', `${randomUUID()}.json`), '{broken');
 assert.doesNotThrow(() => searchProjectKnowledge(session, { query: 'anything' }));
 const removed = remember(session, { kind: 'hypothesis', statement: 'REMOVED_RECORD_SIGNAL' });
 assert.equal(searchProjectKnowledge(session, { query: 'REMOVED_RECORD_SIGNAL' }).items.length, 1);
 removeRecord('memory', removed.id); fs.rmSync(path.join(alpha, '.bzzy', 'memory', removed.id + '.json'));
 assert.equal(searchProjectKnowledge(session, { query: 'REMOVED_RECORD_SIGNAL' }).items.length, 0);
});

test('learning writes require active job and real source provenance, and stop after pause', () => {
 const session = sessionAt(alpha), source = appendEvent(session.id, 'message.user', { text: 'Use an ownership baseline.' }), id = randomUUID();
 putRecord('core.learning.job', id, { id, sessionId: session.id, projectId: session.projectId, projectRoot: alpha, state: 'running', sourceRefs: [{ id: source.id }] });
 const record = remember(session, { kind: 'hypothesis', statement: 'Try an ownership baseline.', sourceId: source.id, requestId: 'lesson-1' }, { learningJobId: id, sourceIds: [source.id] });
 assert.equal(record.provenance.jobId, id); assert.equal(record.truth, 'hypothesis');
 assert.throws(() => remember(session, { kind: 'hypothesis', statement: 'Invented source.', sourceId: `${session.id}:9999999` }), /authorized conversation event/);
 putRecord('core.learning.job', id, { ...getRecord('core.learning.job', id), state: 'paused' });
 assert.throws(() => remember(session, { kind: 'hypothesis', statement: 'Write after pause.' }, { learningJobId: id, sourceIds: [source.id] }), /active authorized review/);
});
