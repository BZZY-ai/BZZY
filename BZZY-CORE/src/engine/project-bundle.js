import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { transaction, getRecord, putRecord, appendEvent, digest } from './database.js';
import { home, privateDir, writeJson } from './files.js';
import { loadSession, sessionPath, sessions } from './store.js';
import { assertSessionIdle } from './models.js';
import { config, updateConfig } from './providers.js';
import { codexHome, claudeHome, claudeAuthHomes } from './auth.js';
import { conversationCursor } from './conversation.js';
import { sharedKinds, portableState, sharedSecrets, assertShareText, validateSharedManifest, stripWorkflowAuthority, SHARE_LIMITS } from './share-bundle-policy.js';
import { canonicalPath } from '../paths.js';
import { resolveProjectIdentity, sessionBelongsToProject } from './project-identity.js';

const helper = fileURLToPath(new URL('./archive.py', import.meta.url));
const uuid = /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi;
const ephemeral = kind => /^(?:telegram-|access-token$|input-owner$|account-status$|outbox$|notification|run$|control$|assignment-control$|assignment-context$|core\.(?:learning|skill|knowledge|project|memory|checkpoint|issue|mission|workflow)(?:\.|$))/.test(kind);
const within = (file, root) => file === root || file.startsWith(root + path.sep);
const present = file => { try { fs.lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };

async function archive(operation, spec) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', [helper, operation], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', error = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { error = (error + chunk).slice(-4000); });
    child.once('error', cause => reject(new Error(cause.code === 'ENOENT' ? 'Project ZIP export/import requires python3.' : cause.message)));
    child.stdin.on('error', () => {});
    child.once('close', code => {
      if (code !== 0) reject(new Error(error.trim() || `ZIP ${operation} failed (${code}).`));
      else { try { resolve(JSON.parse(output)); } catch { reject(new Error('Invalid ZIP helper response.')); } }
    });
    child.stdin.end(JSON.stringify(spec));
  });
}

function strings(value) {
  if (typeof value === 'string') return [value];
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}
function withoutTokens(value) {
  if (Array.isArray(value)) return value.map(withoutTokens);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !['token', 'nonce'].includes(key)).map(([key, item]) => [key, withoutTokens(item)]));
}

export function collectProjectState(root, sessionId, { shared = false, sessionTreeOnly = false } = {}) {
  sessions(); // Reconcile compatibility exports before taking one consistent database snapshot.
  const project = resolveProjectIdentity(root);
  return transaction(db => {
    const candidates = db.prepare('SELECT kind,id,data FROM records').all().filter(row => shared ? sharedKinds.has(row.kind) : !ephemeral(row.kind)).map(row => ({ ...row, data: withoutTokens(stripWorkflowAuthority(JSON.parse(row.data))) }));
    const eligible = row => row.kind === 'session' && !['skill-writer', 'learning-review', 'knowledge-review'].includes(row.data.role);
    const selected = new Set(candidates.filter(row => eligible(row) && (row.id === sessionId || !sessionTreeOnly && sessionBelongsToProject(row.data, project))).map(row => row.id));
    // Legacy workers can have a private cwd and only a parent session binding.
    // Preserve that trusted ancestry without pulling in a separately scoped Agent
    // or another engagement merely because it sits under this directory.
    for (let previous = -1; previous !== selected.size;) {
      previous = selected.size;
      for (const row of candidates) if (eligible(row) && selected.has(row.data.parentSessionId) &&
        (sessionBelongsToProject(row.data, project) || !row.data.projectId && !row.data.projectRoot && row.data.purpose !== 'agent')) selected.add(row.id);
    }
    const allSessions = new Set(candidates.filter(row => row.kind === 'session').map(row => row.id));
    const rows = candidates.filter(row => row.kind !== 'session' || selected.has(row.id))
      .filter(row => !row.data.sessionId || !allSessions.has(row.data.sessionId) || selected.has(row.data.sessionId))
      .filter(row => !['memory', 'issue', 'checkpoint'].includes(row.kind) || !row.data.projectId || row.data.projectId === project.id);
    const included = new Set(), related = new Set(selected);
    let changed = true;
    while (changed) {
      changed = false;
      for (const [index, row] of rows.entries()) {
        if (included.has(index)) continue;
        if (sessionTreeOnly && (row.kind === 'session' && !selected.has(row.id) ||
          allSessions.has(row.id) && !selected.has(row.id) ||
          typeof row.data.sessionId === 'string' && allSessions.has(row.data.sessionId) && !selected.has(row.data.sessionId))) continue;
        if (related.has(row.id) || strings(row.data).some(value => related.has(value) || value === root)) {
          included.add(index); related.add(row.id); changed = true;
          if (row.kind === 'session') { selected.add(row.id); if (row.data.goal?.id) related.add(row.data.goal.id); }
        }
      }
    }
    const records = rows.filter((_row, index) => included.has(index));
    const events = db.prepare('SELECT seq,session_id AS sessionId,type,data,created_at AS createdAt FROM events WHERE session_id IN (SELECT value FROM json_each(?)) ORDER BY seq')
      .all(JSON.stringify([...selected])).map(event => ({ ...event, data: withoutTokens(stripWorkflowAuthority(JSON.parse(event.data))) }));
    return { records, events };
  }, { readOnly: true });
}

function nativeFiles(session) {
  const id = session.engineThreadId;
  if (!id) return [];
  const directory = session.backend === 'claude' ? claudeHome(session.backendHomes)
    : session.engineHome || (session.provider === 'codex' ? session.backendHomes?.codex : session.backendHomes?.codexApi) || codexHome();
  const found = [];
  const scan = (dir, matched = false) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const file = path.join(dir, entry.name), matches = matched || entry.name.includes(id);
      if (entry.isDirectory()) scan(file, matches);
      else if (matches && entry.isFile()) found.push({ source: file, archive: `native/${session.id}/${path.relative(directory, file).split(path.sep).join('/')}` });
    }
  };
  for (const name of session.backend === 'claude' ? ['projects'] : ['sessions', 'archived_sessions']) scan(path.join(directory, name));
  return found;
}

export async function exportProject(sessionOrRoot, filename, ui, { shared = false, kind = 'TERMINAL', agent } = {}) {
  const session = typeof sessionOrRoot === 'string' ? null : loadSession(sessionOrRoot.id) || sessionOrRoot;
  const root = fs.realpathSync(session?.projectRoot || session?.cwd || sessionOrRoot);
  const privateHome = shared ? canonicalPath(home()) : home();
  if (root === home()) throw new Error('Choose a project directory rather than the private bzzy state directory.');
  if (shared) {
    const privateRoots = [home(), codexHome(), claudeHome(), ...Object.values(claudeAuthHomes()),
      path.join(os.homedir(), '.ssh'), path.join(os.homedir(), 'Library/Keychains')].filter(value => typeof value === 'string');
    if (privateRoots.map(directory => canonicalPath(directory)).some(directory => within(root, directory) || within(directory, root))) throw new Error('Share a project directory separate from private Core/provider/account storage.');
  }
  const collected = collectProjectState(root, session?.id, { shared, sessionTreeOnly: kind === 'AGENT' });
  const state = shared ? portableState(collected) : collected;
  for (const row of state.records.filter(row => row.kind === 'session')) {
    try { assertSessionIdle(row.data); } catch { throw new Error('Pause the project’s running agents before exporting its complete context.'); }
  }
  const label = (session?.alias || path.basename(root) || 'project').replace(/[^a-zA-Z0-9_-]/g, '_');
  const destination = path.resolve(root, filename || `bzzy-${label}-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`);
  if (present(destination)) throw new Error(`Export already exists: ${destination}`);
  privateDir(path.dirname(destination));
  const temporary = destination + '.partial-' + randomUUID();
  const entries = [{ source: root, archive: 'workspace' }], missingFiles = [];
  const allowed = new Set(['artifacts', 'snapshots', 'workers', 'besties', 'parallel']);
  const candidates = [...new Set(state.records.flatMap(row => strings(row.data)).filter(value => path.isAbsolute(value))
    .map(value => shared ? canonicalPath(value) : value).filter(value => within(value, privateHome) && allowed.has(path.relative(privateHome, value).split(path.sep)[0])))].sort((a, b) => a.length - b.length);
  const copied = [];
  for (const source of candidates) {
    if (within(source, root) || copied.some(parent => within(source, parent))) continue;
    if (!present(source)) { missingFiles.push(source); continue; }
    copied.push(source); entries.push({ source, archive: 'private/' + path.relative(privateHome, source).split(path.sep).join('/') });
  }
  for (const row of state.records.filter(row => row.kind === 'artifact')) {
    if (!present(row.data.path)) throw new Error(`Cannot export missing recorded evidence: ${row.data.path}`);
  }
  for (const row of collected.records.filter(row => row.kind === 'session')) entries.push(...nativeFiles(row.data));
  const used = new Set(state.records.filter(row => row.kind === 'session').map(row => row.data.provider));
  const providerFields = new Set(['id', 'name', 'backend', 'auth', 'baseUrl', 'envKey', 'model', 'contextWindow', 'reasoningEffort', 'supportedEfforts']);
  const providers = shared ? {} : Object.fromEntries(Object.entries(config().providers || {}).filter(([id]) => used.has(id))
    .map(([id, value]) => [id, Object.fromEntries(Object.entries(value).filter(([key]) => providerFields.has(key)))]));
  const manifest = { format: 'bzzy-project', version: 1, createdAt: new Date().toISOString(), sourceRoot: root, sourceHome: privateHome,
    primarySessionId: session?.id || state.records.find(row => row.kind === 'session' && !row.data.parentSessionId)?.id || null,
    ...state, providers, missingFiles, ...(shared ? { sharing: { version: 1, kind, inactive: true, credentialBindings: false }, ...(agent ? { agent } : {}) } : {}) };
  if (shared) validateSharedManifest(manifest, { kind });
  const secrets = shared ? sharedSecrets() : [];
  if (shared) assertShareText(JSON.stringify(manifest), secrets);
  ui?.event('info', { message: 'Exporting the complete working directory and saved project context…' });
  const result = await archive('create', { destination, temporary, manifest, entries, exclude: [destination, temporary, home()],
    ...(shared ? { portable: true, limits: SHARE_LIMITS, secrets, projectRoot: root } : {}) });
  ui?.event('info', { message: `Exported: ${destination}\n${state.records.filter(row => row.kind === 'session').length} sessions · ${state.events.length} history events · ${result.entries} files/directories${missingFiles.length ? `\n${missingFiles.length} previously missing context paths are listed in bundle.json.` : ''}` });
  return { path: destination, ...result, sessions: state.records.filter(row => row.kind === 'session').length, missingFiles };
}

function transform(value, convert) {
  if (typeof value === 'string') return convert(value);
  if (Array.isArray(value)) return value.map(item => transform(item, convert));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [convert(key), transform(item, convert)]));
  return value;
}

function rewriteProjectMetadata(dir, convert) {
  if (!present(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || entry.name === 'imports') continue;
    let file = path.join(dir, entry.name);
    if (entry.isDirectory()) rewriteProjectMetadata(file, convert);
    else if (/\.(?:jsonl?|md)$/.test(entry.name)) {
      const original = fs.readFileSync(file, 'utf8');
      const updated = entry.name.endsWith('.md') ? convert(original) : entry.name.endsWith('.jsonl') ? original.split('\n').filter(Boolean).map(line => JSON.stringify(transform(JSON.parse(line), convert))).join('\n') + '\n'
        : JSON.stringify(transform(JSON.parse(original), convert), null, 2) + '\n';
      fs.writeFileSync(file, updated);
    }
    const renamed = convert(entry.name);
    if (renamed !== entry.name) fs.renameSync(file, path.join(dir, renamed));
  }
}

function markImportedKnowledge(metadata, projectId, bundleId) {
  const roots = [metadata], agents = path.join(metadata, 'agents');
  if (present(agents)) for (const entry of fs.readdirSync(agents, { withFileTypes: true })) if (entry.isDirectory()) roots.push(path.join(agents, entry.name));
  for (const root of roots) for (const kind of ['memory', 'issues', 'checkpoints', 'goals']) {
    const directory = path.join(root, kind);
    if (!present(directory)) continue;
    if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) throw new Error('Imported knowledge must use real directories.');
    for (const name of fs.readdirSync(directory).filter(value => /^[a-f0-9-]{36}\.json$/.test(value))) {
      const file = path.join(directory, name), stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4 * 1024 * 1024) throw new Error('Imported knowledge must use bounded regular records.');
      let record;
      try { record = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('Imported knowledge record is invalid.'); }
      if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Imported knowledge record is invalid.');
      record.importProvenance = { sourceRecordId: record.id || record.sessionId, bundleId, importedAt: new Date().toISOString(), observation: 'imported-history', previousTruth: record.truth || null };
      record.projectId = projectId; record.truth = 'inconclusive'; delete record.verification; delete record.verificationId;
      writeJson(file, record);
    }
  }
}

function checkMerge(source, target) {
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name), to = path.join(target, entry.name);
    if (!present(to)) continue;
    const existing = fs.lstatSync(to);
    if (entry.isDirectory() && existing.isDirectory()) checkMerge(from, to);
    else if (entry.isFile() && existing.isFile() && digest(fs.readFileSync(from)) === digest(fs.readFileSync(to))) continue;
    else if (entry.isSymbolicLink() && existing.isSymbolicLink() && fs.readlinkSync(from) === fs.readlinkSync(to)) continue;
    else throw new Error(`Import would overwrite an existing file: ${to}. Choose an empty directory.`);
  }
}
function merge(source, target, created) {
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name), to = path.join(target, entry.name);
    if (present(to)) { if (entry.isDirectory()) merge(from, to, created); continue; }
    created.push(to);
    const info = fs.lstatSync(from);
    if (entry.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(from), to);
    else if (entry.isDirectory()) {
      fs.mkdirSync(to, { mode: 0o700 }); merge(from, to, created);
      fs.chmodSync(to, info.mode & 0o777); fs.utimesSync(to, info.atime, info.mtime);
    } else {
      fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(to, info.mode & 0o777); fs.utimesSync(to, info.atime, info.mtime);
    }
  }
}

function relocateLinks(dir, convert) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) relocateLinks(file, convert);
    else if (entry.isSymbolicLink()) {
      const original = fs.readlinkSync(file), updated = path.isAbsolute(original) ? convert(original) : original;
      if (updated !== original) { fs.unlinkSync(file); fs.symlinkSync(updated, file); }
    }
  }
}

export async function importProject(filename, directory, ui, { shared = false, kind = 'TERMINAL', agentImport } = {}) {
  const root = fs.realpathSync(directory), source = path.resolve(filename);
  if (root === home()) throw new Error('Import into a project directory rather than the private bzzy state directory.');
  if (shared) {
    const privateRoots = [home(), codexHome(), claudeHome(), ...Object.values(claudeAuthHomes()),
      path.join(os.homedir(), '.ssh'), path.join(os.homedir(), '.aws'), path.join(os.homedir(), '.azure'),
      path.join(os.homedir(), '.gnupg'), path.join(os.homedir(), '.config'), path.join(os.homedir(), 'Library/Keychains')]
      .filter(value => typeof value === 'string').map(value => canonicalPath(value));
    const systemRoots = ['/etc', '/usr', '/bin', '/sbin', '/System', '/Library', '/Applications', '/proc', '/sys', '/dev', '/boot', '/var/run', '/var/lib']
      .map(value => canonicalPath(value));
    if (root === path.parse(root).root || root === canonicalPath(os.homedir()) ||
      privateRoots.some(value => within(root, value) || within(value, root)) || systemRoots.some(value => within(root, value))) {
      throw new Error('Import into an ordinary project directory, separate from home, system and private account storage.');
    }
  }
  const stage = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-import-'))), created = [], sessionFiles = [];
  let previousSettings, importedSettings, committed = false;
  try {
    ui?.event('info', { message: 'Reading the project ZIP and restoring its saved context…' });
    await archive('extract', { archive: source, directory: stage, ...(shared ? { portable: true, limits: SHARE_LIMITS } : {}) });
    const manifest = JSON.parse(fs.readFileSync(path.join(stage, 'bundle.json'), 'utf8'));
    if (shared) validateSharedManifest(manifest, { kind });
    agentImport?.signal?.throwIfAborted(); agentImport?.authorize?.();
    if (manifest.format !== 'bzzy-project' || manifest.version !== 1 || !Array.isArray(manifest.records) || !Array.isArray(manifest.events)
      || typeof manifest.sourceRoot !== 'string' || !path.isAbsolute(manifest.sourceRoot) || manifest.sourceRoot === path.parse(manifest.sourceRoot).root
      || typeof manifest.sourceHome !== 'string' || !path.isAbsolute(manifest.sourceHome) || manifest.sourceHome === path.parse(manifest.sourceHome).root) throw new Error('Invalid bzzy project manifest.');
    const workspace = path.join(stage, 'workspace');
    if (!present(workspace) || !fs.lstatSync(workspace).isDirectory()) throw new Error('Bundle has no working directory.');
    const metadata = path.join(workspace, '.bzzy');
    if (present(metadata) && !fs.lstatSync(metadata).isDirectory()) throw new Error('The bundle’s .bzzy metadata must be a real directory.');
    if (present(path.join(metadata, 'imports')) && !fs.lstatSync(path.join(metadata, 'imports')).isDirectory()) throw new Error('The bundle’s import directory must be a real directory.');
    for (const name of ['private', 'native']) if (present(path.join(stage, name)) && !fs.lstatSync(path.join(stage, name)).isDirectory()) throw new Error(`The bundle’s ${name} context must be a real directory.`);
    const bundleId = randomUUID(), importedProjectId = randomUUID(), relativeContext = path.join('.bzzy', 'imports', bundleId), context = path.join(root, relativeContext), privateRoot = path.join(context, 'private');
    const ids = new Map([...new Set(JSON.stringify([manifest.records, manifest.events]).match(uuid) || [])].map(id => [id, randomUUID()]));
    for (const row of manifest.records) if (typeof row.data?.projectId === 'string') ids.set(row.data.projectId, importedProjectId);
    const sourceMarker = path.join(metadata, 'project.json');
    if (present(sourceMarker)) {
      const stat = fs.lstatSync(sourceMarker);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16384) throw new Error('Imported project identity must be a bounded regular file.');
      let value;
      try { value = JSON.parse(fs.readFileSync(sourceMarker, 'utf8')); } catch { throw new Error('Imported project identity is invalid.'); }
      if (typeof value.id === 'string') ids.set(value.id, importedProjectId);
    }
    for (const row of manifest.records) if (typeof row.id === 'string' && row.id && !(row.id.match(uuid) || []).length) ids.set(row.id, randomUUID());
    const replaceIds = value => ids.get(value) || value.replace(uuid, id => ids.get(id) || id);
    const convert = value => {
      if (shared && path.isAbsolute(value)) value = canonicalPath(value);
      if (path.isAbsolute(value) && within(value, manifest.sourceHome)) return path.join(privateRoot, path.relative(manifest.sourceHome, value));
      if (path.isAbsolute(value) && within(value, manifest.sourceRoot)) {
        const relative = path.relative(manifest.sourceRoot, value);
        const storedImport = relative.startsWith(path.join('.bzzy', 'imports') + path.sep);
        return path.join(root, !storedImport && relative.startsWith('.bzzy' + path.sep) ? replaceIds(relative) : relative);
      }
      return replaceIds(value.split(manifest.sourceRoot).join(root));
    };
    rewriteProjectMetadata(metadata, convert);
    const projectMarker = path.join(workspace, '.bzzy', 'project.json');
    privateDir(path.dirname(projectMarker));
    writeJson(projectMarker, { version: 1, id: importedProjectId, createdAt: new Date().toISOString(),
      description: 'Imported BZZY engagement. Historical observations require current validation.' });
    markImportedKnowledge(metadata, importedProjectId, bundleId);
    const stagedContext = path.join(workspace, relativeContext); privateDir(stagedContext);
    for (const name of ['private', 'native']) if (present(path.join(stage, name))) fs.renameSync(path.join(stage, name), path.join(stagedContext, name));
    relocateLinks(workspace, convert);
    const usedAliases = new Set(sessions().map(session => session.alias).filter(Boolean));
    const records = manifest.records.filter(row => shared ? sharedKinds.has(row.kind) : !ephemeral(row.kind)).map(row => {
      if (typeof row.kind !== 'string' || typeof row.id !== 'string' || !row.data || typeof row.data !== 'object') throw new Error('Invalid saved context record.');
      const record = transform(stripWorkflowAuthority(row), convert);
      if (['session', 'memory', 'issue', 'checkpoint'].includes(row.kind)) record.data.projectId = importedProjectId;
      record.data.importProvenance = { sourceRecordId: row.id, bundleId, importedAt: new Date().toISOString(), observation: 'imported-history' };
      if (['memory', 'issue', 'checkpoint'].includes(row.kind)) {
        record.data.importProvenance = { ...record.data.importProvenance, sourceRecordId: row.id, bundleId,
          importedAt: new Date().toISOString(), observation: 'imported-history', previousTruth: record.data.truth || null };
        record.data.truth = 'inconclusive'; delete record.data.verification; delete record.data.verificationId;
      }
      if (row.kind === 'snapshot') record.data.manifest = row.data.manifest;
      delete record.data.runner; delete record.data.launcher; delete record.data.token; delete record.data.nonce;
      delete record.data.missionContext; delete record.data.contextRequest; delete record.data.contextRequestId;
      if (['queued', 'launching', 'running', 'starting', 'waiting_for_input'].includes(record.data.state)) { record.data.state = 'interrupted'; record.data.reason = 'Imported project; explicit resume required.'; }
      if (row.kind === 'question' && record.data.state === 'pending') { record.data.state = 'expired'; record.data.reason = 'Imported project; original runner is no longer attached.'; }
      if (row.kind === 'operation' && ['planned', 'dispatched'].includes(record.data.state)) record.data.state = 'uncertain';
      if (row.kind === 'session') {
        const session = record.data;
        if (!within(session.cwd || '', root) || !/^[a-f0-9-]{36}$/.test(record.id) || session.id !== record.id) throw new Error('Imported session points outside the restored project.');
        const stagedDirectory = path.join(workspace, path.relative(root, session.cwd));
        if (!present(stagedDirectory) || !fs.statSync(stagedDirectory).isDirectory() || !within(fs.realpathSync(stagedDirectory), workspace)) throw new Error('An imported session’s working directory is missing or outside the project.');
        if (session.alias) {
          const originalAlias = session.alias; let suffix = 1;
          while (usedAliases.has(session.alias)) { const ending = suffix++ === 1 ? '-imported' : `-imported-${suffix - 1}`; session.alias = originalAlias.slice(0, 80 - ending.length) + ending; }
          usedAliases.add(session.alias);
        }
        session.projectRoot = root; session.executionState = 'idle'; session.engineThreadId = null; session.engineSessionId = null; session.engineHome = null;
        session.backendHomes = { codex: codexHome(), codexApi: codexHome({ auth: 'api-key' }), ...claudeAuthHomes() };
        session.importedContext = { directory: context, nativeDirectory: path.join(context, 'native'), sourceSessionId: row.id,
          previous: session.importedContext || null, importedAt: new Date().toISOString() };
        session.conversationHandoff = { pending: true, throughSeq: 0 };
        session.engineTokenOffset = session.usage?.tokens || 0;
        if (session.goal) {
          session.goal.importedHistorical = true;
          if (['active', 'verifying'].includes(session.goal.status)) { session.goal.status = 'paused'; session.goal.reason = 'imported'; }
          delete session.goal.nativeGoalId; delete session.goal.nativeStatus; delete session.goal.nativeTokensUsed;
          session.goal.nativeTokenOffset = session.goal.supervisorTokensUsed ?? session.goal.tokensUsed ?? 0;
        }
      }
      return record;
    });
    const imported = records.filter(row => row.kind === 'session'), sessionIds = new Set(imported.map(row => row.id));
    const primary = imported.find(row => row.id === ids.get(manifest.primarySessionId));
    if (kind === 'AGENT') {
      if (!agentImport || !primary || primary.data.parentSessionId || primary.data.purpose !== 'agent' || primary.data.agentId !== ids.get(manifest.agent.id)) throw new Error('The agent package has no valid primary conversation.');
      const descendants = new Set([primary.id]);
      for (let previous = -1; previous !== descendants.size;) {
        previous = descendants.size;
        for (const row of imported) if (descendants.has(row.data.parentSessionId)) descendants.add(row.id);
      }
      if (descendants.size !== imported.length) throw new Error('An agent package contains an unrelated conversation.');
      for (const row of imported) {
        Object.assign(row.data, { provider: agentImport.selection.provider, backend: agentImport.backend, model: agentImport.selection.model,
          selectedEffort: agentImport.selection.effort, agentId: agentImport.id, importedUntrusted: true });
        if (row.id === primary.id) row.data.purpose = 'agent';
      }
      writeJson(path.join(workspace, 'agent.json'), { version: 1, name: agentImport.name || manifest.agent.name,
        instructions: manifest.agent.instructions, ...agentImport.selection });
    }
    const history = transform(stripWorkflowAuthority(manifest.events), convert);
    if (history.some(event => !sessionIds.has(event.sessionId) || typeof event.type !== 'string' || !Number.isSafeInteger(event.seq)
      || typeof event.createdAt !== 'string' || !Number.isFinite(Date.parse(event.createdAt))) || new Set(history.map(event => event.seq)).size !== history.length) throw new Error('Bundle history contains an invalid event or references an unknown session.');
    for (const record of records.filter(row => row.kind === 'artifact')) {
      if (!within(record.data.path || '', root)) throw new Error('Imported evidence points outside the restored project.');
      const file = path.join(workspace, path.relative(root, record.data.path));
      if (!present(file) || !fs.lstatSync(file).isFile() || !within(fs.realpathSync(file), workspace) || digest(fs.readFileSync(file)) !== record.data.sha256) throw new Error('Imported evidence is missing or failed its integrity check.');
    }
    writeJson(path.join(stagedContext, 'bundle.json'), { ...manifest, records, events: history });
    checkMerge(workspace, root);
    for (const row of imported) {
      if (loadSession(row.id) || present(sessionPath(row.id))) throw new Error('Imported session ID already exists. Try importing again.');
    }
    for (const row of records) if (getRecord(row.kind, row.id)) throw new Error('Imported context ID already exists. Try importing again.');
    const importedProviders = {};
    const providerFields = new Set(['id', 'name', 'backend', 'auth', 'baseUrl', 'envKey', 'model', 'contextWindow', 'reasoningEffort', 'supportedEfforts']);
    for (const [id, provider] of Object.entries(shared ? {} : manifest.providers || {})) {
      if (!/^[a-z][a-z0-9_-]{0,39}$/.test(id) || !provider || typeof provider !== 'object' || !['codex', 'claude'].includes(provider.backend) || !['subscription', 'api-key'].includes(provider.auth)) throw new Error('Invalid imported provider settings.');
      importedProviders[id] = Object.fromEntries(Object.entries(provider).filter(([key]) => providerFields.has(key)));
    }
    agentImport?.signal?.throwIfAborted(); agentImport?.authorize?.();
    merge(workspace, root, created);
    transaction(db => {
      agentImport?.signal?.throwIfAborted(); agentImport?.authorize?.();
      for (const row of records) putRecord(row.kind, row.id, row.data, db);
      const sequences = new Map();
      const insertEvent = db.prepare('INSERT INTO events(session_id,type,data,created_at) VALUES (?,?,?,?)');
      for (const event of history) sequences.set(event.seq, Number(insertEvent.run(event.sessionId, event.type, JSON.stringify(event.data), event.createdAt).lastInsertRowid));
      for (const row of records.filter(row => ['peer-message', 'peer-cursor'].includes(row.kind))) {
        if (row.kind === 'peer-message') row.data.seq = sequences.get(row.data.seq) || row.data.seq;
        else row.data.after = sequences.get(row.data.after) || 0;
        putRecord(row.kind, row.id, row.data, db);
      }
      for (const row of imported) {
        appendEvent(row.id, 'project.imported', { bundleId, sourceSessionId: row.data.importedContext.sourceSessionId, cwd: root }, db);
        row.data.conversationHandoff.throughSeq = conversationCursor(row.id, db);
        row.data.updatedAt = new Date().toISOString();
        putRecord('session', row.id, row.data, db);
        sessionFiles.push(sessionPath(row.id)); writeJson(sessionPath(row.id), row.data);
      }
      for (const row of records.filter(row => ['parallel', 'besties'].includes(row.kind))) {
        row.data.cursors = {}; row.data.started = {}; row.data.resumed = {};
        putRecord(row.kind, row.id, row.data, db);
      }
      agentImport?.commit?.({ db, primarySession: primary?.data, manifest, bundleId });
      importedSettings = updateConfig(current => {
        previousSettings = structuredClone(current); current.providers ||= {};
        for (const [id, provider] of Object.entries(importedProviders)) if (!Object.hasOwn(current.providers, id)) current.providers[id] = provider;
        return current;
      });
    });
    committed = true;
    const selectedPrimary = primary || imported.find(row => !row.data.parentSessionId);
    const reference = selectedPrimary && (selectedPrimary.data.alias || selectedPrimary.id);
    const quoted = reference && `'${reference.replaceAll("'", "'\\''")}'`;
    ui?.event('info', { message: `Imported into: ${root}\n${imported.length} sessions · ${history.length} history events restored.${selectedPrimary && kind === 'TERMINAL' ? `\nOpen: bzzy --attach ${quoted}` : ''}` });
    return { cwd: root, sessions: imported.map(row => row.data), primarySession: selectedPrimary?.data || null };
  } catch (error) {
    if (!committed) {
      for (const file of sessionFiles) fs.rmSync(file, { force: true });
      for (const file of created.reverse()) fs.rmSync(file, { recursive: true, force: true });
      if (importedSettings) {
        try { updateConfig(current => {
          if (digest(current) !== digest(importedSettings)) throw Object.assign(new Error('Configuration changed during import rollback.'), { code: 'CONFLICT' });
          return previousSettings;
        }); }
        catch (rollback) { if (rollback.code !== 'CONFLICT') throw rollback; }
      }
    }
    throw error;
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}

// Network imports use this stricter policy. Owner ZIP backup/restore stays
// compatible and must never be exposed as the portable sharing operation.
export async function exportSharedProject(sessionOrRoot, filename, ui) {
  try { return await exportProject(sessionOrRoot, filename, ui, { shared: true }); }
  catch (error) {
    error.code = /Pause|still running/.test(error.message) ? 'EXPORT_ACTIVE'
      : /credential/i.test(error.message) ? 'SECRET_DETECTED' : 'EXPORT_INVALID';
    throw error;
  }
}
export async function importSharedProject(filename, directory, ui) {
  try { return await importProject(filename, directory, ui, { shared: true }); }
  catch (error) {
    error.code = /overwrite|already exists/.test(error.message) ? 'IMPORT_CONFLICT'
      : /provider locally/.test(error.message) ? 'PROVIDER_UNAVAILABLE' : 'IMPORT_INVALID';
    throw error;
  }
}

export async function exportSharedAgentProject(session, filename, definition) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-agent-export-')));
  const raw = path.join(directory, 'source.zip'), stage = path.join(directory, 'stage'); fs.mkdirSync(stage, { mode: 0o700 });
  try {
    await exportProject(session, raw, undefined, { shared: true, kind: 'AGENT', agent: definition });
    await archive('extract', { archive: raw, directory: stage, portable: true, limits: SHARE_LIMITS });
    const manifest = JSON.parse(fs.readFileSync(path.join(stage, 'bundle.json'), 'utf8'));
    const tree = new Set([manifest.primarySessionId]), conversations = manifest.records.filter(row => row.kind === 'session');
    for (let previous = -1; previous !== tree.size;) { previous = tree.size;
      for (const row of conversations) if (tree.has(row.data.parentSessionId)) tree.add(row.id); }
    if (!conversations.length || conversations.some(row => !tree.has(row.id))) throw new Error('Agent export contains an unrelated conversation.');
    // Source filesystem identities are routing metadata, never portable authority.
    const sourceRoot = '/BZZY-PORTABLE/PROJECT', sourceHome = '/BZZY-PORTABLE/PRIVATE';
    const convert = value => {
      // Runtime records can legitimately use /tmp while the pinned manifest
      // uses /private/tmp on macOS. Normalize before replacing the two roots.
      const normalized = path.isAbsolute(value) ? canonicalPath(value) : value;
      return normalized.split(manifest.sourceRoot).join(sourceRoot).split(manifest.sourceHome).join(sourceHome);
    };
    for (const name of ['workspace/.bzzy', 'private', 'native']) rewriteProjectMetadata(path.join(stage, name), convert);
    const portable = transform(manifest, convert); portable.sourceRoot = sourceRoot; portable.sourceHome = sourceHome;
    const destination = path.resolve(filename), temporary = destination + '.partial-' + randomUUID();
    const entries = ['workspace', 'private', 'native'].filter(name => present(path.join(stage, name))).map(name => ({ source: path.join(stage, name), archive: name }));
    const result = await archive('create', { destination, temporary, manifest: portable, entries, exclude: [], portable: true,
      limits: SHARE_LIMITS, secrets: sharedSecrets(), projectRoot: path.join(stage, 'workspace') });
    return { path: destination, ...result, sessions: conversations.length, missingFiles: portable.missingFiles };
  } catch (error) { error.code = /Pause|still running/.test(error.message) ? 'EXPORT_ACTIVE' : /credential/i.test(error.message) ? 'SECRET_DETECTED' : 'EXPORT_INVALID'; throw error; }
  finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
export async function importSharedAgentProject(filename, directory, agentImport) {
  try { return await importProject(filename, directory, undefined, { shared: true, kind: 'AGENT', agentImport }); }
  catch (error) { error.code ||= /overwrite|already exists/.test(error.message) ? 'IMPORT_CONFLICT' : 'IMPORT_INVALID'; throw error; }
}
