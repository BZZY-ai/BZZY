import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runtimeInfo, runtimeRequest } from '../src/runtime.js';
import { identityAlive } from '../src/recovery.js';
import { listRecords, appendEvent, getRecord } from '../src/database.js';
import { saveWorkflow, workflowSelection } from '@bzzy/core/engine/workflows.js';
import { parseArgs } from '../src/cli.js';
import { createChatSession } from '@bzzy/core/engine/host-commands.js';
import { getProvider } from '@bzzy/core/engine/providers.js';
import { loadSession, saveSession } from '@bzzy/core/engine/store.js';
import { newGoal } from '@bzzy/core/engine/goals.js';
import { terminalYolo } from '@bzzy/core/engine/terminal-permissions.js';

let directory, previous;
const keys = ['BZZY_HOME', 'BZZY_DIRECT'];
test.beforeEach(() => {
  previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bz-at-')));
  process.env.BZZY_HOME = path.join(directory, 'private'); process.env.BZZY_DIRECT = '1';
  fs.mkdirSync(path.join(directory, 'first')); fs.mkdirSync(path.join(directory, 'second'));
});
test.afterEach(async () => {
  const info = runtimeInfo();
  if (info && identityAlive(info.identity)) await runtimeRequest(info, 'POST', '/shutdown', {}).catch(() => {});
  for (let count = 0; count < 100 && info && identityAlive(info.identity); count++) await new Promise(resolve => setTimeout(resolve, 20));
  for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  fs.rmSync(directory, { recursive: true, force: true });
});
const invoke = (folder, args) => spawnSync(process.execPath, ['bin/bzzy.js', '--json', '--cwd', path.join(directory, folder), ...args],
  { cwd: path.resolve(import.meta.dirname, '..'), env: process.env, encoding: 'utf8', timeout: 15000 });

test('actual --attach name creates once, then replays the same saved chat from a different cwd without inference', async () => {
  const first = invoke('first', ['--attach', 'daily-review', '--provider', 'codex', '--model', 'offline-fixture']);
  assert.equal(first.status, 0, first.stderr); assert.match(first.stdout, /Created session daily-review/);
  const session = listRecords('session')[0]; assert.equal(session.alias, 'daily-review'); assert.equal(session.cwd, path.join(directory, 'first'));
  appendEvent(session.id, 'text', { text: 'Retain this saved answer.' });
  const second = invoke('second', ['--attach', 'daily-review']); assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /Retain this saved answer/); assert.doesNotMatch(second.stdout, /Created session/);
  assert.equal(listRecords('session').length, 1); assert.equal(listRecords('execution').length, 0);
  assert.equal(listRecords('session')[0].model, 'offline-fixture'); assert.equal(listRecords('session')[0].goal, null);
});

test('--view remains read-only lookup and never creates a missing named session', () => {
  const missing = invoke('first', ['--view', 'missing-name']);
  assert.notEqual(missing.status, 0); assert.match(missing.stderr + missing.stdout, /No matching session/);
  assert.equal(listRecords('session').length, 0); assert.equal(listRecords('execution').length, 0);
});

test('actual --workflow selects on a new named chat, reuses it and clears with none', () => {
  const workflow = saveWorkflow({ name: 'evidence-review', instructions: 'Inspect supplied controls before conclusions.' }, { scope: 'global' });
  const first = invoke('first', ['--attach', 'workflow-chat', '--workflow', workflow.name, '--provider', 'codex', '--model', 'offline-fixture']);
  assert.equal(first.status, 0, first.stderr); const session = listRecords('session')[0];
  assert.equal(workflowSelection(session.id).selected.id, workflow.id); assert.equal(listRecords('execution').length, 0);
  const second = invoke('second', ['--attach', 'workflow-chat', '--workflow=none']); assert.equal(second.status, 0, second.stderr);
  assert.equal(workflowSelection(session.id).selected, null); assert.equal(listRecords('session').length, 1);
  const missing = invoke('first', ['--attach', 'bad-workflow-chat', '--workflow', 'not-here']);
  assert.notEqual(missing.status, 0); assert.equal(listRecords('session').length, 1);
});

test('workflow parsing accepts an explicit name and rejects contradictory view/resume selections', () => {
  assert.equal(parseArgs(['--workflow', 'evidence-review']).options.workflow, 'evidence-review');
  assert.equal(parseArgs(['--workflow=none']).options.workflow, 'none');
  for (const args of [['--workflow'], ['--workflow', 'a', '--view', 'saved'], ['--workflow', 'a', '--resume', 'saved'], ['resume', 'saved', '--workflow', 'a'], ['goal', 'resume', '--workflow', 'a']]) assert.throws(() => parseArgs(args));
});

test('actual --attach --yolo reopens a saved read-only parent, stays on and leaves its review child read-only', async () => {
  const parent = createChatSession(getProvider('codex'), { cwd: path.join(directory, 'first'), model: 'offline-fixture', alias: 'yolo-parent' });
  parent.goal = { ...newGoal('Preserve this saved objective'), status: 'paused', evidence: ['saved-evidence'] };
  parent.contract = { objective: parent.goal.objective, context: 'Saved context.', scope: { allowedTargets: ['fixture.invalid'] },
    policy: { mode: 'read-only', network: 'disabled', writablePaths: [] } }; parent.policy = parent.contract.policy; parent.strictPolicy = true; saveSession(parent);
  const child = createChatSession(getProvider('codex'), { cwd: path.join(directory, 'first'), model: 'offline-fixture' });
  Object.assign(child, { parentSessionId: parent.id, role: 'reviewer', contract: { policy: { mode: 'read-only', network: 'disabled', writablePaths: [] } } }); saveSession(child);
  const first = invoke('second', ['--attach', 'yolo-parent', '--yolo']); assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /YOLO on/); assert.equal(terminalYolo(parent.id), true); assert.equal(getRecord('terminal-permissions', parent.id).yolo, true);
  assert.equal(loadSession(parent.id).contract.policy.mode, 'workspace-write'); assert.equal(loadSession(parent.id).contract.policy.network, 'disabled');
  assert.deepEqual(loadSession(parent.id).goal, parent.goal); assert.equal(terminalYolo(child.id), false);
  const second = invoke('second', ['--attach', 'yolo-parent', '--yolo']); assert.equal(second.status, 0, second.stderr);
  assert.equal(terminalYolo(parent.id), true); assert.equal(listRecords('terminal-policy-change').length, 1);
  const info = runtimeInfo(), snapshot = await runtimeRequest(info, 'GET', `/sessions/${parent.id}`);
  assert.equal(snapshot.permissions.yolo, true); assert.equal(listRecords('execution').length, 0);
  const isolated = invoke('second', ['--attach', child.id, '--yolo']); assert.notEqual(isolated.status, 0);
  assert.equal(terminalYolo(child.id), false); assert.equal(loadSession(child.id).contract.policy.mode, 'read-only');
});
