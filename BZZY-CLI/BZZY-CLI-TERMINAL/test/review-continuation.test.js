import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createSession, sessionPath } from '../src/store.js';
import { BUILTINS, saveConfig } from '../src/providers.js';
import { listRecords, putRecord } from '../src/database.js';
import { RunnerUI } from '../src/runtime-ui.js';
import { snapshotWorkspace } from '../src/evidence.js';
import { assessGroupCompletion } from '../src/verification.js';
import { normalizeContract } from '../src/contracts.js';
import { newGoal } from '../src/goals.js';
import { runtimeFile, runtimeRequest } from '../src/runtime.js';
import { processIdentity } from '../src/process-identity.js';
import { writeJson } from '../src/files.js';
import { Coordinator } from '../src/coordination.js';
import { sandboxSupport } from '../src/policy.js';

let directory, previous;
test.beforeEach(() => {
  directory = fs.realpathSync(fs.mkdtempSync('/tmp/bz-rc-')); previous = process.env.BZZY_HOME;
  process.env.BZZY_HOME = path.join(directory, 'state');
  fs.mkdirSync(path.join(directory, 'project'));
});
test.afterEach(() => {
  if (previous == null) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
  fs.rmSync(directory, { recursive: true, force: true });
});
const session = () => createSession(BUILTINS.codex, path.join(directory, 'project'));

test('invalid input timeout cannot leave a pending approval or waiting session behind', async () => {
  const s = session(); saveConfig({ version: 1, inputTimeoutSeconds: 0 });
  await assert.rejects(new RunnerUI(s.id).approve('Run command?'), /inputTimeoutSeconds/);
  assert.deepEqual(listRecords('question', { sessionId: s.id }), []);
});

test('failed snapshot copying removes the incomplete workspace', t => {
  const s = session(); fs.writeFileSync(path.join(s.cwd, 'app.txt'), 'original');
  t.mock.method(fs, 'copyFileSync', () => { throw new Error('Fixture copy failed'); });
  assert.throws(() => snapshotWorkspace(s), /Fixture copy failed/);
  assert.deepEqual(fs.readdirSync(path.join(process.env.BZZY_HOME, 'snapshots')), []);
  assert.deepEqual(listRecords('snapshot'), []);
});

test('group integration honors the recorded snapshot limits for large changed files', async () => {
  const parent = session(); parent.mode = 'parallel'; parent.goal = newGoal('Update binary');
  parent.contract = normalizeContract({}, 'Update binary');
  saveConfig({ version: 1, snapshotLimits: { maxFileMiB: 24, maxTotalMiB: 30 } });
  const file = path.join(parent.cwd, 'asset.bin');
  fs.writeFileSync(file, Buffer.alloc(21 * 1024 * 1024, 1));
  const snapshot = snapshotWorkspace(parent), work = path.join(directory, 'peer');
  fs.cpSync(snapshot.directory, work, { recursive: true });
  fs.writeFileSync(path.join(work, 'asset.bin'), Buffer.alloc(21 * 1024 * 1024, 2));
  const child = createSession(BUILTINS.codex, work); child.goal = newGoal('Update binary');
  child.goal.status = 'complete'; child.acceptance = { passed: true };
  putRecord('parallel', parent.id, { snapshotId: snapshot.id });
  assert.equal((await assessGroupCompletion(parent, [child])).integrated, false);
  fs.copyFileSync(path.join(work, 'asset.bin'), file);
  assert.equal((await assessGroupCompletion(parent, [child])).passed, true);
});

test('a safe runtime retry follows a replacement service and preserves its request', async t => {
  const stale = { url: 'http://127.0.0.1:1', token: 'old-fixture' };
  const replacement = { url: 'http://127.0.0.1:2', token: 'new-fixture', identity: processIdentity() };
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) { writeJson(runtimeFile(), replacement); throw new TypeError('fetch failed'); }
    return new Response(JSON.stringify({ ok: true }));
  });
  assert.deepEqual(await runtimeRequest(stale, 'POST', '/sessions/fixture/control', { action: 'pause' }, 'same-request'), { ok: true });
  assert.equal(calls[1].url, replacement.url + '/sessions/fixture/control');
  assert.equal(calls[1].options.headers.authorization, 'Bearer old-fixture');
  assert.equal(calls[1].options.headers['idempotency-key'], 'same-request');
  assert.equal(calls[1].options.body, calls[0].options.body);
});

test('a runtime request without an idempotency guarantee is not retried', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new TypeError('fetch failed'); });
  await assert.rejects(runtimeRequest({ url: 'http://127.0.0.1:1', token: 'fixture' }, 'POST', '/tokens', {}), /fetch failed/);
  assert.equal(calls, 1);
});

test('a failed coordinator initialization releases its session lock', { skip: !sandboxSupport() }, t => {
  const s = session(); s.mode = 'parallel'; s.goal = newGoal('Check project');
  const coordinator = new Coordinator(s, { event() {} }, {}), mkdir = fs.mkdirSync;
  t.mock.method(fs, 'mkdirSync', (target, ...args) => {
    if (target === path.join(s.cwd, '.bzzy')) throw new Error('Fixture project is unwritable');
    return mkdir(target, ...args);
  });
  assert.throws(() => coordinator.start(), /Fixture project is unwritable/);
  assert.equal(fs.existsSync(sessionPath(s.id) + '.lock'), false);
});

test('a failed coordinator result write releases its session lock', { skip: !sandboxSupport() }, async t => {
  const s = session(); s.mode = 'parallel'; s.goal = newGoal('Check project');
  const coordinator = new Coordinator(s, { event() {} }, {}); coordinator.start();
  const write = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (target, ...args) => {
    if (typeof target === 'string' && target.endsWith('.txt')) throw new Error('Fixture evidence write failed');
    return write(target, ...args);
  });
  await assert.rejects(coordinator.finish('complete', {}, { totalTokens: 0, complete: true, agents: [] }), /Fixture evidence write failed/);
  assert.equal(fs.existsSync(sessionPath(s.id) + '.lock'), false);
});
