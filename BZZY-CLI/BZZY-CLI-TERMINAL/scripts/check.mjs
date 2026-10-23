import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

let failed = false;
for (const dir of ['bin', 'src', 'scripts', 'test', 'assets']) {
  if (!fs.existsSync(dir)) continue;
  for (const entry of fs.readdirSync(dir, { recursive: true })) {
    const file = path.join(dir, entry);
    if (entry.split(path.sep).some(part => part.startsWith('._'))) continue;
    if (!/\.(m?js)$/.test(file)) continue;
    const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
    failed ||= result.status !== 0;
  }
}
process.exitCode = failed ? 1 : 0;
