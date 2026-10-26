import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openOrCreateChatSession, createChatSession } from '../src/engine/host-commands.js';
import { getProvider } from '../src/engine/providers.js';
import { listRecords } from '../src/engine/database.js';
import { saveSession } from '../src/engine/store.js';

let directory, previous;
test.beforeEach(() => {
  previous = process.env.BZZY_HOME; directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-named-attach-')));
  process.env.BZZY_HOME = path.join(directory, 'private');
  fs.mkdirSync(path.join(directory, 'first')); fs.mkdirSync(path.join(directory, 'second'));
});
test.afterEach(() => {
  if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
  fs.rmSync(directory, { recursive: true, force: true });
});
const options = () => ({ cwd: path.join(directory, 'first'), provider: 'codex', model: 'offline-fixture', effort: 'low' });

test('attachment creates one idle named terminal and later resolves its alias, full ID and prefix without changing its saved context', async () => {
  const first = await openOrCreateChatSession('daily-review', options());
  assert.equal(first.created, true); assert.equal(first.session.alias, 'daily-review'); assert.equal(first.session.selectedEffort, 'low');
  assert.equal(first.session.cwd, options().cwd); assert.equal(first.session.goal, null); assert.equal(first.session.engineThreadId, null);
  first.session.goal = { id: 'old-goal', status: 'paused', objective: 'Retain the saved work', evidence: ['existing-evidence'] }; saveSession(first.session);
  for (const reference of ['daily-review', first.session.id, first.session.id.slice(0, 12)]) {
    const reused = await openOrCreateChatSession(reference, { cwd: path.join(directory, 'second'), provider: 'deepseek', model: 'different-model' });
    assert.equal(reused.created, false); assert.equal(reused.session.id, first.session.id);
    assert.equal(reused.session.cwd, options().cwd); assert.equal(reused.session.model, 'offline-fixture');
    assert.deepEqual(reused.session.goal, first.session.goal);
  }
  assert.equal(listRecords('session').length, 1); assert.equal(listRecords('execution').length, 0);
  assert.equal(fs.existsSync(path.join(directory, 'second', '.bzzy')), false);
});

test('ambiguous existing aliases and invalid names never become additional sessions', async () => {
  const provider = getProvider('codex'); createChatSession(provider, { ...options(), alias: 'same-name' });
  createChatSession(provider, { ...options(), alias: 'same-name' });
  await assert.rejects(openOrCreateChatSession('same-name', options()), { code: 'SESSION_AMBIGUOUS' });
  for (const name of ['', ' ', 'a'.repeat(81), 'unsafe\nname']) await assert.rejects(openOrCreateChatSession(name, options()));
  assert.equal(listRecords('session').length, 2); assert.equal(listRecords('execution').length, 0);
});

test('concurrent CLI processes create the same requested alias once', async () => {
  const moduleURL = new URL('../src/engine/host-commands.js', import.meta.url).href;
  const code = `const { openOrCreateChatSession } = await import(${JSON.stringify(moduleURL)});
    const result = await openOrCreateChatSession('concurrent-review', JSON.parse(process.argv[1]));
    process.stdout.write(JSON.stringify({ id: result.session.id, cwd: result.session.cwd, created: result.created }));`;
  const run = promisify(execFile);
  const replies = await Promise.all(['first', 'second'].map(folder => run(process.execPath,
    ['--input-type=module', '-e', code, JSON.stringify({ ...options(), cwd: path.join(directory, folder) })], { env: process.env, timeout: 15000 })));
  const results = replies.map(reply => JSON.parse(reply.stdout));
  assert.equal(results[0].id, results[1].id); assert.equal(results.filter(reply => reply.created).length, 1);
  assert.equal(results[0].cwd, results[1].cwd); assert.equal(listRecords('session').length, 1);
  assert.equal(listRecords('execution').length, 0);
});
