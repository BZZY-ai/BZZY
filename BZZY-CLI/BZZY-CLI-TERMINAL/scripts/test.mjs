import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const environment = { ...process.env };
if (process.platform === 'darwin') {
  // Canonical short paths avoid Unix-socket limits and /var -> /private/var
  // aliases in fixture assertions. This does not alter application storage.
  environment.TMPDIR = '/private/tmp';
  if (spawnSync('git', ['--version'], { stdio: 'ignore' }).status !== 0 && fs.existsSync('/Library/Developer/CommandLineTools/usr/bin/git') && spawnSync('/Library/Developer/CommandLineTools/usr/bin/git', ['--version'], { stdio: 'ignore' }).status === 0) {
    environment.PATH = '/Library/Developer/CommandLineTools/usr/bin:' + environment.PATH;
  }
}

// Fixture controls are explicit test configuration, not production inheritance.
const fixtures = new Set(['NODE_OPTIONS', 'FLOW_DIRECTORY']);
for (const name of fs.readdirSync('test', { recursive: true })) {
  if (!/\.(m?js)$/.test(name) || path.basename(name).startsWith('._')) continue;
  for (const match of fs.readFileSync(path.join('test', name), 'utf8').matchAll(/\bBZZY_(?:TEST|FIXTURE)_[A-Z0-9_]+\b/g)) fixtures.add(match[0]);
}
const files = process.argv.slice(2);
const child = spawn(process.execPath, ['--test', ...(files.length ? files : fs.readdirSync('test').filter(name => !name.startsWith('._') && name.endsWith('.test.js')).map(name => path.join('test', name)))], {
  stdio: 'inherit', env: { ...environment, BZZY_ENV_ALLOW: [...fixtures].join(',') },
});
child.once('error', error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
