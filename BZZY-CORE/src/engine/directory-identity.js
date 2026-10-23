import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

// macOS can assign a different st_dev after a reboot/remount. A volume UUID
// plus the directory inode remains stable without accepting a different volume.
function volumeIdentity(directory, run = spawnSync) {
  const options = { encoding: 'utf8', timeout: 2000, maxBuffer: 256 * 1024, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C' } };
  const mounted = run('/bin/df', ['-P', directory], options);
  if (mounted.error || mounted.status !== 0) return null;
  const device = mounted.stdout.trim().split('\n').at(-1)?.trim().split(/\s+/)[0];
  if (!/^\/dev\/disk\d+(?:s\d+)*$/.test(device || '')) return null;
  const result = run('/usr/sbin/diskutil', ['info', '-plist', device], options);
  if (result.error || result.status !== 0) return null;
  return result.stdout.match(/<key>VolumeUUID<\/key>\s*<string>([A-Fa-f0-9-]{36})<\/string>/)?.[1]?.toLowerCase() || null;
}
export function directoryIdentity(directory, { platform = process.platform, run } = {}) {
  const stat = fs.lstatSync(directory);
  const volume = platform === 'darwin' ? volumeIdentity(directory, run) : null;
  const current = fs.lstatSync(directory);
  if (stat.dev !== current.dev || stat.ino !== current.ino) throw new Error('Directory changed while its identity was checked.');
  return { dev: String(stat.dev), ino: String(stat.ino), ...(volume ? { volume } : {}) };
}
export function sameDirectoryIdentity(left, right) {
  return Boolean(left && right && left.ino === right.ino &&
    (left.volume && right.volume ? left.volume === right.volume : left.dev === right.dev));
}
export function matchesDirectoryIdentity(directory, expected, stat = fs.lstatSync(directory)) {
  if (!expected || expected.ino !== String(stat.ino)) return false;
  if (expected.dev === String(stat.dev)) return true;
  return Boolean(expected.volume && sameDirectoryIdentity(expected, directoryIdentity(directory)));
}
