import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createSession, saveSession, loadSession } from '../src/store.js';
import { getProvider } from '../src/providers.js';
import { appendEvent, events, getRecord, listRecords, digest } from '../src/database.js';
import { runtimeInfo, runtimeRequest } from '../src/runtime.js';
import { identityAlive } from '../src/recovery.js';
import { root } from '../src/process.js';
import { prepareTask } from '@bzzy/core/engine/task.js';
import { newGoal } from '@bzzy/core/engine/goals.js';
import { captureEvidence } from '@bzzy/core/engine/evidence.js';

let directory, workspace, previous;
test.beforeEach(() => {
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-validate-command-')));
  workspace = path.join(directory, 'project'); fs.mkdirSync(workspace);
  const configuration = {
    BZZY_HOME: path.join(directory, 'private'), BZZY_CODEX_HOME: path.join(directory, 'codex'),
    BZZY_CLAUDE_HOME: path.join(directory, 'claude'), CLAUDE_CONFIG_DIR: path.join(directory, 'claude'),
    CLAUDE_SECURESTORAGE_CONFIG_DIR: path.join(directory, 'claude-secure'),
    BZZY_CODEX_BIN: path.join(root, 'test/fixtures/advanced-agent.mjs'),
    BZZY_CLAUDE_BIN: path.join(root, 'test/fixtures/advanced-agent.mjs'),
    BZZY_TEST_LOG: path.join(directory, 'backend.jsonl'), BZZY_TEST_ADVANCED: 'debate-no-evidence', BZZY_DIRECT: undefined,
  };
  previous = Object.fromEntries(Object.keys(configuration).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(configuration)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
});
test.afterEach(async () => {
  const info = runtimeInfo();
  let stopped = false;
  try {
    // /shutdown deliberately retains independent runners. This fixture ends
    // when validation starts, so stop and await its workers before removing
    // their private workspace and logs.
    if (info && identityAlive(info.identity)) await runtimeRequest(info, 'POST', '/operator-stop', { shutdown: true });
    for (let count = 0; count < 100 && info && identityAlive(info.identity); count++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(Boolean(info && identityAlive(info.identity)), false, 'The private fixture Core must exit before its temporary directory is removed.');
    stopped = true;
  } finally {
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    if (stopped) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 40 });
  }
});

function achievedSession() {
  fs.writeFileSync(path.join(workspace, 'source.txt'), 'The controlled fixture answer is 4.\n');
  const session = createSession(getProvider('codex'), workspace, 'fixture-validate-command', 'Validate command fixture');
  const objective = 'Check that the supplied controlled fixture records the answer 4.';
  prepareTask(session, { mode: 'solo' }, objective); session.goal = newGoal(objective);
  session.contract.acceptanceCriteria = [{ id: 'recorded-answer', description: 'The supplied source records the answer 4.' }];
  session.contract.constraints = ['Only inspect the supplied local fixture.']; saveSession(session);
  appendEvent(session.id, 'message.user', { text: objective, kind: 'goal' });
  session.goal.evidence = [captureEvidence(session, 'source.txt', 'controlled-source').id];
  session.goal.status = 'complete'; saveSession(session);
  appendEvent(session.id, 'text', { text: Array.from({ length: 80 }, (_, index) => `Saved observation ${index + 1}: supplied fixture only.\n`).join('') });
  appendEvent(session.id, 'text', { text: 'The controlled source records the answer 4. Goal achieved.' });
  appendEvent(session.id, 'goal.completed', { goalId: session.goal.id });
  return session;
}

// The real default CLI handles raw stdin, command dispatch and watcher replay.
// Inspect its settled terminal screen, not text that was immediately erased.
function submitValidate(session, expectation) {
  const code = String.raw`
import codecs, fcntl, json, os, pty, re, select, sqlite3, struct, subprocess, sys, termios, time, unicodedata
rows, cols = 38, 140
screen = [[' '] * cols for _ in range(rows)]
y, x, saved, pending = 0, 0, (0, 0), ''
decoder = codecs.getincrementaldecoder('utf-8')('replace')
raw = b''
def paint(data):
    global y, x, saved, pending
    pending += decoder.decode(data)
    i = 0
    while i < len(pending):
        ch = pending[i]
        if ch == '\x1b':
            if i + 1 >= len(pending): break
            if pending[i + 1] == '[':
                match = re.match(r'\x1b\[([0-?]*)([ -/]*)([@-~])', pending[i:])
                if not match: break
                args, _, command = match.groups()
                values = [int(v or 0) for v in args.split(';')] if re.fullmatch(r'[0-9;]*', args) else []
                if command in ('H', 'f'):
                    y = min(rows - 1, max(0, (values[0] if values else 1) - 1))
                    x = min(cols - 1, max(0, (values[1] if len(values) > 1 else 1) - 1))
                elif command == 'K':
                    mode = values[0] if values else 0
                    start, end = (0, cols) if mode == 2 else (0, x + 1) if mode == 1 else (x, cols)
                    screen[y][start:end] = [' '] * (end - start)
                elif command == 'J':
                    mode = values[0] if values else 0
                    if mode in (2, 3):
                        for line in screen: line[:] = [' '] * cols
                    elif mode == 0:
                        screen[y][x:] = [' '] * (cols - x)
                        for line in screen[y + 1:]: line[:] = [' '] * cols
                elif command == 'A': y = max(0, y - (values[0] if values and values[0] else 1))
                elif command == 'B': y = min(rows - 1, y + (values[0] if values and values[0] else 1))
                elif command == 'C': x = min(cols - 1, x + (values[0] if values and values[0] else 1))
                elif command == 'D': x = max(0, x - (values[0] if values and values[0] else 1))
                i += match.end(); continue
            if pending[i + 1] == ']':
                end = pending.find('\x07', i + 2)
                if end < 0: break
                i = end + 1; continue
            if pending[i + 1] == '7': saved = (y, x)
            elif pending[i + 1] == '8': y, x = saved
            i += 2; continue
        if ch == '\r': x = 0
        elif ch == '\n':
            y += 1
            if y >= rows: screen.pop(0); screen.append([' '] * cols); y = rows - 1
        elif ch == '\b': x = max(0, x - 1)
        elif ord(ch) >= 32 and not unicodedata.combining(ch):
            width = 2 if unicodedata.east_asian_width(ch) in ('W', 'F') else 1
            if x >= cols: x = 0; y = min(rows - 1, y + 1)
            screen[y][x] = ch
            if width == 2 and x + 1 < cols: screen[y][x + 1] = ''
            x += width
        i += 1
    pending = pending[i:]
def visible(): return '\n'.join(''.join(line).rstrip() for line in screen)
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
child = subprocess.Popen([sys.argv[1], sys.argv[2], '--attach', sys.argv[4], '--no-pet'], stdin=slave, stdout=slave, stderr=slave, cwd=sys.argv[3], env={**os.environ, 'TERM': 'xterm-256color'}, start_new_session=True)
os.close(slave)
db = sqlite3.connect(os.path.join(os.environ['BZZY_HOME'], 'bzzy.sqlite'), timeout=2)
def drain(duration=.03):
    global raw
    if select.select([master], [], [], duration)[0]:
        try:
            data = os.read(master, 65536)
            raw = (raw + data)[-150000:]; paint(data)
        except OSError: pass
def until(check, seconds=10):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        drain()
        if check(): return
        if child.poll() is not None: break
    raise AssertionError('Settled screen:\n' + visible() + '\nRaw tail:\n' + raw[-1600:].decode(errors='replace'))
def links(): return [json.loads(row[0]) for row in db.execute("SELECT data FROM events WHERE session_id=? AND type='debate.linked'", (sys.argv[4],))]
def started():
    linked = links()
    return linked and db.execute("SELECT 1 FROM records WHERE kind='execution' AND json_extract(data,'$.sessionId')=? LIMIT 1", (linked[-1]['sessionId'],)).fetchone()
try:
    until(lambda: 'fixture-validate-command' in visible() and any(label in visible() for label in ('Read-only session', 'Ask BZZY to do anything', 'Send a message to continue here')))
    os.write(master, b'/validate\r')
    if sys.argv[5] == 'started':
        until(started)
    else:
        until(lambda: 'Validation could not start' in visible())
        # Retain the error through watcher polling and the temporary notice's
        # dismissal; scrollbar glyphs are terminal chrome, not message prose.
        deadline = time.monotonic() + 4.25
        while time.monotonic() < deadline: drain()
        frame = visible()
        prose = re.sub(r'\s+', ' ', frame.replace('│', '').replace('┃', ''))
        assert 'Validation could not start' in frame, frame
        assert 'Restore the original files' in prose, frame
        assert 'Saved artifact copies were kept' in prose, frame
        assert not links(), 'Failed preflight must not link or launch a review'
        assert 'Validated ✓' not in frame, frame
    print(json.dumps({'screen': visible(), 'linked': links()}))
finally:
    if child.poll() is None: child.terminate()
    child.wait(timeout=5)
    db.close(); os.close(master)
`;
  const result = spawnSync('python3', ['-I', '-c', code, process.execPath, path.join(root, 'bin/bzzy.js'), workspace, session.id, expectation], {
    env: process.env, encoding: 'utf8', timeout: 18000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message || result.stdout);
  return JSON.parse(result.stdout.trim());
}

test('actual default CLI /validate on an achieved goal links and starts the independent review', { timeout: 25000 }, () => {
  const session = achievedSession(), terminal = submitValidate(session, 'started');
  const link = events(session.id).find(event => event.type === 'debate.linked');
  assert.ok(link); assert.equal(terminal.linked[0].sessionId, link.data.sessionId);
  assert.ok(listRecords('execution', { sessionId: link.data.sessionId }).length);
  assert.equal(loadSession(link.data.sessionId).parentSessionId, session.id);
  assert.equal(loadSession(session.id).goal.status, 'complete');
});

test('actual default CLI /validate retains a visible missing-source error without a review or false validation badge', { timeout: 25000 }, () => {
  const session = achievedSession(), artifact = getRecord('artifact', session.goal.evidence[0]);
  const savedCopy = fs.readFileSync(artifact.path);
  assert.equal(digest(savedCopy), artifact.sha256);
  fs.unlinkSync(path.join(workspace, 'source.txt'));
  submitValidate(session, 'missing');
  assert.deepEqual(fs.readFileSync(artifact.path), savedCopy);
  assert.equal(loadSession(session.id).goal.status, 'complete');
  assert.equal(events(session.id).filter(event => event.type === 'debate.linked').length, 0);
  assert.equal(listRecords('execution').length, 0);
  assert.equal(listRecords('session').length, 1);
  assert.notEqual(loadSession(session.id).goalValidation?.state, 'validated');
});
