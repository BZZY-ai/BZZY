import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { BUILTINS, config, modeDefault, saveModeDefault, defaultSelection } from '../src/providers.js';
import { saveSessionDefaultSelection } from '../src/session-defaults.js';
import { chooseSavedCombo } from '../src/mode-presets.js';
import { chooseDebate, applyDebateSelection } from '../src/debate-setup.js';
import { applyBestiesSelection } from '../src/besties-setup.js';
import { applyParallelSelection } from '../src/parallel-setup.js';
import { createSession, saveSession, sessions } from '../src/store.js';
import { parseArgs } from '../src/cli.js';
import { root } from '../src/process.js';
import { chatHelp } from '../src/terminal-commands.js';

let directory, previous;
const agents = (mode, count = 2) => Array.from({ length: count }, (_, index) => ({ provider: 'codex', model: `${mode}-${index}`, effort: index ? 'high' : 'xhigh', capabilities: { supportedEfforts: ['high', 'xhigh'] } }));
test.beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-presets-'));
  previous = Object.fromEntries(['BZZY_HOME', 'BZZY_CODEX_BIN', 'BZZY_TEST_LOG'].map(key => [key, process.env[key]]));
  Object.assign(process.env, { BZZY_HOME: path.join(directory, 'private'), BZZY_CODEX_BIN: path.join(root, 'test/fixtures/models.mjs'), BZZY_TEST_LOG: path.join(directory, 'backend.jsonl') });
});
test.afterEach(() => {
  for (const [key, value] of Object.entries(previous)) if (value == null) delete process.env[key]; else process.env[key] = value;
  fs.rmSync(directory, { recursive: true, force: true });
});

test('/default keeps normal, parallel, debate, besties and delegate presets independent', () => {
  const normal = createSession(BUILTINS.claude, directory, 'normal-chat'); normal.selectedEffort = 'high';
  saveSessionDefaultSelection(normal); const original = defaultSelection();
  for (const mode of ['parallel', 'debate', 'besties', 'delegate']) {
    const selected = agents(mode, mode === 'delegate' ? 2 : 3), session = createSession(BUILTINS.codex, directory);
    if (mode === 'parallel') applyParallelSelection(session, selected);
    if (mode === 'besties') applyBestiesSelection(session, selected);
    if (mode === 'debate') applyDebateSelection(session, selected);
    if (mode === 'delegate') Object.assign(session, { mode, model: selected[0].model, selectedEffort: selected[0].effort, modelCapabilities: selected[0].capabilities, executor: selected[1] });
    saveSession(session); saveSessionDefaultSelection(session);
    assert.deepEqual(modeDefault(mode), selected);
    assert.deepEqual(defaultSelection(), original);
  }
  for (const mode of ['parallel', 'debate', 'besties', 'delegate']) assert.deepEqual(config()[`${mode}Default`], agents(mode, mode === 'delegate' ? 2 : 3));
});

test('--default skips all selection prompts and uses only the requested mode’s saved combo', async () => {
  for (const mode of ['parallel', 'debate', 'besties', 'delegate']) {
    const selected = agents(mode); saveModeDefault(mode, selected);
    assert.equal(parseArgs([`--${mode}`, '--default']).options.useDefault, true);
    assert.deepEqual(await chooseSavedCombo(mode, { useDefault: true }, { chooseOne() { throw new Error('No selector should open'); } }), selected);
    let prompts = 0;
    assert.deepEqual(await chooseSavedCombo(mode, {}, { async chooseOne(title) { prompts++; assert.match(title, /Use saved combo/); return 'yes'; } }), selected);
    assert.equal(prompts, 1);
    assert.equal(await chooseSavedCombo(mode, {}, { async chooseOne() { return 'no'; } }), false);
    assert.equal(await chooseSavedCombo(mode, {}, { async chooseOne() { return null; } }), null);
  }
  await assert.rejects(chooseSavedCombo('parallel', { useDefault: true, parallelCount: 3 }, {}), /No matching parallel default/);
  assert.throws(() => parseArgs(['--parallel', '--default', '--agents', 'codex,claude']), /either --default/);
});

test('missing presets give a clear error with --default, and debate supports two or three model/effort selections', async () => {
  await assert.rejects(chooseSavedCombo('besties', { useDefault: true }, {}), /Configure the agents.*\/default/);
  for (const count of [2, 3]) {
    let configured = 0;
    const selected = await chooseDebate({ cwd: directory }, { interactive: true, async chooseOne(title, options) {
      const picker = await options;
      if (title === 'Debate · Select agents') return configured < count ? `agent:${configured}` : 'continue';
      if (title.includes('Choose provider')) return 'codex';
      assert.equal(picker.selectEffort, true); configured++;
      return { value: configured === 1 ? 'fixture-brain' : 'fixture-light', effort: configured === 1 ? 'xhigh' : 'low' };
    }, event() {} });
    assert.equal(selected.length, count); assert.equal(selected[0].effort, 'xhigh');
    assert.ok(selected.slice(1).every(agent => agent.effort === 'low'));
    assert.equal(sessions().length, 0);
  }
  for (const mode of ['parallel', 'debate', 'delegate', 'besties']) assert.ok(chatHelp.includes(`--${mode}`));
  assert.match(chatHelp, /\/default/); assert.match(chatHelp, /--default/);
});

const ptyAvailable = process.platform === 'linux' && spawnSync('script', ['--version'], { stdio: 'ignore' }).status === 0;
test('each mode flag goes straight to goal entry without confirmation or model selection', { skip: !ptyAvailable, timeout: 20000 }, async () => {
  for (const mode of ['parallel', 'debate', 'besties', 'delegate']) {
    saveModeDefault(mode, agents(mode, mode === 'delegate' ? 2 : 3));
    const command = [process.execPath, path.join(root, 'bin/bzzy.js'), `--${mode}`, '--no-pet'].map(value => `'${value.replaceAll("'", "'\\''")}'`).join(' ');
    const child = spawn('script', ['-qefc', command, '/dev/null'], { cwd: directory, env: { ...process.env, TERM: 'xterm-256color' }, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    const done = new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
    try {
      for (let attempt = 0; attempt < 300 && !output.includes('Goal setup'); attempt++) { assert.equal(child.exitCode, null, output); await new Promise(resolve => setTimeout(resolve, 10)); }
      assert.match(output, /Goal setup/);
      assert.doesNotMatch(output, /Use saved combo|Select agents|Choose provider|Choose model/);
      assert.ok(output.includes(`${mode}-0`));
      child.stdin.write('\x1b'); assert.equal(await done, 0, output);
      assert.equal(sessions().length, 0);
    } finally { if (child.exitCode == null) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} } await done.catch(() => {}); }
  }
});
