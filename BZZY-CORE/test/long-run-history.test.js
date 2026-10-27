import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSession, loadSession, saveSession } from '../src/engine/store.js';
import { getProvider } from '../src/engine/providers.js';
import { appendEvent, database, digest, getRecord, listRecords, putRecord, transaction } from '../src/engine/database.js';
import { initializeProject } from '../src/engine/project.js';
import { advanceConversationSource, conversationSourceStatus, conversationRedactionContext } from '../src/engine/conversation-source.js';
import { maintainSessionHistory } from '../src/engine/history-maintenance.js';
import { knowledgeAccess, indexKnowledgeRecord, refreshKnowledgeHistory, searchKnowledgeIndex } from '../src/engine/knowledge-index.js';
import { indexSessionMemory, pendingSessionMemoryNodes, publishSessionMemorySummary, readSessionMemory, sessionMemoryMaterial, sessionMemoryStatus } from '../src/engine/session-memory.js';
import { processSessionCompactions, queueSessionCompaction, sessionCompactionStatus } from '../src/engine/session-compactor.js';
import { compactTaskState } from '../src/engine/recovery.js';
import { recordNativeCompaction } from '../src/engine/native-context.js';

let root, oldHome, session;
test.beforeEach(() => {
  oldHome = process.env.BZZY_HOME; root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-long-history-')));
  process.env.BZZY_HOME = path.join(root, 'private');
  const project = path.join(root, 'project'); fs.mkdirSync(project);
  session = createSession(getProvider('codex'), project, 'offline-fixture'); initializeProject(session);
  session.goal = { id: randomUUID(), objective: 'Compare recorded offline controls.', createdAt: new Date().toISOString(), status: 'active' };
  session.executionState = 'running'; saveSession(session);
});
test.afterEach(() => {
  if (oldHome == null) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = oldHome;
  fs.rmSync(root, { recursive: true, force: true });
});
function nativeMessage(text, { itemId = 'reused-native-item', runId = 'fixture-run', threadRef = 'fixture-thread', split = false } = {}) {
  const identity = { itemId, runId, threadRef };
  if (split) {
    const middle = Math.floor(text.length / 2);
    appendEvent(session.id, 'text', { ...identity, text: text.slice(0, middle) });
    appendEvent(session.id, 'text', { ...identity, text: text.slice(middle) });
  } else appendEvent(session.id, 'text', { ...identity, text });
  return appendEvent(session.id, 'message.finalized', identity);
}
function scanAll(target = session) {
  let result;
  for (let count = 0; count < 100; count++) { result = advanceConversationSource(target); if (!result.remaining) return result; }
  assert.fail('Bounded source scanner did not catch up.');
}
const history = () => database().prepare('SELECT seq,type,data,created_at FROM events WHERE session_id=? ORDER BY seq').all(session.id);

test('1200 finalized messages and repeated native compactions advance live memory and searchable tail without changing originals or the goal', () => {
  const originalGoal = structuredClone(session.goal);
  session.contract = { objective: session.goal.objective, context: 'Keep every declared scope and acceptance condition. '.repeat(500), constraints: ['Only supplied offline observations.'] }; saveSession(session);
  for (let batch = 0; batch < 12; batch++) {
    transaction(() => { for (let index = batch * 100; index < (batch + 1) * 100; index++) nativeMessage(`Observation ${index}: TAIL_CANARY_${index} remains unverified.`, { split: true }); });
    recordNativeCompaction(session, { threadId: 'virtual-thread', turnId: 'virtual-turn', itemId: `virtual-compaction-${batch}`, phase: 'started', at: 1000 + batch * 1000 });
    recordNativeCompaction(session, { threadId: 'virtual-thread', turnId: 'virtual-turn', itemId: `virtual-compaction-${batch}`, phase: 'completed', at: 1100 + batch * 1000 });
    const maintained = maintainSessionHistory(session); assert.equal(maintained.status, 'indexed');
    assert.ok(Buffer.byteLength(JSON.stringify(compactTaskState(session))) <= 8192);
  }
  const before = history(), originalDigest = digest(before);
  for (let tick = 0; tick < 150; tick++) {
    const result = maintainSessionHistory(session);
    if (!result.indexingRemaining) break;
    if (tick === 149) assert.fail('Rolling bounded maintenance did not drain its backlog.');
  }
  const status = sessionMemoryStatus(session), source = conversationSourceStatus(session);
  assert.equal(source.pendingMessages, 0); assert.equal(source.scannedThroughSeq, source.latestSeq); assert.equal(status.indexedThroughSeq, source.latestSeq);
  assert.ok(status.leaves >= 149, 'Reused native IDs must still count separate finalized messages.');
  const found = searchKnowledgeIndex(knowledgeAccess(session), [session.id], { query: 'TAIL_CANARY_1199', types: ['chat'] });
  assert.ok(found.items.some(item => item.text.includes('TAIL_CANARY_1199')));
  assert.deepEqual(loadSession(session.id).goal, originalGoal); assert.equal(loadSession(session.id).executionState, 'running');
  assert.equal(loadSession(session.id).nativeContext.epoch, 12); assert.equal(digest(history()), originalDigest);
  const first = pendingSessionMemoryNodes({ sessionId: session.id, limit: 1 })[0];
  assert.ok(sessionMemoryMaterial(session, first.id).sourceBytes <= 40000);
  publishSessionMemorySummary(session, first.id, { text: 'Historical offline observations remain unverified; inspect original controls.' });
  assert.ok(Buffer.byteLength(JSON.stringify(readSessionMemory(session, { maxBytes: 1024 }))) < 2000);
});

test('interleaved finalized messages mask all deltas even when their seal lies beyond the contiguous frontier', () => {
  const a = { runId: 'run', threadRef: 'thread', itemId: 'A' }, b = { runId: 'run', threadRef: 'thread', itemId: 'B' };
  const first = appendEvent(session.id, 'text', { ...a, text: 'sk-FIRST' });
  appendEvent(session.id, 'text', { ...b, text: 'Still pending.' });
  appendEvent(session.id, 'text', { ...a, text: 'PRIVATEFRAGMENT123456' });
  appendEvent(session.id, 'message.finalized', a);
  const source = scanAll(); assert.equal(source.sealedThroughSeq, first.seq); assert.equal(source.pendingMessages, 1);
  const context = conversationRedactionContext(session.id, { seq: first.seq, type: 'text' }, source.sealedThroughSeq);
  assert.match(context.text, /redacted/); assert.doesNotMatch(context.text, /sk-FIRST|PRIVATEFRAGMENT/);
  indexSessionMemory(session, { throughSeq: source.sealedThroughSeq, force: true });
  const node = pendingSessionMemoryNodes({ sessionId: session.id, limit: 1 })[0];
  assert.doesNotMatch(sessionMemoryMaterial(session, node.id).inputText, /sk-FIRST|PRIVATEFRAGMENT/);
  refreshKnowledgeHistory(session, knowledgeAccess(session), { sessionOnly: true });
  const documents = database().prepare('SELECT body,payload FROM knowledge_documents').all();
  assert.doesNotMatch(JSON.stringify(documents), /sk-FIRST|PRIVATEFRAGMENT/);
});

test('overlapping turns that reuse an item ID retain separate completion and redaction boundaries', () => {
  const common = { runId: 'run', threadRef: 'thread', itemId: 'same-item' };
  const first = appendEvent(session.id, 'text', { ...common, turnId: 'turn-A', text: 'sk-FIRST' });
  const other = appendEvent(session.id, 'text', { ...common, turnId: 'turn-B', text: 'SAFE_OTHER_TURN' });
  appendEvent(session.id, 'text', { ...common, turnId: 'turn-A', text: 'PRIVATEFRAGMENT123456' });
  appendEvent(session.id, 'message.finalized', { ...common, turnId: 'turn-A' });
  const source = scanAll(); assert.equal(source.pendingMessages, 1);
  const context = conversationRedactionContext(session.id, { seq: first.seq, type: 'text' }, source.sealedThroughSeq);
  assert.match(context.text, /redacted/); assert.doesNotMatch(context.text, /SAFE_OTHER_TURN|sk-FIRST|PRIVATEFRAGMENT/);
  appendEvent(session.id, 'message.finalized', { ...common, turnId: 'turn-B' }); scanAll();
  const separate = conversationRedactionContext(session.id, { seq: other.seq, type: 'text' }, conversationSourceStatus(session).sealedThroughSeq);
  assert.equal(separate.text, 'SAFE_OTHER_TURN');
});

test('more than 1024 interleaved starts cannot block the scanner from reaching their completion markers', () => {
  transaction(() => {
    for (let index = 0; index < 1100; index++) appendEvent(session.id, 'text', { runId: 'run', threadRef: 'thread', itemId: `open-${index}`, text: `Observation ${index}.` });
    for (let index = 0; index < 1100; index++) appendEvent(session.id, 'message.finalized', { runId: 'run', threadRef: 'thread', itemId: `open-${index}` });
  });
  const partial = advanceConversationSource(session); assert.equal(partial.remaining, true);
  assert.ok(partial.pending.length <= 32); assert.ok(Buffer.byteLength(JSON.stringify(getRecord('core.conversation.source', session.id))) < 16000);
  const result = scanAll(); assert.equal(result.pendingMessages, 0); assert.equal(result.sealedThroughSeq, conversationSourceStatus(session).latestSeq);
});

test('unfinished native tails stay out of active indexes and become searchable after their seal', () => {
  nativeMessage('A finalized baseline.');
  const identity = { runId: 'run', threadRef: 'thread', itemId: 'partial' };
  appendEvent(session.id, 'text', { ...identity, text: 'UNFINISHED_TAIL_MARKER' });
  maintainSessionHistory(session);
  assert.equal(searchKnowledgeIndex(knowledgeAccess(session), [session.id], { query: 'UNFINISHED_TAIL_MARKER', types: ['chat'] }).items.length, 0);
  const before = conversationSourceStatus(session); assert.equal(before.pendingMessages, 1);
  appendEvent(session.id, 'text', { ...identity, text: ' is complete now.' }); appendEvent(session.id, 'message.finalized', identity);
  maintainSessionHistory(session);
  assert.ok(searchKnowledgeIndex(knowledgeAccess(session), [session.id], { query: 'UNFINISHED_TAIL_MARKER', types: ['chat'] }).items.length);
  assert.ok(conversationSourceStatus(session).sealedThroughSeq > before.sealedThroughSeq);
});

test('unrelated modern seals do not split conservative legacy whole-message privacy masking', () => {
  session.executionState = 'idle'; saveSession(session);
  const first = appendEvent(session.id, 'text', { itemId: 'old-adapter-item', text: 'sk-FIRST' });
  appendEvent(session.id, 'message.finalized', { runId: 'other-run', threadRef: 'other-thread', itemId: 'unrelated-native-item' });
  appendEvent(session.id, 'text', { itemId: 'old-adapter-item', text: 'PRIVATEFRAGMENT123456' });
  const end = appendEvent(session.id, 'message.user', { text: 'The next legacy-visible boundary.' });
  const context = conversationRedactionContext(session.id, { seq: first.seq, type: 'text' }, end.seq);
  assert.match(context.text, /redacted/); assert.doesNotMatch(context.text, /sk-FIRST|PRIVATEFRAGMENT/);
});

test('older item-only text cannot pin later sealed native history after a visible legacy boundary', () => {
  appendEvent(session.id, 'text', { itemId: 'older-native-item-without-scope', text: 'A finished answer from an older adapter.' });
  appendEvent(session.id, 'message.user', { kind: 'goal', text: 'A fresh current request.' });
  nativeMessage('CURRENT_NATIVE_AFTER_LEGACY');
  const source = scanAll(); assert.equal(source.pendingMessages, 0); assert.equal(source.sealedThroughSeq, conversationSourceStatus(session).latestSeq);
  maintainSessionHistory(session);
  assert.ok(searchKnowledgeIndex(knowledgeAccess(session), [session.id], { query: 'CURRENT_NATIVE_AFTER_LEGACY', types: ['chat'] }).items.length);
});

test('V1 summary generations and chat fragments are withheld and migrate without altering immutable history', () => {
  nativeMessage('A current complete observation.'); scanAll(); indexSessionMemory(session, { force: true });
  const first = pendingSessionMemoryNodes({ sessionId: session.id, limit: 1 })[0];
  publishSessionMemorySummary(session, first.id, { text: 'V1_UNSAFE_PRIVATE_FRAGMENT' });
  const old = getRecord('core.session.memory', session.id); delete old.sourceVersion; old.version = 1; putRecord('core.session.memory', session.id, old);
  indexKnowledgeRecord(knowledgeAccess(session).project, 'chat', `${session.id}:legacy-fragment`, session.id, 'V1_UNSAFE_PRIVATE_FRAGMENT', { text: 'V1_UNSAFE_PRIVATE_FRAGMENT', sourceVersion: 1 });
  const before = digest(history());
  assert.doesNotMatch(JSON.stringify(readSessionMemory(session)), /V1_UNSAFE_PRIVATE_FRAGMENT/);
  assert.equal(searchKnowledgeIndex(knowledgeAccess(session), [session.id], { query: 'V1_UNSAFE_PRIVATE_FRAGMENT', types: ['chat'] }).items.length, 0);
  maintainSessionHistory(session);
  assert.notEqual(sessionMemoryStatus(session).generation, old.generation);
  assert.ok(getRecord('core.session.memory.history', `${session.id}:${old.generation}`)); assert.equal(digest(history()), before);
});

test('deferred legacy sessions yield discovery turns to later active finalized sessions', () => {
  const sources = [session];
  for (let index = 0; index < 33; index++) {
    const target = createSession(getProvider('codex'), session.cwd, 'offline-fixture'); initializeProject(target);
    target.executionState = 'running'; saveSession(target); sources.push(target);
  }
  sources.sort((a, b) => a.id.localeCompare(b.id));
  const target = sources.at(-1);
  for (const source of sources.slice(0, -1)) appendEvent(source.id, 'text', { text: 'An unfinished legacy response.' });
  appendEvent(target.id, 'text', { text: 'LATER_ELIGIBLE_SESSION', runId: 'run', threadRef: 'thread', itemId: 'answer' });
  appendEvent(target.id, 'message.finalized', { runId: 'run', threadRef: 'thread', itemId: 'answer' });
  for (let tick = 0; tick < 5; tick++) refreshKnowledgeHistory(session, knowledgeAccess(session), { limit: 64 });
  const result = searchKnowledgeIndex(knowledgeAccess(session), sources.map(source => source.id), { query: 'LATER_ELIGIBLE_SESSION', types: ['chat'] });
  assert.ok(result.items.some(item => item.sessionId === target.id));
});

test('whole-message aggregate budgets retain the unprocessed cursor and eventually index large completed history', () => {
  transaction(() => {
    for (let index = 0; index < 35; index++) nativeMessage(`LARGE_MESSAGE_${index} ${'p'.repeat(120000)}`, { itemId: `large-${index}` });
  });
  scanAll(); const access = knowledgeAccess(session), before = digest(history());
  const first = refreshKnowledgeHistory(session, access, { sessionOnly: true });
  assert.equal(first.remaining, true); assert.ok(first.indexed < 35);
  const key = `history:v2:${session.projectId}:${session.id}`;
  const initialCursor = getRecord('core.knowledge.cursor', key).seq;
  assert.ok(initialCursor < conversationSourceStatus(session).latestSeq);
  let result = first, previousCursor = initialCursor;
  for (let tick = 0; tick < 40 && result.remaining; tick++) {
    result = refreshKnowledgeHistory(session, access, { sessionOnly: true });
    const current = getRecord('core.knowledge.cursor', key).seq; assert.ok(current >= previousCursor); previousCursor = current;
  }
  assert.equal(result.remaining, false);
  for (let index = 0; index < 35; index++) assert.ok(searchKnowledgeIndex(access, [session.id], { query: `LARGE_MESSAGE_${index}`, types: ['chat'] }).items.length);
  assert.equal(digest(history()), before);
});

test('clock contention cannot let repeated tail reads starve the bounded prefix work unit', () => {
  transaction(() => { for (let index = 0; index < 100; index++) nativeMessage(`CLOCK_FAIR_PREFIX_${index}`, { itemId: `clock-${index}` }); });
  scanAll(); const access = knowledgeAccess(session), originalNow = Date.now;
  let wall = originalNow();
  try {
    // Simulate preemption after each clock observation without sleeping. The
    // minimum prefix unit remains bounded by the existing byte/part limits.
    Date.now = () => wall += 100;
    const result = refreshKnowledgeHistory(session, access, { sessionOnly: true, limit: 64 });
    assert.equal(result.remaining, true);
  } finally { Date.now = originalNow; }
  const cursor = getRecord('core.knowledge.cursor', `history:v2:${session.projectId}:${session.id}`).seq;
  assert.ok(cursor >= 63, 'At least32 complete one-delta messages must advance before yielding.');
  const prefix = searchKnowledgeIndex(access, [session.id], { query: 'CLOCK_FAIR_PREFIX_31', types: ['chat'] });
  assert.ok(prefix.items.length);
});

test('a short foreground-safe summary behind 100 deferred paid jobs receives a bounded scheduler turn', async () => {
  transaction(() => {
    for (let index = 0; index < 808; index++) nativeMessage(`Large observation ${index}. ${'Keep the inconclusive controls and original evidence. '.repeat(8)}`);
  });
  scanAll(); queueSessionCompaction(session, { force: true, maxParts: 1024 });
  appendEvent(session.id, 'message.user', { text: 'Short host-only summary.' }); scanAll(); queueSessionCompaction(session, { force: true, maxParts: 1024 });
  const status = sessionCompactionStatus(session), jobs = listRecords('core.session.compactor.job', { sessionId: session.id });
  assert.ok(jobs.length > 100);
  const short = jobs.find(item => sessionMemoryMaterial(session, item.nodeId).sourceBytes < 400);
  assert.ok(short);
  putRecord('core.session.compactor.discovery', 'scheduler-jobs', { after: short.id });
  let completed;
  for (let tick = 0; tick < 3; tick++) {
    const results = await processSessionCompactions({ runModel: () => assert.fail('Foreground paid inference remains deferred.') });
    if (results.some(item => item.id === short.id)) { completed = results.find(item => item.id === short.id); break; }
  }
  assert.equal(completed?.state, 'completed'); assert.equal(sessionCompactionStatus(session).settings.duringForeground, false);
  assert.equal(status.control.state, 'enabled'); assert.equal(loadSession(session.id).executionState, 'running');
});

test('rotating bounded backfill reaches later controls while earlier sources still have unfinished pages', async () => {
  const sources = [];
  for (let index = 0; index < 25; index++) {
    const target = createSession(getProvider('codex'), session.cwd, 'offline-fixture'); initializeProject(target);
    target.executionState = 'running'; saveSession(target); sources.push(target);
    appendEvent(target.id, 'text', { runId: 'run', threadRef: 'thread', itemId: 'large', text: 'x'.repeat(400000) });
    appendEvent(target.id, 'message.finalized', { runId: 'run', threadRef: 'thread', itemId: 'large' });
    scanAll(target); queueSessionCompaction(target, { maxParts: 1 });
  }
  assert.ok(sources.every(target => getRecord('core.session.memory', target.id).cursorOffset === 2048));
  await processSessionCompactions({ runModel: () => assert.fail('Oversize omission material needs no paid backend.') });
  await processSessionCompactions({ runModel: () => assert.fail('Oversize omission material needs no paid backend.') });
  assert.ok(sources.every(target => getRecord('core.session.memory', target.id).cursorOffset > 2048 || !getRecord('core.session.memory', target.id).cursorOffset));
});
