import { database, getRecord, digest } from './database.js';
import { loadSession } from './store.js';
import { getProvider } from './providers.js';
import { childPolicy } from './policy.js';
import { normalizePolicy } from './contracts.js';
import { agentExecutionScope } from './agent-execution.js';
import { getSubagentDefinition, listSubagentDefinitions, assertSubagentDefinitionEnabled } from './subagent-definitions.js';
import { startAssignment, assignmentStatus, followupAssignment, answerAssignmentContext } from './delegation.js';
import { sanitizeMissionValue } from './mission-context.js';
import { reasoningEffort } from './instructions.js';
import { compactAssignmentStatus } from './assignment-views.js';

const fail = message => { throw new Error(message); };
const text = (value, limit, label) => {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > limit || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) fail(`Invalid subagent ${label}.`);
  return value.trim();
};
const fields = ['name', 'requestId', 'objective', 'context', 'evidence', 'policy', 'limits', 'waitSeconds'];

// Only top-level owner conversations can invoke specialists. Registry text and
// imported worker metadata never establish a new execution principal.
export function subagentsAvailable(session) {
  return Boolean(session?.id && !session.parentSessionId && !session.assignmentId &&
    !['executor', 'reviewer', 'peer', 'bestie', 'learning-review', 'knowledge-review', 'skill-writer'].includes(session.role) &&
    session.purpose !== 'agent' && !agentExecutionScope(session));
}

function runningParent(parent, { goalMode = false, runId } = {}) {
  const saved = parent?.id && loadSession(parent.id), run = saved && getRecord('run', saved.id);
  if (!saved || !subagentsAvailable(saved) || !subagentsAvailable(parent) || saved.cwd !== parent.cwd ||
      !runId || run?.id !== runId || run.state !== 'running' || !['running', 'waiting_for_input'].includes(saved.executionState)) fail('Subagents require the current live parent execution; stopped or historical conversations cannot launch workers.');
  if (goalMode && (!saved.goal || saved.goal.status !== 'active' || saved.goal.id !== parent.goal?.id)) fail('The parent goal is not active.');
  return saved;
}

function validateInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !fields.includes(key))) fail('Invalid subagent invocation fields.');
  const requestId = text(input.requestId, 128, 'request ID'), objective = text(input.objective, 16000, 'objective');
  if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(requestId)) fail('Invalid subagent request ID.');
  if (input.context != null) text(input.context, 32000, 'context');
  if (input.evidence != null && (!Array.isArray(input.evidence) || input.evidence.length > 32 || input.evidence.some(id => typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)))) fail('Subagent evidence must contain at most 32 recorded artifact IDs.');
  if (input.policy != null && (!input.policy || typeof input.policy !== 'object' || Array.isArray(input.policy) || Object.keys(input.policy).some(key => !['mode', 'network', 'writablePaths'].includes(key)))) fail('Invalid subagent permission fields.');
  if (input.limits != null && (!input.limits || typeof input.limits !== 'object' || Array.isArray(input.limits) || Object.keys(input.limits).some(key => !['runtimeSeconds', 'tokenBudget'].includes(key)))) fail('Invalid subagent invocation limits.');
  for (const [key, max] of [['runtimeSeconds', 3600], ['tokenBudget', 200000]]) if (input.limits?.[key] != null && (!Number.isSafeInteger(input.limits[key]) || input.limits[key] < 1 || input.limits[key] > max)) fail(`Subagent ${key} must be 1–${max}.`);
  if (input.waitSeconds != null && (!Number.isSafeInteger(input.waitSeconds) || input.waitSeconds < 0 || input.waitSeconds > 30)) fail('Subagent waitSeconds must be 0–30.');
  return { requestId, objective };
}

export function spawnSubagent(parent, input, context = {}) {
  const source = runningParent(parent, context), { requestId, objective } = validateInput(input);
  const invocation = { id: digest([source.id, context.goalMode ? source.goal.id : context.runId, requestId]), digest: digest(sanitizeMissionValue(input)) };
  const previous = getRecord('subagent-invocation', invocation.id);
  if (previous) {
    if (previous.digest !== invocation.digest) fail('Idempotency conflict: request ID was already used for different input.');
    return subagentStatus(source, previous.assignmentId);
  }
  const definition = getSubagentDefinition(input.name, { cwd: source.projectRoot || source.cwd, enabledOnly: true });
  const provider = getProvider(definition.provider || source.provider);
  const inheritedModel = provider.id === source.provider ? source.model : provider.model;
  const sameModel = provider.id === source.provider && (!definition.model || definition.model === source.model);
  const selection = { provider: provider.id, model: definition.model || inheritedModel || null,
    ...(definition.effort || sameModel && source.selectedEffort ? { effort: definition.effort || source.selectedEffort } : {}),
    ...(sameModel && source.modelCapabilities ? { capabilities: source.modelCapabilities } : {}) };
  // Validate against Core's catalog, including fixed selections on a different
  // provider, before reserving a worker or calling any model.
  reasoningEffort({ provider: selection.provider, model: selection.model, selectedEffort: selection.effort, modelCapabilities: selection.capabilities }, { contract: true });
  const base = normalizePolicy(source.policy || source.contract?.policy);
  const defined = childPolicy(base, { ...base, ...definition.policy });
  const policy = childPolicy(defined, { ...defined, ...input.policy });
  const runtimeSeconds = Math.min(input.limits?.runtimeSeconds || definition.limits?.runtimeSeconds || 300,
    definition.limits?.runtimeSeconds || 3600, source.contract?.limits?.assignmentSeconds || 3600);
  const tokenBudget = Math.min(input.limits?.tokenBudget || definition.limits?.tokenBudget || 20000, definition.limits?.tokenBudget || 200000);
  const taskContext = sanitizeMissionValue({ mode: context.goalMode ? 'goal' : 'chat', request: text(context.prompt || objective, 128000, 'current request'), assignment: objective, context: input.context || '' });
  const payload = sanitizeMissionValue({ requestId, objective, context: `SPECIALIST DEFINITION (${definition.name}, ${definition.version}):\n${definition.instructions}\n\nCURRENT ASSIGNMENT:\n${input.context || objective}`, policy,
    acceptanceCriteria: [{ id: 'specialist-result', description: 'Return evidence-backed observations for the assigned task, explicit uncertainty and any blockers; do not claim the parent objective is complete.', modelJudgment: true }],
    limits: { runtimeSeconds, tokenBudget } });
  return startAssignment(source, payload, { executor: selection, role: 'executor', sharedEvidence: [...new Set(input.evidence || [])],
    ...(context.launch ? { launch: context.launch } : {}),
    subagent: { definition, invocation, chatRunId: context.goalMode ? null : context.runId, taskContext,
      budget: context.goalMode ? source.goal?.tokenBudget : context.tokenBudget ?? null } });
}

export function subagentStatus(parent, id) {
  const job = assignmentStatus(id);
  if (!job.subagentDefinition || job.parentSessionId !== parent.id) fail('Subagent invocation belongs to another conversation.');
  return job;
}

export function listSubagentRuns(parent, { offset = 0, limit = 10 } = {}) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) fail('Invalid subagent invocation page.');
  const filter = "kind='assignment' AND json_extract(data,'$.parentSessionId')=? AND json_extract(data,'$.subagentDefinition') IS NOT NULL";
  const total = database().prepare(`SELECT count(*) AS n FROM records WHERE ${filter}`).get(parent.id).n;
  const jobs = database().prepare(`SELECT id, json_extract(data,'$.subagentDefinition.name') AS name, json_extract(data,'$.subagentDefinition.version') AS version
    FROM records WHERE ${filter} ORDER BY updated_at DESC,id LIMIT ? OFFSET ?`).all(parent.id, limit, offset);
  return { items: jobs.map(job => ({ ...compactAssignmentStatus(assignmentStatus(job.id)), name: job.name, version: job.version })),
    total, nextOffset: offset + limit < total ? offset + limit : null };
}

export function discoverSubagents(parent, input = {}) {
  if (!subagentsAvailable(parent)) fail('Subagent discovery is unavailable to this execution.');
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['query', 'offset', 'limit'].includes(key))) fail('Invalid subagent discovery fields.');
  return listSubagentDefinitions({ cwd: parent.projectRoot || parent.cwd, query: input.query, offset: input.offset, limit: input.limit, enabledOnly: true });
}

export function followupSubagent(parent, id, input, context = {}) {
  const saved = runningParent(parent, context), job = subagentStatus(saved, id);
  assertSubagentDefinitionEnabled(job.subagentDefinition);
  if (Boolean(job.chatRunId) === Boolean(context.goalMode)) fail('A subagent follow-up must retain its original chat or goal scope.');
  text(input.requestId, 128, 'request ID'); text(input.feedback, 16000, 'feedback'); text(input.objective, 16000, 'objective');
  return followupAssignment(saved, id, sanitizeMissionValue(input), { ...(context.launch ? { launch: context.launch } : {}),
    ...(context.sharedEvidence ? { sharedEvidence: context.sharedEvidence } : {}), chatRunId: job.chatRunId ? context.runId : undefined,
    budget: context.goalMode ? saved.goal?.tokenBudget : context.tokenBudget ?? null });
}

export function answerSubagentContext(parent, id, input, context = {}) {
  const saved = runningParent(parent, context), job = subagentStatus(saved, id);
  if (Boolean(job.chatRunId) === Boolean(context.goalMode)) fail('A subagent answer must retain its original chat or goal scope.');
  return answerAssignmentContext(saved, id, sanitizeMissionValue(input), { chatRunId: job.chatRunId ? context.runId : undefined });
}
