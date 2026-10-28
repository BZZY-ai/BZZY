import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

test('the release tarball runs CLI, Core and Relay SDK without sibling source directories', { timeout: 90000 }, t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-package-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const userconfig = path.join(temporary, 'npmrc'); fs.writeFileSync(userconfig, '');
  const env = { ...process.env, PATH: [path.dirname(process.execPath), process.env.PATH].join(path.delimiter),
    BZZY_HOME: path.join(temporary, 'private'), npm_config_userconfig: userconfig, npm_config_offline: 'true' };
  const workspace = path.join(temporary, 'source'), terminal = path.join(workspace, 'BZZY-CLI/BZZY-CLI-TERMINAL');
  for (const [source, target] of [
    [root, terminal],
    [path.resolve(root, '../../BZZY-CORE'), path.join(workspace, 'BZZY-CORE')],
    [path.resolve(root, '../../BZZY-RELAY'), path.join(workspace, 'BZZY-RELAY')],
  ]) {
    const pkg = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
    fs.mkdirSync(target, { recursive: true });
    for (const entry of ['package.json', 'package-lock.json', '.npmrc', ...pkg.files]) {
      const file = path.join(source, entry);
      if (fs.existsSync(file)) fs.cpSync(file, path.join(target, entry), { recursive: true,
        filter: name => !name.split(path.sep).some(part => part.startsWith('._')) });
    }
  }
  const npm = (args, cwd) => {
    const command = process.env.npm_execpath ? process.execPath : 'npm';
    const prefix = process.env.npm_execpath ? [process.env.npm_execpath] : [];
    const result = spawnSync(command, [...prefix, ...args], { cwd, env, encoding: 'utf8', timeout: 60000 });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return result.stdout;
  };
  // Exercise release preparation and its physical dependency staging. npm runs
  // lifecycle output on stderr in JSON mode, leaving stdout machine-readable.
  const [packed] = JSON.parse(npm(['pack', '--json', '--pack-destination', temporary], terminal));
  const contents = packed.files.map(file => file.path);
  assert.ok(contents.includes('node_modules/@bzzy/core/src/engine/runtime.js'));
  assert.ok(contents.includes('node_modules/@bzzy/core/src/engine/rpc-failure.js'));
  assert.ok(contents.includes('node_modules/@bzzy/core/scripts/core-chat-init-probe.py'));
  assert.ok(contents.some(file => file.endsWith('@bzzy/relay/src/client.js')));
  assert.ok(contents.every(file => !/(^|\/)(?:connect\.txt|\.env(?:\..*)?|credentials\.json|\.npmrc|\._[^/]*)(?:\/|$)/i.test(file)), 'release must exclude private notes, credentials and host metadata');
  assert.ok(contents.every(file => !file.split('/').includes('..')), 'release paths must remain within the package');
  const coreSource = path.join(workspace, 'BZZY-CORE');
  const metadataFixture = path.join(coreSource, 'node_modules/@bzzy/relay/._packaging-fixture');
  fs.writeFileSync(metadataFixture, 'fixture dependency metadata');
  fs.writeFileSync(path.join(coreSource, 'connect.txt'), 'fixture private host notes');
  fs.writeFileSync(path.join(coreSource, 'credentials.json'), '{"fixture":"not-a-real-credential"}');
  const [packedCore] = JSON.parse(npm(['pack', '--json', '--pack-destination', temporary], coreSource));
  assert.ok(packedCore.files.some(file => file.path === 'scripts/core-chat-init-probe.py'));
  assert.equal(fs.readFileSync(metadataFixture, 'utf8'), 'fixture dependency metadata', 'Core packaging must preserve original dependency metadata');
  assert.equal(fs.readFileSync(path.join(coreSource, 'connect.txt'), 'utf8'), 'fixture private host notes');
  assert.equal(fs.existsSync(path.join(coreSource, '.bzzy-package')), false, 'postpack must restore and remove its temporary stage');
  assert.ok(packedCore.files.every(file => !/(^|\/)(?:connect\.txt|\.env(?:\..*)?|credentials\.json|\.npmrc|\._[^/]*)(?:\/|$)/i.test(file.path)), 'standalone Core must exclude private notes, credentials and host metadata');
  assert.ok(packedCore.files.every(file => !file.path.split('/').includes('..')));
  fs.rmSync(workspace, { recursive: true, force: true });
  const installed = path.join(temporary, 'installed'); fs.mkdirSync(installed);
  npm(['install', '--prefix', installed, '--ignore-scripts', '--offline', '--no-audit', '--no-fund', path.join(temporary, packed.filename)], temporary);
  const cli = path.join(installed, 'node_modules/bzzy-cli');
  assert.equal(fs.existsSync(path.join(temporary, 'BZZY-CORE')), false);
  for (const [file, args, expected] of [
    [path.join(cli, 'bin/bzzy.js'), ['--version'], /^bzzy 0\.2\.0\s*$/],
    [path.join(cli, 'node_modules/@bzzy/core/bin/bzzy-core.js'), ['status'], /"running":false/],
  ]) {
    const result = spawnSync(process.execPath, [file, ...args], { cwd: temporary, env, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, expected);
  }
  const sdk = spawnSync(process.execPath, ['--input-type=module', '-e', "import { BzzyCore } from '@bzzy/core'; import { RelayClient } from '@bzzy/relay'; console.log(typeof BzzyCore, typeof RelayClient);"], {
    cwd: path.join(cli, 'node_modules/@bzzy/core'), env, encoding: 'utf8', timeout: 15000,
  });
  assert.equal(sdk.status, 0, sdk.stderr); assert.match(sdk.stdout, /function function/);
  const host = path.join(temporary, 'core-host'); fs.mkdirSync(host);
  npm(['install', '--prefix', host, '--ignore-scripts', '--offline', '--no-audit', '--no-fund', path.join(temporary, packedCore.filename)], temporary);
  assert.equal(fs.existsSync(path.join(host, 'node_modules/bzzy-cli')), false);
  const status = spawnSync(process.execPath, [path.join(host, 'node_modules/@bzzy/core/bin/bzzy-core.js'), 'status'], { cwd: host, env, encoding: 'utf8', timeout: 15000 });
  assert.equal(status.status, 0, status.stderr); assert.match(status.stdout, /"running":false/);
});
