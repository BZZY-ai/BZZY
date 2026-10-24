import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { updateRepository } from '../src/packaged-update.js';

const repair = new URL('../../../BZZY-CORE/scripts/repair-updater.py', import.meta.url).pathname;
for (const layout of ['managed', 'multiline', 'multiline-crlf', 'multiline-legacy', 'runuser', 'sudo', 'explicit']) test(`old updater recovery works from another cwd with ${layout} paths and preserves the old source`, t => {
  const accountWrapper = ['runuser', 'sudo'].includes(layout);
  if (accountWrapper && os.userInfo().uid === 0) return t.skip('non-root owner fixture; root handoff is checked separately');
  const explicit = layout === 'explicit';
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
  fs.writeFileSync(process.env.BZZY_REPAIR_TEST_RECEIPT, JSON.stringify({ directory, target: options.expectedCommit, bin: process.env.BZZY_LAUNCHER_BIN_DIR, runtime: process.execPath, version: process.versions.node, stateHome: process.env.BZZY_HOME }));
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
  // The host shell can use Node 20 while BZZY's launcher pins its own Node 24.
  fs.writeFileSync(path.join(bin, 'node'), '#!/bin/sh\necho v20.20.2\n', { mode: 0o755 });
  if (layout.startsWith('multiline')) {
    const newline = layout === 'multiline-crlf' ? '\r\n' : '\n';
    const continuation = String.fromCharCode(92);
    fs.writeFileSync(path.join(bin, 'bzzy'), [
      '#!/bin/sh', layout === 'multiline-legacy' ? '# older BZZY launcher' : '# bzzy-managed launcher', '  exec ' + continuation,
      '    ' + quote(process.execPath) + ' ' + continuation,
      '    ' + quote(path.join(old, 'bin/bzzy.js')) + ' ' + continuation,
      '    "$@"', '',
    ].join(newline), { mode: 0o755 });
  }
  let outer, outerBody;
  if (accountWrapper) {
    const outerBin = path.join(root, 'root bin'); fs.mkdirSync(outerBin);
    outer = path.join(outerBin, 'bzzy');
    const account = os.userInfo();
    outerBody = [
      '#!/bin/sh', `exec /usr/sbin/${layout} -u ${quote(account.username)} -- env`,
      `HOME=${quote(account.homedir)} USER=${quote(account.username)} LOGNAME=${quote(account.username)}`,
      `SHELL=/bin/sh XDG_RUNTIME_DIR=/run/user/${account.uid} DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${account.uid}/bus`,
      'TERM="${TERM:-xterm-256color}" COLORTERM="${COLORTERM:-truecolor}" LANG="${LANG:-C.UTF-8}"',
      `PATH=${quote(env.PATH)} BZZY_HOME=${quote(path.join(root, 'existing private home'))}`,
      `${quote(path.join(bin, 'bzzy'))} "$@"`,
    ].map((line, index, lines) => index > 0 && index < lines.length - 1 ? line + ' ' + String.fromCharCode(92) : line).join('\n') + '\n';
    fs.writeFileSync(outer, outerBody, { mode: 0o755 });
    env.PATH = outerBin + path.delimiter + env.PATH;
  }
  const args = [repair, ...(explicit ? ['--installation', old, '--node', process.execPath] : [])];
  const result = spawnSync('python3', args, { cwd: os.tmpdir(), env, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  const actual = JSON.parse(fs.readFileSync(receipt, 'utf8'));
  assert.equal(actual.directory, fs.realpathSync(old)); assert.equal(actual.target, target);
  assert.equal(actual.runtime, process.execPath); assert.ok(Number(actual.version.split('.')[0]) >= 24);
  if (!explicit) assert.equal(actual.bin, bin);
  if (accountWrapper) {
    assert.equal(actual.stateHome, path.join(root, 'existing private home'));
    assert.equal(fs.readFileSync(outer, 'utf8'), outerBody);
  }
  assert.equal(fs.readFileSync(path.join(old, 'local-notes.txt'), 'utf8'), 'preserve my local files');
  assert.equal(fs.readFileSync(path.join(old, 'bin/bzzy.js'), 'utf8'), '// installed CLI');
  assert.match(result.stdout, /updater repaired/);
});

test('root wrapper recovery drops identity before Git/Node and rejects unsupported commands without executing them or exposing secrets', () => {
  const code = String.raw`
import importlib.util, os, pathlib, subprocess, sys, tempfile, types
from unittest.mock import patch
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('repair', sys.argv[1])
repair = importlib.util.module_from_spec(spec)
spec.loader.exec_module(repair)
with tempfile.TemporaryDirectory() as temporary:
    root = pathlib.Path(temporary)
    account = types.SimpleNamespace(pw_name='fixture-owner', pw_uid=4242, pw_gid=4343, pw_dir=str(root), pw_shell='/bin/sh')
    inner = root / 'inner'
    inner.write_text('#!/bin/sh\nexec /installed/node /installed/cli/bin/bzzy.js "$@"\n')
    outer = root / 'bzzy'
    def wrapper(assignments='', target=inner):
        outer.write_text(f'#!/bin/sh\nexec /usr/sbin/runuser -u fixture-owner -- env HOME={root} {assignments} {target} "$@"\n')
    wrapper('BZZY_HOME=/existing/private/state')
    with patch('pwd.getpwnam', return_value=account), patch.object(repair.os, 'geteuid', return_value=0):
        directory, node, bin_dir, (owner, selected) = repair.inspect_launcher(outer, {'ROOT_PRIVATE_TOKEN': 'do-not-forward', 'GIT_CONFIG_GLOBAL': '/root/private-gitconfig'})
        assert directory == pathlib.Path('/installed/cli') and node == pathlib.Path('/installed/node')
        assert bin_dir == root and selected['BZZY_HOME'] == '/existing/private/state'
        assert 'ROOT_PRIVATE_TOKEN' not in selected and 'GIT_CONFIG_GLOBAL' not in selected
        with patch.object(repair.sys, 'platform', 'linux'), patch.object(repair.os, 'getgrouplist', return_value=[4343, 4545]), patch.object(repair.subprocess, 'run', return_value=types.SimpleNamespace(returncode=17)) as run:
            assert repair.repair_as_account(owner, selected, directory, node, bin_dir) == 17
            arguments = run.call_args.args[0]
            options = run.call_args.kwargs
            assert arguments == [sys.executable, '-I', '-', '--installation', str(directory), '--node', str(node)]
            assert options['user'] == 4242 and options['group'] == 4343 and options['extra_groups'] == [4343, 4545]
            assert options['umask'] == 0o077 and options['cwd'] == str(root)
            assert options['env']['HOME'] == str(root) and options['env']['BZZY_LAUNCHER_BIN_DIR'] == str(root)
            assert 'ROOT_PRIVATE_TOKEN' not in options['env'] and 'GIT_CONFIG_GLOBAL' not in options['env']
            assert options['input'] == pathlib.Path(sys.argv[1]).read_text()
        with patch.object(repair.sys, 'argv', ['repair']), patch.object(repair.shutil, 'which', return_value=str(outer)), patch.object(repair, 'repair_as_account', return_value=17) as handoff, patch.object(repair.subprocess, 'run', side_effect=AssertionError('Git or Node ran before dropping privileges')):
            try:
                repair.main()
                raise AssertionError('Expected child exit status')
            except SystemExit as result:
                assert result.code == 17
            handoff.assert_called_once()
        marker = root / 'must-not-exist'
        for assignment, expected in [('API_KEY=fixture-private-token', 'REPAIR_WRAPPER_ENVIRONMENT'), (f'PATH="$(touch {marker})"', 'REPAIR_WRAPPER_ENVIRONMENT'), ('HOME=/wrong-owner', 'REPAIR_WRAPPER_FORMAT'), ('PATH="$PRIVATE_TOKEN"', 'REPAIR_WRAPPER_ENVIRONMENT')]:
            wrapper(assignment)
            with patch.object(repair.subprocess, 'run', side_effect=AssertionError('Wrapper executed')):
                try:
                    repair.inspect_launcher(outer, {})
                    raise AssertionError('Unsafe wrapper accepted')
                except RuntimeError as error:
                    assert expected in str(error) and 'fixture-private-token' not in str(error)
            assert not marker.exists()
        wrapper(target=outer)
        try:
            repair.inspect_launcher(outer, {})
            raise AssertionError('Loop accepted')
        except RuntimeError as error:
            assert 'REPAIR_LAUNCHER_LOOP' in str(error)
        wrapper()
        with patch.object(repair.os, 'geteuid', return_value=5151):
            try:
                repair.inspect_launcher(outer, {})
                raise AssertionError('Another account accepted')
            except RuntimeError as error:
                assert 'REPAIR_WRAPPER_ACCOUNT' in str(error)
        account.pw_uid = 0
        try:
            repair.inspect_launcher(outer, {})
            raise AssertionError('Root model execution accepted')
        except RuntimeError as error:
            assert 'REPAIR_WRAPPER_ACCOUNT' in str(error)
`;
  const result = spawnSync('python3', ['-I', '-c', code, repair], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!result.stdout.includes('fixture-private-token'));
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
