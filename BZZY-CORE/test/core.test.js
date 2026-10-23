import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BzzyCore, generationSecurityPolicy } from '../src/index.js';
import { events, appendEvent, listRecords, getRecord, putRecord } from '../src/engine/database.js';
import { loadSession } from '../src/engine/store.js';
import { normalizeContract } from '../src/engine/contracts.js';
import { assessCompletion } from '../src/engine/verification.js';

let directory, previousHome, workspace;
test.beforeEach(() => {
  previousHome = process.env.BZZY_HOME;
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-core-'));
  process.env.BZZY_HOME = path.join(directory, 'private');
  workspace = path.join(directory, 'project'); fs.mkdirSync(workspace);
});
test.afterEach(() => {
  if (previousHome === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previousHome;
  fs.rmSync(directory, { recursive: true, force: true });
});
const create = (core = new BzzyCore(), options = {}) => core.createConversation({ provider: 'codex', cwd: workspace, ...options }, { requestId: randomUUID() });

class LocalCore extends BzzyCore {
  async events(id, after, limit) {
    const items = events(id, after, limit);
    return { events: items, hasMore: items.length === limit };
  }
}

test('conversation creation uses the existing database and CLI session format without an execution', () => {
  const core = new BzzyCore(), session = create(core, { alias: 'Project', model: 'fixture-model', effort: 'high' });
  assert.equal(loadSession(session.id).alias, 'Project');
  assert.equal(session.cwd, fs.realpathSync(workspace));
  assert.equal(session.backend, 'codex'); assert.equal(session.selectedEffort, 'high');
  assert.equal(session.goal, null); assert.equal(session.executionState, 'idle');
  assert.equal(listRecords('execution').length, 0);
  const compatibility = JSON.parse(fs.readFileSync(path.join(process.env.BZZY_HOME, 'sessions', `${session.id}.json`)));
  assert.deepEqual(compatibility, session);
  assert.deepEqual(events(session.id).map(event => event.type), ['lifecycle', 'session.created']);
});

test('concurrent retries create one conversation; input conflicts fail; replay preserves later state', async () => {
  const core = new BzzyCore(), input = { provider: 'codex', cwd: workspace }, requestId = randomUUID();
  const [first, second] = await Promise.all([Promise.resolve().then(() => core.createConversation(input, { requestId })), Promise.resolve().then(() => core.createConversation(input, { requestId }))]);
  assert.equal(first.id, second.id); assert.equal(listRecords('session').length, 1);
  assert.throws(() => core.createConversation({ ...input, alias: 'Changed' }, { requestId }), { code: 'CONFLICT' });
  putRecord('session', first.id, { ...first, turns: 7, executionState: 'paused' });
  const replay = core.createConversation(input, { requestId });
  assert.equal(replay.turns, 7); assert.equal(replay.executionState, 'paused');
  assert.equal(events(first.id).filter(event => event.type === 'session.created').length, 1);
});

test('conversation input cannot inject account bindings, credentials, policies or environment', () => {
  const core = new BzzyCore();
  for (const key of ['apiKey', 'environment', 'bindingId', 'policy', 'permissions', 'parentSessionId']) {
    assert.throws(() => create(core, { [key]: 'synthetic-private-value' }), { code: 'INVALID_REQUEST' });
  }
  assert.throws(() => core.createConversation({ provider: 'codex', cwd: workspace }), /request ID/);
  assert.throws(() => create(core, { cwd: 'relative' }), { code: 'INVALID_REQUEST' });
  fs.mkdirSync(process.env.BZZY_HOME);
  assert.throws(() => create(core, { cwd: process.env.BZZY_HOME }), { code: 'FORBIDDEN' });
  assert.equal(listRecords('session').length, 0);
});

test('a host object cannot follow a changed BZZY_HOME into another private identity', () => {
  const core = new BzzyCore();
  process.env.BZZY_HOME = path.join(directory, 'other-private');
  assert.throws(() => create(core), { code: 'HOST_CONTEXT_CHANGED' });
});

test('processed event cursors survive a new Core instance and stay separate for each session', async () => {
  const core = new LocalCore(), first = create(core), second = create(core);
  const a = appendEvent(first.id, 'future.unknown', { value: 1 });
  const b = appendEvent(second.id, 'text', { text: 'Other session' });
  const seen = [];
  await core.processEvents(first.id, { consumerId: 'ios-device', handle: event => seen.push(event.id) });
  assert.ok(seen.includes(a.id));
  const restarted = new LocalCore();
  assert.equal(restarted.processedCursor('ios-device', first.id), a.seq);
  assert.equal(restarted.processedCursor('ios-device', second.id), 0);
  await restarted.processEvents(second.id, { consumerId: 'ios-device', handle: event => seen.push(event.id) });
  assert.equal(restarted.processedCursor('ios-device', second.id), b.seq);
  assert.equal((await restarted.processEvents(first.id, { consumerId: 'ios-device', handle: () => assert.fail('Already processed') })).processed, 0);
});

test('a failed event handler never acknowledges the failed event', async () => {
  const core = new LocalCore(), session = create(core), all = events(session.id);
  await assert.rejects(core.processEvents(session.id, { consumerId: 'viewer', handle: event => { if (event.seq === all[1].seq) throw new Error('Consumer storage unavailable'); } }), /Consumer storage/);
  assert.equal(core.processedCursor('viewer', session.id), all[0].seq);
  const replay = [];
  await core.processEvents(session.id, { consumerId: 'viewer', handle: event => replay.push(event.id) });
  assert.deepEqual(replay, [all[1].id]);
});

test('abort before handling keeps the replay cursor unchanged', async () => {
  const core = new LocalCore(), session = create(core);
  const result = await core.processEvents(session.id, { consumerId: 'viewer', signal: AbortSignal.abort(), handle: () => assert.fail() });
  assert.equal(result.processed, 0); assert.equal(result.nextCursor, 0); assert.equal(result.hasMore, true);
});

test('two processors cannot silently overwrite the same processed cursor', async () => {
  const core = new LocalCore(), session = create(core);
  await assert.rejects(core.processEvents(session.id, { consumerId: 'viewer', handle: () => {
    putRecord('core.cursor', `viewer:${session.id}`, { seq: 999 });
  } }), { code: 'CURSOR_CONFLICT' });
});

test('a failed explicit acceptance requirement cannot become a verified success', async () => {
  const session = create();
  session.contract = normalizeContract({ acceptanceCriteria: [{ id: 'proof', description: 'Inspect evidence supporting the objective' }] }, 'Demonstrate the objective');
  session.goal = { id: randomUUID(), status: 'verifying', objective: 'Demonstrate the objective', createdAt: new Date().toISOString() };
  const result = await assessCompletion(session);
  assert.equal(result.passed, false);
  assert.equal(result.requirements[0].passed, false);
  assert.match(result.level, /evidence/);
  assert.equal(getRecord('acceptance', result.id).passed, false);
});

test('generation policy is exactly the reusable SECURITY.md preprompt', () => {
  const security = fs.readFileSync(new URL('../../SECURITY.md', import.meta.url), 'utf8');
  const excerpt = security.split('"Build reusable behavior')[1].split('"')[0];
  assert.equal(generationSecurityPolicy, `Build reusable behavior${excerpt}`);
});
