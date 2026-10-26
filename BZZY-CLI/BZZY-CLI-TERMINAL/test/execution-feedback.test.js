import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { ExecutionFeedback } from '../src/execution-feedback.js';
import { UI } from '../src/ui.js';
import { clean, cellWidth } from '../src/terminal-format.js';

function fixture() {
  let instant = Date.parse('2026-10-26T00:00:00Z');
  const feedback = new ExecutionFeedback({ clock: () => instant });
  const snapshot = (changes = {}) => ({ session: { id: 'chat', executionState: 'running' },
    execution: { id: 'execution', state: 'running', startedAt: '2026-10-26T00:00:00Z' },
    observation: { executionId: 'execution', observedAt: new Date(instant).toISOString(), runnerAlive: true }, ...changes });
  feedback.update(snapshot());
  return { feedback, snapshot, advance(ms) { instant += ms; }, event(type, data = {}) { feedback.event(type, { ...data, occurredAt: new Date(instant).toISOString() }); } };
}

test('action timers and last output change independently from snapshot polls and process observations', () => {
  const f = fixture();
  f.event('backend', { method: 'item/started', params: { item: { id: 'command', type: 'commandExecution', command: 'synthetic-check' } } });
  f.event('tool', { name: 'shell', detail: 'synthetic-check' });
  f.advance(3000); f.event('backend', { method: 'item/commandExecution/outputDelta', params: { delta: 'Supplied output' } });
  f.advance(4000); f.feedback.update(f.snapshot());
  const view = f.feedback.view(); assert.equal(view.title, 'Running shell'); assert.equal(view.elapsed, '00:07');
  assert.match(view.meta, /Last output 4s ago.*Process alive.*checked 0s ago/);
  f.advance(1000); f.feedback.update(f.snapshot()); assert.match(f.feedback.view().meta, /Last output 5s ago/);
  f.event('backend', { method: 'item/completed', params: { item: { id: 'command', type: 'commandExecution', exitCode: 0 } } });
  assert.match(f.feedback.view().title, /Tool returned.*waiting for model/);
  assert.equal(f.feedback.view().detail, '');
  f.event('text', { text: 'A response', itemId: 'reply' }); f.advance(2000); f.event('text', { text: ' continued', itemId: 'reply' });
  assert.equal(f.feedback.view().title, 'Receiving response'); assert.equal(f.feedback.view().elapsed, '00:02');
});

test('parallel tools, Claude completions and model output never keep a completed command active', () => {
  const f = fixture();
  for (const id of ['first', 'second']) f.event('backend', { method: 'tool.started', params: { id, name: id } });
  f.event('backend', { method: 'tool.completed', params: { id: 'second' } }); assert.equal(f.feedback.view().title, 'Running first');
  f.event('backend', { method: 'tool.completed', params: { id: 'first', failed: true } });
  assert.match(f.feedback.view().title, /Tool returned an error/);
  f.event('text', { text: 'I am correcting the failure.' }); assert.equal(f.feedback.view().title, 'Receiving response');
});

test('old replay, duplicate sequences and observations for another execution cannot fabricate activity or liveness', () => {
  const f = fixture(); f.advance(10000);
  f.feedback.event('tool', { name: 'old-command', occurredAt: '2026-10-25T23:00:00Z', seq: 10 });
  assert.equal(f.feedback.phase, null);
  f.event('text', { text: 'Current', seq: 20 }); f.advance(1000);
  f.feedback.update(f.snapshot()); f.event('tool', { name: 'duplicate', seq: 20 }); assert.equal(f.feedback.view().title, 'Receiving response');
  f.feedback.update(f.snapshot({ observation: { executionId: 'different', runnerAlive: true, observedAt: '2026-10-26T00:00:11Z' } }));
  assert.match(f.feedback.view().meta, /Process check unavailable/);
  assert.doesNotMatch(f.feedback.view().meta, /Process alive/);
  f.event('execution.finished', { id: 'previous-execution', exitCode: 0 }); assert.equal(f.feedback.active, true);
  f.feedback.update(f.snapshot({ execution: { id: 'queued-turn', state: 'queued', createdAt: '2026-10-26T00:00:11Z' } }));
  f.event('tool', { name: 'previous-run-finishing' }); f.advance(2000);
  f.feedback.update(f.snapshot({ execution: { id: 'queued-turn', state: 'running', startedAt: '2026-10-26T00:00:13Z' } }));
  assert.equal(f.feedback.view().title, 'Waiting for model output'); assert.equal(f.feedback.tools.size, 0);
});

test('quiet output, missing runners, input waits and lost connections are explicit and cannot appear healthy from animation', () => {
  const f = fixture(); f.event('text', { text: 'Last actual output' }); f.advance(45000); f.feedback.update(f.snapshot());
  assert.match(f.feedback.view().meta, /Last output 45s ago/); assert.equal(f.feedback.view().warning, true);
  f.feedback.connection(false); assert.equal(f.feedback.view().title, 'Reconnecting to Core'); assert.match(f.feedback.view().meta, /process unknown/);
  f.feedback.update(f.snapshot({ observation: { executionId: 'execution', runnerAlive: false, observedAt: '2026-10-26T00:00:45Z' } }));
  assert.match(f.feedback.view().title, /Process not detected/);
  f.feedback.update(f.snapshot({ questions: [{ id: 'approval' }] })); assert.equal(f.feedback.view().waiting, true);
  assert.equal(f.feedback.view().title, 'Waiting for your input');
  f.advance(11000); assert.equal(f.feedback.view().title, 'Reconnecting to Core');
});

test('completion freezes elapsed time; new executions and new terminals cannot inherit old tools or output', () => {
  const f = fixture(); f.event('tool', { name: 'shell' }); f.advance(23000);
  f.event('execution.finished', { id: 'execution', exitCode: 0 }); f.advance(10000);
  assert.deepEqual(f.feedback.view(), { title: 'Response finished', elapsed: '00:23', complete: true, warning: false });
  f.feedback.update(f.snapshot({ session: { id: 'chat', executionState: 'paused' }, execution: { id: 'execution', state: 'stopped', exitCode: 130 } }));
  assert.equal(f.feedback.view().title, 'Response paused');
  f.feedback.update(f.snapshot({ execution: { id: 'new', state: 'queued', createdAt: '2026-10-26T00:00:33Z' } }));
  assert.equal(f.feedback.view().title, 'Queued for execution'); assert.equal(f.feedback.lastOutputAt, null); assert.equal(f.feedback.tools.size, 0);
  f.feedback.update({ id: 'different-terminal', executionState: 'idle' }); assert.equal(f.feedback.view(), null);
  const idle = new ExecutionFeedback(); idle.update({ id: 'other', executionState: 'idle' }); assert.equal(idle.view(), null);
});

test('actual terminal activity animates visibly beside the action in compact and minimal chats, without adding history', () => {
  const input = new PassThrough(); Object.assign(input, { isTTY: true, setRawMode() {} });
  const output = new PassThrough(); Object.assign(output, { isTTY: true, columns: 80, rows: 26 }); output.resume();
  const ui = new UI({ input, output, error: output });
  try {
    const f = fixture(); ui.setSession('chat'); ui.tui.executionFeedback = f.feedback;
    for (const minimal of [false, true]) for (const columns of [40, 80, 120]) {
      ui.minimal = minimal; output.columns = columns; ui.updateSession(f.snapshot());
      ui.event('backend', { method: 'tool.started', params: { id: 'active', name: 'shell' } });
      ui.tui.value = 'Preserve this draft'; ui.tui.cursor = 5;
      ui.tui.frame = 0; ui.tui.render(); const first = ui.tui.lastFrame.map(clean).join('\n');
      ui.tui.frame = 1; ui.tui.render(); const second = ui.tui.lastFrame.map(clean).join('\n');
      assert.match(first, /⠋ Running shell/); assert.match(second, /⠙ Running shell/);
      assert.ok(ui.tui.lastFrame.every(line => cellWidth(line) < columns));
      assert.equal(ui.tui.value, 'Preserve this draft'); assert.equal(ui.tui.cursor, 5);
    }
    assert.equal(ui.tui.entries.length, 0); assert.equal(ui.tui.history.length, 0);
    ui.updateSession(f.snapshot({ session: { id: 'chat', executionState: 'waiting_for_input', goal: { id: 'goal', status: 'active' } }, questions: [{ id: 'approval', kind: 'approval', question: 'Allow the synthetic action?' }] }));
    ui.tui.render(); const waiting = ui.tui.lastFrame.map(clean).join('\n');
    assert.match(waiting, /Waiting for your input/); assert.match(waiting, /Needs your input/); assert.doesNotMatch(waiting, /Pursuing goal/);
    ui.clearHistory(); assert.equal(ui.tui.executionFeedback.view(), null);
  } finally { ui.close(); }
});
