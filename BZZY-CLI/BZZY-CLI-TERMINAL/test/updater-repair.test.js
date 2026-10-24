import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { updateRepository } from '../src/packaged-update.js';

const repair = new URL('../../../BZZY-CORE/scripts/repair-updater.py', import.meta.url).pathname;
for (const explicit of [false, true]) test(`old updater recovery works from another cwd with ${explicit ? 'explicit installation paths' : 'a managed launcher'} and preserves the old source`, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bzzy repair's fixture-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const author = path.join(root, 'author'), remote = path.join(root, 'remote.git'), old = path.join(root, 'custom install'), bin = path.join(root, 'custom bin');
  const receipt = path.join(root, 'repair.json'), globalConfig = path.join(root, 'gitconfig');
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH, GIT_CONFIG_GLOBAL: globalConfig,
    GIT_AUTHOR_NAME: 'Repair fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Repair fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test',
    BZZY_REPAIR_TEST_RECEIPT: receipt };
  const git = (cwd, ...args) => {
    const result = spawnSync('git', args, { cwd, env, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  git(root, 'init', '--bare', '--initial-branch=main', remote); git(root, 'clone', remote, author);
  const helper = path.join(author, 'BZZY-CORE/src/engine/installation-update.js'); fs.mkdirSync(path.dirname(helper), { recursive: true });
  fs.writeFileSync(path.join(author, 'BZZY-CORE/package.json'), '{"type":"module"}');
  fs.writeFileSync(helper, `import fs from 'node:fs'; import path from 'node:path';
export async function updateRepositoryInstallation(directory, options) {
  if (fs.readFileSync(path.join(directory, 'local-notes.txt'), 'utf8') !== 'preserve my local files') throw new Error('Local files changed');
  fs.writeFileSync(process.env.BZZY_REPAIR_TEST_RECEIPT, JSON.stringify({ directory, target: options.expectedCommit, bin: process.env.BZZY_LAUNCHER_BIN_DIR }));
}`);
  git(author, 'add', '.'); git(author, 'commit', '-m', 'Official repair fixture'); git(author, 'push', 'origin', 'main');
  const target = git(author, 'rev-parse', 'HEAD');
  git(root, 'config', '--file', globalConfig, `url.${remote}.insteadOf`, updateRepository);
  fs.mkdirSync(path.join(old, 'bin'), { recursive: true }); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(old, 'package.json'), '{"name":"bzzy-cli"}'); fs.writeFileSync(path.join(old, 'bin/bzzy.js'), '// installed CLI');
  fs.writeFileSync(path.join(old, 'local-notes.txt'), 'preserve my local files');
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  fs.writeFileSync(path.join(bin, 'bzzy'), `#!/bin/sh\n# bzzy-managed launcher\nexec ${quote(process.execPath)} ${quote(path.join(old, 'bin/bzzy.js'))} "$@"\n`, { mode: 0o755 });
  if (!explicit) {
    const writer = path.join(old, 'scripts/install-launcher.mjs'); fs.mkdirSync(path.dirname(writer));
    fs.copyFileSync(new URL('../scripts/install-launcher.mjs', import.meta.url), writer);
    const installed = spawnSync(process.execPath, [writer, bin, process.execPath], { env, encoding: 'utf8' });
    assert.equal(installed.status, 0, installed.stderr);
  }
  const args = [repair, ...(explicit ? ['--installation', old, '--node', process.execPath] : [])];
  const result = spawnSync('python3', args, { cwd: os.tmpdir(), env, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  const actual = JSON.parse(fs.readFileSync(receipt, 'utf8'));
  assert.equal(actual.directory, fs.realpathSync(old)); assert.equal(actual.target, target);
  if (!explicit) assert.equal(actual.bin, bin);
  assert.equal(fs.readFileSync(path.join(old, 'local-notes.txt'), 'utf8'), 'preserve my local files');
  assert.equal(fs.readFileSync(path.join(old, 'bin/bzzy.js'), 'utf8'), '// installed CLI');
  assert.match(result.stdout, /updater repaired/);
});

for (const scenario of ['missing-install', 'missing-package', 'invalid-package', 'missing-node', 'failed-node']) test(`repair identifies ${scenario} before network access without exposing file contents`, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-repair-diagnostic-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installed = path.join(root, 'installed'), missing = path.join(root, 'missing');
  fs.mkdirSync(installed);
  const secret = 'fixture-private-malformed-package-fragment';
  if (!['missing-install', 'missing-package'].includes(scenario)) fs.writeFileSync(path.join(installed, 'package.json'), scenario === 'invalid-package' ? secret : '{"name":"bzzy-cli"}');
  let node = scenario === 'missing-node' ? missing : process.execPath;
  if (scenario === 'failed-node') {
    node = path.join(root, 'failed-node'); fs.writeFileSync(node, '#!/bin/sh\necho fixture-private-node-output >&2\nexit 17\n', { mode: 0o755 });
  }
  const result = spawnSync('python3', [repair, '--installation', scenario === 'missing-install' ? missing : installed, '--node', node], { encoding: 'utf8', timeout: 3000 });
  assert.equal(result.status, 1);
  const codes = { 'missing-install': 'REPAIR_INSTALL_MISSING', 'missing-package': 'REPAIR_PACKAGE_MISSING', 'invalid-package': 'REPAIR_PACKAGE_INVALID', 'missing-node': 'REPAIR_NODE_MISSING', 'failed-node': 'REPAIR_NODE_FAILED' };
  assert.ok(result.stderr.includes(codes[scenario]), result.stderr);
  assert.ok(!result.stderr.includes(secret)); assert.ok(!result.stderr.includes('fixture-private-node-output'));
  assert.ok(!result.stdout.includes('Preparing the official updater'));
});
