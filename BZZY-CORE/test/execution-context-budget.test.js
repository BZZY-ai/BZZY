import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSession, saveSession } from '../src/engine/store.js';
import { getProvider } from '../src/engine/providers.js';
import { initializeProject, projectConstraintsForExecution } from '../src/engine/project.js';
import { putRecord, getRecord } from '../src/engine/database.js';
import { contextFor, readTaskStateDetails } from '../src/engine/recovery.js';
import { agentInstructions } from '../src/engine/instructions.js';
import { newGoal } from '../src/engine/goals.js';

let root, previous, session;
test.beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-execution-context-')));
  previous = process.env.BZZY_HOME; process.env.BZZY_HOME = path.join(root, 'private');
  const cwd = path.join(root, 'project'); fs.mkdirSync(cwd);
  session = createSession(getProvider('codex'), cwd, 'offline-fixture'); initializeProject(session);
  session.goal = newGoal('Preserve the complete authorized original goal.');
  session.executionState = 'running'; saveSession(session);
});
test.afterEach(() => { if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous; fs.rmSync(root, { recursive: true, force: true }); });
const durable = instructions => JSON.parse(instructions.split('DURABLE TASK CONTEXT:\n').at(-1));
function detail(section, state, context) {
  let nextOffset = 0, sourceRevision, text = '';
  do {
    const page = readTaskStateDetails(session, { section, revision: state.revision, offset: nextOffset, limit: 8192,
      ...(sourceRevision ? { sourceRevision } : {}) }, context);
    text += page.text; sourceRevision = page.sourceRevision; nextOffset = page.nextOffset;
  } while (nextOffset !== null);
  return JSON.parse(text);
}

test('compact execution instructions preserve all mandatory source and replace huge derived history with revisioned navigation', () => {
  const runId = randomUUID(), context = { goalMode: true, runId };
  putRecord('run', session.id, { id: runId, sessionId: session.id, state: 'running', goalMode: true });
  const originalContext = `ORIGINAL INSTRUCTIONS\n${'Keep every user requirement exactly. '.repeat(230)}\nBZZY HOST-PINNED WORKFLOW\n<workflow-instructions>\n${'Retain every scope boundary and evidence gate. '.repeat(120)}\n</workflow-instructions>\n`;
  const scope = { allowedTargets: ['https://owned.example.invalid'], excludedTargets: ['https://excluded.example.invalid'], allowedActions: ['offline fixtures'], excludedActions: ['production changes'], accountReferences: ['owner-gateway-reference'], cleanupObligations: ['Remove owned test objects.'] };
  const projectConstraints = { version: 1, constraints: ['全ての前提🙂'.repeat(1000)], scope: { ...scope,
    excludedTargets: Array.from({ length: 140 }, (_, index) => `https://excluded-${index}.example.invalid`) } };
  fs.writeFileSync(path.join(session.projectRoot, '.bzzy', 'constraints.json'), JSON.stringify(projectConstraints));
  session.contract = { ...session.contract, objective: session.goal.objective, context: originalContext, constraints: ['All original contract constraints.'], scope };
  session.policy = { mode: 'read-only', network: 'disabled', writablePaths: [] };
  session.pendingInput = [{ id: randomUUID(), text: 'Current owner restriction: retain this complete steering text. '.repeat(40) }];
  saveSession(session);
  const recovery = { sessionId: session.id, state: 'reconciled', createdAt: new Date().toISOString(), automaticallyReplayed: false,
    workspaceChanges: Array.from({ length: 1200 }, (_, index) => ({ path: `ordinary-source/${index}.txt`, before: null, after: { sha256: String(index).padStart(64, '0'), size: index }, observation: 'DERIVED-RECOVERY-ONLY '.repeat(20) })),
    workspaceOmissions: Array.from({ length: 400 }, (_, index) => ({ path: `historical-report-${index}.md`, reason: 'bzzy_debug_artifact' })) };
  putRecord('recovery', session.id, recovery);
  for (let index = 0; index < 35; index++) {
    const id = randomUUID();
    putRecord('memory', id, { id, sessionId: session.id, projectId: session.projectId, project: session.projectRoot,
      kind: 'observation', truth: 'observed', statement: `HISTORICAL-NOTE-${index} ` + 'Derived historical memory only. '.repeat(300), evidence: [], inputs: [], createdAt: new Date().toISOString() });
  }
  const full = contextFor(session, context), compact = agentInstructions(session, context);
  assert.ok(Buffer.byteLength(full) > 700000); assert.ok(Buffer.byteLength(compact) < Buffer.byteLength(full) / 8);
  const parsed = durable(compact);
  assert.deepEqual(parsed.contract, session.contract); assert.equal(parsed.contract.context, originalContext);
  assert.deepEqual(parsed.policy, session.policy); assert.deepEqual(parsed.projectContext.constraints, projectConstraints);
  assert.deepEqual(parsed.pendingInput, session.pendingInput);
  assert.equal(parsed.currentState.recovery.workspaceChangeCount, 1200); assert.equal(parsed.currentState.recovery.workspaceOmissionCount, 400);
  assert.doesNotMatch(compact, /DERIVED-RECOVERY-ONLY|HISTORICAL-NOTE-/);
  assert.equal(parsed.derivedHistory.compacted, true); assert.equal(parsed.derivedHistory.details.tool, 'read_task_state_details');
  assert.deepEqual(detail('contract', parsed.currentState, context), session.contract);
  assert.deepEqual(detail('recovery', parsed.currentState, context), recovery);
  assert.ok(detail('projectContext', parsed.currentState, context).notes.some(item => item.statement.startsWith('HISTORICAL-NOTE-')));
  const normal = durable(agentInstructions(session, context)), explicit = durable(agentInstructions(session, { ...context, compactDerived: true }));
  delete normal.currentState.executionBudget.observedAt; delete explicit.currentState.executionBudget.observedAt;
  assert.deepEqual(normal, explicit, 'Default execution now uses the bounded projection.');
  assert.deepEqual(getRecord('recovery', session.id), recovery, 'Projection does not rewrite durable observations.');
});

test('compact execution reads project constraints without loading historical project directories', () => {
  const directory = path.join(session.projectRoot, '.bzzy', 'memory'); fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${randomUUID()}.json`), JSON.stringify({ sessionId: session.id, statement: 'Historical file should be fetched only through details.' }));
  const readdir = fs.readdirSync; let historyReads = 0;
  fs.readdirSync = (file, ...args) => { if (String(file).includes(path.join('.bzzy', 'memory'))) historyReads++; return readdir(file, ...args); };
  try {
    const compact = JSON.parse(contextFor(session, { compactDerived: true, goalMode: true }));
    assert.ok(compact.projectContext.constraints); assert.equal(historyReads, 0);
    contextFor(session); assert.ok(historyReads > 0, 'The unchanged full path still loads historical project context.');
  } finally { fs.readdirSync = readdir; }
});

test('full context samples project notes after the same bounded migration used by recall', () => {
  session.goal.objective='RELATION_SNAPSHOT';saveSession(session);
  for(let index=0;index<35;index++) {
    const id=`00000000-0000-4000-8000-${String(index).padStart(12,'0')}`;
    putRecord('memory',id,{id,sessionId:session.id,projectId:session.projectId,project:session.projectRoot,
      kind:'hypothesis',truth:'hypothesis',statement:'RELATION_SNAPSHOT historical fixture',evidence:[],inputs:[],revision:1,createdAt:'2026-01-01T00:00:00Z'});
  }
  for(const expectedCoverage of ['backfill-pending','complete']) {
    const snapshot=JSON.parse(contextFor(session));
    const notes=new Map(snapshot.projectContext.notes.map(item=>[item.id,item]));
    const overlap=snapshot.relevantMemory.filter(item=>notes.has(item.id));
    assert.ok(overlap.length>0);
    for(const memory of overlap) {
      assert.equal(memory.relationshipCoverage,expectedCoverage);
      assert.equal(notes.get(memory.id).relationshipCoverage,memory.relationshipCoverage);
      assert.equal(notes.get(memory.id).stale,memory.stale);
      assert.equal(notes.get(memory.id).truth,memory.truth);
    }
  }
});

test('worker compact execution retains complete immutable mission, bounded assignment contract and actual runtime grants', () => {
  const parent = createSession(getProvider('codex'), session.cwd, 'offline-parent'); initializeProject(parent); saveSession(parent);
  session.role = 'executor'; session.parentSessionId = parent.id; session.assignmentId = randomUUID(); session.assignmentRound = 3;
  session.goal = null; session.missionContext = { brief: `FULL CURRENT MISSION\n${'Retain the parent constraint and original scope. '.repeat(220)}` };
  session.allowedArtifactIds = [randomUUID(), randomUUID()]; session.allowedSkillIds = ['project:fixture:review'];
  session.policy = { mode: 'read-only', network: 'disabled' }; saveSession(session);
  putRecord('assignment', session.assignmentId, { id: session.assignmentId, workerSessionId: session.id, parentSessionId: session.parentSessionId, currentRound: 3, closure: 'open' });
  const compact = JSON.parse(contextFor(session, { compactDerived: true, goalMode: false }));
  assert.equal(compact.mission, session.missionContext.brief); assert.deepEqual(compact.contract, session.contract);
  assert.deepEqual(compact.policy, session.policy); assert.deepEqual(compact.allowedArtifactIds, session.allowedArtifactIds);
  assert.deepEqual(compact.allowedSkillIds, session.allowedSkillIds); assert.equal(compact.assignmentRound, 3);
});

test('compact project constraints use existing privacy policy without arbitrary string/array clipping or symlink reads', () => {
  const constraints = { version: 1, constraints: ['A'.repeat(9000)], scope: { excludedTargets: Array.from({ length: 150 }, (_, index) => `https://excluded-${index}.example.invalid`) },
    ownerToken: 'private-value-must-not-reach-model' };
  const file = path.join(session.projectRoot, '.bzzy', 'constraints.json'); fs.writeFileSync(file, JSON.stringify(constraints));
  const { ownerToken, ...permitted } = constraints;
  assert.deepEqual(projectConstraintsForExecution(session.projectRoot, { session }).constraints, permitted);
  fs.writeFileSync(file, JSON.stringify({ constraints: ['Keep the surrounding rule. password="first\\\"private\nsecond-private\nlast-private" End rule.'] }));
  const masked = projectConstraintsForExecution(session.projectRoot, { session }).constraints.constraints[0];
  assert.match(masked, /Keep the surrounding rule/); assert.match(masked, /End rule/); assert.doesNotMatch(masked, /first|second-private|last-private/);
  fs.linkSync(file, path.join(root, 'linked-constraints.json'));
  assert.throws(() => projectConstraintsForExecution(session.projectRoot, { session }), /without links/);
  fs.unlinkSync(file); fs.symlinkSync(path.join(root, 'private-auth-file.json'), file);
  fs.writeFileSync(path.join(root, 'private-auth-file.json'), JSON.stringify({ privateData: 'DO-NOT-READ' }));
  assert.throws(() => projectConstraintsForExecution(session.projectRoot, { session }), /symlinks/);
  const read = fs.readFileSync; let privateReads = 0;
  fs.readFileSync = (source, ...args) => { if (source === file || source === path.join(root, 'private-auth-file.json')) privateReads++; return read(source, ...args); };
  try { assert.throws(() => agentInstructions(session, { goalMode: true }), /symlinks/); assert.equal(privateReads, 0); }
  finally { fs.readFileSync = read; }
});

test('restricted compact guidance advertises only existing Core navigation without widening tools', () => {
  const instructions = agentInstructions(session, { goalMode: true, compactDerived: true, agentScope: { isolated: true } });
  const projected = durable(instructions);
  assert.equal(projected.currentState.details, undefined); assert.equal(projected.derivedHistory.details, undefined);
  assert.deepEqual(projected.derivedHistory.navigation.tools, ['get_task_state', 'recall', 'search_knowledge']);
  assert.doesNotMatch(JSON.stringify(projected), /read_task_state_details|assignment_status|list_assignments/);
});
