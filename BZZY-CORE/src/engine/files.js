import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

export const home = () => path.resolve(process.env.BZZY_HOME || path.join(os.homedir(), '.bzzy'));
export function privateDir(dir) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); }
export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw new Error(`Cannot read ${file}: ${error.message}`); }
}
export function writeJson(file, value) {
  if (path.dirname(path.resolve(file)) === path.join(home(), 'sessions') && /^[a-f0-9-]{36}\.json$/.test(path.basename(file)) &&
      value && typeof value === 'object' && Object.hasOwn(value, 'goalValidation')) {
    const { goalValidation: _projection, ...persisted } = value; value = persisted;
  }
  privateDir(path.dirname(file));
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
  } finally { fs.rmSync(temp, { force: true }); }
}
