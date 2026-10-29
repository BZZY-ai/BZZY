import fs from 'node:fs';
import path from 'node:path';
import { privateWorkspacePath } from './private-paths.js';
import { diagnosticRedactor } from './diagnostic-redaction.js';

const sourceExtensions = /\.(?:[cm]?[jt]sx?|py|rb|go|rs|c|cc|cpp|h|hpp|java|kt|swift|sh|bash|zsh|ps1|sql|html?|css|scss|sass|vue|svelte|xml|ya?ml|toml|json|md|txt)$/i;
const inside = (root, target) => target !== root && !path.relative(root, target).startsWith('..' + path.sep) && path.relative(root, target) !== '..' && !path.isAbsolute(path.relative(root, target));
const maximumBytes = 256 * 1024;

// Owner-terminal presentation only. Never read a path inferred from prose or
// commands. Native edit metadata identifies candidates; canonical containment,
// private-path exclusions and a bounded regular-file read gate their preview.
// No recursive watcher, inference, execution or permission changes occur here.
export function sourcePreview(session, filename, { phase = 'completed', failed = false, callId, diff } = {}) {
  if (session.agentId || session.importedUntrusted || !session.cwd || typeof filename !== 'string' || filename.length > 4096) return null;
  let descriptor;
  try {
    const root = fs.realpathSync(session.cwd), target = path.resolve(root, filename);
    const relative = path.relative(root, target);
    if (!inside(root, target) || privateWorkspacePath(relative) || relative.split(path.sep).includes('.git') || !sourceExtensions.test(relative)) return null;
    const base = { path: relative, language: path.extname(relative).slice(1), phase: failed ? 'failed' : phase,
      callId, observedAt: new Date().toISOString(), provenance: 'native-file-edit', actorSessionId: session.id };
    if (phase === 'started' || failed) return base;
    const canonical = fs.realpathSync(target);
    if (!inside(root, canonical) || privateWorkspacePath(path.relative(root, canonical)) || canonical.split(path.sep).includes('.git')) return null;
    descriptor = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(descriptor), current = fs.statSync(canonical);
    if (!stat.isFile() || stat.nlink > 1 || stat.size > maximumBytes || stat.dev !== current.dev || stat.ino !== current.ino) return { ...base, unavailable: 'Source preview is oversized, hardlinked or not a regular file.' };
    const bytes = Buffer.alloc(maximumBytes + 1), count = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
    if (count > maximumBytes || bytes.subarray(0, count).includes(0)) return { ...base, unavailable: 'Binary or oversized source preview.' };
    const redactor = diagnosticRedactor({ maxString: maximumBytes, maxItems: 8 });
    const content = redactor.scrub(bytes.subarray(0, count).toString('utf8'));
    return { ...base, content, ...(typeof diff === 'string' && diff.length <= maximumBytes ? { diff: redactor.scrub(diff) } : {}), redacted: redactor.stats.redactedValues > 0 };
  } catch { return null; }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

export function createSourceObserver(session, emit) {
  const pending = new Map();
  return data => {
    const params = data.params || {}, item = params.item;
    let changes = [], phase, callId, failed = false;
    if (['item/started', 'item/completed'].includes(data.method) && item?.type === 'fileChange') {
      changes = item.changes || []; callId = item.id; phase = data.method === 'item/started' ? 'started' : 'completed'; failed = item.status === 'failed';
    } else if (data.method === 'tool.started' && /^(?:Write|Edit|MultiEdit)$/.test(params.name || '')) {
      if (typeof params.input?.file_path !== 'string') return;
      callId = params.id; changes = [{ path: params.input.file_path }]; phase = 'started';
      if (pending.size >= 64) pending.delete(pending.keys().next().value);
      pending.set(callId, changes);
    } else if (data.method === 'tool.completed' && pending.has(params.id)) {
      callId = params.id; changes = pending.get(callId); pending.delete(callId); phase = 'completed'; failed = Boolean(params.failed);
    }
    for (const change of Array.isArray(changes) ? changes.slice(0, 16) : []) {
      const preview = sourcePreview(session, change.path, { phase, callId, failed, diff: change.diff });
      if (preview) emit('source.changed', preview);
    }
  };
}
