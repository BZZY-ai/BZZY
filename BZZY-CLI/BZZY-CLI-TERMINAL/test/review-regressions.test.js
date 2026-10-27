import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { database, transaction, putRecord, listRecords, appendEvent } from '../src/database.js';
import { createSession, saveSession, loadSession, lockFile } from '../src/store.js';
import { processIdentity } from '../src/process-identity.js';
import { BUILTINS, saveConfig } from '../src/providers.js';
import { conversationCursor, conversationPrompt } from '../src/conversation.js';
import { guardedInterval } from '../src/interval.js';
import { RunnerUI } from '../src/runtime-ui.js';
import { ToolHost, bridgeRequest } from '../src/tools.js';
import { Rpc } from '../src/rpc.js';
import { snapshotWorkspace } from '../src/evidence.js';
import { initializeProject } from '../src/project.js';
import { newGoal } from '../src/goals.js';
import { normalizeContract } from '../src/contracts.js';
import { assessGroupCompletion, runCheck } from '../src/verification.js';
import { collectProjectState } from '../src/project-bundle.js';
import { goalEvent } from '../src/lifecycle.js';
import { sandboxSupport } from '../src/policy.js';

let directory, previous;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
test.beforeEach(() => {
  directory = fs.realpathSync(fs.mkdtempSync('/tmp/bz-rv-')); previous = process.env.BZZY_HOME;
  process.env.BZZY_HOME = path.join(directory, 'state');
});
test.afterEach(() => {
  if (previous == null) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
  fs.rmSync(directory, { recursive: true, force: true });
});

function session() { return createSession(BUILTINS.codex, directory); }

test('indexed filters exclude historical executions and select only a session’s pending work', () => {
  const a = session(), b = session();
  transaction(db => {
    for (let i = 0; i < 12000; i++) putRecord('execution', String(i), { id: String(i), sessionId: i % 2 ? a.id : b.id, state: 'finished' }, db);
    putRecord('execution', 'active', { id: 'active', sessionId: a.id, state: 'running' }, db);
    putRecord('execution', 'queued', { id: 'queued', sessionId: b.id, state: 'queued' }, db);
  });
  assert.deepEqual(listRecords('execution', { sessionId: a.id, states: ['queued', 'running'] }).map(row => row.id), ['active']);
  assert.deepEqual(listRecords('execution', { sessionIds: [a.id, b.id], state: 'queued', limit: 1 }).map(row => row.id), ['queued']);
  assert.deepEqual(listRecords('execution', { sessionIds: [] }), []);
  const plans = database().prepare("EXPLAIN QUERY PLAN SELECT data FROM records WHERE kind=? AND json_extract(data,'$.sessionId')=? AND json_extract(data,'$.state')=?").all('execution', a.id, 'running');
  assert.match(JSON.stringify(plans), /records_session_state/);
});

test('locks detect reused live PIDs, recover old incomplete files and protect active owners', () => {
  const file = path.join(process.env.BZZY_HOME, 'test.lock'); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ identity: { ...processIdentity(), start: 'previous-process' }, nonce: 'stale' }));
  const release = lockFile(file);
  assert.equal(JSON.parse(fs.readFileSync(file)).identity.start, processIdentity().start);
  assert.throws(() => lockFile(file), error => error.code === 'BZZY_LOCKED' && error.message.includes(file));
  release();
  fs.writeFileSync(file, ''); assert.throws(() => lockFile(file), { code: 'BZZY_LOCKED' });
  fs.utimesSync(file, new Date(0), new Date(0)); lockFile(file)();
  fs.writeFileSync(file, `${process.pid}:legacy`); assert.throws(() => lockFile(file), { code: 'BZZY_LOCKED' });
});

test('provider handoffs bound long histories and even a single giant reply', () => {
  const s = session();
  for (let i = 0; i < 120; i++) { appendEvent(s.id, 'message.user', { text: `message-${i}` }); appendEvent(s.id, 'text', { text: '🐝'.repeat(4000) }); }
  s.conversationHandoff = { pending: true, throughSeq: conversationCursor(s.id) };
  let prompt = conversationPrompt(s, 'current');
  assert.ok(Buffer.byteLength(prompt) < 110 * 1024); assert.match(prompt, /message-119/); assert.doesNotMatch(prompt, /message-0"/);
  appendEvent(s.id, 'text', { text: 'oversized'.repeat(200000) });
  s.conversationHandoff.throughSeq = conversationCursor(s.id); prompt = conversationPrompt(s, 'next');
  assert.ok(Buffer.byteLength(prompt) < 110 * 1024); assert.match(prompt, /CURRENT USER MESSAGE:\nnext/);
});

test('guarded timers catch sync and async failures and do not overlap work', async () => {
  let calls = 0, active = 0, peak = 0; const failures = [];
  const timer = guardedInterval(async () => {
    active++; peak = Math.max(peak, active); const count = ++calls;
    try { await pause(15); if (count < 3) throw new Error('temporary failure'); } finally { active--; }
  }, 2, { onError: (_error, consecutive) => failures.push(consecutive) });
  try { for (let i = 0; i < 100 && calls < 4; i++) await pause(5); }
  finally { clearInterval(timer); await pause(20); }
  assert.equal(peak, 1); assert.ok(calls >= 4); assert.deepEqual(failures, [1, 2]);
});

test('unanswered approvals expire denied, release waiting state and preserve a concurrent engine save', async () => {
  const s = session(), ui = new RunnerUI(s.id, { questionTimeoutMs: 150 });
  const approval = ui.approve('Run a command?'); await pause(20);
  const stale = { ...s, executionState: 'running', usage: { tokens: 5 } }; saveSession(stale);
  assert.equal(loadSession(s.id).executionState, 'waiting_for_input');
  assert.equal(await approval, false);
  const [question] = listRecords('question', { sessionId: s.id });
  assert.equal(question.state, 'expired'); assert.equal(question.reason, 'input_timeout');
  assert.equal(loadSession(s.id).executionState, 'running');
  saveSession(stale);
  assert.equal(loadSession(s.id).executionState, 'running', 'late usage saves must not revive an expired question');
});

test('waiting notifications carry a unique question and an attach path', () => {
  const s = session(); s.goal = newGoal('Finish migration');
  const question = { id: randomUUID(), question: 'Allow command?', kind: 'approval' };
  const event = goalEvent(s, { question });
  assert.equal(event.type, 'goal.waiting_for_input'); assert.ok(String(event.epoch).includes(question.id));
  assert.equal(event.sessionId, s.id); assert.equal(event.question.id, question.id);
});

test('tool socket requests and responses preserve UTF-8 split inside a character', async () => {
  const s = session(), host = await new ToolHost(s, { event() {} }).open();
  try {
    const payload = Buffer.from(JSON.stringify({ token: host.token, method: 'call', name: 'get_task_state', arguments: { contextGeneration: 'Configuración 🐝' } }) + '\n');
    const split = payload.indexOf(Buffer.from('ó')) + 1;
    await new Promise((resolve, reject) => {
      const socket = net.createConnection(host.socket); const chunks = [];
      socket.on('error', reject); socket.on('data', chunk => chunks.push(chunk));
      socket.on('connect', () => { socket.write(payload.subarray(0, split)); setTimeout(() => socket.write(payload.subarray(split)), 15); });
      socket.on('end', () => { try { assert.ok(JSON.parse(Buffer.concat(chunks).toString()).result); resolve(); } catch (error) { reject(error); } });
    });
    const call = database().prepare("SELECT data FROM events WHERE session_id=? AND type='coordination.tool'").get(s.id);
    assert.equal(JSON.parse(call.data).input.contextGeneration, 'Configuración 🐝');
  } finally { await host.close(); }
  const socketPath = path.join(directory, 'response.sock'), text = 'Configuración 🐝';
  const response = Buffer.from(JSON.stringify({ result: { text } })), split = response.indexOf(Buffer.from('ó')) + 1;
  const server = net.createServer(socket => socket.once('data', () => { socket.write(response.subarray(0, split)); setTimeout(() => socket.end(response.subarray(split)), 15); }));
  await new Promise(resolve => server.listen(socketPath, resolve));
  try { assert.deepEqual(await bridgeRequest(socketPath, 'test-token', {}), { text }); }
  finally { await new Promise(resolve => server.close(resolve)); }
});

test('RPC tolerates stdout noise and distinguishes a failed handler from malformed JSON', async () => {
  const child = new EventEmitter(); Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), exitCode: 0 });
  const rpc = new Rpc(child, () => {}), diagnostics = [];
  rpc.on('diagnostic', event => diagnostics.push(event));
  const response = rpc.request('initialize'); child.stdout.write('native CLI warning\n{"id":1,"result":{"ok":true}}\n');
  assert.deepEqual(await response, { ok: true }); assert.equal(diagnostics.length, 1);
  const failure = new Promise(resolve => rpc.once('failure', resolve)); rpc.on('notification', () => { throw new Error('SQLITE_BUSY'); });
  child.stdout.write('{"method":"turn/completed"}\n');
  assert.match((await failure).message, /handler failed: SQLITE_BUSY/); await rpc.close();
});

test('project state reads use a WAL snapshot without blocking another writer', () => {
  const s = session(); appendEvent(s.id, 'text', { text: 'Saved context' });
  transaction(() => {
    listRecords('session');
    const source = `import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(process.argv[1]); db.exec("PRAGMA busy_timeout=200; INSERT INTO metadata VALUES ('concurrent-writer','ok')");`;
    const writer = spawnSync(process.execPath, ['--input-type=module', '-e', source, path.join(process.env.BZZY_HOME, 'bzzy.sqlite')], { encoding: 'utf8' });
    assert.equal(writer.status, 0, writer.stderr);
  }, { readOnly: true });
  const unrelated = session(); appendEvent(unrelated.id, 'text', { text: 'not included in selected history' });
  const state = collectProjectState(directory, s.id); assert.ok(state.events.some(event => event.sessionId === s.id));
});

test('a group cannot complete while code changes exist only in a private peer workspace', async () => {
  const parent = session(); parent.mode = 'parallel'; parent.goal = newGoal('Update app'); parent.contract = normalizeContract({}, 'Update app');
  fs.writeFileSync(path.join(directory, 'app.txt'), 'before');
  const snapshot = snapshotWorkspace(parent);
  const work = path.join(directory, 'peer'); fs.cpSync(snapshot.directory, work, { recursive: true });
  fs.writeFileSync(path.join(work, 'app.txt'), 'after');
  const child = createSession(BUILTINS.codex, work); child.goal = newGoal('Update app'); child.goal.status = 'complete'; child.acceptance = { passed: true };
  putRecord('parallel', parent.id, { snapshotId: snapshot.id });
  let result = await assessGroupCompletion(parent, [child]);
  assert.equal(result.passed, false); assert.deepEqual(result.workspaces[0].unapplied, ['app.txt']); assert.equal(result.workspaces[0].directory, work);
  fs.writeFileSync(path.join(directory, 'app.txt'), 'after');
  result = await assessGroupCompletion(parent, [child]); assert.equal(result.passed, true);
});

test('automatic project files are ignored without replacing custom ignore rules', () => {
  const s = session(); initializeProject(s); const ignore = path.join(directory, '.bzzy', '.gitignore');
  assert.equal(fs.readFileSync(ignore, 'utf8'), '*\n');
  fs.writeFileSync(ignore, 'custom/\n'); initializeProject(s); assert.equal(fs.readFileSync(ignore, 'utf8'), 'custom/\n');
});


test('snapshot limits can be raised explicitly without omitting files from the manifest', () => {
  const s = session(); fs.writeFileSync(path.join(directory, 'large.bin'), Buffer.alloc(21 * 1024 * 1024, 1));
  assert.throws(() => snapshotWorkspace(s), /exceeds 20 MiB/);
  saveConfig({ version: 1, snapshotLimits: { maxFileMiB: 24, maxTotalMiB: 30 } });
  const snapshot = snapshotWorkspace(s);
  assert.equal(snapshot.manifest['large.bin'].size, 21 * 1024 * 1024);
  assert.equal(snapshot.limits.maxFileMiB, 24);
  assert.equal(fs.statSync(path.join(snapshot.directory, 'large.bin')).size, 21 * 1024 * 1024);
});

test('verification output preserves characters written in separate byte chunks', async () => {
  const s = session(); s.contract = { policy: null };
  const program = "const bytes = Buffer.from('Configuración 🐝'); let n=0; const next=()=> { if(n<bytes.length) { process.stdout.write(bytes.subarray(n,++n)); setTimeout(next, 3); } }; next();";
  const result = await runCheck(s, { id: 'utf8', argv: [process.execPath, '-e', program], expectedExitCode: 0 });
  const evidence = (await import('../src/evidence.js')).readArtifact(result.evidence);
  assert.equal(JSON.parse(evidence.content).stdout, 'Configuración 🐝');
});

test('unsupported multi-agent isolation fails before launching a backend', { skip: process.platform === 'darwin' && sandboxSupport() ? 'macOS sandbox is available independently of PATH' : false }, () => {
  const controller = new URL('../src/controller.js', import.meta.url).href;
  const store = new URL('../src/store.js', import.meta.url).href;
  const provider = new URL('../src/providers.js', import.meta.url).href;
  const goals = new URL('../src/goals.js', import.meta.url).href;
  const code = `import assert from 'node:assert/strict';
    import { runSession } from ${JSON.stringify(controller)};
    import { createSession } from ${JSON.stringify(store)};
    import { BUILTINS } from ${JSON.stringify(provider)};
    import { newGoal } from ${JSON.stringify(goals)};
    const session = createSession(BUILTINS.codex, process.argv[1]); session.mode='delegate'; session.goal=newGoal('Do work');
    const ui = { event() {}, newline() {}, async ask() { return ''; }, async approve() { return false; } };
    await assert.rejects(runSession(BUILTINS.codex, session, {}, ui, 'Do work', {goal:true}), {code:'UNSUPPORTED_POLICY'});
    assert.equal(session.failure.category,'unsupported_policy'); assert.equal(session.goal.tokensUsed,0);`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code, directory], {
    env: { ...process.env, PATH: path.join(directory, 'no-bin'), BZZY_CODEX_BIN: path.join(directory, 'must-not-be-started') }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(child.status, 0, child.stderr);
});
