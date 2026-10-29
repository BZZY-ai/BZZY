import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSession, saveSession } from '../src/engine/store.js';
import { BUILTINS } from '../src/engine/providers.js';
import { database, getRecord, listRecords, putRecord } from '../src/engine/database.js';
import { initializeProject, issue } from '../src/engine/project.js';
import { artifact } from '../src/engine/evidence.js';
import { checkpoint, remember } from '../src/engine/memory.js';
import { compactTaskState, contextFor, readTaskStateDetails } from '../src/engine/recovery.js';
import { conversationPrompt } from '../src/engine/conversation.js';
import { ToolHost } from '../src/engine/tools.js';
import { refreshKnowledgeRecords } from '../src/engine/knowledge-index.js';

let directory, previousHome, alpha, beta, session, source;
function saved(cwd, extra = {}) {
  const value = { ...createSession(BUILTINS.codex, cwd, 'offline-fixture'), ...extra };
  initializeProject(value); saveSession(value); return value;
}
function newGoal(target = session) {
  target.goal = { id: randomUUID(), objective: 'Find a new unreported stored XSS in the fictional Orbit bulletin updates panel.', status: 'active' };
  target.contract = { objective: target.goal.objective, constraints: ['Use only offline fictional fixtures.'] };
  saveSession(target);
}
// Entirely fictional regression data: no engagement records or private exports.
function reportedPair() {
  const evidence = artifact(source, 'Offline report package fixture', 'Fictional issue report; no live target or vulnerability verification.');
  const reported = issue(source, { title: 'Orbit bulletin updates stored XSS report', status: 'resolved', evidence: [evidence.id],
    details: 'Already reported in the fictional prior engagement; do not count this claim as a new finding.',
    resolution: 'A report package was saved. Independent verification remains inconclusive.' });
  const blocked = issue(source, { title: 'Orbit bulletin updates stored XSS verification', status: 'blocked',
    details: 'Specialist verification is blocked pending an authorized offline fixture.' });
  return { reported, blocked };
}
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const briefIds = state => state.knowledgeBrief.items.map(item => item.sourceId);

test.beforeEach(() => {
  previousHome = process.env.BZZY_HOME;
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-task-knowledge-')));
  process.env.BZZY_HOME = path.join(directory, 'private');
  alpha = path.join(directory, 'alpha'); beta = path.join(directory, 'beta');
  fs.mkdirSync(alpha); fs.mkdirSync(beta);
  source = saved(alpha); session = saved(alpha); newGoal();
});
test.afterEach(() => {
  if (previousHome === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previousHome;
  fs.rmSync(directory, { recursive: true, force: true });
});

test('task knowledge retains separate reported and blocked issue claims without promoting their truth', () => {
  const { reported, blocked } = reportedPair();
  const state = compactTaskState(session), brief = state.knowledgeBrief;
  assert.deepEqual(new Set(briefIds(state)), new Set([reported.id, blocked.id]));
  for (const original of [reported, blocked]) {
    const hit = brief.items.find(item => item.sourceId === original.id);
    assert.equal(hit.kind, 'issue'); assert.equal(hit.status, original.status);
    assert.equal(hit.truth, 'inconclusive'); assert.equal(hit.revision, original.revision);
    assert.equal(hit.historical, true); assert.match(hit.statement, /Orbit|stored XSS/i);
  }
  assert.match(brief.authority, /historical|permission|completion/i);
  assert.equal(brief.detail, 'knowledgeBrief');
  assert.ok(bytes(brief) <= 2200); assert.ok(bytes(state) <= 8192);
  assert.equal(getRecord('session', session.id).goal.status, 'active');
  assert.equal(listRecords('memory').length, 0, 'navigation must not manufacture memory records');
});

test('a continuing native goal can pull the brief after compaction without replaying work', async () => {
  const { reported, blocked } = reportedPair();
  session.nativeContext = { threadRef: 'fictional-thread', epoch: 1 }; saveSession(session);
  const host = new ToolHost(session, { event() {} }, { goalMode: true });
  const first = await host.call('get_task_state', {});
  session.nativeContext.epoch = 2; saveSession(session);
  const before = listRecords('execution').length;
  const after = await host.call('get_task_state', { knownRevision: first.revision, contextGeneration: first.contextGeneration });
  assert.equal(after.notModified, false); assert.notEqual(after.contextGeneration, first.contextGeneration);
  assert.ok(briefIds(after).includes(reported.id)); assert.ok(briefIds(after).includes(blocked.id));
  assert.equal(listRecords('execution').length, before);
  assert.equal(getRecord('session', session.id).goal.id, session.goal.id);
  assert.equal(getRecord('session', session.id).goal.status, 'active');
});

test('a fresh goal receives prior issue navigation in compact prompts but never adopts old completion', () => {
  const { reported, blocked } = reportedPair();
  const old = checkpoint(session, { completedWork: ['OLD_GOAL_COMPLETION_CLAIM'], decisions: ['Old goal conclusion only.'] });
  const previousGoal = session.goal.id; newGoal();
  assert.notEqual(session.goal.id, previousGoal);
  const state = compactTaskState(session);
  assert.equal(state.checkpoint, null); assert.equal(state.historicalCheckpoint.revision, old.revision);
  assert.equal(state.historicalCheckpoint.reason, 'different-execution-scope');
  assert.ok(briefIds(state).includes(reported.id)); assert.ok(briefIds(state).includes(blocked.id));
  const execution = JSON.parse(contextFor(session, { compactDerived: true }));
  assert.equal(execution.currentState.checkpoint, null);
  assert.ok(briefIds(execution.currentState).includes(reported.id));
  const request = 'Continue the new offline-only objective.';
  const prompt = conversationPrompt(session, request, { compactDerived: true });
  assert.match(prompt, /BZZY CURRENT STATE CAPSULE/); assert.ok(prompt.includes(reported.id)); assert.ok(prompt.includes(blocked.id));
  assert.ok(prompt.includes(session.goal.id)); assert.ok(prompt.includes(request));
  assert.equal(getRecord('session', session.id).goal.status, 'active');
});

test('knowledge caching changes with source revisions and context generations, not repeated reads', () => {
  const { blocked } = reportedPair();
  session.nativeContext = { threadRef: 'fictional-thread', epoch: 1 }; saveSession(session);
  const initial = compactTaskState(session);
  const cached = { knownRevision: initial.revision, contextGeneration: initial.contextGeneration };
  assert.equal(compactTaskState(session, cached).notModified, true);
  const updated = issue(source, { id: blocked.id, title: blocked.title, status: 'investigating', expectedRevision: blocked.revision,
    details: 'Orbit stored XSS offline fixture is now available for review.' });
  const changed = compactTaskState(session, cached);
  assert.equal(changed.notModified, false); assert.notEqual(changed.revision, initial.revision);
  assert.equal(changed.knowledgeBrief.items.find(item => item.sourceId === blocked.id).revision, updated.revision);
  assert.equal(changed.knowledgeBrief.items.find(item => item.sourceId === blocked.id).status, 'investigating');
  assert.equal(compactTaskState(session, { knownRevision: changed.revision, contextGeneration: changed.contextGeneration }).notModified, true);
  session.nativeContext.epoch++; saveSession(session);
  assert.equal(compactTaskState(session, { knownRevision: changed.revision, contextGeneration: changed.contextGeneration }).notModified, false);
});

test('evidence drift and time expiry invalidate a cached brief without another source write', t => {
  const proof = artifact(source, 'Orbit offline evidence fixture', 'Original bytes');
  const originalBytes = fs.readFileSync(getRecord('artifact', proof.id).path);
  const expiresAt = Date.now() + 60000;
  const memory = remember(source, { kind: 'hypothesis', statement: 'Orbit stored XSS requires fresh offline evidence.',
    evidence: [proof.id], freshness: { expiresAt: new Date(expiresAt).toISOString() } });
  const first = compactTaskState(session), cached = { knownRevision: first.revision, contextGeneration: first.contextGeneration };
  assert.equal(first.knowledgeBrief.items.find(item => item.sourceId === memory.id).stale, false);
  assert.equal(compactTaskState(session, cached).notModified, true);
  fs.writeFileSync(getRecord('artifact', proof.id).path, 'Changed offline evidence bytes');
  const drift = compactTaskState(session, cached);
  assert.equal(drift.notModified, false);
  assert.equal(drift.knowledgeBrief.items.find(item => item.sourceId === memory.id).truth, 'stale');
  assert.equal(getRecord('memory', memory.id).revision, memory.revision);
  fs.writeFileSync(getRecord('artifact', proof.id).path, originalBytes);
  const restored = compactTaskState(session);
  assert.equal(restored.knowledgeBrief.items.find(item => item.sourceId === memory.id).stale, false);
  t.mock.method(Date, 'now', () => expiresAt + 1);
  const expired = compactTaskState(session, { knownRevision: restored.revision, contextGeneration: restored.contextGeneration });
  assert.equal(expired.notModified, false);
  assert.equal(expired.knowledgeBrief.items.find(item => item.sourceId === memory.id).truth, 'stale');
});

test('project and worker scope prevent unrelated knowledge from entering the brief', () => {
  const { reported } = reportedPair();
  const foreign = saved(beta); newGoal(foreign);
  issue(foreign, { title: 'Orbit stored XSS FOREIGN_PROJECT_ONLY', details: 'Private fictional foreign source.' });
  assert.doesNotMatch(JSON.stringify(compactTaskState(session).knowledgeBrief), /FOREIGN_PROJECT_ONLY/);
  assert.equal(briefIds(compactTaskState(foreign)).includes(reported.id), false);
  const worker = saved(alpha, { role: 'executor', parentSessionId: session.id }); newGoal(worker);
  issue(worker, { title: 'Orbit stored XSS WORKER_OWN_HISTORY', details: 'Fictional worker-local history.' });
  const restricted = compactTaskState(worker);
  assert.deepEqual(restricted.knowledgeBrief.items, []);
  assert.doesNotMatch(JSON.stringify(restricted.knowledgeBrief), /WORKER_OWN_HISTORY|Orbit bulletin/);
  assert.deepEqual(compactTaskState(session, {}, { goalMode: false }).knowledgeBrief.items, []);
  session.goal.status = 'paused'; saveSession(session);
  assert.deepEqual(compactTaskState(session).knowledgeBrief.items, []);
});

test('brief and paged originals sanitize historical text and invalidate deleted source sessions', () => {
  const { blocked } = reportedPair();
  const stored = getRecord('issue', blocked.id);
  // Simulate an older/imported untrusted record that predates write validation.
  putRecord('issue', blocked.id, { ...stored, details: 'Orbit stored XSS legacy note password="FICTIONAL_PRIVATE_VALUE"', revision: stored.revision + 1 });
  const state = compactTaskState(session);
  assert.ok(briefIds(state).includes(blocked.id));
  assert.doesNotMatch(JSON.stringify(state.knowledgeBrief), /FICTIONAL_PRIVATE_VALUE/);
  let offset = 0, sourceRevision, text = '';
  do {
    const page = readTaskStateDetails(session, { section: 'knowledgeBrief', revision: state.revision, offset, limit: 257,
      ...(sourceRevision ? { sourceRevision } : {}) });
    assert.ok(Buffer.byteLength(page.text) <= 257); text += page.text; sourceRevision = page.sourceRevision; offset = page.nextOffset;
  } while (offset != null);
  assert.ok(text.includes(blocked.id)); assert.doesNotMatch(text, /FICTIONAL_PRIVATE_VALUE/);
  putRecord('session-deletion', source.id, { sessionId: source.id });
  const deleted = compactTaskState(session, { knownRevision: state.revision, contextGeneration: state.contextGeneration });
  assert.equal(deleted.notModified, false); assert.deepEqual(deleted.knowledgeBrief.items, []);
  assert.throws(() => readTaskStateDetails(session, { section: 'knowledgeBrief', revision: state.revision }), /changed/i);
});

test('many long matching records retain strict byte bounds and disclose omitted items', () => {
  for (let index = 0; index < 18; index++) issue(source, {
    title: `Orbit stored XSS fictional candidate ${index}`, status: 'blocked',
    details: 'Fictional unresolved historical claim Ω🙂. '.repeat(110),
  });
  const state = compactTaskState(session);
  assert.ok(state.knowledgeBrief.items.length > 0);
  assert.ok(state.knowledgeBrief.omitted > 0);
  assert.ok(bytes(state.knowledgeBrief) <= 2200);
  assert.ok(bytes(state) <= 8192);
});

test('legacy typed fields and malformed source pins cannot leak metadata or break task recovery', () => {
  const original = issue(source, { title: 'Orbit stored XSS legacy typed fields' });
  const secret = 'FICTIONAL_TYPED_PRIVATE_VALUE';
  putRecord('issue', original.id, { ...original, status: `password="${secret}"`,
    truth: { authorization: secret }, revision: { api_key: secret } });
  const memoryId = randomUUID();
  putRecord('memory', memoryId, { id: memoryId, project: alpha, projectId: session.projectId, sessionId: source.id,
    kind: `password="${secret}"`, truth: `password="${secret}"`, revision: 1,
    statement: 'Orbit stored XSS prior memory claim', evidence: [], inputs: [] });
  const wrongPin = randomUUID();
  putRecord('issue', wrongPin, { ...original, id: randomUUID() });
  const malformedId = randomUUID();
  putRecord('issue', malformedId, { ...original, id: malformedId, inputs: 'invalid legacy inputs' });
  let migrated;
  for(let round=0;round<16;round++) { migrated=refreshKnowledgeRecords(session);if(!migrated.remaining)break; }
  assert.equal(migrated.remaining,false);
  const state = compactTaskState(session);
  assert.doesNotMatch(JSON.stringify(state.knowledgeBrief), new RegExp(secret));
  const issueHit = state.knowledgeBrief.items.find(item => item.sourceId === original.id);
  assert.equal(issueHit.status, 'inconclusive'); assert.equal(issueHit.truth, 'inconclusive'); assert.equal(issueHit.revision, null);
  const memoryHit = state.knowledgeBrief.items.find(item => item.sourceId === memoryId);
  assert.equal(memoryHit.recordKind, 'inconclusive'); assert.equal(memoryHit.truth, 'inconclusive');
  assert.equal(briefIds(state).includes(wrongPin), false); assert.equal(briefIds(state).includes(malformedId), false);
});

test('malformed legacy text objects cannot break the task-state pull path', () => {
  const original = issue(source, { title: 'Orbit stored XSS historical record', details: 'Orbit stored XSS remains inconclusive.' });
  putRecord('issue', original.id, { ...original, title: { toString: null, valueOf: null } });
  const state = compactTaskState(session);
  assert.equal(state.knowledgeBrief.items.find(item => item.sourceId === original.id).statement, original.details);
  assert.equal(state.knowledgeBrief.items.find(item => item.sourceId === original.id).truth, 'inconclusive');
});

test('oversized legacy source and index payloads are omitted before hydration without altering originals', t => {
  const original=issue(source,{title:'Orbit stored XSS oversized legacy source'});
  const record={...original,details:'Orbit stored XSS '+ 'x'.repeat(256*1024)};
  putRecord('issue',original.id,record);
  const stored=JSON.stringify(record),indexed=JSON.stringify({legacyPadding:'y'.repeat(512*1024)});
  database().prepare('UPDATE knowledge_documents SET payload=? WHERE source_id=?').run(indexed,original.id);
  const parse=JSON.parse;
  const spy=t.mock.method(JSON,'parse',function(value,...args) {
    assert.ok(typeof value!=='string' || Buffer.byteLength(value)<=128*1024,'Polling must not hydrate oversized source or index JSON.');
    return Reflect.apply(parse,this,[value,...args]);
  });
  let state;
  try { state=compactTaskState(session); } finally { spy.mock.restore(); }
  assert.equal(briefIds(state).includes(original.id),false);assert.ok(state.knowledgeBrief.omitted>=1);
  assert.equal(state.knowledgeBrief.coverage.maximumSourceBytes,128*1024);
  assert.ok(bytes(state.knowledgeBrief)<=2200);assert.ok(bytes(state)<=8192);
  assert.equal(database().prepare("SELECT data FROM records WHERE kind='issue' AND id=?").get(original.id).data,stored);
  assert.equal(database().prepare('SELECT payload FROM knowledge_documents WHERE source_id=?').get(original.id).payload,indexed);
});

test('legacy nested session discovery and repeated task reads do not mutate durable state', () => {
  const nested = path.join(alpha, 'legacy-nested'); fs.mkdirSync(nested);
  const legacy = createSession(BUILTINS.codex, nested, 'offline-fixture');
  assert.equal(legacy.projectId, undefined); assert.equal(legacy.projectRoot, undefined);
  const original = issue(source, { title: 'Orbit stored XSS legacy nested source' });
  putRecord('issue', original.id, { ...original, sessionId: legacy.id });
  refreshKnowledgeRecords(session);
  const identity = getRecord('core.project.identity', session.projectId);
  putRecord('core.project.identity', session.projectId, { ...identity, updatedAt: '2000-01-01T00:00:00.000Z' });
  const records = () => database().prepare('SELECT kind,id,data,updated_at FROM records ORDER BY kind,id').all();
  const before = records();
  const first = compactTaskState(session);
  assert.ok(briefIds(first).includes(original.id), 'Legacy sessions remain discoverable within their verified project.');
  assert.equal(compactTaskState(session, { knownRevision: first.revision, contextGeneration: first.contextGeneration }).notModified, true);
  assert.deepEqual(records(), before, 'Polling must not rewrite project identities, indexes, cursors or runtime records.');
});
