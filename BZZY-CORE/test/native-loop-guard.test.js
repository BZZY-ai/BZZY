import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSession, saveSession } from '../src/engine/store.js';
import { BUILTINS } from '../src/engine/providers.js';
import { newGoal } from '../src/engine/goals.js';
import { putRecord, events } from '../src/engine/database.js';
import { nativeInspectionCommand, observeNativeGoalProgress, recordNativeCompaction, recordNativeCompactionStall } from '../src/engine/native-context.js';

let directory, previousHome, session, runId, threadId, startedAt;
test.beforeEach(() => {
  previousHome = process.env.BZZY_HOME;
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-native-loop-')));
  process.env.BZZY_HOME = path.join(directory, 'private');
  const cwd = path.join(directory, 'project'); fs.mkdirSync(cwd);
  session = createSession(BUILTINS.codex, cwd, 'offline-loop-fixture');
  session.goal = newGoal('Inspect only the synthetic local fixture and retain unresolved evidence.');
  session.executionState = 'running'; saveSession(session);
  runId = 'fixture-run'; threadId = 'fixture-thread'; startedAt = Date.now();
  putRecord('run', session.id, { id: runId, sessionId: session.id, goalId: session.goal.id, goalMode: true, state: 'running' });
});
test.afterEach(() => {
  if (previousHome === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previousHome;
  fs.rmSync(directory, { recursive: true, force: true });
});
const observe = (input = {}) => observeNativeGoalProgress(session, { runId, threadId, at: startedAt, ...input });
function compact(index, at) {
  const signal = { threadId, turnId: 'fixture-turn', itemId: 'compaction-' + index };
  recordNativeCompaction(session, { ...signal, phase: 'started', at: at - 1000 });
  recordNativeCompaction(session, { ...signal, phase: 'completed', at });
  return observe({ kind: 'compaction', at });
}
const read = (input = {}, result = {}, at = startedAt) => observe({ kind: 'core-tool', name: 'read_artifact',
  input: { id: 'retained-report', offset: 0, ...input }, result: { sha256: 'a'.repeat(64), nextOffset: 2048, ...result }, at });

test('a prolonged compaction and repeated-inspection loop requests one pause despite new prose, call IDs and activity records', () => {
  const originalGoal = structuredClone(session.goal);
  observe(); read();
  let pauseCount = 0, firstPause;
  for (let index = 1; index <= 61; index++) {
    const at = startedAt + index * 45000;
    compact(index, at);
    for (const name of ['get_task_state', 'assignment_status', 'activity', 'lookup_resolutions']) {
      const input = { id: name === 'assignment_status' ? 'same-exhausted-worker' : undefined,
        callId: 'new-call-' + index, summary: 'Another synthetic plan ' + index, updatedAt: new Date(at).toISOString() };
      observe({ kind: 'core-tool', name, input, result: { status: 'unchanged', tokens: index * 100, updatedAt: input.updatedAt }, at });
    }
    read({ offset: 0, limit: index % 2 ? 128 : 512 }, { nextOffset: index % 2 ? 128 : 512 }, at);
    observe({ kind: 'native-work', name: 'shell', input: { command: "bash -lc 'pwd; head -n 80 .bzzy/NOTES.md'" }, at });
    observe({ kind: 'commentary', input: { text: 'A different promise to close the same investigation ' + index }, at });
    if (recordNativeCompactionStall(session, { runId, threadId, at })) { pauseCount++; firstPause ??= index; }
  }
  assert.equal(pauseCount, 1); assert.ok(firstPause < 20, 'The safeguard acts well before a 61-compaction loop');
  assert.equal(session.nativeContext.loopGuard.reason, 'context_no_progress');
  assert.deepEqual(session.goal, originalGoal, 'A safeguard request does not claim completion or mutate the goal itself');
  const receipts = events(session.id, 0, 1000).filter(row => row.type === 'diagnostic.context' && row.data.method === 'native-progress-guard');
  assert.equal(receipts.length, 1); assert.equal(receipts[0].data.outcome, 'pause-requested');
  assert.doesNotMatch(JSON.stringify(receipts), /Another synthetic plan|new-call-|NOTES\.md/);
});

test('replayed compaction receipts and a short inspection burst cannot manufacture a sustained stall', () => {
  observe(); const at = startedAt + 1000;
  compact('single', at);
  for (let index = 0; index < 100; index++) {
    recordNativeCompaction(session, { threadId, turnId: 'fixture-turn', itemId: 'compaction-single', phase: 'completed', at });
    observe({ kind: 'compaction', at });
    observe({ kind: 'core-tool', name: 'get_task_state', at });
  }
  assert.equal(session.nativeContext.loopGuard.compactions.length, 1);
  assert.equal(recordNativeCompactionStall(session, { runId, threadId, at }), false);
  assert.equal(session.goal.status, 'active');
});

test('a long coordination-only read loop is distinct from compaction pressure and still needs a sustained observation window', () => {
  observe();
  for (let index = 0; index < 100; index++) observe({ kind: 'core-tool', name: 'get_task_state', at: startedAt + 1000 });
  assert.equal(recordNativeCompactionStall(session, { runId, threadId, at: startedAt + 1000 }), false);
  for (let index = 1; index <= 40; index++) observe({ kind: 'core-tool', name: 'get_task_state', at: startedAt + index * 10000 });
  assert.equal(session.nativeContext.loopGuard.compactions.length, 0);
  assert.equal(recordNativeCompactionStall(session, { runId, threadId, at: startedAt + 400000 }), true);
  const receipt = events(session.id, 0, 1000).find(row => row.data.method === 'native-progress-guard');
  assert.equal(receipt.data.trigger, 'coordination-read-loop');
});

test('source byte coverage counts new bytes, not changed limits, overlapping pages or failed inspections', () => {
  assert.equal(read({ offset: 100 }, { nextOffset: 200 }).meaningful, true);
  assert.equal(read({ offset: 110, limit: 10 }, { nextOffset: 120 }).meaningful, false);
  assert.equal(read({ offset: 100, limit: 100 }, { nextOffset: 200 }).meaningful, false);
  assert.equal(read({ offset: 50 }, { nextOffset: 150 }).meaningful, true);
  assert.equal(read({ offset: 160 }, { nextOffset: 250 }).meaningful, true);
  assert.equal(read({ offset: 50, limit: 200 }, { nextOffset: 250 }).meaningful, false, 'Merged coverage spans the whole inspected range');
  assert.equal(read({ offset: 0 }, { nextOffset: 50 }).meaningful, true);
  assert.equal(observe({ kind: 'core-tool', name: 'read_artifact', input: { id: 'retained-report', offset: 250 },
    result: { sha256: 'a'.repeat(64), nextOffset: 300 }, failed: true }).meaningful, false);
  assert.equal(read({ offset: 250 }, { nextOffset: 300 }).meaningful, true, 'A failed read did not consume future coverage');
  assert.equal(read({ offset: 0 }, { sha256: 'b'.repeat(64), nextOffset: 300 }).meaningful, true, 'Changed source bytes are a new observation');
});

test('a final UTF-8 skill or knowledge page reports new bytes even when nextOffset is null', () => {
  const inspect = (offset, text, nextOffset) => observe({ kind: 'core-tool', name: 'read_skill',
    input: { name: 'synthetic-method', file: 'SKILL.md', offset },
    result: { name: 'synthetic-method', file: 'SKILL.md', sha256: 'c'.repeat(64), text, nextOffset } });
  assert.equal(inspect(0, 'éé', 4).meaningful, true);
  assert.equal(inspect(4, '🛰️', null).meaningful, true, 'The last page has no next cursor but contains new UTF-8 bytes');
  assert.equal(inspect(4, '🛰️', null).meaningful, false);
  assert.equal(inspect(0, 'éé🛰️', null).meaningful, false, 'A complete reread covers the same byte ranges');
  const knowledge = { kind: 'core-tool', name: 'read_knowledge_source', input: { sourceId: 'synthetic-note', offset: 0 },
    result: { sourceId: 'synthetic-note', sha256: 'd'.repeat(64), text: 'A complete short local source.', nextOffset: null } };
  assert.equal(observe(knowledge).meaningful, true); assert.equal(observe(knowledge).meaningful, false);
});

test('novel source inspection, actual edits and successful reviews renew the progress window while repeated definitions and failed work do not', () => {
  observe();
  for (let index = 1; index <= 30; index++) {
    const at = startedAt + index * 30000;
    compact(index, at);
    for (let count = 0; count < 4; count++) observe({ kind: 'core-tool', name: 'get_task_state', at });
    const novel = observe({ kind: 'native-work', name: 'shell', input: { command: 'cat src/fixture-' + index + '.js' }, at });
    assert.equal(novel.meaningful, true);
    assert.equal(recordNativeCompactionStall(session, { runId, threadId, at }), false);
  }
  assert.equal(observe({ kind: 'native-work', name: 'shell', input: { command: "sed -n '1,60p' src/fixture-30.js" }, at: startedAt + 901000 }).meaningful, false);
  assert.equal(observe({ kind: 'native-work', name: 'shell', input: { command: 'python3 inspect_fixture.py' }, failed: true, at: startedAt + 901100 }).meaningful, false);
  const definition = { name: 'read_skill', input: { name: 'local-method', file: 'SKILL.md', offset: 0 }, result: { sha256: 'c'.repeat(64), nextOffset: 100 } };
  assert.equal(observe({ kind: 'core-tool', ...definition, at: startedAt + 901200 }).meaningful, true);
  assert.equal(observe({ kind: 'core-tool', ...definition, result: { ...definition.result, nextOffset: 40 }, at: startedAt + 901300 }).meaningful, false);
  assert.equal(observe({ kind: 'core-tool', name: 'review_assignment', failed: true, at: startedAt + 901400 }).meaningful, false);
  assert.equal(observe({ kind: 'core-tool', name: 'review_assignment', result: { outcome: 'inconclusive' }, at: startedAt + 902000 }).meaningful, true);
  assert.equal(observe({ kind: 'core-tool', name: 'close_work_unit', result: { state: 'closed', outcome: 'blocked' }, at: startedAt + 903000 }).meaningful, true);
  assert.equal(observe({ kind: 'native-work', name: 'edit', input: { command: undefined }, at: startedAt + 904000 }).meaningful, true);
});

test('native line pages retain novel audit reading while overlapping ranges and multiple-file rereads do not fabricate progress', () => {
  const inspect = command => observe({ kind: 'native-work', name: 'shell', input: { command } }).meaningful;
  assert.equal(inspect("sed -n '1,100p' src/large-fixture.js"), true);
  assert.equal(inspect("sed -n '51,80p' src/large-fixture.js"), false);
  assert.equal(inspect("sed -n '101,200p' src/large-fixture.js"), true);
  assert.equal(inspect("sed -n '150,250p' src/large-fixture.js"), true);
  assert.equal(inspect("sed -n '1,250p' src/large-fixture.js"), false);
  assert.equal(inspect('cat src/fixed-trailer.txt'), true);
  assert.equal(inspect('cat src/new-fixture.js src/fixed-trailer.txt'), true, 'Each explicitly named cat source can add new inspection');
  assert.equal(inspect('cat src/new-fixture.js src/fixed-trailer.txt'), false);
  assert.equal(inspect('cd package-one && cat README.md'), true);
  assert.equal(inspect('cd package-two && cat README.md'), true, 'The same relative file in another explicit cwd is a different source');
  assert.equal(inspect('cd package-two && cat README.md'), false);
  assert.equal(inspect("bash -lc 'cd package-three && cat README.md'"), true);
  assert.equal(inspect("/bin/bash -lc 'cd package-four && cat README.md'"), true, 'Shell wrappers must preserve explicit cwd identity');
  assert.equal(inspect('cd package-four && cat README.md'), false, 'Wrapping the same source cannot manufacture a new inspection');
});

test('worker receipt changes renew progress, while fresh status bodies and token counters do not', () => {
  observe();
  assert.equal(observe({ kind: 'worker-state', fingerprint: 'same-owned-round' }).meaningful, false, 'The initial inventory is a baseline');
  for (let index = 1; index <= 6; index++) {
    const at = startedAt + index * 30000;
    compact(index, at);
    for (let count = 0; count < 4; count++) observe({ kind: 'core-tool', name: 'assignment_status',
      input: { id: 'worker-fixture' }, result: { state: 'running', tokens: index * 100 + count, updatedAt: new Date(at).toISOString() }, at });
    assert.equal(observe({ kind: 'worker-state', fingerprint: 'same-owned-round', at }).meaningful, false);
  }
  assert.equal(observe({ kind: 'check', at: startedAt + 180000 }).shouldPause, true);
  const completed = observe({ kind: 'worker-state', fingerprint: 'new-durable-report-receipt', at: startedAt + 181000 });
  assert.equal(completed.meaningful, true); assert.equal(completed.shouldPause, false);
  assert.equal(completed.state.compactions.length, 0); assert.equal(completed.state.repeatedReads.length, 0);
  assert.equal(observe({ kind: 'worker-state', fingerprint: 'new-durable-report-receipt', at: startedAt + 182000 }).meaningful, false);
});

test('an explicitly different native thread starts an independent observation window', () => {
  observe();
  for (let index = 1; index <= 6; index++) {
    const at = startedAt + index * 30000;
    compact(index, at);
    for (let count = 0; count < 4; count++) observe({ kind: 'core-tool', name: 'get_task_state', at });
  }
  assert.equal(observe({ kind: 'check', at: startedAt + 180000 }).shouldPause, true);
  const prior = session.nativeContext.loopGuard;
  const fresh = observe({ threadId: 'a-new-native-thread', at: startedAt + 181000 });
  assert.notEqual(fresh.state, prior); assert.equal(fresh.noProgressMs, 0);
  assert.equal(fresh.state.compactions.length, 0); assert.equal(fresh.shouldPause, false);
});

test('the guard excludes unrelated runs, ordinary chat, workers, inactive goals and deleted sessions; a fresh run gets a fresh window', () => {
  observe(); const state = session.nativeContext.loopGuard;
  assert.equal(observe({ runId: 'other-run' }), null); assert.equal(observe({ threadId: null }), null);
  for (const fields of [{ role: 'executor' }, { parentSessionId: 'parent' }, { agentId: 'agent' }, { purpose: 'document' }]) {
    const copy = { ...session, ...fields };
    assert.equal(observeNativeGoalProgress(copy, { runId, threadId, kind: 'check', at: startedAt }), null);
  }
  const original = session.goal;
  session.goal = { ...original, status: 'paused' }; assert.equal(observe(), null);
  session.goal = { ...original, id: 'different-goal' }; assert.equal(observe(), null); session.goal = original;
  putRecord('run', session.id, { id: runId, goalId: original.id, goalMode: false, state: 'running' }); assert.equal(observe(), null);
  putRecord('run', session.id, { id: runId, goalId: original.id, goalMode: true, state: 'paused' }); assert.equal(observe(), null);
  runId = 'fresh-run'; putRecord('run', session.id, { id: runId, goalId: original.id, goalMode: true, state: 'running' });
  const fresh = observe({ at: startedAt + 600000 }); assert.notEqual(fresh.state, state);
  assert.equal(fresh.state.runId, 'fresh-run'); assert.equal(fresh.noProgressMs, 0); assert.equal(fresh.shouldPause, false);
  putRecord('session-deletion', session.id, { id: session.id }); assert.equal(observe(), null);
});

test('inspection recognition is conservative for mutations, helper programs and shell expansion', () => {
  for (const command of ['cat src/a.js', "sed -n '1,80p' src/a.js", "bash -lc 'pwd; ls -la; head -n 40 .bzzy/NOTES.md; rg marker src'", 'find src -type f | sort | head -n 5'])
    assert.equal(nativeInspectionCommand(command), true, command);
  for (const command of ['find . -delete', 'find . -exec touch {} \\;', 'find . -fprint saved-list.txt', 'sort -o saved.txt input.txt',
    "sed -i 's/old/new/' src/a.js", "sed '1w saved.txt' src/a.js", 'rg --pre custom-helper marker src', 'cat input.txt > output.txt',
    'python3 inspect_fixture.py', 'cat $(which fixture)', 'cat `which fixture`']) assert.equal(nativeInspectionCommand(command), false, command);
});

test('inspection memory is bounded without retaining source paths, task prose or evidence bodies', () => {
  observe();
  for (let index = 0; index < 400; index++) read({ id: 'synthetic-private-needle-' + index }, { nextOffset: 10 }, startedAt + index);
  const state = session.nativeContext.loopGuard;
  assert.ok(Object.keys(state.readCoverage).length <= 128); assert.ok(state.fingerprints.length <= 128);
  assert.ok(state.compactions.length <= 64); assert.ok(state.repeatedReads.length <= 128);
  assert.doesNotMatch(JSON.stringify(state), /synthetic-private-needle/);
});

test('hitting native source tracking capacity defers uncertain inspection without exempting known repeated sources', () => {
  observe();
  for (let index = 0; index < 128; index++) observe({ kind: 'native-work', name: 'shell', input: { command: 'cat src/fixture-' + index + '.js' } });
  for (let index = 1; index <= 12; index++) {
    const at = startedAt + index * 30000;
    compact(index, at);
    for (let count = 0; count < 4; count++) observe({ kind: 'core-tool', name: 'get_task_state', at });
    observe({ kind: 'native-work', name: 'shell', input: { command: index <= 6 ? 'cat src/untracked-fixture-' + index + '.js' : 'cat src/fixture-0.js' }, at });
    if (index <= 6) assert.equal(recordNativeCompactionStall(session, { runId, threadId, at }), false, 'Untracked source identity is uncertainty, not proof of repetition');
  }
  assert.equal(session.nativeContext.loopGuard.fingerprints.length, 128);
  assert.equal(recordNativeCompactionStall(session, { runId, threadId, at: startedAt + 360000 }), true, 'Known repeated sources still permit a later sustained-loop decision');
});
