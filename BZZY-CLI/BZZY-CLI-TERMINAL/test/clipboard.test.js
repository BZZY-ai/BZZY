import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { copyText, readClipboard } from '../src/clipboard.js';

function mockSpawn(outcomes, calls) {
  return (command, args, options) => {
    const outcome = outcomes.shift() || {}, child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough();
    const entry = { command, args, options, input: '' }; calls.push(entry);
    child.stdin.on('data', data => { entry.input += data.toString(); });
    child.kill = signal => { entry.killed = signal; queueMicrotask(() => child.emit('close', null)); };
    queueMicrotask(() => {
      if (outcome.error) { child.emit('error', Object.assign(new Error('mock missing utility'), { code: 'ENOENT' })); return; }
      if (outcome.hang) return;
      if (outcome.text != null) child.stdout.emit('data', Buffer.from(outcome.text));
      child.emit('close', outcome.code || 0);
    });
    return child;
  };
}
test('Mac copy and explicit paste use native bounded tools with exact Unicode text', async () => {
  const calls = [], spawnImpl = mockSpawn([{}, { text: 'quoted ☃\nsecond line\n' }], calls), options = { platform: 'darwin', env: {}, spawnImpl };
  assert.deepEqual(await copyText('selected ☃ words', null, options), { copied: true, method: 'native' });
  assert.deepEqual(await readClipboard(options), { text: 'quoted ☃\nsecond line\n', method: 'native' });
  assert.equal(calls[0].command, 'pbcopy'); assert.equal(calls[0].input, 'selected ☃ words'); assert.equal(calls[1].command, 'pbpaste');
  assert.equal(calls[1].input, ''); assert.equal(calls[0].options.stdio[2], 'ignore');
});
test('Linux chooses Wayland then available X11 tools and never runs clipboard readers implicitly', async () => {
  const calls = [], options = { platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':1' }, spawnImpl: mockSpawn([{ error: true }, { code: 1 }, {}], calls) };
  assert.equal((await copyText('selection', null, options)).copied, true);
  assert.deepEqual(calls.map(call => call.command), ['wl-copy', 'xclip', 'xsel']);
  assert.equal(calls.some(call => call.command === 'wl-paste' || call.args.includes('-out')), false);
});
test('SSH copy sends escaped OSC52 only to a TTY, while clipboard reads report an honest fallback', async () => {
  const sent = [], output = { isTTY: true, write: value => sent.push(value) }, options = { platform: 'linux', env: { TERM: 'xterm-256color' } };
  const copied = await copyText('phrase\x1b]52;evil', output, options);
  assert.equal(copied.method, 'osc52'); assert.match(copied.reason, /must be enabled/);
  assert.equal(sent[0], `\x1b]52;c;${Buffer.from('phrase\x1b]52;evil').toString('base64')}\x07`);
  const pasted = await readClipboard(options); assert.equal(pasted.text, null); assert.match(pasted.reason, /terminal’s Paste/);
  assert.equal(sent.length, 1, 'reading never sends a hidden terminal clipboard query');
  assert.equal((await copyText('phrase', { isTTY: false, write() { throw new Error('not reached'); } }, options)).copied, false);
});
test('tmux requests are wrapped, clipboard subprocess hangs are killed, and oversized data is rejected', async () => {
  const calls = [], sent = [], output = { isTTY: true, write: text => sent.push(text) };
  const timed = await copyText('small selection', output, { platform: 'darwin', env: { TMUX: 'session' }, timeoutMs: 10, spawnImpl: mockSpawn([{ hang: true }], calls) });
  assert.equal(calls[0].killed, 'SIGKILL'); assert.equal(timed.method, 'osc52'); assert.ok(sent[0].startsWith('\x1bPtmux;\x1b\x1b]52;'));
  assert.equal((await copyText('a'.repeat(512 * 1024 + 1), output, { platform: 'linux', env: {} })).copied, false);
  const oversized = await readClipboard({ platform: 'darwin', env: {}, spawnImpl: mockSpawn([{ text: 'a'.repeat(512 * 1024 + 1) }], []) });
  assert.equal(oversized.text, null); assert.match(oversized.reason, /exceeds/);
});
