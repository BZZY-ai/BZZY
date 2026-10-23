import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const regularFiles = directory => fs.readdirSync(directory, { recursive: true }).filter(entry => !entry.split(path.sep).some(part => part.startsWith('._')) && fs.statSync(path.join(directory, entry)).isFile());

test('Core production modules resolve without any terminal source dependency', () => {
  for (const folder of ['src', 'bin']) for (const entry of regularFiles(path.join(root, folder)).filter(entry => /\.m?js$/.test(entry))) {
    const file = path.join(root, folder, entry), source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /BZZY-CLI(?:-TERMINAL)?/, `${folder}/${entry} references the terminal package.`);
    for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.[^'"]+)['"]/g)) {
      const dependency = path.resolve(path.dirname(file), match[1]);
      assert.ok(dependency.startsWith(root), `${folder}/${entry} imports outside Core: ${match[1]}`);
      assert.ok(fs.existsSync(dependency), `${folder}/${entry} imports a missing module: ${match[1]}`);
    }
  }
});

test('a standalone Core copy executes, replays raw native messages and restarts without the CLI', { timeout: 30000, skip: process.platform === 'win32' }, async () => {
  const directory = fs.mkdtempSync(path.join(process.platform === 'darwin' ? '/private/tmp' : os.tmpdir(), 'bz-core-alone-'));
  const installed = path.join(directory, 'core'), workspace = path.join(directory, 'workspace');
  const include = source => !path.basename(source).startsWith('._');
  try {
    fs.mkdirSync(installed); fs.mkdirSync(workspace);
    // Copy actual files, including dependencies. A symlink to the workspace
    // would hide a reverse dependency and would not prove Core can stand alone.
    for (const name of ['package.json', 'src', 'bin', 'assets', 'node_modules']) fs.cpSync(path.join(root, name), path.join(installed, name), { recursive: true, dereference: true, filter: include });
    const fixtures = path.join(installed, 'test', 'fixtures'); fs.mkdirSync(fixtures, { recursive: true });
    for (const name of ['standalone-agent.mjs', 'standalone-host.mjs']) fs.copyFileSync(path.join(root, 'test', 'fixtures', name), path.join(fixtures, name));
    fs.chmodSync(path.join(fixtures, 'standalone-agent.mjs'), 0o755);
    const privateHome = path.join(directory, 'private'); fs.mkdirSync(privateHome, { mode: 0o700 });
    fs.writeFileSync(path.join(privateHome, 'config.json'), JSON.stringify({ executionEnvironment: { allow: ['BZZY_TEST_LOG'] } }), { mode: 0o600 });
    const environment = { ...process.env, BZZY_HOME: privateHome, BZZY_CODEX_HOME: path.join(directory, 'codex'),
      BZZY_CODEX_BIN: path.join(fixtures, 'standalone-agent.mjs'), BZZY_TEST_LOG: path.join(directory, 'backend.jsonl'),
      BZZY_ENV_ALLOW: 'BZZY_TEST_LOG', CLAUDE_CONFIG_DIR: path.join(directory, 'claude'), CLAUDE_SECURESTORAGE_CONFIG_DIR: path.join(directory, 'claude-secure') };
    delete environment.NODE_OPTIONS;
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(fixtures, 'standalone-host.mjs'), workspace], { cwd: installed, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
      child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr }));
    });
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout.trim());
    assert.deepEqual(report, { standalone: true, coreRunner: true, rawBodyPreserved: true, replayPreserved: true, executionCount: 1, processedEvents: report.processedEvents });
    assert.ok(report.processedEvents > 0);
    assert.equal(fs.existsSync(path.join(directory, 'BZZY-CLI')), false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
