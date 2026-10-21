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
import { config, saveConfig } from './providers.js';
import { codexHome, claudeHome, claudeAuthHomes } from './auth.js';
import { conversationCursor } from './conversation.js';

const helper = fileURLToPath(new URL('./archive.py', import.meta.url));
const uuid = /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi;
const ephemeral = kind => /^(?:telegram-|access-token$|input-owner$|account-status$|outbox$|notification|run$|control$|assignment-control$)/.test(kind);
const within = (file, root) => file === root || file.startsWith(root + path.sep);
const present = file => { try { fs.lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };

async function archive(operation, spec) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', [helper, operation], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', error = '';
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

export function collectProjectState(root, sessionId) {
  sessions(); // Reconcile compatibility exports before taking one consistent database snapshot.
  return transaction(db => {
    const rows = db.prepare('SELECT kind,id,data FROM records').all().filter(row => !ephemeral(row.kind)).map(row => ({ ...row, data: withoutTokens(JSON.parse(row.data)) }));
    const selected = new Set(rows.filter(row => row.kind === 'session' && (row.id === sessionId || row.data.projectRoot === root || within(row.data.cwd || '', root))).map(row => row.id));
    const included = new Set(), related = new Set(selected);
    let changed = true;
    while (changed) {
      changed = false;
      for (const [index, row] of rows.entries()) {
        if (included.has(index)) continue;
        if (related.has(row.id) || strings(row.data).some(value => related.has(value) || value === root)) {
          included.add(index); related.add(row.id); changed = true;
          if (row.kind === 'session') { selected.add(row.id); if (row.data.goal?.id) related.add(row.data.goal.id); }
        }
      }
    }
    const records = rows.filter((_row, index) => included.has(index));
    const events = db.prepare('SELECT seq,session_id AS sessionId,type,data,created_at AS createdAt FROM events ORDER BY seq').all()
      .filter(event => selected.has(event.sessionId)).map(event => ({ ...event, data: withoutTokens(JSON.parse(event.data)) }));
    return { records, events };
  });
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

export async function exportProject(sessionOrRoot, filename, ui) {
  const session = typeof sessionOrRoot === 'string' ? null : loadSession(sessionOrRoot.id) || sessionOrRoot;
  const root = fs.realpathSync(session?.projectRoot || session?.cwd || sessionOrRoot);
  if (root === home()) throw new Error('Choose a project directory rather than the private bzzy state directory.');
  const state = collectProjectState(root, session?.id);
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
  const candidates = [...new Set(state.records.flatMap(row => strings(row.data)).filter(value => path.isAbsolute(value) && within(value, home()) && allowed.has(path.relative(home(), value).split(path.sep)[0])))].sort((a, b) => a.length - b.length);
  const copied = [];
  for (const source of candidates) {
    if (within(source, root) || copied.some(parent => within(source, parent))) continue;
    if (!present(source)) { missingFiles.push(source); continue; }
    copied.push(source); entries.push({ source, archive: 'private/' + path.relative(home(), source).split(path.sep).join('/') });
  }
  for (const row of state.records.filter(row => row.kind === 'artifact')) {
    if (!present(row.data.path)) throw new Error(`Cannot export missing recorded evidence: ${row.data.path}`);
  }
  for (const row of state.records.filter(row => row.kind === 'session')) entries.push(...nativeFiles(row.data));
  const used = new Set(state.records.filter(row => row.kind === 'session').map(row => row.data.provider));
  const providerFields = new Set(['id', 'name', 'backend', 'auth', 'baseUrl', 'envKey', 'model', 'contextWindow', 'reasoningEffort', 'supportedEfforts']);
  const providers = Object.fromEntries(Object.entries(config().providers || {}).filter(([id]) => used.has(id))
    .map(([id, value]) => [id, Object.fromEntries(Object.entries(value).filter(([key]) => providerFields.has(key)))]));
  const manifest = { format: 'bzzy-project', version: 1, createdAt: new Date().toISOString(), sourceRoot: root, sourceHome: home(),
    primarySessionId: session?.id || state.records.find(row => row.kind === 'session' && !row.data.parentSessionId)?.id || null,
    ...state, providers, missingFiles };
  ui?.event('info', { message: 'Exporting the complete working directory and saved project context…' });
  const result = await archive('create', { destination, temporary, manifest, entries, exclude: [destination, temporary, home()] });
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

export async function importProject(filename, directory, ui) {
  const root = fs.realpathSync(directory), source = path.resolve(filename);
  if (root === home()) throw new Error('Import into a project directory rather than the private bzzy state directory.');
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-import-')), created = [], sessionFiles = [];
  const previousSettings = config(); let committed = false, settingsChanged = false;
  try {
    ui?.event('info', { message: 'Reading the project ZIP and restoring its saved context…' });
    await archive('extract', { archive: source, directory: stage });
    const manifest = JSON.parse(fs.readFileSync(path.join(stage, 'bundle.json'), 'utf8'));
    if (manifest.format !== 'bzzy-project' || manifest.version !== 1 || !Array.isArray(manifest.records) || !Array.isArray(manifest.events)
      || typeof manifest.sourceRoot !== 'string' || !path.isAbsolute(manifest.sourceRoot) || manifest.sourceRoot === path.parse(manifest.sourceRoot).root
      || typeof manifest.sourceHome !== 'string' || !path.isAbsolute(manifest.sourceHome) || manifest.sourceHome === path.parse(manifest.sourceHome).root) throw new Error('Invalid bzzy project manifest.');
    const workspace = path.join(stage, 'workspace');
    if (!present(workspace) || !fs.lstatSync(workspace).isDirectory()) throw new Error('Bundle has no working directory.');
    const metadata = path.join(workspace, '.bzzy');
    if (present(metadata) && !fs.lstatSync(metadata).isDirectory()) throw new Error('The bundle’s .bzzy metadata must be a real directory.');
    if (present(path.join(metadata, 'imports')) && !fs.lstatSync(path.join(metadata, 'imports')).isDirectory()) throw new Error('The bundle’s import directory must be a real directory.');
    for (const name of ['private', 'native']) if (present(path.join(stage, name)) && !fs.lstatSync(path.join(stage, name)).isDirectory()) throw new Error(`The bundle’s ${name} context must be a real directory.`);
    const bundleId = randomUUID(), relativeContext = path.join('.bzzy', 'imports', bundleId), context = path.join(root, relativeContext), privateRoot = path.join(context, 'private');
    const ids = new Map([...new Set(JSON.stringify([manifest.records, manifest.events]).match(uuid) || [])].map(id => [id, randomUUID()]));
    for (const row of manifest.records) if (typeof row.id === 'string' && row.id && !(row.id.match(uuid) || []).length) ids.set(row.id, randomUUID());
    const replaceIds = value => ids.get(value) || value.replace(uuid, id => ids.get(id) || id);
    const convert = value => {
      if (path.isAbsolute(value) && within(value, manifest.sourceHome)) return path.join(privateRoot, path.relative(manifest.sourceHome, value));
      if (path.isAbsolute(value) && within(value, manifest.sourceRoot)) {
        const relative = path.relative(manifest.sourceRoot, value);
        const storedImport = relative.startsWith(path.join('.bzzy', 'imports') + path.sep);
        return path.join(root, !storedImport && relative.startsWith('.bzzy' + path.sep) ? replaceIds(relative) : relative);
      }
      return replaceIds(value.split(manifest.sourceRoot).join(root));
    };
    rewriteProjectMetadata(metadata, convert);
    const stagedContext = path.join(workspace, relativeContext); privateDir(stagedContext);
    for (const name of ['private', 'native']) if (present(path.join(stage, name))) fs.renameSync(path.join(stage, name), path.join(stagedContext, name));
    relocateLinks(workspace, convert);
    const usedAliases = new Set(sessions().map(session => session.alias).filter(Boolean));
    const records = manifest.records.filter(row => !ephemeral(row.kind)).map(row => {
      if (typeof row.kind !== 'string' || typeof row.id !== 'string' || !row.data || typeof row.data !== 'object') throw new Error('Invalid saved context record.');
      const record = transform(row, convert);
      if (row.kind === 'snapshot') record.data.manifest = row.data.manifest;
      delete record.data.runner; delete record.data.launcher; delete record.data.token; delete record.data.nonce;
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
          if (['active', 'verifying'].includes(session.goal.status)) { session.goal.status = 'paused'; session.goal.reason = 'imported'; }
          delete session.goal.nativeGoalId; delete session.goal.nativeStatus; delete session.goal.nativeTokensUsed;
          session.goal.nativeTokenOffset = session.goal.supervisorTokensUsed ?? session.goal.tokensUsed ?? 0;
        }
      }
      return record;
    });
    const imported = records.filter(row => row.kind === 'session'), sessionIds = new Set(imported.map(row => row.id));
    const history = transform(manifest.events, convert);
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
    const settings = structuredClone(previousSettings); settings.providers ||= {};
    const providerFields = new Set(['id', 'name', 'backend', 'auth', 'baseUrl', 'envKey', 'model', 'contextWindow', 'reasoningEffort', 'supportedEfforts']);
    for (const [id, provider] of Object.entries(manifest.providers || {})) {
      if (!/^[a-z][a-z0-9_-]{0,39}$/.test(id) || !provider || typeof provider !== 'object' || !['codex', 'claude'].includes(provider.backend) || !['subscription', 'api-key'].includes(provider.auth)) throw new Error('Invalid imported provider settings.');
      if (!Object.hasOwn(settings.providers, id)) settings.providers[id] = Object.fromEntries(Object.entries(provider).filter(([key]) => providerFields.has(key)));
    }
    merge(workspace, root, created);
    transaction(db => {
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
      settingsChanged = true; saveConfig(settings);
    });
    committed = true;
    const primary = imported.find(row => row.id === ids.get(manifest.primarySessionId)) || imported.find(row => !row.data.parentSessionId);
    const reference = primary && (primary.data.alias || primary.id);
    const quoted = reference && `'${reference.replaceAll("'", "'\\''")}'`;
    ui?.event('info', { message: `Imported into: ${root}\n${imported.length} sessions · ${history.length} history events restored.${primary ? `\nOpen: bzzy --attach ${quoted}` : ''}\nBrowse: bzzy sessions` });
    return { cwd: root, sessions: imported.map(row => row.data), primarySession: primary?.data || null };
  } catch (error) {
    if (!committed) {
      for (const file of sessionFiles) fs.rmSync(file, { force: true });
      for (const file of created.reverse()) fs.rmSync(file, { recursive: true, force: true });
      if (settingsChanged) saveConfig(previousSettings);
    }
    throw error;
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}
