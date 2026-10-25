import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSession, saveSession } from '../src/engine/store.js';
import { getProvider } from '../src/engine/providers.js';
import { appendEvent, database, getRecord, putRecord } from '../src/engine/database.js';
import { deleteTerminalConversation } from '../src/engine/session-deletion.js';
import { saveKey } from '../src/engine/providers.js';
import { taskTools, ToolHost } from '../src/engine/tools.js';
import { sanitizeLearningText, maskLearningText } from '../src/engine/learning.js';
import { sessionMemoryEligible, indexSessionMemory, pendingSessionMemoryNodes, sessionMemoryMaterial,
  publishSessionMemorySummary, readSessionMemory, expandSessionMemory, sessionMemoryStatus, resetSessionMemory } from '../src/engine/session-memory.js';

let root, priorHome, session;
test.beforeEach(() => {
  priorHome = process.env.BZZY_HOME;
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-session-memory-')));
  process.env.BZZY_HOME = path.join(root, 'private');
  session = createSession(getProvider('codex'), root, 'selected-model', 'Session one');
});
test.afterEach(() => {
  if (priorHome === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = priorHome;
  fs.rmSync(root, { recursive: true, force: true });
});
const visible = (target, count = 8, prefix = 'observation') => Array.from({ length: count }, (_, index) => appendEvent(target.id,
  index % 2 ? 'text' : 'message.user', { text: `${prefix} ${index}.`, ...(index % 2 ? { itemId: `answer-${index}` } : {}) }));
const pending = target => pendingSessionMemoryNodes({ limit: 1000 }).filter(node => node.sessionId === target.id);
const events = target => database().prepare('SELECT * FROM events WHERE session_id=? ORDER BY seq').all(target.id);
const publish = (target, node, text = `Historical observations for events ${node.firstSeq} through ${node.lastSeq}; exact claims require original messages.`) =>
  publishSessionMemorySummary(target, node.id, { text, provider: 'deepseek', model: 'configured-model', effort: 'low', usage: { tokens: 25, available: true } });
function finishIndex(target, maxParts = 128) {
  let result;
  for (let round = 0; round < 2000; round++) {
    result = indexSessionMemory(target, { force: true, maxParts });
    if (!result.indexingRemaining) return result;
  }
  assert.fail('Bounded indexing did not make progress.');
}
function summarizeAll(target) {
  for (let round = 0; round < 32; round++) {
    const nodes = pending(target);
    if (!nodes.length) return;
    for (const node of nodes) publish(target, node);
  }
  assert.fail('Summary hierarchy did not converge.');
}

test('sessions in the same directory have independent trees and cross-session node access fails', () => {
  const other = createSession(getProvider('codex'), root, 'another-model', 'Session two');
  visible(session, 8, 'FIRST_SESSION_ONLY'); visible(other, 8, 'SECOND_SESSION_ONLY');
  finishIndex(session); finishIndex(other);
  const first = pending(session)[0], second = pending(other)[0];
  assert.notEqual(first.id, second.id); assert.notEqual(first.generation, second.generation);
  assert.match(sessionMemoryMaterial(session, first.id).inputText, /FIRST_SESSION_ONLY/);
  assert.doesNotMatch(sessionMemoryMaterial(session, first.id).inputText, /SECOND_SESSION_ONLY/);
  for (const id of [second.id, '', '../foreign', {}, null, 'a'.repeat(64)]) {
    assert.throws(() => sessionMemoryMaterial(session, id), /outside this session|replaced/);
    assert.throws(() => expandSessionMemory(session, { id }), /outside this session|replaced/);
    assert.throws(() => publishSessionMemorySummary(session, id, { text: 'Foreign attempt.' }), /outside this session|replaced/);
  }
});

test('alias, provider, model and root conversation mode changes preserve the session tree', () => {
  visible(session); finishIndex(session); summarizeAll(session);
  const before = readSessionMemory(session), generation = before.generation;
  for (const mode of ['delegate', 'debate', 'parallel', 'besties', null]) {
    session.alias = `Renamed ${mode}`; session.provider = 'claude'; session.backend = 'claude'; session.model = `model-${mode}`;
    session.selectedEffort = 'low'; session.mode = mode; saveSession(session);
    assert.equal(readSessionMemory(session).generation, generation);
    assert.deepEqual(readSessionMemory(session).items, before.items);
  }
});

test('only finalized visible conversation events are indexed; running sessions defer without mutation', () => {
  appendEvent(session.id, 'message.user', { text: 'Visible user input.' });
  appendEvent(session.id, 'text', { text: 'Visible assistant output.' });
  appendEvent(session.id, 'question', { id: 'input-question', kind: 'input', question: 'Visible question?' });
  appendEvent(session.id, 'question.answered', { id: 'input-question', answer: 'Visible answer.' });
  appendEvent(session.id, 'debate.result', { message: 'Visible final debate result.' });
  appendEvent(session.id, 'question', { id: 'approval', kind: 'approval', question: 'HIDDEN APPROVAL' });
  appendEvent(session.id, 'question.answered', { id: 'approval', answer: 'HIDDEN APPROVAL ANSWER' });
  appendEvent(session.id, 'question.answered', { id: 'unknown', answer: 'HIDDEN UNMATCHED ANSWER' });
  appendEvent(session.id, 'tool', { text: 'HIDDEN TOOL OUTPUT' });
  appendEvent(session.id, 'backend', { text: 'HIDDEN PRIVATE REASONING' });
  appendEvent(session.id, 'debate.round', { text: 'HIDDEN INTERMEDIATE DEBATE' });
  session.executionState = 'running'; saveSession(session);
  assert.equal(indexSessionMemory(session).deferred, true); assert.equal(sessionMemoryStatus(session).nodes, 0);
  session.executionState = 'idle'; saveSession(session);
  const before = events(session); finishIndex(session);
  const material = pending(session).map(node => sessionMemoryMaterial(session, node.id).inputText).join('\n');
  for (const expected of ['Visible user', 'Visible assistant', 'Visible question', 'Visible answer', 'Visible final debate']) assert.match(material, new RegExp(expected));
  assert.doesNotMatch(material, /HIDDEN/); assert.deepEqual(events(session), before);
});

test('streaming text deltas count as one logical message and byte limits still bound leaves', () => {
  appendEvent(session.id, 'message.user', { text: 'Analyze this.' });
  for (let part = 0; part < 200; part++) appendEvent(session.id, 'text', { text: 'x'.repeat(40), itemId: 'one-streamed-reply' });
  indexSessionMemory(session, { maxParts: 1024 });
  // Ref limits may split a large stream, but each continuation remains one
  // logical assistant message rather than counting every text delta as a turn.
  assert.ok(sessionMemoryStatus(session).leaves <= 1);
  assert.ok(sessionMemoryStatus(session).pendingMessages <= 2);
  finishIndex(session);
  for (const node of pending(session)) assert.ok(node.sourceBytes <= 12000);
  const totalParts = pending(session).flatMap(node => node.refs).length;
  assert.equal(totalParts, 201);
});

test('eight logical messages seal a leaf, while small tails wait until explicit final flush', () => {
  visible(session, 7); indexSessionMemory(session);
  assert.equal(sessionMemoryStatus(session).leaves, 0); assert.equal(sessionMemoryStatus(session).pendingMessages, 7);
  appendEvent(session.id, 'text', { text: 'Eighth response.', itemId: 'answer-7' }); indexSessionMemory(session);
  assert.equal(sessionMemoryStatus(session).leaves, 1); assert.equal(sessionMemoryStatus(session).pendingMessages, 0);
  appendEvent(session.id, 'message.user', { text: 'A short tail.' }); indexSessionMemory(session);
  assert.equal(sessionMemoryStatus(session).leaves, 1); assert.equal(sessionMemoryStatus(session).pendingMessages, 1);
  finishIndex(session); assert.equal(sessionMemoryStatus(session).leaves, 2);
});

test('large Unicode source events advance in bounded codepoint slices and expand with UTF-8-safe byte paging', () => {
  const text = '🦉é漢'.repeat(8000), entry = appendEvent(session.id, 'message.user', { text });
  let previous = -1;
  for (let count = 0; count < 32; count++) {
    const result = indexSessionMemory(session, { maxParts: 1 });
    const meta = getRecord('core.session.memory', session.id), position = meta.cursorOffset || (meta.cursorSeq === entry.seq ? Array.from(text).length : 0);
    assert.ok(position > previous); previous = position;
    if (!result.indexingRemaining) break;
  }
  finishIndex(session, 1);
  const refs = pending(session).flatMap(node => node.refs);
  assert.equal(refs.reduce((sum, ref) => sum + ref.length, 0), Array.from(text).length);
  assert.ok(refs.every(ref => ref.length <= 2048));
  for (const node of pending(session)) {
    assert.ok(node.sourceBytes <= 12000);
    const original = sessionMemoryMaterial(session, node.id).inputText;
    let offset = 0, reconstructed = '';
    for (let pageNumber = 0; pageNumber < 2000; pageNumber++) {
      const page = expandSessionMemory(session, { id: node.id, offset, limit: 37 });
      assert.ok(Buffer.byteLength(page.text) <= 37); assert.ok(page.nextOffset > offset); assert.doesNotMatch(page.text, /�/);
      reconstructed += page.text; offset = page.nextOffset;
      if (!page.hasMore) break;
    }
    assert.equal(reconstructed, original);
  }
});

test('ready summaries form a hierarchy that zooms to child summaries and original message references', () => {
  visible(session, 32); const before = events(session); finishIndex(session); summarizeAll(session);
  const status = sessionMemoryStatus(session); assert.equal(status.leaves, 4); assert.equal(status.nodes, 7); assert.equal(status.ready, 7);
  const top = readSessionMemory(session); assert.equal(top.items.length, 1); assert.equal(top.items[0].level, 2);
  const middle = expandSessionMemory(session, { id: top.items[0].id }); assert.equal(middle.children.length, 2);
  assert.ok(middle.children.every(child => child.provenance === 'generated-history-summary'));
  const leaves = expandSessionMemory(session, { id: middle.children[0].id });
  const originals = expandSessionMemory(session, { id: leaves.children[0].id });
  assert.equal(originals.provenance, 'original-conversation-excerpts'); assert.match(originals.text, /observation 0/);
  assert.ok(originals.sources.every(ref => ref.sourceId.startsWith(session.id + ':'))); assert.deepEqual(events(session), before);
});

test('published derived nodes are immutable and reset invalidates stale-generation writers', () => {
  visible(session); finishIndex(session); const node = pending(session)[0];
  const ready = publish(session, node, 'Stable historical text.');
  assert.deepEqual(publish(session, node, 'Stable historical text.'), ready);
  assert.throws(() => publish(session, node, 'Replacement text.'), { code: 'CONFLICT' });
  const reset = resetSessionMemory(session, { expectedGeneration: node.generation }); assert.notEqual(reset.generation, node.generation);
  assert.throws(() => resetSessionMemory(session, { expectedGeneration: node.generation }), { code: 'CONFLICT' });
  assert.throws(() => publish(session, node), /outside this session|replaced/);
  assert.equal(pending(session).length, 0); assert.equal(readSessionMemory(session).items.length, 0);
  finishIndex(session); assert.notEqual(pending(session)[0].id, node.id);
});

test('source hash changes and node corruption fail closed without modifying original events', () => {
  const entries = visible(session); finishIndex(session); const node = pending(session)[0];
  database().prepare('UPDATE events SET data=? WHERE seq=?').run(JSON.stringify({ text: 'Edited source body.' }), entries[0].seq);
  const modified = events(session);
  assert.throws(() => sessionMemoryMaterial(session, node.id), { code: 'SESSION_MEMORY_INTEGRITY' });
  assert.throws(() => publish(session, node), { code: 'SESSION_MEMORY_INTEGRITY' }); assert.deepEqual(events(session), modified);
  resetSessionMemory(session); finishIndex(session); const fresh = pending(session)[0]; publish(session, fresh);
  const record = getRecord('core.session.memory.node', fresh.id);
  putRecord('core.session.memory.node', fresh.id, { ...record, summary: 'Corrupted text.' });
  assert.throws(() => readSessionMemory(session), { code: 'SESSION_MEMORY_INTEGRITY' });
});

test('private values are redacted only in derived material and summaries cannot smuggle credentials', () => {
  const source = appendEvent(session.id, 'message.user', { text: 'Recorded password=synthetic-private-value for the controlled case.' });
  finishIndex(session); const node = pending(session)[0];
  const material = sessionMemoryMaterial(session, node.id); assert.match(material.inputText, /redacted/); assert.doesNotMatch(material.inputText, /synthetic-private-value/);
  assert.match(events(session).find(row => row.seq === source.seq).data, /synthetic-private-value/);
  assert.throws(() => publish(session, node, 'Reuse password=synthetic-private-value.'), { code: 'SESSION_MEMORY_OUTPUT' });
  assert.throws(() => publish(session, node, '🦉'.repeat(513)), { code: 'SESSION_MEMORY_OUTPUT' });
});

test('whole-message redaction protects credentials across source slices and leaf boundaries', () => {
  const secret = 'sk-fixtureBoundaryCredential123456789'; saveKey('deepseek', secret);
  const text = 'x'.repeat(10238) + secret + 'AFTER-SECRET-FIDELITY' + 'z'.repeat(3000);
  appendEvent(session.id, 'message.user', { text }); const before = events(session);
  finishIndex(session); const nodes = pending(session); assert.ok(nodes.length > 1);
  const material = nodes.map(node => sessionMemoryMaterial(session, node.id).inputText).join('\n');
  assert.doesNotMatch(material, /sk-fixture|fixtureBoundaryCredential|BoundaryCredential123456789/);
  assert.match(material, /redacted/); assert.match(material, /AFTER-SECRET-FIDELITY/);
  for (const node of nodes) assert.equal(expandSessionMemory(session, { id: node.id, limit: 16000 }).text, sessionMemoryMaterial(session, node.id).inputText);
  assert.deepEqual(events(session), before);
});

test('streamed secret halves are joined and redacted before either event reaches models or expansion', () => {
  const opaque = 'opaqueFixturePrivateCredentialABCDEFGH'; saveKey('deepseek', opaque);
  const api = 'sk-unboundFixtureStreamingKey123456789';
  appendEvent(session.id, 'message.user', { text: 'Remember the controlled account result.' });
  appendEvent(session.id, 'text', { text: 'Opaque: ' + opaque.slice(0, 17), itemId: 'first-part' });
  appendEvent(session.id, 'backend', { text: 'Not part of the visible conversation.' });
  appendEvent(session.id, 'text', { text: opaque.slice(17) + '\nAPI: ' + api.slice(0, 2), itemId: 'changed-item-id' });
  appendEvent(session.id, 'text', { text: api.slice(2) + '\nSafe ending.', itemId: 'third-part' });
  const before = events(session); finishIndex(session);
  const material = pending(session).map(node => sessionMemoryMaterial(session, node.id).inputText).join('\n');
  for (const value of [opaque, opaque.slice(0, 17), opaque.slice(17), api, api.slice(2)]) assert.equal(material.includes(value), false);
  assert.match(material, /redacted/); assert.match(material, /Safe ending/); assert.doesNotMatch(material, /Not part of the visible/);
  for (const node of pending(session)) assert.equal(expandSessionMemory(session, { id: node.id, limit: 16000 }).text, sessionMemoryMaterial(session, node.id).inputText);
  assert.deepEqual(events(session), before);
});

test('masking preserves Unicode source positions and the ordinary sanitizer contract', () => {
  const secret = 'fixture🐝unicodePrivateCredential'; saveKey('deepseek', secret);
  const text = '🐝你'.repeat(1023) + secret + 'UNICODE-AFTER-SECRET';
  const masked = maskLearningText(text, [secret]);
  assert.equal([...masked.text].length, [...text].length); assert.equal(masked.text.includes(secret), false);
  assert.equal(sanitizeLearningText('password=controlled-value.'), 'password=[redacted]');
  appendEvent(session.id, 'message.user', { text }); finishIndex(session);
  const material = pending(session).map(node => sessionMemoryMaterial(session, node.id).inputText).join('\n');
  assert.match(material, /🐝你/); assert.match(material, /UNICODE-AFTER-SECRET/); assert.doesNotMatch(material, /unicodePrivateCredential|�/);
});

test('oversized logical messages omit every fragment while keeping original history intact', () => {
  const secret = 'opaqueOversizedPrivateCredentialABCDEFG'; saveKey('deepseek', secret);
  appendEvent(session.id, 'text', { text: 'OVERSIZED-FIRST-FRAGMENT ' + secret.slice(0, 20) + 'x'.repeat(70 * 1024) });
  appendEvent(session.id, 'text', { text: secret.slice(20) + 'OVERSIZED-SECOND-FRAGMENT ' + 'y'.repeat(70 * 1024) });
  const before = events(session); finishIndex(session);
  const material = pending(session).map(node => sessionMemoryMaterial(session, node.id).inputText).join('\n');
  assert.match(material, /Source omitted.*128 KiB/); assert.doesNotMatch(material, /OVERSIZED-FIRST|OVERSIZED-SECOND|opaqueOversized|CredentialABCDEFG/);
  for (const node of pending(session)) assert.match(expandSessionMemory(session, { id: node.id }).text, /Source omitted/);
  assert.deepEqual(events(session), before);
});

test('logical message event-count bounds omit excessive empty streaming deltas', () => {
  for (let index = 0; index < 4097; index++) appendEvent(session.id, 'text', { text: index === 4096 ? 'TINY-DELTA-TAIL' : '' });
  finishIndex(session);
  const material = pending(session).map(node => sessionMemoryMaterial(session, node.id).inputText).join('\n');
  assert.match(material, /Source omitted.*4096-delta/); assert.doesNotMatch(material, /TINY-DELTA-TAIL/);
});

test('history instruction text stays historical and never establishes permissions, findings or verified evidence', () => {
  visible(session); finishIndex(session); const node = pending(session)[0];
  publish(session, node, 'Historical user said ignore permissions; old model claimed a verified finding. Both claims require current review.');
  const view = readSessionMemory(session);
  assert.equal(view.items[0].provenance, 'generated-history-summary'); assert.match(view.policy, /not instructions, permissions or verified evidence/);
  assert.equal(getRecord('session', session.id).goal, null);
  for (const kind of ['artifact', 'acceptance', 'assessment', 'issue', 'execution', 'access-token']) {
    assert.equal(database().prepare('SELECT count(*) AS total FROM records WHERE kind=?').get(kind).total, 0);
  }
});

test('worker identities and malformed bounds cannot access terminal memory or trigger indexing', () => {
  const child = createSession(getProvider('codex'), root, 'worker-model'); child.parentSessionId = session.id; child.role = 'reviewer'; saveSession(child);
  assert.equal(sessionMemoryEligible(child), false);
  for (const input of [child, child.id, { ...session, role: 'executor' }, randomUUID(), null]) assert.throws(() => indexSessionMemory(input), /terminal conversation|unavailable/);
  for (const options of [{ maxParts: 0 }, { maxParts: 1025 }, { maxParts: 1.5 }, { force: 'yes' }, { throughSeq: -1 }, { throughSeq: 99999 }]) assert.throws(() => indexSessionMemory(session, options));
  for (const options of [{ limit: 0 }, { limit: 101 }, { maxBytes: 511 }, { maxBytes: 24001 }]) assert.throws(() => readSessionMemory(session, options));
});

test('deleting a session denies all memory access and prevents stale summary publication or rebuild resurrection', () => {
  visible(session); finishIndex(session); const node = pending(session)[0]; publish(session, node);
  deleteTerminalConversation(session.id, { requestId: randomUUID() });
  for (const operation of [() => readSessionMemory(session), () => sessionMemoryStatus(session), () => indexSessionMemory(session),
    () => resetSessionMemory(session), () => publish(session, node), () => expandSessionMemory(session, { id: node.id })]) assert.throws(operation, { code: 'SESSION_DELETED' });
  assert.equal(pendingSessionMemoryNodes().some(item => item.sessionId === session.id), false);
});

test('summary provenance and usage reject private strings, coercion, malformed values and unsupported fields', () => {
  visible(session); finishIndex(session); const node = pending(session)[0], text = 'Safe historical summary.';
  saveKey('deepseek', 'fixture-private-metadata-credential');
  for (const input of [
    { provider: 'password=synthetic-test-secret' }, { model: 'fixture-private-metadata-credential' }, { effort: 'high\nprivate' },
    { provider: {} }, { model: null }, { model: 'x'.repeat(201) }, { effort: 3 }, { extra: 'unsupported' },
    { usage: { tokens: 'password=synthetic-secret', available: false } }, { usage: { tokens: -1, available: true } },
    { usage: { tokens: 1.5, available: true } }, { usage: { tokens: 1, available: 'yes' } },
    { usage: { tokens: null, available: true } }, { usage: { tokens: 1, available: true, extra: 'unsupported' } },
  ]) assert.throws(() => publishSessionMemorySummary(session, node.id, { text, ...input }), { code: 'SESSION_MEMORY_OUTPUT' });
  assert.equal(pending(session).length, 1);
  const saved = publishSessionMemorySummary(session, node.id, { text, model: 'vendor/model:release', usage: { tokens: null, available: false } });
  assert.deepEqual(saved.usage, { tokens: null, available: false }); assert.equal(saved.summarizer.model, 'vendor/model:release');
});

test('memory tool calls remain scoped to the invoking root session and cannot override identity or execute compaction', async () => {
  visible(session); finishIndex(session); summarizeAll(session);
  const foreign = createSession(getProvider('codex'), root, 'foreign-model'); visible(foreign); finishIndex(foreign);
  const foreignNode = pending(foreign)[0], tools = taskTools(session), host = new ToolHost(session, {});
  assert.ok(tools.some(tool => tool.name === 'read_session_memory')); assert.ok(tools.some(tool => tool.name === 'expand_session_memory'));
  const before = events(session), map = await host.call('read_session_memory', { maxBytes: 12000, limit: 8 });
  assert.equal(map.sessionId, session.id);
  await assert.rejects(host.call('read_session_memory', { sessionId: foreign.id }), /Invalid session memory fields/);
  await assert.rejects(host.call('expand_session_memory', { id: foreignNode.id }), /outside this session|replaced/);
  await assert.rejects(host.call('expand_session_memory', { id: map.items[0].id, force: true }), /Invalid session memory fields/);
  for (const role of ['executor', 'reviewer', 'peer', 'learning-review']) {
    const worker = { ...session, parentSessionId: session.id, role };
    try { assert.ok(taskTools(worker).every(tool => !['read_session_memory', 'expand_session_memory'].includes(tool.name))); }
    catch (error) { assert.equal(error.code, 'FORBIDDEN'); }
    await assert.rejects(new ToolHost(worker, {}).call('read_session_memory', {}), /not authorized|Persistent Agents/);
  }
  assert.deepEqual(events(session), before);
  assert.equal(database().prepare("SELECT count(*) AS total FROM records WHERE kind='core.session.compactor.job'").get().total, 0);
});
