import fs from 'node:fs';
import path from 'node:path';
import { database, transaction, getRecord, putRecord, digest, now } from './database.js';
import { getProvider } from './providers.js';
import { assertShareText, sharedSecrets } from './share-bundle-policy.js';
import { assertPortableDefinitionText } from './definition-portability.js';
import { recordLibraryCreation } from './library-notifications.js';
import { normalizeCapabilities } from './workflow-routing-schema.js';

// Local-owner administration only. Models discover definitions but cannot edit
// the reusable instructions or make their own durable permission grants.
const kind = 'core.subagent.definition';
const versionKind = 'core.subagent.definition.version';
const fields = ['name', 'description', 'instructions', 'provider', 'model', 'effort', 'policy', 'limits', 'capabilities'];
const controls = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/u;
const fail = (message, code = 'INVALID_REQUEST') => { throw Object.assign(new Error(message), { code }); };
const clone = value => structuredClone(value);
const atomic = operation => database().isTransaction ? operation(database()) : transaction(operation);

function object(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.keys(value).some(key => !keys.includes(key))) fail(`Invalid ${label} fields.`);
}
function nameOf(value) {
  if (typeof value !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) || value.length > 64) fail('Use a lowercase hyphenated subagent name of at most 64 characters.');
  return value;
}
function text(value, maximum, label, singleLine = false) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > maximum || controls.test(value) || singleLine && /[\r\n\t]/.test(value)) fail(`Invalid ${label}.`);
  return value.trim();
}
function location({ cwd = process.cwd(), scope } = {}) {
  if (scope !== undefined && !['project', 'global'].includes(scope)) fail('Choose project or global subagent scope.');
  if (scope === 'global') return { scope: 'global', projectRoot: null };
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) fail('Subagents need an absolute project directory.');
  const projectRoot = fs.realpathSync(cwd);
  if (!fs.statSync(projectRoot).isDirectory()) fail('The subagent project directory is unavailable.');
  return { scope: 'project', projectRoot };
}
const idFor = (name, selected) => digest([selected.scope, selected.projectRoot, name]);
const active = record => record && !record.deletedAt;
const enabled = record => active(record) && record.enabled !== false;
const catalogRecord = record => ({ ...clone(record), enabled: record.enabled !== false });
const summary = record => {
  const { instructions, ...value } = record;
  return catalogRecord(value);
};

export function normalizeSubagentDefinition(input) {
  object(input, fields, 'subagent definition');
  const result = { name: nameOf(input.name), description: text(input.description, 1024, 'subagent description', true),
    instructions: text(input.instructions, 16000, 'subagent instructions') };
  if (input.capabilities !== undefined) result.capabilities = normalizeCapabilities(input.capabilities);
  if (input.provider !== undefined) {
    if (typeof input.provider !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(input.provider)) fail('Invalid subagent provider.');
    getProvider(input.provider); result.provider = input.provider;
  }
  if (input.model !== undefined) {
    if (typeof input.model !== 'string' || !input.model || input.model.length > 200 || /[\s\x00-\x1f\x7f-\x9f]/u.test(input.model)) fail('Invalid subagent model.');
    result.model = input.model;
  }
  if (input.effort !== undefined) {
    if (typeof input.effort !== 'string' || !/^(?:default|[a-z][a-z0-9_-]{0,23})$/.test(input.effort)) fail('Invalid subagent reasoning effort.');
    result.effort = input.effort;
  }
  if (input.policy !== undefined) {
    object(input.policy, ['mode', 'network', 'writablePaths'], 'subagent policy');
    const policy = {};
    if (input.policy.mode !== undefined) {
      if (!['read-only', 'workspace-write'].includes(input.policy.mode)) fail('Unsupported subagent permission mode.');
      policy.mode = input.policy.mode;
    }
    if (input.policy.network !== undefined) {
      if (!['inherit', 'disabled'].includes(input.policy.network)) fail('Unsupported subagent network policy.');
      policy.network = input.policy.network;
    }
    if (input.policy.writablePaths !== undefined) {
      const paths = input.policy.writablePaths;
      if (!Array.isArray(paths) || paths.length > 32 || paths.some(value => typeof value !== 'string' || !value ||
          value.length > 240 || /[\\\x00-\x1f\x7f-\x9f:]/u.test(value) || path.posix.isAbsolute(value) ||
          value.split('/').some(part => !part || part === '..' || part === '.' && value !== '.'))) fail('Subagent writable paths must be bounded relative project paths.');
      policy.writablePaths = [...new Set(paths)];
    }
    if (policy.mode === 'read-only') {
      if (policy.writablePaths?.length) fail('A read-only subagent cannot request writable paths.');
      policy.writablePaths = [];
    }
    result.policy = policy;
  }
  if (input.limits !== undefined) {
    object(input.limits, ['runtimeSeconds', 'tokenBudget'], 'subagent limits');
    const limits = {};
    for (const [key, maximum] of [['runtimeSeconds', 3600], ['tokenBudget', 200000]]) {
      const value = input.limits[key];
      if (value !== undefined) {
        if (!Number.isSafeInteger(value) || value < 1 || value > maximum) fail(`Subagent ${key} must be between 1 and ${maximum}.`);
        limits[key] = value;
      }
    }
    result.limits = limits;
  }
  const serialized = JSON.stringify(result);
  if (Buffer.byteLength(serialized) > 24 * 1024) fail('Subagent definition exceeds 24 KiB.');
  // Known credentials, recognizable key formats, literal credential assignments
  // and private account addresses do not belong in reusable definitions.
  assertShareText(serialized, sharedSecrets());
  try { assertPortableDefinitionText([result.description, result.instructions].join('\n')); }
  catch { fail('Reusable subagents cannot contain credentials, private account addresses or host paths. Use private host bindings at execution time.'); }
  return result;
}

export function listSubagentDefinitions(options = {}) {
  const { scope, query = '', offset = 0, limit = 50, enabledOnly = false } = options;
  if (typeof query !== 'string' || query.length > 200 || !Number.isSafeInteger(offset) || offset < 0 ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || typeof enabledOnly !== 'boolean') fail('Invalid subagent definition page.');
  const selected = location(options);
  const rows = database().prepare('SELECT data FROM records WHERE kind=?').all(kind).map(row => JSON.parse(row.data));
  const localNames = new Set(rows.filter(row => row.scope === 'project' && row.projectRoot === selected.projectRoot).map(row => row.name));
  const visible = rows.filter(row => active(row) && (!enabledOnly || enabled(row)) && (scope === 'global' ? row.scope === 'global'
    : scope === 'project' ? row.scope === 'project' && row.projectRoot === selected.projectRoot
      : row.scope === 'project' && row.projectRoot === selected.projectRoot || row.scope === 'global' && !localNames.has(row.name)))
    .filter(row => `${row.name} ${row.description} ${(row.capabilities?.tags || []).join(' ')}`.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name));
  const page = visible.slice(offset, offset + limit);
  return { subagents: page.map(summary), total: visible.length, nextOffset: offset + page.length < visible.length ? offset + page.length : null };
}

export function getSubagentDefinition(name, options = {}) {
  nameOf(name); const selected = location(options);
  const project = selected.scope === 'project' ? getRecord(kind, idFor(name, selected)) : null;
  // A deleted local override deliberately shadows the global definition. A
  // missing/removed specialist must never silently execute different behavior.
  if (project) {
    if (!active(project)) fail('Subagent definition was removed from this project.', 'NOT_FOUND');
    if (options.enabledOnly && !enabled(project)) fail('This subagent is disabled. Enable it in Agents before using it.', 'SUBAGENT_DISABLED');
    return catalogRecord(project);
  }
  if (options.scope === 'project') fail('Subagent definition not found in this project.', 'NOT_FOUND');
  const global = getRecord(kind, idFor(name, { scope: 'global', projectRoot: null }));
  if (!active(global)) fail('Subagent definition not found in this project.', 'NOT_FOUND');
  if (options.enabledOnly && !enabled(global)) fail('This subagent is disabled. Enable it in Agents before using it.', 'SUBAGENT_DISABLED');
  return catalogRecord(global);
}

export function saveSubagentDefinition(input, options = {}) {
  const { expectedRevision = 0 } = options;
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) fail('Supply the current subagent revision.');
  const definition = normalizeSubagentDefinition(input), selected = location({ ...options, scope: options.scope || 'project' });
  const id = idFor(definition.name, selected), version = digest(definition);
  return atomic(db => {
    const previous = getRecord(kind, id);
    if ((previous?.revision || 0) !== expectedRevision) fail('Subagent definition already exists or changed. Reload its revision before replacing it.', 'CONFLICT');
    if (!previous) {
      if (database().prepare('SELECT count(*) AS total FROM records WHERE kind=?').get(kind).total >= 512) fail('The host subagent definition limit was reached.', 'CAPACITY');
    }
    if (!active(previous)) {
      const count = database().prepare("SELECT count(*) AS total FROM records WHERE kind=? AND json_extract(data,'$.scope')=? AND json_extract(data,'$.projectRoot') IS ? AND json_extract(data,'$.deletedAt') IS NULL").get(kind, selected.scope, selected.projectRoot).total;
      if (count >= 128) fail('The subagent scope definition limit was reached.', 'CAPACITY');
    }
    const timestamp = now(), record = { ...definition, id, ...selected, version, enabled: active(previous) ? previous.enabled !== false : true, revision: expectedRevision + 1,
      createdAt: previous?.createdAt || timestamp, updatedAt: timestamp };
    const versionId = digest([id, version]);
    if (!getRecord(versionKind, versionId)) {
      if (database().prepare('SELECT count(*) AS total FROM records WHERE kind=?').get(versionKind).total >= 4096) fail('The host subagent definition version limit was reached.', 'CAPACITY');
      putRecord(versionKind, versionId, record, db);
    }
    putRecord(kind, id, record, db);
    if (!active(previous)) recordLibraryCreation('specialist', id, { sourceSessionId: options.session?.id }, db);
    return clone(record);
  });
}

// Availability is host catalog metadata, separate from immutable instructions.
// Turning it off never rewrites an existing worker pin or cancels running work.
export function setSubagentEnabled(name, value, options = {}) {
  nameOf(name); const { expectedRevision } = options;
  if (typeof value !== 'boolean' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) fail('Supply an on/off value and the current subagent revision.');
  const selected = location({ ...options, scope: options.scope || 'project' }), id = idFor(name, selected);
  return atomic(db => {
    const previous = getRecord(kind, id);
    if (!active(previous) || previous.revision !== expectedRevision) fail('Subagent definition changed or was removed. Reload before toggling it.', 'CONFLICT');
    if ((previous.enabled !== false) === value) return catalogRecord(previous);
    const record = { ...previous, enabled: value, revision: previous.revision + 1, updatedAt: now() };
    putRecord(kind, id, record, db); return catalogRecord(record);
  });
}

// New admission and follow-up paths check the current host catalog by pinned
// identity, rather than trusting a copied enabled flag or resolving newer text.
export function assertSubagentDefinitionEnabled(definition) {
  const record = typeof definition?.id === 'string' && getRecord(kind, definition.id);
  if (!active(record)) fail('This subagent was removed. No new worker execution was started.', 'SUBAGENT_DISABLED');
  if (!enabled(record)) fail('This subagent is disabled. Enable it in Agents before starting or following up work.', 'SUBAGENT_DISABLED');
  if (record.name !== definition.name || record.scope !== definition.scope || record.projectRoot !== definition.projectRoot) fail('The subagent catalog identity changed.', 'CONFLICT');
  return catalogRecord(record);
}

export function deleteSubagentDefinition(name, options = {}) {
  nameOf(name); const { expectedRevision } = options;
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) fail('Supply the current subagent revision before deletion.');
  const selected = location({ ...options, scope: options.scope || 'project' }), id = idFor(name, selected);
  return atomic(db => {
    const previous = getRecord(kind, id);
    if (!active(previous) || previous.revision !== expectedRevision) fail('Subagent definition changed or was removed. Reload before deleting it.', 'CONFLICT');
    const record = { ...previous, revision: previous.revision + 1, deletedAt: now(), updatedAt: now() };
    putRecord(kind, id, record, db); return summary(record);
  });
}

// Trusted runtime lookup for an invocation's immutable pin. This intentionally
// does not resolve a name to the latest definition or reactivate deleted ones.
export function getSubagentDefinitionVersion(id, version) {
  if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id) || typeof version !== 'string' || !/^[a-f0-9]{64}$/.test(version)) fail('Invalid pinned subagent definition.');
  const record = getRecord(versionKind, digest([id, version]));
  if (!record || record.id !== id || record.version !== version) fail('Pinned subagent definition is unavailable.', 'NOT_FOUND');
  if (digest(Object.fromEntries(fields.filter(key => Object.hasOwn(record, key)).map(key => [key, record[key]]))) !== version) fail('Pinned subagent definition integrity check failed.', 'CONFLICT');
  return clone(record);
}

export function assertSubagentDefinitionPin(definition) {
  object(definition, [...fields, 'id', 'scope', 'projectRoot', 'version', 'revision', 'createdAt', 'updatedAt', 'enabled'], 'pinned subagent definition');
  if (definition.enabled !== undefined && typeof definition.enabled !== 'boolean') fail('Invalid pinned subagent availability.');
  const pinned = getSubagentDefinitionVersion(definition.id, definition.version);
  const payload = Object.fromEntries(fields.filter(key => Object.hasOwn(definition, key)).map(key => [key, definition[key]]));
  // Content versions deliberately exclude mutable catalog metadata. A no-op
  // edit, or a reviewed revert, can reuse a version with a later revision/time.
  if (definition.scope !== pinned.scope || definition.projectRoot !== pinned.projectRoot || digest(payload) !== pinned.version ||
      !Number.isSafeInteger(definition.revision) || definition.revision < 1) fail('Pinned subagent definition integrity check failed.', 'CONFLICT');
  return clone(definition);
}
