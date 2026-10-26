import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createExecutionObserver } from '../src/engine/execution-observation.js';
import { processIdentity } from '../src/engine/process-identity.js';

test('runner observations are cached briefly without inventing newer checks or exposing process identities', () => {
  let instant = Date.parse('2026-10-26T00:00:00Z'), checks = 0;
  const observe = createExecutionObserver({ clock: () => instant, alive: () => { checks++; return true; } });
  const job = { id: 'execution-one', state: 'running', runner: { pid: 123, start: 'birth-one' } };
  const first = observe(job); assert.equal(first.runnerAlive, true);
  assert.deepEqual(Object.keys(first).sort(), ['executionId', 'observedAt', 'runnerAlive']);
  instant += 1000; assert.deepEqual(observe(job), first); assert.equal(checks, 1);
  first.runnerAlive = false; assert.equal(observe(job).runnerAlive, true, 'Callers cannot change a cached observation');
  instant += 1100; assert.notEqual(observe(job).observedAt, first.observedAt); assert.equal(checks, 2);
  assert.equal(observe({ ...job, state: 'finished' }).runnerAlive, null);
  assert.equal(observe({ ...job, runner: { pid: 123, start: 'different-birth' } }).runnerAlive, true);
  assert.equal(checks, 3, 'Changed identities bypass the old observation');
});

test('queued, absent, legacy and failed observations never assert that a runner is alive', () => {
  const observe = createExecutionObserver({ alive() { throw new Error('Observation unavailable'); } });
  for (const job of [null, { id: 'queued', state: 'queued' }, { id: 'legacy', state: 'running', runner: { pid: 1, start: 'platform-unverified' } },
    { id: 'unknown', state: 'running', runner: { pid: 1, start: 'birth' } }]) assert.equal(observe(job).runnerAlive, null);
});

test('actual runner liveness changes after exit and a reused birth identity is rejected', { skip: !['darwin', 'linux'].includes(process.platform) }, async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  let instant = Date.now(); const observe = createExecutionObserver({ clock: () => instant });
  try {
    const runner = processIdentity(child.pid), job = { id: 'live-child', state: 'running', runner };
    assert.equal(observe(job).runnerAlive, true);
    assert.equal(observe({ ...job, runner: { ...runner, start: 'different birth' } }).runnerAlive, false);
    const ended = new Promise(resolve => child.once('exit', resolve)); child.kill(); await ended;
    instant += 2100; assert.equal(observe(job).runnerAlive, false);
  } finally { if (child.exitCode == null && child.signalCode == null) child.kill(); }
});
