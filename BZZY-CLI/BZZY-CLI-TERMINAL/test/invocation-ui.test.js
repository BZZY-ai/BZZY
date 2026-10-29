import test from 'node:test';
import assert from 'node:assert/strict';
import { recordInvocationEvent, reconcileInvocationEntries, invocationEntryLayout } from '../src/invocation-ui.js';
import { clean, cellWidth } from '../src/terminal-format.js';
import { createTerminalTheme } from '../src/terminal-theme.js';
import { ActorProjection } from '../src/actor-ui.js';

const sessionId = '11111111-2222-3333-4444-555555555555', other = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const receipt = (overrides = {}) => ({ id: 'receipt-one', kind: 'skill', sessionId, rootSessionId: sessionId, name: 'evidence-first', scope: 'project', seq: 1, ...overrides });
const assignment = (id = 'assignment-one', overrides = {}) => ({ id, parentSessionId: sessionId, currentRound: 1,
  subagentDefinition: { name: 'http-analyzer' }, selection: { provider: 'same-provider', model: 'same-model' }, seq: 2, ...overrides });
const record = (entries, type, data) => recordInvocationEvent(entries, type, data, { sessionId });
const snapshot = (agents = [], extra = {}) => ({ session: { id: sessionId }, invocations: { version: 1, agents, truncated: false, ...extra } });
const agent = (overrides = {}) => ({ id: 'assignment-one', parentSessionId: sessionId, name: 'http-analyzer', specialist: true, round: 1, state: 'running', closure: 'open', ...overrides });

test('actual skill receipts create one loaded card, including validated worker-to-root mirrors', () => {
  const entries = [];
  assert.equal(record(entries, 'core.usage', receipt()).changed, true);
  assert.equal(record(entries, 'core.usage', receipt()).changed, false);
  assert.equal(entries.length, 1); assert.equal(entries[0].state, 'loaded');
  assert.match(entries[0].text, /^Skill · evidence-first · Loaded · project · Main$/);
  assert.equal(record(entries, 'core.usage', receipt({ id: 'worker-receipt', sessionId: other })).changed, true);
  assert.equal(entries[1].actorSessionId, other);
  assert.equal(record(entries, 'core.usage', receipt({ id: 'foreign-receipt', sessionId: other, rootSessionId: other })).handled, false);
  assert.equal(record(entries, 'core.usage', receipt({ id: 'foreign-stream', eventSessionId: other })).handled, false);
  assert.equal(record(entries, 'core.usage', receipt({ id: 'discovery', kind: 'agent' })).handled, false);
  assert.equal(record(entries, 'tool', { name: 'read_skill', detail: 'not a successful load receipt' }).handled, false);
  assert.equal(entries.length, 2);
});

test('one named-agent card updates through bounded followups and final supervisor review', () => {
  const entries = [];
  const created = record(entries, 'assignment.created', assignment()); assert.equal(created.changed, true);
  assert.match(created.entry.text, /^Agent · http-analyzer · Starting$/);
  record(entries, 'assignment.started', { id: 'assignment-one', round: 1, seq: 3 });
  assert.equal(entries[0].state, 'running');
  record(entries, 'assignment.needs_context', { assignmentId: 'assignment-one', round: 1, seq: 4, questions: ['PRIVATE_QUESTION'] });
  record(entries, 'assignment.finished', { id: 'assignment-one', round: 1, state: 'awaiting_review', seq: 5 });
  assert.equal(entries[0].state, 'needs_context', 'A finish event does not hide a pending context request.');
  record(entries, 'assignment.context_answered', { assignmentId: 'assignment-one', round: 1, seq: 6 });
  assert.equal(entries[0].state, 'awaiting_followup');
  record(entries, 'assignment.followup', { id: 'assignment-one', round: 2, seq: 7, objective: 'PRIVATE_OBJECTIVE' });
  record(entries, 'assignment.started', { id: 'assignment-one', round: 2, seq: 8 });
  record(entries, 'assignment.finished', { id: 'assignment-one', round: 2, state: 'awaiting_review', seq: 9, report: { summary: 'PRIVATE_REPORT' } });
  assert.equal(entries[0].state, 'awaiting_review'); assert.match(entries[0].text, /Awaiting review · round 2/);
  record(entries, 'assignment.reviewed', { assignmentId: 'assignment-one', round: 2, outcome: 'accepted', seq: 10, rationale: 'PRIVATE_RATIONALE' });
  assert.equal(entries.length, 1); assert.match(entries[0].text, /Accepted · round 2/);
  assert.doesNotMatch(JSON.stringify(entries), /PRIVATE_/);
});

test('generic workers and another terminal cannot create or change named-agent cards', () => {
  const entries = [];
  assert.equal(record(entries, 'assignment.created', assignment('generic', { subagentDefinition: undefined })).handled, false);
  assert.equal(record(entries, 'assignment.created', assignment('foreign', { parentSessionId: other })).handled, false);
  assert.equal(record(entries, 'assignment.finished', { id: 'unseen', state: 'failed' }).handled, false);
  record(entries, 'assignment.created', assignment());
  assert.equal(record(entries, 'assignment.failed', { id: 'assignment-one', parentSessionId: other, seq: 8 }).handled, false);
  assert.equal(entries.length, 1); assert.equal(entries[0].state, 'starting');
  assert.deepEqual(reconcileInvocationEntries(entries, { ...snapshot([agent({ state: 'failed' })]), session: { id: other } }, { sessionId }), []);
  assert.equal(entries[0].state, 'starting');
});

test('replayed and old-round events cannot reopen or duplicate a settled invocation', () => {
  const entries = [];
  record(entries, 'assignment.created', assignment());
  record(entries, 'assignment.followup', { id: 'assignment-one', round: 2, seq: 4 });
  record(entries, 'assignment.finished', { id: 'assignment-one', round: 2, state: 'awaiting_review', seq: 6 });
  record(entries, 'assignment.started', { id: 'assignment-one', round: 1, seq: 20 });
  record(entries, 'assignment.started', { id: 'assignment-one', round: 2, seq: 5 });
  assert.equal(entries[0].state, 'awaiting_review'); assert.equal(entries[0].round, 2);
  assert.equal(reconcileInvocationEntries(entries, snapshot([agent({ round: 2, closure: 'accepted' })]), { sessionId }).length, 1);
  record(entries, 'assignment.created', assignment());
  record(entries, 'assignment.finished', { id: 'assignment-one', round: 2, state: 'awaiting_review', seq: 30 });
  record(entries, 'assignment.followup', { id: 'assignment-one', round: 3, seq: 40 });
  assert.equal(entries.length, 1); assert.equal(entries[0].state, 'accepted');
  assert.equal(reconcileInvocationEntries(entries, snapshot([agent({ round: 2, state: 'running' })]), { sessionId }).length, 0);
  assert.equal(reconcileInvocationEntries(entries, snapshot([agent({ round: 1 })]), { sessionId }).length, 0);
  assert.equal(entries[0].state, 'accepted');
});

test('snapshot reconciliation clears missing active states without inventing successful completion or unseen cards', () => {
  const entries = [];
  record(entries, 'assignment.created', assignment());
  record(entries, 'assignment.started', { id: 'assignment-one', round: 1, seq: 3 });
  let changed = reconcileInvocationEntries(entries, snapshot([], { truncated: true }), { sessionId });
  assert.equal(changed.length, 1); assert.equal(entries[0].state, 'unavailable');
  record(entries, 'assignment.started', { id: 'assignment-one', round: 1, seq: 3 });
  assert.equal(entries[0].state, 'unavailable');
  changed = reconcileInvocationEntries(entries, snapshot([agent({ state: 'interrupted' }), agent({ id: 'never-seen' })]), { sessionId });
  assert.equal(changed.length, 1); assert.equal(entries.length, 1); assert.equal(entries[0].state, 'interrupted');
  assert.deepEqual(reconcileInvocationEntries(entries, { session: { id: sessionId } }, { sessionId }), []);
});

test('fresh host liveness can recover an unavailable card while cached active rows cannot reopen stopped work', () => {
  const entries = []; record(entries, 'assignment.created', assignment());
  reconcileInvocationEntries(entries, snapshot([]), { sessionId }); assert.equal(entries[0].state, 'unavailable');
  reconcileInvocationEntries(entries, snapshot([agent()]), { sessionId }); assert.equal(entries[0].state, 'running');
  reconcileInvocationEntries(entries, snapshot([agent({ state: 'unknown' })]), { sessionId }); assert.equal(entries[0].state, 'unknown');
  reconcileInvocationEntries(entries, snapshot([agent()]), { sessionId }); assert.equal(entries[0].state, 'running');
  record(entries, 'assignment.finished', { id: 'assignment-one', round: 1, state: 'awaiting_review', seq: 5 });
  assert.equal(reconcileInvocationEntries(entries, snapshot([agent()]), { sessionId }).length, 0);
  assert.equal(entries[0].state, 'awaiting_review');
});

test('snapshot status describes stopped workers and supervisor acceptance separately', () => {
  for (const state of ['paused', 'interrupted', 'cancelled', 'failed', 'awaiting_review', 'needs_context', 'timed_out', 'budget_limited', 'unknown', 'cancelling']) {
    const entries = []; record(entries, 'assignment.created', assignment());
    reconcileInvocationEntries(entries, snapshot([agent({ state })]), { sessionId });
    assert.equal(entries[0].state, state); assert.doesNotMatch(entries[0].text, /goal achieved|validated|complete/i);
  }
});

test('timeout, budget and unknown finish events have explicit outcomes instead of an assumed review result', () => {
  for (const [state, text] of [['timed_out', 'Timed out'], ['budget_limited', 'Budget reached'], ['future-unrecognized', 'Unknown']]) {
    const entries = []; record(entries, 'assignment.created', assignment());
    record(entries, 'assignment.finished', { id: 'assignment-one', round: 1, state, seq: 4 });
    assert.ok(entries[0].text.includes(text)); assert.doesNotMatch(entries[0].text, /review pending|Accepted/);
  }
  const entries = []; record(entries, 'assignment.created', assignment());
  reconcileInvocationEntries(entries, snapshot([agent({ state: 'cancelling' })]), { sessionId });
  assert.match(entries[0].text, /Stopping/);
  record(entries, 'assignment.started', { id: 'assignment-one', round: 1, seq: 4 });
  assert.equal(entries[0].state, 'cancelling');
  reconcileInvocationEntries(entries, snapshot([]), { sessionId }); assert.equal(entries[0].state, 'unavailable');
});

test('compact invocation layouts preserve Unicode geometry, sanitize controls and separate same-model agent colors', () => {
  const entries = [];
  record(entries, 'assignment.created', assignment('one', { subagentDefinition: { name: '\x1b[31m响应-analyst🙂\nPRIVATE_SECOND_LINE' } }));
  record(entries, 'assignment.created', assignment('two', { subagentDefinition: { name: 'other-analyst' } }));
  record(entries, 'core.usage', receipt({ id: 'unicode', name: '响应-review🙂' }));
  const theme = createTerminalTheme({ isTTY: true }, { FORCE_COLOR: '3' });
  assert.equal(invocationEntryLayout(entries[0], 80, theme).lines[0], invocationEntryLayout({ ...entries[0], agentSlot: 1 }, 80, theme).lines[0], 'actor colors remain stable when list order changes');
  for (const width of [1, 8, 20, 40, 80, 140]) for (const entry of entries) {
    const { lines } = invocationEntryLayout(entry, width, theme);
    assert.ok(lines.every(line => cellWidth(line) <= width), `${width}: ${lines.map(clean).join(' ')}`);
    assert.ok(lines.every(line => !clean(line).includes('\n')));
  }
  assert.doesNotMatch(entries[0].text, /\x1b|\n/);
  const plain = createTerminalTheme({ isTTY: true }, { NO_COLOR: '1' });
  assert.match(invocationEntryLayout(entries[2], 80, plain).lines.map(clean).join(' '), /Skill.*Loaded/);
});

test('duplicate named workers and generic same-role actors retain distinct display identities', () => {
  const actors = new ActorProjection();
  for (const actorSessionId of ['worker-one', 'worker-two']) actors.event('worker.tool', {
    workerSessionId: actorSessionId, actorRole: 'subagent', actorName: 'http-analyst',
  }, [], { sessionId });
  assert.match(actors.for('worker-one', sessionId).label, /Agent · http-analyst.*worker-o/);
  assert.match(actors.for('worker-two', sessionId).label, /Agent · http-analyst.*worker-t/);
  assert.notEqual(actors.for('worker-one', sessionId).label, actors.for('worker-two', sessionId).label);
  actors.event('activity', { actorSessionId: 'reviewer-one', actorRole: 'reviewer', actorName: 'Reviewer' }, [], { sessionId });
  assert.match(actors.for('reviewer-one', sessionId).label, /Reviewer · Reviewer · reviewer/);
});

test('partial handoff presentation cannot hide a final review or leak previous-round report state into a followup', () => {
  const progress = { stopReason: 'allocation_checkpoint', parentState: 'running',
    budget: { tokensUsed: 18000, tokenLimit: 20000, elapsedSeconds: 250, runtimeLimitSeconds: 300, complete: true },
    result: { saved: true, reportArtifactId: 'previous-report' } };
  for (const outcome of ['accepted', 'rejected', 'inconclusive']) {
    const entries = []; record(entries, 'assignment.created', assignment());
    reconcileInvocationEntries(entries, snapshot([agent({ state: 'awaiting_review', ...progress })]), { sessionId });
    assert.match(entries[0].text, /Partial handoff/);
    record(entries, 'assignment.reviewed', { assignmentId: 'assignment-one', round: 1, outcome, seq: 4 });
    assert.ok(entries[0].text.includes(outcome[0].toUpperCase() + outcome.slice(1)));
    assert.doesNotMatch(entries[0].text, /Partial handoff/);
  }
  const entries = []; record(entries, 'assignment.created', assignment());
  reconcileInvocationEntries(entries, snapshot([agent({ state: 'awaiting_review', ...progress })]), { sessionId });
  record(entries, 'assignment.followup', { assignmentId: 'assignment-one', round: 2, seq: 5 });
  assert.match(entries[0].text, /Starting.*round 2/); assert.doesNotMatch(entries[0].text, /Partial handoff/);
  const text = invocationEntryLayout(entries[0], 100, createTerminalTheme({ isTTY: false }, {})).lines.map(clean).join('\n');
  assert.doesNotMatch(text, /Report saved|previous-report|18,000|Runtime 250|Main state/);
});
