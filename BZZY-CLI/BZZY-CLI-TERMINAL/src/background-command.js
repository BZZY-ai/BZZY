import { randomUUID } from 'node:crypto';
import { activateCLIHost } from '@bzzy/core/engine/host-service.js';
import { ensureRuntime, runtimeInfo, runtimeRequest } from '@bzzy/core/engine/runtime.js';
import { identityAlive } from '@bzzy/core/engine/process-identity.js';
import { backgroundJob, listBackgroundJobs, backgroundJobEvents, cancelBackgroundJob, pumpBackgroundJobs } from '@bzzy/core/engine/background-jobs.js';

export async function backgroundCLI(args, options) {
  const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
  if (options.backgroundScript) {
    if (args.length) throw new Error('Place script arguments after --. Use bzzy --background SCRIPT [options] -- ARG...');
    await activateCLIHost();
    const info = await ensureRuntime();
    const job = await runtimeRequest(info, 'POST', '/v1/jobs', { script: options.backgroundScript, args: options.scriptArgs || [],
      cwd: options.cwd, timeoutSeconds: options.timeoutSeconds || 0, notify: options.notify === true }, options.requestId || randomUUID());
    if (options.json) emit(job);
    else process.stdout.write(`Job ${job.id} · ${job.state}\nStatus: bzzy background status ${job.id}\n`);
    return 0;
  }
  const [action, id, ...extra] = args;
  if (!['list', 'status', 'logs', 'cancel'].includes(action) || extra.length || (action === 'list' ? id !== undefined : !id))
    throw new Error('Use bzzy background list|status JOB_ID|logs JOB_ID|cancel JOB_ID.');
  const local = () => { pumpBackgroundJobs({ launch: false }); };
  const request = async (method, suffix, body, requestId, fallback) => {
    const info = runtimeInfo();
    if (info && identityAlive(info.identity)) return runtimeRequest(info, method, `/v1/jobs${suffix}`, body, requestId);
    local(); return fallback();
  };
  if (action === 'list') {
    const result = await request('GET', '', undefined, undefined, () => listBackgroundJobs());
    if (options.json) emit(result);
    else { for (const job of result.items) process.stdout.write(`${job.id}  ${job.state.padEnd(12)} ${job.script}\n`); }
    return 0;
  }
  if (action === 'logs') {
    let cursor = 0, interrupted = false;
    const interrupt = () => { interrupted = true; };
    if (options.follow) process.once('SIGINT', interrupt);
    try {
      while (!interrupted) {
        const result = await request('GET', `/${id}/logs?after=${cursor}`, undefined, undefined, () => {
          const job = backgroundJob(id), events = backgroundJobEvents(id, cursor, 200, { logs: true });
          return { events, nextCursor: events.at(-1)?.seq || cursor, hasMore: events.length === 200, state: job.state, logsTruncated: job.logsTruncated };
        });
        for (const event of result.events) { if (options.json) emit(event); else process.stdout.write(event.data.text); }
        cursor = result.nextCursor;
        if (result.hasMore) continue;
        if (!options.follow || !['queued', 'launching', 'running', 'cancelling'].includes(result.state)) break;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    } finally { process.removeListener('SIGINT', interrupt); }
    return 0;
  }
  const job = action === 'cancel'
    ? await request('POST', `/${id}/cancel`, {}, options.requestId || randomUUID(), () => cancelBackgroundJob(id, options.requestId || randomUUID()))
    : await request('GET', `/${id}`, undefined, undefined, () => backgroundJob(id));
  if (options.json) emit(job);
  else process.stdout.write(`Job ${job.id} · ${job.state}\n${job.script}\n${job.outcome ? `Exit: ${job.outcome.exitCode ?? 'unknown'}${job.outcome.signal ? ` · ${job.outcome.signal}` : ''}${job.outcome.code ? ` · ${job.outcome.code}` : ''}\n` : ''}`);
  return 0;
}
