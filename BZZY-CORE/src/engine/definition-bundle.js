import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { home, privateDir } from './files.js';
import { database, getRecord, putRecord, transaction, digest, now } from './database.js';
import { resolveProjectIdentity } from './project-identity.js';
import { listSkills, inspectSkill, importSkill, skillStorageId, setSkillEnabled } from './skills.js';
import { listSubagentDefinitions, getSubagentDefinition, normalizeSubagentDefinition, saveSubagentDefinition, setSubagentEnabled } from './subagent-definitions.js';
import { assertPortableDefinitionText as portable } from './definition-portability.js';
import { listWorkflows, getWorkflow, normalizeWorkflow, saveWorkflow } from './workflows.js';
import { normalizeGoalTemplate, saveGoalTemplate, listGoalTemplates as listSavedGoals,
  getSavedGoalTemplate as getSavedGoal, hasGoalTemplateObjective as hasSavedGoalObjective } from './goal-templates.js';

export const DEFINITION_BUNDLE_LIMITS = Object.freeze({ bytes: 64 * 1024 * 1024, fileBytes: 1024 * 1024, entries: 4096, definitions: 256 });
export const LIBRARY_BUNDLE_LIMITS = Object.freeze({ ...DEFINITION_BUNDLE_LIMITS, definitions: 1024 });
const payloadLimit = 60 * 1024 * 1024, reviews = new Map(), lifetime = 30 * 60 * 1000;
const agentFields = ['name', 'description', 'instructions', 'provider', 'model', 'effort', 'policy', 'limits', 'capabilities'];
const fail = (message, code = 'DEFINITION_BUNDLE') => { throw Object.assign(new Error(message), { code }); };
const portabilityFailure = (message, reasonCode, line) => {
  throw Object.assign(new Error(message), { code: 'DEFINITION_BUNDLE', reasonCode,
    ...(Number.isSafeInteger(line) && line > 0 ? { line } : {}) });
};
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
function outputAt(context, requested, label = 'definitions') {
  const value = requested || `bzzy-${label}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.zip`;
  const outputPath = path.resolve(context.cwd, value), basename = path.basename(outputPath);
  if (path.dirname(outputPath) !== context.cwd || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}\.zip$/i.test(basename)) fail('Export a ZIP filename directly in the current project directory.');
  if (fs.existsSync(outputPath) || (() => { try { fs.lstatSync(outputPath); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } })()) fail('That export destination already exists. Choose another ZIP filename.', 'CONFLICT');
  return outputPath;
}
function pageAll(read, field, maximum = DEFINITION_BUNDLE_LIMITS.definitions) {
  const rows = []; let offset = 0;
  do {
    const page = read(offset); rows.push(...page[field]);
    if (rows.length > maximum) fail('The reusable-definition library exceeds this ZIP’s definition limit.');
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

const libraryKinds = ['skill', 'agent', 'workflow', 'goal'];
const excludedEntryFields = ['kind', 'scope', 'name', 'id', 'revision', 'version'];
const entryKey = entry => JSON.stringify([entry.kind, entry.scope, entry.name]);
function chosenKinds(value = libraryKinds) {
  if (!Array.isArray(value) || !value.length || value.length > libraryKinds.length || new Set(value).size !== value.length || [...value].some(kind => !libraryKinds.includes(kind))) {
    fail('Choose one or more Library kinds: skill, agent, workflow or goal.');
  }
  return [...value].sort();
}
function definitionExclusions(value = [], kinds) {
  if (!Array.isArray(value) || value.length > LIBRARY_BUNDLE_LIMITS.definitions) fail('Choose a bounded list of exact Library entries to exclude.');
  const seen = new Set();
  return [...value].map(entry => {
    object(entry, excludedEntryFields);
    if (Object.keys(entry).length !== excludedEntryFields.length || !['skill', 'agent', 'workflow'].includes(entry.kind) || !kinds.includes(entry.kind) ||
      !scope(entry.scope) || !name(entry.name) || typeof entry.id !== 'string' || !entry.id || entry.id.length > 240 || /[\x00-\x1f\x7f-\x9f]/u.test(entry.id) ||
      !Number.isSafeInteger(entry.revision) || entry.revision < 1 || !hash(entry.version) || seen.has(entryKey(entry))) fail('Exclude only exact, revision-pinned entries from the selected Library kinds.');
    seen.add(entryKey(entry));
    return Object.fromEntries(excludedEntryFields.map(field => [field, entry[field]]));
  }).sort((a, b) => entryKey(a).localeCompare(entryKey(b)));
}
function librarySelectionPins(value, kinds) {
  if (!Array.isArray(value) || value.length > LIBRARY_BUNDLE_LIMITS.definitions) fail('Choose a bounded list of exact Library entries.');
  const definitions = [], goals = [], seen = new Set();
  for (const entry of value) {
    object(entry, excludedEntryFields);
    if (seen.has(entryKey(entry))) fail('Select each Library entry only once.');
    seen.add(entryKey(entry));
    if (entry.kind !== 'goal') { definitions.push(entry); continue; }
    if (Object.keys(entry).length !== excludedEntryFields.length || !kinds.includes('goal') || entry.scope !== 'global' ||
      typeof entry.id !== 'string' || !goalReference.test(entry.id) || !hash(entry.revision) || !hash(entry.version) || entry.name !== 'goal-' + entry.version.slice(0, 48)) {
      fail('Select only exact, revision-pinned saved goals from the current Library.');
    }
    goals.push(Object.fromEntries(excludedEntryFields.map(field => [field, entry[field]])));
  }
  return [...definitionExclusions(definitions, kinds), ...goals].sort((a, b) => entryKey(a).localeCompare(entryKey(b)));
}
// Local-owner metadata only. Resource bytes are checked after the owner selects
// names, so an unrelated blocked package cannot prevent a selective export.
export function listLibraryExportChoices({ cwd = process.cwd(), kinds = ['skill', 'agent'] } = {}) {
  const context = capture(cwd); kinds = chosenKinds(kinds);
  const entries = [], labels = {};
  for (const selected of ['global', 'project']) {
    if (kinds.includes('skill')) for (const item of pageAll(offset => listSkills({ projectRoot: context.projectRoot, scope: selected, offset, limit: 100 }), 'skills', LIBRARY_BUNDLE_LIMITS.definitions)) {
      entries.push(definitionPin('skill', selected, item));
    }
    if (kinds.includes('agent')) for (const item of pageAll(offset => listSubagentDefinitions({ cwd: context.cwd, scope: selected, offset, limit: 100 }), 'subagents', LIBRARY_BUNDLE_LIMITS.definitions)) {
      entries.push(definitionPin('agent', selected, item));
    }
    if (kinds.includes('workflow')) for (const item of pageAll(offset => listWorkflows({ cwd: context.cwd, scope: selected, offset, limit: 100 }), 'workflows', LIBRARY_BUNDLE_LIMITS.definitions)) {
      entries.push(definitionPin('workflow', selected, item));
    }
  }
  if (kinds.includes('goal')) for (const goal of pageAll(offset => listSavedGoals({ offset, limit: 100 }), 'goals', LIBRARY_BUNDLE_LIMITS.definitions)) {
    const definition = { objective: goal.objective }, entry = { kind: 'goal', scope: 'global', name: goalName(definition),
      id: goal.id, revision: goal.revision, version: digest(definition) };
    entries.push(entry); labels[entryKey(entry)] = goalDescription(goal.objective);
  }
  return { kinds, entries: librarySelectionPins(entries, kinds), ...(kinds.includes('goal') ? { labels } : {}) };
}
export function previewSelectedLibraryExport({ cwd = process.cwd(), kinds = ['skill', 'agent'], selectedEntries } = {}) {
  kinds = chosenKinds(kinds);
  if (!Array.isArray(selectedEntries) || !selectedEntries.length) fail('Select at least one entry to export.');
  const selected = librarySelectionPins(selectedEntries, kinds), current = listLibraryExportChoices({ cwd, kinds }).entries;
  const available = new Map(current.map(entry => [entryKey(entry), entry]));
  for (const entry of selected) if (digest(available.get(entryKey(entry)) || null) !== digest(entry)) fail('A selected entry changed. Open Export again.', 'STALE_REVIEW');
  const selectedKeys = new Set(selected.map(entryKey));
  const omitted = current.filter(entry => !selectedKeys.has(entryKey(entry)));
  return previewLibraryExport({ cwd, kinds, excludeEntries: omitted.filter(entry => entry.kind !== 'goal'),
    excludeGoalIds: omitted.filter(entry => entry.kind === 'goal').map(entry => entry.id) });
}
const definitionPin = (kind, scope, record) => ({ kind, scope, name: record.name, id: record.id || record.name,
  revision: record.revision, version: record.version });
function omitDefinition(pin, state, pins) {
  const excluded = state?.exclusions.get(entryKey(pin));
  if (!excluded) return false;
  if (digest(excluded) !== digest(pin)) fail('An excluded Library entry changed. Review its current version before omitting it.', 'STALE_REVIEW');
  state.found.add(entryKey(pin)); state.excludedEntries.push({ ...pin, reason: 'Explicitly excluded by the owner.' });
  pins.push({ ...pin, kind: 'excluded-' + pin.kind }); return true;
}
const blockedReasons = Object.freeze({
  CREDENTIAL: 'A configured credential or recognizable secret pattern was detected.',
  CREDENTIAL_LITERAL: 'A literal credential or account value is embedded. Use an environment reference or placeholder.',
  PRIVATE_ACCOUNT: 'An account address is embedded. Parameterize it in the reusable text.',
  PRIVATE_HOST_PATH: 'A private host path is embedded. Parameterize it in the reusable text.',
  PRIVATE_RESOURCE: 'The package contains private case, evidence, binding or runtime resources.',
  RESOURCE_PATH: 'The package contains an unsafe resource path.',
  RESOURCE_TYPE: 'A resource is linked, oversized or is not a regular file.',
  RESOURCE_IO: 'A resource is missing or cannot be read safely.',
  CONTENT_CHANGED: 'The resource bytes no longer match the saved immutable version.',
  METADATA: 'SKILL.md metadata does not match the registered package.',
  PACKAGE_INVALID: 'The package failed its inventory, metadata or integrity validation.',
});
function blockedDefinition(pin, error, fallback = 'PACKAGE_INVALID', file) {
  let reasonCode = error?.reasonCode;
  if (!Object.hasOwn(blockedReasons, reasonCode)) {
    const message = error?.message || '';
    if (['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR'].includes(error?.code)) reasonCode = 'RESOURCE_IO';
    else if (error?.code === 'ELOOP' || /^(?:Skill import does not accept symbolic|Skill files must be bounded)/.test(message)) reasonCode = 'RESOURCE_TYPE';
    else if (error?.code === 'WORKFLOW_PIN_INVALID' || message === 'Skill source changed. Run sync again.') reasonCode = 'CONTENT_CHANGED';
    else if (message === 'Skill contains an unsafe, hidden or authentication path.') reasonCode = 'RESOURCE_PATH';
    else if (/^(?:SKILL\.md|Invalid quoted skill metadata|Use a lowercase hyphenated name)/.test(message)) reasonCode = 'METADATA';
    else if (/^(?:Sharing blocked: selected context contains a credential\.|Workflows cannot contain credentials|Workflow text contains credential-like)/.test(message)) reasonCode = 'CREDENTIAL';
    else if (/^(?:Reusable subagents cannot contain credentials|Workflows cannot embed credentials)/.test(message)) reasonCode = 'CREDENTIAL_LITERAL';
    else reasonCode = fallback;
  }
  return { ...pin, reasonCode, reason: blockedReasons[reasonCode], ...(file ? { file } : {}),
    ...(Number.isSafeInteger(error?.line) && error.line > 0 ? { line: error.line } : {}) };
}

// Import diagnostics carry only validated package identity and fixed policy
// reasons. Never expose matched resource text, account values or host paths.
function importPortable(data, context, entry, file) {
  try { portable(data, context); }
  catch (error) {
    if (['CREDENTIAL', 'CREDENTIAL_LITERAL', 'PRIVATE_ACCOUNT', 'PRIVATE_HOST_PATH'].includes(error?.reasonCode)
      && ['skill', 'agent', 'workflow', 'goal'].includes(entry?.kind) && name(entry.name) && scope(entry.scope)) {
      try {
        portable(Buffer.from(entry.name), context);
        const diagnostic = { kind: entry.kind, name: entry.name, scope: entry.scope, reasonCode: error.reasonCode };
        if (safePath(file) && /^[a-zA-Z0-9_./-]+$/.test(file)) {
          try { portable(Buffer.from(file), context); diagnostic.file = file; } catch {}
        }
        if (diagnostic.file && Number.isSafeInteger(error.line) && error.line > 0 && error.line <= 1000000) diagnostic.line = error.line;
        error.importDiagnostic = diagnostic;
      } catch {}
    }
    throw error;
  }
}

function collect(context, { allowEmpty = false, inheritSelection = false, maximum = DEFINITION_BUNDLE_LIMITS.definitions,
  kinds = ['skill', 'agent'], selection } = {}) {
  const skills = [], agents = [], files = [], pins = [];
  for (const selected of ['global', 'project']) {
    if (kinds.includes('skill')) for (const item of pageAll(offset => listSkills({ projectRoot: context.projectRoot, projectId: context.projectId, scope: selected, offset, limit: 100 }), 'skills', maximum)) {
      const options = { scope: selected, projectId: context.projectId }, record = getRecord('core.skill', item.id || skillStorageId(item.name, options));
      if (!record || record.version !== item.version || !selection && (!Array.isArray(record.files) || digest(record.files) !== record.version))
        fail('A skill inventory changed. Preview the definitions again.', 'STALE_REVIEW');
      const pin = definitionPin('skill', selected, record);
      if (omitDefinition(pin, selection, pins)) continue;
      let resourceFile, phase = 'PACKAGE_INVALID';
      try {
        if (!Array.isArray(record.files) || digest(record.files) !== record.version) portabilityFailure('The skill inventory no longer matches its immutable version.', 'CONTENT_CHANGED');
        inspectSkill(record.id || record.name, options);
        if (record.files.some(file => privateResource(file.path))) portabilityFailure(`Skill “${item.name}” contains private case, evidence, binding or runtime resources and cannot be exported as reusable behavior.`, 'PRIVATE_RESOURCE');
        const checked = importSkill(skillDirectory(record), { ...options, preview: true, expectedVersion: record.version });
        const candidateFiles = [];
        const resources = record.files.map(file => {
          resourceFile = undefined; phase = 'RESOURCE_PATH';
          if (!safePath(file.path)) portabilityFailure('Unsafe reusable skill path.', 'RESOURCE_PATH');
          portable(Buffer.from(file.path), context);
          resourceFile = file.path; phase = 'RESOURCE_TYPE';
          const data = regular(path.join(skillDirectory(record), file.path));
          if (data.length !== file.bytes || digest(data) !== file.sha256) portabilityFailure('Immutable skill content changed.', 'CONTENT_CHANGED');
          portable(data, { ...context, resourcePath: file.path }); candidateFiles.push({ path: `skills/${selected}/${record.name}/${file.path}`, data }); return { ...file };
        });
        resourceFile = 'SKILL.md'; phase = 'METADATA';
        if (checked.name !== record.name || checked.description !== record.description) portabilityFailure('Skill metadata changed.', 'METADATA');
        files.push(...candidateFiles);
        skills.push({ name: record.name, description: record.description, scope: selected, version: record.version, files: resources });
        pins.push({ kind: 'skill', id: record.id || record.name, revision: record.revision, version: record.version });
      } catch (error) {
        if (selection) selection.blockedEntries.push(blockedDefinition(pin, error, phase, resourceFile));
        else if (error.reasonCode === 'PRIVATE_RESOURCE') throw error;
        else fail(`Skill “${item.name}” is not a safe, intact portable package. Review its resources before exporting.`);
      }
    }
    if (kinds.includes('agent')) for (const item of pageAll(offset => listSubagentDefinitions({ cwd: context.cwd, scope: selected, offset, limit: 100 }), 'subagents', maximum)) {
      const record = getSubagentDefinition(item.name, { cwd: context.cwd, scope: selected });
      const pin = definitionPin('agent', selected, record);
      if (omitDefinition(pin, selection, pins)) continue;
      try {
        const definition = normalizeSubagentDefinition(Object.fromEntries(agentFields.filter(key => Object.hasOwn(record, key) &&
          (!inheritSelection || !['provider', 'model', 'effort'].includes(key))).map(key => [key, record[key]])));
        const data = Buffer.from(JSON.stringify(definition, null, 2) + '\n'); portable(data, context);
        const file = `agents/${selected}/${record.name}.json`, resource = inventoryFile(file, data);
        files.push({ path: file, data }); agents.push({ name: record.name, description: record.description, scope: selected, version: digest(definition), file, bytes: resource.bytes, sha256: resource.sha256 });
        pins.push({ kind: 'agent', id: record.id, revision: record.revision, version: record.version });
      } catch (error) { if (selection) selection.blockedEntries.push(blockedDefinition(pin, error)); else throw error; }
    }
  }
  if (skills.length + agents.length > maximum) fail('The reusable-definition library exceeds this ZIP’s definition limit.');
  const total = files.reduce((sum, item) => sum + item.data.length, 0);
  if (!allowEmpty && !skills.length && !agents.length) fail('This project and Core library have no reusable skills or specialist agents to export.');
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

function definitionKinds(kinds = ['skill', 'agent']) {
  if (!Array.isArray(kinds) || !kinds.length || kinds.length > 2 || new Set(kinds).size !== kinds.length ||
    [...kinds].some(kind => !['skill', 'agent'].includes(kind))) fail('Choose skills, agents or both for this ZIP.');
  return [...kinds].sort();
}
export function previewDefinitionExport({ cwd = process.cwd(), outputPath, kinds } = {}) {
  kinds = definitionKinds(kinds);
  const context = capture(cwd), destination = outputAt(context, outputPath, kinds.length === 1 ? kinds[0] + 's' : 'definitions'), content = collect(context, { kinds }), directory = stage();
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
    return storeReview({ kind: 'definition-export', version: 1, kinds, entries, totals, outputPath: destination }, { context, directory, pins: content.pins, manifest, inventory });
  } catch (error) { fs.rmSync(directory, { recursive: true, force: true }); throw error; }
}
export function exportDefinitionBundle(review, { cwd = process.cwd(), outputPath = review?.outputPath } = {}) {
  const saved = reviewed(review, 'definition-export', cwd);
  if (outputPath !== review.outputPath) fail('Preview the chosen ZIP destination before exporting.', 'STALE_REVIEW');
  const current = collect(saved.context, { kinds: saved.public.kinds });
  if (digest(current.pins) !== digest(saved.pins) || digest([current.skills, current.agents]) !== digest([saved.manifest.skills, saved.manifest.agents])) fail('A source definition changed. Preview the export again.', 'STALE_REVIEW');
  outputAt(saved.context, outputPath);
  const published = archive({ operation: 'create', cwd: saved.context.cwd, fingerprint: saved.context.fingerprint, name: path.basename(outputPath), source: saved.directory, files: saved.inventory });
  const { data, device, inode } = regular(outputPath, DEFINITION_BUNDLE_LIMITS.bytes, true);
  if (published.sha256 !== digest(data) || published.bytes !== data.length || published.device !== device || published.inode !== inode) fail('The published ZIP changed before export completed. Preview and export again; the changed file was left untouched.', 'STALE_REVIEW');
  const result = { path: outputPath, sha256: digest(data), bytes: data.length, skills: review.totals.skills, agents: review.totals.agents };
  discardDefinitionBundleReview(review); return result;
}

function validateManifest(manifest, extracted, directory, context, { allowEmpty = false, maximum = DEFINITION_BUNDLE_LIMITS.definitions } = {}) {
  object(manifest, ['format', 'version', 'createdAt', 'skills', 'agents']);
  if (manifest.format !== 'bzzy-definitions' || manifest.version !== 1 || typeof manifest.createdAt !== 'string' || manifest.createdAt.length > 40 || !Number.isFinite(Date.parse(manifest.createdAt)) ||
      !Array.isArray(manifest.skills) || !Array.isArray(manifest.agents) || !allowEmpty && !manifest.skills.length && !manifest.agents.length || manifest.skills.length + manifest.agents.length > maximum) fail('Unsupported reusable-definitions manifest.');
  const paths = new Map([['manifest.json', null]]), names = new Set(), entries = [];
  const add = (file, entry, resourcePath) => {
    object(file, ['path', 'bytes', 'sha256']);
    if (!safePath(file.path, 360) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > DEFINITION_BUNDLE_LIMITS.fileBytes || !hash(file.sha256) || paths.has(file.path.toLowerCase())) fail('Invalid or duplicate definition resource.');
    importPortable(Buffer.from(file.path), context, entry, resourcePath);
    const data = regular(path.join(directory, file.path)); importPortable(data, { ...context, resourcePath: file.path }, entry, resourcePath);
    if (data.length !== file.bytes || digest(data) !== file.sha256) fail('A definition resource failed its exact manifest hash check.');
    paths.set(file.path.toLowerCase(), file); return data;
  };
  for (const item of manifest.skills) {
    object(item, ['name', 'description', 'scope', 'version', 'files']);
    if (!name(item.name) || !scope(item.scope) || !hash(item.version) || !Array.isArray(item.files) || !item.files.length || item.files.length > 512 || !item.files.some(file => file.path === 'SKILL.md') || names.has(`skill:${item.scope}:${item.name}`)) fail('Invalid or duplicate skill definition.');
    names.add(`skill:${item.scope}:${item.name}`);
    for (const file of item.files) {
      if (!safePath(file.path) || privateResource(file.path)) fail(`Skill “${item.name}” contains a private or unsafe resource.`);
      add({ ...file, path: `skills/${item.scope}/${item.name}/${file.path}` }, { kind: 'skill', ...item }, file.path);
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
    const data = add({ path: item.file, bytes: item.bytes, sha256: item.sha256 }, { kind: 'agent', ...item }, 'definition.json');
    let definition; try { definition = JSON.parse(data.toString('utf8')); } catch { fail('Invalid specialist definition JSON.'); }
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
export function previewDefinitionImport(file, { cwd = process.cwd(), kinds } = {}) {
  kinds = definitionKinds(kinds);
  const context = capture(cwd), source = path.resolve(cwd, file), data = regular(source, DEFINITION_BUNDLE_LIMITS.bytes), directory = stage();
  try {
    const archiveSha256 = digest(data), archivePath = path.join(directory, 'input.zip'), payload = path.join(directory, 'payload');
    fs.writeFileSync(archivePath, data, { mode: 0o600, flag: 'wx' }); privateDir(payload);
    const extracted = archive({ operation: 'extract', source: archivePath, target: payload }).files;
    let manifest; try { manifest = JSON.parse(regular(path.join(payload, 'manifest.json')).toString('utf8')); } catch { fail('The ZIP has no valid bounded definitions manifest.'); }
    const entries = validateManifest(manifest, extracted, payload, context).filter(entry => kinds.includes(entry.kind)), destinations = entries.map(entry => destination(entry, context));
    if (!entries.length) fail('This ZIP contains no definitions of the selected type.');
    const conflicts = destinations.filter(item => item.conflict).map(({ kind, name, scope }) => ({ kind, name, scope }));
    const totals = { skills: entries.filter(entry => entry.kind === 'skill').length, agents: entries.filter(entry => entry.kind === 'agent').length, files: entries.reduce((sum, entry) => sum + entry.files.length, 0), bytes: entries.reduce((sum, entry) => sum + entry.files.reduce((bytes, file) => bytes + file.bytes, 0), 0) };
    return storeReview({ kind: 'definition-import', version: 1, kinds, archiveSha256, entries, conflicts, totals }, { context, directory, source, archiveSha256, manifest, extracted, payload, destinations });
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
  if (saved.public.kind === 'library-export') {
    if (collectLibrary(saved.context, { excludeGoalIds: review.excludeGoalIds, kinds: review.kinds, excludeEntries: review.excludeEntries }).sourceDigest !== review.sourceDigest) fail('A source library entry changed. Preview the Library share again.', 'STALE_REVIEW');
  } else if (saved.public.kind === 'definition-export') {
    for (const pin of saved.pins) {
      const current = getRecord(pin.kind === 'skill' ? 'core.skill' : 'core.subagent.definition', pin.id);
      if (!current || current.revision !== pin.revision || current.version !== pin.version) fail('A source definition changed. Preview the export again.', 'STALE_REVIEW');
    }
  } else if (digest(regular(saved.source, DEFINITION_BUNDLE_LIMITS.bytes)) !== saved.archiveSha256) fail('The selected ZIP changed. Preview it again.', 'STALE_REVIEW');
  const relative = entry.kind === 'skill' ? `skills/${entry.scope}/${entry.name}/${file}` : entry.kind === 'agent' ? `agents/${entry.scope}/${entry.name}.json`
    : entry.kind === 'workflow' ? `workflows/${entry.scope}/${entry.name}.json` : `goals/${entry.name}.json`;
  const data = regular(path.join(saved.payload || saved.directory, relative));
  if (data.length !== resource.bytes || digest(data) !== resource.sha256) fail('The reviewed definition file changed.', 'STALE_REVIEW');
  let text;
  try { new TextDecoder('utf-8', { fatal: true }).decode(data); text = new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(offset, Math.min(data.length, offset + limit)), { stream: offset + limit < data.length }); }
  catch { return { file, text: null, binary: true, size: data.length, bytes: data.length, sha256: resource.sha256, nextOffset: null }; }
  const consumed = Buffer.byteLength(text);
  if (!consumed && offset < data.length) fail('Increase the page size to include the next complete character.');
  return { file, text, binary: false, offset, size: data.length, bytes: data.length, sha256: resource.sha256, nextOffset: offset + consumed < data.length ? offset + consumed : null };
}

const goalName = definition => 'goal-' + digest(definition).slice(0, 48);
const goalDescription = objective => [...objective.split(/\r?\n/u)[0]].slice(0, 160).join('');
const goalReference = /^(?:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}|template:[a-f0-9]{64})$/;
function goalExclusions(value) {
  if (!Array.isArray(value) || value.length > LIBRARY_BUNDLE_LIMITS.definitions || new Set(value).size !== value.length || [...value].some(id => typeof id !== 'string' || !goalReference.test(id))) fail('Choose a bounded list of saved goals to exclude from this Library share.');
  return [...value].sort();
}
function collectLibrary(context, { excludeGoalIds = [], kinds, excludeEntries = [] } = {}) {
  kinds = chosenKinds(kinds);
  const selectedExclusions = definitionExclusions(excludeEntries, kinds);
  const selection = { exclusions: new Map(selectedExclusions.map(entry => [entryKey(entry), entry])), found: new Set(), excludedEntries: [], blockedEntries: [] };
  const exclusions = new Set(goalExclusions(excludeGoalIds)), excludedGoals = [], blockedGoals = [], found = new Set();
  if (!kinds.includes('goal') && exclusions.size) fail('Saved-goal exclusions require the goal Library kind.');
  const content = collect(context, { allowEmpty: true, inheritSelection: true, maximum: LIBRARY_BUNDLE_LIMITS.definitions, kinds, selection });
  const workflows = [], goals = [];
  const add = (kind, scope, definition, pin) => {
    const data = Buffer.from(JSON.stringify(definition, null, 2) + '\n');
    portable(data, { ...context, privateRoots: pin.cwd ? [pin.cwd] : [] });
    const name = definition.name || goalName(definition), file = kind === 'goal' ? `goals/${name}.json` : `workflows/${scope}/${name}.json`;
    const resource = inventoryFile(file, data), item = { name, description: kind === 'goal' ? goalDescription(definition.objective) : definition.description,
      scope, version: digest(definition), file, bytes: resource.bytes, sha256: resource.sha256 };
    content.files.push({ path: file, data }); content.pins.push(pin);
    (kind === 'goal' ? goals : workflows).push(item);
  };
  if (kinds.includes('workflow')) for (const scope of ['global', 'project']) {
    for (const summary of pageAll(offset => listWorkflows({ cwd: context.cwd, scope, offset, limit: 100 }), 'workflows', LIBRARY_BUNDLE_LIMITS.definitions)) {
      const pin = definitionPin('workflow', scope, summary);
      if (omitDefinition(pin, selection, content.pins)) continue;
      try {
        const record = getWorkflow(summary.name, { cwd: context.cwd, scope });
        if (digest(definitionPin('workflow', scope, record)) !== digest(pin)) fail('A workflow changed. Preview the Library share again.', 'STALE_REVIEW');
        const definition = normalizeWorkflow({ name: record.name, description: record.description, instructions: record.instructions,
          ...(record.schemaVersion === 2 ? { schemaVersion: 2, routing: record.routing } : {}) });
        if (record.version !== digest(definition)) fail('A workflow changed. Preview the Library share again.', 'STALE_REVIEW');
        add('workflow', scope, definition, { kind: 'workflow', id: record.id, revision: record.revision, version: record.version });
      } catch (error) {
        if (error?.code === 'STALE_REVIEW') throw error;
        selection.blockedEntries.push(blockedDefinition(pin, error));
      }
    }
  }
  if (kinds.includes('goal')) for (const goal of pageAll(offset => listSavedGoals({ offset, limit: 100 }), 'goals', LIBRARY_BUNDLE_LIMITS.definitions)) {
    found.add(goal.id);
    getSavedGoal(goal.id, { revision: goal.revision });
    if (exclusions.has(goal.id)) {
      excludedGoals.push({ id: goal.id, reason: 'Explicitly excluded by the owner.' });
      content.pins.push({ kind: 'excluded-goal', id: goal.id, revision: goal.revision }); continue;
    }
    let definition, reason;
    try { definition = normalizeGoalTemplate({ objective: goal.objective }); portable(Buffer.from(JSON.stringify(definition)), { ...context, privateRoots: goal.cwd ? [goal.cwd] : [] }); }
    catch { reason = 'Contains private credentials, account bindings, host paths or unsupported objective text.'; }
    if (reason) { blockedGoals.push({ id: goal.id, reason }); continue; }
    add('goal', 'global', definition, { kind: 'goal', id: goal.id, revision: goal.revision, cwd: goal.cwd });
  }
  if ([...selection.exclusions.keys()].some(key => !selection.found.has(key))) fail('An excluded Library entry is unavailable. Review the Library again.', 'STALE_REVIEW');
  if (selection.blockedEntries.length) {
    if (selection.blockedEntries.length > LIBRARY_BUNDLE_LIMITS.definitions) fail('Too many blocked Library entries. Select fewer kinds before sharing.');
    const first = selection.blockedEntries[0];
    throw Object.assign(new Error(`${selection.blockedEntries.length} selected Library entr${selection.blockedEntries.length === 1 ? 'y cannot' : 'ies cannot'} be shared. ${first.kind === 'skill' ? 'Skill' : first.kind === 'agent' ? 'Agent' : 'Workflow'} “${first.name}”: ${first.reason} Review the blocked entries or omit them explicitly.`),
      { code: 'LIBRARY_BLOCKED_ENTRIES', blockedEntries: selection.blockedEntries });
  }
  if ([...exclusions].some(id => !found.has(id))) fail('An excluded saved goal changed or is unavailable. Preview the Library again.', 'STALE_REVIEW');
  if (blockedGoals.length) {
    const error = Object.assign(new Error(`${blockedGoals.length} saved goal${blockedGoals.length === 1 ? '' : 's'} cannot be shared as portable text. Explicitly omit those goals or go back; nothing was shared.`),
      { code: 'LIBRARY_BLOCKED_GOALS', blockedGoals });
    throw error;
  }
  const total = content.skills.length + content.agents.length + workflows.length + goals.length;
  if (!total) fail('No skills, specialist agents, workflows or saved goals are available to share.');
  if (total > LIBRARY_BUNDLE_LIMITS.definitions || content.files.length + 1 > LIBRARY_BUNDLE_LIMITS.entries ||
      content.files.reduce((sum, file) => sum + file.data.length, 0) > payloadLimit) fail('The complete Library exceeds its bounded definition, resource or byte limit. Nothing was omitted.');
  return { ...content, workflows, goals, kinds, excludeEntries: selectedExclusions, excludedEntries: selection.excludedEntries,
    excludeGoalIds: [...exclusions].sort(), excludedGoals,
    sourceDigest: digest([content.skills, content.agents, workflows, goals, content.pins, kinds, selectedExclusions, [...exclusions].sort()]) };
}
function libraryPayload(context, content, directory) {
  const manifest = { format: 'bzzy-definitions', version: 2, createdAt: now(), skills: content.skills, agents: content.agents,
    workflows: content.workflows, goals: content.goals };
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  if (bytes.length > LIBRARY_BUNDLE_LIMITS.fileBytes) fail('The Library manifest exceeds its bounded size.');
  writeFile(directory, 'manifest.json', bytes);
  for (const file of content.files) writeFile(directory, file.path, file.data);
  const entries = [...content.skills.map(item => contentEntry('skill', item))];
  for (const [kind, items] of [['agent', content.agents], ['workflow', content.workflows], ['goal', content.goals]]) {
    for (const item of items) entries.push(contentEntry(kind, { ...item, files: [{ path: 'definition.json', bytes: item.bytes, sha256: item.sha256 }] },
      kind === 'agent' ? JSON.parse(content.files.find(file => file.path === item.file).data.toString('utf8')) : undefined));
  }
  const totals = { skills: content.skills.length, agents: content.agents.length, workflows: content.workflows.length,
    goals: content.goals.length, files: content.files.length, bytes: content.files.reduce((sum, file) => sum + file.data.length, 0) };
  return { manifest, entries, totals, inventory: [inventoryFile('manifest.json', bytes), ...content.files.map(file => inventoryFile(file.path, file.data))] };
}

export function previewLibraryExport({ cwd = process.cwd(), excludeGoalIds = [], kinds, excludeEntries = [] } = {}) {
  const context = capture(cwd), content = collectLibrary(context, { excludeGoalIds, kinds, excludeEntries }), directory = stage();
  try {
    const payload = libraryPayload(context, content, directory);
    return storeReview({ kind: 'library-export', version: 2, entries: payload.entries, totals: payload.totals, sourceDigest: content.sourceDigest,
      kinds: content.kinds, excludeEntries: content.excludeEntries, excludedEntries: content.excludedEntries,
      excludeGoalIds: content.excludeGoalIds, excludedGoals: content.excludedGoals },
      { context, directory, pins: content.pins, ...payload });
  } catch (error) { fs.rmSync(directory, { recursive: true, force: true }); throw error; }
}

function privateLibraryOutput(context, destination) {
  if (typeof destination !== 'string' || !path.isAbsolute(destination)) fail('Library transfer requires private host archive storage.');
  const relative = path.relative(context.home, destination), parts = relative.split(path.sep);
  if (parts.length !== 4 || parts[0] !== 'relay' || parts[1] !== 'shares' || !/^[a-f0-9-]{36}$/.test(parts[2]) || parts[3] !== 'project.zip') fail('Library archives belong in private Relay transfer storage.');
  for (let current = path.dirname(destination); ; current = path.dirname(current)) {
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077 || process.getuid && stat.uid !== process.getuid()) fail('Library transfer storage must be private and contain no links.');
    if (current === context.home) break;
    if (current === path.dirname(current)) fail('Invalid Library transfer storage.');
  }
  return realDirectory(path.dirname(destination));
}
export function buildLibraryArchive(destination, { cwd = process.cwd(), expectedDigest, excludeGoalIds = [], kinds, excludeEntries = [] } = {}) {
  if (!hash(expectedDigest)) fail('Preview the exact Library inventory before sharing.', 'STALE_REVIEW');
  const context = capture(cwd), target = privateLibraryOutput(context, destination), content = collectLibrary(context, { excludeGoalIds, kinds, excludeEntries });
  if (content.sourceDigest !== expectedDigest) fail('The Library changed. Preview it again before sharing.', 'STALE_REVIEW');
  const directory = stage();
  try {
    const payload = libraryPayload(context, content, directory);
    const published = archive({ operation: 'create', cwd: target.cwd, fingerprint: target.fingerprint, name: path.basename(destination), source: directory, files: payload.inventory });
    const { data, device, inode } = regular(destination, LIBRARY_BUNDLE_LIMITS.bytes, true);
    if (published.sha256 !== digest(data) || published.bytes !== data.length || published.device !== device || published.inode !== inode) fail('The prepared Library archive changed.', 'STALE_REVIEW');
    return { path: destination, ...payload.totals, sha256: digest(data), bytes: data.length,
      payloadBytes: payload.totals.bytes, sourceDigest: content.sourceDigest };
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

function validateLibraryManifest(manifest, extracted, directory, context) {
  object(manifest, ['format', 'version', 'createdAt', 'skills', 'agents', 'workflows', 'goals']);
  if (manifest.format !== 'bzzy-definitions' || manifest.version !== 2 || !['skills', 'agents', 'workflows', 'goals'].every(key => Array.isArray(manifest[key])) ||
      !['skills', 'agents', 'workflows', 'goals'].some(key => manifest[key].length) ||
      ['skills', 'agents', 'workflows', 'goals'].reduce((sum, key) => sum + manifest[key].length, 0) > LIBRARY_BUNDLE_LIMITS.definitions) fail('Unsupported Library bundle manifest.');
  const baseFiles = extracted.filter(file => file === 'manifest.json' || /^(?:skills|agents)\//.test(file));
  const entries = validateManifest({ format: manifest.format, version: 1, createdAt: manifest.createdAt, skills: manifest.skills, agents: manifest.agents },
    baseFiles, directory, context, { allowEmpty: true, maximum: LIBRARY_BUNDLE_LIMITS.definitions });
  if (entries.some(entry => entry.kind === 'agent' && Object.keys(entry.selection || {}).length)) fail('Portable Library specialists must inherit the recipient model.');
  const paths = new Set(baseFiles.map(file => file.toLowerCase())), names = new Set();
  let total = entries.reduce((sum, entry) => sum + entry.files.reduce((bytes, file) => bytes + file.bytes, 0), 0);
  for (const [kind, items] of [['workflow', manifest.workflows], ['goal', manifest.goals]]) for (const item of items) {
    object(item, ['name', 'description', 'scope', 'version', 'file', 'bytes', 'sha256']);
    const expectedFile = kind === 'workflow' ? `workflows/${item.scope}/${item.name}.json` : `goals/${item.name}.json`;
    if (!name(item.name) || !scope(item.scope) || kind === 'goal' && item.scope !== 'global' || !hash(item.version) || !hash(item.sha256) ||
        item.file !== expectedFile || !safePath(item.file) || !Number.isSafeInteger(item.bytes) || item.bytes < 1 || item.bytes > LIBRARY_BUNDLE_LIMITS.fileBytes ||
        paths.has(item.file.toLowerCase()) || names.has(`${kind}:${item.scope}:${item.name}`)) fail('Invalid or duplicate Library text entry.');
    paths.add(item.file.toLowerCase()); names.add(`${kind}:${item.scope}:${item.name}`);
    const data = regular(path.join(directory, item.file)); importPortable(data, { ...context, resourcePath: item.file }, { kind, ...item }, 'definition.json'); total += data.length;
    if (data.length !== item.bytes || digest(data) !== item.sha256) fail('A Library text entry failed its exact hash check.');
    let definition;
    try { definition = JSON.parse(data.toString('utf8')); } catch { fail('A Library text entry is not valid JSON.'); }
    const checked = kind === 'workflow' ? normalizeWorkflow(definition) : normalizeGoalTemplate(definition);
    if (digest(checked) !== item.version || digest(checked) !== digest(definition) || (kind === 'workflow'
      ? checked.name !== item.name || checked.description !== item.description
      : item.name !== goalName(checked) || item.description !== goalDescription(checked.objective))) fail('Library metadata does not match its complete reviewed text.');
    entries.push(contentEntry(kind, { ...item, files: [{ path: 'definition.json', bytes: item.bytes, sha256: item.sha256 }] }));
  }
  if (extracted.length !== paths.size || extracted.some(file => !paths.has(file.toLowerCase())) || paths.size > LIBRARY_BUNDLE_LIMITS.entries || total > payloadLimit) fail('The Library ZIP has missing, extra or excessive resources.');
  return entries;
}
function libraryDestination(entry, context, directory) {
  if (entry.kind === 'skill' || entry.kind === 'agent') return destination(entry, context);
  if (entry.kind === 'workflow') {
    const id = digest([entry.scope, entry.scope === 'project' ? context.cwd : null, entry.name]), existing = getRecord('core.workflow.definition', id);
    return { kind: entry.kind, name: entry.name, scope: entry.scope, id, conflict: Boolean(existing), revision: existing?.revision || 0, version: existing?.version || null };
  }
  const definition = JSON.parse(regular(path.join(directory, 'goals', entry.name + '.json')).toString('utf8'));
  return { kind: 'goal', name: entry.name, scope: 'global', id: digest(definition), conflict: hasSavedGoalObjective(definition.objective) };
}

export function previewLibraryImport(file, { cwd = process.cwd() } = {}) {
  const context = capture(cwd), source = path.resolve(cwd, file), data = regular(source, LIBRARY_BUNDLE_LIMITS.bytes), directory = stage();
  try {
    const archiveSha256 = digest(data), archivePath = path.join(directory, 'input.zip'), payload = path.join(directory, 'payload');
    fs.writeFileSync(archivePath, data, { mode: 0o600, flag: 'wx' }); privateDir(payload);
    const extracted = archive({ operation: 'extract', source: archivePath, target: payload }).files;
    let manifest; try { manifest = JSON.parse(regular(path.join(payload, 'manifest.json')).toString('utf8')); } catch { fail('The ZIP has no valid Library manifest.'); }
    const entries = validateLibraryManifest(manifest, extracted, payload, context), destinations = entries.map(entry => libraryDestination(entry, context, payload));
    const conflicts = destinations.filter(item => item.conflict).map(({ kind, name, scope }) => ({ kind, name, scope }));
    const totals = { skills: manifest.skills.length, agents: manifest.agents.length, workflows: manifest.workflows.length, goals: manifest.goals.length,
      files: entries.reduce((sum, entry) => sum + entry.files.length, 0), bytes: entries.reduce((sum, entry) => sum + entry.files.reduce((bytes, file) => bytes + file.bytes, 0), 0) };
    return storeReview({ kind: 'library-import', version: 2, archiveSha256, entries, conflicts, totals }, { context, directory, source, archiveSha256, manifest, extracted, payload, destinations });
  } catch (error) { fs.rmSync(directory, { recursive: true, force: true }); throw error; }
}

export function libraryImportEntryIndexes(value, count) {
  if (!Number.isSafeInteger(count) || count < 1 || count > LIBRARY_BUNDLE_LIMITS.definitions) fail('Invalid Library entry count.');
  if (value === undefined) return Array.from({ length: count }, (_, index) => index);
  if (!Array.isArray(value) || !value.length || value.length > count || new Set(value).size !== value.length ||
      [...value].some(index => !Number.isSafeInteger(index) || index < 0 || index >= count)) fail('Choose entries from this exact Library review.');
  return [...value].sort((a, b) => a - b);
}
export function importLibraryBundle(review, { cwd = process.cwd(), enable = false, entryIndexes, reportReceipt = false } = {}) {
  const saved = reviewed(review, 'library-import', cwd);
  const indexes = libraryImportEntryIndexes(entryIndexes, review.entries.length), entries = indexes.map(index => review.entries[index]);
  if (typeof enable !== 'boolean' || typeof reportReceipt !== 'boolean') fail('Choose whether to enable the reviewed imported skills and agents.');
  if (digest(regular(saved.source, LIBRARY_BUNDLE_LIMITS.bytes)) !== saved.archiveSha256) fail('The downloaded Library changed. Preview it again.', 'STALE_REVIEW');
  validateLibraryManifest(saved.manifest, saved.extracted, saved.payload, saved.context);
  const receiptId = digest([saved.archiveSha256, saved.context.cwd, saved.context.projectId,
    ...(indexes.length === review.entries.length ? [] : [indexes])]), created = [];
  let result, alreadyImported = false;
  try {
    result = transaction(db => {
      assertContext(saved.context, cwd);
      const previous = getRecord('core.library.import', receiptId);
      if (previous) {
        alreadyImported = true;
        if (previous.enable !== enable) fail('This Library archive was already imported with a different availability choice.', 'CONFLICT');
        return structuredClone(previous.result);
      }
      const destinations = entries.map(entry => libraryDestination(entry, saved.context, saved.payload));
      if (digest(destinations) !== digest(indexes.map(index => saved.destinations[index]))) fail('A destination Library entry changed. Preview the import again.', 'STALE_REVIEW');
      const imported = { skills: [], agents: [], workflows: [], goals: [], skipped: [], enabled: enable };
      for (const [index, entry] of entries.entries()) {
        if (entry.kind !== 'skill' || destinations[index].conflict) continue;
        const target = skillDirectory({ ...entry, projectId: saved.context.projectId }); libraryPathSafe(target);
        if (fs.existsSync(target)) {
          const checked = importSkill(target, { scope: entry.scope, projectId: saved.context.projectId, preview: true, expectedVersion: entry.version });
          if (checked.name !== entry.name || checked.description !== entry.description) fail('An existing immutable skill package does not match the reviewed Library import.');
        }
      }
      for (const [index, entry] of entries.entries()) {
        if (destinations[index].conflict) { imported.skipped.push({ kind: entry.kind, name: entry.name, scope: entry.scope }); continue; }
        if (entry.kind === 'skill') {
          const target = skillDirectory({ ...entry, projectId: saved.context.projectId }); libraryPathSafe(target);
          if (!fs.existsSync(target)) created.push(target);
          const record = importSkill(path.join(saved.payload, 'skills', entry.scope, entry.name), { scope: entry.scope, projectId: saved.context.projectId,
            expectedRevision: 0, expectedVersion: entry.version, provenance: { kind: 'library-relay' } });
          imported.skills.push(enable ? setSkillEnabled(record.id, true, record.revision, { scope: entry.scope, projectId: saved.context.projectId }) : record);
        } else if (entry.kind === 'agent') {
          const definition = JSON.parse(regular(path.join(saved.payload, 'agents', entry.scope, entry.name + '.json')).toString('utf8'));
          let record = saveSubagentDefinition(definition, { cwd: saved.context.cwd, scope: entry.scope, expectedRevision: 0 });
          if (!enable) record = setSubagentEnabled(record.name, false, { cwd: saved.context.cwd, scope: entry.scope, expectedRevision: record.revision });
          imported.agents.push({ name: record.name, scope: record.scope, version: record.version, revision: record.revision, enabled: record.enabled !== false });
        } else if (entry.kind === 'workflow') {
          const definition = JSON.parse(regular(path.join(saved.payload, 'workflows', entry.scope, entry.name + '.json')).toString('utf8'));
          const record = saveWorkflow(definition, { cwd: saved.context.cwd, scope: entry.scope, expectedRevision: 0 });
          imported.workflows.push({ name: record.name, scope: record.scope, version: record.version, revision: record.revision });
        } else {
          const definition = JSON.parse(regular(path.join(saved.payload, 'goals', entry.name + '.json')).toString('utf8'));
          const record = saveGoalTemplate(definition); imported.goals.push({ id: `template:${record.id}`, version: record.version });
        }
      }
      putRecord('core.library.import', receiptId, { archiveSha256: saved.archiveSha256, cwd: saved.context.cwd,
        projectId: saved.context.projectId, enable, entryIndexes: indexes, result: imported, importedAt: now() }, db);
      return imported;
    });
  } catch (error) { for (const directory of created.reverse()) fs.rmSync(directory, { recursive: true, force: true }); throw error; }
  discardDefinitionBundleReview(review); return reportReceipt ? { ...result, alreadyImported } : result;
}
