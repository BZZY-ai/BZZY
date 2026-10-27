import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkInstallationUpdate, applyInstallationUpdate, officialRepository, runUpdateCommand, updateCommand } from '../src/update-checker.js';
function fixture(t) {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-check-update-'));
 t.after(() => fs.rmSync(root, { recursive: true, force: true }));
 const directory = path.join(root, 'BZZY-CLI/BZZY-CLI-TERMINAL'); fs.mkdirSync(directory, { recursive: true });
 fs.mkdirSync(path.join(root, 'BZZY-CORE')); fs.writeFileSync(path.join(root, 'BZZY-CORE/package.json'), '{}');
 const state = { current: 'a'.repeat(40), target: 'b'.repeat(40), branch: 'main', dirty: '', origin: 'git@github.com:BZZY-ai/BZZY.git', installs: [] };
 const run = async (command, args, options) => {
  if (command !== 'git') { state.installs.push({ command, args, options }); return ''; }
  const call = args.slice(2).join(' ');
  if (call === 'rev-parse --show-toplevel') return root;
  if (call === 'rev-parse HEAD') return state.current;
  if (call.startsWith('symbolic-ref')) return state.branch;
  if (call.startsWith('remote get-url')) return state.origin;
  if (call.startsWith('status')) return state.dirty;
  if (call.startsWith('ls-remote')) return `ref: refs/heads/main\tHEAD\n${state.target}\tHEAD`;
  if (call.startsWith('merge-base')) throw new Error('not ancestor');
  throw new Error('Unexpected Git operation');
 };
 return { root, directory, state, run };
}
test('the combined checker selects official releases without requiring a clean or attached source checkout', async t => {
 const f = fixture(t), check = await checkInstallationUpdate(f);
 assert.equal(check.available, true); assert.equal(check.blocked, null); assert.equal(f.state.installs.length, 0);
 f.state.dirty = ' M BZZY-CORE/source.js\n?? user-reference/'; assert.equal((await checkInstallationUpdate(f)).blocked, null);
 f.state.branch = 'feature'; assert.equal((await checkInstallationUpdate(f)).blocked, null);
 f.state.branch = null; assert.equal((await checkInstallationUpdate(f)).available, true);
 f.state.origin = 'https://github.com/other/project.git'; await assert.rejects(checkInstallationUpdate(f), /origin must be BZZY/);
 assert.equal(officialRepository('https://github.com/BZZY-ai/BZZY.git'), true);
 assert.equal(officialRepository('https://github.com/BZZY-ai/BZZY.git?token=private'), false);
});
test('installation pins the reviewed commit and rejects intervening source changes', async t => {
 const f = fixture(t), oldHome = process.env.BZZY_HOME; process.env.BZZY_HOME = path.join(f.root, 'private');
 try {
  const check = await checkInstallationUpdate(f); await applyInstallationUpdate(check, { run: f.run });
  assert.equal(f.state.installs.length, 1); assert.equal(f.state.installs[0].options.target, check.target);
  assert.equal(f.state.installs[0].args.at(-1), 'update');
  f.state.target = 'c'.repeat(40);
  await assert.rejects(applyInstallationUpdate(check, { run: f.run }), /changed/); assert.equal(f.state.installs.length, 1);
 } finally { if (oldHome == null) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = oldHome; }
});

test('source checks give local Git probes and GitHub discovery separate bounded deadlines', async t => {
 const f = fixture(t), calls = [], parent = new AbortController();
 await checkInstallationUpdate({ directory: f.directory, signal: parent.signal,
  run: (command, args, options) => { calls.push({ command, args, options }); return f.run(command, args, options); } });
 assert.equal(calls.length, 4);
 for (const call of calls) {
  assert.equal(call.options.signal, parent.signal);
  assert.equal(call.options.timeoutMs, call.args.includes('ls-remote') ? 60000 : 10000);
 }
});

test('packaged discovery receives the same independent network deadline and parent cancellation', async t => {
 const f = fixture(t), directory = path.join(f.root, 'package'), parent = new AbortController(), calls = [];
 fs.mkdirSync(path.join(directory, 'bin'), { recursive: true });
 fs.mkdirSync(path.join(directory, 'node_modules', '@bzzy', 'core'), { recursive: true });
 fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'bzzy-cli' }));
 fs.writeFileSync(path.join(directory, 'bin', 'bzzy.js'), '');
 fs.writeFileSync(path.join(directory, 'node_modules', '@bzzy', 'core', 'package.json'), '{}');
 const result = await checkInstallationUpdate({ directory, signal: parent.signal, run: async (command, args, options) => {
  calls.push({ command, args, options }); return `ref: refs/heads/main\tHEAD\n${f.state.target}\tHEAD`;
 } });
 assert.equal(result.packaged, true); assert.equal(calls.length, 1);
 assert.equal(calls[0].options.signal, parent.signal); assert.equal(calls[0].options.timeoutMs, 60000);
});

test('a command deadline reports timeout rather than claiming that the child could not start', async () => {
 await assert.rejects(runUpdateCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  timeoutMs: 30, signal: AbortSignal.timeout(2000),
 }), error => error.code === 'UPDATE_TIMEOUT' && error.stage === 'updater'
  && /timed out/.test(error.message) && !/could not start/.test(error.message));
});

test('explicit cancellation stops a started child without exposing the cancellation reason', async t => {
 const f = fixture(t), marker = path.join(f.root, 'started'), controller = new AbortController();
 const task = runUpdateCommand(process.execPath, ['-e', "require('node:fs').writeFileSync(process.argv[1], 'started');setInterval(() => {}, 1000)", marker], { signal: controller.signal });
 const outcome = task.then(() => assert.fail('Cancelled update command must not succeed'), error => error);
 try {
  for (let attempt = 0; attempt < 200 && !fs.existsSync(marker); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(fs.existsSync(marker), 'the child was running before cancellation');
  controller.abort(new Error('private-cancellation-reason'));
  const error = await outcome;
  assert.equal(error.name, 'AbortError'); assert.equal(error.code, 'UPDATE_CANCELLED');
  assert.match(error.message, /was cancelled/); assert.doesNotMatch(error.message, /private-cancellation-reason|could not start/);
 } finally { controller.abort(); await outcome; }
});

test('already cancelled commands do not launch and preserve a safe cancellation outcome', async t => {
 const f = fixture(t), marker = path.join(f.root, 'must-not-start'), controller = new AbortController(); controller.abort();
 await assert.rejects(runUpdateCommand(process.execPath, ['-e', "require('node:fs').writeFileSync(process.argv[1], 'started')", marker], {
  signal: controller.signal,
 }), error => error.name === 'AbortError' && error.code === 'UPDATE_CANCELLED');
 assert.equal(fs.existsSync(marker), false);
});

test('missing executables and denied execution report safe startup categories without command arguments or paths', async t => {
 const f = fixture(t), missing = path.join(f.root, 'missing-private-command'), denied = path.join(f.root, 'denied-private-command');
 fs.writeFileSync(denied, '#!/bin/sh\nexit 0\n', { mode: 0o600 });
 for (const [command, code, systemCode] of [[missing, 'UPDATE_COMMAND_NOT_FOUND', 'ENOENT'], [denied, 'UPDATE_COMMAND_PERMISSION', 'EACCES']]) {
  await assert.rejects(runUpdateCommand(command, ['https://private-user:private-token@example.invalid/repo']), error =>
   error.code === code && error.message.includes(systemCode) && !error.message.includes(f.root)
   && !error.message.includes('private-user') && !error.message.includes('private-token'));
 }
});

test('nonzero commands expose only the safe stage and exit status, never stderr', async () => {
 await assert.rejects(runUpdateCommand(process.execPath, ['-e', "process.stderr.write('PRIVATE_STDERR_829411');process.exit(37)"]), error =>
  error.code === 'UPDATE_COMMAND_FAILED' && error.stage === 'updater' && error.exitCode === 37
  && /exit 37/.test(error.message) && !error.message.includes('PRIVATE_STDERR_829411'));
});

test('TUI update checking relies on Core deadlines and cancels its parent signal when leaving', async t => {
 const original = AbortSignal.timeout, deadlines = [], f = fixture(t); let signal;
 t.mock.method(AbortSignal, 'timeout', ms => { deadlines.push(ms); return original(ms); });
 await updateCommand({ chooseOne: async (_title, content) => { await content; return 'back'; } }, {
  check: async options => { signal = options.signal; return { current: f.state.current, target: f.state.target, available: true }; },
 });
 assert.deepEqual(deadlines, []); assert.ok(signal.aborted);
});
