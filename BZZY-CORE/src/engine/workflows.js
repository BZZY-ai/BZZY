import fs from 'node:fs';
import path from 'node:path';
import { database, getRecord, putRecord, digest, now, transaction, appendEvent } from './database.js';
import { loadSession, sessionDeleted } from './store.js';
import { assertShareText, sharedSecrets } from './share-bundle-policy.js';
import { privateWorkspacePath } from './private-paths.js';
import { getProvider, providerModelCapabilities } from './providers.js';
import { sanitizeMissionValue } from './mission-context.js';
import { normalizeRouting } from './workflow-routing-schema.js';

const DEFINITION = 'core.workflow.definition', VERSION = 'core.workflow.version';
const SELECTION = 'core.workflow.selection', BINDING = 'core.workflow.goal-binding';
export const WORKFLOW_TEXT_BYTES = 128 * 1024;
const security = fs.readFileSync(new URL('../../assets/generation-security.txt', import.meta.url), 'utf8').trim();
const atomic = operation => database().isTransaction ? operation(database()) : transaction(operation);
const fail = (message, code = 'INVALID_WORKFLOW', status = 400) => { throw Object.assign(new Error(message), { code, status }); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const active = value => Boolean(value && !value.deletedAt);
const payload = value => ({ name: value.name, description: value.description, instructions: value.instructions,
  ...(value.schemaVersion === 2 ? { schemaVersion: 2, routing: value.routing } : {}) });
const intactDefinition = value => active(value) && hash(value.version) && digest(payload(value)) === value.version;
const summary = value => { const { instructions, ...metadata } = value; return structuredClone(metadata); };
const bounded = (value, maximum, empty = false) => typeof value === 'string' && (empty || value.trim()) &&
  Buffer.byteLength(value) <= maximum && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/u.test(value);
function nameOf(name) {
  if (typeof name !== 'string' || name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) fail('Use a lowercase hyphenated workflow name of at most 64 characters.');
  return name;
}
function location({ cwd = process.cwd(), scope } = {}) {
  if (scope !== undefined && !['global', 'project'].includes(scope)) fail('Choose project or global workflow scope.');
  if (scope === 'global') return { scope, projectRoot: null };
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) fail('Workflows need an absolute project directory.');
  let projectRoot;
  try { projectRoot = fs.realpathSync(cwd); if (!fs.statSync(projectRoot).isDirectory()) throw new Error(); }
  catch { fail('The workflow project directory is unavailable.', 'WORKFLOW_SCOPE_UNAVAILABLE', 409); }
  return { scope: 'project', projectRoot };
}
const idFor = (name, selected) => digest([selected.scope, selected.projectRoot, name]);
function safeInstructions(value) {
  try { assertShareText(value, sharedSecrets()); }
  catch { fail('Workflows cannot contain credentials or private account bindings. Use authorized private host references.'); }
  if (/(?:["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|cookie|authorization)["']?)\s*[=:]\s*["']?(?!<|\$\{|\[redacted\])[^\s"']+/i.test(value) ||
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(value)) fail('Workflows cannot embed credentials or private account addresses. Use private host references.');
  if (sanitizeMissionValue(value) !== value) fail('Workflow text contains credential-like material that cannot reach agent briefs unchanged. Use an approved private host reference; no instructions were removed or saved.');
}
export function normalizeWorkflow(input) {
  if (!plain(input) || Object.keys(input).some(key => !['name', 'description', 'instructions', 'schemaVersion', 'routing'].includes(key)) ||
      input.schemaVersion !== undefined && input.schemaVersion !== 2 || (input.schemaVersion === 2) !== (input.routing !== undefined)) fail('A workflow contains name, description, instructions and optional schemaVersion 2 routing; permissions and executable configuration are not workflow fields.');
  const name = nameOf(input.name), description = input.description ?? '';
  if (!bounded(description, 1024, true) || /[\r\n]/.test(description)) fail('Workflow descriptions must be one line, at most 1024 UTF-8 bytes.');
  if (!bounded(input.instructions, WORKFLOW_TEXT_BYTES)) fail('Workflow instructions must be nonempty UTF-8 text, at most 128 KiB. Nothing was truncated.');
  let instructions = input.instructions.trim();
  if (!instructions.includes(security)) instructions += '\n\n' + security;
  if (Buffer.byteLength(instructions) > WORKFLOW_TEXT_BYTES) fail('Workflow text including its required security policy exceeds 128 KiB. Nothing was truncated.');
  safeInstructions(description + '\n' + instructions);
  const result = { name, description: description.trim(), instructions,
    ...(input.schemaVersion === 2 ? { schemaVersion: 2, routing: normalizeRouting(input.routing) } : {}) };
  if (result.routing) safeInstructions(JSON.stringify(result.routing)); return result;
}
export function saveWorkflow(input, options = {}) {
  const { expectedRevision = 0 } = options;
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) fail('Use the current workflow revision.');
  const definition = normalizeWorkflow(input), selected = location({ ...options, scope: options.scope || 'project' });
  const id = idFor(definition.name, selected), version = digest(definition);
  return atomic(db => {
    const previous = getRecord(DEFINITION, id);
    if ((previous?.revision || 0) !== expectedRevision) fail('Workflow already exists or changed. Reload its revision before saving.', 'CONFLICT', 409);
    if (!previous && database().prepare('SELECT count(*) AS n FROM records WHERE kind=?').get(DEFINITION).n >= 512) fail('The workflow definition limit was reached.', 'CAPACITY', 409);
    const timestamp = now(), record = { ...definition, id, ...selected, version, revision: expectedRevision + 1,
      createdAt: previous?.createdAt || timestamp, updatedAt: timestamp };
    const versionId = digest([id, version]);
    if (!getRecord(VERSION, versionId)) {
      if (database().prepare('SELECT count(*) AS n FROM records WHERE kind=?').get(VERSION).n >= 4096) fail('The workflow version limit was reached.', 'CAPACITY', 409);
      putRecord(VERSION, versionId, record, db);
    }
    putRecord(DEFINITION, id, record, db); return structuredClone(record);
  });
}
export function listWorkflows(options = {}) {
  const { scope, query = '', offset = 0, limit = 50 } = options;
  if (typeof query !== 'string' || query.length > 200 || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('Invalid workflow page.');
  const selected = location(options), rows = database().prepare("SELECT json_remove(data, '$.instructions') AS data FROM records WHERE kind=?").all(DEFINITION).map(row => JSON.parse(row.data));
  const localNames = new Set(rows.filter(row => row.scope === 'project' && row.projectRoot === selected.projectRoot).map(row => row.name));
  const visible = rows.filter(row => active(row) && (scope === 'global' ? row.scope === 'global' : scope === 'project'
    ? row.scope === 'project' && row.projectRoot === selected.projectRoot
    : row.scope === 'project' && row.projectRoot === selected.projectRoot || row.scope === 'global' && !localNames.has(row.name)))
    .filter(row => `${row.name} ${row.description}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => a.name.localeCompare(b.name));
  return { workflows: visible.slice(offset, offset + limit).map(summary), total: visible.length,
    nextOffset: offset + limit < visible.length ? offset + limit : null };
}
export function getWorkflow(name, options = {}) {
  nameOf(name); const selected = location(options);
  const local = selected.scope === 'project' && getRecord(DEFINITION, idFor(name, selected));
  if (local) {
    if (!active(local)) fail('This project workflow was deleted.', 'NOT_FOUND', 404);
    if (!intactDefinition(local)) fail('The workflow definition changed unexpectedly.', 'WORKFLOW_PIN_INVALID', 409);
    return structuredClone(local);
  }
  if (options.scope === 'project') fail('Workflow not found in this project.', 'NOT_FOUND', 404);
  const global = getRecord(DEFINITION, idFor(name, { scope: 'global', projectRoot: null }));
  if (!active(global)) fail('Workflow not found.', 'NOT_FOUND', 404);
  if (!intactDefinition(global)) fail('The workflow definition changed unexpectedly.', 'WORKFLOW_PIN_INVALID', 409);
  return structuredClone(global);
}
export function deleteWorkflow(name, options = {}) {
  nameOf(name); const { expectedRevision } = options;
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) fail('Use the workflow revision shown before deleting it.');
  const selected = location({ ...options, scope: options.scope || 'project' }), id = idFor(name, selected);
  return atomic(db => {
    const current = getRecord(DEFINITION, id);
    if (!active(current) || current.revision !== expectedRevision) fail('Workflow changed or was deleted. Reload before deleting.', 'CONFLICT', 409);
    const record = { ...current, revision: current.revision + 1, deletedAt: now(), updatedAt: now() };
    putRecord(DEFINITION, id, record, db); return summary(record);
  });
}
export function readWorkflowTextFile(filename, { cwd = process.cwd() } = {}) {
  if (typeof filename !== 'string' || !filename || filename.startsWith('-')) fail('Choose a workflow text file.');
  const file = path.resolve(cwd, filename);
  if (privateWorkspacePath(file)) fail('Workflow imports cannot read private authentication or Core stores.');
  let descriptor;
  try {
    const canonical = fs.realpathSync(file);
    if (privateWorkspacePath(canonical)) fail('Workflow imports cannot read private authentication or Core stores.');
    const expected = fs.lstatSync(canonical);
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== expected.dev || stat.ino !== expected.ino || stat.size > WORKFLOW_TEXT_BYTES) fail('Import a regular workflow text file without links, at most 128 KiB.');
    const bytes = Buffer.alloc(WORKFLOW_TEXT_BYTES + 1); let length = 0, count;
    do { count = fs.readSync(descriptor, bytes, length, bytes.length - length); length += count; } while (count > 0 && length < bytes.length);
    if (length > WORKFLOW_TEXT_BYTES) fail('Workflow text exceeds 128 KiB. Nothing was truncated.');
    const current = fs.fstatSync(descriptor);
    if (current.size !== stat.size || current.mtimeMs !== stat.mtimeMs || current.ctimeMs !== stat.ctimeMs || length !== current.size) fail('Workflow source changed while reading. Reload the text file.');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
  } catch (error) { if (error.code === 'INVALID_WORKFLOW') throw error; fail('Cannot read the selected regular UTF-8 workflow file.'); }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}
export function importWorkflow(filename, options = {}) {
  const source = readWorkflowTextFile(filename, options);
  if (path.extname(filename).toLowerCase() === '.json') {
    let definition; try { definition = JSON.parse(source); } catch { fail('The workflow JSON document is invalid.'); }
    if (options.name && options.name !== definition?.name) fail('The requested workflow name differs from its JSON definition.');
    return saveWorkflow(definition, options);
  }
  return saveWorkflow({ name: options.name, description: options.description || '', instructions: source }, options);
}
function terminal(value) {
  const id = typeof value === 'string' ? value : value?.id;
  const session = uuid(id) && !sessionDeleted(id) && loadSession(id);
  if (!session || session.parentSessionId || session.assignmentId || session.role || session.purpose && session.purpose !== 'terminal') fail('Workflows can be selected only for an existing terminal conversation.', 'WORKFLOW_SESSION_UNAVAILABLE', 403);
  location({ cwd: session.cwd }); return session;
}
export function workflowSelection(value) {
  const session = terminal(value), record = getRecord(SELECTION, session.id);
  if (!record?.selected) return { sessionId: session.id, revision: record?.revision || 0, selected: null, available: true };
  const current = getRecord(DEFINITION, record.selected.id), projectRoot = location({ cwd: session.cwd }).projectRoot;
  const available = intactDefinition(current) && current.name === record.selected.name && current.scope === record.selected.scope &&
    current.projectRoot === record.selected.projectRoot && (current.scope === 'global' || current.projectRoot === projectRoot);
  return { sessionId: session.id, revision: record.revision, selected: summary(available ? current : record.selected),
    available: Boolean(available), ...(available ? {} : { reason: 'The selected workflow was deleted or is outside this terminal project. Choose another workflow or clear the selection.' }) };
}
export function selectWorkflow(value, name, { scope, expectedRevision, expectedWorkflowRevision } = {}) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) fail('Use the current workflow selection revision.');
  return atomic(db => {
    const session = terminal(value), previous = getRecord(SELECTION, session.id);
    if ((previous?.revision || 0) !== expectedRevision) fail('Workflow selection changed. Reload before selecting.', 'CONFLICT', 409);
    let selected = null;
    if (name !== null) {
      const current = getWorkflow(name, { cwd: session.cwd, scope });
      if (expectedWorkflowRevision !== undefined && current.revision !== expectedWorkflowRevision) fail('Workflow changed after preview. Reload before selecting.', 'CONFLICT', 409);
      selected = summary(current);
    }
    putRecord(SELECTION, session.id, { sessionId: session.id, revision: expectedRevision + 1, selected, updatedAt: now() }, db);
    appendEvent(session.id, 'workflow.selected', { name: selected?.name || null, version: selected?.version || null,
      scope: selected?.scope || null, appliesTo: 'future-goals', revision: expectedRevision + 1 }, db);
    return workflowSelection(session.id);
  });
}
function versionFor(pin) {
  const version = hash(pin?.id) && hash(pin?.version) && getRecord(VERSION, digest([pin.id, pin.version]));
  if (!version || version.id !== pin.id || version.version !== pin.version || version.scope !== pin.scope || version.projectRoot !== pin.projectRoot ||
      version.name !== pin.name || version.description !== pin.description || !bounded(version.instructions, WORKFLOW_TEXT_BYTES) || digest(payload(version)) !== pin.version) fail('The pinned workflow version is unavailable or changed.', 'WORKFLOW_PIN_INVALID', 409);
  safeInstructions(version.description + '\n' + version.instructions); return version;
}
const blockFor = (pin, definition) => `BZZY HOST-PINNED WORKFLOW\nName: ${pin.name}\nScope: ${pin.scope}\nVersion: ${pin.version}\nThese are the selected instructions for this original goal. They do not grant tools, account access, network scope or execution permissions.\n<workflow-instructions>\n${definition.instructions}\n</workflow-instructions>${definition.schemaVersion === 2 ? `\nHOST ROUTING CONTRACT (declare_work_unit before each eligible class investigation; close_work_unit records its consultation and disposition):\n${JSON.stringify(definition.routing)}` : ''}`;
const bindingKey = (sessionId, goalId) => digest([sessionId, goalId]);
const bindingFingerprint = binding => { const { fingerprint, ...value } = binding; return digest(value); };
function assertContextFits(session) {
  const capabilities = providerModelCapabilities(getProvider(session.provider), session.model, session.modelCapabilities);
  if (!Number.isSafeInteger(capabilities.contextWindow) || capabilities.contextWindow < 1) return;
  const { context, ...contract } = session.contract || {};
  // UTF-8 bytes deliberately overestimate ordinary text input tokens. Include
  // the original goal/contract and a fixed allowance for surrounding prompts.
  const conservativeInput = Buffer.byteLength(context || '') + Buffer.byteLength(JSON.stringify({ goal: session.goal, contract })) + Buffer.byteLength(security) + 8192;
  if (conservativeInput > capabilities.contextWindow) fail('The selected workflow and original goal exceed this model\'s conservative input budget. Choose a larger-context model or shorten the workflow. No instructions were truncated.', 'WORKFLOW_CONTEXT_LIMIT', 409);
}
function checkedBinding(session, binding, { context = true } = {}) {
  if (!binding || binding.version !== 1 || binding.sessionId !== session.id || binding.goalId !== session.goal?.id ||
      binding.id !== bindingKey(session.id, session.goal.id) || bindingFingerprint(binding) !== binding.fingerprint) fail('The goal workflow admission receipt is unavailable or changed.', 'WORKFLOW_PIN_INVALID', 409);
  if (binding.workflow) {
    const version = versionFor(binding.workflow), block = blockFor(binding.workflow, version);
    if (digest(block) !== binding.blockSha256 || context && (typeof session.contract?.context !== 'string' || !session.contract.context.includes(block) ||
        digest(session.contract.context) !== binding.contextSha256)) fail('The goal no longer contains its complete pinned workflow and original context. Start a new goal or restore its original instructions.', 'WORKFLOW_PIN_INVALID', 409);
    if (context) assertContextFits(session);
  }
  return binding;
}
const admissionFor = binding => ({ version: 1, bindingId: binding.id, goalId: binding.goalId,
  workflowVersion: binding.workflow?.version || null, fingerprint: binding.fingerprint });

// Explicit stopped scope transitions preserve the predecessor's exact workflow,
// rather than resolving today's Library selection or duplicating its context.
export function forkGoalWorkflowBinding(previous, next) {
  const prior = getRecord(BINDING, bindingKey(previous.id, previous.goal?.id));
  if (!prior) return null;
  const checked = checkedBinding(previous, prior);
  if (next.id !== previous.id || !uuid(next.goal?.id) || next.goal.id === previous.goal.id || next.contract?.context !== previous.contract?.context) fail('A scope successor must preserve its original workflow context.', 'WORKFLOW_PIN_INVALID', 409);
  const id = bindingKey(next.id, next.goal.id);
  if (getRecord(BINDING, id)) fail('Successor workflow binding already exists.', 'CONFLICT', 409);
  const { fingerprint, ...body } = checked;
  const value = { ...body, id, goalId: next.goal.id, predecessorBindingId: checked.id, admittedAt: now() };
  const binding = { ...value, fingerprint: digest(value) };
  putRecord(BINDING, id, binding);
  appendEvent(next.id, 'workflow.admitted', { goalId: next.goal.id, workflow: binding.workflow, legacy: binding.legacy, predecessorBindingId: checked.id });
  return admissionFor(binding);
}

// One deterministic host gate, after the goal is prepared but before any model
// execution is queued. Selection is never resolved again for an existing pin.
export function preflightGoalWorkflow(session, { resumeGoal = false } = {}) {
  if (!uuid(session?.goal?.id)) fail('A saved goal is required before workflow admission.');
  if (session.parentSessionId || session.assignmentId || session.role || session.purpose && session.purpose !== 'terminal') return null;
  return atomic(db => {
    const id = bindingKey(session.id, session.goal.id), previous = getRecord(BINDING, id);
    if (previous) return admissionFor(checkedBinding(session, previous));
    // A legacy/resumed goal retains its recorded instructions. Loading a
    // workflow later cannot silently replace that older goal's mission.
    const legacy = resumeGoal || session.goal.importedHistorical || session.goal.status === 'complete' || (session.goal.turns || 0) > 0 || (session.goal.evidence || []).length > 0;
    const selected = legacy ? null : workflowSelection(session.id);
    if (selected && !selected.available) fail(selected.reason, 'WORKFLOW_UNAVAILABLE', 409);
    let workflow = null, blockSha256 = null;
    if (selected?.selected) {
      workflow = summary(getWorkflow(selected.selected.name, { cwd: session.cwd, scope: selected.selected.scope }));
      const definition = versionFor(workflow), block = blockFor(workflow, definition);
      session.contract.context = [session.contract.context, block].filter(Boolean).join('\n\n'); blockSha256 = digest(block);
      assertContextFits(session);
    }
    const value = { version: 1, id, sessionId: session.id, goalId: session.goal.id, workflow,
      blockSha256, contextSha256: workflow ? digest(session.contract.context) : null, legacy: Boolean(legacy), admittedAt: now() };
    const binding = { ...value, fingerprint: digest(value) };
    putRecord(BINDING, id, binding, db); putRecord('session', session.id, session, db);
    appendEvent(session.id, 'workflow.admitted', { goalId: session.goal.id, workflow, legacy: binding.legacy }, db);
    if (workflow) appendEvent(session.id, 'info', { message: `Workflow loaded: ${workflow.name} · ${workflow.version.slice(0, 8)}` }, db);
    return admissionFor(binding);
  });
}
export function assertGoalWorkflowAdmission(session, admission) {
  if (!admission) {
    if (session.goal?.id && getRecord(BINDING, bindingKey(session.id, session.goal.id))?.workflow) fail('This execution has no receipt for the pinned goal workflow.', 'WORKFLOW_PIN_INVALID', 409);
    return;
  }
  if (!plain(admission) || Object.keys(admission).some(key => !['version', 'bindingId', 'goalId', 'workflowVersion', 'fingerprint'].includes(key)) ||
      admission.version !== 1 || !hash(admission.bindingId) || !uuid(admission.goalId) || !hash(admission.fingerprint) || admission.workflowVersion !== null && !hash(admission.workflowVersion)) fail('Invalid workflow execution admission.', 'WORKFLOW_PIN_INVALID', 409);
  const binding = checkedBinding(session, getRecord(BINDING, admission.bindingId));
  if (digest(admissionFor(binding)) !== digest(admission)) fail('This execution belongs to another goal workflow admission.', 'WORKFLOW_PIN_INVALID', 409);
}
export function getGoalWorkflow(sessionId, goalId) {
  const session = terminal(sessionId); goalId ||= session.goal?.id;
  if (!uuid(goalId)) return { goalId: null, workflow: null, admittedAt: null, state: 'none' };
  const binding = getRecord(BINDING, bindingKey(session.id, goalId));
  if (!binding) return { goalId, workflow: null, admittedAt: null, state: 'legacy' };
  try {
    const current = session.goal?.id === goalId ? session : { ...session, goal: { id: goalId } };
    checkedBinding(current, binding, { context: session.goal?.id === goalId });
    return { goalId, workflow: binding.workflow ? summary(binding.workflow) : null, admittedAt: binding.admittedAt,
      state: binding.workflow ? 'pinned' : binding.legacy ? 'legacy' : 'none' };
  } catch { return { goalId, workflow: null, admittedAt: binding.admittedAt, state: 'unavailable' }; }
}

// Trusted current-goal lookup. Never reinterpret a legacy workflow's prose.
export function goalRoutingContract(session) {
  if (!session?.goal?.id || session.parentSessionId || session.assignmentId || session.role || session.purpose && session.purpose !== 'terminal') return null;
  const binding = getRecord(BINDING, bindingKey(session.id, session.goal.id));
  if (!binding?.workflow) return null;
  checkedBinding(session, binding);
  const definition = versionFor(binding.workflow);
  return definition.schemaVersion === 2 ? { workflowId: definition.id, workflowVersion: definition.version,
    bindingId: binding.id, routing: normalizeRouting(definition.routing) } : null;
}
