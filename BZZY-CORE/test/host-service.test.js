import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { servicePlan, installService, serviceStatus, startService, stopService, uninstallService, installationDoctor,
  coreHostStatus, startCoreHost, stopCoreHost, suspendCoreHost, restartCoreHost, activateCLIHost, clearCoreStartFailure,
  snapshotCoreServiceManifest, restoreCoreServiceManifest, startRestoredCoreService } from '../src/engine/host-service.js';
import { randomUUID } from 'node:crypto';

function fixture(platform = process.platform) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-user-service-'));
  const userHome = path.join(directory, 'user'), coreHome = path.join(userHome, 'private context'), entry = path.join(directory, 'core entry.js');
  fs.mkdirSync(userHome, { mode: 0o700 }); fs.writeFileSync(entry, '// isolated service fixture\n', { mode: 0o600 });
  const plan = servicePlan({ platform, userHome, coreHome, entry, env: { PATH: process.env.PATH, DEEPSEEK_API_KEY: 'never-copy-this-account-secret' } });
  return { directory, plan, close: () => fs.rmSync(directory, { recursive: true, force: true }) };
}
function manager(platform) {
  const calls = []; let running = false, loaded = false;
  const run = (command, args) => {
    calls.push([command, ...args]);
    if (args.includes('print')) return !args[1]?.includes('/app.bzzy.core.') ? { status: 0, stdout: 'fixture GUI domain\n' }
      : loaded ? { status: 0, stdout: `state = ${running ? 'running' : 'waiting'}\n${running ? 'pid = 4321\n' : ''}` } : { status: 113, stderr: 'No such process' };
    if (args.includes('show')) return { status: 0, stdout: `LoadState=loaded\nActiveState=${running ? 'active' : 'inactive'}\nSubState=${running ? 'running' : 'dead'}\nMainPID=${running ? 4321 : 0}\nUnitFileState=${loaded ? 'enabled' : 'disabled'}\n` };
    if (args.includes('bootstrap')) { loaded = true; running = true; }
    if (args.includes('--now') && args.includes('enable')) { loaded = true; running = true; }
    if (args.includes('bootout') || args.includes('disable') && args.includes('--now')) { loaded = false; running = false; }
    return { status: 0, stdout: '' };
  };
  return { calls, run };
}

test('pure service plans use the same foreground engine, absolute paths and private scoped state without credentials', () => {
  for (const platform of ['darwin', 'linux']) {
    const setup = fixture(platform);
    try {
      const { plan } = setup;
      assert.equal(fs.existsSync(plan.coreHome), false); assert.equal(fs.existsSync(plan.file), false);
      assert.match(plan.manifest, /serve/); assert.ok(plan.manifest.includes(plan.node));
      assert.ok(plan.file.startsWith(plan.userHome + path.sep));
      assert.doesNotMatch(JSON.stringify(plan), /never-copy-this-account-secret|DEEPSEEK_API_KEY|Bearer|internal-execution/);
      assert.equal(plan.environment.BZZY_HOME, plan.coreHome);
      assert.equal(plan.environment.PATH.split(path.delimiter)[0], path.dirname(plan.node));
      if (platform === 'darwin') {
        const plist = path.join(setup.directory, 'plan.plist'); fs.writeFileSync(plist, plan.manifest);
        if (process.platform === 'darwin') assert.equal(spawnSync('/usr/bin/plutil', ['-lint', plist], { encoding: 'utf8' }).status, 0);
        assert.match(plan.manifest, /<key>Umask<\/key><integer>63<\/integer>/);
      } else {
        assert.match(plan.manifest, /UMask=0077/); assert.match(plan.manifest, /KillMode=process/);
        assert.match(plan.manifest, /Restart=always/);
        const weird = servicePlan({ ...plan, env: { PATH: '/usr/bin:/bin' }, entry: '/a space/100%/price$quote".js' });
        assert.match(weird.manifest, /100%%\/price\$\$quote\\"\.js/);
      }
    } finally { setup.close(); }
  }
  assert.throws(() => servicePlan({ uid: 0 }), { code: 'SERVICE_NON_ROOT_REQUIRED' });
  assert.throws(() => servicePlan({ platform: 'win32' }), { code: 'SERVICE_PLATFORM_UNSUPPORTED' });
  assert.throws(() => servicePlan({ env: { PATH: '/bin\nExecStart=bad' } }), { code: 'SERVICE_PATH_INVALID' });
});

test('owned install is private and idempotent, has no manager/model side effects, and refuses unrelated/symlink files', () => {
  const setup = fixture('darwin');
  try {
    const { plan } = setup;
    assert.equal(installService(plan).changed, true); assert.equal(installService(plan).changed, false);
    assert.equal(servicePlan({ ...plan, env: plan.environment }).file, plan.file, 'first creation must not change scope through a /var alias');
    assert.equal(fs.statSync(plan.file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(plan.coreHome).mode & 0o777, 0o700);
    assert.equal(fs.statSync(plan.logPath).mode & 0o777, 0o600);
    fs.writeFileSync(plan.file, 'an unrelated owner service');
    assert.throws(() => installService(plan), { code: 'SERVICE_FILE_CONFLICT' });
    fs.unlinkSync(plan.file); fs.symlinkSync(plan.entry, plan.file);
    assert.throws(() => installService(plan), { code: 'SERVICE_PRIVATE_PATH_REQUIRED' });
    assert.equal(fs.readFileSync(plan.entry, 'utf8'), '// isolated service fixture\n');
  } finally { setup.close(); }
});

test('Linux working directory stays an absolute literal path independently of command/environment quoting', () => {
  const setup = fixture('linux');
  try {
    for (const name of ['private context', '100% $cash "quoted" \\folder', 'trailing space ', 'trailing slash\\']) {
      const plan = servicePlan({ ...setup.plan, coreHome: path.join(setup.plan.userHome, name) });
      const value = /^WorkingDirectory=(.*)$/m.exec(plan.manifest)?.[1];
      assert.ok(value.startsWith('/'), 'systemd rejects a quoted value as non-absolute');
      assert.equal(path.resolve(value.replaceAll('%%', '%')), plan.coreHome, 'literal spaces, quotes, dollars and backslashes must survive the single-path parser');
      assert.ok(!/[\\\s]$/.test(value), 'line trimming and continuation must not change the directory');
    }
    installService(setup.plan);
    const old = setup.plan.manifest.replace(/^WorkingDirectory=.*$/m, `WorkingDirectory="${setup.plan.coreHome}"`);
    fs.writeFileSync(setup.plan.file, old);
    const unavailable = { run: () => ({ status: 0, stdout: 'LoadState=bad-setting\nActiveState=inactive\nSubState=dead\nMainPID=0\nUnitFileState=disabled\n' }) };
    assert.equal(installService(setup.plan, unavailable).changed, true, 'an inactive old invalid manifest is replaced through ordinary installation');
    assert.equal(fs.readFileSync(setup.plan.file, 'utf8'), setup.plan.manifest);
  } finally { setup.close(); }
});

test('native systemd accepts generated Linux units and rejects the old quoted working directory', { skip: process.platform !== 'linux' }, t => {
  const analyzer = ['/usr/bin/systemd-analyze', '/bin/systemd-analyze'].find(file => fs.existsSync(file));
  if (!analyzer) return t.skip('systemd-analyze is not installed');
  const setup = fixture('linux');
  try {
    const env = { ...process.env, XDG_RUNTIME_DIR: setup.directory, SYSTEMD_LOG_LEVEL: 'warning', SYSTEMD_LOG_TARGET: 'console' };
    for (const name of ['private context', '100% $cash "quoted" \\folder', 'trailing space ', 'trailing slash\\']) {
      const plan = servicePlan({ ...setup.plan, coreHome: path.join(setup.plan.userHome, name) });
      installService(plan);
      const result = spawnSync(analyzer, ['--user', 'verify', plan.file], { env, encoding: 'utf8', timeout: 15000 });
      assert.equal(result.status, 0, result.stderr);
    }
    fs.writeFileSync(setup.plan.file, setup.plan.manifest.replace(/^WorkingDirectory=.*$/m, `WorkingDirectory="${setup.plan.coreHome}"`));
    const rejected = spawnSync(analyzer, ['--user', 'verify', setup.plan.file], { env, encoding: 'utf8', timeout: 15000 });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /WorkingDirectory|working directory|bad.*setting/i);
  } finally { setup.close(); }
});

test('user service lifecycle uses only exact manager arguments, blocks duplicate daemons and preserves private state', async () => {
  for (const platform of ['darwin', 'linux']) {
    const setup = fixture(platform), fake = manager(platform);
    try {
      const { plan } = setup;
      assert.equal(serviceStatus(plan, fake).installed, false); installService(plan);
      assert.equal(fake.calls.length, 0);
      await assert.rejects(startService(plan, { ...fake, runtimeRunning: async () => true }), { code: 'CORE_ALREADY_RUNNING' });
      assert.equal(fake.calls.filter(call => call.includes('bootstrap') || call.includes('--now')).length, 0);
      const started = await startService(plan, fake); assert.equal(started.running, true); assert.equal(started.pid, 4321);
      assert.equal((await startService(plan, fake)).running, true);
      assert.equal(fake.calls.filter(call => call.includes('bootstrap') || call.includes('enable') && call.includes('--now')).length, 1);
      assert.equal(stopService(plan, fake).state, 'stopped');
      const preserved = path.join(plan.coreHome, 'preserve-private-state'); fs.writeFileSync(preserved, 'private fixture');
      assert.equal(uninstallService(plan, fake).removed, true);
      assert.equal(fs.existsSync(plan.file), false); assert.equal(fs.readFileSync(preserved, 'utf8'), 'private fixture');
      assert.ok(fake.calls.every(call => call[0] === plan.manager && !call.some(arg => /sudo|\/bin\/sh|codex|claude/.test(arg))));
    } finally { setup.close(); }
  }
});

test('service start rejects outdated plans and unsafe private contexts; manager failures expose no raw output', async () => {
  const setup = fixture('linux');
  try {
    const { plan } = setup; installService(plan);
    const changed = { ...plan, manifest: plan.manifest + '# changed\n' };
    await assert.rejects(startService(changed), { code: 'SERVICE_OUTDATED' });
    fs.chmodSync(plan.coreHome, 0o755);
    await assert.rejects(startService(plan), { code: 'SERVICE_PRIVATE_PATH_REQUIRED' });
    fs.chmodSync(plan.coreHome, 0o700);
    const run = () => ({ status: 1, stderr: 'raw secret must never enter diagnostic' });
    await assert.rejects(startService(plan, { run }), error => error.code === 'SERVICE_MANAGER_UNAVAILABLE' && !error.message.includes('raw secret'));
  } finally { setup.close(); }
});

test('starting the same release from another terminal retains installed PATH while runtime path/settings changes remain blocked', async () => {
  for (const platform of ['darwin', 'linux']) {
    const setup = fixture(platform), fake = manager(platform);
    try {
      const { plan } = setup; installService(plan);
      const saved = fs.readFileSync(plan.file, 'utf8');
      const otherTerminal = servicePlan({ ...plan, env: { PATH: '/different/login/bin:/usr/bin:/bin' } });
      assert.notEqual(otherTerminal.manifest, saved);
      assert.equal((await startService(otherTerminal, fake)).running, true);
      assert.equal(fs.readFileSync(plan.file, 'utf8'), saved, 'start must keep the reviewed installed PATH');
      const otherNode = servicePlan({ ...plan, node: '/other/node24', env: plan.environment });
      await assert.rejects(startService(otherNode, fake), { code: 'SERVICE_OUTDATED' });
      const otherEntry = servicePlan({ ...plan, entry: '/other/release/bzzy-core.js', env: plan.environment });
      await assert.rejects(startService(otherEntry, fake), { code: 'SERVICE_OUTDATED' });
      const otherAuthPath = servicePlan({ ...plan, env: { ...plan.environment, CODEX_HOME: '/other/private/codex' } });
      await assert.rejects(startService(otherAuthPath, fake), { code: 'SERVICE_OUTDATED' });
    } finally { setup.close(); }
  }
});

test('doctor distinguishes Node/Python/context prerequisites without creating a daemon or reading account bindings', () => {
  const setup = fixture(); const previous = process.env.BZZY_HOME;
  process.env.BZZY_HOME = setup.plan.coreHome;
  try {
    const missing = installationDoctor({ nodeVersion: '22.22.0', env: { PATH: '/nonexistent' } });
    assert.equal(missing.ready, false); assert.equal(missing.checks.node.ready, false); assert.equal(missing.checks.python.ready, false);
    assert.equal(fs.existsSync(setup.plan.coreHome), false);
    const ready = installationDoctor();
    assert.equal(ready.checks.node.ready, true); assert.equal(ready.checks.python.ready, true);
    assert.equal(fs.existsSync(path.join(setup.plan.coreHome, 'runtime', 'listener.json')), false);
    assert.doesNotMatch(JSON.stringify(ready), /never-copy-this-account-secret|token|credentials\.json/);
  } finally {
    if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
    setup.close();
  }
});

function lifecycle(platform = 'darwin', { standalone = false, failure = false } = {}) {
  const setup = fixture(platform), fake = manager(platform), events = [];
  let running = standalone, intent = false, managed = false;
  const run = (command, args) => {
    events.push(args.join(' '));
    const result = fake.run(command, args);
    if (args.includes('bootstrap') || args.includes('enable') && args.includes('--now')) { running = true; managed = true; }
    if (args.includes('bootout') || args.includes('disable') && args.includes('--now')) { if (managed) running = false; managed = false; }
    return result;
  };
  const runtime = {
    stopped: () => intent,
    clearStop() { events.push('clear-intent'); intent = false; },
    persistStop() { events.push('persist-intent'); intent = true; },
    async status() { return running ? { running: true, pid: 4321, version: 'fixture', apiVersion: 1 } : { running: false }; },
    async quiesce(managed) {
      events.push(`quiesce:${managed}`);
      if (failure) throw Object.assign(new Error('Unverified fixture runner'), { code: 'STOP_INCOMPLETE' });
      if (!managed) running = false;
      return { quiesced: true, pausedExecutions: 2, runningAgentsContinue: false };
    },
    async shutdown() { events.push('shutdown-control'); running = false; return { stopped: true, runningAgentsContinue: true }; },
  };
  return { ...setup, run, runtime, events, doctor: () => ({ ready: true }), processes: { identity: () => null, alive: () => false } };
}

test('top-level lifecycle prepares once, pauses before unload, and restarts service without resuming model work', async () => {
  for (const platform of ['darwin', 'linux']) {
    const setup = lifecycle(platform);
    try {
      const { plan, runtime, events } = setup;
      const idle = await coreHostStatus(setup); assert.equal(idle.running, false); assert.equal(idle.service.installed, false);
      assert.equal(events.some(value => /bootstrap|enable|clear-intent/.test(value)), false, 'status must not start or reactivate anything');
      assert.equal((await startCoreHost(setup)).managed, true);
      assert.equal(fs.existsSync(plan.file), true);
      const stopped = await stopCoreHost(setup);
      assert.equal(stopped.running, false); assert.equal(stopped.pausedExecutions, 2); assert.equal(runtime.stopped(), true);
      const unload = events.findIndex(value => value.includes('bootout') || value.includes('disable --now'));
      assert.ok(events.indexOf('quiesce:true') < unload, events.join('\n'));
      const beforeRead = events.filter(value => value === 'clear-intent').length;
      assert.equal((await coreHostStatus(setup)).operatorStopped, true);
      assert.equal(events.filter(value => value === 'clear-intent').length, beforeRead);
      await startCoreHost(setup);
      assert.equal((await restartCoreHost(setup)).running, true);
      assert.equal(runtime.stopped(), false);
      assert.equal(events.filter(value => value.startsWith('quiesce:')).length, 1, 'restart must not pause existing runners');
      assert.ok(events.every(value => !/model|execute|codex|claude/.test(value)), 'lifecycle must not submit model work');
    } finally { setup.close(); }
  }
});

test('an explicit Stop arriving during restart wins over control reactivation', async () => {
  const setup = lifecycle();
  try {
    await startCoreHost(setup);
    const run = (command, args) => {
      const result = setup.run(command, args);
      if (args.includes('bootout')) setup.runtime.persistStop();
      return result;
    };
    const result = await restartCoreHost({ ...setup, run });
    assert.equal(result.operatorStopped, true); assert.equal(result.running, false);
    assert.equal(setup.events.filter(value => value.includes('bootstrap')).length, 1);
  } finally { setup.close(); }
});

test('operator stop failure leaves its gate and loaded supervisor intact; explicit restart safely migrates standalone Core', async () => {
  const failed = lifecycle('darwin', { failure: true });
  try {
    await startCoreHost(failed);
    await assert.rejects(stopCoreHost(failed), { code: 'STOP_INCOMPLETE' });
    assert.equal(failed.runtime.stopped(), true);
    assert.equal(failed.events.some(value => value.includes('bootout')), false);
    await assert.rejects(startCoreHost(failed), { code: 'CORE_STOPPED' });
  } finally { failed.close(); }
  const standalone = lifecycle('darwin', { standalone: true });
  try {
    await assert.rejects(startCoreHost(standalone), { code: 'CORE_ALREADY_RUNNING' });
    assert.equal((await restartCoreHost(standalone)).managed, true);
    assert.ok(standalone.events.includes('shutdown-control'));
    assert.equal(standalone.events.filter(value => value.includes('bootstrap')).length, 1);
  } finally { standalone.close(); }
});

test('fresh CLI invocation alone clears stop intent, direct fixtures stay isolated, and active manifests cannot be replaced', async () => {
  const setup = lifecycle();
  try {
    setup.runtime.persistStop();
    await activateCLIHost({ ...setup, direct: true }); assert.equal(setup.runtime.stopped(), true);
    await activateCLIHost(setup); assert.equal(setup.runtime.stopped(), false);
    assert.equal(fs.existsSync(setup.plan.file), false, 'source/test invocation does not register a service');
    await startCoreHost(setup); setup.events.length = 0;
    const changed = { ...setup.plan, manifest: setup.plan.manifest + '# new release\n' };
    assert.throws(() => installService(changed, setup), { code: 'SERVICE_RUNNING' });
    assert.equal(fs.readFileSync(setup.plan.file, 'utf8'), setup.plan.manifest);
    assert.equal((await activateCLIHost(setup)).managed, true);
    assert.equal(setup.events.filter(value => value.includes('bootstrap')).length, 0, 'new CLI reuses the same running service');
  } finally { setup.close(); }
});

test('failed supervised start restores the stop gate instead of permitting an unsupervised polling fallback', async () => {
  const setup = lifecycle();
  try {
    const run = () => ({ status: 1, stderr: 'manager unavailable' });
    await assert.rejects(startCoreHost({ ...setup, run }), { code: 'SERVICE_MANAGER_UNAVAILABLE' });
    assert.equal(setup.runtime.stopped(), true);
    assert.equal((await setup.runtime.status()).running, false);
  } finally { setup.close(); }
});

test('readiness rejects a healthy detached engine when its PID is not the native manager MainPID', async () => {
  const setup = lifecycle();
  try {
    const actualStatus = setup.runtime.status;
    setup.runtime.status = async () => {
      const status = await actualStatus(); return status.running ? { ...status, pid: 9876 } : status;
    };
    await assert.rejects(startCoreHost({ ...setup, readinessWaitMs: 50 }), { code: 'SERVICE_START_FAILED' });
    assert.equal(setup.runtime.stopped(), true);
    const snapshot = await coreHostStatus(setup);
    assert.equal(snapshot.engine.running, true); assert.equal(snapshot.engine.pid, 9876);
    assert.equal(snapshot.service.pid, 4321); assert.equal(snapshot.managed, false);
  } finally { setup.close(); }
});

test('loaded waiting launchd jobs remain supervised and must unload before manifest replacement even without engine health', async () => {
  const setup = fixture('darwin'); let loaded = true, bootouts = 0;
  const run = (_command, args) => {
    if (args[0] === 'print') return !args[1].includes('/app.bzzy.core.') || loaded ? { status: 0, stdout: args[1].includes('/app.bzzy.core.') ? 'state = waiting\n' : 'GUI domain' } : { status: 113 };
    if (args[0] === 'bootout') { bootouts++; loaded = false; }
    return { status: 0, stdout: '' };
  };
  const runtime = { status: async () => ({ running: false }), stopped: () => false, controlAlive: () => false,
    persistStop() { assert.fail('Suspension must not record an operator stop.'); }, quiesce() { assert.fail('Suspension must not pause work.'); } };
  try {
    installService(setup.plan);
    const status = await coreHostStatus({ ...setup, runtime, run });
    assert.equal(status.running, false); assert.equal(status.service.loaded, true); assert.equal(status.service.running, false);
    const changed = { ...setup.plan, manifest: setup.plan.manifest + '<!-- changed -->\n' };
    assert.throws(() => installService(changed, { run }), { code: 'SERVICE_RUNNING' });
    await suspendCoreHost({ ...setup, runtime, run, processes: { identity: () => null, alive: () => false } });
    assert.equal(bootouts, 1); assert.equal(serviceStatus(setup.plan, { run }).loaded, false);
    assert.equal(installService(changed, { run }).changed, true);
  } finally { setup.close(); }
});

test('suspension waits for native unload and the captured old control identity after its runtime record disappears', async () => {
  const setup = fixture('darwin'); let loaded = true, remainingPrints = 3, alive = true, stopRequested = false, waited = 0;
  const run = (_command, args) => {
    if (args[0] === 'bootout') { stopRequested = true; return { status: 0 }; }
    if (args[0] === 'print' && args[1].includes('/app.bzzy.core.')) {
      if (stopRequested && --remainingPrints <= 0) loaded = false;
      return loaded ? { status: 0, stdout: 'state = running\npid = 4321\n' } : { status: 113 };
    }
    return { status: 0, stdout: 'GUI domain' };
  };
  const identity = { pid: 4321, start: 'captured-start' }, runtime = { status: async () => ({ running: false }), controlIdentity: () => identity,
    controlAlive: () => false, stopped: () => false };
  try {
    installService(setup.plan);
    await suspendCoreHost({ ...setup, run, runtime, processes: { identity: () => identity, alive: value => {
      assert.equal(value.start, 'captured-start'); waited++; if (waited > 4) alive = false; return alive;
    } } });
    assert.equal(loaded, false); assert.equal(alive, false); assert.ok(waited > 4);
  } finally { setup.close(); }
});

test('unknown native-manager failures never count as an unloaded service', async () => {
  const setup = fixture('darwin');
  try {
    installService(setup.plan);
    const run = () => ({ status: 5, stderr: 'private manager diagnostic' });
    const status = serviceStatus(setup.plan, { run }); assert.equal(status.loaded, null); assert.equal(status.available, false);
    assert.throws(() => installService({ ...setup.plan, manifest: setup.plan.manifest + '<!-- next -->' }, { run }), { code: 'SERVICE_MANAGER_UNAVAILABLE' });
    await assert.rejects(suspendCoreHost({ ...setup, run, runtime: { status: async () => ({ running: false }) } }), error =>
      error.code === 'SERVICE_MANAGER_UNAVAILABLE' && !error.message.includes('private manager diagnostic'));
  } finally { setup.close(); }
});

test('standalone source control can shut down without a native manager but still waits for its captured daemon exit', async () => {
  const setup = fixture('darwin'); let running = true, identityAlive = true, checks = 0, stopped = false;
  const identity = { pid: 7777, start: 'fixture-standalone' };
  const runtime = { status: async () => ({ running }), controlIdentity: () => identity, controlAlive: () => running,
    stopped: () => stopped, persistStop() { stopped = true; },
    async shutdown() { running = false; return { stopped: true, runningAgentsContinue: true }; },
    async quiesce() { running = false; return { quiesced: true, pausedExecutions: 0 }; } };
  const processes = { identity: () => null, alive: value => { assert.equal(value, identity); if (++checks >= 3) identityAlive = false; return identityAlive; } };
  const run = () => ({ status: 1 });
  try {
    await suspendCoreHost({ ...setup, run, runtime, processes });
    assert.equal(stopped, false); assert.equal(identityAlive, false); assert.ok(checks >= 3);
    assert.equal(fs.existsSync(setup.plan.file), false);
    assert.equal((await stopCoreHost({ ...setup, run, runtime, processes })).stopped, true);
    assert.equal(stopped, true);
  } finally { setup.close(); }
});

test('a healthy running old plan cannot swallow SERVICE_OUTDATED as a successful concurrent launch', async () => {
  const setup = lifecycle();
  try {
    await startCoreHost(setup); setup.events.length = 0;
    await assert.rejects(startCoreHost({ ...setup, plan: { ...setup.plan, manifest: setup.plan.manifest + '<!-- new release -->\n' } }), { code: 'SERVICE_OUTDATED' });
    assert.equal(setup.events.includes('clear-intent'), false); assert.equal(setup.events.includes('persist-intent'), false);
  } finally { setup.close(); }
});

test('update-owned starts preserve an explicit stop before start and while readiness is being checked', async () => {
  const setup = lifecycle();
  try {
    setup.runtime.persistStop();
    await assert.rejects(startCoreHost({ ...setup, respectStop: true, attemptId: randomUUID() }), { code: 'CORE_STOPPED' });
    assert.equal(setup.runtime.stopped(), true); assert.equal(setup.events.includes('clear-intent'), false);
    setup.runtime.clearStop(); const originalStatus = setup.runtime.status; let reads = 0;
    setup.runtime.status = async () => { const result = await originalStatus(); if (++reads === 2) setup.runtime.persistStop(); return result; };
    await assert.rejects(startCoreHost({ ...setup, respectStop: true, attemptId: randomUUID() }), { code: 'CORE_STOPPED' });
    assert.equal(setup.runtime.stopped(), true);
  } finally { setup.close(); }
});

test('automatic readiness gates carry an exact attempt and only that failed attempt can be cleared', async () => {
  const setup = lifecycle(); let intent = null;
  setup.runtime.stopped = () => Boolean(intent); setup.runtime.stopIntent = () => intent;
  setup.runtime.persistStop = value => { intent ||= { source: value.source, attemptId: value.attemptId, id: randomUUID() }; };
  setup.runtime.clearStop = expected => { if (!intent) return false; if (expected && (intent.source !== expected.expectedSource || intent.attemptId !== expected.expectedAttemptId)) return false; intent = null; return true; };
  const original = setup.runtime.status; setup.runtime.status = async () => { const value = await original(); return value.running ? { ...value, pid: 9999 } : value; };
  try {
    const attemptId = randomUUID();
    await assert.rejects(startCoreHost({ ...setup, respectStop: true, attemptId, readinessWaitMs: 50 }), { code: 'SERVICE_START_FAILED' });
    assert.equal(intent.source, 'service_start_failure'); assert.equal(intent.attemptId, attemptId);
    assert.equal((await coreHostStatus(setup)).operatorStopIntent.id, intent.id);
    assert.equal(await clearCoreStartFailure(randomUUID(), setup), false); assert.equal(await clearCoreStartFailure(attemptId, setup), true);
  } finally { setup.close(); }
});

test('exact manifest receipts restore the original bytes and recover through new stop-aware lifecycle code', async () => {
  const setup = lifecycle();
  try {
    installService(setup.plan); const original = fs.readFileSync(setup.plan.file, 'utf8'), receipt = snapshotCoreServiceManifest(setup);
    const replacement = { ...setup.plan, manifest: setup.plan.manifest.replace('KeepAlive', 'KeepAlive') + '<!-- alternate release environment -->\n' };
    installService(replacement, setup);
    assert.throws(() => restoreCoreServiceManifest({ ...receipt, sha256: '0'.repeat(64) }, setup), { code: 'SERVICE_SNAPSHOT_STALE' });
    assert.equal(restoreCoreServiceManifest(receipt, setup).restored, true); assert.equal(fs.readFileSync(setup.plan.file, 'utf8'), original);
    setup.runtime.persistStop();
    await assert.rejects(startRestoredCoreService(receipt, { ...setup, attemptId: randomUUID(), respectStop: true }), { code: 'CORE_STOPPED' });
    setup.runtime.clearStop();
    assert.equal((await startRestoredCoreService(receipt, { ...setup, attemptId: randomUUID(), respectStop: true })).managed, true);
    assert.equal(fs.readFileSync(setup.plan.file, 'utf8'), original);
    await assert.rejects(startRestoredCoreService(receipt, setup), { code: 'SERVICE_SNAPSHOT_STALE' });
  } finally { setup.close(); }
});

test('new-controller recovery starts the exact old native Node, entry and environment and restores its reviewed mode', async () => {
  const setup = lifecycle(); let previousUmask;
  try {
    installService(setup.plan); fs.chmodSync(setup.plan.file, 0o640);
    const original = fs.readFileSync(setup.plan.file, 'utf8'), entry = path.join(setup.directory, 'new-core-entry.js'), node = path.join(setup.directory, 'new-node24');
    fs.writeFileSync(entry, '// next release fixture'); fs.writeFileSync(node, '// next Node fixture');
    const controller = servicePlan({ ...setup.plan, node, entry, env: { PATH: '/next/runtime/bin:/usr/bin', CODEX_HOME: path.join(setup.directory, 'next-accounts') } });
    assert.notEqual(controller.manifest, original);
    const receipt = snapshotCoreServiceManifest({ plan: controller });
    installService(controller, setup);
    previousUmask = process.umask(0o077);
    restoreCoreServiceManifest(receipt, { ...setup, plan: controller });
    process.umask(previousUmask); previousUmask = undefined;
    assert.equal(fs.statSync(setup.plan.file).mode & 0o777, 0o640); assert.equal(fs.readFileSync(setup.plan.file, 'utf8'), original);
    await assert.rejects(startCoreHost({ ...setup, plan: controller }), { code: 'SERVICE_OUTDATED' });
    const run = (command, args) => {
      if (args.includes('bootstrap')) assert.equal(fs.readFileSync(setup.plan.file, 'utf8'), original, 'native bootstrap must consume the captured old manifest');
      return setup.run(command, args);
    };
    assert.equal((await startRestoredCoreService(receipt, { ...setup, plan: controller, run, attemptId: randomUUID(), respectStop: true })).managed, true);
    assert.equal(fs.readFileSync(setup.plan.file, 'utf8'), original);
  } finally { if (previousUmask !== undefined) process.umask(previousUmask); setup.close(); }
});
