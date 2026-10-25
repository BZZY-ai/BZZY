import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { importTerminal } from '../src/share-ui.js';
import { putRecord } from '@bzzy/core/engine/database.js';

const code = 'BZZY-TERMINAL-' + 'A'.repeat(43), sender = 's'.repeat(43);
let directory, cwd, previous;
test.beforeEach(() => {
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-import-destination-')));
  cwd = path.join(directory, 'project'); fs.mkdirSync(cwd);
  previous = process.env.BZZY_HOME; process.env.BZZY_HOME = path.join(directory, 'private');
});
test.afterEach(() => {
  if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
  fs.rmSync(directory, { recursive: true, force: true });
});
function ui(answers) {
  const terminal = { interactive: true, sessionId: 'visible-session', input: { isTTY: true }, output: { isTTY: true },
    events: [], prompts: [], tui: { schedule() {} }, event(type, data) { this.events.push({ type, ...data }); },
    async ask(question, options) {
      this.prompts.push({ question, options });
      const answer = answers.shift(); return typeof answer === 'function' ? answer(question, options) : answer;
    } };
  return terminal;
}
const options = importer => ({ chooseDestination: true, relayLoader: async () => ({ importTerminalShare: importer }) });
function initialized() {
  fs.mkdirSync(path.join(cwd, '.bzzy')); fs.writeFileSync(path.join(cwd, '.bzzy', 'project.json'), '{"private":"keep-current-project"}');
  fs.writeFileSync(path.join(cwd, 'user.txt'), 'Keep existing user work.');
}

test('first in-chat import suggests a fresh folder beneath an initialized project and creates only after IMPORT', async () => {
  initialized(); let selected;
  const terminal = ui([(_question, config) => { selected = config.initialValue; assert.equal(fs.existsSync(selected), false); return selected; }, sender,
    () => { assert.equal(fs.existsSync(selected), false); return 'IMPORT'; }]);
  const result = await importTerminal(code, cwd, terminal, options(async input => {
    assert.match(input.cwd, /imported-session-/); assert.equal(fs.statSync(input.cwd).isDirectory(), true);
    fs.writeFileSync(path.join(input.cwd, 'received.txt'), 'Synthetic received project.');
    return { cwd: input.cwd, primarySession: { id: 'new-chat' } };
  }));
  assert.equal(result.cwd, selected); assert.equal(fs.readFileSync(path.join(cwd, 'user.txt'), 'utf8'), 'Keep existing user work.');
  assert.equal(JSON.parse(fs.readFileSync(path.join(cwd, '.bzzy/project.json'))).private, 'keep-current-project');
  assert.ok(!JSON.stringify(terminal.events).includes(code));
});

test('a journal-owned previous import stays the suggested destination for exact retry and missing-history merge', async () => {
  initialized(); const pin = fs.statSync(cwd);
  putRecord('project-import-source', 'fixture-source', { root: cwd, location: `${pin.dev}:${pin.ino}` });
  for (const result of [{ alreadyImported: true }, { added: { sessions: 1, events: 4, records: 6 }, preserved: 2 }]) {
    const terminal = ui([(_question, config) => { assert.equal(config.initialValue, cwd); return cwd; }, sender, 'IMPORT']);
    await importTerminal(code, cwd, terminal, options(async input => { assert.equal(input.cwd, cwd); return { cwd, ...result }; }));
    assert.match(terminal.events[0].message, result.alreadyImported ? /Already imported.*No duplicate history/ : /updated.*1 chats, 4 history events and 6 records.*local work was retained/);
    assert.doesNotMatch(terminal.events[0].message, /Execution remains paused/);
  }
  assert.equal(fs.readFileSync(path.join(cwd, 'user.txt'), 'utf8'), 'Keep existing user work.');
});

test('an explicit nonexistent nested folder is created after approval and an uninitialized cwd remains the default', async () => {
  const target = path.join(cwd, 'received', 'session');
  const terminal = ui([(_question, config) => { assert.equal(config.initialValue, cwd); return target; }, sender,
    () => { assert.equal(fs.existsSync(path.dirname(target)), false); return 'IMPORT'; }]);
  await importTerminal(code, cwd, terminal, options(async input => { assert.equal(input.cwd, target); return { cwd: target }; }));
  assert.equal(fs.statSync(target).isDirectory(), true);
});

test('cancellation and invalid destinations create no folders and never overwrite existing files or follow links', async () => {
  const cancelled = path.join(cwd, 'cancelled'); let calls = 0;
  await importTerminal(code, cwd, ui([cancelled, sender, null]), options(async () => { calls++; }));
  assert.equal(fs.existsSync(cancelled), false); assert.equal(calls, 0);
  const file = path.join(cwd, 'user.txt'); fs.writeFileSync(file, 'Original data.');
  const linked = path.join(cwd, 'linked'); fs.symlinkSync(directory, linked);
  for (const target of [file, linked, path.join(linked, 'new-folder')]) {
    await assert.rejects(importTerminal(code, cwd, ui([target]), options(async () => { calls++; })), /destination directory/);
  }
  assert.equal(calls, 0); assert.equal(fs.readFileSync(file, 'utf8'), 'Original data.');
  assert.equal(fs.existsSync(path.join(directory, 'new-folder')), false);
});

test('host or visible-session changes after a prompt or transport load fail before creating the destination', async () => {
  const originalHome = process.env.BZZY_HOME;
  for (const mutate of [terminal => { terminal.sessionId = 'another-session'; }, () => { process.env.BZZY_HOME = path.join(directory, 'another-private'); }]) {
    process.env.BZZY_HOME = originalHome;
    const target = path.join(cwd, 'never-created'), terminal = ui([target, sender, 'IMPORT']); let calls = 0;
    await assert.rejects(importTerminal(code, cwd, terminal, { chooseDestination: true, relayLoader: async () => {
      mutate(terminal); return { importTerminalShare: async () => { calls++; } };
    } }), /terminal, project or Core host changed/);
    assert.equal(calls, 0); assert.equal(fs.existsSync(target), false);
  }
  process.env.BZZY_HOME = originalHome;
});

test('failed imports remove only newly created empty directories and retain any data written meanwhile', async () => {
  for (const keepData of [false, true]) {
    const target = path.join(cwd, keepData ? 'keep-new-data' : 'remove-empty');
    await assert.rejects(importTerminal(code, cwd, ui([target, sender, 'IMPORT']), options(async () => {
      if (keepData) fs.writeFileSync(path.join(target, 'local.txt'), 'Keep this new local file.');
      throw Object.assign(new Error('Private transport failure ' + code), { code: 'IMPORT_CONFLICT' });
    })), error => !error.message.includes(code));
    assert.equal(fs.existsSync(target), keepData);
    if (keepData) assert.equal(fs.readFileSync(path.join(target, 'local.txt'), 'utf8'), 'Keep this new local file.');
  }
});

test('an active merge error asks to pause and does not change or remove the selected existing directory', async () => {
  fs.writeFileSync(path.join(cwd, 'user.txt'), 'Existing work.');
  await assert.rejects(importTerminal(code, cwd, ui([cwd, sender, 'IMPORT']), options(async () => {
    throw Object.assign(new Error('Active imported session.'), { code: 'IMPORT_ACTIVE' });
  })), /Pause the imported chat before merging newer history/);
  assert.equal(fs.readFileSync(path.join(cwd, 'user.txt'), 'utf8'), 'Existing work.');
});
