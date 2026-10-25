import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs, ensureCurrentTerminalSession } from '../src/cli.js';
import { createChatSession } from '@bzzy/core/engine/host-commands.js';
import { getProvider } from '@bzzy/core/engine/providers.js';
import { saveSession } from '@bzzy/core/engine/store.js';
import { listRecords } from '@bzzy/core/engine/database.js';
import { getWorkflow, workflowSelection } from '@bzzy/core/engine/workflows.js';

let directory, previousHome;
test.beforeEach(() => {
  previousHome = process.env.BZZY_HOME;
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-workflow-owner-')));
  process.env.BZZY_HOME = path.join(directory, 'private');
});
test.afterEach(() => {
  if (previousHome === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previousHome;
  fs.rmSync(directory, { recursive: true, force: true });
});
const definition = { name: 'evidence-first', description: 'Preserve the supplied evidence.', instructions: 'Read the complete goal and supplied evidence before acting. Record uncertainty.' };
const terminal = () => createChatSession(getProvider('codex'), { cwd: directory, model: 'offline-fixture' });
function invoke(args, expected = 0) {
  const result = spawnSync(process.execPath, ['bin/bzzy.js', '--json', '--cwd', directory, 'workflows', ...args],
    { cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, BZZY_HOME: process.env.BZZY_HOME }, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, expected, result.stderr + result.stdout);
  return result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).at(-1);
}

test('owner workflow arguments preserve scoped revisions and exact text while general options remain CLI-owned', () => {
  const parsed = parseArgs(['--cwd', directory, 'workflows', 'use', 'evidence-first', '--session', 'session-id', '--revision', '0', '--workflow-revision=1', '--global', '--json']);
  assert.deepEqual(parsed.args, ['workflows', 'use', 'evidence-first', '--session', 'session-id', '--revision', '0', '--workflow-revision', '1', '--global']);
  assert.equal(parsed.options.cwd, directory); assert.equal(parsed.options.json, true); assert.equal(parsed.options.model, undefined);
  assert.deepEqual(parseArgs(['workflows', 'import', 'body.md', '--name=evidence-first', '--description', 'Read the original goal.']).args,
    ['workflows', 'import', 'body.md', '--name', 'evidence-first', '--description', 'Read the original goal.']);
  for (const args of [['workflows', 'use', 'a', '--session'], ['workflows', 'clear', '--revision', '--json'], ['workflows', 'list', '--global=1'], ['workflows', 'list', '--permissions']]) assert.throws(() => parseArgs(args));
});

test('actual workflow owner commands create, import, update, select and clear without a host service or model', () => {
  const file = path.join(directory, 'workflow.json'); fs.writeFileSync(file, JSON.stringify(definition));
  assert.equal(invoke(['create', file, '--global']).result.name, definition.name);
  assert.equal(invoke(['show', definition.name, '--global']).result.revision, 1);
  fs.writeFileSync(file, JSON.stringify({ ...definition, description: 'Updated evidence procedure.' }));
  assert.equal(invoke(['update', file, '--revision', '1', '--global']).result.revision, 2);
  const body = path.join(directory, 'process.md'); fs.writeFileSync(body, 'Start with the original objective. Preserve every supplied requirement.');
  assert.equal(invoke(['import', body, '--name', 'project-process', '--description', 'Project instructions.']).result.scope, 'project');
  assert.equal(invoke(['list']).result.total, 2);
  const session = terminal(); assert.equal(session.goal, null);
  assert.equal(invoke(['use', definition.name, '--session', session.id, '--revision', '0', '--workflow-revision', '2', '--global']).result.selected.version,
    getWorkflow(definition.name, { scope: 'global' }).version);
  assert.equal(invoke(['selection', '--session', session.id]).result.selected.name, definition.name);
  assert.equal(invoke(['clear', '--session', session.id, '--revision', '1']).result.selected, null);
  assert.equal(workflowSelection(session.id).revision, 2);
  invoke(['delete', definition.name, '--revision', '2', '--global']);
  assert.equal(listRecords('execution').length, 0); assert.equal(listRecords('run').length, 0);
  assert.equal(fs.existsSync(path.join(process.env.BZZY_HOME, 'runtime', 'host-service.log')), false);
});

test('workflow session callback uses the already-saved idle terminal before its first goal and never chooses a worker or another chat', () => {
  const session = terminal(), neighbor = terminal(), ui = { sessionId: session.id };
  assert.equal(ensureCurrentTerminalSession(ui).id, session.id); assert.equal(ensureCurrentTerminalSession(ui).goal, null);
  assert.equal(listRecords('session').length, 2);
  ui.sessionId = neighbor.id; assert.equal(ensureCurrentTerminalSession(ui).id, neighbor.id);
  neighbor.parentSessionId = session.id; saveSession(neighbor); ui.activeTab = neighbor.id; ui.sessionId = session.id;
  assert.throws(() => ensureCurrentTerminalSession(ui), { code: 'WORKFLOW_SESSION_UNAVAILABLE' });
  assert.throws(() => ensureCurrentTerminalSession({}), /Open a terminal chat/);
  assert.equal(listRecords('execution').length, 0); assert.equal(listRecords('session').length, 2);
});
