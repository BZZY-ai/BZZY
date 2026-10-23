import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CoreWorkspaces } from '../src/workspaces.js';
import { BzzyCore } from '../src/core.js';
import { getRecord, putRecord } from '../src/engine.js';
import { directoryIdentity, sameDirectoryIdentity } from '../src/engine/directory-identity.js';

let directory, saved;
test.beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-workspace-root-'));
  saved = process.env.BZZY_HOME;
  process.env.BZZY_HOME = path.join(directory, 'private');
});
test.afterEach(() => {
  if (saved === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = saved;
  fs.rmSync(directory, { recursive: true, force: true });
});

test('managed workspace root settings are explicit, canonical, idempotent and revision checked', () => {
  const api = new CoreWorkspaces(), selected = path.join(directory, 'managed-projects');
  assert.deepEqual(api.settings(), { configured: false, revision: 0, root: null });
  assert.throws(() => api.pin(), { code: 'WORKSPACE_SETUP_REQUIRED' });
  const input = { path: selected, create: true }, request = { requestId: randomUUID(), expectedRevision: 0 };
  const result = api.configure(input, request);
  assert.equal(result.root.path, fs.realpathSync(selected)); assert.equal(result.revision, 1);
  assert.deepEqual(api.configure(input, request), result);
  assert.equal(api.pin().path, result.root.path);
  assert.throws(() => api.configure({ path: selected }, { requestId: randomUUID(), expectedRevision: 0 }), { code: 'CONFLICT' });
  assert.throws(() => api.configure({ path: path.join(directory, 'different') }, request), { code: 'CONFLICT' });
  assert.equal(getRecord('core.workspace', 'default').identity.ino, String(fs.statSync(selected).ino));
});

test('workspace root stays separate from private host/auth storage and rejects symlink roots', () => {
  const api = new CoreWorkspaces();
  for (const selected of [process.env.BZZY_HOME, directory, path.join(directory, '.ssh'), path.join(directory, '.env.private')]) {
    assert.throws(() => api.configure({ path: selected, create: true }, { requestId: randomUUID(), expectedRevision: 0 }), { code: 'FORBIDDEN' });
  }
  const real = path.join(directory, 'actual'), link = path.join(directory, 'alias'); fs.mkdirSync(real); fs.symlinkSync(real, link);
  assert.throws(() => api.configure({ path: link }, { requestId: randomUUID(), expectedRevision: 0 }), { code: 'FORBIDDEN' });
  assert.equal(api.settings().configured, false);
});

test('changing a managed root never moves or rewrites a CLI conversation original cwd', () => {
  const api = new CoreWorkspaces(), external = path.join(directory, 'external-cli-project'); fs.mkdirSync(external);
  const core = new BzzyCore(), terminal = core.createConversation({ provider: 'codex', cwd: external }, { requestId: randomUUID() });
  const original = getRecord('session', terminal.id), first = path.join(directory, 'managed-one'), second = path.join(directory, 'managed-two');
  api.configure({ path: first, create: true }, { requestId: randomUUID(), expectedRevision: 0 }); const pin = api.pin();
  api.configure({ path: second, create: true }, { requestId: randomUUID(), expectedRevision: 1 });
  assert.throws(() => api.assertPin(pin), { code: 'WORKSPACE_CHANGED' });
  assert.equal(getRecord('session', terminal.id).cwd, original.cwd);
  assert.equal(fs.existsSync(path.join(first, path.basename(external))), false);
  assert.equal(fs.lstatSync(external).isSymbolicLink(), false);
});

test('pinned root replacement is detected without granting access to the replacement', () => {
  const api = new CoreWorkspaces(), selected = path.join(directory, 'projects');
  api.configure({ path: selected, create: true }, { requestId: randomUUID(), expectedRevision: 0 }); const pin = api.pin();
  fs.renameSync(selected, selected + '-old'); fs.mkdirSync(selected);
  assert.throws(() => api.assertPin(pin), { code: 'WORKSPACE_CHANGED' });
});

test('volume identity tolerates a remount but never an inode or volume replacement', () => {
  const selected = path.join(directory, 'root'); fs.mkdirSync(selected);
  const run = command => ({ status: 0, stdout: command.endsWith('/df') ? 'Filesystem Blocks Used Available Capacity Mounted on\n/dev/disk3s5 10 1 9 10% /\n'
    : '<plist><dict><key>VolumeUUID</key><string>12345678-1234-4234-8234-123456789ABC</string></dict></plist>' });
  const pin = directoryIdentity(selected, { platform: 'darwin', run });
  assert.ok(pin.volume); assert.equal(sameDirectoryIdentity(pin, { ...pin, dev: 'remounted' }), true);
  assert.equal(sameDirectoryIdentity(pin, { ...pin, ino: 'replaced' }), false);
  assert.equal(sameDirectoryIdentity(pin, { ...pin, volume: 'different' }), false);
  assert.equal(sameDirectoryIdentity({ dev: 'old', ino: pin.ino }, { ...pin, dev: 'new' }), false, 'Unverifiable legacy pins still need explicit confirmation');
});

test('macOS workspace pins survive a verified device-number change with the same volume and inode', { skip: process.platform !== 'darwin' }, () => {
  const selected = path.join(directory, 'managed'), api = new CoreWorkspaces();
  api.configure({ path: selected, create: true }, { expectedRevision: 0, requestId: randomUUID() });
  const original = getRecord('core.workspace', 'default');
  if (!original.identity.volume) return;
  const remounted = { ...original, identity: { ...original.identity, dev: 'previous-boot' } };
  putRecord('core.workspace', 'default', remounted);
  assert.equal(api.assertPin(remounted).id, original.id);
  assert.equal(getRecord('core.workspace', 'default').identity.dev, String(fs.statSync(selected).dev));
  assert.equal(getRecord('core.workspace', 'default').revision, original.revision);
  fs.renameSync(selected, selected + '-old'); fs.mkdirSync(selected);
  assert.throws(() => api.assertPin(remounted), { code: 'WORKSPACE_CHANGED' });
});
