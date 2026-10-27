import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { servicePlan, installService, serviceStatus, startCoreHost, stopCoreHost, restartCoreHost,
  coreHostStatus, uninstallService } from '../src/engine/host-service.js';
import { assertRootExecutable, rootExecutionAllowed, authorizeRootExecution } from '../src/engine/root-execution.js';

function fixture() {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-root-service-')));
  const userHome = path.join(directory, 'owner'), coreHome = path.join(userHome, 'private');
  fs.mkdirSync(userHome, { mode: 0o700 });
  const options = { platform: 'linux', uid: 0, rootExecution: true, userHome, coreHome,
    node: process.execPath, entry: process.execPath,
    env: { PATH: path.dirname(process.execPath) + ':/usr/bin:/bin', DEEPSEEK_API_KEY: 'never-copy-root-fixture-secret' } };
  return { directory, options, close: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

function fakeSystemManager() {
  const calls = []; let running = false, enabled = false;
  return {
    calls,
    run(command, args) {
      calls.push([command, ...args]);
      if (args.includes('enable') && args.includes('--now')) { running = true; enabled = true; }
      if (args.includes('disable') && args.includes('--now')) { running = false; enabled = false; }
      return { status: 0, stdout: args.includes('show')
        ? `LoadState=loaded\nActiveState=${running ? 'active' : 'inactive'}\nSubState=${running ? 'running' : 'dead'}\nMainPID=${running ? 4321 : 0}\nUnitFileState=${enabled ? 'enabled' : 'disabled'}\n`
        : '' };
    },
  };
}

test('missing, malformed and linked policy files cannot implicitly enable root execution', () => {
  const setup = fixture();
  try {
    const coreHome = setup.options.coreHome, file = path.join(coreHome, 'root-execution.json');
    const lookup = { platform: 'linux', uid: 0, coreHome };
    fs.mkdirSync(coreHome, { mode: 0o700 });
    assert.equal(rootExecutionAllowed(lookup), false);
    fs.writeFileSync(file, '{invalid', { mode: 0o600 });
    assert.equal(rootExecutionAllowed(lookup), false);
    assert.equal(fs.readFileSync(file, 'utf8'), '{invalid', 'lookup never repairs authorization');
    const policy = JSON.stringify({ version: 1, mode: 'linux-root', uid: 0, coreHome });
    fs.writeFileSync(file, policy, { mode: 0o600 });
    if (process.getuid?.() !== 0) assert.equal(rootExecutionAllowed(lookup), false, 'JSON cannot forge root filesystem ownership');
    assert.equal(rootExecutionAllowed({ ...lookup, platform: 'darwin' }), false);
    assert.equal(rootExecutionAllowed({ ...lookup, uid: 501 }), false);
    fs.unlinkSync(file);
    const target = path.join(setup.directory, 'private-policy-target');
    fs.writeFileSync(target, policy, { mode: 0o600 }); fs.symlinkSync(target, file);
    assert.equal(rootExecutionAllowed(lookup), false);
    assert.equal(fs.readFileSync(target, 'utf8'), policy);
    assert.equal(fs.lstatSync(file).isSymbolicLink(), true);
  } finally { setup.close(); }
});

test('a caller-supplied root UID cannot authorize a non-root process or write state', () => {
  const setup = fixture();
  try {
    if (process.getuid?.() !== 0) {
      assert.throws(() => authorizeRootExecution({ platform: 'linux', uid: 0, coreHome: setup.options.coreHome }),
        { code: 'SERVICE_NON_ROOT_REQUIRED' });
      assert.equal(fs.existsSync(setup.options.coreHome), false);
    }
    assert.throws(() => authorizeRootExecution({ platform: 'darwin', uid: 0, coreHome: setup.options.coreHome }),
      { code: 'SERVICE_NON_ROOT_REQUIRED' });
    assert.equal(fs.existsSync(setup.options.coreHome), false);
    const file = path.join(setup.directory, 'mutable-entry.js'); fs.writeFileSync(file, '// disposable fixture', { mode: 0o666 });
    fs.chmodSync(file, 0o666);
    assert.throws(() => assertRootExecutable(file), { code: 'SERVICE_PRIVATE_PATH_REQUIRED' });
  } finally { setup.close(); }
});

test('explicit Linux root plans use system supervision and a separate private context without starting anything', () => {
  const setup = fixture();
  try {
    const plan = servicePlan(setup.options);
    assert.equal(plan.scope, 'system'); assert.equal(plan.uid, 0);
    assert.equal(path.dirname(plan.file), '/etc/systemd/system');
    assert.match(plan.manifest, /^User=root$/m);
    assert.match(plan.manifest, /^WantedBy=multi-user\.target$/m);
    assert.match(plan.manifest, /^UMask=0077$/m);
    assert.match(plan.manifest, /^KillMode=process$/m);
    assert.equal(plan.environment.HOME, setup.options.userHome);
    assert.equal(plan.environment.BZZY_HOME, setup.options.coreHome);
    assert.doesNotMatch(JSON.stringify(plan), /never-copy-root-fixture-secret|DEEPSEEK_API_KEY/);
    assert.equal(fs.existsSync(plan.coreHome), false);
    assert.deepEqual(fs.readdirSync(setup.options.userHome), []);
    assert.throws(() => servicePlan({ ...setup.options, rootExecution: false }));
    assert.throws(() => servicePlan({ ...setup.options, platform: 'darwin' }));
  } finally { setup.close(); }
});

test('root system status addresses the system manager without writing a real system unit', () => {
  const setup = fixture(), fake = fakeSystemManager();
  try {
    const plan = { ...servicePlan(setup.options), file: path.join(setup.directory, 'units', 'fixture.service') };
    const status = serviceStatus(plan, { run: fake.run, inspectMissing: true });
    assert.equal(status.installed, false); assert.equal(status.running, false); assert.equal(status.available, true);
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0][1], '--system'); assert.equal(fake.calls[0][2], 'show');
    assert.equal(fake.calls[0].includes('--user'), false);
    assert.equal(fs.existsSync(path.dirname(plan.file)), false);
  } finally { setup.close(); }
});

test('system-scoped lifecycle keeps owner stop barriers and execution-preserving restart with fixture-only files', async t => {
  const setup = fixture(), fake = fakeSystemManager(), events = [];
  try {
    // The fake manager never executes this binary. Keeping a real executable
    // lets a root test host retain the production executable-ownership checks.
    // All service and state writes stay beneath this disposable fixture.
    const plan = { ...servicePlan(setup.options), uid: process.getuid?.(),
      file: path.join(setup.directory, 'units', 'fixture.service') };
    let engineRunning = false, intent = false;
    const run = (command, args) => {
      const result = fake.run(command, args);
      if (args.includes('enable') && args.includes('--now')) engineRunning = true;
      if (args.includes('disable') && args.includes('--now')) engineRunning = false;
      return result;
    };
    const runtime = {
      stopped: () => intent,
      clearStop() { events.push('clear-stop'); intent = false; },
      persistStop() { events.push('persist-stop'); intent = true; },
      async status() { return engineRunning ? { running: true, pid: 4321 } : { running: false }; },
      async quiesce() { events.push('pause-executions'); return { quiesced: true, pausedExecutions: 2 }; },
      async shutdown() { events.push('shutdown-control'); engineRunning = false; return { stopped: true, runningAgentsContinue: true }; },
    };
    const lifecycle = { plan, runtime, run, doctor: () => ({ ready: true }),
      processes: { identity: () => null, alive: () => false } };
    if (process.getuid?.() === 0) {
      // Some root CI runners keep Node under a writable temporary ancestor.
      // Such a binary must remain ineligible for a privileged host service.
      try { assertRootExecutable(process.execPath); }
      catch { t.skip('The root test runtime does not have a trusted executable ancestor chain.'); return; }
    }
    installService(plan, { run });
    assert.equal(fake.calls.length, 0, 'installation only prepares the fixture manifest');
    assert.equal((await startCoreHost(lifecycle)).managed, true);
    assert.equal((await restartCoreHost(lifecycle)).running, true);
    assert.equal(events.includes('pause-executions'), false, 'restart retains existing execution runners');
    const stopped = await stopCoreHost(lifecycle);
    assert.equal(stopped.running, false); assert.equal(stopped.pausedExecutions, 2); assert.equal(intent, true);
    const beforeStatus = events.length;
    assert.equal((await coreHostStatus(lifecycle)).operatorStopped, true);
    assert.equal(events.length, beforeStatus, 'status must not clear operator stop intent');
    assert.equal(uninstallService(plan, { run }).removed, true);
    assert.equal(fs.existsSync(plan.file), false);
    assert.ok(fake.calls.length > 0);
    assert.ok(fake.calls.every(call => call[0] === plan.manager && call[1] === '--system' && !call.includes('--user')));
    assert.ok(fake.calls.some(call => call.includes('daemon-reload')));
    assert.ok(fake.calls.some(call => call.includes('enable') && call.includes('--now')));
    assert.ok(fake.calls.some(call => call.includes('disable') && call.includes('--now')));
  } finally { setup.close(); }
});
