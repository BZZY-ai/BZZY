import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CoreAgents } from '../src/agents.js';
import { CoreWorkspaces } from '../src/workspaces.js';
import { CoreAssistant } from '../src/assistant.js';
import { getRecord, putRecord, listRecords } from '../src/engine/database.js';
import { createSession } from '../src/engine/store.js';
import { BUILTINS } from '../src/engine/providers.js';
import { agentInstructions } from '../src/engine/instructions.js';

let directory, saved, agents, root;
test.beforeEach(() => {
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-agents-')));
  saved = process.env.BZZY_HOME; process.env.BZZY_HOME = path.join(directory, 'private');
  agents = new CoreAgents(); root = path.join(directory, 'BZZY');
});
test.afterEach(() => {
  if (saved === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = saved;
  fs.rmSync(directory, { recursive: true, force: true });
});
const configure = () => new CoreWorkspaces().configure({ path: root, create: true }, { requestId: randomUUID(), expectedRevision: 0 });
const input = () => ({ name: 'Launch assistant', instructions: 'Keep persistent mission notes; use authorized tools only.', provider: 'codex', model: 'agent-model', effort: 'default' });

test('agents require an explicit root, keep CLI directories and independent coordinator selection', () => {
  assert.equal(agents.status().configured, false); assert.equal(agents.status().scheduling, false);
  assert.throws(() => agents.create(input(), { requestId: randomUUID() }), { code: 'WORKSPACE_SETUP_REQUIRED' });
  configure();
  const external = path.join(directory, 'external'); fs.mkdirSync(external);
  const terminal = createSession(BUILTINS.codex, external);
  const coordinator = new CoreAssistant(); coordinator.configure({ source: 'core', provider: 'claude', model: 'coordinator-model' }, { requestId: randomUUID(), expectedRevision: 0 });
  const agent = agents.create(input(), { requestId: randomUUID() });
  assert.ok(agent.cwd.startsWith(path.join(root, 'Agents') + path.sep));
  assert.equal(fs.lstatSync(agent.cwd).isSymbolicLink(), false); assert.equal(fs.statSync(agent.cwd).mode & 0o777, 0o700);
  assert.equal(getRecord('session', terminal.id).cwd, external);
  assert.equal(coordinator.settings().selection.model, 'coordinator-model');
  assert.equal(getRecord('session', agent.sessionId).purpose, 'agent');
  assert.equal(listRecords('execution').length, 0);
});
test('agent creation retries preserve identity, instructions and chat without starting work', () => {
  configure(); const requestId = randomUUID(), created = agents.create(input(), { requestId });
  assert.deepEqual(agents.create(input(), { requestId }), created);
  assert.equal(listRecords('core.agent').length, 1); assert.equal(listRecords('session').length, 1);
  assert.equal(agents.list().agents[0].instructions, undefined);
  assert.match(agents.get(created.id).instructions, /mission notes/);
  assert.match(agentInstructions(getRecord('session', created.sessionId)), /PERSISTENT AGENT PURPOSE/);
  assert.match(agentInstructions(getRecord('session', created.sessionId)), /mission notes/);
  assert.throws(() => agents.create({ ...input(), name: 'different' }, { requestId }), { code: 'CONFLICT' });
  assert.equal(listRecords('execution').length, 0);
});
test('editing is revisioned, idle-only and keeps history; archive preserves files but denies open', () => {
  configure(); const agent = agents.create(input(), { requestId: randomUUID() });
  const session = getRecord('session', agent.sessionId); putRecord('session', session.id, { ...session, turns: 7, engineThreadId: randomUUID() });
  const inputUpdate = { agentId: agent.id, expectedRevision: 1, instructions: 'Updated persistent task.' }, requestId = randomUUID();
  const updated = agents.update(inputUpdate, { requestId });
  assert.equal(updated.revision, 2); assert.deepEqual(agents.update(inputUpdate, { requestId }), updated);
  assert.equal(getRecord('session', session.id).turns, 7); assert.equal(getRecord('session', session.id).engineThreadId, null);
  assert.throws(() => agents.update(inputUpdate, { requestId: randomUUID() }), { code: 'CONFLICT' });
  const runId = randomUUID(); putRecord('execution', runId, { id: runId, sessionId: session.id, state: 'running' });
  assert.throws(() => agents.archive({ agentId: agent.id, expectedRevision: 2 }, { requestId: randomUUID() }), /still running/);
  putRecord('execution', runId, { id: runId, sessionId: session.id, state: 'completed' });
  const archived = agents.archive({ agentId: agent.id, expectedRevision: 2 }, { requestId: randomUUID() });
  assert.equal(archived.archived, true); assert.deepEqual(agents.list().agents, []);
  assert.throws(() => agents.get(agent.id), { code: 'FORBIDDEN' });
  assert.equal(fs.existsSync(agent.cwd), true);
});
test('agent workspace replacement, arbitrary directories and unsupported schedules fail closed', () => {
  configure();
  for (const extra of [{ cwd: '/outside' }, { path: '../outside' }, { schedule: { every: 1 } }, { credentials: 'private' }]) {
    assert.throws(() => agents.create({ ...input(), ...extra }, { requestId: randomUUID() }), { code: 'INVALID_REQUEST' });
  }
  const agent = agents.create(input(), { requestId: randomUUID() });
  const moved = agent.cwd + '-moved'; fs.renameSync(agent.cwd, moved); fs.symlinkSync(moved, agent.cwd);
  assert.throws(() => agents.get(agent.id), { code: 'WORKSPACE_UNAVAILABLE' });
  const modelCatalog = agents.providers();
  assert.ok(modelCatalog.some(provider => provider.id === 'codex'));
  assert.doesNotMatch(JSON.stringify(modelCatalog), /baseUrl|envKey|credentials|token/);
});
