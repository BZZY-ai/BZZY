import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { home, privateDir } from './files.js';
import { database, getRecord, transaction, digest } from './database.js';
import { resolveProjectIdentity } from './project-identity.js';
import { listSkills, inspectSkill, importSkill, skillStorageId } from './skills.js';
import { listSubagentDefinitions, getSubagentDefinition, normalizeSubagentDefinition, saveSubagentDefinition } from './subagent-definitions.js';
import { assertShareText, sharedSecrets } from './share-bundle-policy.js';

export const DEFINITION_BUNDLE_LIMITS = Object.freeze({ bytes: 64 * 1024 * 1024, fileBytes: 1024 * 1024, entries: 4096, definitions: 256 });
const payloadLimit = 60 * 1024 * 1024, reviews = new Map(), lifetime = 30 * 60 * 1000;
const agentFields = ['name', 'description', 'instructions', 'provider', 'model', 'effort', 'policy', 'limits'];
const fail = (message, code = 'DEFINITION_BUNDLE') => { throw Object.assign(new Error(message), { code }); };
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const name = value => typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 64;
const scope = value => ['global', 'project'].includes(value);
const clone = value => structuredClone(value);
function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.keys(value).some(key => !keys.includes(key))) fail('The definitions package contains unsupported fields.');
}
function safePath(value, maximum = 240) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\\:\x00-\x1f\x7f-\x9f]/u.test(value) &&
    !path.posix.isAbsolute(value) && value.split('/').every(part => part && !part.startsWith('.') && part !== '..');
}
const privateResource = value => value.split('/').some(part => /^(?:auth|credentials|bindings?|accounts?|cookies?|history|sessions?|snapshots?|runtime|logs?)(?:\.|$)/i.test(part) ||
  /^(?:project-scope\.json|run-records\.jsonl|source-goal\.json|evidence(?:\.json)?|id_rsa|id_ed25519)$/i.test(part) ||
  /(?:^|[-_.])(?:credentials?|private[-_]bindings?|bindings?|auth[-_]tokens?|oauth[-_]tokens?|secrets?)\.(?:json|ya?ml|env|ini|toml|conf|txt)$/i.test(part) ||
  /\.(?:pem|key|p12|pfx|keychain|sqlite|db)$/i.test(part));
const placeholder = value => !value || /^(?:\$[A-Z_][A-Z0-9_]*|\$\{[^}]+\}|<[^>]+>|\[redacted\])$/i.test(value);
const credentialField = /^(?:api[_-]?key|(?:access|refresh|auth|oauth)[_-]?token|token|password|passwd|secret|cookie|authorization|account[_-]?id|email)$/i;
function credentialSchema(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (Object.keys(value).length === 1 && typeof value.$ref === 'string' && /^#\/[a-zA-Z0-9_/-]+$/.test(value.$ref)) return true;
  return value.type === 'string' && Object.keys(value).every(key => ['type', 'title', 'description', 'format', 'minLength', 'maxLength'].includes(key)) &&
    ['title', 'description', 'format'].every(key => value[key] === undefined || typeof value[key] === 'string') &&
    ['minLength', 'maxLength'].every(key => value[key] === undefined || Number.isSafeInteger(value[key]) && value[key] >= 0 && value[key] <= 1048576);
}
function portable(data, context) {
  const text = data.toString('utf8'); assertShareText(text, sharedSecrets());
  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text) ||
      /(?:\/Users\/|\/home\/|\/Volumes\/|\/~?\.bzzy\/|~\/(?:\.codex|\.claude|\.ssh)\/)/i.test(text) ||
      [context.cwd, context.hostHome, os.homedir()].some(root => root.length > 3 && text.includes(root))) fail('Reusable definitions contain private account or host-path data. Parameterize it before exporting.');
  let json = false;
  try {
    const parsed = JSON.parse(text); json = true;
    const visit = value => {
      if (!value || typeof value !== 'object') return;
      for (const [key, item] of Object.entries(value)) {
        if (credentialField.test(key) && item !== null && !(typeof item === 'string' && placeholder(item)) && !credentialSchema(item)) fail('Reusable definitions contain a literal credential or account binding.');
        visit(item);
      }
    };
    visit(parsed);
  } catch (error) { if (error.code === 'DEFINITION_BUNDLE') throw error; }
  const assignments = /(?:^|[\s{,(.\[])["']?(?:api[_-]?key|(?:access|refresh|auth|oauth)[_-]?token|token|password|passwd|secret|cookie|authorization|account[_-]?id|email)["']?(?:\s*\])?\s*[:=]\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|(\$\{[^}\r\n]+\}|<[^>\r\n]+>|\[redacted\]|[^\s,\r\n}]+))/gim;
  for (const match of text.matchAll(assignments)) {
    const literal = match[1] ?? match[2], value = literal ?? match[3];
    const expression = literal === undefined && (/^(?:null|None|undefined|str|string|number|integer|boolean|object|array|true|false)$/.test(value) ||
      json && /^[{[]/.test(value) || /^(?:process\.env|os\.environ|config[.[]|bindings?[.[]|credentials?[.[])/.test(value));
    if (!placeholder(value) && !expression) fail('Reusable definitions contain a literal credential or account binding.');
  }
}
function regular(file, maximum = DEFINITION_BUNDLE_LIMITS.fileBytes, identity = false) {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maximum) fail('Definitions require bounded regular files without links.');
    const data = fs.readFileSync(descriptor);
    if (data.length !== stat.size) fail('A definition file changed while being read.');
    const exact = fs.fstatSync(descriptor, { bigint: true });
    return identity ? { data, device: String(exact.dev), inode: String(exact.ino) } : data;
  } finally { fs.closeSync(descriptor); }
}
function realDirectory(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) fail('Choose the current absolute project directory.');
  const cwd = fs.realpathSync(value), stat = fs.lstatSync(cwd);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('The project directory is unavailable.');
  return { cwd, fingerprint: `${stat.dev}:${stat.ino}` };
}
function capture(cwd) {
  privateDir(home());
  const directory = realDirectory(cwd), project = resolveProjectIdentity(directory.cwd, { create: false });
  return { ...directory, home: home(), hostHome: fs.realpathSync(home()), projectId: project.id, projectRoot: project.root };
}
function assertContext(context, cwd) {
  if (digest(capture(cwd)) !== digest(context)) fail('The Core home or project changed. Preview the definitions again.', 'STALE_REVIEW');
}
function stage() {
  const directory = path.join(home(), 'definition-bundles'); privateDir(directory);
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077) fail('Definition review storage must remain private.');
  for (const entry of fs.readdirSync(directory).filter(value => /^\.review-[a-zA-Z0-9]{6}$/.test(value)).slice(0, 128)) {
    const target = path.join(directory, entry), old = fs.lstatSync(target);
    if (old.isDirectory() && !old.isSymbolicLink() && !(old.mode & 0o077) && (!process.getuid || old.uid === process.getuid()) && Date.now() - old.mtimeMs > lifetime) fs.rmSync(target, { recursive: true, force: true });
  }
  return fs.mkdtempSync(path.join(directory, '.review-'));
}
function archive(spec) {
  const result = spawnSync('python3', [fileURLToPath(new URL('./definition-archive.py', import.meta.url))], {
    input: JSON.stringify(spec), encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) fail('The definitions ZIP is unsafe, changed, too large, or its destination already exists. No existing file was replaced.');
  try { return JSON.parse(result.stdout); } catch { fail('The definitions archive could not be validated.'); }
}
function writeFile(directory, relative, data) {
  const target = path.join(directory, relative); privateDir(path.dirname(target));
  fs.writeFileSync(target, data, { mode: 0o600, flag: 'wx' });
}
function outputAt(context, requested) {
  const value = requested || `bzzy-definitions-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.zip`;
  const outputPath = path.resolve(context.cwd, value), basename = path.basename(outputPath);
  if (path.dirname(outputPath) !== context.cwd || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}\.zip$/i.test(basename)) fail('Export a ZIP filename directly in the current project directory.');
  if (fs.existsSync(outputPath) || (() => { try { fs.lstatSync(outputPath); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } })()) fail('That export destination already exists. Choose another ZIP filename.', 'CONFLICT');
  return outputPath;
}
function pageAll(read, field) {
  const rows = []; let offset = 0;
  do {
    const page = read(offset); rows.push(...page[field]);
    if (rows.length > DEFINITION_BUNDLE_LIMITS.definitions) fail('The reusable-definition library exceeds this ZIP’s definition limit.');
    offset = page.nextOffset;
  } while (offset !== null);
  return rows;
}
function skillDirectory(record) {
  return record.scope === 'project' ? path.join(home(), 'skills', '_projects', digest(record.projectId), record.name, record.version)
    : path.join(home(), 'skills', record.name, record.version);
}
function inventoryFile(relative, data) { return { path: relative, bytes: data.length, sha256: digest(data) }; }
function contentEntry(kind, item, definition) {
  return { kind, name: item.name, description: item.description, scope: item.scope, version: item.version, files: clone(item.files),
    ...(definition ? { selection: Object.fromEntries(['provider', 'model', 'effort'].filter(key => Object.hasOwn(definition, key)).map(key => [key, definition[key]])),
      ...(definition.policy ? { policy: clone(definition.policy) } : {}), ...(definition.limits ? { limits: clone(definition.limits) } : {}) } : {}) };
}
function libraryPathSafe(target) {
  for (let current = target; current !== home(); current = path.dirname(current)) {
    if (current === path.dirname(current)) fail('Invalid definition storage location.');
    let stat; try { stat = fs.lstatSync(current); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('Definition storage contains a link or unsafe destination.');
  }
}

function collect(context) {
  const skills = [], agents = [], files = [], pins = [];
  for (const selected of ['global', 'project']) {
    for (const item of pageAll(offset => listSkills({ projectRoot: context.projectRoot, projectId: context.projectId, scope: selected, offset, limit: 100 }), 'skills')) {
      const options = { scope: selected, projectId: context.projectId }, record = getRecord('core.skill', item.id || skillStorageId(item.name, options));
      if (!record || record.version !== item.version || !Array.isArray(record.files) || digest(record.files) !== record.version)
        fail('A skill inventory changed. Preview the definitions again.', 'STALE_REVIEW');
      inspectSkill(record.id || record.name, options);
      if (record.files.some(file => privateResource(file.path))) fail(`Skill “${item.name}” contains private case, evidence, binding or runtime resources and cannot be exported as reusable behavior.`);
      try {
        const checked = importSkill(skillDirectory(record), { ...options, preview: true, expectedVersion: record.version });
        const resources = record.files.map(file => {
          if (!safePath(file.path)) fail('Unsafe reusable skill path.');
          const data = regular(path.join(skillDirectory(record), file.path));
          if (data.length !== file.bytes || digest(data) !== file.sha256) fail('Immutable skill content changed.');
          portable(data, context); files.push({ path: `skills/${selected}/${record.name}/${file.path}`, data }); return { ...file };
        });
        if (checked.name !== record.name || checked.description !== record.description) fail('Skill metadata changed.');
        skills.push({ name: record.name, description: record.description, scope: selected, version: record.version, files: resources });
        pins.push({ kind: 'skill', id: record.id || record.name, revision: record.revision, version: record.version });
      } catch { fail(`Skill “${item.name}” is not a safe, intact portable package. Review its resources before exporting.`); }
    }
    for (const item of pageAll(offset => listSubagentDefinitions({ cwd: context.cwd, scope: selected, offset, limit: 100 }), 'subagents')) {
      const record = getSubagentDefinition(item.name, { cwd: context.cwd, scope: selected });
      const definition = normalizeSubagentDefinition(Object.fromEntries(agentFields.filter(key => Object.hasOwn(record, key)).map(key => [key, record[key]])));
      const data = Buffer.from(JSON.stringify(definition, null, 2) + '\n'); portable(data, context);
      const file = `agents/${selected}/${record.name}.json`, resource = inventoryFile(file, data);
      files.push({ path: file, data }); agents.push({ name: record.name, description: record.description, scope: selected, version: digest(definition), file, bytes: resource.bytes, sha256: resource.sha256 });
      pins.push({ kind: 'agent', id: record.id, revision: record.revision, version: record.version });
    }
  }
  if (skills.length + agents.length > DEFINITION_BUNDLE_LIMITS.definitions) fail('The reusable-definition library exceeds this ZIP’s definition limit.');
  const total = files.reduce((sum, item) => sum + item.data.length, 0);
  if (!skills.length && !agents.length) fail('This project and Core library have no reusable skills or specialist agents to export.');
  if (files.length + 1 > DEFINITION_BUNDLE_LIMITS.entries || total > payloadLimit) fail('The complete definitions exceed the bounded ZIP file or byte limit.');
  if (new Set(files.map(item => item.path.toLowerCase())).size !== files.length) fail('The definitions contain file names that collide on another supported filesystem.');
  return { skills, agents, files, pins };
}
function storeReview(value, internal) {
  for (const [id, old] of reviews) if (Date.now() - old.createdAt > lifetime) discardDefinitionBundleReview({ id });
  while (reviews.size >= 16) discardDefinitionBundleReview({ id: reviews.keys().next().value });
  const id = digest([value, internal.context, internal.pins || null, randomUUID()]), review = { ...value, id };
  reviews.set(id, { ...internal, public: clone(review), createdAt: Date.now() }); return review;
}
function reviewed(review, kind, cwd) {
  const saved = review?.id && reviews.get(review.id);
  if (!saved || saved.public.kind !== kind || digest(saved.public) !== digest(review) || Date.now() - saved.createdAt > lifetime) fail('This definition review changed or expired. Preview it again.', 'STALE_REVIEW');
  assertContext(saved.context, cwd); return saved;
}
export function discardDefinitionBundleReview(review) {
  const saved = reviews.get(review?.id); if (!saved) return;
  reviews.delete(review.id); fs.rmSync(saved.directory, { recursive: true, force: true });
}
process.once('exit', () => {
  for (const [id] of reviews) {
    try { discardDefinitionBundleReview({ id }); } catch { /* Orphaned private stages expire on a later preview. */ }
  }
});

export function previewDefinitionExport({ cwd = process.cwd(), outputPath } = {}) {
  const context = capture(cwd), destination = outputAt(context, outputPath), content = collect(context), directory = stage();
  try {
    const manifest = { format: 'bzzy-definitions', version: 1, createdAt: new Date().toISOString(), skills: content.skills, agents: content.agents };
    const data = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
    if (data.length > DEFINITION_BUNDLE_LIMITS.fileBytes) fail('The definitions manifest exceeds its bounded size.');
    for (const file of content.files) writeFile(directory, file.path, file.data);
    writeFile(directory, 'manifest.json', data);
    const inventory = [inventoryFile('manifest.json', data), ...content.files.map(file => inventoryFile(file.path, file.data))];
    const entries = [...content.skills.map(item => contentEntry('skill', item)), ...content.agents.map(item => contentEntry('agent', { ...item, files: [{ path: 'definition.json', bytes: item.bytes, sha256: item.sha256 }] },
      JSON.parse(content.files.find(file => file.path === item.file).data.toString('utf8'))))];
    const totals = { skills: content.skills.length, agents: content.agents.length, files: content.files.length, bytes: content.files.reduce((sum, item) => sum + item.data.length, 0) };
    return storeReview({ kind: 'definition-export', version: 1, entries, totals, outputPath: destination }, { context, directory, pins: content.pins, manifest, inventory });
  } catch (error) { fs.rmSync(directory, { recursive: true, force: true }); throw error; }
}
export function exportDefinitionBundle(review, { cwd = process.cwd(), outputPath = review?.outputPath } = {}) {
  const saved = reviewed(review, 'definition-export', cwd);
  if (outputPath !== review.outputPath) fail('Preview the chosen ZIP destination before exporting.', 'STALE_REVIEW');
  const current = collect(saved.context);
  if (digest(current.pins) !== digest(saved.pins) || digest([current.skills, current.agents]) !== digest([saved.manifest.skills, saved.manifest.agents])) fail('A source definition changed. Preview the export again.', 'STALE_REVIEW');
  outputAt(saved.context, outputPath);
  const published = archive({ operation: 'create', cwd: saved.context.cwd, fingerprint: saved.context.fingerprint, name: path.basename(outputPath), source: saved.directory, files: saved.inventory });
  const { data, device, inode } = regular(outputPath, DEFINITION_BUNDLE_LIMITS.bytes, true);
  if (published.sha256 !== digest(data) || published.bytes !== data.length || published.device !== device || published.inode !== inode) fail('The published ZIP changed before export completed. Preview and export again; the changed file was left untouched.', 'STALE_REVIEW');
  const result = { path: outputPath, sha256: digest(data), bytes: data.length, skills: review.totals.skills, agents: review.totals.agents };
  discardDefinitionBundleReview(review); return result;
}

function validateManifest(manifest, extracted, directory, context) {
  object(manifest, ['format', 'version', 'createdAt', 'skills', 'agents']);
  if (manifest.format !== 'bzzy-definitions' || manifest.version !== 1 || typeof manifest.createdAt !== 'string' || manifest.createdAt.length > 40 || !Number.isFinite(Date.parse(manifest.createdAt)) ||
      !Array.isArray(manifest.skills) || !Array.isArray(manifest.agents) || !manifest.skills.length && !manifest.agents.length || manifest.skills.length + manifest.agents.length > DEFINITION_BUNDLE_LIMITS.definitions) fail('Unsupported reusable-definitions manifest.');
  const paths = new Map([['manifest.json', null]]), names = new Set(), entries = [];
  const add = file => {
    object(file, ['path', 'bytes', 'sha256']);
    if (!safePath(file.path, 360) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > DEFINITION_BUNDLE_LIMITS.fileBytes || !hash(file.sha256) || paths.has(file.path.toLowerCase())) fail('Invalid or duplicate definition resource.');
    const data = regular(path.join(directory, file.path)); portable(data, context);
    if (data.length !== file.bytes || digest(data) !== file.sha256) fail('A definition resource failed its exact manifest hash check.');
    paths.set(file.path.toLowerCase(), file); return data;
  };
  for (const item of manifest.skills) {
    object(item, ['name', 'description', 'scope', 'version', 'files']);
    if (!name(item.name) || !scope(item.scope) || !hash(item.version) || !Array.isArray(item.files) || !item.files.length || item.files.length > 512 || !item.files.some(file => file.path === 'SKILL.md') || names.has(`skill:${item.scope}:${item.name}`)) fail('Invalid or duplicate skill definition.');
    names.add(`skill:${item.scope}:${item.name}`);
    for (const file of item.files) {
      if (!safePath(file.path) || privateResource(file.path)) fail(`Skill “${item.name}” contains a private or unsafe resource.`);
      add({ ...file, path: `skills/${item.scope}/${item.name}/${file.path}` });
    }
    if (digest(item.files) !== item.version) fail('A skill version does not match its complete resource inventory.');
    const checked = importSkill(path.join(directory, 'skills', item.scope, item.name), { scope: item.scope, projectId: context.projectId, preview: true, expectedVersion: item.version });
    if (checked.name !== item.name || checked.description !== item.description) fail('Skill metadata does not match the manifest.');
    entries.push(contentEntry('skill', item));
  }
  for (const item of manifest.agents) {
    object(item, ['name', 'description', 'scope', 'version', 'file', 'bytes', 'sha256']);
    if (!name(item.name) || !scope(item.scope) || !hash(item.version) || item.file !== `agents/${item.scope}/${item.name}.json` || names.has(`agent:${item.scope}:${item.name}`)) fail('Invalid or duplicate specialist definition.');
    names.add(`agent:${item.scope}:${item.name}`);
    let definition; try { definition = JSON.parse(add({ path: item.file, bytes: item.bytes, sha256: item.sha256 }).toString('utf8')); } catch { fail('Invalid specialist definition JSON.'); }
    const normalized = normalizeSubagentDefinition(definition);
    if (digest(normalized) !== item.version || normalized.name !== item.name || normalized.description !== item.description || digest(normalized) !== digest(definition)) fail('Specialist metadata does not match its reviewed definition.');
    entries.push(contentEntry('agent', { ...item, files: [{ path: 'definition.json', bytes: item.bytes, sha256: item.sha256 }] }, normalized));
  }
  if (extracted.length !== paths.size || extracted.some(file => !paths.has(file.toLowerCase())) || paths.size > DEFINITION_BUNDLE_LIMITS.entries || [...paths.values()].reduce((sum, file) => sum + (file?.bytes || 0), 0) > payloadLimit) fail('The ZIP contains missing, extra or excessive resources outside its exact manifest.');
  return entries;
}
function destination(entry, context) {
  const id = entry.kind === 'skill' ? skillStorageId(entry.name, { scope: entry.scope, projectId: context.projectId }) : digest([entry.scope, entry.scope === 'project' ? context.cwd : null, entry.name]);
  const existing = getRecord(entry.kind === 'skill' ? 'core.skill' : 'core.subagent.definition', id);
  return { kind: entry.kind, name: entry.name, scope: entry.scope, id, conflict: Boolean(existing), revision: existing?.revision || 0, version: existing?.version || null };
}
export function previewDefinitionImport(file, { cwd = process.cwd() } = {}) {
  const context = capture(cwd), source = path.resolve(cwd, file), data = regular(source, DEFINITION_BUNDLE_LIMITS.bytes), directory = stage();
  try {
    const archiveSha256 = digest(data), archivePath = path.join(directory, 'input.zip'), payload = path.join(directory, 'payload');
    fs.writeFileSync(archivePath, data, { mode: 0o600, flag: 'wx' }); privateDir(payload);
    const extracted = archive({ operation: 'extract', source: archivePath, target: payload }).files;
    let manifest; try { manifest = JSON.parse(regular(path.join(payload, 'manifest.json')).toString('utf8')); } catch { fail('The ZIP has no valid bounded definitions manifest.'); }
    const entries = validateManifest(manifest, extracted, payload, context), destinations = entries.map(entry => destination(entry, context));
    const conflicts = destinations.filter(item => item.conflict).map(({ kind, name, scope }) => ({ kind, name, scope }));
    const totals = { skills: manifest.skills.length, agents: manifest.agents.length, files: entries.reduce((sum, entry) => sum + entry.files.length, 0), bytes: entries.reduce((sum, entry) => sum + entry.files.reduce((bytes, file) => bytes + file.bytes, 0), 0) };
    return storeReview({ kind: 'definition-import', version: 1, archiveSha256, entries, conflicts, totals }, { context, directory, source, archiveSha256, manifest, extracted, payload, destinations });
  } catch (error) { fs.rmSync(directory, { recursive: true, force: true }); throw error; }
}
export function importDefinitionBundle(review, { cwd = process.cwd(), skipConflicts = false } = {}) {
  const saved = reviewed(review, 'definition-import', cwd);
  if (typeof skipConflicts !== 'boolean') fail('Choose whether to skip the reviewed name conflicts.');
  if (digest(regular(saved.source, DEFINITION_BUNDLE_LIMITS.bytes)) !== saved.archiveSha256) fail('The selected ZIP changed. Preview it again.', 'STALE_REVIEW');
  validateManifest(saved.manifest, saved.extracted, saved.payload, saved.context);
  const created = [], result = { skills: [], agents: [], skipped: [] };
  try {
    transaction(() => {
      assertContext(saved.context, cwd);
      const destinations = review.entries.map(entry => destination(entry, saved.context));
      if (digest(destinations) !== digest(saved.destinations)) fail('A destination definition changed. Preview the import again.', 'STALE_REVIEW');
      if (!skipConflicts && destinations.some(item => item.conflict)) fail('Definition names already exist. Nothing was imported; choose the reviewed non-conflicting entries explicitly.', 'CONFLICT');
      for (const [index, entry] of review.entries.entries()) {
        if (entry.kind !== 'skill' || destinations[index].conflict) continue;
        const target = skillDirectory({ ...entry, projectId: saved.context.projectId }); libraryPathSafe(target);
        if (fs.existsSync(target)) {
          // Historical immutable packages may outlive their catalog row. Never
          // replace them, or trust the path's content-addressed name alone.
          const existing = importSkill(target, { scope: entry.scope, projectId: saved.context.projectId, preview: true, expectedVersion: entry.version });
          if (existing.name !== entry.name || existing.description !== entry.description) fail('An existing historical skill package does not match the reviewed import.');
        }
      }
      for (const [index, entry] of review.entries.entries()) {
        if (destinations[index].conflict) { result.skipped.push({ kind: entry.kind, name: entry.name, scope: entry.scope }); continue; }
        if (entry.kind === 'skill') {
          const target = skillDirectory({ ...entry, projectId: saved.context.projectId });
          libraryPathSafe(target);
          if (!fs.existsSync(target)) created.push(target);
          result.skills.push(importSkill(path.join(saved.payload, 'skills', entry.scope, entry.name), { scope: entry.scope, projectId: saved.context.projectId,
            expectedRevision: 0, expectedVersion: entry.version, provenance: { kind: 'definition-bundle' } }));
        } else {
          const definition = JSON.parse(regular(path.join(saved.payload, 'agents', entry.scope, entry.name + '.json')).toString('utf8'));
          const record = saveSubagentDefinition(definition, { cwd: saved.context.cwd, scope: entry.scope, expectedRevision: 0 });
          result.agents.push({ name: record.name, scope: record.scope, version: record.version, revision: record.revision });
        }
      }
    });
  } catch (error) {
    for (const directory of created.reverse()) fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  discardDefinitionBundleReview(review); return result;
}

export function readDefinitionBundleFile(review, { cwd = process.cwd(), entryIndex, file, offset = 0, limit = 16384 } = {}) {
  const saved = reviewed(review, review?.kind, cwd), entry = review.entries[entryIndex];
  if (!Number.isSafeInteger(entryIndex) || entryIndex < 0 || !entry || !safePath(file) || !Number.isSafeInteger(offset) || offset < 0 ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 32768) fail('Choose a reviewed definition file and bounded text page.');
  const resource = entry.files.find(item => item.path === file);
  if (!resource) fail('The file is not in the reviewed definition.');
  if (saved.public.kind === 'definition-export') {
    for (const pin of saved.pins) {
      const current = getRecord(pin.kind === 'skill' ? 'core.skill' : 'core.subagent.definition', pin.id);
      if (!current || current.revision !== pin.revision || current.version !== pin.version) fail('A source definition changed. Preview the export again.', 'STALE_REVIEW');
    }
  } else if (digest(regular(saved.source, DEFINITION_BUNDLE_LIMITS.bytes)) !== saved.archiveSha256) fail('The selected ZIP changed. Preview it again.', 'STALE_REVIEW');
  const relative = entry.kind === 'skill' ? `skills/${entry.scope}/${entry.name}/${file}` : `agents/${entry.scope}/${entry.name}.json`;
  const data = regular(path.join(saved.payload || saved.directory, relative));
  if (data.length !== resource.bytes || digest(data) !== resource.sha256) fail('The reviewed definition file changed.', 'STALE_REVIEW');
  let text;
  try { new TextDecoder('utf-8', { fatal: true }).decode(data); text = new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(offset, Math.min(data.length, offset + limit)), { stream: offset + limit < data.length }); }
  catch { return { file, text: null, binary: true, size: data.length, bytes: data.length, sha256: resource.sha256, nextOffset: null }; }
  const consumed = Buffer.byteLength(text);
  if (!consumed && offset < data.length) fail('Increase the page size to include the next complete character.');
  return { file, text, binary: false, offset, size: data.length, bytes: data.length, sha256: resource.sha256, nextOffset: offset + consumed < data.length ? offset + consumed : null };
}
