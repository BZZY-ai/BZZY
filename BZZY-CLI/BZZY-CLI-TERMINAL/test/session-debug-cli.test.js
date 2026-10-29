import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createSession, saveSession, loadSession } from '../src/store.js';
import { BUILTINS } from '../src/providers.js';
import { database, appendEvent } from '../src/database.js';
import { persistOperatorStopIntent, operatorStopRequested, runtimeInfo } from '../src/runtime.js';

const binary = fileURLToPath(new URL('../bin/bzzy.js', import.meta.url));
test('a separate CLI exports a saved running session into the caller folder without starting stopped Core or replaying work', () => {
  const before = process.env.BZZY_HOME, directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-debug-cli-')));
  try {
    process.env.BZZY_HOME = path.join(directory, 'private');
    const original = path.join(directory, 'original-project'), current = path.join(directory, 'current-folder'); fs.mkdirSync(original); fs.mkdirSync(current);
    const session = createSession(BUILTINS.deepseek, original, 'saved-deepseek', 'nine-hour-session');
    session.executionState = 'running'; saveSession(session); appendEvent(session.id, 'text', { text: 'SAVED_EXISTING_SESSION_HISTORY' });
    persistOperatorStopIntent();
    const state = database().prepare('SELECT * FROM records ORDER BY kind,id').all(), events = database().prepare('SELECT * FROM events ORDER BY seq').all();
    const run = spawnSync(process.execPath, [binary, 'debug', 'export', session.alias, '--json'], { cwd: current, env: process.env, encoding: 'utf8', timeout: 15000 });
    assert.equal(run.status, 0, run.stderr + run.stdout);
    const result = run.stdout.trim().split('\n').map(JSON.parse).find(event => event.type === 'debug.exported'); assert.ok(result);
    const output = result.data?.outputPath || result.outputPath;
    assert.equal(path.dirname(output), current); assert.match(path.basename(output), /^nine-hour-session_debug_\d{8}\.md$/);
    assert.match(fs.readFileSync(output, 'utf8'), /SAVED_EXISTING_SESSION_HISTORY/);
    assert.equal(loadSession(session.id).executionState, 'running'); assert.equal(runtimeInfo(), null); assert.equal(operatorStopRequested(), true);
    assert.deepEqual(database().prepare('SELECT * FROM records ORDER BY kind,id').all(), state);
    assert.deepEqual(database().prepare('SELECT * FROM events ORDER BY seq').all(), events);
    assert.deepEqual(fs.readdirSync(original), []);
    const full = spawnSync(process.execPath, [binary, 'full_debug_export', session.alias, '--json'], { cwd: current, env: process.env, encoding: 'utf8', timeout: 15000 });
    assert.equal(full.status, 0, full.stderr + full.stdout);
    assert.match(full.stderr, /Full debug ZIP.*elapsed/); assert.match(full.stderr, /Packaging ZIP/);
    assert.doesNotMatch(full.stderr, /SAVED_EXISTING_SESSION_HISTORY/);
    assert.ok(full.stdout.trim().split('\n').every(line => JSON.parse(line).type === 'debug.exported'), 'Progress must not pollute JSON stdout.');
    const fullResult = full.stdout.trim().split('\n').map(JSON.parse).find(event => event.type === 'debug.exported');
    const fullData = fullResult.data || fullResult; assert.equal(fullData.full, true); assert.equal(path.dirname(fullData.outputPath), current);
    assert.match(path.basename(fullData.outputPath), /^nine-hour-session_full_debug_\d{8}\.zip$/);
    assert.equal(runtimeInfo(), null); assert.equal(operatorStopRequested(), true); assert.equal(loadSession(session.id).executionState, 'running');
    assert.deepEqual(database().prepare('SELECT * FROM records ORDER BY kind,id').all(), state);
    assert.deepEqual(database().prepare('SELECT * FROM events ORDER BY seq').all(), events);
    const failedFull = spawnSync(process.execPath, [binary, 'debug', 'full', session.alias, path.basename(fullData.outputPath), '--json'],
      { cwd: current, env: process.env, encoding: 'utf8', timeout: 15000 });
    assert.notEqual(failedFull.status, 0); assert.equal(failedFull.signal, null, 'Failed export exits without a progress timer keeping it alive.');
    assert.match(failedFull.stderr, /Full debug ZIP.*elapsed/); assert.match(failedFull.stderr, /SESSION_DEBUG_EXISTS/);
    assert.ok(failedFull.stdout.trim().split('\n').filter(Boolean).every(line => JSON.parse(line).type !== 'debug.exported'));
    assert.deepEqual(database().prepare('SELECT * FROM records ORDER BY kind,id').all(), state);
    assert.deepEqual(database().prepare('SELECT * FROM events ORDER BY seq').all(), events);
    const bad = spawnSync(process.execPath, [binary, 'debug', 'export', '--json'], { cwd: current, env: process.env, encoding: 'utf8', timeout: 15000 });
    assert.notEqual(bad.status, 0); assert.match(bad.stderr, /bzzy debug export SESSION/); assert.equal(runtimeInfo(), null);
  } finally {
    if (before === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = before;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
