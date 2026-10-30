import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UI } from '../src/ui.js';
import { clean, cellWidth } from '../src/terminal-format.js';
import { workspaceGeometry } from '../src/workspace-layout.js';
import { chooseSavedModel, savedModelCombinations } from '../src/model-controls.js';
import { config, updateConfig } from '../src/providers.js';

function terminal() {
  const input = new PassThrough(); Object.assign(input, { isTTY: true, setRawMode() {} });
  const output = new PassThrough(); Object.assign(output, { isTTY: true, columns: 180, rows: 48 }); output.resume();
  const ui = new UI({ input, output, pet: false }); ui.setSession('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  return { ui, output, tui: ui.tui };
}
const click = (tui, type, predicate = () => true) => {
  const hit = tui.hitTargets.find(hit => hit.type === type && predicate(hit)); assert.ok(hit, type);
  tui.mouse(0, hit.left, hit.row); tui.mouse(0, hit.left, hit.row, true); tui.render(); return hit;
};
test('responsive workspace preserves readable chat, visible navigation and source inspectors without synthetic activity', async () => {
  const { ui, tui, output } = terminal();
  try {
    tui.value = 'Unsent draft'; tui.cursor = 5;
    ui.event('text', { text: 'Real streaming response', itemId: 'r1' });
    for (const [columns, rows] of [[180,48], [150,40], [120,30], [80,24], [40,16]]) {
      Object.assign(output, { columns, rows }); tui.render();
      assert.ok(tui.lastFrame.every(line => cellWidth(line) <= columns - 1), `${columns} columns`);
      assert.ok(tui.lastFrame.length <= rows);
      assert.match(tui.lastFrame.map(clean).join('\n'), /Real streaming response/);
      assert.equal(tui.value, 'Unsent draft');
    }
    Object.assign(output, { columns: 180, rows: 48 }); tui.render();
    const text = tui.lastFrame.map(clean).join('\n');
    for (const label of ['NAVIGATION', 'AGENTS', 'HTTP PROBE', 'CODE']) assert.ok(text.includes(label), label);
    assert.doesNotMatch(text, /No observed HTTP|Waiting for code|Enable capture/);
    assert.equal(tui.monitor.feed.length, 0); assert.equal(tui.monitor.files.size, 0);
    for (const panel of ['chat', 'agents', 'skills', 'workflows', 'goals', 'metrics', 'settings']) assert.ok(tui.hitTargets.some(hit => hit.type === 'top-' + panel));
    const send = tui.hitTargets.find(hit => hit.type === 'confirm'); assert.ok(send);
    assert.equal(send.row, tui.composerRow); assert.ok(send.left > tui.workspace.x);
    for (const hidden of [true, false]) {
      click(tui, 'workspace-actions'); await new Promise(resolve => setImmediate(resolve));
      tui.finishSelection('@right'); await tui.menuTask; assert.equal(Boolean(tui.workspace.right), !hidden);
    }
    const border = tui.workspaceRegions.find(region => region.kind === 'width' && region.side === 'right');
    const before = tui.workspace.right; tui.mouse(0, border.left, 10); tui.mouse(32, border.left - 7, 10); tui.mouse(0, border.left - 7, 10, true); tui.render(); assert.equal(tui.workspace.right, before + 7);
    click(tui, 'monitor-toggle', hit => hit.kind === 'agents'); assert.ok(tui.monitor.collapsed.has('agents'));
    click(tui, 'monitor-toggle', hit => hit.kind === 'agents'); assert.ok(!tui.monitor.collapsed.has('agents'));
    click(tui, 'monitor-expand', hit => hit.kind === 'code'); assert.equal(tui.panel, 'monitor'); assert.equal(tui.canCompose(), false);
    click(tui, 'monitor-close'); assert.equal(tui.panel, 'chat'); assert.equal(tui.value, 'Unsent draft');
  } finally { ui.close(); }
});
test('HTTP rows merge actual capture phases, redact details and exclude backend visits; source and agent feeds use real event identity', () => {
  const { ui, tui } = terminal();
  try {
    const actor = { actorSessionId: 'worker-1', actorRole: 'subagent', actorName: 'agent-idor' };
    ui.event('assignment.created', { id: 'assignment-1', parentSessionId: ui.sessionId, subagentDefinition: { name: 'agent-idor' }, selection: { provider: 'codex', model: 'fixture' }, occurredAt: '2026-10-29T10:00:00Z' });
    ui.event('core.usage', { id: 'skill-receipt', kind: 'skill', sessionId: ui.sessionId, rootSessionId: ui.sessionId, name: 'api-recon', scope: 'project', createdAt: '2026-10-29T10:01:00Z' });
    ui.event('network.backend', { id: 'visit', url: 'https://example.test/native', provenance: 'backend-reported' });
    ui.event('network.request', { ...actor, id: 'http-1', method: 'GET', url: 'https://example.test/api?token=fixture-private-value', provenance: 'host-observed' });
    ui.event('network.response', { ...actor, id: 'http-1', method: 'GET', url: 'https://example.test/api?token=fixture-private-value', status: 200, durationMs: 32, provenance: 'host-observed', requestHeaders: { Authorization: 'Bearer fixture-private-value' } });
    ui.event('source.changed', { ...actor, path: 'probe.js', language: 'js', content: 'const a = 1;\nconsole.log(a);', phase: 'completed' });
    ui.event('source.changed', { ...actor, path: 'probe.js', language: 'js', content: 'const a = 2;\nconsole.log(a);', phase: 'completed' });
    tui.render();
    assert.equal(tui.monitor.requests(tui.traffic).length, 1);
    assert.equal(tui.monitor.files.size, 1); assert.ok(tui.monitor.files.values().next().value.changed.has(0));
    assert.equal(tui.monitor.feed[0].summary, 'api-recon'); assert.equal(tui.monitor.feed[1].summary, 'agent-idor');
    click(tui, 'monitor-detail', hit => hit.kind === 'http');
    const text = tui.lastFrame.map(clean).join('\n'); assert.match(text, /32 ms/); assert.match(text, /redacted/); assert.doesNotMatch(text, /fixture-private-value/);
    click(tui, 'monitor-close');
    click(tui, 'monitor-detail', hit => hit.kind === 'agents'); assert.equal(tui.monitor.detail.row.summary, 'api-recon');
    assert.equal(tui.entries.some(entry => entry.kind === 'source.changed'), false);
  } finally { ui.close(); }
});
test('workspace geometry uses the modern frame at every size and preserves a dominant center', () => {
  assert.ok(workspaceGeometry(80, 24).center >= 46); assert.equal(workspaceGeometry(40, 18).left, 0);
  for (let width = 110; width <= 240; width++) {
    const geo = workspaceGeometry(width, 40, { left: 36, right: 60 });
    assert.ok(geo.center >= 46); assert.ok(geo.center > geo.left);
  }
});
test('saved combinations reuse Core private configuration and preserve unrelated model defaults', async () => {
  const previous = process.env.BZZY_HOME, directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-combinations-'));
  process.env.BZZY_HOME = directory;
  try {
    updateConfig(value => ({ ...value, defaultProvider: 'codex', unrelated: { keep: true } }));
    const picks = ['@save', null];
    await chooseSavedModel({ provider: 'codex', model: 'fixture-model', selectedEffort: 'high' }, { chooseOne: async () => picks.shift(), ask: async () => 'Saved fixture' });
    assert.deepEqual(savedModelCombinations(), [{ name: 'Saved fixture', provider: 'codex', model: 'fixture-model', effort: 'high' }]);
    const selected = await chooseSavedModel({ provider: 'codex' }, { chooseOne: async () => '0' });
    assert.equal(selected.model, 'fixture-model'); assert.equal(selected.effort, 'high'); assert.equal(config().defaultProvider, 'codex'); assert.deepEqual(config().unrelated, { keep: true });
    assert.doesNotMatch(JSON.stringify(config().terminalModelCombinations), /capabilities|credential|engineHome/);
  } finally { if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous; fs.rmSync(directory, { recursive: true, force: true }); }
});
test('visible response actions copy code and links open only after an explicit safe browser action', async () => {
  const { responseResources, openTerminalLink } = await import('../src/response-actions.js');
  const { EventEmitter } = await import('node:events');
  const resources = responseResources('Read https://example.test/docs.\n```js\nconst value = 1;\n```');
  assert.equal(resources.code[0].text, 'const value = 1;'); assert.deepEqual(resources.links, ['https://example.test/docs']);
  const calls = [], spawnImpl = (...args) => { calls.push(args); const child = new EventEmitter(); queueMicrotask(() => child.emit('close', 0)); return child; };
  await openTerminalLink('https://example.test/docs', { platform: 'darwin', spawnImpl });
  assert.deepEqual(calls[0].slice(0, 2), ['open', ['https://example.test/docs']]); assert.equal(calls[0][2].shell, false);
  await assert.rejects(openTerminalLink('file:///etc/passwd', { spawnImpl }));
  await assert.rejects(openTerminalLink('https://user:password@example.test', { spawnImpl })); assert.equal(calls.length, 1);
  const { ui, tui } = terminal();
  try {
    ui.event('text', { text: 'Example:\n```js\nconst value = 1;\n```', itemId: 'code' }); tui.render();
    const previous = tui.entries[0].text;
    click(tui, 'response-menu'); assert.ok(tui.selection.choices.some(choice => choice.value === 'code:0'));
    tui.finishSelection(null); assert.equal(tui.entries[0].text, previous); assert.equal(tui.inputQueue.length, 0);
  } finally { ui.close(); }
});
test('the saved-model dropdown itself can name the current selection and immediately reuse it without sending chat', async () => {
  const previous = process.env.BZZY_HOME, directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-combination-menu-'));
  process.env.BZZY_HOME = directory;
  const { ui, tui } = terminal();
  try {
    tui.value = 'Keep my draft'; tui.cursor = 5;
    const selection = chooseSavedModel({ provider: 'codex', model: 'fixture-selected', selectedEffort: 'high' }, ui);
    await new Promise(resolve => setImmediate(resolve)); tui.render();
    const saveIndex = tui.selection.choices.findIndex(choice => choice.value === '@save');
    click(tui, 'choice', hit => hit.index === saveIndex);
    await new Promise(resolve => setImmediate(resolve)); assert.ok(tui.promptDraft);
    tui.finish('My saved selection');
    await new Promise(resolve => setImmediate(resolve)); tui.render();
    assert.equal(tui.selection.choices[0].label, 'My saved selection');
    click(tui, 'choice', hit => hit.index === 0);
    const result = await selection; assert.equal(result.model, 'fixture-selected'); assert.equal(result.effort, 'high');
    assert.equal(tui.value, 'Keep my draft'); assert.equal(tui.inputQueue.length, 0); assert.equal(tui.entries.length, 0);
  } finally { ui.close(); if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous; fs.rmSync(directory, { recursive: true, force: true }); }
});
