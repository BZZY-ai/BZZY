import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const dependencies = path.join(root, 'node_modules');
const staging = path.join(root, '.bzzy-package');
const original = path.join(staging, 'original');
const sanitized = path.join(staging, 'sanitized');

function restore() {
  if (!fs.existsSync(staging)) return;
  if (fs.existsSync(original)) {
    fs.rmSync(dependencies, { recursive: true, force: true });
    fs.renameSync(original, dependencies);
  }
  fs.rmSync(staging, { recursive: true, force: true });
}

if (process.argv.includes('--restore')) {
  restore();
  process.exit(0);
}

if (fs.existsSync(staging)) throw new Error('A Core packaging stage already exists. If no package operation is running, run npm run postpack to restore it before retrying.');
if (!fs.existsSync(path.join(dependencies, '@bzzy/relay/package.json'))) throw new Error('Core packaging requires its locked Relay SDK. Run npm ci --ignore-scripts first.');

// npm includes AppleDouble files from bundled dependencies on removable media.
// Swap in a disposable copy; original dependency files and their metadata remain
// untouched in the backup directory until postpack puts them back in place.
fs.mkdirSync(staging, { mode: 0o700 });
try {
  fs.cpSync(dependencies, sanitized, { recursive: true, dereference: true,
    filter: file => !file.split(path.sep).some(name => name.startsWith('._') || name === '.DS_Store') });
  const clean = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.name.startsWith('._') || entry.name === '.DS_Store') fs.rmSync(file, { recursive: true, force: true });
      else if (entry.isDirectory()) clean(file);
    }
  };
  clean(sanitized);
  fs.renameSync(dependencies, original);
  fs.renameSync(sanitized, dependencies);
} catch (error) {
  restore();
  throw error;
}
