import { guardedInterval } from './interval.js';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { home, privateDir, readJson, writeJson, loadSession, saveSession, findSession, lockFile, lockOwner } from './store.js';
import { database, getRecord, putRecord, listRecords, removeRecord, appendEvent, events, reserveRequest, transaction, now, digest } from './database.js';
import { processIdentity, identityAlive, reconcileSession } from './recovery.js';
import { root, runtimeEnv } from './process.js';
import { getProvider, providers } from './providers.js';
import { delay } from './delegation.js';
import { RunnerUI } from './runtime-ui.js';
import { effectivePolicy } from './policy.js';
import { enqueueExecution } from './execution-queue.js';
import { requestExecutionStop, superviseExecutions, settleExecutionControls } from './runtime-processes.js';
import { captureEnvironment, readExecutionEnvironment, removeExecutionEnvironment } from './execution-environment.js';

const runtimeBuild = digest(['src', 'assets', 'bin'].flatMap(directory => fs.readdirSync(path.join(root, directory), { recursive: true })
  .filter(file => fs.statSync(path.join(root, directory, file)).isFile()).sort()
  .map(file => [directory + '/' + file, digest(fs.readFileSync(path.join(root, directory, file)))])));
function environmentFingerprint() {
  const keys = ['PATH', 'BZZY_CODEX_BIN', 'BZZY_CLAUDE_BIN', 'CODEX_HOME', 'BZZY_CODEX_HOME', 'CLAUDE_CONFIG_DIR',
    'CLAUDE_SECURESTORAGE_CONFIG_DIR', 'BZZY_CLAUDE_HOME', ...Object.values(providers()).map(provider => provider.envKey).filter(Boolean)];
  return digest(Object.fromEntries(keys.map(key => [key, key === 'PATH'
    ? [...new Set([path.dirname(process.execPath), ...(process.env.PATH || '').split(path.delimiter)])].join(path.delimiter) : process.env[key] ?? null])));
}

export const runtimeFile = () => path.join(home(), 'runtime', 'service.json');
export const runtimeInfo = () => readJson(runtimeFile(), null);
function groupChildren(session) {
  if (!['parallel', 'besties'].includes(session?.mode)) return [];
  const group = getRecord(session.mode, session.id);
  if (group?.goalId && group.goalId !== session.goal?.id) return [];
  const peers = group?.peers, ids = peers && new Set(peers.map(peer => peer.sessionId));
  return listRecords('session', { parentSessionId: session.id }).filter(child => !ids || ids.has(child.id));
}
export function effectiveInputOwner(sessionId) {
  const lease = getRecord('input-owner', sessionId);
  if (lease && lease.expiresAt > Date.now()) return lease;
  const session = loadSession(sessionId);
  return session?.parentSessionId ? effectiveInputOwner(session.parentSessionId) : null;
}
function belongsTo(sessionId, rootId) {
  let id = sessionId;
  for (let depth = 0; id && depth < 20; depth++) { if (id === rootId) return true; id = loadSession(id)?.parentSessionId; }
  return false;
}
export function claimInput(sessionId, owner, takeover = false) {
  if (typeof owner !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(owner)) throw new Error('Invalid input-owner ID.');
  return transaction(db => {
    const previous = effectiveInputOwner(sessionId);
    if (previous && previous.owner !== owner && previous.expiresAt > Date.now() && !takeover) throw Object.assign(new Error('Another client owns input. Attach explicitly to transfer ownership.'), { code: 'CONFLICT' });
    const lease = { owner, sessionId, expiresAt: Date.now() + 45000 };
    putRecord('input-owner', sessionId, lease, db);
    if (takeover) for (const child of groupChildren(loadSession(sessionId))) putRecord('input-owner', child.id, { ...lease, sessionId: child.id, inheritedFrom: sessionId }, db);
    if (previous?.owner !== owner) appendEvent(sessionId, 'input.owner', { owner, previousOwner: previous?.owner || null }, db);
    return lease;
  });
}
export function requireOwner(sessionId, owner) {
  const lease = effectiveInputOwner(sessionId);
  if (!lease || lease.owner !== owner || lease.expiresAt <= Date.now()) throw Object.assign(new Error('This client does not own input. Use --attach to take control.'), { code: 'CONFLICT' });
}
export function releaseInput(sessionId, owner) {
  const lease = getRecord('input-owner', sessionId);
  if (lease?.owner === owner) removeRecord('input-owner', sessionId);
  for (const child of listRecords('session', { parentSessionId: sessionId })) {
    const inherited = getRecord('input-owner', child.id);
    if (inherited?.owner === owner && inherited.inheritedFrom === sessionId) removeRecord('input-owner', child.id);
  }
}
async function readBody(request) {
  const chunks = []; let bytes = 0;
  for await (const chunk of request) { bytes += chunk.length; if (bytes > 256 * 1024) throw new Error('Request exceeds 256 KiB.'); chunks.push(chunk); }
  return bytes ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}
export async function serveRuntime() {
  privateDir(path.join(home(), 'runtime')); database();
  const unlock = lockFile(path.join(home(), 'runtime', 'service.lock'), 'A bzzy runtime is already starting or running.');
  const existing = runtimeInfo();
  if (existing && identityAlive(existing.identity)) throw new Error('A bzzy service is already running.');
  const listenerFile = path.join(home(), 'runtime', 'listener.json'), listener = readJson(listenerFile, {});
  const token = listener.token || randomUUID() + randomUUID(), identity = processIdentity();
  const environment = environmentFingerprint();
  for (const run of listRecords('run')) if (['starting', 'running', 'waiting_for_input'].includes(run.state) && !identityAlive(run.runner)) reconcileSession(run.sessionId);
  superviseExecutions();
  const send = (response, status, value) => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); response.end(JSON.stringify(value)); };
  let stopping = false; const streams = new Set();
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
      const access = rootToken ? null : getRecord('access-token', digest(supplied));
      if (!rootToken && (!access || access.expiresAt <= Date.now())) { send(response, 401, { error: 'Authentication required.' }); return; }
      if (access && request.method !== 'GET') { send(response, 403, { error: 'This token grants observation only.' }); return; }
      if (request.headers.origin && ![`http://127.0.0.1:${server.address().port}`, `http://localhost:${server.address().port}`].includes(request.headers.origin)) { send(response, 403, { error: 'Foreign origin denied.' }); return; }
      if (request.method === 'GET' && pathname === '/health') { send(response, 200, { ok: true, identity, runtimeBuild, environment, version: '0.2.0', apiVersion: 1, codexBaseline: '0.162.0' }); return; }
      if (request.method === 'GET' && pathname === '/schema') { send(response, 200, readJson(path.join(root, 'assets', 'events.schema.json'))); return; }
      if (request.method === 'GET' && pathname === '/sessions') { send(response, 200, listRecords('session').filter(s => !s.parentSessionId && (!access?.sessionId || access.sessionId === s.id))); return; }
      if (request.method === 'POST' && pathname === '/tokens') {
        const body = await readBody(request), sessionId = body.sessionId;
        if (!loadSession(sessionId)) throw new Error('Observer token needs an existing session ID.');
        const observerToken = randomUUID() + randomUUID(), expiresAt = Date.now() + Math.min(Math.max(body.expiresInSeconds || 86400, 60), 30 * 86400) * 1000;
        putRecord('access-token', digest(observerToken), { sessionId, expiresAt, permissions: ['observe'], createdAt: now() });
        send(response, 201, { token: observerToken, sessionId, expiresAt, permissions: ['observe'] }); return;
      }
      if (request.method === 'POST' && pathname === '/shutdown') { send(response, 200, { stopped: true, runningAgentsContinue: true }); setImmediate(() => shutdown()); return; }
      const match = pathname.match(/^\/sessions\/([a-f0-9-]{36})(?:\/(events|usage|activities|traffic|claim|release|execute|control|answer))?$/);
      if (!match) { send(response, 404, { error: 'Unknown endpoint.' }); return; }
      const [, id, action] = match, session = loadSession(id);
      if (access?.sessionId && !belongsTo(id, access.sessionId)) { send(response, 403, { error: 'Observer token belongs to another session.' }); return; }
      if (!session) { send(response, 404, { error: 'Unknown session.' }); return; }
      if (request.method === 'GET' && action === 'usage') { send(response, 200, { sessionId: id, usage: session.usage || null, summary: session.summary || null, goal: session.goal ? { status: session.goal.status, tokensUsed: session.goal.tokensUsed, runtimeUsedSeconds: session.goal.runtimeUsedSeconds || 0 } : null }); return; }
      if (request.method === 'GET' && ['activities', 'traffic'].includes(action)) {
        const childIds = new Set([id, ...listRecords('session', { parentSessionId: id }).map(s => s.id)]);
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
        const children = ['parallel', 'besties'].includes(session.mode) ? groupChildren(session) : listRecords('session', { parentSessionId: id });
        if (peerOrder.length) children.sort((a, b) => peerOrder.findIndex(p => p.sessionId === a.id) - peerOrder.findIndex(p => p.sessionId === b.id));
        else if (['parallel', 'besties'].includes(session.mode)) children.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        const questionSessions = new Set([id, ...children.map(s => s.id)]);
        send(response, 200, { session, run: getRecord('run', id), execution: jobs[0] || null,
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
            if (blocked || response.destroyed) return;
            if (access && access.expiresAt <= Date.now()) { response.end(); return; }
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
        const items = events(id, Number(url.searchParams.get('after') || 0), Number(url.searchParams.get('limit') || 200));
        send(response, 200, { events: items, nextCursor: items.at(-1)?.seq || Number(url.searchParams.get('after') || 0), hasMore: items.length === Number(url.searchParams.get('limit') || 200) }); return;
      }
      if (request.method !== 'POST') { send(response, 405, { error: 'Method not allowed.' }); return; }
      const body = await readBody(request);
      if (action === 'claim') { send(response, 200, claimInput(id, body.owner, Boolean(body.takeover))); return; }
      if (action === 'release') { releaseInput(id, body.owner); send(response, 200, { released: true }); return; }
      requireOwner(id, body.owner);
      const requestId = request.headers['idempotency-key'] || body.requestId;
      if (action === 'execute') {
        const result = enqueueExecution(id, body, requestId, { authorize: () => requireOwner(id, body.owner) });
        send(response, 202, result); return;
      }
      if (action === 'answer') {
        const result = reserveRequest(`answer:${id}`, requestId, { questionId: body.questionId, answer: body.answer }, db => {
          const question = getRecord('question', body.questionId), child = question && loadSession(question.sessionId);
          if (!question || (question.sessionId !== id && child?.parentSessionId !== id) || question.state !== 'pending') throw Object.assign(new Error('Question is no longer pending in this conversation.'), { code: 'CONFLICT' });
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
          }
          putRecord('control', control.id, control, db);
          if (body.action === 'steer') appendEvent(id, 'message.user', { text: body.text, kind: 'steering', controlId: control.id }, db);
          appendEvent(id, `control.${control.state}`, control, db); return { controlId: control.id };
        });
        const pending = getRecord('control', result.controlId);
        if (['pause', 'cancel'].includes(body.action) && ['queued', 'dispatched'].includes(pending?.state)) requestExecutionStop(id, result.controlId, body.action);
        send(response, 202, result); return;
      }
      send(response, 404, { error: 'Unknown session operation.' });
    } catch (error) { send(response, error.code === 'CONFLICT' || error.code === 'UNCERTAIN' ? 409 : 400, { error: error.message, code: error.code || 'INVALID_REQUEST' }); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(listener.port || 0, '127.0.0.1', resolve); });
  writeJson(listenerFile, { port: server.address().port, token });
  writeJson(runtimeFile(), { version: 1, url: `http://127.0.0.1:${server.address().port}`, token, identity, runtimeBuild, environment, startedAt: now() });
  const scheduler = guardedInterval(() => {
    if (stopping) return;
    superviseExecutions();
    const active = listRecords('execution', { states: ['launching', 'running'] });
    if (active.length >= 8) return;
    for (const job of listRecords('execution', { state: 'queued' }).filter(j => !j.stopAction).slice(0, 8 - active.length)) {
      const logPath = path.join(home(), 'runtime', `${job.id}-execution.log`);
      putRecord('execution', job.id, { ...job, state: 'launching', launchedAt: now(), logPath });
      const log = fs.openSync(logPath, 'a', 0o600);
      const parentId = loadSession(job.sessionId)?.parentSessionId;
      const parentJob = parentId && listRecords('execution', { sessionId: parentId, states: ['launching', 'running'], limit: 1 })[0];
      const environment = readExecutionEnvironment(job.id) || (parentJob && readExecutionEnvironment(parentJob.id)) || process.env;
      const child = spawn(process.execPath, [path.join(root, 'bin/bzzy.js'), 'internal-execution', job.id], {
        cwd: loadSession(job.sessionId)?.cwd || home(), env: { ...environment, BZZY_HOME: home(), PATH: [path.dirname(process.execPath), environment.PATH || ''].join(path.delimiter) }, detached: true, stdio: ['ignore', log, log],
      });
      fs.closeSync(log);
      child.unref();
      putRecord('execution', job.id, { ...getRecord('execution', job.id), runner: processIdentity(child.pid) });
      child.once('error', error => {
        try {
        putRecord('execution', job.id, { ...getRecord('execution', job.id), runnerExitedAt: now(), runnerExitCode: 1 });
        fs.appendFileSync(logPath, error.message + '\n'); superviseExecutions();
        } catch (failure) { process.stderr.write(`Execution supervision: ${failure.message}\n`); }
      });
      child.once('exit', (code, signal) => {
        try {
        const current = getRecord('execution', job.id);
        if (['launching', 'running'].includes(current?.state)) {
          putRecord('execution', job.id, { ...current, runnerExitedAt: now(), runnerExitCode: code, runnerExitSignal: signal });
          superviseExecutions();
        }
        } catch (failure) { process.stderr.write(`Execution supervision: ${failure.message}\n`); }
      });
    }
  }, 100, { label: 'Runtime scheduler' });
  const shutdown = () => {
    if (stopping) return; stopping = true; clearInterval(scheduler);
    if (runtimeInfo()?.token === token) fs.rmSync(runtimeFile(), { force: true });
    for (const response of streams) response.end();
    server.close(); server.closeIdleConnections();
  };
  process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
  await new Promise(resolve => server.once('close', resolve));
  process.removeListener('SIGTERM', shutdown); process.removeListener('SIGINT', shutdown); unlock(); return 0;
}
export async function runtimeRequest(info, method, endpoint, body, requestId) {
  if (method === 'POST' && /\/execute$/.test(endpoint)) body = { ...body, environment: body?.environment || captureEnvironment() };
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
export async function ensureRuntime() {
  const existing = runtimeInfo();
  if (existing && identityAlive(existing.identity)) {
    try {
      const health = await runtimeRequest(existing, 'GET', '/health');
      if (health.runtimeBuild === runtimeBuild) return existing;
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
  const log = fs.openSync(path.join(home(), 'runtime', 'service.log'), 'a', 0o600);
  const child = spawn(process.execPath, [path.join(root, 'bin/bzzy.js'), 'internal-service'], { cwd: home(), env: runtimeEnv(), detached: true, stdio: ['ignore', log, log] });
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
    if (!job || !['queued', 'launching'].includes(job.state)) return null;
    const next = { ...job, state: 'running', runner: processIdentity(), startedAt: now() }; putRecord('execution', id, next, db);
    appendEvent(job.sessionId, 'execution.started', { id, provider: loadSession(job.sessionId).provider }, db); return next;
  });
  if (!acquired) return 0;
  const session = loadSession(acquired.sessionId), ui = new RunnerUI(session.id, { parentSessionId: session.parentSessionId, agent: session.agentNamespace || session.provider, peer: ['peer', 'bestie'].includes(session.role) });
  let code = 1, error;
  try {
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
  }); return code;
}
