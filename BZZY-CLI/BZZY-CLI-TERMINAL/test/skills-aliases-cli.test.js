import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createSkill } from '@bzzy/core/engine/skills.js';
import { home, readJson, writeJson } from '../src/files.js';
import { listRecords } from '../src/database.js';
import { runtimeInfo, persistOperatorStopIntent, operatorStopRequested } from '../src/runtime.js';
import { skillsAliasesCLI } from '../src/skills-aliases-cli.js';

let previous, directory, cwd;
const aliases = [1, 2, 3, 4].map(index => `reader+${index}@fixture.invalid`);
test.beforeEach(() => {
  previous = process.env.BZZY_HOME;
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-alias-cli-')));
  process.env.BZZY_HOME = path.join(directory, 'private'); cwd = path.join(directory, 'project'); fs.mkdirSync(cwd);
  createSkill({ name: 'mail-reader', description: 'Read approved mail.', instructions: 'Use the locally configured approved signup aliases.' }, { scope: 'global' });
  writeJson(path.join(home(), 'config.json'), { version: 1, unrelated: { value: 'keep-this-owner-choice' } });
});
test.afterEach(() => {
  if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
  fs.rmSync(directory, { recursive: true, force: true });
});

test('alias commands store the exact explicit list, show it only on request and preserve unrelated settings', () => {
  const events = [], ui = { event: (_type, value) => events.push(value) };
  assert.equal(skillsAliasesCLI(['set', 'mail-reader', aliases.join(';')], { cwd }, ui), 0);
  assert.equal(events[0].aliasCount, 4); assert.ok(!JSON.stringify(events[0]).includes(aliases[0]));
  assert.equal(skillsAliasesCLI(['show', 'mail-reader'], { cwd }, ui), 0);
  assert.deepEqual(events[1].approvedSignupAliases, aliases); assert.ok(events[1].message.includes(aliases.join('\n')));
  assert.deepEqual(readJson(path.join(home(), 'config.json')).unrelated, { value: 'keep-this-owner-choice' });
  skillsAliasesCLI(['set', 'mail-reader', aliases[1]], { cwd }, ui);
  skillsAliasesCLI(['clear', 'mail-reader'], { cwd }, ui);
  skillsAliasesCLI(['show', 'mail-reader'], { cwd }, ui);
  assert.deepEqual(events.at(-1).approvedSignupAliases, []);
  assert.equal(listRecords('execution').length, 0); assert.equal(listRecords('session').length, 0);
});

test('bad alias commands and malformed addresses cannot change the saved list', () => {
  const ui = { event() {} };
  skillsAliasesCLI(['set', 'mail-reader', ...aliases], { cwd }, ui);
  const before = fs.readFileSync(path.join(home(), 'config.json'), 'utf8');
  for (const args of [[], ['set', 'mail-reader'], ['show', 'mail-reader', 'extra'], ['clear', 'mail-reader', 'extra'],
    ['set', 'mail-reader', 'not-an-address'], ['set', 'mail-reader', aliases[0], aliases[0]]]) {
    assert.throws(() => skillsAliasesCLI(args, { cwd }, ui));
    assert.equal(fs.readFileSync(path.join(home(), 'config.json'), 'utf8'), before);
  }
});

test('the actual CLI configures aliases without starting stopped Core, a chat or model work', () => {
  persistOperatorStopIntent();
  const binary = fileURLToPath(new URL('../bin/bzzy.js', import.meta.url));
  const run = args => spawnSync(process.execPath, [binary, 'skills', 'aliases', ...args, '--json'], { cwd, env: process.env, encoding: 'utf8', timeout: 15000 });
  const saved = run(['set', 'mail-reader', aliases.join(';')]); assert.equal(saved.status, 0, saved.stderr);
  assert.ok(!saved.stdout.includes(aliases[0]));
  const shown = run(['show', 'mail-reader']); assert.equal(shown.status, 0, shown.stderr);
  const result = shown.stdout.trim().split('\n').map(JSON.parse).find(event => event.approvedSignupAliases);
  assert.deepEqual(result.approvedSignupAliases, aliases);
  assert.equal(runtimeInfo(), null); assert.equal(operatorStopRequested(), true);
  assert.equal(listRecords('session').length, 0); assert.equal(listRecords('execution').length, 0);
});
