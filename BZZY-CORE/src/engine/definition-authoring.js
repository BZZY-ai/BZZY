import fs from 'node:fs';
import { digest, database, transaction } from './database.js';
import { home } from './files.js';
import { loadSession, sessionDeleted } from './store.js';
import { selectionFromSession } from './providers.js';
import { projectIdentityForSession } from './project-identity.js';
import { normalizeSubagentDefinition, saveSubagentDefinition, getSubagentDefinition } from './subagent-definitions.js';
import { createSkill, skillMetadata, setSkillEnabled, listSkills, inspectSkill, readSkill } from './skills.js';
import { listSubagentDefinitions } from './subagent-definitions.js';
import { assertPortableDefinitionText } from './definition-portability.js';
import { runRestrictedDocumentModel } from './document-model.js';

const fail = message => { throw Object.assign(new Error(message), { code: 'DEFINITION_AUTHORING' }); };
const validKind = kind => { if (!['skill', 'subagent'].includes(kind)) fail('Choose a skill or specialist creator.'); };
const atomic = operation => database().isTransaction ? operation() : transaction(operation);
const guides = Object.fromEntries(['skill', 'agent'].map(kind => [kind,
  fs.readFileSync(new URL(`../../assets/bzzy-${kind}-creator.md`, import.meta.url), 'utf8')]));

export function captureDefinitionContext(source) {
  const session = loadSession(typeof source === 'string' ? source : source?.id);
  if (!session || sessionDeleted(session.id) || session.role === 'learning-review') fail('Open a saved chat before creating a skill or agent.');
  const project = projectIdentityForSession(session, { create: false });
  const stat = fs.statSync(session.cwd);
  return { sessionId: session.id, hostHome: home(), directory: { device: stat.dev, inode: stat.ino }, cwd: session.cwd, projectRoot: project.root, projectId: project.id,
    agentNamespace: session.agentNamespace || null, selection: selectionFromSession(session) };
}

export function assertDefinitionContext(context, sourceId = context?.sessionId) {
  let fresh;
  try { fresh = captureDefinitionContext(sourceId); } catch { /* Fail with a static error below. */ }
  if (!context || !fresh || context.sessionId !== sourceId || digest(fresh) !== digest(context)) {
    fail('The conversation, project or selected model changed. Reopen the creator to use its current model.');
  }
  return loadSession(sourceId);
}

// Apply the same portable-definition restrictions to inputs before any provider
// call and outputs before they reach a preview, a log, or a saved artifact.
function requestDefinition(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['name', 'purpose', 'details'].includes(key))) fail('Invalid creator input.');
  const checked = normalizeSubagentDefinition({ name: input.name, description: input.purpose, instructions: input.details || 'No additional preferences supplied.' });
  return { name: checked.name, purpose: checked.description, details: checked.instructions };
}

export function validateAuthoredDefinition(text, { kind, name }) {
  validKind(kind);
  if (typeof text !== 'string' || Buffer.byteLength(text) > 32768) fail('The model returned an oversized definition.');
  const cleaned = text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, '$1');
  let value;
  try { value = JSON.parse(cleaned); } catch { fail('The model did not return a valid definition. Try the creator again.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 3 ||
      Object.keys(value).some(key => !['name', 'description', 'instructions'].includes(key))) fail('The model returned unsupported definition fields.');
  const definition = normalizeSubagentDefinition(value);
  if (definition.name !== name) fail('The model changed the requested name. Try the creator again.');
  if (Buffer.byteLength(definition.instructions) < 100) fail('The generated instructions are too short to be useful.');
  if (kind === 'skill') skillMetadata(`---\nname: ${definition.name}\ndescription: ${JSON.stringify(definition.description)}\n---\n\n${definition.instructions}\n`);
  return definition;
}

export async function authorDefinition({ kind, context, input, scope = 'project', signal, Engine, runModel = runRestrictedDocumentModel }) {
  validKind(kind);
  if (!['project', 'global'].includes(scope)) fail('Choose project or global scope.');
  const source = assertDefinitionContext(context), request = requestDefinition(input);
  for (const value of [request.purpose, request.details]) assertPortableDefinitionText(value, context);
  const existing = kind === 'skill'
    ? listSkills({ scope, projectRoot: context.projectRoot, query: request.name, limit: 100 }).skills
    : listSubagentDefinitions({ scope, cwd: context.cwd, query: request.name, limit: 100 }).subagents;
  if (existing.some(entry => entry.name === request.name)) fail('That name already exists in this scope. Choose another name; existing entries are never replaced.');
  if (signal?.aborted) throw signal.reason || new Error('Creation cancelled.');
  const instructions = `Return only a JSON object following this BZZY host contract.\n\n${guides[kind === 'skill' ? 'skill' : 'agent']}`;
  const result = await runModel({ source, selection: context.selection, instructions,
    prompt: JSON.stringify({ kind, scope, requirements: request }), signal, budget: { tokenBudget: 12000, runtimeSeconds: 90 }, Engine });
  if (signal?.aborted) throw signal.reason || new Error('Creation cancelled.');
  assertDefinitionContext(context);
  const definition = validateAuthoredDefinition(result.text, { kind, name: request.name });
  for (const value of [definition.description, definition.instructions]) assertPortableDefinitionText(value, context);
  return { kind, context: structuredClone(context), scope, definition };
}

// Menu Save or an explicit native creation command publishes the definition.
// Generation alone stays in memory; CAS creation never replaces an existing item.
export function saveAuthoredDefinition(draft, { sourceId = draft?.context?.sessionId, activate = false, signal } = {}) {
  if (!draft) fail('Generate a definition before saving it.');
  validKind(draft.kind);
  if (typeof activate !== 'boolean') fail('Choose a valid creator activation setting.');
  if (signal?.aborted) throw signal.reason || new Error('Creation cancelled.');
  assertDefinitionContext(draft.context, sourceId);
  if (!['project', 'global'].includes(draft.scope)) fail('Choose project or global scope.');
  const definition = validateAuthoredDefinition(JSON.stringify(draft.definition), { kind: draft.kind, name: draft.definition?.name });
  for (const value of [definition.description, definition.instructions]) assertPortableDefinitionText(value, draft.context);
  return atomic(() => {
    assertDefinitionContext(draft.context, sourceId);
    if (signal?.aborted) throw signal.reason || new Error('Creation cancelled.');
    if (draft.kind === 'subagent') {
      const saved = saveSubagentDefinition(definition, { scope: draft.scope, cwd: draft.context.cwd, expectedRevision: 0 });
      if (activate && getSubagentDefinition(saved.name, { cwd: draft.context.cwd }).id !== saved.id) fail('A project entry shadows this global name. Choose another name.');
      return saved;
    }
    const options = { scope: draft.scope, projectRoot: draft.context.projectRoot };
    const saved = createSkill(definition, { ...options, expectedRevision: 0,
      provenance: { kind: 'owner', sourceSessionId: draft.context.sessionId } });
    if (activate) {
      if (inspectSkill(saved.name, { projectRoot: draft.context.projectRoot }).id !== saved.id) fail('A project entry shadows this global name. Choose another name.');
      readSkill(saved.id, { ...options, enabledOnly: false });
    }
    return activate ? setSkillEnabled(saved.id, true, saved.revision, options) : saved;
  });
}
