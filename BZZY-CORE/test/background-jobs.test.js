import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { BzzyClient, BzzyCore } from '../src/index.js';
import { ensureRuntime, runtimeRequest, runtimeInfo, clearOperatorStopIntent } from '../src/engine/runtime.js';
import { getRecord, putRecord, listRecords } from '../src/engine/database.js';
import { processIdentity, identityAlive, signalProcess } from '../src/engine/process-identity.js';
import { submitBackgroundJob, cancelBackgroundJob, pumpBackgroundJobs, backgroundJobKind } from '../src/engine/background-jobs.js';
import { createSession } from '../src/engine/store.js';
import { BUILTINS } from '../src/engine/providers.js';

let directory, previous, client;
async function until(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(40); }
  assert.fail(`Timed out: ${label}`);
}
const script = (body, extension = '.mjs') => { const file = path.join(directory, randomUUID() + extension); fs.writeFileSync(file, body); return file; };
const submit = (file, options = {}) => client.submitJob({ script: file, cwd: directory, requestId: randomUUID(), ...options });
const settled = id => until(async () => { const job = await client.job(id); return ['completed', 'failed', 'cancelled', 'timed_out', 'interrupted'].includes(job.state) && job; }, 'job outcome');
const running = id => until(async () => { const job = getRecord(backgroundJobKind, id); return job?.process && job.state === 'running' && job; }, 'script launch');
const logs = async id => (await client.jobLogs(id, { limit: 1000 })).events.map(event => event.data.text).join('');
async function reconnect() { const info = await ensureRuntime(); client = new BzzyClient({ ...info }); return info; }
test.before(async () => {
  previous = { BZZY_HOME: process.env.BZZY_HOME, OPENAI_API_KEY: process.env.OPENAI_API_KEY };
  directory = fs.realpathSync(fs.mkdtempSync(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'bz-job-')));
  process.env.BZZY_HOME = path.join(directory, 'private'); process.env.OPENAI_API_KEY = 'fixture-private-provider-key';
  await reconnect();
});
test.after(async () => {
  const info = runtimeInfo();
  if (info && identityAlive(info.identity)) await runtimeRequest(info, 'POST', '/operator-stop', {}).catch(() => {});
  await until(() => !info || !identityAlive(info.identity), 'Core exit').catch(() => {});
  for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  fs.rmSync(directory, { recursive: true, force: true });
});

test('literal arguments, cwd, stderr, stdin EOF, filtered environment and final unterminated output are durable', async () => {
  const file = script(`import fs from 'node:fs';
    console.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),secret:process.env.OPENAI_API_KEY,stdin:fs.readFileSync(0,'utf8')}));
    console.error('stderr record'); process.stdout.write('final output');`);
  const args = ['a b', '', '--json', '; touch NEVER', '$(touch NEVER)', '🌍', "quote'\"\\"];
  const job = await submit(file, { args }); assert.equal(job.state, 'queued');
  assert.equal(job.specification, undefined); assert.equal(job.runner, undefined);
  const result = await settled(job.id); assert.equal(result.state, 'completed'); assert.equal(result.outcome.exitCode, 0);
  const text = await logs(job.id); assert.match(text, /stderr record/); assert.match(text, /final output/);
  const output = JSON.parse(text.split('\n').find(line => line.startsWith('{')));
  assert.deepEqual(output, { args, cwd: directory, stdin: '' }); assert.ok(!fs.existsSync(path.join(directory, 'NEVER')));
  assert.equal(listRecords('outbox').some(row => row.event.jobId === job.id), false, 'no alert without notify');
  assert.equal((await client.jobs()).items[0].id, job.id);
});

test('concurrent retries return the same saved job; changed input conflicts and a missing source cannot trigger replay', async () => {
  const counter = path.join(directory, 'counter'), file = script(String.raw`import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(counter)},'run\n'); await new Promise(r=>setTimeout(r,400));`);
  const input = { script: file, cwd: directory, requestId: 'fixture-stable-request' };
  const replies = await Promise.all(Array.from({ length: 8 }, () => client.submitJob(input)));
  assert.equal(new Set(replies.map(job => job.id)).size, 1);
  await assert.rejects(client.submitJob({ ...input, args: ['different'] }), { status: 409 });
  assert.equal((await settled(replies[0].id)).state, 'completed');
  fs.unlinkSync(file);
  assert.equal((await client.submitJob(input)).id, replies[0].id);
  await delay(1100); assert.equal(fs.readFileSync(counter, 'utf8'), 'run\n');
});

test('exit failures retain the actual code and replayable JSON/SSE events without exposing execution specifications', async () => {
  const job = await submit(script("console.log('before error'); process.exitCode=7;"));
  const result = await settled(job.id); assert.equal(result.state, 'failed'); assert.equal(result.outcome.exitCode, 7);
  const page = await client.jobEvents(job.id); assert.deepEqual(page.events.map(event => event.type), ['job.queued', 'job.running', 'job.log', 'job.failed']);
  const abort = new AbortController(), seen = [];
  for await (const event of client.streamJob(job.id, { signal: abort.signal, after: page.events[0].seq })) {
    seen.push(event); if (event.type === 'job.failed') abort.abort();
  }
  assert.equal(seen.at(-1).data.outcome.exitCode, 7); assert.ok(seen.every(event => event.jobId === job.id && !event.sessionId));
  assert.equal((await client.jobEvents(job.id, { after: seen.at(-1).seq })).events.length, 0);
  const schema = await client.request('GET', '/v1/jobs/schema'); assert.ok(schema.required.includes('jobId'));
});

test('timeout and cancellation terminate verified process groups including descendants', async () => {
  const pidFile = path.join(directory, 'descendant.pid');
  const file = script(`import fs from 'node:fs'; import {spawn} from 'node:child_process';
    const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)']);
    fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid)); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);`);
  const job = await submit(file, { timeoutSeconds: 1 });
  await until(() => fs.existsSync(pidFile), 'descendant'); const descendant = processIdentity(Number(fs.readFileSync(pidFile, 'utf8')));
  assert.equal((await settled(job.id)).state, 'timed_out'); await until(() => !identityAlive(descendant), 'descendant termination');
  const next = await submit(file); await running(next.id);
  const cancelled = await client.cancelJob(next.id, { requestId: 'cancel-once' }); assert.equal(cancelled.state, 'cancelling');
  assert.equal((await settled(next.id)).state, 'cancelled');
  assert.equal((await client.cancelJob(next.id, { requestId: 'cancel-once' })).state, 'cancelled');
});

test('inert queued jobs can be cancelled offline and never get dispatched', () => {
  const job = submitBackgroundJob({ script: script("throw new Error('must not execute')"), cwd: directory }, randomUUID());
  assert.equal(cancelBackgroundJob(job.id, 'offline-cancel').state, 'cancelled');
  pumpBackgroundJobs({ launch: false }); assert.equal(getRecord(backgroundJobKind, job.id).runner, undefined);
});

test('an abandoned dispatch is interrupted instead of retried, and a changed queued script is rejected', async () => {
  const file = script("console.log('original');");
  const queued = submitBackgroundJob({ script: file, cwd: directory }, randomUUID());
  const record = getRecord(backgroundJobKind, queued.id);
  putRecord(backgroundJobKind, queued.id, { ...record, state: 'launching', launchedAt: new Date(0).toISOString(), launcher: { pid: 2147483647, start: 'fixture-gone' } });
  pumpBackgroundJobs({ launch: false }); assert.equal((await client.job(queued.id)).state, 'interrupted');
  const changed = submitBackgroundJob({ script: file, cwd: directory }, randomUUID());
  fs.writeFileSync(file, "console.log('changed source must never execute');");
  const result = await settled(changed.id); assert.equal(result.state, 'failed'); assert.equal(result.outcome.code, 'JOB_SCRIPT_CHANGED'); assert.equal(await logs(changed.id), '');
});

test('scripts survive a control-daemon restart without duplicate execution', async () => {
  const marker = path.join(directory, 'restart-marker');
  const job = await submit(script(String.raw`import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(marker)},'run\n'); console.log('started'); await new Promise(r=>setTimeout(r,2500)); console.log('done');`));
  await running(job.id); const old = runtimeInfo(); await runtimeRequest(old, 'POST', '/shutdown', {});
  await until(() => !identityAlive(old.identity), 'daemon stopped'); await reconnect();
  assert.equal((await settled(job.id)).state, 'completed'); assert.equal(fs.readFileSync(marker, 'utf8'), 'run\n');
  assert.match(await logs(job.id), /done/);
});

test('a killed job supervisor becomes interrupted, kills its child and is never rerun', async () => {
  const job = await submit(script("console.log('once');setInterval(()=>{},1000);"));
  const live = await running(job.id); await until(async () => (await logs(job.id)).includes('once'), 'actual script output'); signalProcess(live.runner, 'SIGKILL');
  assert.equal((await settled(job.id)).state, 'interrupted'); await until(() => !identityAlive(live.process), 'orphan group exit');
  await delay(1100); assert.equal((await logs(job.id)).match(/once/g)?.length, 1);
});

test('logs redact credentials across chunks, omit oversized lines, bound storage and retain stream identity', async () => {
  const job = await submit(script(String.raw`process.stdout.write('Authorization: Bear'); await new Promise(r=>setTimeout(r,50));
    console.log('er fixture-private-provider-key'); process.stdout.write('password="binding-first\n'); await new Promise(r=>setTimeout(r,50)); console.log('binding-second"');
    console.log('x'.repeat(70000)+' hidden-tail');
    for(let i=0;i<1200;i++) console.log('line'+i+' '+'.'.repeat(8000)); console.error('stderr-safe');`));
  const result = await settled(job.id); assert.equal(result.state, 'completed'); assert.equal(result.logsTruncated, true);
  assert.ok(result.logBytes <= 8 * 1024 * 1024);
  const text = await logs(job.id); assert.doesNotMatch(text, /fixture-private-provider-key|hidden-tail|binding-first|binding-second/); assert.match(text, /redacted|omitted/); assert.match(text, /log limit reached/);
});

test('invalid input, credentials, foreign origins and scoped session tokens cannot start or inspect host jobs', async () => {
  const file = script('console.log(1)');
  for (const input of [{ args: ['--token', 'private'] }, { args: ['fixture-private-provider-key'] }, { timeoutSeconds: -1 }, { notify: 'yes' }, { environment: { PATH: '/tmp' } }, { args: [1] }])
    await assert.rejects(submit(file, input), { status: 400 });
  const session = createSession(BUILTINS.deepseek, directory), token = await client.sessionToken(session.id);
  const observer = new BzzyClient({ url: runtimeInfo().url, token: token.token });
  await assert.rejects(observer.jobs(), { status: 403 }); await assert.rejects(observer.submitJob({ script: file, cwd: directory, requestId: randomUUID() }), { status: 403 });
  const response = await fetch(runtimeInfo().url + '/v1/jobs', { headers: { authorization: `Bearer ${runtimeInfo().token}`, origin: 'https://foreign.example' } });
  assert.equal(response.status, 403); assert.equal((await new BzzyCore().jobs()).items.length > 0, true);
});

test('explicit Core stop interrupts scripts durably and a subsequent start never replays them', async () => {
  const marker = path.join(directory, 'stop-marker');
  const job = await submit(script(String.raw`import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(marker)},'run\n'); setInterval(()=>{},1000);`));
  await until(() => fs.existsSync(marker), 'script side effect'); await running(job.id); const info = runtimeInfo(); await runtimeRequest(info, 'POST', '/operator-stop', {});
  await until(() => !identityAlive(info.identity), 'operator stop');
  assert.equal(getRecord(backgroundJobKind, job.id).state, 'interrupted');
  clearOperatorStopIntent(); await reconnect(); await delay(1100);
  assert.equal((await client.job(job.id)).state, 'interrupted'); assert.equal(fs.readFileSync(marker, 'utf8'), 'run\n');
});
