import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { UI } from '../src/ui.js';
import { clean, cellWidth } from '../src/terminal-format.js';
import { hostMetricsRows } from '../src/host-metrics.js';
import { canControlSession } from '../src/session-controls.js';
import { createSession } from '../src/store.js';
import { BUILTINS } from '../src/providers.js';

let directory, previous;
test.beforeEach(() => { previous = process.env.BZZY_HOME; directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-front-regression-')); process.env.BZZY_HOME = path.join(directory, 'private'); });
test.afterEach(() => { if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous; fs.rmSync(directory, { recursive: true, force: true }); });
function terminal() {
  const input = new PassThrough(); Object.assign(input, { isTTY: true, setRawMode() {} });
  const output = new PassThrough({ highWaterMark: 16 * 1024 * 1024 }); Object.assign(output, { isTTY: true, rows: 40, columns: 160 }); output.resume();
  const ui = new UI({ input, output, pet: false });
  const session = createSession(BUILTINS.codex, directory, 'fixture-model', 'Fixture session');
  ui.setSession(session.id); ui.updateSession(session);
  return { ui, tui: ui.tui, output, session };
}
const frame = tui => tui.lastFrame.map(clean).join('\n');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('Usage separates reported session and compactor tokens and anchors real CPU/RAM below Sessions', () => {
  const { ui, tui, output, session } = terminal();
  try {
    ui.hostMetrics = { host: { cpuPercent: 18.75, memory: { totalBytes: 32 * 1024 ** 3, usedBytes: 12.5 * 1024 ** 3 } } };
    for (const [columns, rows] of [[160, 44], [120, 36], [100, 32], [80, 24]]) {
      Object.assign(output, { columns, rows });
      ui.updateSession({ session: { ...session, usage: { available: true, tokens: 12345 } }, compactorUsage: { sessionId: session.id, available: true, tokens: 2345, complete: false } }); tui.render();
      const text = frame(tui);
      assert.match(text, /12,345 tokens/); assert.match(text, /Compactor\s+≥2,345/);
      const health = tui.lastFrame.findIndex(line => clean(line).includes('HOST USAGE'));
      const sessions = tui.lastFrame.findIndex(line => clean(line).includes('SESSIONS'));
      assert.ok(health > sessions); assert.equal(health, rows - 3);
      assert.match(clean(tui.lastFrame[health + 1]), /CPU.*19%/); assert.match(clean(tui.lastFrame[health + 2]), /RAM.*12.5\/32G/);
      assert.ok(tui.workspaceRegions.filter(region => region.kind === 'sessions').every(region => region.bottom <= health));
      assert.ok(tui.lastFrame.every(line => cellWidth(line) < columns));
    }
    ui.updateSession({ session, compactorUsage: { sessionId: 'another-session', tokens: 999 } }); tui.render();
    assert.equal(tui.compactorUsage, null); assert.match(frame(tui), /Compactor\s+—/);
    assert.ok(hostMetricsRows(null).every(row => row.endsWith('—')));
  } finally { ui.close(); }
});
test('every normal and Settings subview uses the same modern frame at compact, normal and wide sizes', async () => {
  const { ui, tui, output } = terminal();
  try {
    ui.openSettings();
    for (const minimal of [false, true]) for (const [columns, rows] of [[40, 18], [80, 24], [100, 32], [160, 44]]) {
      ui.minimal = minimal; Object.assign(output, { columns, rows });
      const scenes = ['chat', 'room', 'activity', 'http', 'agents', 'skills', 'workflows', 'goals', 'metrics', 'extension', 'settings'];
      for (const panel of scenes) {
        if (panel === 'extension') continue; // Real native extension adapters have their own integration suite.
        tui.panel = panel; tui.render();
        assert.match(clean(tui.lastFrame[0]), /BZZY/);
        assert.ok(tui.lastFrame.every(line => cellWidth(line) < columns), panel);
        assert.ok(tui.lastFrame.length <= rows, panel);
        assert.ok(tui.hitTargets.some(hit => hit.type === 'workspace-toggle' && hit.side === 'left'), panel);
        assert.doesNotMatch(frame(tui), /CHAT ACTIVITY HTTP SESSIONS|Right-click \/ F10|Ask BZZY to do anything/);
      }
      tui.panel = 'settings';
      for (const page of ['main', 'keys', 'core', 'pair', 'approve', 'extensions', 'default-models', 'worker-budget']) {
        Object.assign(ui.settings, { page, focus: 0 }); tui.render();
        assert.match(clean(tui.lastFrame[0]), /BZZY/); assert.ok(tui.lastFrame.every(line => cellWidth(line) < columns), page);
        assert.ok(tui.hitTargets.some(hit => ['back', 'settings-back'].includes(hit.type)), page);
      }
      tui.panel = 'chat'; const finish = tui.beginHistoryRestore({ alias: 'Large saved chat' });
      assert.match(clean(tui.lastFrame[0]), /BZZY/); assert.match(frame(tui), /Loading saved chat/); finish();
    }
  } finally { ui.close(); }
});
test('saved-session misclicks cancel without touching draft, reader, transcript, scroll or queued input', async () => {
  const { ui, tui, session } = terminal();
  try {
    ui.event('text', { text: 'Keep the original answer\n'.repeat(80), itemId: 'original' });
    const target = createSession(BUILTINS.codex, directory, null, 'Another large chat');
    const pending = ui.ask('bzzy › '); await tick();
    tui.value = 'Keep the unsent draft'; tui.cursor = 7; tui.scroll = 3;
    tui.recentCache = null; tui.render();
    const reader = ui.reader, entries = tui.entries.slice();
    const saved = tui.hitTargets.find(hit => hit.type === 'saved-session' && hit.id === target.id); assert.ok(saved);
    tui.mouse(0, saved.left, saved.row); const confirmation = tui.sessionOpenTask; await tick();
    assert.equal(tui.selection.scope, 'session-open');
    assert.deepEqual(tui.selection.choices.map(row => row.value), ['open', 'cancel']);
    assert.equal(tui.selection.choices[tui.selection.focus].value, 'cancel');
    tui.render(); const cancel = tui.hitTargets.find(hit => hit.type === 'choice' && tui.selection.choices[hit.index]?.value === 'cancel'); assert.ok(cancel);
    tui.mouse(0, cancel.left, cancel.row); await confirmation;
    assert.equal(ui.sessionId, session.id); assert.equal(ui.reader, reader);
    assert.equal(tui.value, 'Keep the unsent draft'); assert.equal(tui.cursor, 7); assert.equal(tui.scroll, 3);
    assert.deepEqual(tui.entries, entries); assert.deepEqual(tui.inputQueue, []);
    ui.reader.close(); await pending;
  } finally { ui.close(); }
});
test('normal restored sessions allow visible model controls, explicit read-only views do not', () => {
  const { ui, tui } = terminal();
  try {
    ui.sessionMode = 'VIEW'; ui.permissionConnection = { acquire: async () => {} }; tui.render();
    assert.equal(canControlSession(ui), true);
    assert.ok(tui.hitTargets.filter(hit => hit.type === 'model-control' && /^\/(?:providers|models|effort)/.test(hit.command)).every(hit => !hit.disabled));
    const commands = []; tui.localCommand = command => commands.push(command);
    const provider = tui.hitTargets.find(hit => hit.command === '/providers @provider'); tui.mouse(0, provider.left, provider.row);
    assert.deepEqual(commands, ['/providers @provider']);
    ui.permissionConnection = null; tui.render(); assert.equal(canControlSession(ui), false);
    assert.ok(tui.hitTargets.filter(hit => hit.type === 'model-control').every(hit => hit.disabled));
    tui.mouse(0, provider.left, provider.row); assert.equal(commands.length, 1);
  } finally { ui.close(); }
});
test('agent/skill rows remain newest first and source deltas replay only actual input chunks', () => {
  const { ui, tui, session } = terminal();
  try {
    const assignment = { id: 'actual-assignment', parentSessionId: session.id, subagentDefinition: { name: 'api-agent' }, createdAt: '2026-10-29T10:00:00Z' };
    ui.event('assignment.created', assignment);
    ui.event('core.usage', { id: 'actual-skill', kind: 'skill', sessionId: session.id, rootSessionId: session.id, name: 'api-skill', createdAt: '2026-10-29T10:01:00Z' });
    ui.event('assignment.started', { id: assignment.id, round: 1 });
    ui.event('worker.tool', { workerSessionId: 'worker', name: 'shell', label: 'Do not duplicate these logs' });
    assert.deepEqual(tui.monitor.feed.map(row => row.summary), ['api-skill', 'api-agent']);
    const rows = tui.monitor.rows('agents', 50, tui).lines.map(clean);
    assert.ok(rows.every(row => /^\d\d:\d\d [◇✧] /.test(row))); assert.doesNotMatch(rows.join(''), /Do not duplicate/);
    const source = { sourceId: 'command:call', path: 'python · shell input', language: 'python', actorSessionId: session.id, phase: 'preparing' };
    ui.event('source.delta', { ...source, revision: 1, replaceFrom: 0, text: 'print(' });
    ui.event('source.delta', { ...source, revision: 2, replaceFrom: 6, text: '1)' });
    ui.event('source.delta', { ...source, revision: 1, replaceFrom: 0, text: 'stale' });
    ui.event('source.delta', { ...source, revision: 3, replaceFrom: 99, text: 'invalid' });
    assert.equal(tui.monitor.files.size, 1); assert.equal(tui.monitor.files.values().next().value.sourceText, 'print(1)');
    assert.equal(tui.entries.some(entry => /^source\./.test(entry.kind)), false);
  } finally { ui.close(); }
});
