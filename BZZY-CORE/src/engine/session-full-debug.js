import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { transaction, getRecord, digest, now } from './database.js';
import { home, privateDir } from './files.js';
import { sessionMetricsFamily } from './session-metrics.js';
import { exportSessionDebug, sessionDebugFilename, diagnosticPrivateOperation } from './session-debug.js';
import { diagnosticRedactor } from './diagnostic-redaction.js';
import { sharedSecrets, assertShareText } from './share-bundle-policy.js';
import { privateWorkspacePath } from './private-paths.js';
import { skillVersionForDiagnostics } from './skills.js';
import { debugExportFailure, wrapDebugExportFailure } from './debug-export-errors.js';

const within = (root, value) => value === root || value.startsWith(root + path.sep);
const fileLimit = 64 * 1024 * 1024, totalLimit = 4 * 1024 * 1024 * 1024;
const kinds = new Set(['session', 'goal-history', 'goal-event', 'checkpoint', 'issue', 'memory', 'activity', 'artifact', 'artifact-read', 'artifact-import',
  'snapshot', 'run', 'execution', 'operation', 'acceptance', 'assessment', 'assignment', 'round', 'worker-report', 'review', 'recovery', 'coordination-history',
  'parallel', 'parallel-result', 'besties', 'besties-result', 'conversation-debate', 'peer-message', 'peer-review', 'peer-cursor', 'question', 'control',
  'assignment-control', 'assignment-context', 'assignment-context-answer', 'assignment-apply', 'subagent-invocation', 'native-compaction', 'core.usage', 'core.mission.context']);
const kindPrefix = /^core\.(?:session\.(?:memory|compactor)|learning|episode|resolution|project\.facts|retrieval|memory\.revision|issue\.revision|checkpoint\.(?:revision|scope|request)|conversation\.(?:source|pending)|history\.maintenance|task-state\.read|knowledge\.cursor|workflow\.(?:binding|goal-binding|work-unit|consultation)|skill\.(?:candidate|history|deleted|archived|usage|feedback|outcome|update|evolution|curation))(?:\.|$)/;
const settings = new Set(['core.learning.settings', 'core.session.compactor.settings', 'core.background-model', 'core.skill.evolution.settings']);
const relation = /^(?:sessionId|parentSessionId|sourceSessionId|rootSessionId|workerSessionId|reviewSessionId|documentSourceSessionId|learningSourceSessionId|jobId|learningJobId|documentTaskId|assignmentId|goalId|sourceGoalId|missionContextId|nodeId|candidateId|evaluationId|reservationId|skillId)$/;
const projectKinds = /^(?:memory|issue|checkpoint|core\.(?:memory|issue|checkpoint|knowledge|project\.facts|retrieval\.settings|resolution|skill\.candidate))/;
const safeKind = kind => kinds.has(kind) || /^debate(?:-|$)/.test(kind) || kindPrefix.test(kind) || settings.has(kind);
const progressPhases = new Set(['session', 'destination', 'staging', 'overview', 'history', 'workspace', 'resources', 'manifest', 'packaging', 'complete']);
const progressFields = ['records', 'events', 'files', 'bytes', 'exclusions', 'packagedFiles', 'packagedBytes'];
function progressReporter(onProgress) {
  const started = Date.now(), counts = Object.fromEntries(progressFields.map(key => [key, 0]));
  let phase = 'session', lastSent = 0;
  const emit = force => {
    const clock = Date.now(); if (!force && clock - lastSent < 250) return;
    lastSent = clock;
    try { onProgress?.({ phase, elapsedMs: Math.max(0, clock - started), ...counts }); } catch { /* Display must never fail or replay capture. */ }
  };
  emit(true);
  return { get phase() { return phase; }, set phase(value) { if (progressPhases.has(value)) { phase = value; emit(true); } },
    update(values = {}, force = false) {
      for (const key of progressFields) if (Number.isSafeInteger(values[key]) && values[key] >= 0) counts[key] = values[key];
      emit(force);
    } };
}
const references = (value, found = []) => {
  if (!value || typeof value !== 'object') return found;
  for (const [key, child] of Object.entries(value)) {
    if (relation.test(key) && typeof child === 'string') found.push(child);
    else if (child && typeof child === 'object') references(child, found);
  }
  return found;
};

function readFile(file) {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n) throw new Error('unsafe_file');
    if (before.size > BigInt(fileLimit)) throw new Error('file_limit');
    const data = fs.readFileSync(descriptor), after = fs.fstatSync(descriptor, { bigint: true });
    if (BigInt(data.length) !== before.size || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) throw new Error('changed_during_capture');
    return data;
  } finally { fs.closeSync(descriptor); }
}

function zip(source, destination, progress) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', [fileURLToPath(new URL('./debug-archive.py', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', error = '', result, malformed = false;
    child.stdout.on('data', data => {
      output += data;
      let newline;
      while ((newline = output.indexOf('\n')) >= 0) {
        const line = output.slice(0, newline); output = output.slice(newline + 1);
        if (line.length > 4096) { malformed = true; continue; }
        try {
          const value = JSON.parse(line);
          if (value.type === 'progress') progress.update({ packagedFiles: value.files, packagedBytes: value.bytes });
          else if (value.type === 'complete' && Number.isSafeInteger(value.bytes) && value.bytes >= 0) result = { bytes: value.bytes };
          else malformed = true;
        } catch { malformed = true; }
      }
      if (output.length > 4096) { malformed = true; output = ''; }
    }); child.stderr.on('data', data => { error = (error + data).slice(-2000); });
    child.once('error', cause => reject(debugExportFailure(cause.code === 'ENOENT' ? 'SESSION_DEBUG_PYTHON' : 'SESSION_DEBUG_PACKAGE')));
    child.stdin.on('error', () => {});
    child.once('close', code => {
      if (code) reject(debugExportFailure(/FileExistsError/.test(error) ? 'SESSION_DEBUG_EXISTS' : /ENOSPC|No space left|Disk quota exceeded/.test(error) ? 'SESSION_DEBUG_SPACE'
        : /PermissionError/.test(error) ? 'SESSION_DEBUG_ACCESS' : /FileNotFoundError/.test(error) ? 'SESSION_DEBUG_MISSING' : 'SESSION_DEBUG_PACKAGE'));
      else if (result && !malformed && !output.trim()) { progress.update({}, true); resolve(result); }
      else reject(debugExportFailure('SESSION_DEBUG_PACKAGE'));
    });
    child.stdin.end(JSON.stringify({ source, destination }));
  });
}

function eventData(type, original) {
  const data = structuredClone(original);
  if (type === 'backend' && data && typeof data === 'object') {
    if (/reasoning|thinking|analysis/i.test(data.method || '')) return { omitted: 'private-reasoning' };
    const params = data.params || {}, item = params.item;
    if (/outputDelta|agentMessage\/delta/i.test(data.method || '')) return { method: data.method, params: { itemId: params.itemId, turnId: params.turnId,
      deltaCharacters: typeof params.delta === 'string' ? params.delta.length : null, content: '[see completed tool output or conversation messages; unsafe split credential fragments are not copied]' } };
    if (item && diagnosticPrivateOperation(item.command || item.arguments)) {
      for (const field of ['aggregatedOutput', 'result', 'contentItems', 'output']) if (field in item) item[field] = '[omitted: private operation]';
    }
    if (item?.type === 'fileChange') item.changes = (item.changes || []).map(change => diagnosticPrivateOperation(change.path) ? { path: '[private path]', diff: '[omitted: private operation]' } : change);
  }
  return data;
}

// A deliberately separate owner-local diagnostic artifact, not an importable
// project backup. It captures all scoped saved records without report field
// clipping, plus individually validated filesystem context and explicit omissions.
export async function exportFullSessionDebug(sessionId, { cwd, output, at = new Date(), onProgress } = {}) {
  const progress = progressReporter(onProgress);
  try { const result = await captureFullSessionDebug(sessionId, { cwd, output, at }, progress); progress.phase = 'complete'; return result; }
  catch (error) { throw wrapDebugExportFailure(error, progress.phase); }
}

// The CLI uses this Core-owned worker so synchronous SQLite, redaction and file
// capture cannot freeze its event loop. The inline API remains available to
// trusted local callers and fault-injection tests; both use the same capture.
export function exportFullSessionDebugInWorker(sessionId, { cwd, output, at = new Date(), onProgress } = {}) {
  return new Promise((resolve, reject) => {
    let worker, result, failure, phase = 'session';
    try {
      worker = new Worker(new URL('./session-full-debug-worker.js', import.meta.url), {
        workerData: { sessionId, options: { cwd, output, at } }, execArgv: [], stdout: true, stderr: true });
    } catch (error) { reject(wrapDebugExportFailure(error, phase)); return; }
    // Never forward module warnings or raw worker exceptions to the terminal.
    worker.stdout.resume(); worker.stderr.resume();
    worker.on('message', message => {
      if (message?.type === 'progress' && progressPhases.has(message.value?.phase)) {
        phase = message.value.phase;
        const value = { phase, elapsedMs: Number.isSafeInteger(message.value.elapsedMs) && message.value.elapsedMs >= 0 ? message.value.elapsedMs : 0 };
        for (const key of progressFields) if (Number.isSafeInteger(message.value[key]) && message.value[key] >= 0) value[key] = message.value[key];
        try { onProgress?.(value); } catch { /* Progress cannot change the archive result. */ }
      } else if (message?.type === 'result') result = message.value;
      else if (message?.type === 'error') failure = wrapDebugExportFailure(message.value, message.value?.exportPhase || phase);
    });
    worker.once('error', error => { failure = wrapDebugExportFailure(error, phase); });
    worker.once('exit', code => {
      if (failure) reject(failure);
      else if (code !== 0 || !result) reject(wrapDebugExportFailure(debugExportFailure('SESSION_DEBUG_FAILED'), phase));
      else resolve(result);
    });
  });
}

async function captureFullSessionDebug(sessionId, { cwd, output, at }, progress) {
  const root = getRecord('session', sessionId);
  if (!root || typeof root !== 'object' || Array.isArray(root) || root.parentSessionId || root.purpose && root.purpose !== 'terminal' || getRecord('session-deletion', sessionId)) throw debugExportFailure('SESSION_DEBUG_SESSION');
  if (output !== undefined && (typeof output !== 'string' || !/\.zip$/i.test(output))) throw debugExportFailure('SESSION_DEBUG_OUTPUT');
  progress.phase = 'destination';
  const destinationRoot = fs.realpathSync(cwd || root.cwd), defaultName = sessionDebugFilename(root.alias || root.id.slice(0, 8), at).replace('_debug_', '_full_debug_').replace(/\.md$/, '.zip');
  progress.phase = 'staging';
  const stageRoot = path.join(home(), 'debug-exports'); privateDir(stageRoot);
  if (fs.lstatSync(stageRoot).isSymbolicLink()) throw debugExportFailure('SESSION_DEBUG_STAGING');
  const secrets = sharedSecrets(), projectRoot = root.projectRoot || root.cwd;
  const { scrub, stats } = diagnosticRedactor({ roots: [projectRoot, root.cwd, home()], secrets, maxString: Infinity, maxItems: Infinity, maxDepth: Infinity, maxFields: Infinity });
  const stage = fs.mkdtempSync(path.join(stageRoot, '.full-')); fs.chmodSync(stage, 0o700);
  const manifest = { format: 'bzzy-full-session-debug', version: 1, sessionId, exportedAt: now(), exclusions: [], inventory: [],
    scope: 'Selected terminal, linked workers and derived learning/compaction sessions; project-shared knowledge and complete project files/notes/ledgers.',
    safety: 'Credentials, private authentication stores, host account bindings and private provider reasoning are excluded. This is private execution data; review before sharing.',
    capture: 'Database streams share one read-only cutoff. Files are individually checked after that cutoff; a live filesystem is not an atomic workspace snapshot.',
    transformations: ['Conversation text events reference complete scrubbed logical messages to prevent split credential leakage.',
      'Native streamed deltas retain metadata; their text is represented by completed output/messages when recorded.', 'JSON/JSONL files are structurally scrubbed. Source and exported hashes differ after redaction.'] };
  let total = 0;
  const omit = (name, reason, detail = {}) => {
    manifest.exclusions.push({ path: scrub(name), reason, ...detail }); progress.update({ exclusions: manifest.exclusions.length });
  };
  const write = (name, data, source = {}) => {
    if (path.posix.isAbsolute(name) || name.split('/').some(part => part === '..' || !part)) throw new Error('Unsafe debug archive path.');
    total += data.length; if (total > totalLimit) throw debugExportFailure('SESSION_DEBUG_SIZE');
    const file = path.join(stage, name); privateDir(path.dirname(file)); fs.writeFileSync(file, data, { mode: 0o600, flag: 'wx' });
    manifest.inventory.push({ path: name, bytes: data.length, sha256: digest(data), ...source });
    progress.update({ files: manifest.inventory.length, bytes: total });
  };
  const encode = value => Buffer.from(JSON.stringify(scrub(value)) + '\n');
  const captureBytes = (name, data) => {
    const sourceSha256 = digest(data), sourceBytes = data.length;
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(data); if (text.includes('\0')) text = undefined; } catch { /* Preserve safe binary resources as bytes. */ }
    if (text === undefined) {
      if (data.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4])) || data.subarray(0, 2).equals(Buffer.from([31, 139])) || data.subarray(0, 16).toString() === 'SQLite format 3\0') { omit(name, 'opaque_archive_or_database'); return; }
      const visible = data.toString('latin1');
      try { assertShareText(visible, secrets); } catch { omit(name, 'credential_in_binary'); return; }
      if (/\b(?:authorization|set-cookie|cookie|password|passwd|api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret)\s*[:=]|\bAKIA[A-Z0-9]{16}\b|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/i.test(visible)) { omit(name, 'credential_in_binary'); return; }
      write(name, data, { sourceSha256, sourceBytes, encoding: 'binary' }); return;
    }
    let cleaned;
    if (/\.jsonl$/i.test(name)) cleaned = text.split('\n').map(line => line.trim() ? JSON.stringify(scrub(JSON.parse(line))) : '').join('\n');
    else if (/^\s*[{[]/.test(text) || /\.(?:json|har)$/i.test(name)) {
      let parsed, valid = false;
      try { parsed = JSON.parse(text); valid = true; } catch { if (/\.(?:json|har)$/i.test(name)) throw new Error('unparseable_structured_data'); }
      cleaned = valid ? JSON.stringify(scrub(parsed), null, 2) + '\n' : scrub(text);
    } else cleaned = scrub(text);
    assertShareText(cleaned, secrets);
    write(name, Buffer.from(cleaned), { sourceSha256, sourceBytes, encoding: 'utf8', redacted: cleaned !== text });
  };
  const stream = name => {
    const file = path.join(stage, name); privateDir(path.dirname(file)); const fd = fs.openSync(file, 'wx', 0o600), hash = createHash('sha256'); let bytes = 0;
    return { row(value) { const data = encode(value); bytes += data.length; total += data.length; if (total > totalLimit) throw debugExportFailure('SESSION_DEBUG_SIZE');
      hash.update(data); let offset = 0; while (offset < data.length) offset += fs.writeSync(fd, data, offset); progress.update({ bytes: total }); },
    close() { try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      manifest.inventory.push({ path: name, bytes, sha256: hash.digest('hex'), encoding: 'jsonl' });
      progress.update({ files: manifest.inventory.length, bytes: total }); } };
  };
  let selected, sessionIds, overview;
  const skillRefs = new Map();
  try {
    progress.phase = 'overview';
    // The familiar overview is supplementary and retains its own labeled cutoff
    // and field limits. The separate full streams below are authoritative here.
    try { overview = exportSessionDebug(sessionId, { cwd: stage, output: 'overview.md', at }); }
    catch {
      overview = { savedEvents: null, unavailable: true };
      fs.writeFileSync(path.join(stage, 'overview.md'), '# Overview unavailable\n\nUse manifest.json and the full session JSONL streams. The supplementary bounded overview could not be generated.\n', { mode: 0o600, flag: 'wx' });
    }
    const overviewBytes = fs.statSync(path.join(stage, 'overview.md')).size; total += overviewBytes;
    manifest.inventory.push({ path: 'overview.md', bytes: overviewBytes, bounded: true });
    progress.update({ files: manifest.inventory.length, bytes: total });
    progress.phase = 'history';
    transaction(db => {
      const relatives = sessionMetricsFamily(sessionId, { full: true });
      const sessions = db.prepare("SELECT id,data FROM records WHERE kind='session'").all().map(row => ({ id: row.id, data: JSON.parse(row.data) }));
      const allSessionIds = new Set(sessions.map(row => row.id));
      sessionIds = new Set(relatives.sessionIds);
      for (let size = -1; size !== sessionIds.size;) {
        size = sessionIds.size;
        for (const row of sessions) if (!getRecord('session-deletion', row.id) && row.data?.purpose !== 'agent' &&
          [row.data?.parentSessionId, row.data?.documentSourceSessionId, row.data?.learningSourceSessionId].some(id => sessionIds.has(id))) sessionIds.add(row.id);
      }
      const projectIds = new Set(sessions.filter(row => sessionIds.has(row.id)).map(row => row.data?.projectId).filter(Boolean));
      const rawRecords = db.prepare('SELECT kind,id,data,updated_at AS updatedAt FROM records').all();
      const candidates = rawRecords.filter(row => safeKind(row.kind)).map(row => ({ ...row, data: JSON.parse(row.data) }));
      manifest.excludedRecordKinds = {};
      for (const row of rawRecords) if (!safeKind(row.kind)) {
        const value = JSON.parse(row.data);
        if (sessionIds.has(row.id) || [value?.sessionId, value?.parentSessionId, value?.sourceSessionId].some(id => sessionIds.has(id))) manifest.excludedRecordKinds[row.kind] = (manifest.excludedRecordKinds[row.kind] || 0) + 1;
      }
      manifest.recordPolicy = 'Allowlisted scoped execution, memory, compactor, learning and provenance records; unrelated/global account, profile, device, grant and private binding records are excluded.';
      const related = new Set(sessionIds); for (const row of sessions) if (sessionIds.has(row.id) && row.data?.goal?.id) related.add(row.data.goal.id);
      selected = new Map();
      for (let size = -1; size !== selected.size;) {
        size = selected.size;
        for (const row of candidates) {
          const key = `${row.kind}:${row.id}`; if (selected.has(key)) continue;
          if (row.kind === 'session' && !sessionIds.has(row.id)) continue;
          if (projectKinds.test(row.kind) && row.data?.projectId && !projectIds.has(row.data.projectId)) continue;
          if (row.data?.sessionId && allSessionIds.has(row.data.sessionId) && !sessionIds.has(row.data.sessionId) && !projectKinds.test(row.kind)) continue;
          if (related.has(row.id) || references(row.data).some(id => related.has(id)) || projectKinds.test(row.kind) && projectIds.has(row.data?.projectId) || settings.has(row.kind) ||
            row.kind === 'core.knowledge.cursor' && [...projectIds].some(id => row.id.startsWith(`history:${id}:`))) {
            selected.set(key, row); related.add(row.id);
            progress.update({ records: selected.size });
            for (const id of references(row.data)) related.add(id);
          }
        }
      }
      const days = new Set([...selected.values()].filter(row => /reservation$/.test(row.kind)).map(row => row.data?.day).filter(Boolean));
      for (const row of candidates) if (/^core\.(?:learning|session\.compactor)\.usage$/.test(row.kind) && days.has(row.data?.day || row.id)) selected.set(`${row.kind}:${row.id}`, row);
      manifest.cutoffSeq = db.prepare('SELECT coalesce(max(seq),0) AS seq FROM events').get().seq;
      manifest.sessionIds = [...sessionIds]; manifest.records = selected.size;
      progress.update({ records: selected.size }, true);
      const records = stream('session/records.jsonl');
      try { for (const row of selected.values()) records.row(row); } finally { records.close(); }
      const events = stream('session/events.jsonl'), pending = new Map(); let messages, count = 0;
      const flush = id => { const message = pending.get(id); if (message) { messages.row(message); pending.delete(id); } };
      try {
        messages = stream('session/messages.jsonl');
        for (const row of db.prepare('SELECT seq,session_id AS sessionId,type,data,created_at AS createdAt FROM events WHERE session_id IN (SELECT value FROM json_each(?)) AND seq<=? ORDER BY seq').iterate(JSON.stringify([...sessionIds]), manifest.cutoffSeq)) {
          const data = JSON.parse(row.data), metadata = data && typeof data === 'object' ? data : {}; count++;
          progress.update({ events: count });
          const skillId = row.type === 'core.usage' && metadata.kind === 'skill' ? metadata.skillId : row.type === 'skill.loaded' ? metadata.skillId : null;
          const skillVersion = row.type === 'core.usage' ? metadata.skillVersion : metadata.version;
          if (skillId && /^[a-f0-9]{64}$/.test(skillVersion || '')) skillRefs.set(`${skillId}:${skillVersion}`, { id: skillId, version: skillVersion, owner: getRecord('session', row.sessionId) });
          if (row.type === 'text' && typeof metadata.text === 'string') {
            let message = pending.get(row.sessionId);
            if (message && message.itemId !== data.itemId) { flush(row.sessionId); message = null; }
            if (!message) { message = { id: `${row.sessionId}:${row.seq}`, sessionId: row.sessionId, firstSeq: row.seq, lastSeq: row.seq, itemId: data.itemId, sourceBytes: 0, text: '' }; pending.set(row.sessionId, message); }
            const addedBytes = Buffer.byteLength(data.text);
            if (message.sourceBytes + addedBytes > fileLimit) throw debugExportFailure('SESSION_DEBUG_SIZE');
            const sourceOffset = message.text.length; message.text += data.text; message.sourceBytes += addedBytes; message.lastSeq = row.seq;
            const { text: _text, ...metadata } = data;
            events.row({ ...row, data: { ...metadata, textRef: { messageId: message.id, sourceOffset, sourceCharacters: data.text.length, sourceSha256: digest(data.text) } } });
          } else {
            if (['message.user', 'tool', 'coordination.tool', 'lifecycle'].includes(row.type) || row.type === 'backend' && /item\/(?:started|completed)|turn\/completed/.test(metadata.method || '')) flush(row.sessionId);
            events.row({ ...row, data: eventData(row.type, data) });
          }
        }
        for (const id of pending.keys()) flush(id); manifest.events = count;
        progress.update({ events: count }, true);
      } finally { try { events.close(); } finally { messages?.close(); } }
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='knowledge_documents'").get()) {
        const index = stream('memory/knowledge-index.jsonl');
        try { for (const row of db.prepare('SELECT key,project_id AS projectId,session_id AS sessionId,kind,source_id AS sourceId,body,payload,updated_at AS updatedAt FROM knowledge_documents WHERE session_id IN (SELECT value FROM json_each(?)) OR (project_id IN (SELECT value FROM json_each(?)) AND kind<>\'chat\') ORDER BY key').iterate(JSON.stringify([...sessionIds]), JSON.stringify([...projectIds]))) index.row({ ...row, payload: JSON.parse(row.payload) }); }
        finally { index.close(); }
      }
    }, { readOnly: true });

    progress.phase = 'workspace';
    const copied = new Set(), excludeRoot = value => within(stageRoot, value) || value === path.resolve(destinationRoot, output || defaultName);
    const walk = (source, archive, sourceRoot = source, relative = '') => {
      if (excludeRoot(source)) { omit(archive, 'debug_export_storage'); return; }
      const parts = relative.split(path.sep), inspected = parts[0] === '.bzzy' ? parts.slice(1).join('/') : relative;
      if (relative && (privateWorkspacePath(inspected) || parts.includes('.git') || parts.includes('.DS_Store') || parts.some(part => /^(?:credentials|bindings|accounts|cookies)(?:\.|$)/i.test(part)) ||
        parts[0] === '.bzzy' && parts[1] === 'runtime' || /\.(?:sqlite\d*|db|zip|7z|tar|tgz|gz|rar|p12|pfx)$/i.test(path.basename(source)) ||
        /_(?:full_)?debug_\d{8}(?:_\d+)?\.(?:md|txt|zip)$/i.test(path.basename(source)))) { omit(archive, 'private_opaque_or_generated_path'); return; }
      let stat; try { stat = fs.lstatSync(source); } catch (error) { omit(archive, error.code === 'ENOENT' ? 'missing_source' : 'unreadable_source'); return; }
      if (stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile() || stat.isFile() && stat.nlink !== 1) { omit(archive, 'link_or_special_file'); return; }
      let canonicalRoot;
      try { canonicalRoot = fs.realpathSync(sourceRoot); if (!within(canonicalRoot, fs.realpathSync(source))) { omit(archive, 'outside_capture_root'); return; } }
      catch (error) { omit(archive, error.code === 'ENOENT' ? 'missing_source' : 'unreadable_source'); return; }
      if (copied.has(archive)) return; copied.add(archive);
      if (stat.isDirectory()) {
        // Every child is revalidated. No symlink is traversed into account or
        // unrelated host storage, and empty directories need no executable entry.
        let names;
        try { names = fs.readdirSync(source).sort(); }
        catch (error) { omit(archive, error.code === 'ENOENT' ? 'missing_source' : 'unreadable_source'); return; }
        for (const name of names) walk(path.join(source, name), archive + '/' + name, sourceRoot, relative ? path.join(relative, name) : name);
      } else {
        if (stat.size > fileLimit) { omit(archive, 'source_file_size_limit', { sourceBytes: stat.size, limitBytes: fileLimit }); return; }
        let data;
        try { assertShareText(archive, secrets); data = readFile(source); if (!within(fs.realpathSync(sourceRoot), fs.realpathSync(source))) throw new Error('changed_during_capture'); }
        catch (error) { omit(archive, error.message === 'file_limit' ? 'source_file_size_limit' : /credential/.test(error.message) ? 'credential_content' : 'changed_or_unreadable_source'); return; }
        try { captureBytes(archive, data); }
        catch (error) { if (error.code) throw error;
          omit(archive, /credential/.test(error.message) ? 'credential_content' : error instanceof SyntaxError || error.message === 'unparseable_structured_data' ? 'unparseable_structured_data' : 'unsafe_source_content'); }
      }
    };
    if (within(projectRoot, home()) || within(home(), projectRoot)) throw debugExportFailure('SESSION_DEBUG_PRIVATE_STORAGE');
    walk(projectRoot, 'workspace');
    for (const row of selected.values()) {
      if (row.kind === 'session' && ['executor', 'reviewer', 'peer', 'bestie'].includes(row.data?.role) && row.data.cwd && !within(projectRoot, row.data.cwd) && !within(home(), row.data.cwd)) walk(row.data.cwd, `workers/${row.id}`);
      if (!['artifact', 'snapshot', 'assignment', 'round'].includes(row.kind)) continue;
      for (const field of ['path', 'directory', 'workspace']) {
        const value = row.data?.[field];
        if (typeof value === 'string' && path.isAbsolute(value) && within(home(), value) && ['artifacts', 'snapshots', 'workers', 'besties', 'parallel'].includes(path.relative(home(), value).split(path.sep)[0])) walk(value, 'execution-files/' + path.relative(home(), value).split(path.sep).join('/'));
      }
    }
    progress.phase = 'resources';
    // Include complete, hash-checked skill resources, including safe binaries.
    const overviewLines = readline.createInterface({ input: fs.createReadStream(path.join(stage, 'overview.md')), crlfDelay: Infinity });
    for await (const line of overviewLines) if (line.startsWith('{"kind":"skill.version",')) {
      const row = JSON.parse(line); if (skillRefs.has(`${row.data.id}:${row.data.version}`)) continue;
      const owner = [...selected.values()].find(candidate => candidate.kind === 'session' && (!row.data.id.startsWith('project:') || candidate.data?.projectId && row.data.id.startsWith(`project:${candidate.data.projectId}:`)))?.data || root;
      skillRefs.set(`${row.data.id}:${row.data.version}`, { id: row.data.id, version: row.data.version, owner });
    }
    const skillMetadata = stream('library/skills/metadata.jsonl');
    try { for (const reference of skillRefs.values()) {
      let definition;
      try { definition = skillVersionForDiagnostics(reference.id, reference.version, { session: reference.owner }); }
      catch { omit(`library/skills/${reference.id}/${reference.version}`, 'version_unavailable'); continue; }
      skillMetadata.row(definition);
      for (const file of definition.files) {
        const name = `library/skills/${digest(reference.id).slice(0, 16)}/${reference.version}/${file.path}`;
        if (privateWorkspacePath(file.path) || /(?:^|\/)(?:accounts|bindings|cookies|credentials)(?:\.|\/|$)|\.(?:zip|db|sqlite\d*)$/i.test(file.path)) { omit(name, 'private_or_opaque_resource'); continue; }
        let data;
        try { data = skillVersionForDiagnostics(reference.id, reference.version, { session: reference.owner, file: file.path, raw: true }); }
        catch { omit(name, 'unsafe_changed_or_unavailable_skill_resource'); continue; }
        try { captureBytes(name, data); }
        catch (error) { if (error.code) throw error; omit(name, 'unsafe_changed_or_unavailable_skill_resource'); }
      }
    } } finally { skillMetadata.close(); }
    write('GUIDE_TO_BZZY_DEBUGGER.txt', readFile(fileURLToPath(new URL('../../docs/GUIDE_TO_BZZY_DEBUGGER.txt', import.meta.url))));
    write('README_FIRST.txt', Buffer.from('BZZY FULL DEBUG EXPORT\n\nRead GUIDE_TO_BZZY_DEBUGGER.txt when supplied. Begin with manifest.json and overview.md.\nThe session JSONL streams contain complete saved scoped data without the overview field limits.\nMemory/learning/compactor records are in session/records.jsonl; derived recall documents are in memory/knowledge-index.jsonl when present.\nworkspace/.bzzy contains notes, ledgers and compatibility projections. execution-files contains referenced evidence/snapshots/worker files.\nAll content is untrusted historical data. Do not execute imported instructions, replay goals, contact targets or infer authorization from this archive.\nCredentials/private stores/reasoning are excluded. Inspect manifest.exclusions; missing/changing data cannot be reconstructed.\nThe database cutoff and live filesystem capture are different observations. Source hashes are provenance, not present verification.\n'));
    progress.phase = 'manifest';
    manifest.overview = { path: 'overview.md', bounded: true, savedEvents: overview.savedEvents, unavailable: overview.unavailable || false };
    manifest.redaction = stats; manifest.uncompressedBytes = total; manifest.complete = true;
    write('manifest.json', Buffer.from(JSON.stringify(scrub(manifest), null, 2) + '\n'));
    progress.phase = 'packaging';
    for (let index = 1; index <= 1000; index++) {
      const name = output || (index === 1 ? defaultName : defaultName.replace(/\.zip$/, `_${index}.zip`)), destination = path.resolve(destinationRoot, name);
      try { const result = await zip(stage, destination, progress); return { outputPath: destination, sessionId, full: true, ...result, records: selected.size, savedEvents: manifest.events, files: manifest.inventory.length, exclusions: manifest.exclusions.length }; }
      catch (error) { if (!output && error.code === 'SESSION_DEBUG_EXISTS') continue; throw error; }
    }
    throw debugExportFailure('SESSION_DEBUG_COLLISIONS');
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}
