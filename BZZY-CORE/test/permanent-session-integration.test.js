import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSession, saveSession } from '../src/engine/store.js';
import { getProvider } from '../src/engine/providers.js';
import { initializeProject } from '../src/engine/project.js';
import { putRecord, appendEvent } from '../src/engine/database.js';
import { checkpoint } from '../src/engine/memory.js';
import { checkpointConstraintView } from '../src/engine/checkpoint-items.js';
import { ToolHost, taskTools } from '../src/engine/tools.js';
import { compactTaskState } from '../src/engine/recovery.js';

test('permanent session delivers branch blockers through the pull path and keeps old goals historical', async () => {
  const prior = process.env.BZZY_HOME, root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-permanent-')));
  process.env.BZZY_HOME = path.join(root, 'private');
  try {
    const cwd = path.join(root, 'fake-program'); fs.mkdirSync(cwd);
    const session = createSession(getProvider('codex'), cwd, 'offline-fixture', 'fake-program-session'); initializeProject(session);
    session.goal = { id: randomUUID(), objective: 'Review the offline program fixture.', status: 'active' };
    session.contract = { objective: session.goal.objective, constraints: ['Do not send live traffic.'] }; session.executionState = 'running'; saveSession(session);
    const context = { runId: 'first-run', goalMode: true }, stops = [];
    putRecord('run', session.id, { id: context.runId, sessionId: session.id, goalId: session.goal.id, goalMode: true, state: 'running' });
    const host = new ToolHost(session, {}, { ...context, onInvestigationBlocked: value => stops.push(value) });
    assert.ok(taskTools(session).some(tool => tool.name === 'update_investigation'));
    const unit = await host.executeTool('update_investigation', { action: 'declare', requestId: 'branch', hypothesis: 'Check the saved parser fixture.', dependencies: [{ kind: 'session_input' }] });
    const blocked = await host.executeTool('update_investigation', { action: 'block', requestId: 'block', id: unit.id, expectedRevision: unit.revision, blockGoal: true,
      blocker: { key: 'fixture', kind: 'owner_input', resolver: 'owner', description: 'The fixture is missing.', affectedWork: 'Parser verification.', neededChange: 'Supply the permitted fixture.' } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stops.length, 1); assert.equal(stops[0].requiresExecutionStop, true);
    const state = compactTaskState(session, {}, context);
    assert.equal(state.investigation.branches[0].blockers[0].id, blocked.blockers[0].id);
    assert.equal(compactTaskState(session, { knownRevision: state.revision, contextGeneration: state.contextGeneration }, context).notModified, true);
    appendEvent(session.id, 'message.user', { text: 'The permitted offline fixture is now available.' });
    assert.equal(compactTaskState(session, {}, context).investigation.branches[0].blockers[0].dependencyChanged, true);
    const current = checkpoint(session, { itemOperations: [{ op: 'add', field: 'pendingActions', text: 'Inspect the newly supplied fixture.' }] }, context);
    const owned = current.items.find(item => item.contractOwned);
    assert.throws(() => checkpoint(session, { itemOperations: [{ op: 'archive', field: 'constraints', id: owned.id, expectedItemRevision: owned.revision }] }, context), /Contract-owned/);
    const action = current.items.find(item => item.field === 'pendingActions');
    checkpoint(session, { itemOperations: [{ op: 'archive', field: action.field, id: action.id, expectedItemRevision: action.revision }] }, context);
    const restored = checkpoint(session, { itemOperations: [{ op: 'add', field: action.field, id: action.id, text: action.value }] }, context);
    assert.ok(restored.items.find(item => item.id === action.id).revision > action.revision);
    assert.throws(() => checkpoint(session, { itemOperations: [{ op: 'update', field: action.field, id: action.id,
      expectedItemRevision: action.revision, text: 'A stale writer must not change the restored action.' }] }, context), /item changed/);
    const constraints = checkpointConstraintView(['Only /Admin', 'Only /admin', 'Do not test A', 'Do test A', 'Only /Admin']);
    assert.equal(constraints.length, 4); assert.equal(constraints[0].count, 2);
    session.goal = { ...session.goal, id: randomUUID() }; saveSession(session);
    const next = compactTaskState(session, {}, { ...context, runId: 'second-run' });
    assert.equal(next.checkpoint, null); assert.equal(next.investigation.branches.length, 0);
    assert.equal(next.investigation.historicalCount, 1); assert.equal(next.scope.sessionId, session.id);
  } finally { if (prior === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = prior; fs.rmSync(root, { recursive: true, force: true }); }
});
