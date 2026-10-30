import fs from 'node:fs';
import path from 'node:path';
import { privateWorkspacePath } from './private-paths.js';
import { diagnosticRedactor } from './diagnostic-redaction.js';
import { safeCommandSource } from './source-stream.js';
import { launchedSourceFile } from './command-source-file.js';

const sourceExtensions = /\.(?:[cm]?[jt]sx?|py|rb|go|rs|c|cc|cpp|h|hpp|java|kt|swift|sh|bash|zsh|ps1|sql|html?|css|scss|sass|vue|svelte|xml|ya?ml|toml|json|md|txt)$/i;
const inside = (root, target) => target !== root && !path.relative(root, target).startsWith('..' + path.sep) && path.relative(root, target) !== '..' && !path.isAbsolute(path.relative(root, target));
const maximumBytes = 256 * 1024;

// Owner-terminal presentation only. Native edits and explicit interpreter
// arguments identify candidates; never infer paths from prose or stdout. Containment,
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
  const pending = new Map(), commands = new Map();
  return data => {
    const params = data.params || {}, item = params.item;
    let changes = [], phase, callId, failed = false;
    const nativeCommand = ['item/started', 'item/completed'].includes(data.method) && item?.type === 'commandExecution';
    if (nativeCommand || data.method === 'tool.started' && params.name === 'Bash' || data.method === 'tool.completed' && commands.has(params.id)) {
      const id = nativeCommand ? item.id : params.id;
      const prior = commands.get(id);
      const command = nativeCommand ? item.command ?? prior?.command : data.method === 'tool.started' ? params.input?.command : prior?.command;
      const commandCwd = nativeCommand && typeof item.cwd === 'string' ? item.cwd : prior?.cwd || session.cwd;
      const done = nativeCommand ? data.method === 'item/completed' : data.method === 'tool.completed';
      const failed = nativeCommand ? item.status === 'failed' || Number.isInteger(item.exitCode) && item.exitCode !== 0 : params.failed;
      const preview = safeCommandSource(session, command, { callId: id, phase: failed ? 'failed' : done ? 'completed' : 'started' });
      if (preview) emit('source.changed', preview);
      const filename = launchedSourceFile(command);
      if (filename) {
        try {
          const root = fs.realpathSync(session.cwd), cwd = fs.realpathSync(path.resolve(session.cwd, commandCwd));
          const target = path.isAbsolute(filename) && inside(path.resolve(session.cwd), filename)
            ? path.resolve(root, path.relative(session.cwd, filename)) : path.resolve(cwd, filename);
          const file = sourcePreview(session, target, { callId: id });
          if (file) emit('source.changed', { ...file, sourceKind: 'executed-file', phase: failed ? 'failed' : done ? 'completed' : 'running', provenance: 'native-script-launch' });
        } catch { /* Missing source cannot change command execution or hide its input preview. */ }
      }
      if (!done) { if (commands.size >= 64) commands.delete(commands.keys().next().value); commands.set(id, { command, cwd: commandCwd }); } else commands.delete(id);
      return;
    }
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
