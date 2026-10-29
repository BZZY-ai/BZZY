import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { sourcePreview, createSourceObserver } from '../src/engine/source-preview.js';

test('source previews use actual completed files and reject private paths, symlink escapes, binary and oversized data', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-source-')), cwd = path.join(directory, 'project'); fs.mkdirSync(cwd);
  const session = { id: 'fixture', cwd };
  try {
    fs.writeFileSync(path.join(cwd, 'probe.js'), 'const value = 1;\nconst API_KEY = "fixture-never-display";\n');
    const preview = sourcePreview(session, 'probe.js');
    assert.equal(preview.phase, 'completed'); assert.match(preview.content, /const value = 1/); assert.doesNotMatch(preview.content, /fixture-never-display/); assert.equal(preview.redacted, true);
    fs.writeFileSync(path.join(cwd, 'settings.json'), '{"password":"fixture-password","token":"fixture-token"}');
    assert.doesNotMatch(sourcePreview(session, 'settings.json').content, /fixture-password|fixture-token/);
    fs.linkSync(path.join(cwd, 'probe.js'), path.join(cwd, 'linked.js')); assert.equal(sourcePreview(session, 'linked.js').content, undefined);
    fs.unlinkSync(path.join(cwd, 'linked.js'));
    fs.writeFileSync(path.join(cwd, '.env'), 'TOKEN=fixture'); assert.equal(sourcePreview(session, '.env'), null);
    fs.writeFileSync(path.join(directory, 'outside.js'), 'const outside = true;'); assert.equal(sourcePreview(session, '../outside.js'), null);
    fs.symlinkSync(path.join(directory, 'outside.js'), path.join(cwd, 'link.js')); assert.equal(sourcePreview(session, 'link.js'), null);
    fs.writeFileSync(path.join(cwd, 'binary.js'), Buffer.from([0, 1, 2])); assert.equal(sourcePreview(session, 'binary.js').content, undefined);
    fs.writeFileSync(path.join(cwd, 'huge.js'), 'x'.repeat(256 * 1024 + 1)); assert.equal(sourcePreview(session, 'huge.js').content, undefined);
    assert.equal(sourcePreview({ ...session, agentId: 'persistent' }, 'probe.js'), null);
    assert.equal(sourcePreview(session, 'missing.js'), null);
    assert.equal(sourcePreview(session, 'probe.js', { phase: 'started' }).content, undefined);
    assert.equal(sourcePreview(session, 'probe.js', { failed: true }).content, undefined);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test('native observers correlate edit completion and return atomic writes immediately without inventing streamed lines', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-source-observer-')), emitted = [];
  try {
    const observer = createSourceObserver({ id: 'fixture', cwd }, (type, data) => emitted.push({ type, data }));
    observer({ method: 'tool.started', params: { id: 'tool-1', name: 'Write', input: { file_path: 'main.py', content: 'Uncommitted proposed content' } } });
    assert.equal(emitted[0].data.phase, 'started'); assert.equal(emitted[0].data.content, undefined);
    fs.writeFileSync(path.join(cwd, 'main.py'), 'print("actual file")');
    observer({ method: 'tool.completed', params: { id: 'tool-1' } }); assert.equal(emitted.at(-1).data.content, 'print("actual file")');
    observer({ method: 'item/completed', params: { item: { id: 'edit-1', type: 'fileChange', status: 'completed', changes: [{ path: 'main.py', diff: '+print("actual file")' }] } } });
    assert.equal(emitted.at(-1).data.provenance, 'native-file-edit'); assert.match(emitted.at(-1).data.diff, /actual file/);
    const count = emitted.length; observer({ method: 'item/completed', params: { item: { type: 'commandExecution', command: 'echo secret > other.js' } } }); assert.equal(emitted.length, count);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});
test('managed runners durably mirror safe source previews with their worker identity', async () => {
  const previous = process.env.BZZY_HOME, cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-source-runner-'));
  process.env.BZZY_HOME = path.join(cwd, 'private');
  try {
    const { createSession } = await import('../src/engine/store.js');
    const { BUILTINS } = await import('../src/engine/providers.js');
    const { RunnerUI } = await import('../src/engine/runtime-ui.js');
    const { events } = await import('../src/engine/database.js');
    const parent = createSession(BUILTINS.codex, cwd), worker = createSession(BUILTINS.codex, cwd);
    fs.writeFileSync(path.join(cwd, 'worker.js'), 'export const observed = true;');
    const runner = new RunnerUI(worker.id, { parentSessionId: parent.id, agent: 'source-reviewer' });
    runner.event('backend', { method: 'item/completed', params: { item: { id: 'actual-edit', type: 'fileChange', status: 'completed', changes: [{ path: 'worker.js' }] } } });
    const source = events(parent.id).filter(row => row.type === 'source.changed');
    assert.equal(source.length, 1); assert.equal(source[0].data.actorSessionId, worker.id); assert.equal(source[0].data.actorName, 'source-reviewer');
    assert.equal(source[0].data.content, 'export const observed = true;');
    runner.close();
  } finally { if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous; fs.rmSync(cwd, { recursive: true, force: true }); }
});
