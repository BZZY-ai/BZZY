import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { UI } from '../src/ui.js';
import { clean, cellWidth } from '../src/terminal-format.js';
import { sessionProjectLocation } from '../src/session-project-path.js';
import { createChatSession } from '@bzzy/core/engine/host-commands.js';
import { getProvider } from '@bzzy/core/engine/providers.js';
import { createSession, saveSession, setSessionAlias } from '@bzzy/core/engine/store.js';
import { getRecord, listRecords } from '@bzzy/core/engine/database.js';

let directory, previous;
test.beforeEach(() => {
  previous = process.env.BZZY_HOME;
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-session-folder-')));
  process.env.BZZY_HOME = path.join(directory, 'private');
});
test.afterEach(() => {
  if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
  fs.rmSync(directory, { recursive: true, force: true });
});
const provider = getProvider('codex');
function saved(name) {
  const cwd = path.join(directory, name); fs.mkdirSync(cwd, { recursive: true });
  return createChatSession(provider, { cwd, alias: name, model: 'fixture-model' });
}
function terminal(minimal = false) {
  const input = new PassThrough(); input.isTTY = true; input.setRawMode = () => {};
  const output = new PassThrough(); Object.assign(output, { isTTY: true, columns: 80, rows: 24 }); output.resume();
  const ui = new UI({ input, output, error: output, minimal });
  return { ui, input, output };
}

test('the folder comes from the saved project binding and aliasing never changes it or creates metadata', () => {
  const parent = saved('engagement'), nested = path.join(parent.cwd, 'nested'); fs.mkdirSync(nested);
  const legacy = createSession(provider, nested, 'fixture-model');
  Object.assign(legacy, { projectRoot: parent.projectRoot, projectId: parent.projectId }); saveSession(legacy);
  const before = structuredClone(getRecord('core.project.identity', parent.projectId));
  const location = sessionProjectLocation(legacy.id);
  assert.equal(location.path, path.join(parent.projectRoot, '.bzzy')); assert.equal(location.status, 'exists');
  setSessionAlias(legacy.id, 'nasa');
  assert.deepEqual(sessionProjectLocation(legacy.id), location);
  assert.deepEqual(getRecord('core.project.identity', parent.projectId), before, 'display must not update identity records');
  assert.equal(fs.existsSync(path.join(nested, '.bzzy')), false);
  assert.equal(listRecords('execution').length, 0);
});

for (const minimal of [false, true]) test(`the selected session path stays visible and copies in ${minimal ? 'minimal' : 'ordinary'} layouts`, async () => {
  const session = saved('a-long-project-name-for-inspecting-the-saved-directory');
  const { ui, input, output } = terminal(minimal);
  try {
    ui.setSession(session.id); ui.updateSession(session);
    const answer = ui.ask('bzzy › '); await Promise.resolve();
    ui.tui.value = 'preserve this draft 🐝'; ui.tui.cursor = 6;
    ui.tui.cwd = path.join(directory, 'unrelated-shell-folder');
    for (const [columns, rows] of [[60, 18], [80, 24], [120, 36]]) {
      Object.assign(output, { columns, rows }); ui.tui.render();
      assert.match(ui.tui.lastFrame.map(clean).join('\n'), /Session \.bzzy:/);
      assert.ok(ui.tui.lastFrame.every(line => cellWidth(line) < columns));
      const hit = ui.tui.hitTargets.find(item => item.type === 'session-project-path');
      assert.ok(hit); assert.ok(hit.row < ui.tui.composerRow);
      assert.equal(ui.tui.hitTargets.find(item => item.type === 'working-directory')?.path, session.cwd);
    }
    let copied;
    ui.clipboard = { async copyText(value) { copied = value; return { copied: true, method: 'native' }; } };
    const cwdHit = ui.tui.hitTargets.find(item => item.type === 'working-directory');
    ui.tui.mouse(0, cwdHit.left, cwdHit.row); await ui.tui.clipboardTask; assert.equal(copied, session.cwd);
    const hit = ui.tui.hitTargets.find(item => item.type === 'session-project-path');
    ui.tui.mouse(0, hit.left, hit.row); await ui.tui.clipboardTask;
    assert.equal(copied, path.join(session.projectRoot, '.bzzy'));
    assert.equal(ui.tui.value, 'preserve this draft 🐝'); assert.equal(ui.tui.cursor, 6);
    assert.ok(ui.tui.resolveInput); assert.equal(listRecords('execution').length, 0);
    const originalEntries = ui.tui.entries.length;
    assert.equal(await ui.settingsCommand('/session-folder'), true); ui.tui.render();
    assert.ok(ui.tui.entries.slice(originalEntries).some(entry => entry.text.includes(copied) && entry.text.includes('Folder exists.')));
    assert.equal(ui.tui.value, 'preserve this draft 🐝'); assert.equal(ui.tui.cursor, 6);
    ui.tui.finish(null); assert.equal(await answer, null);
  } finally { ui.close(); }
});

test('tab changes and saved-chat reopening show their own bound locations including agent namespaces', () => {
  const first = saved('first'), second = saved('second');
  const child = createSession(provider, first.cwd, 'fixture-worker');
  Object.assign(child, { projectRoot: first.projectRoot, projectId: first.projectId, parentSessionId: first.id, agentNamespace: 'analysis-worker' }); saveSession(child);
  const namespace = path.join(first.projectRoot, '.bzzy', 'agents', child.agentNamespace); fs.mkdirSync(namespace, { recursive: true });
  const { ui } = terminal();
  try {
    ui.setSession(first.id); ui.updateSession(first);
    assert.equal(ui.sessionProjectLocation.path, path.join(first.projectRoot, '.bzzy'));
    ui.setTabs(first.id, [{ id: child.id, agent: 'Analyst' }], child.id); ui.updateSession(child);
    assert.equal(ui.sessionProjectLocation.path, namespace);
    ui.setSession(second.id); ui.updateSession(second);
    assert.equal(ui.sessionProjectLocation.path, path.join(second.projectRoot, '.bzzy'));
    ui.setSession(first.id); ui.updateSession(first);
    assert.equal(ui.sessionProjectLocation.path, path.join(first.projectRoot, '.bzzy'));
    assert.equal(listRecords('execution').length, 0);
  } finally { ui.close(); }
});

test('missing saved folders retain their exact pinned location and never fall back to another cwd', () => {
  const session = saved('gone'), expected = path.join(session.projectRoot, '.bzzy');
  fs.rmSync(session.cwd, { recursive: true });
  const location = sessionProjectLocation(session.id);
  assert.equal(location.path, expected); assert.equal(location.status, 'missing');
  const { ui } = terminal();
  try {
    ui.setSession(session.id); ui.updateSession(session); ui.tui.render();
    assert.match(ui.tui.lastFrame.map(clean).join('\n'), /Session \.bzzy \(missing\):/);
    assert.equal(ui.sessionProjectLocation.path, expected);
    assert.equal(fs.existsSync(session.cwd), false, 'display does not recreate a missing workspace');
    assert.equal(sessionProjectLocation('no-such-session').status, 'unavailable');
  } finally { ui.close(); }
});
