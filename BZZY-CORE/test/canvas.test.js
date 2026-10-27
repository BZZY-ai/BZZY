import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createChatSession } from '../src/engine/host-commands.js';
import { getProvider } from '../src/engine/providers.js';
import { createSession, loadSession, saveSession } from '../src/engine/store.js';
import { claimInput } from '../src/engine/runtime.js';
import { newGoal } from '../src/engine/goals.js';
import { setSessionMode } from '../src/engine/session-operations.js';
import { deleteTerminalConversation } from '../src/engine/session-deletion.js';
import { getRecord, putRecord, listRecords } from '../src/engine/database.js';
import { openCanvas, insertCanvasModel, linkCanvasModels, unlinkCanvasModels, changeCanvasModel, moveCanvasModel, removeCanvasModel, canvasBindings } from '../src/engine/canvas.js';
let directory, previous, root, canvas;
const choice = { provider: 'codex', model: 'fixture-model', effort: 'high', capabilities: null };
const uid = () => randomUUID();
const pause = sessionId => { const session = loadSession(sessionId); session.executionState = 'paused'; saveSession(session); };
test.beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-canvas-')); previous = process.env.BZZY_HOME; process.env.BZZY_HOME = path.join(directory, 'private');
  root = createChatSession(getProvider('codex'), { cwd: directory, modelSelectionRequired: true, alias: 'Canvas' }); canvas = openCanvas(root.id);
});
test.afterEach(() => { if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous; fs.rmSync(directory, { recursive: true, force: true }); });
const insert = () => canvas = insertCanvasModel(root.id, canvas.revision, choice, uid());

test('blank canvas inserts independent model slots idempotently, preserving private state and stable appearances', () => {
  assert.equal(canvas.nodes.length, 0); const request = uid(), revision = canvas.revision;
  canvas = insertCanvasModel(root.id, revision, choice, request);
  assert.equal(canvas.nodes[0].sessionId, root.id); assert.equal(loadSession(root.id).modelSelectionRequired, false);
  assert.deepEqual(insertCanvasModel(root.id, revision, choice, request), canvas);
  assert.deepEqual(openCanvas(root.id), canvas);
  insert(); assert.notEqual(canvas.nodes[0].appearance, canvas.nodes[1].appearance);
  const child = loadSession(canvas.nodes[1].sessionId);
  assert.equal(child.cwd, directory); assert.equal(child.alias, undefined); assert.equal(child.parentSessionId, undefined);
  assert.equal(child.canvasParentId, root.id); assert.equal(child.model, choice.model);
  assert.equal(listRecords('execution').length, 0); assert.equal(listRecords('agent').length, 0);
  assert.throws(() => insertCanvasModel(root.id, revision, choice, uid()), /canvas changed/);
  assert.throws(() => insertCanvasModel(root.id, canvas.revision, { ...choice, model: 'bad\nmodel' }, uid()), /model/);
});

test('companions added or unlinked in a legacy nested canvas retain its saved engagement without a new workspace', () => {
  const nested = path.join(directory, 'nested'); fs.mkdirSync(nested);
  const legacy = createSession(getProvider('codex'), nested, choice.model);
  Object.assign(legacy, { projectRoot: root.projectRoot, projectId: root.projectId, executionState: 'paused',
    mode: 'parallel', parallelAgents: [choice, choice], policy: { mode: 'read-only', writablePaths: [] } });
  saveSession(legacy); let saved = openCanvas(legacy.id); claimInput(legacy.id, 'legacy-owner');
  saved = unlinkCanvasModels(legacy.id, saved.revision, saved.nodes[0].id, 'legacy-owner', uid());
  saved = insertCanvasModel(legacy.id, saved.revision, choice, uid());
  for (const node of saved.nodes.slice(1)) {
    const companion = loadSession(node.sessionId);
    assert.equal(companion.cwd, fs.realpathSync(nested)); assert.equal(companion.projectRoot, root.projectRoot);
    assert.equal(companion.projectId, root.projectId);
  }
  assert.equal(fs.existsSync(path.join(nested, '.bzzy')), false);
  assert.equal(listRecords('execution').length, 0);
});

test('links require a confirmed pause, cannot overlap or cycle, and never resume the goal or change policy', () => {
  insert(); insert(); insert(); const [a, b, c] = canvas.nodes;
  claimInput(a.sessionId, 'owner');
  assert.throws(() => linkCanvasModels(root.id, canvas.revision, a.id, b.id, 'delegate', 'owner', uid()), /Pause/);
  canvas.nodes.forEach(node => pause(node.sessionId));
  const source = loadSession(a.sessionId); source.policy = { mode: 'read-only' }; source.goal = { ...newGoal('Verify an authorized issue'), status: 'paused', tokensUsed: 42 }; saveSession(source);
  canvas = linkCanvasModels(root.id, canvas.revision, a.id, b.id, 'delegate', 'owner', uid());
  const lead = loadSession(a.sessionId); assert.equal(lead.mode, 'delegate'); assert.equal(lead.executionState, 'paused');
  assert.deepEqual(lead.policy, source.policy); assert.equal(lead.goal.id, source.goal.id); assert.equal(lead.goal.status, 'paused'); assert.equal(lead.goal.tokensUsed, 42); assert.equal(lead.executor.model, choice.model);
  assert.throws(() => linkCanvasModels(root.id, canvas.revision, c.id, b.id, 'delegate', 'owner', uid()), /Unlink/);
  assert.throws(() => linkCanvasModels(root.id, canvas.revision, a.id, a.id, 'besties', 'owner', uid()), /different/);
  assert.throws(() => changeCanvasModel(root.id, canvas.revision, a.id, choice, 'owner', uid()), /Unlink/);
  canvas = unlinkCanvasModels(root.id, canvas.revision, a.id, 'owner', uid());
  assert.equal(canvas.groups.length, 0); assert.equal(loadSession(a.sessionId).mode, 'solo'); assert.equal(loadSession(a.sessionId).executionState, 'paused');
  assert.equal(listRecords('execution').length, 0);
});

test('worker bindings use assignment identity and current goal, even when models repeat; external mode changes are stale', () => {
  insert(); insert(); const [a, b] = canvas.nodes; canvas.nodes.forEach(node => pause(node.sessionId)); claimInput(a.sessionId, 'owner');
  canvas = linkCanvasModels(root.id, canvas.revision, a.id, b.id, 'delegate', 'owner', uid());
  const worker = createChatSession(getProvider('codex'), { cwd: directory, model: choice.model });
  putRecord('assignment', uid(), { parentSessionId: a.sessionId, goalId: null, workerSessionId: worker.id });
  assert.equal(canvasBindings(canvas).get(b.id).sessionId, worker.id);
  canvas = unlinkCanvasModels(root.id, canvas.revision, a.id, 'owner', uid()); assert.deepEqual(canvas.nodes[1].threads, [worker.id]);
  canvas = linkCanvasModels(root.id, canvas.revision, a.id, b.id, 'parallel', 'owner', uid());
  const lead = loadSession(a.sessionId); lead.mode = 'solo'; saveSession(lead);
  assert.equal(canvasBindings(canvas).get(b.id).stale, true);
});

test('saved positions reject invalid coordinates; model changes retain character identity and require owner and pause', () => {
  insert(); const node = canvas.nodes[0], appearance = node.appearance;
  canvas = moveCanvasModel(root.id, canvas.revision, node.id, [.2, .7], uid());
  assert.deepEqual(openCanvas(root.id).nodes[0].position, [.2, .7]);
  assert.throws(() => moveCanvasModel(root.id, canvas.revision, node.id, [Infinity, 1], uid()), /position/);
  pause(node.sessionId); claimInput(node.sessionId, 'owner');
  assert.throws(() => changeCanvasModel(root.id, canvas.revision, node.id, choice, 'intruder', uid()), /owner|input|claim/i);
  canvas = changeCanvasModel(root.id, canvas.revision, node.id, { ...choice, model: 'next' }, 'owner', uid());
  assert.equal(canvas.nodes[0].appearance, appearance); assert.equal(loadSession(node.sessionId).model, 'next');
  assert.equal(getRecord('terminal.canvas', root.id).revision, canvas.revision); assert.equal(listRecords('execution').length, 0);
});

test('deleting a canvas checks every companion and worker, including archived characters, without widening grants', () => {
  insert(); insert(); const companion = canvas.nodes[1];
  assert.throws(() => deleteTerminalConversation(companion.sessionId, { requestId: uid() }), /Only terminal/);
  pause(companion.sessionId); canvas = removeCanvasModel(root.id, canvas.revision, companion.id, uid());
  assert.equal(canvas.nodes.length, 1); assert.equal(canvas.archivedNodes.length, 1);
  const jobId = uid(); putRecord('execution', jobId, { id: jobId, sessionId: companion.sessionId, state: 'queued' });
  assert.throws(() => deleteTerminalConversation(root.id, { requestId: uid() }), /Stop or pause/);
  putRecord('execution', jobId, { id: jobId, sessionId: companion.sessionId, state: 'cancelled' });
  const receipt = deleteTerminalConversation(root.id, { requestId: uid() });
  assert.deepEqual(new Set(receipt.deletedSessionIds), new Set([root.id, companion.sessionId]));
});

test('a phone or minimal terminal can configure a solo slot; reopening projects the real selections without inference', () => {
  insert(); pause(root.id); claimInput(root.id, 'owner'); const current = loadSession(root.id);
  setSessionMode(root.id, 'owner', { mode: 'delegate', expectedUpdatedAt: current.updatedAt, selection: { supervisor: choice, executor: { ...choice, model: 'actual-hands' } } });
  const projected = openCanvas(root.id);
  assert.equal(projected.nodes.length, 2); assert.equal(projected.groups[0].mode, 'delegate');
  assert.equal(canvasBindings(projected).get(projected.nodes[1].id).selection.model, 'actual-hands');
  assert.deepEqual(openCanvas(root.id), projected); assert.equal(listRecords('execution').length, 0);
});
