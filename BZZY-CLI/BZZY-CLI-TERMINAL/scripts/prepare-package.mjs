import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const siblingCore = path.resolve(root, '../../BZZY-CORE/package.json');
const installedCore = path.join(root, 'node_modules/@bzzy/core/package.json');
const installedDirectory = path.dirname(installedCore);

if (process.argv.includes('--restore')) {
  if (fs.existsSync(siblingCore)) {
    fs.rmSync(installedDirectory, { recursive: true, force: true });
    fs.symlinkSync(path.relative(path.dirname(installedDirectory), path.dirname(siblingCore)), installedDirectory, 'dir');
  }
  process.exit(0);
}

// Development uses a live Core symlink. Stage an allowlisted physical package
// for npm packing: nested bundled dependencies must not follow an external link.
// postpack restores the development link; the tarball needs no sibling checkout.
if (fs.existsSync(siblingCore)) {
  const npm = process.env.npm_execpath;
  if (!npm) throw new Error('Prepare the release with npm pack or npm publish.');
  for (const cwd of [path.dirname(siblingCore), root]) {
    const links = cwd === root ? '--install-links=false' : '--install-links=true';
    const result = spawnSync(process.execPath, [npm, 'ci', '--ignore-scripts', links, '--no-audit', '--no-fund'], { cwd, stdio: ['ignore', 2, 2] });
    if (result.error || result.status !== 0) throw new Error(`Could not prepare bundled Core: ${result.error?.message || `npm exited ${result.status}`}`);
  }
  fs.rmSync(installedDirectory, { recursive: true, force: true });
  fs.mkdirSync(installedDirectory, { recursive: true });
  const coreRoot = path.dirname(siblingCore), core = JSON.parse(fs.readFileSync(siblingCore, 'utf8'));
  for (const entry of ['package.json', ...core.files, 'node_modules']) {
    const source = path.join(coreRoot, entry);
    if (!fs.existsSync(source)) continue;
    fs.cpSync(source, path.join(installedDirectory, entry), { recursive: true,
      filter: file => !file.split(path.sep).some(name => name.startsWith('._') || name === '.DS_Store') });
  }
  // macOS can recreate AppleDouble files while copying onto removable media.
  // Strip them only from this disposable staging copy, never the source tree.
  const cleanStage = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.name.startsWith('._') || entry.name === '.DS_Store') fs.rmSync(file, { recursive: true, force: true });
      else if (entry.isDirectory()) cleanStage(file);
    }
  };
  cleanStage(installedDirectory);
}
if (!fs.existsSync(installedCore)) throw new Error('Missing BZZY Core. Keep the BZZY workspace layout and run npm ci --ignore-scripts before packing.');
if (fs.lstatSync(installedDirectory).isSymbolicLink()) throw new Error('Core must be staged as a physical package for distribution. Run npm pack with its prepack script enabled.');
