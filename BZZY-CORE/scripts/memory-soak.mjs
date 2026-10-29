import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createSession, saveSession, loadSession } from '../src/engine/store.js';
import { getProvider } from '../src/engine/providers.js';
import { database, appendEvent, putRecord, getRecord, transaction } from '../src/engine/database.js';
import { initializeProject, issue } from '../src/engine/project.js';
import { artifact } from '../src/engine/evidence.js';
import { checkpoint } from '../src/engine/memory.js';
import { recordWorkObservation } from '../src/engine/episode.js';
import { updateInvestigation } from '../src/engine/session-investigation.js';
import { compactTaskState } from '../src/engine/recovery.js';
import { maintainSessionHistory } from '../src/engine/history-maintenance.js';
import { pauseAllSessionCompactions, recoverSessionCompactions, processSessionCompactions } from '../src/engine/session-compactor.js';
import { pauseAllLearning, recoverLearningJobs } from '../src/engine/learning.js';
import { sessionMemoryDocument } from '../src/engine/session-memory-document.js';

const options = Object.fromEntries(process.argv.slice(2).map(arg => {
  const match = /^--(cycles|hours)=(\d+(?:\.\d+)?)$/.exec(arg);
  if (!match) throw new Error('Use --cycles=500 and optionally --hours=5|10|15. This uses isolated synthetic data and no model/network.');
  return [match[1], Number(match[2])];
}));
const cycles = options.cycles ?? 500, hours = options.hours ?? 0;
if (!Number.isSafeInteger(cycles) || cycles < 1 || cycles > 1000000 || hours < 0 || hours > 24) throw new Error('Use 1–1000000 cycles and 0–24 wall-clock hours.');
const originalHome = process.env.BZZY_HOME, root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-memory-soak-')));
process.env.BZZY_HOME = path.join(root, 'private');
const latencies = [], maintenance = [], started = performance.now();
let completed = 0, sourceBytes = 0, lastProgress = started;
try {
  const cwd = path.join(root, 'fake-program'); fs.mkdirSync(cwd);
  let session = createSession(getProvider('codex'), cwd, 'offline-fixture', 'fake-program-session'); initializeProject(session);
  session.goal = { id: randomUUID(), status: 'active', objective: 'Find new unreported fictional Orbit bulletin findings.', tokensUsed: 0 };
  session.contract = { objective: session.goal.objective, constraints: ['Offline synthetic data only.'], scope: { allowedTargets: [] } };
  session.executionState = 'running'; saveSession(session);
  const context = { goalMode: true, runId: 'soak-run' };
  putRecord('run', session.id, { id: context.runId, sessionId: session.id, goalId: session.goal.id, goalMode: true, state: 'running' });
  const proof = artifact(session, 'Fictional prior report', 'Offline fictional report package.');
  const priorFinding = issue(session, { title: 'Orbit bulletin finding already reported', status: 'resolved', details: 'Historical report, not new progress.', evidence: [proof.id] });
  issue(session, { title: 'Orbit bulletin finding verification blocked', status: 'blocked', details: 'Separate contradictory claim; preserve both source IDs.' });
  let branch = updateInvestigation(session, { action: 'declare', requestId: 'branch', hypothesis: 'Check the fictional parser.', dependencies: [{ kind: 'session_input' }] }, context);
  branch = updateInvestigation(session, { action: 'block', requestId: 'block', id: branch.id, expectedRevision: branch.revision,
    blocker: { key: 'fixture', kind: 'owner_input', resolver: 'owner', description: 'Missing fixture.', affectedWork: 'Parser branch.', neededChange: 'Supply the fixture.' } }, context);
  while (completed < cycles || performance.now() - started < hours * 3600000) {
    const i = completed++;
    const text = `Synthetic turn ${i}: Orbit bulletin historical finding is already reported. Missing parser fixture remains an unchanged blocker. ` + 'Keep exact source identifiers and uncertainty. '.repeat(10);
    appendEvent(session.id, i % 2 ? 'text' : 'message.user', { text }); sourceBytes += Buffer.byteLength(text);
    const observed = recordWorkObservation(session, { runId: context.runId, itemId: `item-${i}`, kind: 'command', name: 'shell', command: 'offline-fixture check', output: 'Fixture missing.', exitCode: 1 });
    assert.equal(recordWorkObservation(session, { runId: context.runId, itemId: `item-${i}`, kind: 'command', name: 'shell', command: 'offline-fixture check', output: 'Fixture missing.', exitCode: 1 }).id, observed.id);
    if (i % 20 === 0) checkpoint(session, { pendingActions: ['Await permitted fixture or select another useful branch.'], evidence: [proof.id], blockerIds: [branch.blockers[0].id], requestId: `checkpoint-${i}` }, context);
    let at = performance.now(); maintainSessionHistory(session); maintenance.push(performance.now() - at);
    if (i % 25 === 0) {
      pauseAllSessionCompactions('host_shutdown'); pauseAllLearning('host_shutdown'); recoverSessionCompactions(); recoverLearningJobs();
      session = loadSession(session.id);
      await processSessionCompactions({ runModel: () => assert.fail('No paid model requests in this soak.'), authAvailable: async () => false });
      session.nativeContext = { threadRef: 'synthetic-thread', epoch: Math.floor(i / 25) }; saveSession(session);
    }
    at = performance.now(); const state = compactTaskState(session, {}, context); latencies.push(performance.now() - at);
    assert.ok(Buffer.byteLength(JSON.stringify(state)) <= 8192);
    assert.ok(state.knowledgeBrief.items.some(item => item.sourceId === priorFinding.id), 'Already reported finding remains delivered.');
    assert.equal(compactTaskState(session, { knownRevision: state.revision, contextGeneration: state.contextGeneration }, context).notModified, true);
    if (i % 100 === 0) {
      assert.throws(() => transaction(db => { putRecord('memory-soak-fault', 'rollback', { unexpected: true }, db); throw new Error('injected-write-failure'); }), /injected-write-failure/);
      assert.equal(getRecord('memory-soak-fault', 'rollback'), null);
      assert.equal(sessionMemoryDocument(session).sessionId, session.id);
    }
    if (performance.now() - lastProgress > 60000) { process.stderr.write(`Synthetic memory soak: ${completed} cycles; ${Math.round((performance.now() - started) / 1000)}s elapsed.\n`); lastProgress = performance.now(); }
    if (hours > 0) await new Promise(resolve => setTimeout(resolve, 1000));
  }
  const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))];
  assert.equal(database().prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  console.log(JSON.stringify({ passed: true, cycles: completed, elapsedSeconds: (performance.now() - started) / 1000, sourceBytes,
    taskStateP95Ms: percentile(latencies, .95), maintenanceP95Ms: percentile(maintenance, .95),
    limits: { synthetic: true, modelCalls: 0, targetsContacted: false, restartMode: 'lifecycle recovery functions', wallClockHoursRequested: hours,
      provesLiveAutonomy: false, injectedDiskFull: false, databaseProcessCrash: false } }, null, 2));
} finally {
  if (originalHome === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = originalHome;
  fs.rmSync(root, { recursive: true, force: true });
}
