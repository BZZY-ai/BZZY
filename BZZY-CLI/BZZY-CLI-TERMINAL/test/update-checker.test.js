import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkInstallationUpdate, applyInstallationUpdate, officialRepository } from '../src/update-checker.js';
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
