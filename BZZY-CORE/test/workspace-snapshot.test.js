import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { workspaceManifest, snapshotWorkspace, copyWorkspaceSnapshot, inspectWorkspace } from '../src/engine/evidence.js';
import { createSession } from '../src/engine/store.js';
import { getProvider } from '../src/engine/providers.js';
import { events, getRecord } from '../src/engine/database.js';

const MiB = 1024 * 1024;
let root, project, previous, session;
test.beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-workspace-snapshot-')));
  previous = process.env.BZZY_HOME; process.env.BZZY_HOME = path.join(root, 'private');
  project = path.join(root, 'project'); fs.mkdirSync(project);
  session = createSession(getProvider('codex'), project, 'offline-fixture');
});
test.afterEach(() => {
  if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
  fs.rmSync(root, { recursive: true, force: true });
});
function file(name, size = 16) {
  const target = path.join(project, name); fs.mkdirSync(path.dirname(target), { recursive: true });
  const fd = fs.openSync(target, 'w', 0o600);
  try { fs.ftruncateSync(fd, size); fs.writeSync(fd, 'task input'); }
  finally { fs.closeSync(fd); }
  return target;
}
function configure(snapshotLimits) {
  fs.writeFileSync(path.join(process.env.BZZY_HOME, 'config.json'), JSON.stringify({ snapshotLimits }));
}

test('large evidence survives snapshot, worker copy and change inspection under new defaults', () => {
  const name = 'Cerberus/.cerberus/evidence/source/app/fixtures/stage_backup.json';
  file(name, 65 * MiB); file('other-input.bin', 40 * MiB);
  const snapshot = snapshotWorkspace(session), worker = path.join(root, 'worker');
  assert.equal(snapshot.manifest[name].size, 65 * MiB);
  assert.equal(snapshot.manifest['other-input.bin'].size, 40 * MiB);
  assert.deepEqual(snapshot.limits, { maxFileMiB: 1024, maxTotalMiB: 8192, maxFiles: 100000 });
  assert.equal(snapshot.manifest[name].sha256.length, 64);
  copyWorkspaceSnapshot(snapshot, worker);
  assert.deepEqual(inspectWorkspace(snapshot, worker), []);
  fs.appendFileSync(path.join(worker, name), ' changed');
  const changes = inspectWorkspace(snapshot, worker);
  assert.equal(changes.length, 1); assert.equal(changes[0].path, name);
  assert.equal(changes[0].before.sha256, snapshot.manifest[name].sha256);
  assert.notEqual(changes[0].after.sha256, changes[0].before.sha256);
});

for (const git of [false, true]) test(`runtime caches are excluded and audited with ${git ? 'Git' : 'filesystem'} enumeration`, () => {
  if (git) execFileSync('git', ['init', '-q', project]);
  file('source.js'); file('.cache/ms-playwright/chromium/chrome', 513 * MiB);
  file('nested/.cache/data', 2 * MiB); file('nested/.cache/more', 2 * MiB);
  file('nested/.pytest_cache/result'); file('nested/.mypy_cache/result'); file('.ruff_cache/result');
  // Even tracked caches and untracked caches use the same policy.
  if (git) execFileSync('git', ['-C', project, 'add', 'nested/.cache/data']);
  configure({ maxFileMiB: 1, maxTotalMiB: 1, maxFiles: 1 });
  const snapshot = snapshotWorkspace(session), worker = path.join(root, 'worker');
  assert.deepEqual(Object.keys(snapshot.manifest), ['source.js']);
  assert.deepEqual(snapshot.omissions.map(item => item.path).sort(), ['.cache', '.ruff_cache', 'nested/.cache', 'nested/.mypy_cache', 'nested/.pytest_cache']);
  assert.ok(snapshot.omissions.every(item => item.reason === 'runtime_cache'));
  assert.deepEqual(getRecord('snapshot', snapshot.id).omissions, snapshot.omissions);
  assert.deepEqual(events(session.id).find(event => event.type === 'snapshot').data.omissions, snapshot.omissions);
  copyWorkspaceSnapshot(snapshot, worker); assert.deepEqual(fs.readdirSync(worker), ['source.js']);
  file('source.js'); assert.deepEqual(inspectWorkspace(snapshot, project), []);
});

test('file, total and count limits fail before hashing and identify the exact configured setting', () => {
  file('first.bin', 600 * 1024); file('second.bin', 600 * 1024);
  const read = fs.readSync; let bytes = 0;
  fs.readSync = (...args) => { const count = read(...args); bytes += count; return count; };
  try {
    for (const [limits, key, minimum] of [
      [{ maxFileMiB: 1, maxTotalMiB: 1, maxFiles: 10 }, 'maxTotalMiB', 2],
      [{ maxFileMiB: 1, maxTotalMiB: 2, maxFiles: 1 }, 'maxFiles', 2],
    ]) {
      configure(limits); bytes = 0;
      assert.throws(() => snapshotWorkspace(session), error => {
        assert.ok(error.message.includes(`snapshotLimits.${key} to at least ${minimum}`));
        assert.ok(error.message.includes(path.join(process.env.BZZY_HOME, 'config.json'))); return true;
      });
      assert.ok(bytes <= 128, `Only classification headers should be read before rejecting: ${bytes}`);
    }
    configure({ maxFileMiB: 1 }); file('large.bin', 2 * MiB); bytes = 0;
    assert.throws(() => snapshotWorkspace(session), /snapshotLimits.maxFileMiB to at least 2/);
    assert.ok(bytes <= 128);
    assert.equal(fs.existsSync(path.join(process.env.BZZY_HOME, 'snapshots')), false);
  } finally { fs.readSync = read; }
});

test('explicit 64 MiB limits remain enforced and larger settings pass validation', () => {
  file('fixture.json', 65 * MiB); configure({ maxFileMiB: 64 });
  assert.throws(() => workspaceManifest(project), /file exceeds 64 MiB.*snapshotLimits.maxFileMiB to at least 65/);
  configure({ maxFileMiB: 1024, maxTotalMiB: 32768, maxFiles: 200000 });
  assert.equal(workspaceManifest(project)['fixture.json'].size, 65 * MiB);
  configure({ maxFileMiB: 16385 }); assert.throws(() => workspaceManifest(project), /maxFileMiB must be an integer from 1 to 16384/);
});

test('default snapshots accept more than ten thousand task files', () => {
  const directory = path.join(project, 'source'); fs.mkdirSync(directory);
  for (let i = 0; i < 10001; i++) fs.writeFileSync(path.join(directory, `${i}.txt`), '');
  assert.equal(Object.keys(workspaceManifest(project)).length, 10001);
});

test('raising limits unblocks inspection of an existing worker without replacing its snapshot', () => {
  configure({ maxFileMiB: 1, maxTotalMiB: 1 }); file('source.js');
  const snapshot = snapshotWorkspace(session), worker = path.join(root, 'worker'); copyWorkspaceSnapshot(snapshot, worker);
  const generated = path.join(worker, 'tool-output.bin'), fd = fs.openSync(generated, 'w');
  fs.ftruncateSync(fd, 2 * MiB); fs.closeSync(fd);
  assert.throws(() => inspectWorkspace(snapshot, worker), { code: 'SNAPSHOT_LIMIT' });
  configure({ maxFileMiB: 4, maxTotalMiB: 4 });
  const changes = inspectWorkspace(snapshot, worker);
  assert.equal(changes.length, 1); assert.equal(changes[0].path, 'tool-output.bin');
  assert.equal(changes[0].after.size, 2 * MiB); assert.equal(snapshot.limits.maxFileMiB, 1);
});

test('Git ignored and private files remain excluded while ordinary source stays visible', () => {
  execFileSync('git', ['init', '-q', project]);
  file('source.js'); file('.env'); file('nested/auth.json'); file('node_modules/package/index.js');
  file('ignored/fixture.json', 2 * MiB); fs.writeFileSync(path.join(project, '.gitignore'), 'ignored/\n');
  configure({ maxFileMiB: 1 });
  assert.deepEqual(Object.keys(workspaceManifest(project)), ['.gitignore', 'source.js']);
});

test('legacy snapshot caches are neither copied nor reported as deletions', () => {
  file('.cache/ms-playwright/chrome', 2 * MiB); file('source.js');
  const snapshot = { id: 'legacy-cache', sessionId: session.id, directory: project, manifest: {
    '.cache/ms-playwright/chrome': { size: 2 * MiB, sha256: 'historical-cache' },
    ...workspaceManifest(project),
  } };
  const worker = path.join(root, 'worker'), copied = copyWorkspaceSnapshot(snapshot, worker);
  assert.deepEqual(fs.readdirSync(worker), ['source.js']);
  assert.ok(copied.omissions.some(item => item.reason === 'runtime_cache' && item.phase === 'copy-source'));
  const changes = inspectWorkspace(snapshot, worker);
  assert.deepEqual(changes, []);
  assert.ok(changes.omissions.some(item => item.reason === 'runtime_cache' && item.phase === 'baseline'));
});

test('files growing between preflight and hashing cannot bypass snapshot limits', () => {
  const target = file('growing.bin'), open = fs.openSync;
  fs.openSync = (name, flags, ...args) => {
    if (name === target && flags === 'r') fs.appendFileSync(target, 'changed');
    return open(name, flags, ...args);
  };
  try { assert.throws(() => snapshotWorkspace(session), /Workspace changed while snapshotting: growing.bin/); }
  finally { fs.openSync = open; }
});
