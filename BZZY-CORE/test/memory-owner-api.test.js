import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CoreKnowledge } from '../src/knowledge.js';
import { createSession, saveSession } from '../src/engine/store.js';
import { getProvider } from '../src/engine/providers.js';
import { initializeProject } from '../src/engine/project.js';
import { appendEvent, listRecords } from '../src/engine/database.js';
import { remember } from '../src/engine/memory.js';
import { conversationPrompt } from '../src/engine/conversation.js';
import { taskTools, ToolHost } from '../src/engine/tools.js';

let root, prior, session, api;
test.beforeEach(() => {
  prior = process.env.BZZY_HOME; root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-memory-owner-')));
  process.env.BZZY_HOME = path.join(root, 'private');
  const cwd = path.join(root, 'project'); fs.mkdirSync(cwd);
  session = createSession(getProvider('codex'), cwd, 'offline'); initializeProject(session); saveSession(session); api = new CoreKnowledge();
});
test.afterEach(() => { if (prior === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = prior; fs.rmSync(root, { recursive: true, force: true }); });
const request = (operation, input = {}) => api.request(operation, { sessionId: session.id, ...input });

test('owner can inspect pinned packets while source expansion keeps its exact hash and scope', async () => {
  appendEvent(session.id, 'message.user', { text: 'Owner API fixture context for preserving a durable result.' });
  const job = request('learning.queue', { requestId: 'review-once' }), packet = request('learning.packet', { id: job.id });
  assert.equal(packet.id, job.packetId); assert.equal(packet.selection.model, 'offline');
  session.model = 'changed'; saveSession(session);
  assert.deepEqual(request('learning.packet', { id: job.id }), packet);
  const event = appendEvent(session.id, 'message.user', { text: 'A source expansion marker SOURCE_API_123.' });
  const hit = request('search', { query: 'SOURCE_API_123', types: ['chat'] }).items.find(item => item.sourceId === event.id);
  assert.ok(hit); assert.match(request('source.read', { sourceId: hit.sourceId, sha256: hit.sha256 }).text, /SOURCE_API_123/);
  assert.throws(() => request('source.read', { sourceId: hit.sourceId, sha256: '0'.repeat(64) }), /changed/);
  assert.throws(() => request('learning.packet', { id: job.id, execute: true }), /fields/);
  assert.equal(listRecords('execution').length, 0);
});

test('owner fact projection appears even when request keyword recall has no match, with current CAS', () => {
  const memory = remember(session, { kind: 'hypothesis', statement: 'Pinned fact fixture uses a source-linked record.' });
  const original = request('facts.read');
  assert.throws(() => request('facts.configure', { settings: { ids: [memory.id] }, expectedRevision: original.revision }), /Review/);
  const selected = request('facts.configure', { settings: { ids: [memory.id] }, expectedRevision: original.revision, reviewed: true });
  assert.equal(selected.items[0].id, memory.id);
  assert.match(conversationPrompt(session, 'ZZZ_UNRELATED_QUERY'), /Pinned fact fixture/);
  assert.throws(() => request('facts.configure', { settings: { enabled: false }, expectedRevision: original.revision, reviewed: true }), /changed/);
  request('facts.configure', { settings: { enabled: false }, expectedRevision: selected.revision, reviewed: true });
  assert.doesNotMatch(conversationPrompt(session, 'ZZZ_UNRELATED_QUERY'), /Pinned fact fixture/);
});

test('new diagnostics are read-only and models receive scoped tools without owner administration', async () => {
  const status = request('status'); assert.equal(status.evolution.newSkills, 'stage'); assert.equal(status.evolution.updates, 'stage');
  assert.equal(request('retrieval.status').settings.localEmbeddingsEnabled, false);
  assert.deepEqual(request('skill.curation.suggest').suggestions, []);
  assert.equal(request('episode.status').episodeId, null);
  const names = taskTools(session, { goalMode: false }).map(item => item.name);
  for (const name of ['read_knowledge_source', 'skill_feedback', 'lookup_resolutions']) assert.ok(names.includes(name));
  assert.ok(!names.some(name => /curation|evolution|configure|learning\.packet/.test(name)));
  const host = new ToolHost(session, { event() {} }, { goalMode: false });
  await assert.rejects(host.call('skill_feedback', { usageId: 'bad', requestId: 'bad', kind: 'helpful', rationale: 'password="PRIVATE_RAW_FEEDBACK"' }), /feedback/);
  const coordination = (await import('../src/engine/database.js')).database().prepare("SELECT data FROM events WHERE session_id=? AND type='coordination.tool'").all(session.id);
  assert.doesNotMatch(JSON.stringify(coordination), /PRIVATE_RAW_FEEDBACK/);
  assert.equal(listRecords('core.learning.job').length, 0); assert.equal(listRecords('execution').length, 0);
});
