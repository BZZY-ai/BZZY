import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSession, saveSession } from '../src/engine/store.js';
import { getProvider } from '../src/engine/providers.js';
import { initializeProject } from '../src/engine/project.js';
import { getRecord, putRecord } from '../src/engine/database.js';
import { contextFor } from '../src/engine/recovery.js';
import { agentInstructions } from '../src/engine/instructions.js';

let root, previous, parent, worker;
test.beforeEach(() => {
  previous = process.env.BZZY_HOME;
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-worker-context-')));
  process.env.BZZY_HOME = path.join(root, 'private');
  const project = path.join(root, 'project'), workspace = path.join(root, 'worker-copy');
  fs.mkdirSync(project); fs.mkdirSync(workspace);
  parent = createSession(getProvider('codex'), project, 'offline-parent'); initializeProject(parent); saveSession(parent);
  worker = createSession(getProvider('codex'), workspace, 'offline-worker');
  Object.assign(worker, { parentSessionId: parent.id, projectRoot: project, assignmentId: randomUUID(), assignmentRound: 3,
    contract: { objective: 'Review the selected offline comparison.', context: 'Mandatory current assignment instruction. '.repeat(300) + 'CONTRACT_TAIL',
      constraints: ['Keep the original permitted target and all excluded actions.'], scope: { allowedTargets: ['offline.example.invalid'] } },
    missionContext: { brief: { instructions: 'Pinned parent instruction. '.repeat(400) + 'MISSION_TAIL', independent: true } },
    assignmentContext: { id: 'original-context-request', revision: 2, state: 'answered', round: 3,
      questions: [{ id: 'control', question: 'Which saved control is permitted?' }],
      answers: [{ questionId: 'control', text: 'Use only the selected offline artifact.', evidence: [] }] },
    policy: { mode: 'read-only', network: 'disabled' }, allowedArtifactIds: [randomUUID()], allowedSkillIds: ['project:fixture:review'] });
  putRecord('artifact', worker.allowedArtifactIds[0], { id: worker.allowedArtifactIds[0], sessionId: parent.id,
    label: 'Explicitly shared offline control', size: 42, sha256: 'a'.repeat(64) });
  putRecord('worker-report', worker.id, { summary: 'PREVIOUS_WORKER_REPORT', evidence: [] });
  fs.writeFileSync(path.join(project, '.bzzy', 'constraints.json'), JSON.stringify({ constraints: ['UNPINNED_LIVE_PARENT_INSTRUCTION'] }));
});
test.afterEach(() => {
  if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
  fs.rmSync(root, { recursive: true, force: true });
});

for (const role of ['executor', 'reviewer']) test(`${role} compact context preserves pinned authority and never reads live parent constraints`, () => {
  worker.role = role; saveSession(worker);
  const before = JSON.parse(contextFor(worker));
  const compact = JSON.parse(contextFor(worker, { compactDerived: true, goalMode: false }));
  assert.deepEqual(compact, before);
  assert.deepEqual(compact.contract, worker.contract); assert.deepEqual(compact.mission, worker.missionContext.brief);
  assert.deepEqual(compact.policy, worker.policy); assert.deepEqual(compact.allowedArtifactIds, worker.allowedArtifactIds);
  assert.deepEqual(compact.allowedSkillIds, worker.allowedSkillIds);
  assert.equal(compact.assignmentId, worker.assignmentId); assert.equal(compact.assignmentRound, 3);
  assert.equal(compact.contextRequest.id, 'original-context-request');
  assert.equal(compact.contextRequest.answers[0].text, 'Use only the selected offline artifact.');
  assert.match(JSON.stringify(compact.previousReport), /PREVIOUS_WORKER_REPORT/);
  if (role === 'reviewer') assert.equal(compact.fixedSnapshot, true);
  else assert.equal(compact.selectedEvidence[0].id, worker.allowedArtifactIds[0]);
  assert.doesNotMatch(JSON.stringify(compact), /UNPINNED_LIVE_PARENT_INSTRUCTION/);
  // A changed or malformed live parent file must not affect this pinned worker
  // handoff. Runtime policy and explicit mission updates remain separate gates.
  fs.writeFileSync(path.join(parent.cwd, '.bzzy', 'constraints.json'), '{malformed live parent metadata');
  const instructions = agentInstructions(worker, { goalMode: true, compactDerived: true });
  assert.match(instructions, /CONTRACT_TAIL/); assert.match(instructions, /MISSION_TAIL/);
  assert.match(instructions, /original-context-request/); assert.match(instructions, /PREVIOUS_WORKER_REPORT/);
  assert.doesNotMatch(instructions, /UNPINNED_LIVE_PARENT_INSTRUCTION/);
});

test('whole-goal peers retain current collaboration and its evidence boundary in compact execution', () => {
  parent.goal = { id: randomUUID(), status: 'active', objective: 'Compare the authorized offline controls.' }; saveSession(parent);
  Object.assign(worker, { role: 'bestie', bestiesSessionId: parent.id, goal: parent.goal, agentNamespace: 'fixture-peer' });
  delete worker.assignmentId; delete worker.assignmentRound; saveSession(worker);
  const otherId = randomUUID(), peers = [{ sessionId: worker.id, name: 'first peer' }, { sessionId: otherId, name: 'second peer' }];
  putRecord('besties', parent.id, { goalId: parent.goal.id, peers });
  const messageId = randomUUID();
  putRecord('peer-message', messageId, { id: messageId, groupId: parent.id, goalId: parent.goal.id,
    from: otherId, to: worker.id, seq: 1, text: 'CURRENT_PEER_COORDINATION: retain the offline negative control.', evidence: [] });
  const full = JSON.parse(contextFor(worker)), compact = JSON.parse(contextFor(worker, { compactDerived: true }));
  assert.deepEqual(compact, full); assert.deepEqual(compact.contract, worker.contract);
  assert.equal(compact.collaboration.goalId, parent.goal.id);
  assert.equal(compact.collaboration.inbox[0].id, messageId); assert.equal(compact.collaboration.supported, false);
  assert.match(compact.contextBoundary, /peer claim or agreement alone is not proof/);
  const instructions = agentInstructions(worker, { goalMode: true, compactDerived: true });
  assert.match(instructions, /CURRENT_PEER_COORDINATION/); assert.match(instructions, /peer claim or agreement alone is not proof/);
  assert.equal(getRecord('session', parent.id).goal.status, 'active');
  assert.deepEqual(getRecord('session', worker.id).allowedArtifactIds, worker.allowedArtifactIds);
  parent.goal = { ...parent.goal, id: randomUUID() }; saveSession(parent);
  assert.equal(JSON.parse(contextFor(worker, { compactDerived: true })).collaboration, null);
});
