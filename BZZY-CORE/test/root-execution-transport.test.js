import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { privateWorkspacePath } from '../src/engine/private-paths.js';

const helper = fileURLToPath(new URL('../src/engine/archive.py', import.meta.url));
for (const portable of [false, true]) test(`${portable ? 'shared projects' : 'owner backups'} cannot transport root installation authority`, t => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-root-transport-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'project'), output = path.join(directory, 'bundle.zip');
  fs.mkdirSync(path.join(source, '.bzzy'), { recursive: true });
  fs.writeFileSync(path.join(source, '.bzzy', 'root-execution.json'), JSON.stringify({ version: 1, mode: 'linux-root', uid: 0 }));
  fs.writeFileSync(path.join(source, 'report.txt'), 'Retain ordinary project data.');
  const archive = (action, spec) => spawnSync('python3', [helper, action], { input: JSON.stringify(spec), encoding: 'utf8', timeout: 10000 });
  const created = archive('create', { destination: output, temporary: output + '.partial', portable,
    limits: { entries: 100, fileBytes: 65536, bytes: 1024 * 1024 }, manifest: { sharing: {} }, entries: [{ source, archive: 'workspace' }] });
  assert.equal(created.status, 0, created.stderr);
  const names = spawnSync('python3', ['-c', 'import sys,zipfile,json; print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))', output], { encoding: 'utf8' });
  assert.equal(names.status, 0, names.stderr);
  assert.ok(JSON.parse(names.stdout).includes('workspace/report.txt'));
  assert.equal(JSON.parse(names.stdout).some(name => name.endsWith('/root-execution.json')), false);
  assert.equal(privateWorkspacePath('.bzzy/root-execution.json'), true);
  assert.equal(privateWorkspacePath('root-execution.json'), true);
  const injected = spawnSync('python3', ['-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1],"a"); z.writestr("workspace/.bzzy/root-execution.json","{}"); z.close()', output], { encoding: 'utf8' });
  assert.equal(injected.status, 0, injected.stderr);
  const target = path.join(directory, 'target'); fs.mkdirSync(target);
  const rejected = archive('extract', { archive: output, directory: target, portable,
    limits: { entries: 100, fileBytes: 65536, bytes: 1024 * 1024 } });
  assert.notEqual(rejected.status, 0); assert.match(rejected.stderr, /Root execution authorization cannot be imported/);
  assert.deepEqual(fs.readdirSync(target), []);
});
