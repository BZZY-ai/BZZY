import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { servicePlan, installService, serviceStatus, uninstallService, coreHostStatus,
  startCoreHost, stopCoreHost, restartCoreHost } from '../src/engine/host-service.js';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-root-host-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const userHome = path.join(directory, 'root'), coreHome = path.join(userHome, '.bzzy'), entry = path.join(directory, 'core.js');
  fs.mkdirSync(userHome, { mode: 0o700 }); fs.writeFileSync(entry, '// lifecycle fixture only', { mode: 0o600 });
  const generated = servicePlan({ platform: 'linux', uid: 0, userHome, coreHome, node: process.execPath, entry,
    env: { PATH: process.env.PATH, DEEPSEEK_API_KEY: 'private-key-not-for-service' } });
  // Exercise the actual system-scope lifecycle without writing /etc or starting
  // models. On non-root test hosts only filesystem ownership uses the test UID.
  const plan = { ...generated, file: path.join(directory, 'system', generated.label), uid: process.getuid() };
  const calls = []; let active = false, stopped = false;
  const run = (executable, args) => {
    assert.equal(executable, plan.manager); calls.push(args);
    if (args[0] === 'enable') active = true;
    if (args[0] === 'disable') active = false;
    return { status: 0, stdout: args[0] === 'show' ? `LoadState=loaded\nActiveState=${active ? 'active' : 'inactive'}\nMainPID=${active ? 12345 : 0}\nUnitFileState=${active ? 'enabled' : 'disabled'}\n` : '' };
  };
  const runtime = { stopped: () => stopped, persistStop() { stopped = true; }, clearStop() { stopped = false; },
    async status() { return { running: active, ...(active ? { pid: 12345 } : {}) }; },
    async quiesce() { calls.push(['pause-barrier']); return { quiesced: true, pausedExecutions: 2, runningAgentsContinue: false }; },
    async shutdown() { active = false; return { runningAgentsContinue: true }; } };
  return { generated, plan, run, runtime, calls, doctor: () => ({ ready: true }) };
}

test('Linux UID 0 gets an owned system service and regular users retain user scope', t => {
  const f = fixture(t), root = f.generated;
  assert.equal(root.uid, 0); assert.equal(root.scope, 'system');
  assert.equal(root.file, path.join('/etc/systemd/system', root.label));
  assert.match(root.manifest, /^User=root$/m); assert.match(root.manifest, /^WantedBy=multi-user.target$/m);
  assert.match(root.manifest, /^UMask=0077$/m); assert.match(root.manifest, /^KillMode=process$/m);
  assert.ok(root.manifest.includes(root.environment.BZZY_HOME));
  assert.doesNotMatch(JSON.stringify(root), /private-key-not-for-service|DEEPSEEK_API_KEY/);
  const user = servicePlan({ ...root, uid: 1000, env: { PATH: '/usr/bin:/bin' } });
  assert.equal(user.scope, 'user'); assert.ok(user.file.startsWith(root.userHome + path.sep));
  assert.doesNotMatch(user.manifest, /^User=root$/m); assert.match(user.manifest, /^WantedBy=default.target$/m);
});

test('root lifecycle uses system scope, preserves stop intent and restarts without resuming work', async t => {
  const f = fixture(t);
  assert.equal((await coreHostStatus(f)).service.installed, false); assert.equal(f.calls.length, 0);
  assert.equal((await startCoreHost(f)).managed, true);
  const stopped = await stopCoreHost(f); assert.equal(stopped.pausedExecutions, 2); assert.equal(f.runtime.stopped(), true);
  assert.equal((await coreHostStatus(f)).operatorStopped, true);
  assert.ok(f.calls.findIndex(args => args[0] === 'pause-barrier') < f.calls.findIndex(args => args[0] === 'disable'));
  await startCoreHost(f);
  const before = f.calls.filter(args => args[0] === 'pause-barrier').length;
  assert.equal((await restartCoreHost(f)).managed, true);
  assert.equal(f.calls.filter(args => args[0] === 'pause-barrier').length, before);
  assert.ok(f.calls.every(args => !args.includes('--user')));
  assert.ok(f.calls.some(args => args.join(' ') === `enable --now ${f.plan.label}`));
  assert.ok(f.calls.some(args => args.join(' ') === `disable --now ${f.plan.label}`));
});

test('root service uninstall preserves private identities and rejects unrelated system units', async t => {
  const f = fixture(t); installService(f.plan);
  const identity = path.join(f.plan.coreHome, 'retained-private-identity'); fs.writeFileSync(identity, 'fixture identity', { mode: 0o600 });
  assert.equal(serviceStatus(f.plan, f).installed, true);
  assert.equal(uninstallService(f.plan, f).preservedPrivateData, true);
  assert.equal(fs.readFileSync(identity, 'utf8'), 'fixture identity');
  installService(f.plan); fs.writeFileSync(f.plan.file, 'unrelated service');
  assert.throws(() => installService(f.plan, f), { code: 'SERVICE_FILE_CONFLICT' });
  assert.ok(f.calls.every(args => !args.includes('--user')));
});
