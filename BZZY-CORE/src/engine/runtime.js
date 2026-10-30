import { queueCustomNotification } from './custom-notifications.js';
import { sessionCompactorUsage } from './compaction-cost.js';
import { coreUpdates } from './updates.js';
import { guardedInterval } from './interval.js';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { home, privateDir, readJson, writeJson, loadSession, saveSession, findSession, lockFile, lockOwner, sessionDeleted, recordSessionLifecycle } from './store.js';
import { deleteTerminalConversation } from './session-deletion.js';
import { database, getRecord, putRecord, listRecords, removeRecord, appendEvent, events, eventsBefore, reserveRequest, transaction, now, digest } from './database.js';
import { processIdentity, identityAlive, reconcileSession, recoverOrphanedVerification } from './recovery.js';
import { root, runtimeEnv } from './process.js';
import { getProvider, providers } from './providers.js';
import { delay } from './delegation.js';
import { RunnerUI } from './runtime-ui.js';
import { effectivePolicy } from './policy.js';
import { enqueueExecution } from './execution-queue.js';
import { reserveExecutionLaunch, recordExecutionProcess, requestExecutionStop, superviseExecutions, settleExecutionControls, pauseRuntimeExecutions } from './runtime-processes.js';
import { captureEnvironment, readExecutionEnvironment, removeExecutionEnvironment } from './execution-environment.js';
import { activeAccess, accessAllows, publicAccess, createSessionAccess, revokeSessionAccess, migrateSessionAccess, accessPrincipalActive, sessionPermissions } from './session-access.js';
import { sandboxSupport } from './policy.js';
import { diagnosticError } from './diagnostic-error.js';
import { CorePushWorker } from '../push/worker.js';
import { terminalYolo } from './terminal-permissions.js';
import { submitSessionInput } from './session-input.js';
import { assertCoreAvailable } from './maintenance.js';
import { HostMetricsSampler } from './host-metrics.js';
import { authorizedOwnPhoneTerminalInput } from './update-access.js';
import { recoverLearningJobs, processLearningReviews, pauseLearningForSession, pauseAllLearning } from './learning.js';
import { processSkillEvolution } from './skill-evolution-runner.js';
import { recoverSessionCompactions, processSessionCompactions, pauseSessionCompaction, pauseAllSessionCompactions } from './session-compactor.js';
import { CoreKnowledge } from '../knowledge.js';
import { recordGoalValidationResult } from './goal-validation.js';
import { assertGoalWorkflowAdmission } from './workflows.js';
import { assertGoalScopeAdmission } from './program-scope.js';
import { sessionInvocations } from './invocation-state.js';
import { createExecutionObserver } from './execution-observation.js';
import { sessionMetricsFamily } from './session-metrics.js';
import { deepseekSpendingVisible, sessionSpending } from './session-cost.js';
import { submitBackgroundJob, backgroundJob, listBackgroundJobs, backgroundJobEvents, cancelBackgroundJob, pumpBackgroundJobs, stopBackgroundJobs } from './background-jobs.js';

const observeExecution = createExecutionObserver();

const runtimeBuild = digest(['src', 'assets', 'bin'].flatMap(directory => fs.readdirSync(path.join(root, directory), { recursive: true })
  .filter(file => !file.split(path.sep).some(part => part.startsWith('._')) && fs.statSync(path.join(root, directory, file)).isFile()).sort()
  .map(file => [directory + '/' + file, digest(fs.readFileSync(path.join(root, directory, file)))])));
function environmentFingerprint() {
  const keys = ['PATH', 'BZZY_CODEX_BIN', 'BZZY_CLAUDE_BIN', 'CODEX_HOME', 'BZZY_CODEX_HOME', 'CLAUDE_CONFIG_DIR',
    'CLAUDE_SECURESTORAGE_CONFIG_DIR', 'BZZY_CLAUDE_HOME', ...Object.values(providers()).map(provider => provider.envKey).filter(Boolean)];
  return digest(Object.fromEntries(keys.map(key => [key, key === 'PATH'
    ? [...new Set([path.dirname(process.execPath), ...(process.env.PATH || '').split(path.delimiter)])].join(path.delimiter) : process.env[key] ?? null])));
}

export const runtimeFile = () => path.join(home(), 'runtime', 'service.json');
export const runtimeInfo = () => readJson(runtimeFile(), null);
const operatorStopFile = () => path.join(home(), 'runtime', 'operator-stop.json');
const stopAttempt = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
export function operatorStopIntent() {
  const value = readJson(operatorStopFile(), null);
  if (value?.stopped !== true) return null;
  return { version: 1, stopped: true, source: value.source === 'service_start_failure' ? value.source : 'operator',
    id: typeof value.id === 'string' ? value.id : null, stoppedAt: value.stoppedAt || null,
    ...(stopAttempt(value.attemptId) ? { attemptId: value.attemptId } : {}) };
}
export const operatorStopRequested = () => operatorStopIntent() !== null;
function changeOperatorStop(operation) {
  const deadline = Date.now() + 1000;
  let unlock;
  while (!unlock) {
    try { unlock = lockFile(path.join(home(), 'runtime', 'operator-stop-transition.lock'), 'Core stop state is changing.'); }
    catch (error) {
      if (error.code !== 'BZZY_LOCKED' || Date.now() >= deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try { return operation(); } finally { unlock(); }
}
export function persistOperatorStopIntent({ source = 'operator', attemptId } = {}) {
  if (!['operator', 'service_start_failure'].includes(source) || source === 'service_start_failure' && !stopAttempt(attemptId))
    throw new Error('Invalid Core stop provenance.');
  return changeOperatorStop(() => {
    const previous = operatorStopIntent();
    // A failed supervised start must never overwrite an explicit user's Stop.
    if (source === 'service_start_failure' && previous) return previous;
    const value = { version: 1, stopped: true, id: randomUUID(), source, stoppedAt: now(),
      ...(source === 'service_start_failure' ? { attemptId } : {}) };
    writeJson(operatorStopFile(), value); return value;
  });
}
export function clearOperatorStopIntent({ expectedId, expectedSource, expectedAttemptId } = {}) {
  return changeOperatorStop(() => {
    const value = operatorStopIntent(), conditional = expectedId !== undefined || expectedSource !== undefined || expectedAttemptId !== undefined;
    if (conditional && (!value || expectedId !== undefined && value.id !== expectedId || expectedSource !== undefined && value.source !== expectedSource ||
        expectedAttemptId !== undefined && value.attemptId !== expectedAttemptId)) return false;
    fs.rmSync(operatorStopFile(), { force: true }); return true;
  });
}
export { pauseRuntimeExecutions };
function groupChildren(session) {
  if (!['parallel', 'besties'].includes(session?.mode)) return [];
  const group = getRecord(session.mode, session.id);
  if (!group && session.modeRevision || group && (group.goalId && group.goalId !== session.goal?.id || (group.modeRevision || 0) !== (session.modeRevision || 0))) return [];
  const peers = group?.peers, ids = peers && new Set(peers.map(peer => peer.sessionId));
  return listRecords('session', { parentSessionId: session.id }).filter(child => !ids || ids.has(child.id));
}
export function effectiveInputOwner(sessionId) {
  const lease = getRecord('input-owner', sessionId);
  if (lease && lease.expiresAt > Date.now() && accessPrincipalActive(lease.principal)) return lease;
  const session = loadSession(sessionId);
  return session?.parentSessionId ? effectiveInputOwner(session.parentSessionId) : null;
}
export function claimInput(sessionId, owner, takeover = false, principal = 'owner') {
  if (typeof owner !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(owner)) throw new Error('Invalid input-owner ID.');
  return transaction(db => {
    if (sessionDeleted(sessionId)) throw Object.assign(new Error('This chat was deleted.'), { code: 'SESSION_DELETED', status: 404 });
    const previous = effectiveInputOwner(sessionId);
    if (previous && (previous.owner !== owner || (previous.principal || 'owner') !== principal) && !takeover) throw Object.assign(new Error('Another client owns input. Attach explicitly to transfer ownership.'), { code: 'CONFLICT' });
    const lease = { owner, principal, sessionId, expiresAt: Date.now() + 45000 };
    putRecord('input-owner', sessionId, lease, db);
    if (takeover) for (const child of groupChildren(loadSession(sessionId))) putRecord('input-owner', child.id, { ...lease, sessionId: child.id, inheritedFrom: sessionId }, db);
    if (previous?.owner !== owner || (previous?.principal || 'owner') !== principal) appendEvent(sessionId, 'input.owner', { owner, previousOwner: previous?.owner || null, principal }, db);
    return lease;
  });
}
export function requireOwner(sessionId, owner, principal) {
  const lease = effectiveInputOwner(sessionId);
  if (!lease || lease.owner !== owner || principal && (lease.principal || 'owner') !== principal) throw Object.assign(new Error('This client does not own input. Use --attach to take control.'), { code: 'CONFLICT' });
}
export function releaseInput(sessionId, owner, principal) {
  const lease = getRecord('input-owner', sessionId);
  if (lease?.owner === owner && (!principal || (lease.principal || 'owner') === principal)) removeRecord('input-owner', sessionId);
  for (const child of listRecords('session', { parentSessionId: sessionId })) {
    const inherited = getRecord('input-owner', child.id);
    if (inherited?.owner === owner && inherited.inheritedFrom === sessionId && (!principal || (inherited.principal || 'owner') === principal)) removeRecord('input-owner', child.id);
  }
}
async function readBody(request) {
  const chunks = []; let bytes = 0;
  for await (const chunk of request) { bytes += chunk.length; if (bytes > 256 * 1024) throw new Error('Request exceeds 256 KiB.'); chunks.push(chunk); }
  return bytes ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}
export async function serveRuntime() {
  assertCoreAvailable();
  privateDir(path.join(home(), 'runtime')); database();
  const unlock = lockFile(path.join(home(), 'runtime', 'service.lock'), 'A bzzy runtime is already starting or running.');
  const existing = runtimeInfo();
  if (existing && identityAlive(existing.identity)) throw new Error('A bzzy service is already running.');
  migrateSessionAccess();
  const listenerFile = path.join(home(), 'runtime', 'listener.json'), listener = readJson(listenerFile, {});
  const token = listener.token || randomUUID() + randomUUID(), identity = processIdentity();
  const environment = environmentFingerprint();
  for (const run of listRecords('run')) if (!sessionDeleted(run.sessionId) && ['starting', 'running', 'waiting_for_input'].includes(run.state) && !identityAlive(run.runner)) reconcileSession(run.sessionId);
  for (const session of listRecords('session')) if (!sessionDeleted(session.id) && session.goal?.status === 'verifying') recoverOrphanedVerification(session.id);
  superviseExecutions();
  recoverLearningJobs();
  recoverSessionCompactions();
  pumpBackgroundJobs({ launch: false });
  const send = (response, status, value) => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); response.end(JSON.stringify(value)); };
  let stopping = false, quiescing = operatorStopRequested(), operatorStopPromise, learningPump, memoryPump; const streams = new Set();
  const metrics = new HostMetricsSampler(), knowledge = new CoreKnowledge();
  let relayService, relayServicePromise;
  const relay = () => relayServicePromise ||= import('../relay/service.js')
    .then(({ CoreRelayService }) => relayService = new CoreRelayService());
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      const pathname = url.pathname.replace(/^\/v1(?=\/|$)/, '') || '/';
      if (request.method === 'GET' && ['/', '/app.js'].includes(pathname)) {
        const file = path.join(root, 'assets', pathname === '/' ? 'runtime.html' : 'runtime-web.js');
        response.writeHead(200, { 'content-type': pathname === '/' ? 'text/html' : 'text/javascript', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'", 'cache-control': 'no-store' });
        response.end(fs.readFileSync(file)); return;
      }
      const supplied = (request.headers.authorization || '').replace(/^Bearer /, '');
      const rootToken = Buffer.byteLength(supplied) === Buffer.byteLength(token) && timingSafeEqual(Buffer.from(supplied), Buffer.from(token));
      const accessKey = digest(supplied), access = rootToken ? null : getRecord('access-token', accessKey);
      const requireAccess = permission => {
        if (!rootToken && !activeAccess(getRecord('access-token', accessKey))) throw Object.assign(new Error('Authentication required.'), { status: 401 });
        if (access && !access.permissions?.includes(permission)) throw Object.assign(new Error(access.permissions?.length === 1 ? 'This token grants observation only.' : `This token does not grant ${permission}.`), { status: 403 });
      };
      requireAccess('observe');
      const principal = rootToken ? 'owner' : `grant:${access.id || accessKey}`;
      if (request.headers.origin && ![`http://127.0.0.1:${server.address().port}`, `http://localhost:${server.address().port}`].includes(request.headers.origin)) { send(response, 403, { error: 'Foreign origin denied.' }); return; }
      if (request.method === 'POST' && pathname === '/operator-stop') {
        if (!rootToken) { send(response, 403, { error: 'Only the local owner can stop Core work.' }); return; }
        const input = await readBody(request);
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'shutdown') || input.shutdown !== undefined && typeof input.shutdown !== 'boolean') throw new Error('Choose only the operator shutdown mode.');
        persistOperatorStopIntent(); quiescing = true; pauseAllLearning('host_operator_stop'); pauseAllSessionCompactions('host_operator_stop');
        if (!operatorStopPromise) operatorStopPromise = Promise.all([pauseRuntimeExecutions(), stopBackgroundJobs()])
          .then(([result]) => result).catch(error => { operatorStopPromise = undefined; throw error; });
        const result = await operatorStopPromise;
        // Queue the durable pause outcome before stopping connectivity. A slow
        // or offline Relay cannot indefinitely hold up an explicit Core stop.
        await pushWorker.flush().catch(() => {});
        send(response, 200, { [input.shutdown === false ? 'quiesced' : 'stopped']: true, ...result, runningAgentsContinue: false });
        if (input.shutdown !== false) setImmediate(() => shutdown());
        return;
      }
      if (quiescing && !['/health', '/shutdown'].includes(pathname) && !(request.method === 'GET' && /^\/jobs(?:\/|$)/.test(pathname))) {
        throw Object.assign(new Error('Core was stopped by the local operator. Start Core explicitly before submitting new work.'), { code: 'CORE_STOPPED', status: 409 });
      }
      if (/^\/jobs(?:\/|$)/.test(pathname)) {
        // Host jobs are not session capabilities. A scoped observer, friend or
        // phone session token must never become arbitrary local script access.
        if (!rootToken) { send(response, 403, { error: 'Background jobs require local owner authentication.', code: 'FORBIDDEN' }); return; }
        if (request.method === 'GET' && pathname === '/jobs/schema') { send(response, 200, readJson(path.join(root, 'assets', 'job-events.schema.json'))); return; }
        if (pathname === '/jobs') {
          if (request.method === 'POST') {
            const body = await readBody(request);
            const { requestId, ...input } = body;
            send(response, 202, submitBackgroundJob(input, request.headers['idempotency-key'] || requestId)); return;
          }
          if (request.method === 'GET') {
            send(response, 200, listBackgroundJobs({ before: Number(url.searchParams.get('before') || Number.MAX_SAFE_INTEGER),
              limit: Number(url.searchParams.get('limit') || 100), state: url.searchParams.get('state') || undefined })); return;
          }
        }
        const match = pathname.match(/^\/jobs\/([a-f0-9-]{36})(?:\/(logs|events|cancel))?$/i);
        if (!match) { send(response, 404, { error: 'Unknown job endpoint.' }); return; }
        const [, id, action] = match;
        const job = backgroundJob(id);
        if (request.method === 'POST' && action === 'cancel') {
          const body = await readBody(request);
          if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'requestId')) throw new Error('Job cancellation accepts only a requestId.');
          send(response, 202, cancelBackgroundJob(id, request.headers['idempotency-key'] || body.requestId)); return;
        }
        if (request.method !== 'GET') { send(response, 405, { error: 'Method not allowed.' }); return; }
        if (!action) { send(response, 200, job); return; }
        if (!['events', 'logs'].includes(action)) { send(response, 404, { error: 'Unknown job endpoint.' }); return; }
        let cursor = Number(url.searchParams.get('after') || request.headers['last-event-id'] || 0);
        const logs = action === 'logs', limit = Number(url.searchParams.get('limit') || 200);
        const read = count => backgroundJobEvents(id, cursor, count, { logs });
        read(limit);
        if (url.searchParams.get('stream') === '1' || request.headers.accept === 'text/event-stream') {
          response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
          response.flushHeaders(); streams.add(response); let blocked = false;
          const pump = () => {
            if (response.destroyed || blocked) return;
            for (const event of read(100)) {
              cursor = event.seq;
              if (!response.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)) { blocked = true; break; }
            }
          };
          response.on('drain', () => { blocked = false; pump(); });
          const timer = guardedInterval(pump, 150, { label: 'Job events', onError: () => response.destroy() });
          const heartbeat = guardedInterval(() => { if (!blocked) response.write(': heartbeat\n\n'); }, 10000, { label: 'Job heartbeat', onError: () => response.destroy() });
          response.on('close', () => { clearInterval(timer); clearInterval(heartbeat); streams.delete(response); }); pump(); return;
        }
        const items = read(limit);
        send(response, 200, { events: items, nextCursor: items.at(-1)?.seq || cursor, hasMore: items.length === limit, state: job.state, logsTruncated: job.logsTruncated }); return;
      }
      if (pathname === '/notifications' && request.method === 'POST') {
        if (!rootToken) { send(response, 403, { error: 'Custom notifications require local owner authentication.', code: 'FORBIDDEN' }); return; }
        const { requestId, ...input } = await readBody(request);
        send(response, 202, queueCustomNotification(input, request.headers['idempotency-key'] || requestId)); return;
      }
      if (pathname.startsWith('/knowledge/')) {
        if (!rootToken) { send(response, 403, { error: 'Only the local owner can administer knowledge and learning.' }); return; }
        if (request.method !== 'POST') { send(response, 405, { error: 'Use an explicit knowledge operation.' }); return; }
        send(response, 200, knowledge.request(pathname.slice('/knowledge/'.length), await readBody(request))); return;
      }
      if (pathname.startsWith('/relay/')) {
        if (!rootToken) { send(response, 403, { error: 'Only the local owner can administer the Core Relay gateway.' }); return; }
        const result = await (await relay()).request(request.method, pathname.slice('/relay/'.length), request.method === 'POST' ? await readBody(request) : {});
        send(response, 200, result); return;
      }
      if (request.method === 'GET' && pathname === '/connections') {
        if (!rootToken) { send(response, 403, { error: 'Only the local owner can inspect host connectivity.' }); return; }
        const service = (await relay()).snapshot().status;
        send(response, 200, { version: 1, sampledAt: now(), identity, core: { online: true },
          relay: { online: service.enabled === true && service.connection?.online === true,
            verifiedAt: service.connection?.verifiedAt || null, maximumAgeMs: 6000 } }); return;
      }
      if (request.method === 'GET' && pathname === '/health') { send(response, 200, { ok: true, identity, runtimeBuild, installationId: digest(root), environment, version: '0.2.0', apiVersion: 1, codexBaseline: '0.162.0' }); return; }
      if (request.method === 'GET' && pathname === '/metrics') { send(response, 200, metrics.read()); return; }
      if (request.method === 'GET' && pathname === '/schema') { send(response, 200, readJson(path.join(root, 'assets', 'events.schema.json'))); return; }
      if (request.method === 'GET' && pathname === '/capabilities') { send(response, 200, { apiVersion: 1, managedExecutions: true, durableEvents: true, idempotentCommands: true, inputSubmission: true,
        backgroundJobs: rootToken, jobEvents: rootToken, customNotifications: rootToken, scopedSessionAccess: true, revocableAccess: true, permissions: access?.permissions || sessionPermissions,
        isolation: { platform: process.platform, enforcedPolicies: sandboxSupport(), backendReadConfidentiality: false }, relay: false, portableSharing: false }); return; }
      if (request.method === 'GET' && pathname === '/sessions') { send(response, 200, listRecords('session').filter(s => !sessionDeleted(s.id) && (access ? s.id === access.sessionId : !s.parentSessionId))); return; }
      if (request.method === 'GET' && pathname === '/tokens') {
        if (!rootToken) { send(response, 403, { error: 'Only the local owner can manage session grants.' }); return; }
        send(response, 200, { items: listRecords('access-token').filter(a => a.id).map(publicAccess) }); return;
      }
      if (request.method === 'POST' && pathname === '/tokens') {
        if (!rootToken) { send(response, 403, { error: 'Only the local owner can manage session grants.' }); return; }
        send(response, 201, createSessionAccess(await readBody(request))); return;
      }
      if (request.method === 'DELETE' && /^\/tokens\/[a-f0-9-]{36}$/.test(pathname)) {
        if (!rootToken) { send(response, 403, { error: 'Only the local owner can manage session grants.' }); return; }
        send(response, 200, revokeSessionAccess(pathname.split('/')[2])); return;
      }
      if (request.method === 'POST' && pathname === '/shutdown') { if (!rootToken) { send(response, 403, { error: 'Only the local owner can stop the runtime.' }); return; } send(response, 200, { stopped: true, runningAgentsContinue: true }); setImmediate(() => shutdown()); return; }
      const match = pathname.match(/^\/sessions\/([a-f0-9-]{36})(?:\/(events|usage|activities|traffic|claim|release|execute|control|answer|input|delete))?$/);
      if (!match) { send(response, 404, { error: 'Unknown endpoint.' }); return; }
      const [, id, action] = match;
      if (request.method === 'POST' && action === 'delete') {
        if (!rootToken) { send(response, 403, { error: 'Only the local owner can delete saved chats.', code: 'FORBIDDEN' }); return; }
        const body = await readBody(request);
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'requestId')) throw new Error('Deleting a chat accepts no execution options.');
        send(response, 200, deleteTerminalConversation(id, { requestId: request.headers['idempotency-key'] || body.requestId })); return;
      }
      const session = loadSession(id);
      if (access && !accessAllows(access, id)) { send(response, 403, { error: 'This token belongs to another session.' }); return; }
      if (!session) { send(response, 404, { error: sessionDeleted(id) ? 'This chat was deleted.' : 'Unknown session.', code: sessionDeleted(id) ? 'SESSION_DELETED' : 'NOT_FOUND' }); return; }
      if (request.method === 'GET' && action === 'usage') { send(response, 200, { sessionId: id, usage: session.usage || null, summary: session.summary || null, goal: session.goal ? { status: session.goal.status, tokensUsed: session.goal.tokensUsed, runtimeUsedSeconds: session.goal.runtimeUsedSeconds || 0 } : null }); return; }
      if (request.method === 'GET' && ['activities', 'traffic'].includes(action)) {
        const childIds = new Set([id, ...listRecords('session', { parentSessionId: id }).filter(s => !access || accessAllows(access, s.id)).map(s => s.id)]);
        const after = url.searchParams.get('after') || '', limit = Number(url.searchParams.get('limit') || 100);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('Snapshot page limit must be 1–500.');
        const all = listRecords(action === 'activities' ? 'activity' : 'traffic', { sessionIds: [...childIds] }).sort((a, b) => `${a.createdAt || a.startedAt}:${a.id}`.localeCompare(`${b.createdAt || b.startedAt}:${b.id}`));
        if (after && !all.some(item => item.id === after)) throw new Error('Unknown snapshot cursor.');
        const start = after ? Math.max(0, all.findIndex(item => item.id === after) + 1) : 0, items = all.slice(start, start + limit);
        send(response, 200, { items, nextCursor: items.at(-1)?.id || after, hasMore: start + limit < all.length, liveUpdates: `/v1/sessions/${id}/events?stream=1` }); return;
      }
      if (request.method === 'GET' && !action) {
        const jobs = listRecords('execution', { sessionId: id, limit: 1 });
        const peerOrder = (session.mode === 'besties' ? getRecord('besties', id) : getRecord('parallel', id))?.peers || [];
        const children = (['parallel', 'besties'].includes(session.mode) ? groupChildren(session) : listRecords('session', { parentSessionId: id })).filter(s => !access || accessAllows(access, s.id));
        if (peerOrder.length) children.sort((a, b) => peerOrder.findIndex(p => p.sessionId === a.id) - peerOrder.findIndex(p => p.sessionId === b.id));
        else if (['parallel', 'besties'].includes(session.mode)) children.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        const questionSessions = new Set([id, ...children.map(s => s.id)]);
        const spending = rootToken && deepseekSpendingVisible(session) ? sessionSpending(id, sessionMetricsFamily(id)) : undefined;
        send(response, 200, { session, spending, ...(rootToken ? { compactorUsage: sessionCompactorUsage(id) } : {}), invocations: sessionInvocations(id), observation: observeExecution(jobs[0]), permissions: { yolo: terminalYolo(id) ?? Boolean(['queued', 'launching', 'running'].includes(jobs[0]?.state) && jobs[0]?.options?.yolo) }, run: getRecord('run', id), execution: jobs[0] || null,
          questions: listRecords('question', { sessionIds: [...questionSessions], state: 'pending' }), inputOwner: effectiveInputOwner(id),
          children: children.map(s => ({ id: s.id, provider: s.provider, model: s.model, agent: s.agentNamespace || s.provider, executionState: s.executionState, goalStatus: s.goal?.status || null })),
          capabilities: { activeSteering: session.backend === 'codex' && !['parallel', 'debate', 'besties'].includes(session.mode), durableEvents: true, chatTabs: ['parallel', 'besties'].includes(session.mode) } }); return;
      }
      if (request.method === 'GET' && action === 'events') {
        if (url.searchParams.get('stream') === '1' || request.headers.accept === 'text/event-stream') {
          let cursor = Number(url.searchParams.get('after') || request.headers['last-event-id'] || 0);
          events(id, cursor, 1);
          response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
          response.flushHeaders(); streams.add(response);
          let blocked = false;
          const pump = () => {
            if (response.destroyed) return;
            if (sessionDeleted(id)) { response.end(); return; }
            if (access && !activeAccess(getRecord('access-token', accessKey))) { response.end(); return; }
            if (blocked) return;
            const batch = events(id, cursor, 100);
            for (const event of batch) {
              cursor = event.seq;
              if (!response.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)) { blocked = true; break; }
            }
          };
          response.on('drain', () => { blocked = false; pump(); });
          const timer = guardedInterval(pump, 150, { label: 'Event stream', onError: () => response.destroy() }), heartbeat = guardedInterval(() => { if (!blocked) response.write(': heartbeat\n\n'); }, 10000, { label: 'Event heartbeat', onError: () => response.destroy() });
          response.on('close', () => { clearInterval(timer); clearInterval(heartbeat); streams.delete(response); }); pump(); return;
        }
        if (url.searchParams.has('before')) {
          const before = Number(url.searchParams.get('before')), limit = Number(url.searchParams.get('limit') || 200);
          const items = eventsBefore(id, before, limit);
          const oldest = items[0]?.seq || 0;
          const hasOlder = oldest > 0 && Boolean(eventsBefore(id, oldest, 1).length);
          send(response, 200, { events: items, nextCursor: items.at(-1)?.seq || 0, hasMore: false, oldestCursor: oldest, hasOlder }); return;
        }
        const items = events(id, Number(url.searchParams.get('after') || 0), Number(url.searchParams.get('limit') || 200));
        send(response, 200, { events: items, nextCursor: items.at(-1)?.seq || Number(url.searchParams.get('after') || 0), hasMore: items.length === Number(url.searchParams.get('limit') || 200) }); return;
      }
      if (request.method !== 'POST') { send(response, 405, { error: 'Method not allowed.' }); return; }
      const body = await readBody(request);
      if (action === 'input') {
        if (access && (body.preparedGoalId !== undefined || body.operation === 'execute' && body.goal === true)) throw Object.assign(new Error('Scoped goals must use the canonical goal submission operation.'), { status: 403 });
        if (access && (body.environment !== undefined || body.options != null && (typeof body.options !== 'object' || Array.isArray(body.options) || Object.keys(body.options).length))) throw Object.assign(new Error('Scoped input uses saved host execution settings.'), { status: 403 });
        if (access && access.includeChildren === false && ['parallel', 'besties', 'debate'].includes(session.mode) &&
          (!['mode', 'execute', 'goal', 'control', 'answer', 'permissions'].includes(body.operation) || !authorizedOwnPhoneTerminalInput(access, session))) throw Object.assign(new Error('Group input requires the approved own-phone terminal scope.'), { status: 403 });
        const requestId = request.headers['idempotency-key'] || body.requestId;
        const { requestId: ignored, ...input } = body;
        const info = { url: `http://127.0.0.1:${server.address().port}`, token: request.headers.authorization.slice(7) };
        const result = await submitSessionInput(id, input, requestId, { principal, authorize: permission => {
          if (quiescing || operatorStopRequested()) throw Object.assign(new Error('Core was stopped by its owner.'), { code: 'CORE_STOPPED', status: 409 });
          requireAccess(permission);
        },
          request: (method, suffix = '', data, key) => runtimeRequest(info, method, `/sessions/${id}${suffix ? '/' + suffix : ''}`, data ? { ...data, owner: body.owner } : undefined, key) });
        send(response, 202, result); return;
      }
      requireAccess(action === 'control' ? body.action : action === 'release' ? 'claim' : action);
      if (access && access.includeChildren === false && ['parallel', 'besties', 'debate'].includes(session.mode) && (action === 'execute' || action === 'control' || action === 'claim' && body.takeover) &&
        !(action === 'control' && authorizedOwnPhoneTerminalInput(access, session))) throw Object.assign(new Error('Group controls require a grant that includes child sessions.'), { status: 403 });
      if (action === 'claim') {
        if (body.takeover) requireAccess('takeover');
        if (body.takeover !== undefined && typeof body.takeover !== 'boolean') throw new Error('takeover must be a boolean.');
        send(response, 200, claimInput(id, body.owner, Boolean(body.takeover), principal)); return;
      }
      if (action === 'release') { releaseInput(id, body.owner, principal); send(response, 200, { released: true }); return; }
      requireOwner(id, body.owner, principal);
      const requestId = request.headers['idempotency-key'] || body.requestId;
      if (action === 'execute') {
        if (access && (body.environment !== undefined || body.options != null && (typeof body.options !== 'object' || Array.isArray(body.options) || Object.keys(body.options).length))) throw Object.assign(new Error('Scoped clients use the saved host configuration; environment and execution option overrides are denied.'), { status: 403 });
        const result = enqueueExecution(id, body, requestId, { authorize: () => { requireAccess('execute'); requireOwner(id, body.owner, principal); } });
        send(response, 202, result); return;
      }
      if (action === 'answer') {
        const result = reserveRequest(`answer:${id}`, requestId, { questionId: body.questionId, answer: body.answer }, db => {
          const question = getRecord('question', body.questionId), child = question && loadSession(question.sessionId);
          if (access && question && !accessAllows(access, question.sessionId)) throw Object.assign(new Error('Question is outside this session grant.'), { status: 403 });
          if (!question || (question.sessionId !== id && child?.parentSessionId !== id) || question.state !== 'pending') throw Object.assign(new Error('Question is no longer pending in this conversation.'), { code: 'CONFLICT' });
          if (question.expiresAt && question.expiresAt <= Date.now()) throw Object.assign(new Error('Question has expired; approval was denied.'), { code: 'CONFLICT' });
          if (typeof body.answer !== 'string') throw new Error('Question answer must be text.');
          putRecord('question', question.id, { ...question, state: 'answered', answer: body.answer, answeredAt: now(), answeredBy: body.owner }, db);
          appendEvent(question.sessionId, 'question.answered', { id: question.id, answer: body.answer }, db);
          if (question.sessionId !== id) appendEvent(id, 'worker.question.answered', { id: question.id, sessionId: question.sessionId, answer: body.answer }, db);
          return { answered: true };
        }); send(response, 200, result); return;
      }
      if (action === 'control') {
        const result = reserveRequest(`control:${id}`, requestId, { action: body.action, text: body.text }, db => {
          if (!['pause', 'cancel', 'steer'].includes(body.action)) throw new Error('Unknown control.');
          if (body.action === 'steer' && (session.backend !== 'codex' || ['parallel', 'debate', 'besties'].includes(session.mode) || !body.text?.trim())) throw new Error('Active steering requires an individual Codex chat and a nonempty message.');
          const active = listRecords('execution', { sessionId: id, states: ['queued', 'launching', 'running'], limit: 1 })[0];
          const control = { id: randomUUID(), sessionId: id, executionId: active?.id || null, action: body.action, text: body.text || '', state: 'queued', createdAt: now() };
          if (!active) {
            if (body.action === 'steer') throw new Error('No active turn to steer. Send a new chat message.');
            const children = groupChildren(session);
            const targets = children.filter(child => listRecords('execution', { sessionId: child.id, states: ['queued', 'launching', 'running'], limit: 1 }).length > 0);
            for (const child of targets) { const childControl = { ...control, id: randomUUID(), sessionId: child.id, parentControlId: control.id }; putRecord('control', childControl.id, childControl, db); appendEvent(child.id, 'control.queued', childControl, db); }
            control.state = 'observed'; control.result = { active: false, childSessions: targets.map(child => child.id) };
            const fresh = loadSession(id), previous = structuredClone(fresh);
            if (!targets.length) {
              if (fresh.goal && !['complete', 'cancelled'].includes(fresh.goal.status)) {
                fresh.goal.status = body.action === 'pause' ? 'paused' : 'cancelled';
                fresh.goal.reason = 'user_' + body.action;
              }
              fresh.executionState = body.action === 'pause' ? 'paused' : 'cancelled'; fresh.updatedAt = now();
              putRecord('session', id, fresh, db);
              recordSessionLifecycle(fresh, previous, db);
            }

          }
          putRecord('control', control.id, control, db);
          if (body.action === 'steer') appendEvent(id, 'message.user', { text: body.text, kind: 'steering', controlId: control.id }, db);
          appendEvent(id, `control.${control.state}`, control, db); return { controlId: control.id };
        });
        if (['pause', 'cancel'].includes(body.action)) pauseLearningForSession(id, 'user_' + body.action);
        if (['pause', 'cancel'].includes(body.action)) pauseSessionCompaction(id, 'user_' + body.action);
        const pending = getRecord('control', result.controlId);
        if (['pause', 'cancel'].includes(body.action) && ['queued', 'dispatched'].includes(pending?.state)) requestExecutionStop(id, result.controlId, body.action);
        send(response, 202, result); return;
      }
      send(response, 404, { error: 'Unknown session operation.' });
    } catch (error) { send(response, error.status || (error.code === 'CONFLICT' || error.code === 'UNCERTAIN' ? 409 : 400), { error: diagnosticError(error), code: error.code || 'INVALID_REQUEST' }); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(listener.port || 0, '127.0.0.1', resolve); });
  metrics.start();
  writeJson(listenerFile, { port: server.address().port, token });
  writeJson(runtimeFile(), { version: 1, url: `http://127.0.0.1:${server.address().port}`, token, identity, runtimeBuild, environment, startedAt: now() });
  const pushWorker = new CorePushWorker({ relaySend: async (registration, request) => (await relay()).enqueuePush(registration, request) }).start();
  const updateWatcher = coreUpdates().start();
  // Optional saved connectivity is restored only after the listener is ready;
  // RelayGateway.start() discovers this same engine instead of spawning another.
  void relay().then(service => service.restore()).catch(() => {});
  const scheduler = guardedInterval(() => {
    if (stopping) return;
    superviseExecutions();
    if (quiescing) return;
    const active = listRecords('execution', { states: ['launching', 'running'] });
    const learningMayRun = () => !stopping && !quiescing && !operatorStopRequested();
    if (!learningPump) {
      try { processSkillEvolution({ canRun: learningMayRun }); } catch { /* Reviewed evolution remains staged on failure. */ }
      learningPump = processLearningReviews({ limit: 1, canRun: learningMayRun })
        .catch(() => { /* Learning persists its own bounded failure status. */ })
        .finally(() => { learningPump = undefined; });
    }
    if (active.length >= 8) return;
    if (!memoryPump) {
      memoryPump = processSessionCompactions({ canRun: () => !stopping && !quiescing && !operatorStopRequested() })
        .catch(() => { /* Derived memory retains its durable failure state. */ })
        .finally(() => { memoryPump = undefined; });
    }
    for (const candidate of listRecords('execution', { state: 'queued' }).filter(j => !j.stopAction).slice(0, 8 - active.length)) {
      const logPath = path.join(home(), 'runtime', `${candidate.id}-execution.log`);
      const job = reserveExecutionLaunch(candidate.id, logPath, { engineDirectory: root, engineBuild: runtimeBuild });
      if (!job) continue;
      const log = fs.openSync(logPath, 'a', 0o600);
      const parentId = loadSession(job.sessionId)?.parentSessionId;
      const parentJob = parentId && listRecords('execution', { sessionId: parentId, states: ['launching', 'running'], limit: 1 })[0];
      const environment = captureEnvironment(readExecutionEnvironment(job.id) || (parentJob && readExecutionEnvironment(parentJob.id)) || process.env);
      const child = spawn(process.execPath, [path.join(root, 'bin/bzzy-engine.js'), 'internal-execution', job.id], {
        cwd: loadSession(job.sessionId)?.cwd || home(), env: { ...environment, BZZY_HOME: home(), PATH: [path.dirname(process.execPath), environment.PATH || ''].join(path.delimiter) }, detached: true, stdio: ['ignore', log, log],
      });
      fs.closeSync(log);
      child.unref();
      recordExecutionProcess(job.id, { runner: processIdentity(child.pid) });
      child.once('error', error => {
        try {
        recordExecutionProcess(job.id, { runnerExitedAt: now(), runnerExitCode: 1 });
        fs.appendFileSync(logPath, error.message + '\n'); superviseExecutions();
        } catch (failure) { process.stderr.write(`Execution supervision: ${failure.message}\n`); }
      });
      child.once('exit', (code, signal) => {
        try {
        const current = getRecord('execution', job.id);
        if (['launching', 'running'].includes(current?.state)) {
          recordExecutionProcess(job.id, { runnerExitedAt: now(), runnerExitCode: code, runnerExitSignal: signal });
          superviseExecutions();
        }
        } catch (failure) { process.stderr.write(`Execution supervision: ${failure.message}\n`); }
      });
    }
  }, 100, { label: 'Runtime scheduler' });
  const backgroundScheduler = guardedInterval(() => pumpBackgroundJobs({ launch: !stopping && !quiescing && !operatorStopRequested() }), 1000, { label: 'Background jobs' });
  const shutdown = () => {
    if (stopping) return; stopping = true; clearInterval(scheduler); pauseAllLearning('host_shutdown'); pauseAllSessionCompactions('host_shutdown');
    clearInterval(backgroundScheduler); pushWorker.close(); updateWatcher.close();
    metrics.close();
    if (runtimeInfo()?.token === token) fs.rmSync(runtimeFile(), { force: true });
    for (const response of streams) response.end();
    server.close(); server.closeIdleConnections();
  };
  process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
  await new Promise(resolve => server.once('close', resolve));
  await learningPump;
  await memoryPump;
  await relayServicePromise?.then(service => service.close());
  process.removeListener('SIGTERM', shutdown); process.removeListener('SIGINT', shutdown); unlock(); return 0;
}
export async function runtimeRequest(info, method, endpoint, body, requestId) {
  if (method === 'POST' && (/\/execute$/.test(endpoint) || /\/input$/.test(endpoint) && ['execute', 'goal'].includes(body?.operation))) body = { ...body, environment: body?.environment || captureEnvironment() };
  const retryable = method === 'GET' || Boolean(requestId) || /\/(claim|release)$/.test(endpoint);
  for (let attempt = 0; ; attempt++) {
    let response, value;
    try {
      response = await fetch(info.url + endpoint, { method, headers: { authorization: `Bearer ${info.token}`, 'content-type': 'application/json', ...(requestId ? { 'idempotency-key': requestId } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
      value = await response.json();
    } catch (error) {
      if (!retryable || attempt >= 4) throw error;
      await delay(300 * (attempt + 1));
      const current = runtimeInfo();
      // Reconnect with the caller's existing capability. Reading the local
      // service record must never promote an observer token to the root token.
      if (current && identityAlive(current.identity)) info.url = current.url;
      continue;
    }
    if (!response.ok) throw Object.assign(new Error(value.error || `Runtime HTTP ${response.status}`), { code: value.code });
    return value;
  }
}
async function awaitManagedRuntime(milliseconds) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (operatorStopRequested()) throw Object.assign(new Error('Core was stopped explicitly. Start Core or open a new bzzy terminal to resume.'), { code: 'CORE_STOPPED' });
    const info = runtimeInfo();
    if (info && identityAlive(info.identity)) {
      try {
        const response = await fetch(info.url + '/health', { headers: { authorization: `Bearer ${info.token}` }, redirect: 'error',
          signal: AbortSignal.timeout(Math.max(1, Math.min(1000, deadline - Date.now()))) });
        const health = await response.json();
        if (response.ok && health.runtimeBuild === runtimeBuild && !operatorStopRequested()) return info;
      } catch { /* The installed supervisor owns this startup/restart gap. */ }
    }
    await delay(50);
  }
  throw Object.assign(new Error('The prepared Core service is not ready. Start Core explicitly or inspect its service status.'), { code: 'CORE_SERVICE_UNAVAILABLE' });
}
export async function ensureRuntime({ managedWaitMs = 10000 } = {}) {
  assertCoreAvailable();
  if (!Number.isSafeInteger(managedWaitMs) || managedWaitMs < 50 || managedWaitMs > 15000) throw new Error('Managed runtime wait must be 50–15000 milliseconds.');
  if (operatorStopRequested()) throw Object.assign(new Error('Core was stopped explicitly. Start Core or open a new bzzy terminal to resume.'), { code: 'CORE_STOPPED' });
  const existing = runtimeInfo();
  if (existing && identityAlive(existing.identity)) {
    try {
      const health = await runtimeRequest(existing, 'GET', '/health');
      // Retained clients/runners from a previous immutable release must attach
      // to the compatible installed daemon, never replace it with their code.
      if (health.runtimeBuild === runtimeBuild || health.apiVersion === 1 && health.installationId && health.installationId !== digest(root)) return existing;
      await runtimeRequest(existing, 'POST', '/shutdown', {});
      const deadline = Date.now() + 5000;
      while (identityAlive(existing.identity) && Date.now() < deadline) await delay(50);
      if (identityAlive(existing.identity)) throw Object.assign(new Error('The previous runtime is still stopping after an update. Retry in a moment.'), { code: 'RUNTIME_STOPPING' });
    }
    catch (error) {
      if (error.code === 'RUNTIME_STOPPING') throw error;
      const handoff = Date.now() + 2000;
      while (identityAlive(existing.identity) && Date.now() < handoff) await delay(50);
      if (identityAlive(existing.identity)) throw new Error('The recorded bzzy runtime is alive but unreachable. Inspect bzzy service status before replacing it.');
    }
  }
  const { preparedServiceInstalled } = await import('./host-service.js');
  if (preparedServiceInstalled()) return awaitManagedRuntime(managedWaitMs);
  privateDir(path.join(home(), 'runtime'));
  const lock = path.join(home(), 'runtime', 'service.lock');
  const handoffDeadline = Date.now() + 5000;
  while (fs.existsSync(lock) && Date.now() < handoffDeadline) {
    let owner;
    owner = lockOwner(lock);
    if (!identityAlive(owner)) break;
    const started = runtimeInfo();
    if (started && identityAlive(started.identity)) { try { await runtimeRequest(started, 'GET', '/health'); return started; } catch { /* Shutdown/startup handoff. */ } }
    await delay(50);
  }
  // Installation can finish while another client is waiting for the startup
  // lock. A prepared supervisor remains the only process allowed to spawn Core.
  if (preparedServiceInstalled()) return awaitManagedRuntime(managedWaitMs);
  assertCoreAvailable();
  const log = fs.openSync(path.join(home(), 'runtime', 'service.log'), 'a', 0o600);
  const child = spawn(process.execPath, [path.join(root, 'bin/bzzy-engine.js'), 'internal-service'], { cwd: home(), env: runtimeEnv(), detached: true, stdio: ['ignore', log, log] });
  fs.closeSync(log); child.unref(); let failure; child.on('error', error => { failure = error; });
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (failure) throw failure;
    const info = runtimeInfo(); if (info && identityAlive(info.identity)) { try { await runtimeRequest(info, 'GET', '/health'); return info; } catch { /* Startup handshake is still pending. */ } }
    await delay(50);
  }
  throw new Error(`Runtime startup failed. Inspect ${path.join(home(), 'runtime', 'service.log')}.`);
}
export async function executeJob(id) {
  const acquired = transaction(db => {
    const job = getRecord('execution', id);
    if (!job || !['queued', 'launching'].includes(job.state) || job.stopAction) return null;
    const next = { ...job, state: 'running', runner: processIdentity(), startedAt: now() }; putRecord('execution', id, next, db);
    appendEvent(job.sessionId, 'execution.started', { id, provider: loadSession(job.sessionId).provider }, db); return next;
  });
  if (!acquired) return 0;
  const session = loadSession(acquired.sessionId), ui = new RunnerUI(session.id, { parentSessionId: session.parentSessionId, agent: session.agentNamespace || session.provider, peer: ['peer', 'bestie'].includes(session.role) });
  let code = 1, error;
  try {
    if (acquired.goal || acquired.resumeGoal) assertGoalWorkflowAdmission(session, acquired.workflowAdmission);
    assertGoalScopeAdmission(session, acquired.scopeAdmission);
    if (acquired.goal && session.mode === 'debate') { const { runDebate } = await import('./debate.js'); code = await runDebate(session, acquired.options, ui); }
    else if (acquired.goal && session.mode === 'parallel') { const { runParallel } = await import('./parallel.js'); code = await runParallel(session, acquired.options, ui); }
    else if (acquired.goal && session.mode === 'besties') { const { runBesties } = await import('./besties.js'); code = await runBesties(session, { ...acquired.options, bestiesResume: acquired.resumeGoal, bestiesRunId: acquired.id }, ui); }
    else { const { runSession } = await import('./controller.js'); code = await runSession(getProvider(session.provider), session, acquired.options, ui, acquired.prompt, { goal: acquired.goal, resumeGoal: acquired.resumeGoal }); }
  } catch (failure) {
    error = failure.message; appendEvent(session.id, 'error', { message: error });
    const latest = loadSession(session.id);
    if (latest && !['paused', 'cancelled', 'failed'].includes(latest.executionState)) {
      latest.executionState = 'failed'; latest.failure = { category: failure.code === 'UNSUPPORTED_POLICY' ? 'unsupported_policy' : 'runner_failure', message: error };
      if (acquired.goal && latest.goal && !['complete', 'cancelled'].includes(latest.goal.status)) { latest.goal.status = 'blocked'; latest.goal.reason = error; }
      delete latest.deferTerminalNotification;
      saveSession(latest);
    }
  }
  finally { ui.close(); }
  removeExecutionEnvironment(id);
  settleExecutionControls(getRecord('execution', id));
  transaction(db => {
    const current = getRecord('execution', id);
    if (!['running', 'launching'].includes(current?.state)) return;
    putRecord('execution', id, { ...current, state: code === 0 ? 'finished' : 'stopped', exitCode: code, error, finishedAt: now() }, db);
    appendEvent(session.id, 'execution.finished', { id, exitCode: code, error }, db);
  });
  if (session.reviewSource?.goalId) {
    try { recordGoalValidationResult(session.id); } catch { /* Badge projection cannot undo a settled execution. */ }
  }
  return code;
}
