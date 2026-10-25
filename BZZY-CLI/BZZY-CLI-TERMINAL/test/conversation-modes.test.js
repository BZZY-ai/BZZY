import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createSession, loadSession, saveSession, sessions } from '../src/store.js';
import { BUILTINS, saveModeDefault, saveDefaultSelection, modeDefault } from '../src/providers.js';
import { appendEvent, events, listRecords } from '../src/database.js';
import { runtimeInfo, runtimeRequest, claimInput } from '../src/runtime.js';
import { identityAlive } from '../src/recovery.js';
import { changeSessionMode, conversationModeCommand, controlSession, attachSession, viewSession } from '../src/runtime-client.js';
import { commandSuggestions } from '../src/terminal-commands.js';
import { root } from '../src/process.js';

let directory, previous;
const combo = [{ provider: 'codex', model: 'fixture-brain', effort: 'high', capabilities: { supportedEfforts: ['high'] } },
  { provider: 'codex', model: 'fixture-hands', effort: 'low', capabilities: { supportedEfforts: ['low'] } }];
test.beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-mode-switch-'));
  const keys = ['BZZY_HOME', 'BZZY_CODEX_HOME', 'BZZY_CODEX_BIN', 'BZZY_CLAUDE_BIN', 'BZZY_CLAUDE_HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR', 'BZZY_TEST_LOG', 'BZZY_DIRECT'];
  previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { BZZY_HOME: path.join(directory, 'private'), BZZY_CODEX_HOME: path.join(directory, 'codex'),
    BZZY_CLAUDE_HOME: path.join(directory, 'claude'), CLAUDE_CONFIG_DIR: path.join(directory, 'claude'), CLAUDE_SECURESTORAGE_CONFIG_DIR: path.join(directory, 'claude-secure'),
    BZZY_CODEX_BIN: path.join(root, 'test/fixtures/models.mjs'), BZZY_CLAUDE_BIN: path.join(root, 'test/fixtures/models.mjs'),
    BZZY_TEST_LOG: path.join(directory, 'backend.jsonl') });
  delete process.env.BZZY_DIRECT;
});
test.afterEach(async () => {
  const info = runtimeInfo();
  if (info && identityAlive(info.identity)) await runtimeRequest(info, 'POST', '/shutdown', {}).catch(() => {});
  for (let count = 0; count < 100 && info && identityAlive(info.identity); count++) await new Promise(resolve => setTimeout(resolve, 20));
  for (const [key, value] of Object.entries(previous)) if (value == null) delete process.env[key]; else process.env[key] = value;
  fs.rmSync(directory, { recursive: true, force: true });
});
const ui = () => ({ interactive: true, sessionMode: 'CONTROL', messages: [], event(type, value) { this.messages.push({ type, ...value }); },
  updateSession() {}, async chooseOne() { throw new Error('Saved defaults must not open a picker'); } });
function noExecution() {
  assert.equal(listRecords('execution').length, 0);
  const file = path.join(directory, 'backend.jsonl');
  if (fs.existsSync(file)) assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /thread\/start|turn\/start|thread\/goal\/set/);
}

test('achieved /validate and the legacy /debate alias bypass mode setup for immediate original-goal review', async () => {
  const session = createSession(BUILTINS.codex, directory, 'original-model');
  session.goal = { id: 'achieved-local-goal', status: 'complete', objective: 'Original achieved objective.' }; saveSession(session);
  const screen = ui();
  for (const command of ['/validate', '/validate original severity', '/debate', '/debate original severity']) {
    assert.equal(await conversationModeCommand(command, session.id, screen), false);
  }
  assert.equal(loadSession(session.id).mode, undefined); noExecution();
});

test('a confirmed /pause enables both mode switches in the same goal-less chat with saved defaults and no inference', async () => {
  saveModeDefault('delegate', combo);
  const session = createSession(BUILTINS.codex, directory, 'original-solo', 'Same chat');
  session.selectedEffort = 'xhigh'; saveSession(session);
  appendEvent(session.id, 'message.user', { text: 'Keep my current question.' });
  const reply = appendEvent(session.id, 'text', { text: 'Keep my full answer.' });
  const screen = ui();
  await assert.rejects(changeSessionMode(session.id, 'delegate', screen), /\/pause or \/goal pause/);
  assert.equal(loadSession(session.id).mode, undefined);
  await controlSession(session, 'pause');
  assert.equal(loadSession(session.id).executionState, 'paused');
  assert.equal(await conversationModeCommand('/delegate', session.id, screen), true);
  const delegated = loadSession(session.id);
  assert.equal(delegated.mode, 'delegate'); assert.equal(delegated.model, combo[0].model); assert.deepEqual(delegated.executor, combo[1]);
  assert.equal(delegated.executionState, 'paused'); assert.equal(delegated.goal, null);
  assert.equal(await conversationModeCommand('/singular', session.id, screen), true);
  const solo = loadSession(session.id);
  assert.equal(solo.mode, 'solo'); assert.equal(solo.model, 'original-solo'); assert.equal(solo.selectedEffort, 'xhigh');
  assert.equal(solo.cwd, session.cwd); assert.equal(solo.alias, session.alias); assert.equal(solo.executionState, 'paused');
  assert.equal(events(session.id).find(event => event.seq === reply.seq).data.text, 'Keep my full answer.');
  assert.equal(sessions().length, 1); assert.deepEqual(modeDefault('delegate'), combo); noExecution();
  assert.ok(screen.messages.some(message => /Delegate.*still paused/.test(message.message)));
  await assert.rejects(conversationModeCommand('/delegate run something', session.id, screen), /without arguments/);
  assert.equal(await conversationModeCommand('/unrelated', session.id, screen), false);
  assert.ok(commandSuggestions('/deleg').some(item => item.command === '/delegate'));
  assert.ok(commandSuggestions('/sol').some(item => item.command === '/solo'));
});

test('missing Delegate defaults open setup; cancellation and an input takeover leave the paused conversation intact', async () => {
  const session = createSession(BUILTINS.codex, directory, 'original-solo'); await controlSession(session, 'pause');
  const screen = ui(); let prompts = 0;
  screen.chooseOne = async title => { prompts++; assert.match(title, /Supervisor/); return null; };
  const before = loadSession(session.id);
  await changeSessionMode(session.id, 'delegate', screen);
  assert.equal(prompts, 1); assert.deepEqual(loadSession(session.id), before); noExecution();
  screen.chooseOne = async (title, choices) => {
    await choices;
    if (title.startsWith('Supervisor')) return title.includes('Choose provider') ? 'codex' : { value: 'fixture-brain', effort: 'high' };
    if (title.includes('Choose provider')) return 'codex';
    claimInput(session.id, 'other-client', true);
    return { value: 'fixture-light', effort: 'low' };
  };
  await assert.rejects(changeSessionMode(session.id, 'delegate', screen), /own input/);
  assert.deepEqual(loadSession(session.id), before); noExecution();
});

test('attached chats accept paused Delegate/Debate/Solo switches while read-only views cannot switch modes', async () => {
  saveModeDefault('delegate', combo); saveModeDefault('debate', combo);
  const session = createSession(BUILTINS.codex, directory, 'original-solo');
  const commands = ['/pause', '/delegate', '/debate', '/solo', '/exit'];
  const screen = { ...ui(), cursors: new Map(), setSession(id, mode) { this.sessionId = id; this.sessionMode = mode; }, clearHistory() {},
    async ask() { assert.ok(commands.length, 'Unexpected prompt'); return commands.shift(); } };
  assert.equal(await attachSession(session, { cwd: directory }, screen), 0);
  assert.equal(loadSession(session.id).mode, 'solo'); assert.equal(loadSession(session.id).executionState, 'paused');
  assert.equal(events(session.id).filter(event => event.type === 'mode.changed').length, 3); noExecution();
  commands.push('/delegate', '/debate', '/solo', '/exit');
  await viewSession(loadSession(session.id), { cwd: directory }, screen);
  assert.equal(events(session.id).filter(event => event.type === 'mode.changed').length, 3); noExecution();
  assert.ok(screen.messages.some(message => /read-only view/.test(message.message)));
});

test('Debate uses its own 2–3 agent default in a paused chat and retains focused reply challenges', async () => {
  const agents = [...combo, { ...combo[1], model: 'third-debate-agent' }]; saveModeDefault('debate', agents);
  const session = createSession(BUILTINS.codex, directory, 'solo-original'), screen = ui();
  await assert.rejects(changeSessionMode(session.id, 'debate', screen), /\/pause or \/goal pause/);
  await controlSession(session, 'pause');
  assert.equal(await conversationModeCommand('/debate', session.id, screen), true);
  assert.deepEqual(loadSession(session.id).debateAgents, agents); assert.equal(loadSession(session.id).executionState, 'paused');
  assert.equal(await conversationModeCommand('/debate Focus on this claim', session.id, screen), false);
  assert.equal(await conversationModeCommand('/solo', session.id, screen), true);
  assert.equal(loadSession(session.id).model, 'solo-original'); assert.equal(loadSession(session.id).debateAgents, undefined);
  assert.deepEqual(modeDefault('debate'), agents); noExecution();
});

test('minimal interactive CLI requires /pause and switches modes without leaving or executing its chat', { timeout: 20000 }, () => {
  saveDefaultSelection({ provider: 'codex', model: 'fixture-solo', selectedEffort: 'high' });
  saveModeDefault('delegate', combo); saveModeDefault('debate', combo);
  const code = String.raw`
import fcntl, json, os, pathlib, pty, select, sqlite3, struct, subprocess, sys, termios, time
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 140, 0, 0))
child = subprocess.Popen([sys.argv[1], sys.argv[2], '--minimal', '--no-pet'], stdin=slave, stdout=slave, stderr=slave, cwd=sys.argv[3], env={**os.environ, 'TERM': 'xterm-256color'}, start_new_session=True)
os.close(slave)
output = b''
def drain():
    global output
    if select.select([master], [], [], 0.02)[0]:
        try: output = (output + os.read(master, 65536))[-100000:]
        except OSError: pass
def session():
    file = pathlib.Path(os.environ['BZZY_HOME']) / 'bzzy.sqlite'
    if not file.exists(): return {}
    with sqlite3.connect(file) as db:
        try: rows = db.execute("SELECT data FROM records WHERE kind='session'").fetchall()
        except sqlite3.OperationalError: return {}
    return json.loads(rows[0][0]) if rows else {}
def until(check):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        drain()
        if check(): return
        if child.poll() is not None:
            assert check(), output[-3000:].decode(errors='replace')
            return
    raise AssertionError(output[-3000:].decode(errors='replace'))
try:
    until(lambda: session().get('model') == 'fixture-solo' and (pathlib.Path(os.environ['BZZY_HOME']) / 'runtime/service.json').exists())
    original = session()['id']
    os.write(master, b'/delegate\r')
    until(lambda: b'Pause this chat' in output)
    assert session().get('mode', 'solo') == 'solo'
    os.write(master, b'/pause\r')
    until(lambda: session().get('executionState') == 'paused')
    os.write(master, b'/delegate\r')
    until(lambda: session().get('mode') == 'delegate')
    assert session()['executionState'] == 'paused'
    os.write(master, b'/debate\r')
    until(lambda: session().get('mode') == 'debate')
    assert session()['executionState'] == 'paused'
    os.write(master, b'/solo\r')
    until(lambda: session().get('mode') == 'solo')
    assert session()['id'] == original and session()['model'] == 'fixture-solo'
    assert session()['executionState'] == 'paused'
    os.write(master, b'/exit\r')
    until(lambda: child.poll() is not None)
    assert child.returncode == 0
finally:
    if child.poll() is None: child.terminate()
    child.wait(timeout=5)
    os.close(master)
`;
  const result = spawnSync('python3', ['-I', '-c', code, process.execPath, path.join(root, 'bin/bzzy.js'), directory],
    { env: process.env, encoding: 'utf8', timeout: 18000 });
  assert.equal(result.status, 0, result.stderr); noExecution();
  assert.equal(sessions().length, 1);
  assert.equal(events(sessions()[0].id).filter(event => event.type === 'mode.changed').length, 3);
});

test('plain CLI opens terminal chat and returns from Settings with Esc without inference', { timeout: 20000 }, () => {
  saveDefaultSelection({ provider: 'codex', model: 'fixture-terminal', selectedEffort: 'high' });
  const code = String.raw`
import fcntl, os, pty, select, struct, subprocess, sys, termios, time
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
child = subprocess.Popen([sys.argv[1], sys.argv[2], '--no-pet'], stdin=slave, stdout=slave, stderr=slave, cwd=sys.argv[3], env={**os.environ, 'TERM': 'xterm-256color'}, start_new_session=True)
os.close(slave)
output = b''
def until(check):
    global output
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        if select.select([master], [], [], .03)[0]:
            try: output = (output + os.read(master, 65536))[-150000:]
            except OSError: pass
        if check(): return
    raise AssertionError(output[-2500:].decode(errors='replace'))
try:
    until(lambda: b'fixture-terminal' in output and b'Skills' in output and b'Agents' in output)
    os.write(master, b'/settings\r')
    until(lambda: b'Default models' in output and b'Pair iPhone' in output)
    output = b''
    os.write(master, b'\x1b')
    until(lambda: b'fixture-terminal' in output and b'Ask BZZY to do anything' in output)
    assert b'Right-click / F10' not in output and b'\x1b_G' not in output
    os.write(master, b'/exit\r')
    until(lambda: child.poll() is not None)
    assert child.returncode == 0
finally:
    if child.poll() is None: child.terminate()
    child.wait(timeout=5)
    os.close(master)
`;
  const result = spawnSync('python3', ['-I', '-c', code, process.execPath, path.join(root, 'bin/bzzy.js'), directory], { env: process.env, encoding: 'utf8', timeout: 18000 });
  assert.equal(result.status, 0, result.stderr); noExecution(); assert.equal(sessions().length, 1);
});
