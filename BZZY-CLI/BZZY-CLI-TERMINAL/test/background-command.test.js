import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from '../src/cli.js';
import { runtimeInfo, runtimeRequest, operatorStopRequested } from '../src/runtime.js';
import { identityAlive } from '../src/recovery.js';

const entry = fileURLToPath(new URL('../bin/bzzy.js', import.meta.url));
let directory, previous;
test.beforeEach(() => {
  directory = fs.realpathSync(fs.mkdtempSync(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'bz-cli-job-')));
  previous = process.env.BZZY_HOME; process.env.BZZY_HOME = path.join(directory, 'private');
});
async function until(check) {
  for (let i = 0; i < 500; i++) { const value = await check(); if (value) return value; await delay(30); }
  assert.fail('background CLI fixture timed out');
}
test.afterEach(async () => {
  const info = runtimeInfo();
  if (info && identityAlive(info.identity)) await runtimeRequest(info, 'POST', '/operator-stop', {}).catch(() => {});
  await until(() => !info || !identityAlive(info.identity));
  if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
  fs.rmSync(directory, { recursive: true, force: true });
});
function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], { cwd: directory, env: { ...process.env, BZZY_DIRECT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', text => { stdout += text; }); child.stderr.on('data', text => { stderr += text; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI did not return promptly')); }, 15000);
    child.once('error', reject); child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}
test('background parsing preserves literal argv after -- and preprompt is the existing context-file option', () => {
  const parsed = parseArgs(['--background', 'task.py', '--cwd', directory, '--timeout', '12', '--notif', '--json', '--', '--json', '', 'a b', '$(literal)']);
  assert.deepEqual(parsed.options.scriptArgs, ['--json', '', 'a b', '$(literal)']); assert.equal(parsed.options.timeoutSeconds, 12); assert.equal(parsed.options.notify, true);
  assert.equal(parseArgs(['--preprompt', 'instructions.txt', '--goal', 'finish', '--detach']).options.contextFile, 'instructions.txt');
  for (const args of [['--background', 'task.py', 'arg'], ['--background', 'task.py', '--goal', 'task'], ['--notif'], ['--timeout', '1'], ['--background', 'task.py', '--timeout', '0'], ['--preprompt', 'a', '--context-file', 'b']]) assert.throws(() => parseArgs(args));
});
test('Python jobs outlive the submitting CLI; JSON commands retain outcomes and --notif is explicit', async () => {
  const cwd = path.join(directory, 'working folder'); fs.mkdirSync(cwd);
  const file = path.join(directory, 'task.py'); fs.writeFileSync(file, 'import sys,json,os,time\ntime.sleep(1)\nprint(json.dumps({"args":sys.argv[1:],"cwd":os.getcwd()}))\n');
  const args = ['--background', file, '--cwd', cwd, '--timeout', '10', '--json', '--request-id', 'external-once', '--', 'a b', '--json', '$(literal)'];
  const first = await run(args); assert.equal(first.code, 0, first.stderr); const job = JSON.parse(first.stdout);
  assert.match(job.id, /^[a-f0-9-]{36}$/); assert.equal(job.notify, false); assert.equal(job.specification, undefined);
  const repeat = await run(args); assert.equal(repeat.code, 0, repeat.stderr); assert.equal(JSON.parse(repeat.stdout).id, job.id);
  const result = await until(async () => { const value = await run(['background', 'status', job.id, '--json']); assert.equal(value.code, 0, value.stderr); const saved = JSON.parse(value.stdout); return saved.state === 'completed' && saved; });
  assert.equal(result.outcome.exitCode, 0);
  const logs = await run(['background', 'logs', job.id, '--json']); assert.equal(logs.code, 0, logs.stderr);
  const event = logs.stdout.trim().split('\n').map(JSON.parse)[0]; assert.equal(event.type, 'job.log'); assert.equal(event.jobId, job.id);
  assert.deepEqual(JSON.parse(event.data.text), { args: ['a b', '--json', '$(literal)'], cwd });
  const list = await run(['background', 'list', '--json']); assert.equal(JSON.parse(list.stdout).items.length, 1);
  const notified = await run(['--background', file, '--cwd', cwd, '--notif', '--json']); assert.equal(notified.code, 0, notified.stderr); assert.equal(JSON.parse(notified.stdout).notify, true);
  const missing = await run(['background', 'status', '00000000-0000-0000-0000-000000000000', '--json']);
  assert.equal(missing.code, 1); assert.equal(JSON.parse(missing.stderr).code, 'JOB_NOT_FOUND'); assert.equal(missing.stdout, '');
});
test('cancel works and saved status/logs remain readable with Core stopped, without reactivating it', async () => {
  const file = path.join(directory, 'wait.mjs'); fs.writeFileSync(file, "console.log('ready');setInterval(()=>{},1000);");
  const result = await run(['--background', file, '--json']); assert.equal(result.code, 0, result.stderr); const { id } = JSON.parse(result.stdout);
  const cancelled = await run(['background', 'cancel', id, '--json', '--request-id', 'cancel-once']); assert.equal(cancelled.code, 0, cancelled.stderr);
  await until(async () => JSON.parse((await run(['background', 'status', id, '--json'])).stdout).state === 'cancelled');
  const info = runtimeInfo(); await runtimeRequest(info, 'POST', '/operator-stop', {}); await until(() => !identityAlive(info.identity));
  const status = await run(['background', 'status', id, '--json']); assert.equal(status.code, 0, status.stderr); assert.equal(JSON.parse(status.stdout).state, 'cancelled');
  assert.equal((await run(['background', 'logs', id, '--json'])).code, 0); assert.equal((await run(['background', 'list', '--json'])).code, 0);
  assert.equal(operatorStopRequested(), true); assert.equal(runtimeInfo(), null);
});
