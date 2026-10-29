import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createSession, saveSession, loadSession } from '../src/store.js';
import { BUILTINS } from '../src/providers.js';
import { database, listRecords, getRecord, appendEvent } from '../src/database.js';
import { persistOperatorStopIntent, operatorStopRequested, runtimeInfo } from '../src/runtime.js';
import { parseArgs } from '../src/cli.js';
import { debugExportJob, debugExportJobKind, reconcileDebugExportJobs } from '@bzzy/core/engine/debug-export-jobs.js';
import { signalProcess } from '@bzzy/core/engine/process-identity.js';

const binary = fileURLToPath(new URL('../bin/bzzy.js', import.meta.url));
const run = (args, cwd, env = process.env) => spawnSync(process.execPath, [binary, ...args, '--json'], { cwd, env, encoding: 'utf8', timeout: 10_000 });
const event = (result, type) => { const row = result.stdout.trim().split('\n').filter(Boolean).map(JSON.parse).find(row => row.type === type); return row?.data || row; };

test('the full-debug flag is a detached full export and preserves bounded/explicit foreground forms', () => {
  const parsed = parseArgs(['--full-debug-export', 'program-session', '--bounded']);
  assert.deepEqual(parsed.args, ['debug', 'full', 'program-session']);
  assert.equal(parsed.options.detach, true); assert.equal(parsed.options.debugBounded, true);
  assert.equal(parseArgs(['--json', '--full-debug-export', 'program-session']).options.detach, true);
  assert.equal(parseArgs(['debug', 'full', 'program-session', '--detach']).options.detach, true);
  assert.equal(parseArgs(['debug', 'full', 'program-session']).options.detach, undefined);
});

test('a real detached CLI validates names, returns before capture ends, survives the launcher and saves completion', async () => {
  const previous = process.env.BZZY_HOME, directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-detached-export-')));
  const gate = path.join(directory, 'release'), current = path.join(directory, 'caller'), tools = path.join(directory, 'bin');
  let jobId;
  try {
    process.env.BZZY_HOME = path.join(directory, 'private');
    const project = path.join(directory, 'project'); fs.mkdirSync(project); fs.mkdirSync(current); fs.mkdirSync(tools);
    const session = createSession(BUILTINS.deepseek, project, 'saved-deepseek', 'fake-program-session');
    session.executionState = 'running'; saveSession(session); appendEvent(session.id, 'text', { text: 'SAVED_HUNT_HISTORY' });
    persistOperatorStopIntent();
    const saved = getRecord('session', session.id), events = database().prepare('SELECT * FROM events ORDER BY seq').all();
    const unknown = run(['--full-debug-export', 'no-such-session'], current);
    assert.notEqual(unknown.status, 0); assert.match(unknown.stderr, /No matching session/);
    assert.equal(listRecords(debugExportJobKind).length, 0); assert.equal(runtimeInfo(), null);
    fs.writeFileSync(path.join(tools, 'python3'), '#!/bin/sh\nwhile [ ! -f "$BZZY_FIXTURE_EXPORT_GATE" ]; do /bin/sleep 0.05; done\nexec /usr/bin/python3 "$@"\n', { mode: 0o700 });
    const env = { ...process.env, BZZY_FIXTURE_EXPORT_GATE: gate, PATH: tools + path.delimiter + process.env.PATH };
    const launched = run(['--full-debug-export', session.alias, 'detached.zip'], current, env);
    assert.equal(launched.status, 0, launched.stderr + launched.stdout); assert.equal(fs.existsSync(gate), false);
    const started = event(launched, 'debug.export.started'); assert.ok(started); jobId = started.id;
    assert.match(started.message, /close this terminal/); assert.match(started.message, /iPhone push queue/);
    assert.ok(['queued', 'running'].includes(debugExportJob(jobId).state));
    assert.equal(fs.readdirSync(current).filter(name => name.endsWith('.zip')).length, 0, 'The launcher exited before ZIP packaging was allowed.');
    fs.writeFileSync(path.join(current, 'detached.zip'), 'IN_PROGRESS_FIXTURE');
    const same = run(['debug', 'full', session.alias, 'detached.zip', '--detach'], current, env);
    assert.equal(same.status, 0, same.stderr); assert.equal(event(same, 'debug.export.started').id, jobId);
    assert.equal(event(same, 'debug.export.started').existing, true); assert.equal(listRecords(debugExportJobKind).length, 1);
    fs.unlinkSync(path.join(current, 'detached.zip'));
    const busy = run(['--full-debug-export', session.alias, 'another.zip'], current, env);
    assert.notEqual(busy.status, 0); assert.match(busy.stderr, /already running/);
    const live = run(['debug', 'status', jobId], current); assert.equal(live.status, 0, live.stderr);
    assert.ok(['queued', 'running'].includes(event(live, 'debug.export.status').state));
    fs.writeFileSync(gate, 'release');
    const deadline = Date.now() + 15_000;
    while (['queued', 'running'].includes(debugExportJob(jobId).state) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    const completed = run(['debug', 'status', jobId], current);
    assert.equal(completed.status, 0, completed.stderr); const job = event(completed, 'debug.export.status');
    assert.equal(job.state, 'completed', JSON.stringify(job.error)); assert.equal(path.dirname(job.result.outputPath), current);
    assert.ok(fs.statSync(job.result.outputPath).size > 0); assert.match(job.message, /ZIP:/);
    assert.equal(listRecords('outbox').filter(row => row.event.type === 'debug.export.completed' && row.event.jobId === jobId).length, 1);
    assert.deepEqual(getRecord('session', session.id), saved); assert.deepEqual(database().prepare('SELECT * FROM events ORDER BY seq').all(), events);
    assert.equal(loadSession(session.id).executionState, 'running'); assert.equal(runtimeInfo(), null); assert.equal(operatorStopRequested(), true);
    const protectedFile = path.join(current, 'keep.zip'); fs.writeFileSync(protectedFile, 'KEEP');
    assert.notEqual(run(['--full-debug-export', session.alias, 'keep.zip'], current).status, 0);
    assert.equal(fs.readFileSync(protectedFile, 'utf8'), 'KEEP');
    assert.equal(listRecords(debugExportJobKind).length, 1);
  } finally {
    fs.writeFileSync(gate, 'release');
    if (jobId) {
      const job = getRecord(debugExportJobKind, jobId);
      if (['queued', 'running'].includes(job?.state)) { signalProcess(job.identity, 'SIGTERM', { group: true }); await new Promise(resolve => setTimeout(resolve, 100)); reconcileDebugExportJobs(); }
    }
    if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a detached failure persists a safe error and one error notification without keeping the terminal attached', async () => {
  const previous = process.env.BZZY_HOME, directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-detached-failure-')));
  try {
    process.env.BZZY_HOME = path.join(directory, 'private');
    const project = path.join(directory, 'project'); fs.mkdirSync(project);
    const session = createSession(BUILTINS.deepseek, project, 'saved-deepseek', 'failure-session');
    const launched = run(['--full-debug-export', session.alias], project, { ...process.env, PATH: path.join(directory, 'PRIVATE_FIXTURE_BINDING') });
    assert.equal(launched.status, 0, launched.stderr + launched.stdout); const id = event(launched, 'debug.export.started').id;
    const deadline = Date.now() + 10_000;
    while (['queued', 'running'].includes(debugExportJob(id).state) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    const job = debugExportJob(id); assert.equal(job.state, 'failed'); assert.equal(job.error.code, 'SESSION_DEBUG_PYTHON');
    assert.equal(job.error.phase, 'packaging'); assert.doesNotMatch(JSON.stringify(job), /PRIVATE_FIXTURE_BINDING/);
    assert.equal(listRecords('outbox').filter(row => row.event.type === 'debug.export.failed' && row.event.jobId === id).length, 1);
    assert.equal(fs.readdirSync(project).filter(name => name.endsWith('.zip')).length, 0); assert.equal(runtimeInfo(), null);
  } finally { if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous; fs.rmSync(directory, { recursive: true, force: true }); }
});
