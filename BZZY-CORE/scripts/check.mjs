import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

let failed = false;
for (const directory of ['bin', 'src', 'scripts', 'test']) {
  for (const entry of fs.readdirSync(directory, { recursive: true })) {
    if (entry.startsWith('._') || entry.split(path.sep).some(part => part.startsWith('._')) || !/\.m?js$/.test(entry)) continue;
    const check = spawnSync(process.execPath, ['--check', path.join(directory, entry)], { stdio: 'inherit' });
    failed ||= check.status !== 0;
  }
}
process.exitCode = failed ? 1 : 0;
