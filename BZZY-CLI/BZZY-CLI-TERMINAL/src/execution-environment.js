import fs from 'node:fs';
import path from 'node:path';
import { home, writeJson, readJson } from './files.js';

const environmentFile = id => {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid execution ID.');
  return path.join(home(), 'runtime', `${id}-environment.json`);
};
export function captureEnvironment(environment = process.env) {
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) throw new Error('Execution environment must be an object.');
  const entries = Object.entries(environment);
  if (entries.some(([key, value]) => !key || /[=\0]/.test(key) || typeof value !== 'string' || value.includes('\0'))) throw new Error('Invalid execution environment variable.');
  if (Buffer.byteLength(JSON.stringify(environment)) > 192 * 1024) throw new Error('Execution environment exceeds 192 KiB.');
  return Object.fromEntries(entries);
}
export function saveExecutionEnvironment(id, environment) { writeJson(environmentFile(id), captureEnvironment(environment)); }
export function readExecutionEnvironment(id) { return readJson(environmentFile(id), null); }
export function removeExecutionEnvironment(id) { fs.rmSync(environmentFile(id), { force: true }); }
