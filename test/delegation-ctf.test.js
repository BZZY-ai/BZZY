import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { root } from '../src/process.js';
import { createSession, saveSession, loadSession } from '../src/store.js';
import { BUILTINS } from '../src/providers.js';
import { prepareTask } from '../src/task.js';
import { newGoal } from '../src/goals.js';
import { ensureRuntime, runtimeInfo, runtimeRequest } from '../src/runtime.js';
import { identityAlive } from '../src/recovery.js';
import { events, getRecord, listRecords } from '../src/database.js';
import { remember } from '../src/memory.js';
import { delay } from '../src/delegation.js';
import { agentInstructions } from '../src/instructions.js';

test('a supervisor rejects premature CTF acceptance, follows up with the same cheap worker and independently verifies scoped evidence', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-ctf-'));
  const keys = ['BZZY_HOME', 'BZZY_CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'BZZY_CODEX_BIN', 'BZZY_CLAUDE_BIN', 'BZZY_TEST_ADVANCED', 'BZZY_TEST_LOG', 'DEEPSEEK_API_KEY'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const requests = [], flag = 'BZZY_CTF{local_evidence_verified_by_brain}';
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1'); requests.push({ path: url.pathname, id: url.searchParams.get('user_id'), authenticated: Boolean(request.headers.authorization) });
    response.setHeader('content-type', 'application/json');
    if (url.pathname !== '/profile') { response.writeHead(404); response.end('{}'); return; }
    if (request.headers.authorization !== 'Bearer fixture-account-a') { response.writeHead(401); response.end('{"error":"authentication required"}'); return; }
    response.end(JSON.stringify(url.searchParams.get('user_id') === '1' ? { id: 1, owner: 'fixture-account-a' } : { id: 2, owner: 'fixture-account-b', flag }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  Object.assign(process.env, { BZZY_HOME: path.join(directory, 'private'), BZZY_CODEX_HOME: path.join(directory, 'codex'), CLAUDE_CONFIG_DIR: path.join(directory, 'claude'),
    BZZY_CODEX_BIN: path.join(root, 'test/fixtures/advanced-agent.mjs'), BZZY_CLAUDE_BIN: path.join(root, 'test/fixtures/advanced-agent.mjs'), BZZY_TEST_ADVANCED: 'delegation-ctf', BZZY_TEST_LOG: path.join(directory, 'backend.jsonl'), DEEPSEEK_API_KEY: 'fixture-only-key' });
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    fs.writeFileSync(path.join(directory, 'challenge.json'), JSON.stringify({ baseUrl, actor: 'fixture-account-a', ownedId: 1, foreignId: 2 }));
    const source = createSession(BUILTINS.codex, directory, 'fixture-brain');
    prepareTask(source, { mode: 'delegate', executor: 'deepseek', executorModel: 'deepseek-flash' }, 'Solve the supplied local CTF and independently verify the flag.');
    source.contract.scope = { allowedTargets: [baseUrl] };
    source.contract.acceptanceCriteria = [{ id: 'ctf', description: 'Save the flag only after reviewing controls and independently reproducing the decisive observation.' }];
    source.contract.artifacts = [{ path: 'ctf-proof.json', schema: { type: 'object', required: ['flag', 'verifiedBy'], properties: { flag: { type: 'string', const: flag }, verifiedBy: { type: 'string', const: 'supervisor' } } } }];
    source.goal = newGoal(source.contract.objective); source.selectedEffort = 'xhigh'; source.executor.effort = 'low'; saveSession(source);
    remember(source, { kind: 'hypothesis', statement: 'PARENT_PRIVATE_LEDGER_MARKER is unrelated to this bounded assignment.' });
    assert.match(agentInstructions(source, { goalMode: true }), /potentially hours-long/);
    assert.match(agentInstructions(source, { goalMode: true }), /independently check consequential claims/i);
    const info = await ensureRuntime(), owner = randomUUID();
    await runtimeRequest(info, 'POST', `/sessions/${source.id}/claim`, { owner });
    const started = await runtimeRequest(info, 'POST', `/sessions/${source.id}/execute`, { owner, prompt: source.goal.objective, options: {}, goal: true }, randomUUID());
    let result;
    for (let attempt = 0; attempt < 700; attempt++) { result = getRecord('execution', started.executionId); if (result && !['queued', 'launching', 'running'].includes(result.state)) break; await delay(40); }
    assert.equal(result?.exitCode, 0, result?.error || JSON.stringify(result));
    const saved = loadSession(source.id), assignment = listRecords('assignment').find(job => job.parentSessionId === source.id);
    assert.equal(saved.goal.status, 'complete'); assert.equal(saved.acceptance.passed, true);
    assert.equal(assignment.currentRound, 2); assert.equal(assignment.closure, 'accepted'); assert.equal(assignment.selection.provider, 'deepseek');
    assert.equal(loadSession(assignment.workerSessionId).turns, 2, 'follow-up reuses the same worker conversation');
    assert.equal(loadSession(assignment.workerSessionId).selectedEffort, 'low'); assert.equal(saved.selectedEffort, 'xhigh');
    assert.equal(saved.summary.usage.supervisorTokens, 42); assert.equal(saved.summary.usage.delegatedTokens, 84); assert.equal(saved.summary.usage.totalTokens, 126);
    const proof = JSON.parse(fs.readFileSync(path.join(directory, 'ctf-proof.json'))); assert.equal(proof.flag, flag); assert.equal(proof.verifiedBy, 'supervisor');
    assert.equal(requests.length, 5); assert.ok(requests.some(request => !request.authenticated)); assert.ok(requests.some(request => request.id === '1'));
    assert.ok(events(source.id).some(event => event.type === 'checkpoint' && JSON.stringify(event.data).includes('Do not accept the worker claim yet')));
    assert.ok(events(source.id).some(event => event.type === 'network.response' && event.data.sessionId === source.id));
    assert.ok(assignment.review.inspectedEvidence.length >= 3); assert.ok(assignment.latestReport.reportArtifactId);
  } finally {
    const info = runtimeInfo(); if (info && identityAlive(info.identity)) await runtimeRequest(info, 'POST', '/shutdown', {}).catch(() => {});
    for (let attempt = 0; attempt < 80 && info && identityAlive(info.identity); attempt++) await delay(20);
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    for (const [key, value] of Object.entries(previous)) if (value == null) delete process.env[key]; else process.env[key] = value;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
