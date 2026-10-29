import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSession, saveSession } from '../src/engine/store.js';
import { BUILTINS } from '../src/engine/providers.js';
import { appendEvent, getRecord, putRecord, listRecords } from '../src/engine/database.js';
import { initializeProject, issue } from '../src/engine/project.js';
import { artifact } from '../src/engine/evidence.js';
import { checkpoint, checkpointState, memoryFreshness } from '../src/engine/memory.js';
import { knowledgeAccess } from '../src/engine/knowledge-index.js';
import { recordWorkObservation, captureEpisode } from '../src/engine/episode.js';
import { investigationCapsule, investigationScope, currentInvestigationAttribution, validateInvestigationBlockers,
  updateInvestigation, readInvestigationSource, sanitizedNativeBlocker } from '../src/engine/session-investigation.js';
import { CodexEngine } from '../src/engine/engines/codex.js';

let directory, prior, session, context;
test.beforeEach(() => {
  prior = process.env.BZZY_HOME; directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-investigation-')));
  process.env.BZZY_HOME = path.join(directory, 'private');
  const cwd = path.join(directory, 'project'); fs.mkdirSync(cwd);
  session = createSession(BUILTINS.codex, cwd, 'offline-fixture'); initializeProject(session);
  session.goal = { id: randomUUID(), status: 'active', objective: 'Investigate a fictional offline parser.' };
  session.contract = { objective: session.goal.objective, constraints: ['Use only offline fixtures.'], scope: { allowedTargets: [] } };
  session.executionState = 'running'; saveSession(session);
  context = { runId: 'run-a', goalMode: true };
  putRecord('run', session.id, { id: context.runId, sessionId: session.id, state: 'running', goalMode: true, goalId: session.goal.id });
});
test.afterEach(() => {
  if (prior == null) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = prior;
  fs.rmSync(directory, { recursive: true, force: true });
});
const declare = (requestId = 'branch', dependencies = [{ kind: 'session_input' }]) => updateInvestigation(session,
  { action: 'declare', requestId, hypothesis: 'The fictional parser rejects a missing fixture.', dependencies }, context);
const blocker = (unit, extra = {}) => updateInvestigation(session, { action: 'block', requestId: 'block-' + unit.id,
  id: unit.id, expectedRevision: unit.revision, blocker: { key: 'missing-fixture', kind: 'owner_input', description: 'The offline fixture is unavailable.',
    resolver: 'owner', affectedWork: 'The parser verification branch.', neededChange: 'Supply the permitted offline fixture.' }, ...extra }, context);
const observe = (itemId, extra = {}) => recordWorkObservation(session, { runId: context.runId, itemId, command: 'fixture-parser check',
  kind: 'command', name: 'shell', output: 'Fixture unavailable.', exitCode: 1, ...extra });

test('observed attempts retain branch/dependency attribution and repeat conditions without duplicate capture', () => {
  const branch = declare(), first = observe('attempt-a');
  assert.equal(observe('attempt-a').id, first.id);
  observe('attempt-b'); captureEpisode(session, { runId: context.runId, goalId: session.goal.id });
  const third = observe('attempt-c');
  assert.equal(first.workUnitId, branch.id); assert.equal(third.workUnitId, branch.id);
  assert.equal(listRecords('core.episode.observation').length, 3);
  const repeated = investigationCapsule(session, context).repeatedAttempts[0];
  assert.equal(repeated.count, 3); assert.equal(repeated.outcomes.failed, 3);
  assert.equal(repeated.dependencyCoverage, 'recorded');
  appendEvent(session.id, 'message.user', { text: 'A different offline fixture is available.' });
  const changed = observe('attempt-d');
  assert.notEqual(changed.dependencyFingerprint, first.dependencyFingerprint);
  assert.equal(investigationCapsule(session, context).repeatedAttempts[0].count, 3);
  assert.equal(listRecords('execution').length, 0);
});

test('stable blocker resolution needs changed dependencies, records a receipt and never resumes work', () => {
  const blocked = blocker(declare()), id = blocked.blockers[0].id;
  const input = { action: 'resolve', requestId: 'resolve', id: blocked.id, expectedRevision: blocked.revision,
    blockerId: id, expectedBlockerRevision: 1, resolution: 'The owner supplied the offline fixture.' };
  assert.throws(() => updateInvestigation(session, input, context), /dependency has not changed/);
  appendEvent(session.id, 'message.user', { text: 'The permitted fixture is now supplied.' });
  const changed = investigationCapsule(session, context).branches[0].blockers[0]; assert.equal(changed.dependencyChanged, true);
  const resolved = updateInvestigation(session, input, context);
  assert.equal(resolved.blockers[0].state, 'resolved'); assert.equal(resolved.blockers[0].resolution.observedChange, true);
  assert.deepEqual(updateInvestigation(session, input, context), resolved);
  assert.equal(getRecord('session', session.id).goal.status, 'active'); assert.equal(listRecords('execution').length, 0);
  const closed = updateInvestigation(session, { action: 'close', id: resolved.id, requestId: 'close', expectedRevision: resolved.revision, outcome: 'inconclusive' }, context);
  assert.equal(closed.state, 'closed'); assert.equal(closed.outcome, 'inconclusive');
  assert.throws(() => updateInvestigation(session, { action: 'select', id: closed.id, requestId: 'restart' }, context), /Closed branches/);
});

test('one blocked branch cannot stop another available branch, while explicit all-blocked returns a stop request', () => {
  const one = declare('one'), two = declare('two');
  assert.throws(() => blocker(one, { blockGoal: true }), /Other current branches/);
  assert.equal(getRecord('core.workflow.work-unit', one.id).blockers.length, 0, 'failed all-blocked claim is atomic');
  const blockedOne = blocker(one);
  assert.equal(blockedOne.goalBlocker, undefined); assert.equal(getRecord('session', session.id).goal.status, 'active');
  const blockedTwo = blocker(two, { blockGoal: true });
  assert.equal(blockedTwo.goalBlocker.status, 'blocked'); assert.equal(blockedTwo.goalBlocker.requiresExecutionStop, true);
  assert.equal(blockedTwo.goalBlocker.blockerIds.length, 2); assert.equal(blockedTwo.goalBlocker.coverage, 'all-declared-current-branches');
  assert.match(blockedTwo.goalBlocker.reason, /offline fixture/);
  assert.equal(getRecord('session', session.id).goal.status, 'active', 'the runtime stop callback owns execution status');
});

test('new goals retain branches only as historical sources and worker/sibling sessions cannot read them', () => {
  const branch = blocker(declare());
  session.goal = { ...session.goal, id: randomUUID() }; saveSession(session);
  putRecord('run', session.id, { ...getRecord('run', session.id), goalId: session.goal.id });
  const state = investigationCapsule(session, context);
  assert.equal(state.branches.length, 0); assert.equal(state.historicalCount, 1);
  assert.throws(() => updateInvestigation(session, { action: 'select', id: branch.id, requestId: 'old' }, context), /another execution scope/);
  const page = readInvestigationSource(session, { id: branch.id, revision: String(branch.revision) }, context);
  assert.equal(JSON.parse(page.text).currentScope, false);
  const worker = createSession(BUILTINS.codex, session.cwd, 'offline-fixture');
  Object.assign(worker, { role: 'executor', parentSessionId: session.id }); initializeProject(worker); saveSession(worker);
  assert.throws(() => readInvestigationSource(worker, { id: branch.id, revision: String(branch.revision) }), /outside this session/);
  assert.equal(investigationCapsule(worker).branches.length, 0);
});

test('tombstoned sessions cannot read, change or attribute retained investigation records through stale objects', () => {
  const branch = blocker(declare()), before = getRecord('core.workflow.work-unit', branch.id);
  putRecord('session-deletion', session.id, { id: session.id, deletedAt: new Date().toISOString() });
  assert.ok(getRecord('session', session.id), 'The tombstone must protect even a still-retained source record.');
  const calls = [
    () => investigationScope(session, context),
    () => investigationCapsule(session, context),
    () => currentInvestigationAttribution(session, context),
    () => validateInvestigationBlockers(session, [branch.blockers[0].id], context),
    () => readInvestigationSource(session, { id: branch.id, revision: String(branch.revision) }, context),
    () => updateInvestigation(session, { action: 'select', requestId: 'deleted-select', id: branch.id }, context),
  ];
  for (const call of calls) assert.throws(call, /source is unavailable/);
  assert.deepEqual(getRecord('core.workflow.work-unit', branch.id), before);
});

test('forged project roots, project IDs and roles cannot read or attribute another scope', () => {
  const branch = declare(), foreignRoot = path.join(directory, 'foreign-project'); fs.mkdirSync(foreignRoot);
  const foreign = createSession(BUILTINS.codex, foreignRoot, 'offline-fixture'); initializeProject(foreign); saveSession(foreign);
  const forged = [
    { ...session, cwd: foreign.cwd, projectRoot: foreign.projectRoot, projectId: foreign.projectId },
    { ...session, projectRoot: foreignRoot }, { ...session, projectId: foreign.projectId },
    { ...session, role: 'executor', parentSessionId: foreign.id },
  ];
  for (const value of forged) {
    assert.throws(() => investigationCapsule(value, context), /identity changed/);
    assert.throws(() => currentInvestigationAttribution(value, context), /identity changed/);
    assert.throws(() => readInvestigationSource(value, { id: branch.id, revision: String(branch.revision) }, context), /identity changed/);
    assert.throws(() => updateInvestigation(value, { action: 'select', requestId: 'forged-select', id: branch.id }, context), /identity changed/);
  }
  assert.throws(() => readInvestigationSource(foreign, { id: branch.id, revision: String(branch.revision) }), /outside this session/);
  const legacy = { ...getRecord('session', session.id) }; delete legacy.projectRoot; delete legacy.projectId;
  putRecord('session', session.id, legacy);
  assert.throws(() => investigationCapsule({ ...legacy, projectRoot: foreignRoot }, context), /identity changed/, 'An unsaved project root cannot retarget a legacy session.');
});

test('permitted workers retain only their own exact session branches and disabled roles receive none', () => {
  const rootBranch = declare();
  const worker = createSession(BUILTINS.codex, session.cwd, 'offline-fixture');
  Object.assign(worker, { role: 'executor', parentSessionId: session.id, assignmentId: 'worker-assignment', assignmentRound: 1, executionState: 'running' });
  initializeProject(worker); saveSession(worker);
  const workerContext = { runId: 'worker-run', goalMode: false };
  putRecord('run', worker.id, { id: workerContext.runId, sessionId: worker.id, state: 'running', goalMode: false });
  const branch = updateInvestigation(worker, { action: 'declare', requestId: 'own-worker-branch', hypothesis: 'Inspect the permitted fictional worker fixture.' }, workerContext);
  assert.deepEqual(investigationCapsule(worker, workerContext).branches.map(item => item.id), [branch.id]);
  assert.equal(currentInvestigationAttribution(worker, workerContext).workUnitId, branch.id);
  assert.equal(JSON.parse(readInvestigationSource(worker, { id: branch.id, revision: '1' }, workerContext).text).sessionId, worker.id);
  assert.throws(() => readInvestigationSource(worker, { id: rootBranch.id, revision: '1' }, workerContext), /outside this session/);
  assert.throws(() => investigationCapsule({ ...worker, role: null, parentSessionId: null }, workerContext), /identity changed/);
  const disabled = { ...worker, role: 'knowledge-review' }; putRecord('session', worker.id, disabled);
  assert.throws(() => investigationCapsule(disabled, workerContext), /source is unavailable/);
  assert.throws(() => currentInvestigationAttribution(disabled, workerContext), /source is unavailable/);
});

test('ordinary chat branch ownership remains session based and separate from prior goal progress', () => {
  const goalBranch = declare();
  context = { runId: 'chat-run', goalMode: false };
  putRecord('run', session.id, { id: context.runId, state: 'running', goalMode: false });
  const chat = declare('chat');
  const state = investigationCapsule(session, context);
  assert.equal(state.scope.goalId, null); assert.deepEqual(state.branches.map(item => item.id), [chat.id]);
  assert.equal(state.historicalCount, 1);
  assert.equal(observe('chat-attempt').workUnitId, chat.id);
  assert.notEqual(chat.id, goalBranch.id);
});

test('structured checkpoint edits preserve IDs, exact archives and evidence while retaining legacy array writes', () => {
  const firstEvidence = artifact(session, 'First fixture', 'first'), secondEvidence = artifact(session, 'Second fixture', 'second');
  const first = checkpoint(session, { decisions: ['Original decision.'], unresolvedQuestions: ['Need the fixture?'], evidence: [firstEvidence.id] }, context);
  const decision = first.items.find(item => item.field === 'decisions'), question = first.items.find(item => item.field === 'unresolvedQuestions');
  const updated = checkpoint(session, { expectedRevision: first.revision, requestId: 'items',
    itemOperations: [{ op: 'update', field: 'decisions', id: decision.id, expectedItemRevision: 1, text: 'Revised decision.' },
      { op: 'resolve', field: 'unresolvedQuestions', id: question.id, expectedItemRevision: 1 }],
    evidenceOperations: { add: [secondEvidence.id] } }, context);
  assert.equal(updated.items.find(item => item.field === 'decisions').id, decision.id);
  assert.deepEqual(updated.decisions, ['Revised decision.']); assert.deepEqual(updated.unresolvedQuestions, []);
  assert.deepEqual(new Set(updated.evidence), new Set([firstEvidence.id, secondEvidence.id]));
  assert.equal(updated.itemArchive.find(item => item.id === question.id).state, 'resolved');
  assert.equal(updated.itemArchive.find(item => item.id === decision.id).checkpointRevision, first.revision);
  assert.deepEqual(getRecord('core.checkpoint.revision', `${session.id}:${first.revision}`).decisions, ['Original decision.']);
  assert.throws(() => checkpoint(session, { itemOperations: [{ op: 'archive', field: 'decisions', id: decision.id, expectedItemRevision: 1 }] }, context), /item changed/);
  const legacy = checkpoint(session, { decisions: ['A legacy replacement.'] }, context);
  assert.deepEqual(legacy.decisions, ['A legacy replacement.']); assert.ok(legacy.itemArchive.some(item => item.id === decision.id && item.state === 'replaced'));
});

test('checkpoints reference one canonical blocker store and reject another goal blocker', () => {
  const branch = blocker(declare()), id = branch.blockers[0].id;
  const first = checkpoint(session, { blockerIds: [id] }, context); assert.deepEqual(first.blockerIds, [id]);
  session.goal = { ...session.goal, id: randomUUID() }; saveSession(session);
  putRecord('run', session.id, { ...getRecord('run', session.id), goalId: session.goal.id });
  assert.equal(checkpointState(session, context).current, null);
  assert.throws(() => checkpoint(session, { blockerIds: [id] }, context), /another session or execution scope/);
});

test('capsules and source pages remain bounded and source changes reject continuation pages', () => {
  let branch = declare('unicode');
  branch = blocker(branch);
  const capsule = investigationCapsule(session, context, { maxBytes: 1800 }); assert.ok(Buffer.byteLength(JSON.stringify(capsule)) <= 1800);
  let offset = 0, revision = String(branch.revision), text = '';
  do {
    const page = readInvestigationSource(session, { id: branch.id, revision, offset, limit: 113 }, context);
    assert.ok(Buffer.byteLength(page.text) <= 113); text += page.text; revision = page.revision; offset = page.nextOffset;
  } while (offset != null);
  assert.equal(JSON.parse(text).blockers[0].neededChange, 'Supply the permitted offline fixture.');
  updateInvestigation(session, { action: 'close', requestId: 'abandon', id: branch.id, expectedRevision: branch.revision, outcome: 'abandoned' }, context);
  assert.throws(() => readInvestigationSource(session, { id: branch.id, revision, offset: 113, limit: 113 }, context), /changed/);
});

test('native blocked reasons are sanitized and unavailable reasons stay explicit', () => {
  assert.equal(sanitizedNativeBlocker(null).reasonAvailable, false);
  assert.doesNotMatch(sanitizedNativeBlocker('Failure password="FICTIONAL_PRIVATE"').reason, /FICTIONAL_PRIVATE/);
  const events = [], engine = new CodexEngine(BUILTINS.codex, session, { toolHost: { context } }, { event(type, data) { events.push({ type, data }); } });
  engine.operation = { goal: true }; engine.goalArmed = true;
  engine.updateGoal({ status: 'blocked', tokensUsed: 0, timeUsedSeconds: 1, reason: 'Owner input needed password="FICTIONAL_PRIVATE"' });
  assert.equal(session.goal.reason, 'native_blocked'); assert.equal(session.goal.nativeBlocker.reasonAvailable, true);
  assert.doesNotMatch(JSON.stringify(session.goal), /FICTIONAL_PRIVATE/);
  engine.updateGoal({ status: 'blocked', tokensUsed: 0, timeUsedSeconds: 1 });
  assert.equal(session.goal.nativeBlocker.reasonAvailable, false); assert.match(session.goal.lastBlocker, /without a usable reason/);
});

test('report delivery and fix claims preserve separate inconclusive technical truth and original timestamps', () => {
  const evidence = artifact(session, 'Fictional offline report package', 'report');
  const observedAt = '2025-01-02T03:04:05.000Z';
  let current = issue(session, { title: 'Fictional parser assessment', status: 'inconclusive', evidence: [evidence.id], observedAt,
    reportLifecycle: { state: 'saved', observedAt, evidence: [evidence.id] } });
  const original = current;
  for (const state of ['claimed_submitted', 'acknowledged', 'fixed']) {
    current = issue(session, { id: current.id, expectedRevision: current.revision, title: current.title, status: 'inconclusive',
      reportLifecycle: { state, evidence: [evidence.id] } });
    assert.equal(current.truth, 'inconclusive'); assert.equal(current.reportLifecycle.state, state);
    assert.equal(current.observedAt, observedAt); assert.equal(current.reportLifecycle.observedAt, null);
    assert.equal(current.sourceVersion, current.revision); assert.equal(current.reportLifecycle.sourceVersion, current.revision);
    assert.match(current.reportLifecycle.authority, /do not establish technical truth/);
  }
  assert.equal(getRecord('core.issue.revision', `${original.id}:1`).reportLifecycle.state, 'saved');
  assert.equal(getRecord('core.issue.revision', `${original.id}:1`).observedAt, observedAt);
  assert.throws(() => issue(session, { title: 'Missing receipt', reportLifecycle: { state: 'acknowledged' } }), /require evidence/);
  const legacy = issue(session, { title: 'An older observation with unknown time.' }); assert.equal(legacy.observedAt, null);
});

test('future and expired applicability remains historical even if report lifecycle claims fixed', () => {
  const evidence = artifact(session, 'Fictional fix report', 'report');
  const future = issue(session, { title: 'Future version claim', evidence: [evidence.id],
    applicability: { validFrom: '2999-01-01T00:00:00Z', validUntil: '2999-01-02T00:00:00Z' },
    reportLifecycle: { state: 'fixed', evidence: [evidence.id] } });
  const project = knowledgeAccess(session).project;
  assert.ok(memoryFreshness(future, project, session).staleReasons.includes('not-yet-applicable'));
  const expired = issue(session, { title: 'Old version claim', applicability: { validUntil: '2000-01-01T00:00:00Z' } });
  assert.ok(memoryFreshness(expired, project, session).staleReasons.includes('expired'));
  assert.throws(() => issue(session, { title: 'Invalid date range', applicability: { validFrom: '2026-01-02T00:00:00Z', validUntil: '2026-01-01T00:00:00Z' } }), /end after/);
});

test('a prior all-blocked receipt cannot stop a later explicitly resumed native run', () => {
  const branch = declare();
  const input = { action: 'block', requestId: 'stable-stop', id: branch.id, expectedRevision: branch.revision, blockGoal: true,
    blocker: { key: 'fixture', kind: 'owner_input', description: 'Fixture needed.', resolver: 'owner', affectedWork: 'Parser branch.', neededChange: 'Provide fixture.' } };
  assert.ok(updateInvestigation(session, input, context).goalBlocker);
  context = { ...context, runId: 'new-run' }; putRecord('run', session.id, { ...getRecord('run', session.id), id: context.runId });
  const replay = updateInvestigation(session, input, context);
  assert.equal(replay.goalBlocker, undefined); assert.equal(replay.historicalOnly, true);
});

test('new issue duplicate advice retains resolved and blocked source IDs without merging or changing truth', () => {
  const evidence = artifact(session, 'Fictional report package', 'report');
  const reported = issue(session, { title: 'Orbit bulletin stored XSS', status: 'resolved', evidence: [evidence.id] });
  const blocked = issue(session, { title: 'Orbit bulletin stored XSS review', status: 'blocked' });
  assert.ok(blocked.likelyDuplicateIssues.items.some(item => item.id === reported.id && item.status === 'resolved'));
  const another = issue(session, { title: 'Orbit bulletin stored XSS observation' });
  assert.deepEqual(new Set(another.likelyDuplicateIssues.items.map(item => item.id)), new Set([reported.id, blocked.id]));
  assert.equal(another.likelyDuplicateIssues.complete, false);
  assert.ok(another.likelyDuplicateIssues.items.every(item => item.truth === 'inconclusive'));
  assert.equal(getRecord('issue', reported.id).status, 'resolved'); assert.equal(getRecord('issue', blocked.id).status, 'blocked');
  assert.equal(listRecords('issue').length, 3);
  assert.equal(getRecord('issue', another.id).likelyDuplicateIssues, undefined, 'advice is a view, not another stored claim');
});
