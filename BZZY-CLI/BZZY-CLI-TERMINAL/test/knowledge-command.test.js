import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readKnowledgeDefinition, knowledgeCLI, sessionMemoryCLI, sessionCostCLI } from '../src/knowledge-command.js';
import { runtimeInfo } from '../src/runtime.js';
import { listRecords, putRecord, events } from '../src/database.js';
import { createSession } from '../src/store.js';
import { BUILTINS } from '../src/providers.js';

let directory, prior;
test.beforeEach(() => { directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-knowledge-cli-'))); prior = process.env.BZZY_HOME; process.env.BZZY_HOME = path.join(directory, 'private'); });
test.afterEach(() => { if (prior === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = prior; fs.rmSync(directory, { recursive: true, force: true }); });

test('knowledge definitions reject linked, oversized and malformed private inputs without echoing their body', () => {
  const valid = path.join(directory, 'review.json'); fs.writeFileSync(valid, '{"target":"user","reviewed":true}');
  assert.equal(readKnowledgeDefinition(valid, directory).reviewed, true);
  fs.symlinkSync(valid, path.join(directory, 'linked.json')); assert.throws(() => readKnowledgeDefinition('linked.json', directory));
  fs.linkSync(valid, path.join(directory, 'hardlink.json')); assert.throws(() => readKnowledgeDefinition(valid, directory), /unlinked/);
  fs.writeFileSync(path.join(directory, 'large.json'), ' '.repeat(1024 * 1024 + 1)); assert.throws(() => readKnowledgeDefinition('large.json', directory), /1 MiB/);
  fs.writeFileSync(path.join(directory, 'broken.json'), '{"password":"fixture-private-value" invalid}');
  assert.throws(() => readKnowledgeDefinition('broken.json', directory), error => /valid UTF-8 JSON/.test(error.message) && !error.message.includes('fixture-private-value'));
});

test('local knowledge search/status remains read-only without activating Core, models or a project marker', async () => {
  const messages = [], ui = { event: (_type, value) => messages.push(value) };
  assert.equal(await knowledgeCLI(['status'], { cwd: directory }, ui), 0);
  assert.equal(await knowledgeCLI(['search', 'offline', 'history'], { cwd: directory }, ui), 0);
  assert.equal(messages[1].result.items.length, 0); assert.ok(messages[0].result.project.id);
  assert.equal(runtimeInfo(), null); assert.equal(fs.existsSync(path.join(directory, '.bzzy')), false);
  assert.equal(listRecords('core.learning.job').length, 0); assert.equal(listRecords('execution').length, 0);
});

test('compactor cost reads existing chat history without starting Core or replaying missing attempts', async () => {
  const source = createSession(BUILTINS.deepseek, directory, 'deepseek-flash', 'Long session');
  putRecord('core.session.compactor.job', 'old-job', { id: 'old-job', sessionId: source.id, state: 'paused', attempts: 3,
    totalTokensUsed: 60000, selection: { provider: 'deepseek', model: 'deepseek-flash' } });
  const before = events(source.id), messages = [];
  assert.equal(await sessionMemoryCLI(['cost', source.id], { cwd: directory }, { event: (_type, value) => messages.push(value) }), 0);
  assert.equal(messages[0].result.sessionId, source.id); assert.equal(messages[0].result.legacyAttempts, 3);
  assert.equal(messages[0].result.estimatedUsd, null); assert.equal(runtimeInfo(), null);
  assert.deepEqual(events(source.id), before); assert.equal(listRecords('execution').length, 0);
  assert.equal(listRecords('core.session.compactor.cost').length, 0);
  assert.equal(await sessionCostCLI([source.id], { cwd: directory }, { event: (_type, value) => messages.push(value) }), 0);
  assert.equal(messages[1].result.compactor.legacyAttempts, 3); assert.equal(messages[1].result.total.complete, false);
  assert.equal(runtimeInfo(), null); assert.deepEqual(events(source.id), before);
});
