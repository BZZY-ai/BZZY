import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { ToolTreeProjection, toolTreeLayout, changeToolTree } from '../src/tool-tree-ui.js';
import { createTerminalTheme } from '../src/terminal-theme.js';
import { clean, cellWidth } from '../src/terminal-format.js';
import { UI } from '../src/ui.js';
import { createChatSession } from '@bzzy/core/engine/host-commands.js';
import { getProvider } from '@bzzy/core/engine/providers.js';
import { appendEvent, events, listRecords } from '@bzzy/core/engine/database.js';

let directory, previous, terminals;
test.beforeEach(() => {
  previous = process.env.BZZY_HOME; directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-tool-tree-')));
  process.env.BZZY_HOME = path.join(directory, 'private'); terminals = [];
});
test.afterEach(() => {
  for (const ui of terminals) ui.close();
  if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
  fs.rmSync(directory, { recursive: true, force: true });
});
const owner = 'owner-session';
const backend = (id, command, method = 'item/started', extra = {}) => ({ method, params: { item: { id, type: 'commandExecution', command, ...extra } }, runId: 'native-run' });
const theme = createTerminalTheme({ isTTY: false }, {});
const plain = layout => layout.lines.map(clean).join('\n');
function terminal(session) {
  const input = new PassThrough(); Object.assign(input, { isTTY: true, isRaw: false, setRawMode(value) { this.isRaw = value; } });
  const output = new PassThrough(); Object.assign(output, { isTTY: true, columns: 100, rows: 40 }); output.resume();
  const ui = new UI({ input, output, error: output, pet: false }); ui.setSession(session.id); ui.updateSession(session); terminals.push(ui); return ui;
}

test('native lifecycle and legacy tool notifications count one call and preserve failed exit status', () => {
  const trace = new ToolTreeProjection(), entries = [], event = (type, data) => trace.event(entries, type, data, { sessionId: owner });
  event('execution.started', { id: 'execution' });
  event('backend', { ...backend('one', 'npm test'), seq: 1 });
  event('tool', { name: 'shell', detail: 'npm test', seq: 2 });
  event('backend', { ...backend('one', 'npm test', 'item/completed', { exitCode: 1, durationMs: 1500 }), seq: 3 });
  event('backend', { ...backend('one', 'npm test'), seq: 1 });
  const group = entries[0].toolTree;
  assert.equal(entries.length, 1); assert.equal(group.calls.length, 1); assert.equal(group.calls[0].phase, 'failed');
  const layout = plain(toolTreeLayout(group, 99, theme));
  assert.match(layout, /Tool calls \(1\)/); assert.match(layout, /npm test/); assert.match(layout, /failed.*1.5s.*exit 1/);
});

test('named worker calls nest beneath its card, keep worker identity and do not alter accepted state', () => {
  const trace = new ToolTreeProjection(), entry = { kind: 'invocation', assignmentId: 'assignment', sessionId: owner, state: 'accepted' }, entries = [entry];
  const action = { workerSessionId: 'worker', actorSessionId: 'worker', assignmentId: 'assignment', agent: 'http-analyst', runId: 'worker-run', callId: 'read',
    phase: 'started', name: 'Read', label: 'Read file', detail: 'summary.md', provenance: 'backend-reported' };
  trace.event(entries, 'worker.tool', action, { sessionId: owner });
  trace.event(entries, 'worker.tool', { ...action, phase: 'completed' }, { sessionId: owner });
  assert.equal(entries.length, 1); assert.equal(entry.state, 'accepted'); assert.equal(entry.toolTree.calls.length, 1);
  assert.match(plain(toolTreeLayout(entry.toolTree, 80, theme, { nested: true })), /Read file\("summary.md"\).*returned/);
  assert.doesNotThrow(() => JSON.stringify(entries));
  trace.event(entries, 'worker.tool', { ...action, callId: 'foreign', eventSessionId: 'other' }, { sessionId: owner });
  assert.equal(entry.toolTree.calls.length, 1);
});

test('long histories page visibly, wrap only expanded details and fit narrow/minimal layouts', () => {
  const trace = new ToolTreeProjection(), entries = [];
  for (let i = 0; i < 58; i++) trace.event(entries, 'backend', backend(`${i}`, `python3 analysis-${i}.py --input a-long-input-file-name.json`), { sessionId: owner });
  const group = entries[0].toolTree;
  assert.equal(group.calls.length, 58);
  for (const width of [28, 40, 80, 140]) {
    const layout = toolTreeLayout(group, width, theme);
    assert.ok(layout.lines.every(line => cellWidth(clean(line)) <= width));
    assert.ok(layout.hits.some(hit => hit.type === 'tool-tree-page'));
  }
  changeToolTree({ type: 'tool-tree-page', group, delta: -1 }); assert.equal(group.page, 1);
  changeToolTree({ type: 'tool-row-toggle', group, call: group.calls[25] });
  assert.match(plain(toolTreeLayout(group, 50, theme)), /Backend-reported activity/);
  changeToolTree({ type: 'tool-tree-toggle', group });
  assert.equal(toolTreeLayout(group, 80, theme).lines.length, 2);
});

test('out-of-order completion never reopens a call and interrupted calls remain explicitly unknown', () => {
  const trace = new ToolTreeProjection(), entries = [], event = (type, data) => trace.event(entries, type, data, { sessionId: owner });
  event('backend', { method: 'tool.completed', params: { id: 'read', failed: false }, seq: 3 });
  event('backend', { method: 'tool.started', params: { id: 'read', name: 'Read', input: { file_path: 'impact.md' } }, seq: 2 });
  assert.equal(entries[0].toolTree.calls[0].phase, 'completed'); assert.equal(entries[0].toolTree.calls[0].detail, 'impact.md');
  event('backend', backend('pending', 'long-command'));
  event('execution.finished', { id: 'execution', exitCode: 130 });
  assert.match(plain(toolTreeLayout(entries[0].toolTree, 90, theme)), /stopped · result unknown/);
});

test('saved tool history replays across compaction notifications without modifying assistant bodies or starting work', () => {
  const session = createChatSession(getProvider('codex'), { cwd: directory, model: 'fixture-model' });
  const body = '<bzzy><p>Original assistant body</p></bzzy>';
  const saved = [
    appendEvent(session.id, 'message.user', { text: 'Inspect the project', executionId: 'execution' }),
    appendEvent(session.id, 'backend', backend('read', 'cat summary.md')),
    appendEvent(session.id, 'tool', { name: 'shell', detail: 'cat summary.md' }),
    appendEvent(session.id, 'backend', backend('read', 'cat summary.md', 'item/completed', { exitCode: 0 })),
    appendEvent(session.id, 'backend', { method: 'thread/compacted', params: {} }),
    appendEvent(session.id, 'text', { text: body, itemId: 'reply' }),
    appendEvent(session.id, 'execution.finished', { id: 'execution', exitCode: 0 }),
  ];
  const eventCount = events(session.id).length;
  const ui = terminal(session); ui.tui.value = 'preserve draft';
  const replay = () => { for (const event of saved) ui.event(event.type, { ...event.data, seq: event.seq, eventSessionId: session.id, occurredAt: event.createdAt }); };
  replay();
  const entry = ui.tui.entries.find(entry => entry.kind === 'tool-tree');
  assert.equal(entry.toolTree.calls.length, 1); assert.equal(entry.toolTree.calls[0].phase, 'completed');
  assert.equal(ui.tui.entries.find(entry => entry.kind === 'assistant').text, body);
  ui.tui.key('', { ctrl: true, name: 't' }); assert.equal(entry.toolTree.expanded, false);
  ui.tui.key('', { ctrl: true, name: 't' }); assert.equal(entry.toolTree.expanded, true);
  ui.tui.key('', { ctrl: true, name: 'o' }); assert.equal(ui.tui.showTools, false);
  assert.equal(ui.tui.value, 'preserve draft');
  ui.tui.clear(); replay(); assert.equal(ui.tui.entries.find(entry => entry.kind === 'tool-tree').toolTree.calls.length, 1);
  assert.equal(events(session.id).length, eventCount); assert.equal(listRecords('execution').length, 0);
});
