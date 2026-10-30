import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { backgroundJobKind, backgroundActive, finishBackgroundJob } from './background-jobs.js';
import { getRecord, putRecord, appendEvent, transaction, now } from './database.js';
import { processIdentity, signalProcess } from './process-identity.js';
import { diagnosticRedactor } from './diagnostic-redaction.js';
import { toolEnvironment } from './execution-environment.js';
import { sharedSecrets } from './share-bundle-policy.js';

const id = process.argv[2];
const maximumLogs = 8 * 1024 * 1024;
let gate, gateIdentity, stopTimer, monitor, outcome, stopReason, loggingFailed = false;
const redactor = diagnosticRedactor({ maxString: 256 * 1024,
  secrets: sharedSecrets().flatMap(secret => [secret, ...secret.split(/\r?\n/).filter(part => part.length >= 6)]) });
function log(stream, text) {
  if (!text || loggingFailed) return;
  try {
    const safe = redactor.scrub(text).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
    transaction(db => {
      const job = getRecord(backgroundJobKind, id);
      if (!backgroundActive(job) || job.logsTruncated) return;
      const bytes = Buffer.byteLength(safe);
      if (job.logBytes + bytes > maximumLogs - 128) {
        const text = '[log limit reached; remaining output omitted]\n';
        appendEvent(id, 'job.log', { stream: 'system', text }, db);
        putRecord(backgroundJobKind, id, { ...job, logBytes: job.logBytes + Buffer.byteLength(text), logsTruncated: true, updatedAt: now() }, db);
      } else {
        appendEvent(id, 'job.log', { stream, text: safe }, db);
        putRecord(backgroundJobKind, id, { ...job, logBytes: job.logBytes + bytes, updatedAt: now() }, db);
      }
    });
  } catch { loggingFailed = true; stop('JOB_LOG_FAILURE'); }
}
function capture(stream) {
  const decoder = new StringDecoder('utf8'); let pending = '', dropping = false, privateBlock = false, bindingQuote, complete = [];
  const line = text => {
    const closes = (value, quote) => new RegExp(`(?:^|[^\\\\])${quote}`).test(value);
    if (bindingQuote) {
      if (closes(text, bindingQuote)) bindingQuote = undefined;
      complete.push('[redacted multiline binding]\n'); return;
    }
    const binding = /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|cookie|authorization)["']?\s*[:=]\s*(["'])/.exec(text);
    if (binding && !closes(text.slice(binding.index + binding[0].length), binding[1])) {
      bindingQuote = binding[1]; complete.push('[redacted multiline binding]\n'); return;
    }
    if (/-----BEGIN .*PRIVATE KEY-----/.test(text)) privateBlock = true;
    if (privateBlock) {
      if (/-----END .*PRIVATE KEY-----/.test(text)) privateBlock = false;
      complete.push('[redacted private key]\n');
    } else complete.push(text);
  };
  const write = text => {
    for (const part of text.split(/(?<=\n)/)) {
      if (!part) continue;
      if (!dropping) pending += part;
      if (pending.length > 65536) { pending = ''; dropping = true; }
      if (part.endsWith('\n')) {
        if (dropping) complete.push('[oversized log line omitted]\n'); else line(pending);
        pending = ''; dropping = false;
      }
    }
    if (complete.length) { log(stream, complete.join('')); complete = []; }
  };
  return { write: chunk => write(decoder.write(chunk)), end: () => { write(decoder.end()); if (dropping) log(stream, '[oversized log line omitted]\n'); else if (pending) line(pending); if (complete.length) log(stream, complete.join('')); } };
}
function stop(reason) {
  if (stopReason) return; stopReason = reason;
  transaction(db => {
    const current = getRecord(backgroundJobKind, id);
    if (backgroundActive(current) && !current.stopReason) {
      putRecord(backgroundJobKind, id, { ...current, state: 'cancelling', stopReason: reason, stopRequestedAt: now(), updatedAt: now() }, db);
      appendEvent(id, 'job.cancelling', { state: 'cancelling', reason }, db);
    }
  });
  if (gateIdentity) signalProcess(gateIdentity, 'SIGTERM', { group: true });
  stopTimer = setTimeout(() => { if (gateIdentity) signalProcess(gateIdentity, 'SIGKILL', { group: true }); }, 1500);
}
async function run() {
  let job = getRecord(backgroundJobKind, id);
  if (job?.state !== 'launching') return;
  const identity = processIdentity();
  if (!identity || identity.start === 'platform-unverified') throw new Error('identity');
  transaction(db => {
    job = getRecord(backgroundJobKind, id);
    if (job?.state === 'launching') putRecord(backgroundJobKind, id, { ...job, runner: identity, updatedAt: now() }, db);
  });
  const authorized = await new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), 15_000);
    const finish = value => { clearTimeout(timer); process.removeListener('disconnect', disconnected); resolve(value); };
    const disconnected = () => finish(false);
    process.once('disconnect', disconnected);
    process.once('message', message => finish(message?.type === 'go'));
    process.send?.({ type: 'ready', id });
  });
  if (!authorized) { finishBackgroundJob(id, 'interrupted', { code: 'JOB_INTERRUPTED' }); return; }
  job = getRecord(backgroundJobKind, id);
  if (job.state !== 'launching' || job.stopReason) {
    finishBackgroundJob(id, job.stopReason === 'JOB_CANCELLED' ? 'cancelled' : 'interrupted', { code: job.stopReason || 'JOB_INTERRUPTED' }); return;
  }
  const spec = getRecord('core.background.specification', id), stat = fs.statSync(spec.script);
  if (['dev', 'ino', 'size', 'mtimeMs'].some(key => stat[key] !== spec.file[key])) {
    finishBackgroundJob(id, 'failed', { code: 'JOB_SCRIPT_CHANGED' }); return;
  }
  transaction(db => {
    job = getRecord(backgroundJobKind, id);
    if (job.state !== 'launching' || job.stopReason) return;
    job = { ...job, state: 'running', startedAt: now(), updatedAt: now() };
    putRecord(backgroundJobKind, id, job, db); appendEvent(id, 'job.running', { state: 'running' }, db);
  });
  if (job.state !== 'running' || job.stopReason) { finishBackgroundJob(id, 'interrupted', { code: job.stopReason || 'JOB_INTERRUPTED' }); return; }
  const stdout = capture('stdout'), stderr = capture('stderr');
  gate = spawn(process.execPath, [fileURLToPath(new URL('./background-job-process.js', import.meta.url))], {
    detached: true, env: toolEnvironment(), cwd: spec.cwd, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  gate.stdout.on('data', stdout.write); gate.stderr.on('data', stderr.write);
  gate.on('message', message => {
    if (message?.type === 'result') { outcome = message; return; }
    if (message?.type !== 'ready') return;
    gateIdentity = processIdentity(gate.pid);
    if (!gateIdentity || gateIdentity.pgid !== gateIdentity.pid) { gate.kill('SIGKILL'); return; }
    const allowed = transaction(db => {
      const current = getRecord(backgroundJobKind, id);
      if (current.state !== 'running' || current.stopReason || stopReason) return false;
      putRecord(backgroundJobKind, id, { ...current, process: gateIdentity }, db); return true;
    });
    if (allowed) gate.send({ type: 'go', command: spec.command, args: spec.args, cwd: spec.cwd }, error => { if (error) stop('JOB_START_FAILED'); });
    else { stop(getRecord(backgroundJobKind, id)?.stopReason || 'JOB_INTERRUPTED'); }
  });
  monitor = setInterval(() => {
    const current = getRecord(backgroundJobKind, id);
    if (current?.stopReason) stop(current.stopReason);
    else if (job.timeoutSeconds && Date.now() - Date.parse(job.startedAt) >= job.timeoutSeconds * 1000) stop('JOB_TIMEOUT');
  }, 100);
  await new Promise(resolve => { gate.once('error', () => { outcome = { code: 'JOB_START_FAILED' }; resolve(); }); gate.once('close', resolve); });
  stdout.end(); stderr.end();
  const reason = getRecord(backgroundJobKind, id)?.stopReason || stopReason;
  const state = reason === 'JOB_CANCELLED' ? 'cancelled' : reason === 'JOB_TIMEOUT' ? 'timed_out'
    : ['CORE_STOPPED', 'JOB_INTERRUPTED'].includes(reason) ? 'interrupted'
    : reason || !outcome || outcome.code || outcome.exitCode !== 0 ? 'failed' : 'completed';
  finishBackgroundJob(id, state, { ...outcome, code: reason || outcome?.code || (state === 'failed' ? 'JOB_EXIT' : null) });
}
process.on('SIGTERM', () => stop('JOB_INTERRUPTED')); process.on('SIGINT', () => stop('JOB_INTERRUPTED'));
try { await run(); }
catch { if (gateIdentity) signalProcess(gateIdentity, 'SIGKILL', { group: true }); finishBackgroundJob(id, 'failed', { code: 'JOB_START_FAILED' }); }
finally { clearInterval(monitor); clearTimeout(stopTimer); if (process.connected) process.disconnect(); }
