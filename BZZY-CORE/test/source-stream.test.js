import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commandSource, safeCommandSource, createStreamingSourceObserver } from '../src/engine/source-stream.js';

const session = { id: 'terminal-fixture', cwd: '/synthetic/project' };
const start = (observe, name = 'Bash') => observe({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call', name } });
const chunk = (observe, partial_json) => observe({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json } });

test('shell previews display actual interpreter input, never stdout or invented file paths', () => {
  const command = `/bin/bash -lc "python3 -u - <<'PY'\nimport requests\nprint('actual input')\nPY\n"`;
  const source = commandSource(command);
  assert.equal(source.language, 'python'); assert.equal(source.content, "import requests\nprint('actual input')");
  assert.equal(source.sourceKind, 'command'); assert.equal(source.path, 'python · shell input');
  assert.equal(commandSource('node <<JS\nconsole.log(1);\nJS').content, 'console.log(1);');
  assert.equal(commandSource(['/bin/bash', '-c', "python3 - <<'PY'\nprint('actual argv input')\nPY"]).content, "print('actual argv input')");
  assert.equal(commandSource('curl https://example.test').language, 'sh');
  assert.equal(commandSource('x'.repeat(256 * 1024 + 1)), null);
  assert.equal(safeCommandSource({ ...session, agentId: 'persistent' }, command), null);
  assert.equal(safeCommandSource({ ...session, importedUntrusted: true }, command), null);
  assert.doesNotMatch(safeCommandSource(session, 'API_KEY="fixture-never-show" curl example.test').content, /fixture-never-show/);
});
test('real tool-input chunks produce replayable source patches, including escapes and changed heredoc projections', () => {
  const events = [], observe = createStreamingSourceObserver(session, (type, data) => events.push({ type, data }));
  start(observe);
  const input = JSON.stringify({ command: "python3 - <<'PY'\nprint('café 🐝')\nPY" });
  let replay = '', revision = 0;
  for (const character of input) {
    const before = events.length; chunk(observe, character);
    assert.ok(events.length <= before + 1, 'no fabricated timer or typing deltas');
  }
  observe({ type: 'content_block_stop', index: 0 });
  for (const { type, data } of events) {
    assert.equal(type, 'source.delta'); assert.equal(data.sourceId, 'command:call');
    assert.equal(data.revision, ++revision); assert.ok(data.replaceFrom <= replay.length);
    replay = replay.slice(0, data.replaceFrom) + data.text;
  }
  assert.equal(replay, "print('café 🐝')");
  assert.equal(events.at(-1).data.phase, 'prepared');
  assert.equal(events.at(-1).data.provenance, 'native-tool-input-stream');
  const before = events.length; chunk(observe, 'ignored'); assert.equal(events.length, before);
});
test('file input previews wait for an actual contained path and never parse fields inside source strings', () => {
  const events = [], observe = createStreamingSourceObserver(session, (type, data) => events.push(data));
  start(observe, 'Write');
  chunk(observe, JSON.stringify({ content: 'const field = "file_path";', file_path: 'src/actual.js' }));
  assert.equal(events.length, 1); assert.equal(events[0].path, 'src/actual.js'); assert.equal(events[0].sourceKind, 'proposed-edit');
  assert.equal(events[0].text, 'const field = "file_path";');
  for (const file_path of ['../outside.js', '.env', '.git/config', '/private/elsewhere.js']) {
    const before = events.length; start(observe, 'Write'); chunk(observe, JSON.stringify({ file_path, content: 'excluded' }));
    assert.equal(events.length, before, file_path);
  }
  start(observe, 'Bash'); chunk(observe, JSON.stringify({ nested: { command: 'fabricated nested command' }, description: '"command":"not input"' }));
  assert.equal(events.some(data => /fabricated|not input/.test(data.text)), false);
});
test('known credentials remain absent even when split between native chunks', () => {
  const previous = process.env.BZZY_STREAM_TEST_API_KEY, secret = 'fixture-stream-private-credential-9876';
  process.env.BZZY_STREAM_TEST_API_KEY = secret;
  try {
    const events = [], observe = createStreamingSourceObserver(session, (type, data) => events.push(data));
    start(observe);
    const input = JSON.stringify({ command: 'printf ' + secret + '\necho done' });
    for (const character of input) chunk(observe, character);
    let text = '';
    for (const event of events) { text = text.slice(0, event.replaceFrom) + event.text; assert.doesNotMatch(text, /fixture-stream-private/); }
    assert.match(text, /redacted/); assert.match(text, /echo done/);
  } finally { if (previous === undefined) delete process.env.BZZY_STREAM_TEST_API_KEY; else process.env.BZZY_STREAM_TEST_API_KEY = previous; }
});
test('unavailable private credentials disable optional streaming previews without interrupting native execution', () => {
  const previous = process.env.BZZY_HOME, directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-stream-private-'));
  process.env.BZZY_HOME = directory;
  try {
    fs.writeFileSync(path.join(directory, 'credentials.json'), 'fixture-damaged-private-binding');
    const events = [], observe = createStreamingSourceObserver(session, (type, data) => events.push(data));
    start(observe); chunk(observe, JSON.stringify({ command: 'echo visible' }));
    assert.deepEqual(events, []);
  } finally { if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous; fs.rmSync(directory, { recursive: true, force: true }); }
});
