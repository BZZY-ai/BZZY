import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { withPausedCore } from '../src/engine/installation-update.js';
import { servicePlan, installService, coreHostStatus, suspendCoreHost, beginCoreMaintenance, clearCoreStartFailure,
  snapshotCoreServiceManifest, restoreCoreServiceManifest, startRestoredCoreService } from '../src/engine/host-service.js';
import { coreMaintenanceActive } from '../src/engine/maintenance.js';
import { createSession, saveSession, loadSession } from '../src/engine/store.js';
import { BUILTINS, saveDefaultSelection, saveModeDefault, defaultSelection, modeDefault } from '../src/engine/providers.js';
import { database, putRecord, getRecord, appendEvent, digest } from '../src/engine/database.js';
import { CoreAssistant } from '../src/assistant.js';
import { configureBackgroundModel, backgroundModelSettings } from '../src/engine/background-model.js';
import { createSessionAccess, revokeSessionAccess, sessionPermissions, activeAccess } from '../src/engine/session-access.js';
import { authorizedUpdateGrant } from '../src/engine/update-access.js';
import { setTerminalYolo, terminalYolo } from '../src/engine/terminal-permissions.js';
import { operatorStopRequested, operatorStopIntent, persistOperatorStopIntent, clearOperatorStopIntent } from '../src/engine/runtime.js';

function fixture(t, platform, failReadiness) {
  const previous = process.env.BZZY_HOME, directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-update-state-')));
  const userHome = path.join(directory, 'user'), privateHome = path.join(directory, 'private'), project = path.join(directory, 'project');
  for (const folder of [userHome, privateHome, project]) fs.mkdirSync(folder, { mode: 0o700 });
  process.env.BZZY_HOME = privateHome;
  t.after(() => { if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous; fs.rmSync(directory, { recursive: true, force: true }); });
  const oldCLI = path.join(directory, 'old-cli'), newCLI = path.join(directory, 'new-cli'), bin = path.join(directory, 'bin');
  for (const folder of [oldCLI, newCLI]) {
    fs.mkdirSync(path.join(folder, 'bin'), { recursive: true }); fs.writeFileSync(path.join(folder, 'package.json'), '{}');
    fs.writeFileSync(path.join(folder, 'bin/bzzy-core.js'), '// never executed: isolated update fixture\n', { mode: 0o600 });
  }
  fs.mkdirSync(bin);
  const launchers = ['bzzy', 'bzzy-core'].map(name => path.join(bin, name));
  for (const file of launchers) fs.writeFileSync(file, '# bzzy-managed launcher\nretained old release\n', { mode: 0o755 });
  const accounts = ['codex', 'claude'].map(name => path.join(directory, name));
  for (const folder of accounts) fs.mkdirSync(folder, { mode: 0o700 });
  const credentialFiles = [path.join(privateHome, 'credentials.json'), ...accounts.map(folder => path.join(folder, 'auth.json'))];
  for (const file of credentialFiles) fs.writeFileSync(file, JSON.stringify({ syntheticBinding: 'SYNTHETIC_FIXTURE_ONLY_NOT_A_REAL_CREDENTIAL' }), { mode: 0o600 });
  const plan = entry => servicePlan({ platform, userHome, coreHome: privateHome, entry, env: { PATH: process.env.PATH,
    BZZY_CODEX_HOME: accounts[0], BZZY_CLAUDE_HOME: accounts[1] } });
  const oldPlan = plan(path.join(oldCLI, 'bin/bzzy-core.js')), newPlan = plan(path.join(newCLI, 'bin/bzzy-core.js'));
  const native = { loaded: false, running: false, enabled: false, pid: null }, engine = { running: false, pid: null };
  const managerCalls = [], starts = []; let currentPlan = oldPlan, rollbacks = 0, pauses = 0;
  const nativeRun = (command, args) => {
    assert.equal(command, currentPlan.manager); managerCalls.push(args.join(' '));
    if (args[0] === 'print') {
      if (args[1] === `gui/${oldPlan.uid}`) return { status: 0, stdout: 'user domain available\n' };
      return native.loaded ? { status: 0, stdout: `state = ${native.running ? 'running' : 'waiting'}\n${native.running ? `pid = ${native.pid}\n` : ''}` }
        : { status: 113, stdout: '', stderr: 'No such process' };
    }
    if (args.includes('show')) return { status: 0, stdout: `LoadState=loaded\nActiveState=${native.running ? 'active' : 'inactive'}\nSubState=${native.running ? 'running' : 'dead'}\nMainPID=${native.pid || 0}\nUnitFileState=${native.enabled ? 'enabled' : 'disabled'}\n` };
    if (args.includes('disable')) native.enabled = false;
    if (args.includes('bootout') || args.includes('disable') && args.includes('--now')) {
      Object.assign(native, { loaded: false, running: false, pid: null }); Object.assign(engine, { running: false, pid: null });
    }
    if (args.includes('bootstrap') || args.includes('kickstart') || args.includes('enable') && args.includes('--now')) {
      Object.assign(native, { loaded: true, running: true, enabled: true, pid: 63001 }); Object.assign(engine, { running: true, pid: native.pid });
    }
    return { status: 0, stdout: '' };
  };
  installService(oldPlan, { run: nativeRun });
  Object.assign(native, { loaded: true, running: true, enabled: true, pid: 61001 }); Object.assign(engine, { running: true, pid: native.pid });
  const identity = pid => ({ pid, start: `synthetic-control-${pid}`, boot: 'synthetic-boot' });
  const runtime = { stopped: operatorStopRequested, stopIntent: operatorStopIntent, persistStop: persistOperatorStopIntent, clearStop: clearOperatorStopIntent,
    controlAlive: () => engine.running, controlIdentity: () => engine.running ? identity(engine.pid) : null,
    async status() { return engine.running ? { running: true, pid: engine.pid, version: 'synthetic', apiVersion: 1 } : { running: false }; },
    async quiesce() { pauses++; assert.fail('An update must not pause active executions.'); },
    async shutdown() { Object.assign(engine, { running: false, pid: null }); return { runningAgentsContinue: true }; } };
  const processes = { identity, alive: value => Boolean(native.running && native.pid === value.pid || engine.running && engine.pid === value.pid) };
  const oldManifest = { body: fs.readFileSync(oldPlan.file), mode: fs.statSync(oldPlan.file).mode & 0o777 };
  const retainedLaunchers = launchers.map(file => ({ file, body: fs.readFileSync(file), mode: fs.statSync(file).mode & 0o777 }));
  const lifecycle = {
    beginCoreMaintenance: () => beginCoreMaintenance(privateHome),
    coreHostStatus: () => coreHostStatus({ plan: currentPlan, runtime, run: nativeRun }),
    suspendCoreHost: () => suspendCoreHost({ plan: currentPlan, runtime, run: nativeRun, processes }),
    stopCoreHost: async () => { pauses++; assert.fail('An automatic update must not issue operator Stop.'); },
    snapshotCoreServiceManifest: () => snapshotCoreServiceManifest({ plan: oldPlan }),
    restoreCoreServiceManifest(saved) {
      assert.equal(coreMaintenanceActive(privateHome), true); assert.equal(native.running, false);
      restoreCoreServiceManifest(saved, { plan: currentPlan, run: nativeRun }); currentPlan = oldPlan;
    },
    startRestoredCoreService(saved, options) {
      assert.equal(coreMaintenanceActive(privateHome), false); assert.equal(operatorStopRequested(), false);
      assert.equal(options.respectStop, true); starts.push(path.join(oldCLI, 'bin/bzzy-core.js'));
      return startRestoredCoreService(saved, { ...options, plan: oldPlan, runtime, run: nativeRun, doctor: () => ({ ready: true }), readinessWaitMs: 50 });
    },
    clearCoreStartFailure: attemptId => clearCoreStartFailure(attemptId, { runtime }),
  };
  const run = (command, args, options) => {
    assert.equal(command, process.execPath); assert.equal(args.length, 2); assert.equal(args[1], 'start');
    assert.equal(coreMaintenanceActive(privateHome), false, 'Readiness is checked only after service/launcher activation is consistent');
    assert.equal(options.env.BZZY_CORE_RESPECT_STOP, '1'); assert.match(options.env.BZZY_CORE_START_ATTEMPT_ID, /^[a-f0-9-]{36}$/);
    starts.push(args[0]); const next = args[0] === path.join(newCLI, 'bin/bzzy-core.js');
    assert.equal(args[0], path.join(next ? newCLI : oldCLI, 'bin/bzzy-core.js'));
    assert.equal(fs.readFileSync(currentPlan.file, 'utf8'), (next ? newPlan : oldPlan).manifest);
    Object.assign(native, { loaded: true, running: true, enabled: true, pid: next ? 62001 : 63001 });
    Object.assign(engine, { running: true, pid: native.pid });
    if (next && failReadiness) {
      persistOperatorStopIntent({ source: 'service_start_failure', attemptId: options.env.BZZY_CORE_START_ATTEMPT_ID });
      return { status: 1, stdout: '', stderr: 'Synthetic service readiness failed' };
    }
    assert.equal(operatorStopRequested(), false); return { status: 0, stdout: '' };
  };
  const install = () => {
    assert.equal(coreMaintenanceActive(privateHome), true); assert.equal(native.running, false);
    for (const file of launchers) fs.writeFileSync(file, '# bzzy-managed launcher\nnew release\n', { mode: 0o755 });
    installService(newPlan, { run: nativeRun }); currentPlan = newPlan;
    return { directory: newCLI, code: 0 };
  };
  const rollback = () => {
    rollbacks++; assert.equal(coreMaintenanceActive(privateHome), true); assert.equal(native.running, false);
    for (const saved of retainedLaunchers) { fs.writeFileSync(saved.file, saved.body, { mode: saved.mode }); fs.chmodSync(saved.file, saved.mode); }
  };
  return { privateHome, project, credentialFiles, launchers, oldCLI, newCLI, oldPlan, newPlan, oldManifest, retainedLaunchers,
    lifecycle, run, install, rollback, native, starts, managerCalls, pauses: () => pauses, rollbacks: () => rollbacks };
}

function seedPrivateState(f) {
  saveDefaultSelection({ provider: 'codex', model: 'terminal-sentinel', selectedEffort: 'high' });
  for (const mode of ['delegate', 'debate', 'parallel', 'besties']) saveModeDefault(mode,
    [{ provider: 'codex', model: `${mode}-brain`, effort: 'high' }, { provider: 'claude', model: `${mode}-worker`, effort: 'low' }]);
  new CoreAssistant().configure({ source: 'core', provider: 'claude', model: 'core-coordinator-sentinel', effort: 'high' }, { requestId: randomUUID(), expectedRevision: 0 });
  configureBackgroundModel({ source: 'custom', provider: 'codex', model: 'shared-background-sentinel', effort: 'low' }, { requestId: randomUUID(), expectedRevision: 0 });
  const sessions = ['active', 'paused', 'complete'].map(status => {
    const session = createSession(BUILTINS.codex, f.project, `saved-${status}-model`, `${status} goal`);
    session.goal = { id: randomUUID(), status, objective: `Retain the ${status} controlled task.`, createdAt: new Date().toISOString(), evidence: [], tokensUsed: 1234 };
    session.selectedEffort = 'low'; session.executionState = status === 'active' ? 'running' : status === 'complete' ? 'completed' : 'paused';
    session.policy = { mode: 'workspace-write', network: 'disabled', writablePaths: [f.project] }; saveSession(session);
    appendEvent(session.id, 'message.user', { kind: 'goal', text: session.goal.objective }); return session;
  });
  setTerminalYolo(sessions[2].id, { enabled: true }, randomUUID(), { authorize() {} });
  const runner = { pid: 71001, start: 'synthetic-active-runner', boot: 'synthetic-runner-boot' }, executionId = randomUUID();
  putRecord('run', sessions[0].id, { id: randomUUID(), sessionId: sessions[0].id, state: 'running', runner, goalMode: true });
  putRecord('execution', executionId, { id: executionId, sessionId: sessions[0].id, state: 'running', runner, goal: true, options: { provider: 'codex', effort: 'low' } });
  appendEvent(sessions[0].id, 'execution.started', { id: executionId, provider: 'codex' });
  const grant = createSessionAccess({ sessionId: sessions[0].id, permissions: [...sessionPermissions], recipient: 'synthetic-owner-phone', includeChildren: false });
  const revoked = createSessionAccess({ sessionId: sessions[0].id, permissions: [...sessionPermissions], recipient: 'synthetic-revoked-phone', includeChildren: false }); revokeSessionAccess(revoked.id);
  const phone = { id: randomUUID(), peerId: 'synthetic-owner-phone', hostId: 'synthetic-host', peerDigest: digest({ synthetic: true }),
    resource: 'base-resource', sessionId: sessions[0].id, token: grant.token, coreGrantId: grant.id, sessionAccess: true, agentAccess: true,
    shareAccess: true, permissions: [...sessionPermissions], expiresAt: grant.expiresAt };
  putRecord('core.relay.pin', phone.peerId, { certificate: { synthetic: true }, hostId: phone.hostId }); putRecord('core.relay.grant', phone.id, phone);
  putRecord('core.relay.grant', revoked.id, { ...phone, id: revoked.id, coreGrantId: revoked.id, token: revoked.token, revokedAt: new Date().toISOString() });
  assert.ok(authorizedUpdateGrant(phone.id));
  return { sessions, runner, executionId, grant, revoked, phone };
}

function privateSnapshot(f) {
  // Compare logical records, not SQLite/WAL bytes. Hash private values so a
  // failed sentinel assertion never prints even synthetic account bindings.
  const db = database();
  return { records: digest(db.prepare('SELECT kind,id,data,updated_at FROM records ORDER BY kind,id').all()),
    events: digest(db.prepare('SELECT * FROM events ORDER BY seq').all()), requests: digest(db.prepare('SELECT * FROM requests ORDER BY scope,id').all()),
    files: [...f.credentialFiles, path.join(f.privateHome, 'config.json')].map(file => ({ hash: digest(fs.readFileSync(file)), mode: fs.statSync(file).mode & 0o777 })),
    solo: defaultSelection('codex'), modes: Object.fromEntries(['delegate', 'debate', 'parallel', 'besties'].map(mode => [mode, modeDefault(mode)])),
    coordinator: new CoreAssistant().settings(), background: backgroundModelSettings() };
}

for (const platform of ['darwin', 'linux']) for (const failReadiness of [false, true]) {
  test(`${platform} update ${failReadiness ? 'readiness rollback' : 'activation'} preserves private settings, grants, goals and runner identities without replay`, async t => {
    const f = fixture(t, platform, failReadiness), saved = seedPrivateState(f), before = privateSnapshot(f);
    const updating = withPausedCore(f.oldCLI, f.install, { run: f.run, lifecycle: f.lifecycle, rollback: f.rollback });
    if (failReadiness) await assert.rejects(updating, /update command failed/i); else assert.equal(await updating, 0);
    assert.deepEqual(privateSnapshot(f), before);
    assert.deepEqual(saved.sessions.map(session => loadSession(session.id).goal.status), ['active', 'paused', 'complete']);
    assert.equal(terminalYolo(saved.sessions[2].id), true);
    assert.deepEqual(getRecord('execution', saved.executionId).runner, saved.runner); assert.equal(getRecord('execution', saved.executionId).state, 'running');
    assert.equal(getRecord('run', saved.sessions[0].id).state, 'running');
    assert.deepEqual(getRecord('access-token', digest(saved.grant.token)).permissions, sessionPermissions);
    assert.equal(activeAccess(getRecord('access-token', digest(saved.grant.token))), true);
    assert.equal(activeAccess(getRecord('access-token', digest(saved.revoked.token))), false);
    assert.ok(authorizedUpdateGrant(saved.phone.id)); assert.equal(authorizedUpdateGrant(saved.revoked.id), null);
    assert.equal(f.pauses(), 0); assert.equal(operatorStopRequested(), false); assert.equal(coreMaintenanceActive(f.privateHome), false);
    assert.equal(f.rollbacks(), failReadiness ? 1 : 0); assert.equal(f.starts.length, failReadiness ? 2 : 1);
    assert.equal(f.native.running, true);
    assert.equal(fs.readFileSync(f.oldPlan.file, 'utf8'), (failReadiness ? f.oldPlan : f.newPlan).manifest);
    for (const file of f.launchers) assert.match(fs.readFileSync(file, 'utf8'), failReadiness ? /retained old release/ : /new release/);
  });
}
