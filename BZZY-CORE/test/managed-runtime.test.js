import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { servicePlan, installService } from '../src/engine/host-service.js';
import { ensureRuntime, runtimeInfo, runtimeRequest } from '../src/engine/runtime.js';
import { identityAlive } from '../src/engine/process-identity.js';

const root = fileURLToPath(new URL('../', import.meta.url));
let directory, saved, child;
test.beforeEach(() => {
  directory = fs.mkdtempSync(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'bmr-'));
  saved = { HOME: process.env.HOME, BZZY_HOME: process.env.BZZY_HOME };
  process.env.HOME = path.join(directory, 'user'); process.env.BZZY_HOME = path.join(directory, 'private');
  fs.mkdirSync(process.env.HOME, { mode: 0o700 });
  installService(servicePlan(), { run: () => { throw new Error('The prepared-runtime fixture must not contact the native manager.'); } });
});
test.afterEach(async () => {
  const info = runtimeInfo();
  if (info && identityAlive(info.identity)) await runtimeRequest(info, 'POST', '/shutdown', {}).catch(() => {});
  const deadline = Date.now() + 5000;
  while (info && identityAlive(info.identity) && Date.now() < deadline) await delay(25);
  child?.kill('SIGTERM'); child = undefined;
  for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  fs.rmSync(directory, { recursive: true, force: true });
});

test('a prepared service never falls back to a detached daemon when its manager is stopped', { timeout: 5000 }, async () => {
  await assert.rejects(ensureRuntime({ managedWaitMs: 100 }), { code: 'CORE_SERVICE_UNAVAILABLE' });
  assert.equal(runtimeInfo(), null);
  assert.equal(fs.existsSync(path.join(process.env.BZZY_HOME, 'runtime/service.log')), false);
  assert.equal(fs.existsSync(path.join(process.env.BZZY_HOME, 'runtime/service.lock')), false);
});

test('a polling client waits through a managed restart gap and attaches to the manager-launched foreground PID', { timeout: 10000 }, async () => {
  const waiting = ensureRuntime({ managedWaitMs: 3000 });
  await delay(100);
  assert.equal(runtimeInfo(), null);
  child = spawn(process.execPath, [path.join(root, 'bin/bzzy-core.js'), 'serve'], { env: process.env, stdio: 'ignore' });
  const info = await waiting;
  assert.equal(info.identity.pid, child.pid);
  assert.equal((await runtimeRequest(info, 'GET', '/health')).ok, true);
  assert.equal(fs.existsSync(path.join(process.env.BZZY_HOME, 'runtime/service.log')), false);
});
