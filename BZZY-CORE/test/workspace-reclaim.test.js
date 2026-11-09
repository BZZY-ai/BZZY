import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { home } from '../src/engine/files.js';
import { database, putRecord } from '../src/engine/database.js';
import { workspaceManifest } from '../src/engine/evidence.js';
import { reclaimAssignmentWorker, reclaimWorkspaceStorage, reclaimDeletedSessionStorage } from '../src/engine/workspace-reclaim.js';

let root, previous;
test.beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-reclaim-')));
  previous = process.env.BZZY_HOME; process.env.BZZY_HOME = path.join(root, 'private');
  database();
});
test.afterEach(() => {
  if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
  fs.rmSync(root, { recursive: true, force: true });
});

const uuid = () => randomUUID();
function makeDir(store, id, { aged = true } = {}) {
  const dir = path.join(home(), store, id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'copy'), 'x'.repeat(2048));
  fs.writeFileSync(path.join(home(), store, `${id}.json`), '{}'); // snapshot-style sidecar (ignored for other stores)
  if (aged) { const past = Date.now() / 1000 - 7200; fs.utimesSync(dir, past, past); }
  return dir;
}
const has = (store, id) => fs.existsSync(path.join(home(), store, id));
const assignment = (id, fields) => putRecord('assignment', id, { id, currentRound: 1, closure: 'open', ...fields });
const roundState = (id, n, state) => putRecord('round', `${id}:${n}`, { state });
const session = (id, fields) => putRecord('session', id, { id, ...fields });
const snapshot = (id, sessionId) => putRecord('snapshot', id, { id, sessionId });
const deleteSession = id => putRecord('session-deletion', id, { sessionId: id });

test('reclaimAssignmentWorker reclaims only copies no code path can still read', () => {
  const mk = (closure, extra = {}) => { const id = uuid(); assignment(id, { closure, ...extra }); makeDir('workers', id); return id; };

  const inconclusive = mk('inconclusive');
  assert.equal(reclaimAssignmentWorker(inconclusive), true);
  assert.equal(has('workers', inconclusive), false);

  const abandoned = mk('abandoned');
  reclaimAssignmentWorker(abandoned);
  assert.equal(has('workers', abandoned), false);

  const applied = mk('accepted', { appliedAt: '2026-01-01T00:00:00.000Z' });
  reclaimAssignmentWorker(applied);
  assert.equal(has('workers', applied), false, 'accepted + applied is terminal');

  const acceptedPending = mk('accepted');
  assert.equal(reclaimAssignmentWorker(acceptedPending), false, 'accepted-not-applied still needed by apply');
  assert.equal(has('workers', acceptedPending), true);

  const open = mk('open');
  assert.equal(reclaimAssignmentWorker(open), false, 'open can still resume/review');
  assert.equal(has('workers', open), true);

  const running = uuid(); assignment(running, { closure: 'inconclusive', currentRound: 2 }); roundState(running, 2, 'running'); makeDir('workers', running);
  assert.equal(reclaimAssignmentWorker(running), false, 'a running round is never pulled out');
  assert.equal(has('workers', running), true);
});

test('reclaimAssignmentWorker handles orphans and the recency guard', () => {
  const orphanAged = uuid(); makeDir('workers', orphanAged);
  assert.equal(reclaimAssignmentWorker(orphanAged), true, 'orphan with no record is reclaimable');

  const fresh = uuid(); makeDir('workers', fresh, { aged: false });
  assert.equal(reclaimAssignmentWorker(fresh), false, 'recency guard protects an in-flight copy');
  assert.equal(reclaimAssignmentWorker(fresh, { enforceRecencyGuard: false }), true, 'close/apply hook bypasses the guard at a known-safe point');

  const badId = 'not-a-uuid'; fs.mkdirSync(path.join(home(), 'workers', badId), { recursive: true });
  assert.equal(reclaimAssignmentWorker(badId), false, 'a non-uuid name is never treated as a store entry');
});

test('a finished or deleted parent session releases even an open assignment copy', () => {
  const done = uuid(); session(done, { goal: { state: 'completed' } });
  const onDone = uuid(); assignment(onDone, { closure: 'open', parentSessionId: done }); makeDir('workers', onDone);
  assert.equal(reclaimAssignmentWorker(onDone), true);

  const gone = uuid(); deleteSession(gone);
  const onGone = uuid(); assignment(onGone, { closure: 'open', parentSessionId: gone }); makeDir('workers', onGone);
  assert.equal(reclaimAssignmentWorker(onGone), true);

  const liveBlocked = uuid(); session(liveBlocked, { goal: { state: 'native_blocked' } });
  const onLive = uuid(); assignment(onLive, { closure: 'open', parentSessionId: liveBlocked }); makeDir('workers', onLive);
  assert.equal(reclaimAssignmentWorker(onLive), false, 'a resumable (blocked) session keeps its open copy');
});

test('sweep reclaims orphan and finished snapshots but keeps referenced ones', async () => {
  const orphan = uuid(); makeDir('snapshots', orphan);

  const doneSess = uuid(); session(doneSess, { goal: { state: 'completed' } });
  const doneSnap = uuid(); snapshot(doneSnap, doneSess); makeDir('snapshots', doneSnap);

  const liveSess = uuid();
  const baseSnap = uuid(); snapshot(baseSnap, liveSess); makeDir('snapshots', baseSnap);
  session(liveSess, { goal: { state: 'running' }, startSnapshotId: baseSnap });

  const refSnap = uuid(); snapshot(refSnap, doneSess); makeDir('snapshots', refSnap);
  const openAsg = uuid(); assignment(openAsg, { closure: 'open', parentSessionId: liveSess, snapshotId: refSnap });

  const summary = await reclaimWorkspaceStorage();
  assert.equal(has('snapshots', orphan), false, 'orphan snapshot reclaimed');
  assert.equal(fs.existsSync(path.join(home(), 'snapshots', `${orphan}.json`)), false, 'sidecar reclaimed too');
  assert.equal(has('snapshots', doneSnap), false, 'finished session snapshot reclaimed');
  assert.equal(has('snapshots', baseSnap), true, 'live session run-start baseline kept');
  assert.equal(has('snapshots', refSnap), true, 'snapshot referenced by an open assignment kept');
  assert.ok(summary.snapshots >= 2);
});

test('sweep reclaims terminal workers and finished group trees, keeps live ones', async () => {
  const liveSess = uuid(); session(liveSess, { goal: { state: 'running' } });
  const term = uuid(); assignment(term, { closure: 'inconclusive', parentSessionId: liveSess }); makeDir('workers', term);
  const open = uuid(); assignment(open, { closure: 'open', parentSessionId: liveSess }); makeDir('workers', open);

  const doneSess = uuid(); session(doneSess, { goal: { state: 'failed' } });
  makeDir('besties', doneSess);
  makeDir('parallel', liveSess);

  await reclaimWorkspaceStorage();
  assert.equal(has('workers', term), false, 'inconclusive worker reclaimed even while the session is live');
  assert.equal(has('workers', open), true, 'open worker of a live session kept');
  assert.equal(has('besties', doneSess), false, 'finished session group tree reclaimed');
  assert.equal(has('parallel', liveSess), true, 'live session group tree kept');
});

test('reclaimDeletedSessionStorage drops every copy a deleted session owned', () => {
  const sess = uuid();
  const asg = uuid(); assignment(asg, { closure: 'open', parentSessionId: sess }); makeDir('workers', asg, { aged: false });
  const snap = uuid(); snapshot(snap, sess); makeDir('snapshots', snap, { aged: false });
  makeDir('besties', sess, { aged: false });

  reclaimDeletedSessionStorage([sess]);
  assert.equal(has('workers', asg), false);
  assert.equal(has('snapshots', snap), false);
  assert.equal(fs.existsSync(path.join(home(), 'snapshots', `${snap}.json`)), false);
  assert.equal(has('besties', sess), false);
});

test('a goal launched from a home root excludes home dotdirs, not project source', () => {
  const ws = path.join(root, 'home-workspace'); fs.mkdirSync(ws);
  fs.mkdirSync(path.join(ws, '.local', 'share'), { recursive: true }); fs.writeFileSync(path.join(ws, '.local', 'share', 'blob'), 'x'.repeat(4096));
  fs.mkdirSync(path.join(ws, '.hermes'), { recursive: true }); fs.writeFileSync(path.join(ws, '.hermes', 'agent'), 'x'.repeat(4096));
  fs.writeFileSync(path.join(ws, 'app.js'), 'the real project');

  const prevHome = process.env.HOME;
  try {
    process.env.HOME = ws; // make this workspace the Core user's home
    const omissions = [];
    const manifest = workspaceManifest(ws, undefined, { omissions });
    assert.ok(manifest['app.js'], 'visible project source is still captured');
    assert.ok(!Object.keys(manifest).some(k => k.startsWith('.local') || k.startsWith('.hermes')), 'home dotdirs are not copied');
    assert.ok(omissions.some(o => o.path === '.local' && o.reason === 'runtime_cache'), 'exclusion is recorded as an omission');
  } finally { if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome; }
});

test('outside a home root, named caches are skipped but other dotdirs are kept', () => {
  const ws = path.join(root, 'project'); fs.mkdirSync(ws);
  fs.mkdirSync(path.join(ws, '.cargo'), { recursive: true }); fs.writeFileSync(path.join(ws, '.cargo', 'registry'), 'x'.repeat(4096));
  fs.mkdirSync(path.join(ws, '.hermes'), { recursive: true }); fs.writeFileSync(path.join(ws, '.hermes', 'keep'), 'x'.repeat(4096));
  fs.writeFileSync(path.join(ws, 'main.py'), 'code');

  const prevHome = process.env.HOME;
  try {
    process.env.HOME = path.join(root, 'elsewhere'); fs.mkdirSync(process.env.HOME);
    const manifest = workspaceManifest(ws, undefined, {});
    assert.ok(manifest['main.py']);
    assert.ok(!Object.keys(manifest).some(k => k.startsWith('.cargo')), 'a known dependency cache is skipped anywhere');
    assert.ok(Object.keys(manifest).some(k => k.startsWith('.hermes')), 'an unknown dotdir is kept in a normal project');
  } finally { if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome; }
});
