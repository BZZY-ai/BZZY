import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { workspaceManifest, snapshotWorkspace, copyWorkspaceSnapshot, inspectWorkspace, workspaceSnapshotContext } from '../src/engine/evidence.js';
import { createSession } from '../src/engine/store.js';
import { getProvider } from '../src/engine/providers.js';
import { events, getRecord } from '../src/engine/database.js';
import { sandboxSupport, spawnBounded } from '../src/engine/policy.js';

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

test('file, total and count budgets omit incidental files without hashing their payloads', () => {
  file('first.bin', 600 * 1024); file('second.bin', 600 * 1024);
  const read = fs.readSync; let bytes = 0;
  fs.readSync = (...args) => { const count = read(...args); bytes += count; return count; };
  try {
    for (const [limits, key] of [
      [{ maxFileMiB: 1, maxTotalMiB: 1, maxFiles: 10 }, 'maxTotalMiB'],
      [{ maxFileMiB: 1, maxTotalMiB: 2, maxFiles: 1 }, 'maxFiles'],
    ]) {
      configure(limits); bytes = 0;
      const omissions = [], manifest = workspaceManifest(project, undefined, { omissions });
      assert.deepEqual(Object.keys(manifest), ['first.bin']);
      assert.ok(omissions.some(item => item.path === 'second.bin' && item.reason === 'snapshot_limit' && item.limit === key));
      assert.ok(bytes <= 600 * 1024 + 128, `Only included files and classification headers should be read: ${bytes}`);
    }
    configure({ maxFileMiB: 1 }); file('large.bin', 2 * MiB); bytes = 0;
    const omissions = [], manifest = workspaceManifest(project, undefined, { omissions });
    assert.equal(manifest['large.bin'], undefined); assert.equal(Object.keys(manifest).length, 2);
    assert.ok(omissions.some(item => item.path === 'large.bin' && item.limit === 'maxFileMiB'));
    assert.ok(bytes <= 1200 * 1024 + 192);
  } finally { fs.readSync = read; }
});

test('explicit 64 MiB limits remain enforced and larger settings pass validation', () => {
  file('fixture.json', 65 * MiB); configure({ maxFileMiB: 64 });
  const omissions = [];
  assert.deepEqual(workspaceManifest(project, undefined, { omissions }), {});
  assert.equal(omissions[0].limit, 'maxFileMiB'); assert.equal(omissions[0].limitValue, 64);
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
  const partial = inspectWorkspace(snapshot, worker);
  assert.deepEqual(partial, []); assert.ok(partial.omissions.some(item => item.path === 'tool-output.bin'));
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
  try {
    const snapshot = snapshotWorkspace(session);
    assert.equal(snapshot.manifest['growing.bin'], undefined);
    assert.ok(snapshot.omissions.some(item => item.path === 'growing.bin' && item.reason === 'snapshot_changed'));
  }
  finally { fs.openSync = open; }
});

test('a large sibling does not consume the budget for smaller later inputs', () => {
  configure({ maxFileMiB: 4, maxTotalMiB: 1 });
  file('a-app.apk', 2 * MiB); file('b-task.txt', 32);
  const snapshot = snapshotWorkspace(session);
  assert.deepEqual(Object.keys(snapshot.manifest), ['b-task.txt']);
  assert.equal(snapshot.omissions[0].limit, 'maxTotalMiB');
  assert.equal(fs.statSync(path.join(project, 'a-app.apk')).size, 2 * MiB);
  session.startSnapshotId = snapshot.id;
  const coverage = workspaceSnapshotContext(session);
  assert.equal(coverage.originalWorkspace, project); assert.equal(coverage.skippedFiles, 1);
  assert.match(coverage.notice, /existing read tools and policy/);
  assert.equal(events(session.id).filter(event => event.type === 'info').length, 1);
});

test('budget omissions cannot become worker deletions and tracked files retain priority', () => {
  configure({ maxFileMiB: 1, maxTotalMiB: 1, maxFiles: 1 }); file('z-source.txt', 32);
  const snapshot = snapshotWorkspace(session), worker = path.join(root, 'worker'); copyWorkspaceSnapshot(snapshot, worker);
  fs.writeFileSync(path.join(worker, 'a-generated.txt'), 'new incidental output');
  fs.appendFileSync(path.join(worker, 'z-source.txt'), ' changed');
  const changes = inspectWorkspace(snapshot, worker);
  assert.equal(changes.length, 1); assert.equal(changes[0].path, 'z-source.txt'); assert.ok(changes[0].after);
  const fd = fs.openSync(path.join(worker, 'z-source.txt'), 'r+'); fs.ftruncateSync(fd, 2 * MiB); fs.closeSync(fd);
  const partial = inspectWorkspace(snapshot, worker);
  assert.deepEqual(partial.uninspected, ['z-source.txt']);
  assert.equal(partial.some(change => change.path === 'z-source.txt'), false);
  fs.unlinkSync(path.join(worker, 'z-source.txt'));
  const deleted = inspectWorkspace(snapshot, worker).find(change => change.path === 'z-source.txt');
  assert.ok(deleted.before); assert.equal(deleted.after, null);
});

test('omission metadata stays bounded when many files exceed the count budget', () => {
  configure({ maxFiles: 1 });
  for (let i = 0; i < 1000; i++) file(`${i}.txt`);
  const snapshot = snapshotWorkspace(session);
  assert.equal(Object.keys(snapshot.manifest).length, 1);
  assert.ok(snapshot.omissions.length <= 65);
  assert.equal(snapshot.omissions.reduce((count, item) => count + (item.omittedCount || 1), 0), 999);
  session.startSnapshotId = snapshot.id;
  assert.equal(workspaceSnapshotContext(session).skippedFiles, 999);
  assert.equal(workspaceSnapshotContext(session).samples.length, 8);
});

test('an unreadable incidental file is omitted while readable inputs remain usable', () => {
  const target = file('a-unreadable.bin'), open = fs.openSync; file('b-task.txt');
  fs.openSync = (name, flags, ...args) => {
    if (name === target && flags === 'r') throw Object.assign(new Error('fixture denied'), { code: 'EACCES' });
    return open(name, flags, ...args);
  };
  try {
    const snapshot = snapshotWorkspace(session);
    assert.deepEqual(Object.keys(snapshot.manifest), ['b-task.txt']);
    assert.ok(snapshot.omissions.some(item => item.path === 'a-unreadable.bin' && item.reason === 'snapshot_unavailable'));
  } finally { fs.openSync = open; }
});

test('copy failures for individual files do not fail an otherwise usable snapshot', () => {
  const target = file('a-vanished.txt'), copy = fs.copyFileSync; file('b-task.txt');
  fs.copyFileSync = (source, ...args) => {
    if (source === target) throw Object.assign(new Error('fixture disappeared'), { code: 'ENOENT' });
    return copy(source, ...args);
  };
  try {
    const snapshot = snapshotWorkspace(session);
    assert.deepEqual(Object.keys(snapshot.manifest), ['b-task.txt']);
    assert.ok(snapshot.omissions.some(item => item.path === 'a-vanished.txt' && item.reason === 'snapshot_unavailable'));
  } finally { fs.copyFileSync = copy; }
});

test('best-effort capture cannot bypass symlink containment', () => {
  execFileSync('git', ['init', '-q', project]);
  const outside = path.join(root, 'outside.txt'); fs.writeFileSync(outside, 'not a project input');
  fs.symlinkSync(outside, path.join(project, 'link.txt'));
  execFileSync('git', ['-C', project, 'add', 'link.txt']);
  assert.throws(() => workspaceManifest(project), /symlinks/);
});

test('an isolated worker can read an omitted original input under existing permissions without modifying it', async t => {
  if (!sandboxSupport()) return t.skip('Native sandbox is unavailable on this host.');
  configure({ maxFileMiB: 1 });
  const input = file('findings/previous-report/chrome', 2 * MiB);
  const snapshot = snapshotWorkspace(session), worker = path.join(root, 'worker'); copyWorkspaceSnapshot(snapshot, worker);
  assert.equal(fs.existsSync(path.join(worker, 'findings/previous-report/chrome')), false);
  const program = `const fs = require('node:fs');
    const fd = fs.openSync(process.argv[1], 'r'), header = Buffer.alloc(10);
    fs.readSync(fd, header, 0, header.length, 0); fs.closeSync(fd);
    if (header.toString() !== 'task input') process.exit(2);
    try { fs.writeFileSync(process.argv[1], 'changed'); process.exit(3); }
    catch (error) { if (!['EPERM', 'EACCES', 'EROFS'].includes(error.code)) throw error; }
    fs.writeFileSync('analysis.txt', 'Read original input without copying it.');`;
  const child = spawnBounded(process.execPath, ['-e', program, input], {
    cwd: worker, policy: { mode: 'workspace-write', writablePaths: ['.'], network: 'disabled' },
  });
  let stderr = ''; child.stderr.on('data', value => { stderr += value; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(code, 0, stderr);
  assert.equal(fs.statSync(input).size, 2 * MiB);
  assert.ok(fs.existsSync(path.join(worker, 'analysis.txt')));
});
