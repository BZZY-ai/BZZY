import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

export function processIdentity(pid = process.pid, platform = process.platform) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    process.kill(pid, 0);
    if (platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (fields[0] === 'Z') return null;
      return { pid, boot: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), start: fields[19], ppid: Number(fields[1]), pgid: Number(fields[2]) };
    }
    if (platform === 'darwin') {
      const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'stat=', '-o', 'ppid=', '-o', 'pgid='],
        { encoding: 'utf8', timeout: 1000, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } });
      const match = result.status === 0 && /^(.*?)\s+(\S+)\s+(\d+)\s+(\d+)\s*$/.exec(result.stdout.trim());
      if (!match || !match[1] || match[2].includes('Z')) return null;
      return { pid, platform: 'darwin', start: match[1], ppid: Number(match[3]), pgid: Number(match[4]) };
    }
    return { pid, start: 'platform-unverified' };
  } catch { return null; }
}
export function identityAlive(identity) {
  if (!identity) return false;
  const current = processIdentity(identity.pid, identity.platform || process.platform);
  if (identity.start === 'platform-unverified') return Boolean(current); // Legacy records: liveness only, never authority to signal a group.
  return Boolean(current && current.start === identity.start && current.boot === identity.boot);
}
export function signalProcess(identity, signal, { group = false } = {}) {
  if (!identity || identity.start === 'platform-unverified' || !identityAlive(identity)) return false;
  if (group && identity.pgid != null && identity.pgid !== identity.pid) return false;
  try { process.kill(group ? -identity.pid : identity.pid, signal); return true; }
  catch (error) { if (error.code !== 'ESRCH') throw error; return false; }
}
