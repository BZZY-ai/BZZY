import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
for (const directory of ['src', 'bin', 'scripts', 'test', 'examples']) {
  for (const file of readdirSync(path.join(root, directory), { recursive: true }).filter(f => f.endsWith('.js') && !f.split(path.sep).some(part => part.startsWith('._')))) {
    const result = spawnSync(process.execPath, ['--check', path.join(root, directory, file)], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status || 1);
  }
}
console.log('JavaScript syntax checks passed.');
