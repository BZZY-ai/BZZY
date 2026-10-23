import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CoreAgents } from '../src/agents.js';
import { CoreWorkspaces } from '../src/workspaces.js';
import { createToolBroker } from '../src/tool-broker.js';
import { getRecord, putRecord, listRecords } from '../src/engine/database.js';
import { createSession } from '../src/engine/store.js';
import { BUILTINS } from '../src/engine/providers.js';
import { ToolHost, taskTools } from '../src/engine/tools.js';
import { agentExecutionScope, assertAgentScope, createAgentProjectReader, agentToolNames } from '../src/engine/agent-execution.js';

let directory, savedHome, agents, agent, session, readers;
test.beforeEach(() => {
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-agent-policy-')));
  savedHome = process.env.BZZY_HOME;
  process.env.BZZY_HOME = path.join(directory, 'private');
  new CoreWorkspaces().configure({ path: path.join(directory, 'BZZY'), create: true }, { requestId: randomUUID(), expectedRevision: 0 });
  agents = new CoreAgents();
  agent = agents.create({ name: 'Isolated helper', instructions: 'Work only with approved project information.', provider: 'codex', model: 'offline-fixture', effort: 'default' }, { requestId: randomUUID() });
  session = getRecord('session', agent.sessionId);
  readers = [];
});
test.afterEach(() => {
  for (const reader of readers) try { reader.close(); } catch {}
  if (savedHome === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = savedHome;
  fs.rmSync(directory, { recursive: true, force: true });
});
const child = (parent = session, cwd = parent.cwd) => {
  const value = { ...createSession(BUILTINS.codex, cwd), parentSessionId: parent.id, role: 'executor' };
  putRecord('session', value.id, value);
  return value;
};
const readerFor = value => {
  const reader = createAgentProjectReader(value, agentExecutionScope(value));
  readers.push(reader); return reader;
};

test('only a registered Agent principal and its stored descendants receive the immutable project scope', () => {
  const scope = agentExecutionScope(session);
  assert.deepEqual(scope, { agentId: agent.id, rootSessionId: session.id, cwd: agent.cwd, projectRoot: agent.cwd });
  assert.equal(Object.isFrozen(scope), true);
  const nested = path.join(agent.cwd, 'nested'); fs.mkdirSync(nested);
  const worker = child(), grandchild = child(worker, nested);
  assert.deepEqual(agentExecutionScope(grandchild), { ...scope, cwd: nested });
  assert.deepEqual(assertAgentScope(grandchild, agentExecutionScope(grandchild)), agentExecutionScope(grandchild));
  const terminal = createSession(BUILTINS.codex, directory);
  assert.equal(agentExecutionScope(terminal), null);
  assert.throws(() => assertAgentScope(session, { ...scope, agentId: randomUUID() }), { code: 'FORBIDDEN' });
  assert.throws(() => assertAgentScope({ ...session, projectRoot: directory }, scope), { code: 'FORBIDDEN' });
});

test('orphaned or forged Agent records, parent cycles and directories outside the registered project fail closed', () => {
  for (const marker of [{ purpose: 'agent', agentId: randomUUID() }, { agentId: agent.id }]) {
    const forged = { ...createSession(BUILTINS.codex, directory), ...marker };
    putRecord('session', forged.id, forged);
    assert.throws(() => agentExecutionScope(forged), { code: 'FORBIDDEN' });
  }
  const orphan = child(); putRecord('session', orphan.id, { ...orphan, parentSessionId: randomUUID() });
  assert.throws(() => agentExecutionScope(orphan), { code: 'FORBIDDEN' });
  const one = child(), two = child(one);
  putRecord('session', one.id, { ...one, parentSessionId: two.id });
  assert.throws(() => agentExecutionScope(one), { code: 'FORBIDDEN' });
  assert.throws(() => agentExecutionScope(child(session, directory)), { code: 'FORBIDDEN' });
  const substituted = { ...session, agentId: randomUUID() };
  putRecord('session', session.id, substituted);
  assert.throws(() => agentExecutionScope(substituted), { code: 'FORBIDDEN' });
});

test('the Agent reader returns bounded host observations and denies credentials, traversal, symlinks and hardlinks', async () => {
  fs.writeFileSync(path.join(agent.cwd, 'source.txt'), 'approved project data');
  fs.writeFileSync(path.join(agent.cwd, '.env'), 'private fixture');
  fs.writeFileSync(path.join(agent.cwd, 'auth.json'), 'private fixture');
  fs.mkdirSync(path.join(agent.cwd, '.bzzy')); fs.writeFileSync(path.join(agent.cwd, '.bzzy', 'state.json'), 'private fixture');
  fs.mkdirSync(path.join(agent.cwd, 'private')); fs.writeFileSync(path.join(agent.cwd, 'private', 'account.key'), 'private fixture');
  const outside = path.join(directory, 'outside.txt'); fs.writeFileSync(outside, 'outside fixture');
  fs.symlinkSync(outside, path.join(agent.cwd, 'external-link'));
  fs.symlinkSync(path.join(agent.cwd, 'source.txt'), path.join(agent.cwd, 'internal-link'));
  fs.symlinkSync(directory, path.join(agent.cwd, 'linked-directory'));
  fs.linkSync(outside, path.join(agent.cwd, 'hard-link'));
  const reader = readerFor(session), result = await reader.read({ path: 'source.txt', offset: 9, limit: 7 });
  assert.equal(result.data.content, 'project'); assert.equal(result.data.nextOffset, 16); assert.equal(result.data.truncated, true);
  assert.equal(result.provenance.type, 'host-tool-observation');
  for (const file of ['.env', 'auth.json', '.bzzy/state.json', 'private/account.key', '../outside.txt', outside, 'external-link', 'internal-link', 'linked-directory/outside.txt', 'hard-link']) {
    await assert.rejects(reader.read({ path: file }), { code: 'FORBIDDEN' }, file);
  }
  await assert.rejects(reader.read({ path: 'source.txt', limit: 16385 }), { code: 'INVALID_REQUEST' });
  await assert.rejects(reader.read({ path: 'source.txt', offset: -1 }), { code: 'INVALID_REQUEST' });
  assert.equal(listRecords('execution').length, 0);
});

test('only the Agent adapter can read approved project context while private context paths remain denied', async () => {
  const write = (relative, content) => {
    const file = path.join(agent.cwd, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); return file;
  };
  const readable = [
    ['.bzzy/notes.txt', 'persistent project notes'],
    ['.bzzy/evidence/imported.txt', 'imported evidence is historical context'],
    ['.bzzy/history/conversation.json', '{"body":"original rich message"}'],
  ];
  for (const [relative, content] of readable) write(relative, content);
  for (const relative of ['.bzzy/runtime/owner-token', '.bzzy/history/auth.json', '.bzzy/notes/.env', '.bzzy/artifacts/account.key']) write(relative, 'private fixture');
  const outside = path.join(directory, 'outside.txt'); fs.writeFileSync(outside, 'outside fixture');
  fs.linkSync(outside, path.join(agent.cwd, '.bzzy/evidence/hard-link'));
  fs.symlinkSync(outside, path.join(agent.cwd, '.bzzy/evidence/external-link'));
  const reader = readerFor(session);
  for (const [relative, content] of readable) assert.equal((await reader.read({ path: relative })).data.content, content);
  for (const relative of ['.bzzy/runtime/owner-token', '.bzzy/history/auth.json', '.bzzy/notes/.env', '.bzzy/artifacts/account.key', '.bzzy/evidence/hard-link', '.bzzy/evidence/external-link']) {
    await assert.rejects(reader.read({ path: relative }), { code: 'FORBIDDEN' }, relative);
  }
  const principal = { userId: 'local-owner', workspaceId: 'generic-project', agentId: 'generic-reader' };
  const genericSession = createSession(BUILTINS.codex, agent.cwd), { admin } = createToolBroker();
  const grant = admin.grant({ principal, integrationId: 'filesystem', capabilities: ['filesystem.read'], roots: [{ id: 'project', path: agent.cwd }], expiresAt: Date.now() + 60000 });
  const generic = admin.scope({ principal, sessionId: genericSession.id });
  try {
    for (const [relative] of readable) await assert.rejects(generic.invoke('filesystem.read_file', { root: 'project', path: relative }), { code: 'FORBIDDEN' }, relative);
  } finally { admin.revokeGrant(grant.id); }
});

test('an independently revoked reader cannot borrow another reader permission for the same Agent', async () => {
  fs.writeFileSync(path.join(agent.cwd, 'source.txt'), 'approved project data');
  const first = readerFor(session), second = readerFor(session);
  assert.equal((await first.read({ path: 'source.txt' })).data.content, 'approved project data');
  first.close();
  await assert.rejects(first.read({ path: 'source.txt' }), { code: 'FORBIDDEN' });
  assert.equal((await second.read({ path: 'source.txt' })).data.content, 'approved project data');
  second.close();
  await assert.rejects(second.read({ path: 'source.txt' }), { code: 'FORBIDDEN' });
});

test('archiving the registered Agent immediately denies existing readers and child scope resolution', async () => {
  fs.writeFileSync(path.join(agent.cwd, 'source.txt'), 'approved project data');
  const worker = child(), reader = readerFor(worker);
  assert.equal((await reader.read({ path: 'source.txt' })).data.content, 'approved project data');
  agents.archive({ agentId: agent.id, expectedRevision: 1 }, { requestId: randomUUID() });
  await assert.rejects(reader.read({ path: 'source.txt' }), { code: 'FORBIDDEN' });
  assert.throws(() => agentExecutionScope(worker), { code: 'FORBIDDEN' });
  assert.equal(fs.existsSync(path.join(agent.cwd, 'source.txt')), true);
});

test('a saved child principal change denies a stale in-memory scope before another file read', async () => {
  fs.writeFileSync(path.join(agent.cwd, 'source.txt'), 'approved project data');
  const worker = child(), scope = agentExecutionScope(worker), reader = readerFor(worker);
  putRecord('session', worker.id, { ...worker, cwd: directory });
  assert.throws(() => assertAgentScope(worker, scope), { code: 'FORBIDDEN' });
  await assert.rejects(reader.read({ path: 'source.txt' }), { code: 'FORBIDDEN' });
});

test('direct ToolHost calls cannot bypass persistent Agent tool authorization', async () => {
  const scoped = { ...session, mode: 'delegate', bestiesSessionId: randomUUID(), peers: [{ sessionId: randomUUID() }] };
  const available = taskTools(scoped).map(tool => tool.name);
  assert.ok(available.includes('read_project_file'));
  assert.ok(available.every(name => agentToolNames.has(name)));
  const host = new ToolHost(scoped, {});
  for (const name of ['http_request', 'record_evidence', 'read_artifact', 'peer_message', 'peer_inbox', 'peer_status', 'delegate', 'followup_assignment', 'apply_assignment', 'shell', 'bash', 'exec', 'write_file']) {
    await assert.rejects(host.call(name, { url: 'http://127.0.0.1:1', path: path.join(directory, 'outside.txt') }), { code: 'FORBIDDEN' }, name);
  }
  fs.writeFileSync(path.join(agent.cwd, 'source.txt'), 'approved project data');
  assert.equal((await host.call('read_project_file', { path: 'source.txt' })).data.content, 'approved project data');
  await host.close();
  assert.equal(listRecords('artifact').length, 0); assert.equal(listRecords('assignment').length, 0); assert.equal(listRecords('execution').length, 0);
});

test('memory inputs cannot fingerprint credentials or hardlinks and imported private inputs become stale without a read', async t => {
  const safeFile = path.join(agent.cwd, 'source.txt'); fs.writeFileSync(safeFile, 'approved source fixture');
  const privateFiles = ['.env', 'auth.json', 'hard-link'];
  fs.writeFileSync(path.join(agent.cwd, '.env'), 'private fixture');
  fs.writeFileSync(path.join(agent.cwd, 'auth.json'), 'private fixture');
  const outside = path.join(directory, 'outside.txt'); fs.writeFileSync(outside, 'outside fixture');
  fs.linkSync(outside, path.join(agent.cwd, 'hard-link'));
  const host = new ToolHost(session, {});
  try {
    for (const input of privateFiles) {
      await assert.rejects(host.call('remember', { kind: 'hypothesis', statement: 'Untrusted input fixture', inputs: [input] }));
      assert.equal(listRecords('memory').length, 0, input);
      assert.equal(fs.existsSync(path.join(agent.cwd, '.bzzy/memory')), false, input);
    }
    const safe = await host.call('remember', { kind: 'hypothesis', statement: 'Safe project input', inputs: ['source.txt'] });
    assert.equal(listRecords('memory').length, 1); assert.equal(safe.inputs[0].path, 'source.txt'); assert.equal(safe.inputs[0].sha256.length, 64);
    const base = { project: agent.cwd, sessionId: session.id, kind: 'hypothesis', rationale: '', createdAt: new Date().toISOString(),
      inputs: privateFiles.map(file => ({ path: file, sha256: safe.inputs[0].sha256 })) };
    const forged = { ...base, id: randomUUID(), statement: 'Forged private input' };
    putRecord('memory', forged.id, forged);
    const imported = { ...base, id: randomUUID(), statement: 'Imported private input' };
    fs.writeFileSync(path.join(agent.cwd, '.bzzy/memory', imported.id + '.json'), JSON.stringify(imported));
    const protectedPaths = new Set(privateFiles.map(file => path.join(agent.cwd, file))), attemptedPrivateReads = [];
    let safeReads = 0;
    const originalRead = fs.readFileSync;
    const readSpy = t.mock.method(fs, 'readFileSync', function(file, ...args) {
      const target = typeof file === 'string' ? path.resolve(file) : null;
      if (protectedPaths.has(target)) { attemptedPrivateReads.push(target); throw new Error('Private fixture must not be read.'); }
      if (target === safeFile) safeReads++;
      return Reflect.apply(originalRead, this, [file, ...args]);
    });
    let recalled;
    try { recalled = await host.call('recall', { query: '', limit: 10 }); } finally { readSpy.mock.restore(); }
    assert.deepEqual(attemptedPrivateReads, []); assert.ok(safeReads > 0);
    assert.equal(recalled.find(item => item.id === safe.id).stale, false);
    for (const id of [forged.id, imported.id]) {
      const item = recalled.find(value => value.id === id);
      assert.equal(item.stale, true); assert.deepEqual(item.staleInputs, privateFiles);
    }
    assert.equal(recalled.find(item => item.id === imported.id).provenance, 'project-file');
  } finally { await host.close(); }
});
