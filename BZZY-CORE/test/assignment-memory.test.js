import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { CoreAssistant } from '../src/assistant.js';
import { getProvider } from '../src/engine/providers.js';
import { createSession, saveSession } from '../src/engine/store.js';
import { appendEvent, database, getRecord, putRecord } from '../src/engine/database.js';
import { assignmentMemoryReceipt, currentAssignmentMemoryCapsule } from '../src/engine/assignment-memory.js';
import { indexSessionMemory, pendingSessionMemoryNodes, sessionMemoryMaterial, publishSessionMemorySummary,
  readSessionMemory, expandSessionMemory, sessionMemoryStatus } from '../src/engine/session-memory.js';
import { queueSessionCompaction, processSessionCompactions } from '../src/engine/session-compactor.js';

let directory, previousHome, previousTaskKey, session;
const privateText = 'PRIVATE_WORKER_BODY_password_and_mail';
test.beforeEach(() => {
  previousHome = process.env.BZZY_HOME;
  previousTaskKey = process.env.BZZY_TASK_TEST_API_KEY;
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-assignment-memory-')));
  process.env.BZZY_HOME = path.join(directory, 'private');
  session = createSession({ id: 'codex', backend: 'codex' }, directory);
  session.goal = { id: randomUUID(), objective: 'Inspect the offline fixture.', createdAt: new Date().toISOString(), status: 'active' };
  saveSession(session);
});
test.afterEach(() => {
  if (previousHome === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previousHome;
  if (previousTaskKey === undefined) delete process.env.BZZY_TASK_TEST_API_KEY; else process.env.BZZY_TASK_TEST_API_KEY = previousTaskKey;
  fs.rmSync(directory, { recursive: true, force: true });
});
function assignment(overrides = {}) {
  const job = { id: randomUUID(), parentSessionId: session.id, goalId: session.goal.id, currentRound: 1, closure: 'open',
    role: 'executor', createdAt: new Date().toISOString(),
    subagentDefinition: { id: 'a'.repeat(64), name: 'xss-agent', version: 'b'.repeat(64), instructions: privateText },
    contract: { objective: 'Check the offline search field for reflected XSS.', context: privateText,
      limits: { tokenBudget: 20000, runtimeSeconds: 300 } }, ...overrides };
  putRecord('assignment', job.id, job);
  putRecord('round', `${job.id}:1`, { assignmentId: job.id, number: 1, state: 'starting' });
  const created = appendEvent(session.id, 'assignment.created', job);
  return { job, created };
}
function finish(job, overrides = {}) {
  const report = { assignmentId: job.id, round: 1, state: 'budget_limited', stopReason: 'token_limit', workerClaim: 'unknown',
    missingReport: true, summary: privateText, reportArtifactId: randomUUID(), artifacts: [{ id: randomUUID(), label: privateText, path: privateText }], ...overrides };
  const finished = appendEvent(session.id, 'assignment.finished', { id: job.id, round: report.round, state: report.state, report });
  putRecord('round', `${job.id}:${report.round}`, report);
  putRecord('assignment', job.id, { ...job, currentRound: report.round, latestReport: report });
  return { report, finished };
}
const pending = () => pendingSessionMemoryNodes({ sessionId: session.id, limit: 100 });
function indexAll() {
  let indexed;
  for (let i = 0; i < 100; i++) {
    indexed = indexSessionMemory(session, { force: true, maxParts: 2 });
    if (!indexed.indexingRemaining) return indexed;
  }
  assert.fail('bounded memory indexing must finish');
}
const material = () => pending().map(node => sessionMemoryMaterial(session, node.id).inputText).join('\n');

test('compaction material contains scoped typed agent receipts and review/evidence references, never worker payloads', () => {
  const { job } = assignment(), { report, finished } = finish(job);
  const reviewId = randomUUID(), evidenceId = report.artifacts[0].id;
  appendEvent(session.id, 'assignment.reviewed', { id: reviewId, assignmentId: job.id, round: 1, outcome: 'inconclusive',
    rationale: privateText, inspectedEvidence: [evidenceId], patch: { rawBody: privateText } });
  appendEvent(session.id, 'tool', { text: privateText });
  appendEvent(session.id, 'backend', { text: privateText });
  indexAll(); const text = material(), receipt = assignmentMemoryReceipt(session, finished.seq);
  assert.equal(receipt.receipt.missingReport, true); assert.equal(receipt.receipt.workerClaim, 'unknown');
  for (const expected of [job.id, job.subagentDefinition.version, 'xss-agent', 'budget_limited', 'token_limit', report.reportArtifactId, evidenceId, reviewId, 'inconclusive']) assert.ok(text.includes(expected), expected);
  assert.ok(!text.includes(privateText)); assert.match(text, /host-receipt/);
  assert.ok(pending().every(node => node.sourceBytes <= 12000));
  const page = expandSessionMemory(session, { id: pending()[0].id, limit: 16000 });
  assert.equal(page.provenance, 'conversation-and-host-assignment-receipts');
});

test('the actual restricted compactor receives agent receipts and publishes their navigation without executing worker history', async () => {
  new CoreAssistant().configure({ source: 'core', provider: 'deepseek', model: getProvider('deepseek').model, effort: 'low' }, { requestId: randomUUID(), expectedRevision: 0 });
  const { job } = assignment(), { report } = finish(job);
  appendEvent(session.id, 'assignment.reviewed', { id: randomUUID(), assignmentId: job.id, round: 1, outcome: 'inconclusive', inspectedEvidence: [] });
  queueSessionCompaction(session, { force: true });
  let calls = 0;
  const results = await processSessionCompactions({ authAvailable: async () => true, runModel: async input => {
    calls++; assert.equal(input.task.kind, 'session-compaction');
    for (const expected of [job.id, 'xss-agent', 'token_limit', 'missingReport', 'inconclusive', 'Check the offline search field for reflected XSS.']) assert.ok(input.prompt.includes(expected), expected);
    assert.ok(!input.prompt.includes(privateText));
    assert.match(input.instructions, /worker claims from reviewed results/);
    return { text: `Historical xss-agent ${job.id} stopped at token_limit without a structured report. Supervisor review was inconclusive; inspect ${report.reportArtifactId}.`, tokens: 10, usageAvailable: true };
  } });
  assert.equal(calls, 1); assert.ok(results.some(result => result.state === 'completed'));
  assert.ok(JSON.stringify(readSessionMemory(session)).includes(report.reportArtifactId));
  assert.equal(getRecord('round', `${job.id}:1`).state, 'budget_limited');
});

test('duplicate replay is indexed once, older rounds stay historical and a restarted view restores current Core state', () => {
  const { job } = assignment(), first = finish(job);
  const duplicate = appendEvent(session.id, 'assignment.finished', { id: job.id, round: 1, state: first.report.state, report: first.report });
  assert.equal(assignmentMemoryReceipt(session, duplicate.seq), null);
  const newer = finish(job, { round: 2, state: 'awaiting_review', stopReason: undefined, missingReport: false, workerClaim: 'partial' });
  appendEvent(session.id, 'assignment.started', { id: job.id, round: 1 }); // delayed old event
  indexAll();
  const text = material(); assert.equal(text.split('"event":"assignment.finished"').length - 1, 2);
  for (const node of pending()) publishSessionMemorySummary(session, node.id, {
    text: `Historical agent ${job.id} reached token_limit in round 1; inspect report ${first.report.reportArtifactId}. Later round 2 requires review.`, provider: 'host', model: 'receipt-fixture', effort: 'none',
  });
  const before = currentAssignmentMemoryCapsule(session, { goalMode: true });
  assert.equal(before.assignments[0].round, 2); assert.equal(before.assignments[0].state, 'awaiting_review');
  const memoryModule = new URL('../src/engine/session-memory.js', import.meta.url).href;
  const receiptModule = new URL('../src/engine/assignment-memory.js', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import { readSessionMemory } from ${JSON.stringify(memoryModule)};import {currentAssignmentMemoryCapsule} from ${JSON.stringify(receiptModule)};console.log(JSON.stringify({memory:readSessionMemory(process.argv[1]),capsule:currentAssignmentMemoryCapsule(process.argv[1],{goalMode:true})}));`, session.id], {
    encoding: 'utf8', env: { BZZY_HOME: process.env.BZZY_HOME, HOME: directory, PATH: process.env.PATH || '' }, timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr); const restored = JSON.parse(result.stdout);
  assert.ok(JSON.stringify(restored.memory).includes(first.report.reportArtifactId));
  assert.equal(restored.capsule.assignments[0].state, 'awaiting_review');
  assert.equal(restored.capsule.assignments[0].reportArtifactId, newer.report.reportArtifactId);
});

test('cross-parent events are excluded, current goal/run scope is exact and imports cannot assert live execution', () => {
  const other = createSession({ id: 'codex', backend: 'codex' }, directory);
  const { job, created } = assignment(); finish(job);
  assert.equal(assignmentMemoryReceipt(other, created.seq), null);
  const forged = appendEvent(session.id, 'assignment.created', { ...job, id: randomUUID(), parentSessionId: other.id });
  assert.equal(assignmentMemoryReceipt(session, forged.seq), null);
  const foreignGoal = assignment({ goalId: randomUUID() }).job; finish(foreignGoal);
  const imported = assignment({ importProvenance: { observation: 'imported-history' } }).job; finish(imported);
  const importedJob = getRecord('assignment', imported.id); putRecord('assignment', imported.id, { ...importedJob, importProvenance: { observation: 'imported-history' } });
  const capsule = currentAssignmentMemoryCapsule(session, { goalMode: true });
  assert.ok(!capsule.assignments.some(item => item.assignmentId === foreignGoal.id));
  assert.equal(capsule.assignments.find(item => item.assignmentId === imported.id).state, 'historical');
  const runId = randomUUID(), otherRun = randomUUID();
  const chat = assignment({ goalId: null, chatRunId: runId }).job;
  assignment({ goalId: null, chatRunId: otherRun });
  const chatCapsule = currentAssignmentMemoryCapsule(session, { goalMode: false, runId });
  assert.deepEqual(chatCapsule.assignments.map(item => item.assignmentId), [chat.id]);
});

test('memory generation migrates lazily without editing source events or active contracts and verifies receipt source hashes', () => {
  const { job } = assignment(), { finished } = finish(job);
  const oldGeneration = randomUUID(), contract = structuredClone(getRecord('assignment', job.id).contract);
  putRecord('core.session.memory', session.id, { sessionId: session.id, sourceVersion: 2, version: 2, generation: oldGeneration, leafCount: 0 });
  assert.equal(sessionMemoryStatus(session).legacyRebuildPending, true);
  const before = database().prepare('SELECT seq,type,data FROM events WHERE session_id=? ORDER BY seq').all(session.id);
  indexAll(); assert.equal(sessionMemoryStatus(session).sourceVersion, 5);
  assert.ok(getRecord('core.session.memory.history', `${session.id}:${oldGeneration}`));
  assert.deepEqual(getRecord('assignment', job.id).contract, contract);
  assert.deepEqual(database().prepare('SELECT seq,type,data FROM events WHERE session_id=? ORDER BY seq').all(session.id), before);
  const node = pending()[0], row = database().prepare('SELECT data FROM events WHERE seq=?').get(finished.seq);
  const changed = JSON.parse(row.data); changed.report.stopReason = 'runtime_limit';
  database().prepare('UPDATE events SET data=? WHERE seq=?').run(JSON.stringify(changed), finished.seq);
  assert.throws(() => sessionMemoryMaterial(session, node.id), { code: 'SESSION_MEMORY_INTEGRITY' });
});

test('live usage polling leaves the assignment capsule revision stable while lifecycle changes invalidate it', () => {
  const { job } = assignment(), result = finish(job);
  const before = currentAssignmentMemoryCapsule(session, { goalMode: true });
  putRecord('assignment', job.id, { ...getRecord('assignment', job.id), latestReport: { ...result.report, usage: { tokens: 19999, available: true } } });
  assert.equal(currentAssignmentMemoryCapsule(session, { goalMode: true }).revision, before.revision);
  putRecord('round', `${job.id}:1`, { ...result.report, state: 'paused' });
  assert.notEqual(currentAssignmentMemoryCapsule(session, { goalMode: true }).revision, before.revision);
});

test('malformed optional receipt fields cannot expose private values, break indexing or widen the saved owner identity', () => {
  const { job } = assignment();
  const finished = appendEvent(session.id, 'assignment.finished', { id: job.id, round: 1, state: privateText,
    report: { artifacts: { arbitrary: privateText }, workerClaim: privateText, stopReason: privateText, reportArtifactId: privateText, missingReport: null } });
  const receipt = assignmentMemoryReceipt(session, finished.seq);
  assert.equal(receipt.receipt.state, 'unknown'); assert.equal(receipt.receipt.workerClaim, 'unknown'); assert.equal(receipt.receipt.missingReport, true);
  assert.ok(!receipt.text.includes(privateText)); indexAll(); assert.ok(!material().includes(privateText));
  assert.throws(() => currentAssignmentMemoryCapsule({ ...session, cwd: path.join(directory, 'foreign') }), { code: 'ASSIGNMENT_MEMORY_SCOPE' });
  assert.throws(() => assignmentMemoryReceipt({ ...session, role: 'executor' }, finished.seq), { code: 'ASSIGNMENT_MEMORY_SCOPE' });
});

test('allocation warnings and distinct extensions retain revisions and safe evidence without duplicating replay', () => {
  const { job } = assignment(), evidence = randomUUID();
  appendEvent(session.id, 'assignment.budget.warning', { assignmentId: job.id, round: 1, revision: 1, tokenLimit: 20000, runtimeLimitSeconds: 300 });
  const extension = { assignmentId: job.id, round: 1, revision: 2, tokenLimit: 40000, runtimeLimitSeconds: 600, evidence: [evidence], progress: privateText };
  appendEvent(session.id, 'assignment.budget.extended', extension);
  const duplicate = appendEvent(session.id, 'assignment.budget.extended', extension);
  appendEvent(session.id, 'assignment.budget.extended', { ...extension, revision: 3, tokenLimit: 60000 });
  assert.equal(assignmentMemoryReceipt(session, duplicate.seq), null);
  finish(job, { stopReason: 'allocation_checkpoint', state: 'awaiting_review', workerClaim: 'partial', missingReport: false });
  indexAll(); const text = material();
  for (const expected of ['allocation_warning', 'allocation_extended', '40000', '60000', evidence, 'allocation_checkpoint']) assert.ok(text.includes(expected), expected);
  assert.equal(text.split('"state":"allocation_extended"').length - 1, 2);
  assert.ok(!text.includes(privateText));
});

test('trusted Core run identifiers remain compatible without granting cross-run access or accepting control text', () => {
  for (const runId of ['context-run', 'chat-run-1']) {
    const { job, created } = assignment({ goalId: null, chatRunId: runId });
    putRecord('run', session.id, { id: runId, sessionId: session.id, state: 'running', goalMode: false });
    const capsule = currentAssignmentMemoryCapsule(session, { goalMode: false, runId });
    assert.equal(capsule.scope.chatRunId, runId);
    assert.deepEqual(capsule.assignments.map(item => item.assignmentId), [job.id]);
    assert.equal(currentAssignmentMemoryCapsule(session, { goalMode: false }).scope.chatRunId, runId);
    assert.equal(assignmentMemoryReceipt(session, created.seq).receipt.chatRunId, runId);
  }
  for (const runId of ['unsafe\nrun', '../foreign', 'x'.repeat(193), {}, 4]) {
    assert.throws(() => currentAssignmentMemoryCapsule(session, { goalMode: false, runId }), { code: 'ASSIGNMENT_MEMORY_SCOPE' });
  }
});

test('immutable original and focused round tasks survive compaction while full context and worker prose stay excluded', () => {
  const original = 'Check https://target.example/search for reflected XSS.', focused = 'Retest the HTML attribute sink with the recorded harmless canary.';
  const { job, created } = assignment({ contract: { objective: original, context: privateText, acceptanceCriteria: [privateText] } });
  const followup = appendEvent(session.id, 'assignment.followup', { id: job.id, round: 2, objective: focused, feedback: privateText, context: privateText });
  putRecord('round', `${job.id}:2`, { assignmentId: job.id, number: 2, state: 'needs_context', objective: focused, feedback: privateText,
    contextRequest: { questions: [{ question: privateText }] } });
  putRecord('assignment', job.id, { ...job, currentRound: 2, contract: { objective: 'Mutable job text must not replace the saved original task.' } });
  session.goal.objective = 'Mutable current goal text must not replace the original task.'; saveSession(session);
  indexAll(); const text = material();
  assert.ok(text.includes(original)); assert.ok(text.includes(focused));
  for (const absent of [privateText, 'Mutable job text', 'Mutable current goal text']) assert.ok(!text.includes(absent));
  assert.equal(assignmentMemoryReceipt(session, created.seq).receipt.task.kind, 'original_objective');
  assert.equal(assignmentMemoryReceipt(session, followup.seq).receipt.task.kind, 'round_objective');
  assert.equal(currentAssignmentMemoryCapsule(session, { goalMode: true }).assignments[0].task, focused);
  assert.equal(getRecord('assignment', job.id).currentRound, 2);
  assert.equal(session.goal.status, 'active');
});

test('task credentials and aliases spanning preview boundaries are masked with stable refs after credential rotation', () => {
  const secret = 'ROTATED_CREDENTIAL_FRAGMENT_'.repeat(8), prefix = 'Check https://target.example/search. ' + 'a'.repeat(525);
  delete process.env.BZZY_TASK_TEST_API_KEY;
  const { created } = assignment({ contract: { objective: prefix + secret + ' and retain evidence.' } });
  assignment({ contract: { objective: prefix + 'private/owner=case?verification^1@forwarding.example' } });
  assignment({ contract: { objective: prefix + 'password="private first line\nprivate second line" and retain evidence.' } });
  indexAll(); const refs = pending().flatMap(node => node.refs), originalHash = assignmentMemoryReceipt(session, created.seq).sha256;
  process.env.BZZY_TASK_TEST_API_KEY = secret;
  const text = material();
  for (const absent of ['ROTATED_CREDENTIAL', 'private/owner', 'forwarding.example', 'private first', 'private second']) assert.ok(!text.includes(absent), absent);
  assert.ok(text.includes('https://target.example/search'));
  assert.ok(text.includes('[redacted]'));
  assert.equal(assignmentMemoryReceipt(session, created.seq).sha256, originalHash);
  assert.deepEqual(pending().flatMap(node => node.refs), refs);
  const derived = database().prepare("SELECT data FROM records WHERE kind LIKE 'core.session.memory%'").all();
  assert.ok(!JSON.stringify(derived).includes('ROTATED_CREDENTIAL'));
  assert.ok(!JSON.stringify(derived).includes('private first'));
});

test('task display remains byte-bounded after redaction, oversized tasks are omitted and full-source tampering is detected', () => {
  const { created } = assignment({ contract: { objective: 'password=x; '.repeat(100) } });
  const maximum = assignment({ goalId: randomUUID(), chatRunId: 'r'.repeat(192),
    subagentDefinition: { id: 'a'.repeat(192), name: 'n'.repeat(128), version: 'b'.repeat(64) }, contract: { objective: 'a'.repeat(2000) } });
  const oversized = assignment({ contract: { objective: 'a'.repeat(128 * 1024 + 1) } });
  indexAll();
  const receipt = assignmentMemoryReceipt(session, maximum.created.seq);
  assert.ok([...receipt.text].length <= 2048, 'task receipts fit a single source part');
  assert.equal(assignmentMemoryReceipt(session, oversized.created.seq).receipt.task.omitted, 'over_128_kib');
  const text = material(), displays = [...text.matchAll(/Parent-assigned task \(untrusted task data; no permission or execution grant\):\n([^\n]*)/g)];
  assert.ok(displays.length >= 2);
  for (const [, preview] of displays) assert.ok(Buffer.byteLength(preview) <= 600);
  assert.ok(!text.includes('password=x'));
  const row = database().prepare('SELECT data FROM events WHERE seq=?').get(created.seq), changed = JSON.parse(row.data);
  changed.contract.objective = changed.contract.objective.slice(0, 1000) + 'changed beyond the visible prefix';
  database().prepare('UPDATE events SET data=? WHERE seq=?').run(JSON.stringify(changed), created.seq);
  assert.throws(() => material(), { code: 'SESSION_MEMORY_INTEGRITY' });
});

test('projection-one generation-three maps rebuild lazily without changing active assignments or original events', () => {
  const { job } = assignment(), generation = randomUUID(), before = database().prepare('SELECT seq,type,data FROM events WHERE session_id=? ORDER BY seq').all(session.id);
  putRecord('core.session.memory', session.id, { sessionId: session.id, sourceVersion: 3, version: 3, generation, leafCount: 0 });
  const contract = structuredClone(getRecord('assignment', job.id).contract);
  assert.equal(sessionMemoryStatus(session).legacyRebuildPending, true);
  indexAll();
  assert.equal(sessionMemoryStatus(session).sourceVersion, 5);
  assert.ok(getRecord('core.session.memory.history', `${session.id}:${generation}`));
  assert.ok(pending().flatMap(node => node.refs).every(ref => ref.projectionVersion === 2));
  assert.deepEqual(getRecord('assignment', job.id).contract, contract);
  assert.deepEqual(database().prepare('SELECT seq,type,data FROM events WHERE session_id=? ORDER BY seq').all(session.id), before);
});
