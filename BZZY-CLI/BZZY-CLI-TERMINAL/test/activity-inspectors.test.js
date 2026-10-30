import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { UI } from '../src/ui.js';
import { clean, cellWidth } from '../src/terminal-format.js';
import { sliceCells } from '../src/terminal-surface.js';
import { createSession } from '../src/store.js';
import { BUILTINS } from '../src/providers.js';
import { events, listRecords } from '../src/database.js';

let directory, previous;
test.beforeEach(() => { previous = process.env.BZZY_HOME; directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-inspectors-')); process.env.BZZY_HOME = path.join(directory, 'private'); });
test.afterEach(() => { if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous; fs.rmSync(directory, { recursive: true, force: true }); });
const tick = () => new Promise(resolve => setImmediate(resolve));
function terminal() {
  const input = new PassThrough(); Object.assign(input, { isTTY: true, setRawMode() {} });
  const output = new PassThrough(); Object.assign(output, { isTTY: true, columns: 170, rows: 44 }); output.resume();
  const ui = new UI({ input, output, pet: false }), session = createSession(BUILTINS.codex, directory, 'fixture', 'Inspector fixture');
  ui.setSession(session.id); ui.updateSession(session); return { ui, tui: ui.tui, session, input, output };
}
const frame = tui => tui.lastFrame.map(clean).join('\n');
const right = tui => tui.lastFrame.map(line => clean(sliceCells(line, tui.workspace.width - tui.workspace.right, tui.workspace.width))).join('\n');
const center = tui => tui.lastFrame.map(line => clean(sliceCells(line, tui.workspace.x, tui.workspace.x + tui.workspace.center))).join('\n');
function click(tui, type, predicate = () => true) { tui.render(); const hit = tui.hitTargets.find(hit => hit.type === type && predicate(hit)); assert.ok(hit, type); tui.mouse(0, hit.left, hit.row); tui.render(); }

test('HTTP rows keep the right table intact and open stacked, independently scrolling request/response blocks in the center', async () => {
  const { ui, tui, session, input } = terminal();
  try {
    const pending = ui.ask('bzzy › '); await tick(); tui.value = 'Preserve the HTTP draft'; tui.cursor = 7;
    const reader = ui.reader, before = events(session.id);
    const headers = Object.fromEntries(Array.from({ length: 25 }, (_, index) => ['x-fixture-' + index, 'header-' + index]));
    ui.event('network.request', { id: 'fixture-http', method: 'POST', url: 'https://example.test/api?access_token=private-value', requestHeaders: { ...headers, authorization: 'Bearer private-value' }, provenance: 'proxy-observed' });
    click(tui, 'monitor-detail', hit => hit.kind === 'http');
    assert.match(center(tui), /REQUEST[\s\S]*RESPONSE/); assert.match(center(tui), /Awaiting response/);
    assert.doesNotMatch(right(tui), /HEADERS|BODY|Awaiting response/); assert.match(right(tui), /POST\s+…/);
    const request = tui.httpInspectorRegions.find(row => row.section === 'request');
    tui.mouse(65, request.left + 3, request.top + 2); tui.render(); assert.ok(tui.monitor.httpDetailOffsets.request > 0); assert.equal(tui.monitor.httpDetailOffsets.response, 0);
    ui.event('network.response', { id: 'fixture-http', status: 201, durationMs: 37, responseHeaders: { ...headers, 'content-type': 'application/json', 'set-cookie': 'private-cookie' }, responsePreview: '{"result":{"count":2},"token":"private-body-value"}' });
    tui.render(); assert.match(center(tui), /201\s+·\s+37 ms/); assert.match(right(tui), /POST\s+201/);
    const response = tui.httpInspectorRegions.find(row => row.section === 'response'), keptOffset = tui.monitor.httpDetailOffsets.request;
    tui.mouse(65, response.left + 3, response.top + 2); tui.render(); assert.ok(tui.monitor.httpDetailOffsets.response > 0); assert.equal(tui.monitor.httpDetailOffsets.request, keptOffset);
    let copied; ui.clipboard = { async copyText(value) { copied = value; return { copied: true }; } };
    click(tui, 'monitor-http-copy', hit => hit.section === 'response'); await tui.clipboardTask;
    assert.match(copied, /"result": \{\n\s+"count": 2/); assert.doesNotMatch(copied, /private-body-value|private-cookie/);
    click(tui, 'monitor-http-copy', hit => hit.section === 'request'); await tui.clipboardTask;
    assert.match(copied, /authorization: \[redacted\]/); assert.doesNotMatch(copied, /private-value/);
    input.write('\x1b'); await new Promise(resolve => setTimeout(resolve, 80)); tui.render();
    assert.equal(tui.panel, 'chat'); assert.equal(ui.reader, reader); assert.equal(tui.value, 'Preserve the HTTP draft'); assert.equal(tui.cursor, 7);
    assert.deepEqual(events(session.id), before); assert.equal(listRecords('execution').length, 0);
    ui.reader.close(); await pending;
  } finally { ui.close(); }
});
test('CODE lists each actual command once, updates completion, and opens full wrapped input in the center with Esc back to chat', async () => {
  const { ui, tui, input, output, session } = terminal();
  try {
    const pending = ui.ask('bzzy › '); await tick(); tui.value = 'Preserve the command draft'; tui.cursor = 9;
    const reader = ui.reader, before = events(session.id);
    const full = "python3 -u - <<'PY'\nprint('" + 'full actual command '.repeat(400) + "')\nPY";
    const item = { id: 'actual-command', type: 'commandExecution', command: ['/bin/bash', '-c', full] };
    ui.event('backend', { method: 'item/started', runId: 'run-1', params: { item } });
    ui.event('backend', { method: 'item/completed', runId: 'run-1', params: { item: { ...item, status: 'completed', exitCode: 0 } } });
    assert.equal(tui.monitor.commands.size, 1); assert.equal([...tui.monitor.commands.values()][0].phase, 'completed');
    tui.render(); assert.match(right(tui), /TIME\s+COMMAND/); assert.doesNotMatch(right(tui), /20 full actual command/);
    click(tui, 'monitor-command');
    const recorded = [...tui.monitor.commands.values()][0].command;
    assert.match(center(tui), /COMMAND/); assert.equal(tui.monitor.commandPreview.sourceText, recorded);
    const first = center(tui); await new Promise(resolve => setTimeout(resolve, 170)); tui.render(); assert.notEqual(center(tui), first, 'real render frames reveal the captured input');
    tui.monitor.scroll('command', Infinity); tui.render();
    assert.ok(tui.monitor.maxima.command > 0); assert.ok(tui.lastFrame.every(line => cellWidth(line) < output.columns));
    let copied; ui.clipboard = { async copyText(value) { copied = value; return { copied: true }; } };
    click(tui, 'monitor-command-copy'); await tui.clipboardTask; assert.equal(copied, recorded); assert.match(copied, /\/bin\/bash -c/);
    assert.match(right(tui), /TIME\s+COMMAND/); assert.doesNotMatch(right(tui), /COMMAND\s+Copy/);
    input.write('\x1b'); await new Promise(resolve => setTimeout(resolve, 80)); tui.render();
    assert.equal(tui.panel, 'chat'); assert.equal(ui.reader, reader); assert.equal(tui.value, 'Preserve the command draft'); assert.equal(tui.cursor, 9);
    assert.deepEqual(events(session.id), before); assert.equal(listRecords('execution').length, 0);
    ui.reader.close(); await pending;
  } finally { ui.close(); }
});
