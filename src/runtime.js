import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { home, privateDir, readJson, writeJson, loadSession, saveSession, findSession, lockFile } from './store.js';
import { database, getRecord, putRecord, listRecords, removeRecord, appendEvent, events, reserveRequest, transaction, now, digest } from './database.js';
import { processIdentity, identityAlive, reconcileSession } from './recovery.js';
import { root, runtimeEnv } from './process.js';
import { getProvider } from './providers.js';
import { delay } from './delegation.js';
import { RunnerUI } from './runtime-ui.js';
import { effectivePolicy } from './policy.js';
import { enqueueExecution } from './execution-queue.js';

export const runtimeFile = () => path.join(home(), 'runtime', 'service.json');
export const runtimeInfo = () => readJson(runtimeFile(), null);
function groupChildren(session) {
  if (!['parallel', 'besties'].includes(session?.mode)) return [];
  const group = getRecord(session.mode, session.id);
  if (group?.goalId && group.goalId !== session.goal?.id) return [];
  const peers = group?.peers, ids = peers && new Set(peers.map(peer => peer.sessionId));
  return listRecords('session').filter(child => child.parentSessionId === session.id && (!ids || ids.has(child.id)));
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
  for (const child of listRecords('session').filter(s => s.parentSessionId === sessionId)) {
    const inherited = getRecord('input-owner', child.id);
    if (inherited?.owner === owner && inherited.inheritedFrom === sessionId) removeRecord('input-owner', child.id);
  }
}
async function readBody(request) {
  let body = ''; for await (const chunk of request) { body += chunk; if (body.length > 256 * 1024) throw new Error('Request exceeds 256 KiB.'); }
  return body ? JSON.parse(body) : {};
}
export async function serveRuntime() {
  privateDir(path.join(home(), 'runtime')); database();
  const unlock = lockFile(path.join(home(), 'runtime', 'service.lock'), 'A bzzy runtime is already starting or running.');
  const existing = runtimeInfo();
  if (existing && identityAlive(existing.identity)) throw new Error('A bzzy service is already running.');
  const listenerFile = path.join(home(), 'runtime', 'listener.json'), listener = readJson(listenerFile, {});
  const token = listener.token || randomUUID() + randomUUID(), identity = processIdentity();
  for (const run of listRecords('run')) if (['starting', 'running', 'waiting_for_input'].includes(run.state) && !identityAlive(run.runner)) reconcileSession(run.sessionId);
  for (const job of listRecords('execution')) if (['launching', 'running'].includes(job.state) && !identityAlive(job.runner)) {
    putRecord('execution', job.id, { ...job, state: 'interrupted', reason: 'Runtime restarted after an uncertain runner handoff; explicit resume required.' });
  }
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
      if (request.method === 'GET' && pathname === '/health') { send(response, 200, { ok: true, identity, version: '0.2.0', apiVersion: 1, codexBaseline: '0.162.0' }); return; }
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
        const childIds = new Set([id, ...listRecords('session').filter(s => s.parentSessionId === id).map(s => s.id)]);
        const after = url.searchParams.get('after') || '', limit = Number(url.searchParams.get('limit') || 100);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('Snapshot page limit must be 1–500.');
        const all = listRecords(action === 'activities' ? 'activity' : 'traffic').filter(item => childIds.has(item.sessionId)).sort((a, b) => `${a.createdAt || a.startedAt}:${a.id}`.localeCompare(`${b.createdAt || b.startedAt}:${b.id}`));
        if (after && !all.some(item => item.id === after)) throw new Error('Unknown snapshot cursor.');
        const start = after ? Math.max(0, all.findIndex(item => item.id === after) + 1) : 0, items = all.slice(start, start + limit);
        send(response, 200, { items, nextCursor: items.at(-1)?.id || after, hasMore: start + limit < all.length, liveUpdates: `/v1/sessions/${id}/events?stream=1` }); return;
      }
      if (request.method === 'GET' && !action) {
        const jobs = listRecords('execution').filter(j => j.sessionId === id);
        const peerOrder = (session.mode === 'besties' ? getRecord('besties', id) : getRecord('parallel', id))?.peers || [];
        const children = ['parallel', 'besties'].includes(session.mode) ? groupChildren(session) : listRecords('session').filter(s => s.parentSessionId === id);
        if (peerOrder.length) children.sort((a, b) => peerOrder.findIndex(p => p.sessionId === a.id) - peerOrder.findIndex(p => p.sessionId === b.id));
        else if (['parallel', 'besties'].includes(session.mode)) children.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        const questionSessions = new Set([id, ...children.map(s => s.id)]);
        send(response, 200, { session, run: getRecord('run', id), execution: jobs[0] || null,
          questions: listRecords('question').filter(q => questionSessions.has(q.sessionId) && q.state === 'pending'), inputOwner: effectiveInputOwner(id),
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
          const timer = setInterval(pump, 150), heartbeat = setInterval(() => { if (!blocked) response.write(': heartbeat\n\n'); }, 10000);
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
          const control = { id: randomUUID(), sessionId: id, action: body.action, text: body.text || '', state: 'queued', createdAt: now() };
          const active = listRecords('execution').some(j => j.sessionId === id && ['queued', 'launching', 'running'].includes(j.state));
          if (!active) {
            if (body.action === 'steer') throw new Error('No active turn to steer. Send a new chat message.');
            const children = groupChildren(session);
            const targets = children.filter(child => listRecords('execution').some(j => j.sessionId === child.id && ['queued', 'launching', 'running'].includes(j.state)));
            for (const child of targets) { const childControl = { ...control, id: randomUUID(), sessionId: child.id, parentControlId: control.id }; putRecord('control', childControl.id, childControl, db); appendEvent(child.id, 'control.queued', childControl, db); }
            control.state = 'observed'; control.result = { active: false, childSessions: targets.map(child => child.id) };
          }
          putRecord('control', control.id, control, db);
          if (body.action === 'steer') appendEvent(id, 'message.user', { text: body.text, kind: 'steering', controlId: control.id }, db);
          appendEvent(id, `control.${control.state}`, control, db); return { controlId: control.id };
        }); send(response, 202, result); return;
      }
      send(response, 404, { error: 'Unknown session operation.' });
    } catch (error) { send(response, error.code === 'CONFLICT' || error.code === 'UNCERTAIN' ? 409 : 400, { error: error.message, code: error.code || 'INVALID_REQUEST' }); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(listener.port || 0, '127.0.0.1', resolve); });
  writeJson(listenerFile, { port: server.address().port, token });
  writeJson(runtimeFile(), { version: 1, url: `http://127.0.0.1:${server.address().port}`, token, identity, startedAt: now() });
  const scheduler = setInterval(() => {
    if (stopping) return;
    const active = listRecords('execution').filter(j => ['launching', 'running'].includes(j.state) && identityAlive(j.runner));
    if (active.length >= 8) return;
    for (const job of listRecords('execution').filter(j => j.state === 'queued').slice(0, 8 - active.length)) {
      putRecord('execution', job.id, { ...job, state: 'launching' });
      const child = spawn(process.execPath, [path.join(root, 'bin/bzzy.js'), 'internal-execution', job.id], { env: runtimeEnv(), detached: true, stdio: 'ignore' });
      child.unref();
      putRecord('execution', job.id, { ...getRecord('execution', job.id), runner: processIdentity(child.pid) });
      child.on('error', error => putRecord('execution', job.id, { ...getRecord('execution', job.id), state: 'failed', error: error.message }));
    }
  }, 100);
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
  const response = await fetch(info.url + endpoint, { method, headers: { authorization: `Bearer ${info.token}`, 'content-type': 'application/json', ...(requestId ? { 'idempotency-key': requestId } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
  const value = await response.json(); if (!response.ok) throw Object.assign(new Error(value.error || `Runtime HTTP ${response.status}`), { code: value.code }); return value;
}
export async function ensureRuntime() {
  const existing = runtimeInfo();
  if (existing && identityAlive(existing.identity)) {
    try { await runtimeRequest(existing, 'GET', '/health'); return existing; }
    catch {
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
    try { owner = Number(fs.readFileSync(lock, 'utf8').split(':')[0]); } catch (error) { if (error.code === 'ENOENT') break; throw error; }
    if (!processIdentity(owner)) break;
    const started = runtimeInfo();
    if (started && identityAlive(started.identity)) { try { await runtimeRequest(started, 'GET', '/health'); return started; } catch { /* Shutdown/startup handoff. */ } }
    await delay(50);
  }
  const log = fs.openSync(path.join(home(), 'runtime', 'service.log'), 'a', 0o600);
  const child = spawn(process.execPath, [path.join(root, 'bin/bzzy.js'), 'internal-service'], { env: runtimeEnv(), detached: true, stdio: ['ignore', log, log] });
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
    const next = { ...job, state: 'running', runner: processIdentity(), startedAt: now() }; putRecord('execution', id, next, db); return next;
  });
  if (!acquired) return 0;
  const session = loadSession(acquired.sessionId), ui = new RunnerUI(session.id, { parentSessionId: session.parentSessionId, agent: session.agentNamespace || session.provider, peer: ['peer', 'bestie'].includes(session.role) });
  let code = 1, error;
  try {
    if (acquired.goal && session.mode === 'debate') { const { runDebate } = await import('./debate.js'); code = await runDebate(session, acquired.options, ui); }
    else if (acquired.goal && session.mode === 'parallel') { const { runParallel } = await import('./parallel.js'); code = await runParallel(session, acquired.options, ui); }
    else if (acquired.goal && session.mode === 'besties') { const { runBesties } = await import('./besties.js'); code = await runBesties(session, { ...acquired.options, bestiesResume: acquired.resumeGoal, bestiesRunId: acquired.id }, ui); }
    else { const { runSession } = await import('./controller.js'); code = await runSession(getProvider(session.provider), session, acquired.options, ui, acquired.prompt, { goal: acquired.goal, resumeGoal: acquired.resumeGoal }); }
  } catch (failure) { error = failure.message; appendEvent(session.id, 'error', { message: error }); }
  finally { ui.close(); }
  putRecord('execution', id, { ...getRecord('execution', id), state: code === 0 ? 'finished' : 'stopped', exitCode: code, error, finishedAt: now() });
  appendEvent(session.id, 'execution.finished', { id, exitCode: code, error }); return code;
}
