import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createToolActivityProjector } from '../src/engine/tool-activity.js';
import { RunnerUI } from '../src/engine/runtime-ui.js';
import { createSession } from '../src/engine/store.js';
import { getProvider } from '../src/engine/providers.js';
import { events } from '../src/engine/database.js';

test('native commands, files, browser actions and searches project only display metadata', () => {
  const project = createToolActivityProjector({ sessionId: 'session', runId: 'run', secrets: [] });
  const start = item => project('backend', { method: 'item/started', params: { item } });
  assert.equal(start({ id: 'cmd', type: 'commandExecution', command: 'npm test', aggregatedOutput: 'PRIVATE_OUTPUT' }).detail, 'npm test');
  assert.equal(start({ id: 'file', type: 'fileChange', changes: [{ path: 'src/main.js', diff: 'PRIVATE_CONTENT' }] }).detail, 'src/main.js');
  assert.equal(start({ id: 'web', type: 'webSearch', action: { type: 'openPage', url: 'https://example.test/docs' } }).label, 'Open web');
  const browser = start({ id: 'browser', type: 'mcpToolCall', server: 'browser', tool: 'browser_exec', arguments: { description: 'Opening the documentation', code: 'PRIVATE_SCRIPT' } });
  assert.equal(browser.label, 'Browser'); assert.equal(browser.detail, 'Opening the documentation');
  assert.doesNotThrow(() => start({ id: 'null', type: 'mcpToolCall', tool: 'read_file', arguments: 'null' }));
  assert.equal(start({ id: 'think', type: 'reasoning', text: 'PRIVATE_REASONING' }), null);
  assert.doesNotMatch(JSON.stringify(browser), /PRIVATE_/);
  const completed = project('backend', { method: 'item/completed', params: { item: { id: 'cmd', type: 'commandExecution', command: 'npm test', exitCode: 1, durationMs: 1250 } } });
  assert.equal(completed.id, 'run:cmd'); assert.equal(completed.phase, 'failed'); assert.equal(completed.durationMs, 1250);
});

test('Claude lifecycles keep stable IDs and internal Core wrappers are not double counted', () => {
  const project = createToolActivityProjector({ sessionId: 'session', runId: 'run', secrets: [] });
  const start = project('backend', { method: 'tool.started', params: { id: 'read', name: 'Read', input: { file_path: 'summary.md', content: 'PRIVATE_FILE' } } });
  const done = project('backend', { method: 'tool.completed', params: { id: 'read', failed: false } });
  assert.equal(start.label, 'Read file'); assert.equal(start.detail, 'summary.md'); assert.equal(done.id, start.id);
  assert.equal(done.phase, 'completed'); assert.doesNotMatch(JSON.stringify(start), /PRIVATE_FILE/);
  assert.equal(project('backend', { method: 'tool.started', params: { id: 'core', name: 'mcp__bzzy_goal__read_skill', input: {} } }), null);
  assert.equal(project('backend', { method: 'tool.completed', params: { id: 'core' } }), null);
});

test('complete values are scrubbed before command previews are shortened', () => {
  const secret = 'fixture-secret-binding', project = createToolActivityProjector({ sessionId: 'session', runId: 'run', secrets: [secret] });
  const action = project('backend', { method: 'tool.started', params: { id: 'cmd', name: 'Bash', input: {
    command: `curl --password "${secret}" -H 'Authorization: Bearer ${secret}' https://example.test/?token=${secret}`, env: { PRIVATE_KEY: secret },
  } } });
  assert.doesNotMatch(JSON.stringify(action), /fixture-secret-binding|PRIVATE_KEY/);
  assert.match(action.detail, /redacted/);
});

test('workers mirror sanitized tool lifecycles durably without changing their original events', () => {
  const previous = process.env.BZZY_HOME, directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-tool-activity-')));
  process.env.BZZY_HOME = path.join(directory, 'private');
  try {
    const parent = createSession(getProvider('codex'), directory), child = createSession(getProvider('codex'), directory);
    const ui = new RunnerUI(child.id, { parentSessionId: parent.id, assignmentId: 'assignment', agent: 'http-reviewer' });
    ui.event('backend', { method: 'item/started', params: { item: { id: 'cmd', type: 'commandExecution', command: 'printf fixture', aggregatedOutput: 'PRIVATE_OUTPUT' } } });
    ui.event('backend', { method: 'item/completed', params: { item: { id: 'cmd', type: 'commandExecution', command: 'printf fixture', exitCode: 0 } } });
    const mirrored = events(parent.id).filter(event => event.type === 'worker.tool');
    assert.equal(mirrored.length, 2); assert.equal(mirrored[0].data.id, mirrored[1].data.id);
    assert.equal(mirrored[0].data.assignmentId, 'assignment'); assert.equal(mirrored[1].data.phase, 'completed');
    assert.equal(mirrored[0].data.actorSessionId, child.id); assert.equal(mirrored[0].data.actorRole, 'subagent');
    assert.equal(mirrored[0].data.actorName, 'http-reviewer');
    assert.doesNotMatch(JSON.stringify(mirrored), /PRIVATE_OUTPUT/);
    assert.equal(events(child.id).filter(event => event.type === 'backend').length, 2);
    const body = '<message version="1"><p>Original worker body.</p></message>';
    ui.event('text', { text: body });
    assert.equal(events(child.id).find(event => event.type === 'text').data.text, body);
    ui.close();
  } finally {
    if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
