import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { UI } from '../src/ui.js';
import { updateCommand } from '../src/update-checker.js';
import { readUpdateHandoff, writeUpdateHandoff } from '../src/update-handoff.js';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-update-handoff-'));
  const saved = Object.fromEntries(['BZZY_HOME', 'BZZY_LAUNCHER_BIN_DIR'].map(key => [key, process.env[key]]));
  process.env.BZZY_HOME = path.join(directory, 'private'); process.env.BZZY_LAUNCHER_BIN_DIR = path.join(directory, 'bin');
  fs.mkdirSync(process.env.BZZY_LAUNCHER_BIN_DIR);
  const launcher = path.join(process.env.BZZY_LAUNCHER_BIN_DIR, 'bzzy');
  fs.writeFileSync(launcher, '#!/bin/sh\n# bzzy-managed launcher\nexec "$BZZY_TEST_NODE" "$BZZY_TEST_RELOAD_ENTRY"\n', { mode: 0o700 });
  const input = new PassThrough(), output = new PassThrough();
  input.isTTY = true; input.setRawMode = () => {};
  Object.assign(output, { isTTY: true, columns: 100, rows: 30 }); output.resume();
  const ui = new UI({ input, output, error: output }); ui.setSession('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  ui.tui.value = 'Keep this unsent draft 🐝'; ui.tui.cursor = [...ui.tui.value].length;
  const check = { current: 'a'.repeat(40), target: 'b'.repeat(40), available: true, blocked: null, directory };
  t.after(() => {
    ui.close();
    for (const [key, value] of Object.entries(saved)) if (value == null) delete process.env[key]; else process.env[key] = value;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, ui, check };
}
async function until(check) {
  for (let attempt = 0; attempt < 100; attempt++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Expected update UI state');
}
test('updating keeps the TUI open, locks installation controls and saves drafts for a safe reload', async t => {
  const f = fixture(t); let complete, installed = false;
  const pending = new Promise(resolve => { complete = resolve; });
  const updating = updateCommand(f.ui, { check: async () => f.check, hostStatus: async () => ({ operatorStopped: true }),
    apply: async (check, options) => { assert.equal(check.target, f.check.target); assert.equal(options.inherit, false); installed = true; await pending; } });
  await until(() => f.ui.tui.selection && !f.ui.tui.selection.loading);
  f.ui.tui.finishSelection('install');
  await until(() => installed && f.ui.tui.selection?.locked);
  assert.equal(f.ui.closed, undefined); assert.equal(f.ui.tui.closed, undefined);
  const progress = f.ui.tui.selection;
  f.ui.tui.key('', { name: 'escape' }); assert.equal(f.ui.tui.selection, progress);
  f.ui.tui.render(); assert.equal(f.ui.tui.hitTargets.some(hit => hit.type === 'cancel'), false);
  complete(); await updating;
  assert.equal(f.ui.updateStatus, 'Updated · reloading');
  const file = f.ui.updateRestart.file;
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const recovery = readUpdateHandoff(file);
  assert.equal(recovery.sessionId, f.ui.sessionId); assert.equal(recovery.coreStopped, true);
  assert.equal(recovery.drafts[0][1].value, 'Keep this unsent draft 🐝');
  assert.equal(fs.existsSync(file), false, 'Recovery is consumed once');
  assert.equal(f.ui.closed, undefined, 'The update command never closes the terminal UI');
});
test('failed installation keeps the TUI and draft, reports failure and never schedules a reload', async t => {
  const f = fixture(t);
  const updating = updateCommand(f.ui, { check: async () => f.check, hostStatus: async () => ({}), apply: async () => { throw new Error('Installation fixture failed'); } });
  await until(() => f.ui.tui.selection && !f.ui.tui.selection.loading); f.ui.tui.finishSelection('install'); await updating;
  assert.equal(f.ui.updateRestart, undefined); assert.equal(f.ui.updateStatus, 'Update failed');
  assert.equal(f.ui.tui.value, 'Keep this unsent draft 🐝'); assert.equal(f.ui.tui.closed, undefined);
});
test('recovery rejects public files, symlinks and secret-entry state', t => {
  const f = fixture(t);
  f.ui.sessionMode = 'TRAFFIC VIEW';
  const observer = writeUpdateHandoff(f.ui); assert.equal(readUpdateHandoff(observer).mode, 'VIEW', 'Read-only screens remain observers after reload');
  const file = writeUpdateHandoff(f.ui); fs.chmodSync(file, 0o644);
  assert.throws(() => readUpdateHandoff(file), /private/);
  f.ui.tui.hidden = true; assert.throws(() => writeUpdateHandoff(f.ui), /private input/); f.ui.tui.hidden = false;
  const target = path.join(f.directory, 'private-target.json'); fs.writeFileSync(target, '{}', { mode: 0o600 });
  const link = writeUpdateHandoff(f.ui); fs.unlinkSync(link); fs.symlinkSync(target, link);
  assert.throws(() => readUpdateHandoff(link)); assert.equal(fs.readFileSync(target, 'utf8'), '{}');
});
test('the installed CLI replaces its process while retaining stdin/stdout and consuming only saved UI state', t => {
  const f = fixture(t), file = writeUpdateHandoff(f.ui), helper = new URL('../src/update-handoff.js', import.meta.url).href;
  const entry = path.join(f.directory, 'reloaded.mjs');
  fs.writeFileSync(entry, `import { readUpdateHandoff } from ${JSON.stringify(helper)}; const state=readUpdateHandoff(); console.log(JSON.stringify({after:process.pid, session:state.sessionId, draftRetained:state.drafts[0][1].value.includes('unsent draft')}));`);
  const script = `import { execUpdatedCLI } from ${JSON.stringify(helper)}; console.log(JSON.stringify({before:process.pid})); execUpdatedCLI({file:process.argv[1],check:{directory:process.argv[2]}});`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, file, f.directory], {
    encoding: 'utf8', timeout: 15000, env: { ...process.env, BZZY_TEST_NODE: process.execPath, BZZY_TEST_RELOAD_ENTRY: entry },
  });
  assert.equal(child.status, 0, child.stderr);
  const [before, after] = child.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(before.before, after.after, 'The same OS process and terminal continue after the update');
  assert.equal(after.session, f.ui.sessionId); assert.equal(after.draftRetained, true);
  assert.equal(fs.existsSync(file), false);
});
