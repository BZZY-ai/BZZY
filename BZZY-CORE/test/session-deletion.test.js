import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { BzzyCore } from '../src/core.js';
import { BzzyClient } from '../src/engine/api-client.js';
import { appendEvent, getRecord, putRecord, listRecords, events } from '../src/engine/database.js';
import { loadSession, saveSession, sessionPath, sessions, findSession, writeJson } from '../src/engine/store.js';
import { deleteTerminalConversation, terminalCatalogRevision } from '../src/engine/session-deletion.js';
import { processIdentity, identityAlive } from '../src/engine/process-identity.js';
import { runtimeInfo, runtimeRequest, claimInput } from '../src/engine/runtime.js';
import { createSessionAccess } from '../src/engine/session-access.js';
import { newConversation } from '../src/engine/host-commands.js';

let directory, previousHome, workspace;
test.beforeEach(() => {
  previousHome = process.env.BZZY_HOME;
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-delete-'));
  process.env.BZZY_HOME = path.join(directory, 'private');
  workspace = path.join(directory, 'project'); fs.mkdirSync(workspace);
});
test.afterEach(async () => {
  const info = runtimeInfo();
  if (info && identityAlive(info.identity)) {
    await runtimeRequest(info, 'POST', '/shutdown', {}).catch(() => {});
    for (let i = 0; i < 150 && identityAlive(info.identity); i++) await delay(20);
  }
  if (previousHome === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previousHome;
  fs.rmSync(directory, { recursive: true, force: true });
});
const create = (alias = 'Saved terminal') => new BzzyCore().createConversation({ provider: 'codex', cwd: workspace, alias }, { requestId: randomUUID() });
const remove = id => deleteTerminalConversation(id, { requestId: randomUUID() });

test('deleting a paused terminal removes descendants from saved access, preserving project and audit provenance', () => {
  const root = create(), unrelated = create('Keep this chat'), child = create('Worker');
  putRecord('session', child.id, { ...child, parentSessionId: root.id });
  root.goal = { id: randomUUID(), status: 'paused', objective: 'Historical objective' }; root.executionState = 'paused'; saveSession(root);
  const original = structuredClone(root), body = appendEvent(root.id, 'text', { text: 'Saved private reply' });
  const artifactID = randomUUID(); putRecord('artifact', artifactID, { id: artifactID, sessionId: root.id, sha256: 'fixed-provenance' });
  const file = path.join(workspace, 'keep.txt'); fs.writeFileSync(file, 'Project stays intact');
  const revision = terminalCatalogRevision(), id = randomUUID();
  const result = deleteTerminalConversation(root.id, { requestId: id });
  assert.equal(result.state, 'deleted'); assert.deepEqual(new Set(result.deletedSessionIds), new Set([root.id, child.id]));
  assert.notEqual(terminalCatalogRevision(), revision);
  assert.equal(loadSession(root.id), null); assert.equal(loadSession(child.id), null);
  assert.deepEqual(sessions(fs.realpathSync(workspace)).map(session => session.id), [unrelated.id]);
  assert.throws(() => findSession(root.id), /No matching session/);
  assert.throws(() => saveSession(original), { code: 'SESSION_DELETED' });
  writeJson(sessionPath(root.id), original);
  putRecord('session', root.id, original); // Simulate a legacy writer bypassing saveSession.
  assert.equal(loadSession(root.id), null); assert.equal(sessions(fs.realpathSync(workspace)).some(item => item.id === root.id), false);
  assert.deepEqual(deleteTerminalConversation(root.id, { requestId: id }), result);
  assert.deepEqual(remove(root.id), result);
  assert.equal(terminalCatalogRevision(), getRecord('terminal-catalog', 'current').revision);
  assert.equal(getRecord('session-deletion', child.id).receipt, undefined, 'Child markers must not duplicate an unbounded root receipt');
  assert.throws(() => remove(child.id), { code: 'FORBIDDEN' });
  assert.equal(fs.readFileSync(file, 'utf8'), 'Project stays intact');
  assert.equal(getRecord('artifact', artifactID).sha256, 'fixed-provenance');
  assert.ok(events(root.id).some(event => event.id === body.id), 'Original raw evidence/history remains in the private audit');
  assert.equal(events(root.id).filter(event => event.type === 'session.deleted').length, 1);
  const fresh = newConversation(original, { cwd: workspace });
  assert.ok(fresh.id !== root.id); assert.equal(fresh.alias, undefined); assert.equal(fresh.cwd, root.cwd);
  assert.equal(listRecords('execution').length, 0, 'Deleting or replacing the UI context never starts inference');
});

test('queued, active descendant and live runner work rejects deletion atomically', () => {
  const root = create(), child = create('Child'); putRecord('session', child.id, { ...child, parentSessionId: root.id });
  const job = { id: randomUUID(), sessionId: child.id, state: 'queued' }; putRecord('execution', job.id, job);
  const revision = terminalCatalogRevision();
  assert.throws(() => remove(root.id), { code: 'SESSION_BUSY' });
  assert.equal(terminalCatalogRevision(), revision); assert.equal(getRecord('session-deletion', root.id), null);
  putRecord('execution', job.id, { ...job, state: 'paused' });
  putRecord('run', child.id, { sessionId: child.id, state: 'running', runner: processIdentity() });
  assert.throws(() => remove(root.id), { code: 'SESSION_BUSY' });
  assert.equal(getRecord('session-deletion', child.id), null);
  putRecord('run', child.id, { sessionId: child.id, state: 'interrupted' });
  assert.equal(remove(root.id).state, 'deleted');
});

test('deletion rejects persistent Agent contexts and changed input under an existing request identity', () => {
  const terminal = create(), other = create('Other'), id = randomUUID();
  deleteTerminalConversation(terminal.id, { requestId: id });
  assert.throws(() => deleteTerminalConversation(other.id, { requestId: id }), { code: 'CONFLICT' });
  const agent = create('Agent'); putRecord('session', agent.id, { ...agent, purpose: 'agent' });
  assert.throws(() => remove(agent.id), { code: 'FORBIDDEN' });
  assert.equal(loadSession(agent.id).purpose, 'agent');
  assert.throws(() => deleteTerminalConversation(other.id), /request ID/);
});

test('only local owner can delete; deleted API reads, claims and fresh work stay denied across restart', async () => {
  const core = new BzzyCore(), session = create();
  const observer = createSessionAccess({ sessionId: session.id });
  await core.start();
  const info = runtimeInfo(), scoped = new BzzyClient({ url: info.url, token: observer.token });
  await assert.rejects(scoped.deleteConversation(session.id, { requestId: randomUUID() }), { status: 403 });
  assert.ok(loadSession(session.id));
  const requestId = randomUUID(), receipt = await core.deleteConversation(session.id, { requestId });
  assert.deepEqual(await core.deleteConversation(session.id, { requestId }), receipt);
  await assert.rejects(core.session(session.id), { status: 404, code: 'SESSION_DELETED' });
  await assert.rejects(core.events(session.id), { status: 404, code: 'SESSION_DELETED' });
  await assert.rejects(scoped.session(session.id), { status: 401 });
  assert.throws(() => claimInput(session.id, 'stale-cli'), { code: 'SESSION_DELETED' });
  assert.deepEqual(await core.sessions(), []);
  await runtimeRequest(info, 'POST', '/shutdown', {});
  for (let i = 0; i < 150 && identityAlive(info.identity); i++) await delay(20);
  const restarted = new BzzyCore(); await restarted.start();
  assert.deepEqual(await restarted.deleteConversation(session.id, { requestId }), receipt);
  await assert.rejects(restarted.session(session.id), { status: 404, code: 'SESSION_DELETED' });
  assert.equal(listRecords('execution').length, 0);
});
