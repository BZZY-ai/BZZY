import { randomUUID } from 'node:crypto';
import { appendEvent, getRecord, digest } from './database.js';
import { listSkills } from './skills.js';
import { listSubagentDefinitions } from './subagent-definitions.js';
import { diagnosticFields as pick, diagnosticRedactor } from './diagnostic-redaction.js';
import { saveSession } from './store.js';

const definitionFields = ['id', 'name', 'description', 'scope', 'version', 'revision', 'enabled', 'provider', 'model', 'effort', 'policy', 'limits'];
export const diagnosticDefinition = value => pick(value, definitionFields);
const live = (session, context) => context.runId && getRecord('run', session.id)?.id === context.runId && getRecord('run', session.id)?.state === 'running';

function pageCatalog(read, field) {
  const items = []; let offset = 0, total = 0;
  do {
    const page = read(offset); total = page.total; items.push(...page[field].map(diagnosticDefinition)); offset = page.nextOffset;
  } while (offset != null && items.length < 1024);
  return { items, total, complete: offset == null };
}

// New records describe host-visible choices and tool outcomes, not private
// reasoning or a claim that every available method should have been invoked.
export function recordRunDiagnostics(session, context, tools) {
  if (!live(session, context)) return;
  const scrub = diagnosticRedactor({ roots: [session.cwd, session.projectRoot], maxItems: 2048 }).scrub;
  let skills, agents;
  try { skills = pageCatalog(offset => listSkills({ session, enabledOnly: true, limit: 100, offset }), 'skills'); }
  catch { skills = { items: [], complete: false, reason: 'catalog_unavailable' }; }
  try { agents = tools.includes('list_subagents') ? pageCatalog(offset => listSubagentDefinitions({ cwd: session.projectRoot || session.cwd, enabledOnly: true, limit: 100, offset }), 'subagents')
    : { items: [], total: 0, complete: true, reason: 'not_available_to_role' }; }
  catch { agents = { items: [], complete: false, reason: 'catalog_unavailable' }; }
  appendEvent(session.id, 'diagnostic.run', scrub({ version: 1, runId: context.runId, goalId: context.goalMode ? session.goal?.id : null,
    provider: session.provider, model: session.model, effort: session.selectedEffort || null, mode: session.mode || 'solo', role: session.role || 'coordinator',
    tools, policy: session.policy, limits: session.contract?.limits, skills, agents, provenance: 'available-at-run-start' }));
}

export function recordPromptSkillCatalog(session, catalog) {
  const run = getRecord('run', session.id);
  if (!run || run.state !== 'running') return;
  appendEvent(session.id, 'diagnostic.catalog', { version: 1, runId: run.id, goalId: run.goalMode ? run.goalId : null,
    provenance: 'prepared-skill-prompt', ...diagnosticRedactor({ roots: [session.cwd, session.projectRoot] }).scrub(catalog) });
}

export function recordDiagnosticTool(session, context, { name, callId, started, result, error, phase, input }) {
  if (!live(session, context)) return;
  const data = { version: 1, runId: context.runId, goalId: context.goalMode ? session.goal?.id : null,
    callId, name, outcome: phase === 'started' ? 'started' : error ? 'failed' : 'returned', durationMs: Math.max(0, Date.now() - started) };
  if (phase === 'started') data.input = name === 'gmail_read' ? { operation: ['list', 'read'].includes(input?.operation) ? input.operation : 'invalid' }
    : pick(input, ['name', 'query', 'version', 'file', 'offset', 'limit', 'id', 'requestId', 'waitSeconds', 'timeoutSeconds', 'round', 'limits', 'policy', 'maxBytes', 'types', 'includeStale']);
  else if (error) { data.code = typeof error.code === 'string' ? error.code : 'TOOL_ERROR'; data.message = String(error.message || 'Tool failed.'); }
  else if (name === 'list_skills' || name === 'list_subagents') {
    const field = name === 'list_skills' ? 'skills' : 'subagents';
    data.discovery = { items: result[field].map(diagnosticDefinition), total: result.total, nextOffset: result.nextOffset };
  } else if (name === 'read_subagent') data.definition = { ...diagnosticDefinition(result), instructions: result.instructions };
  else if (name === 'read_skill') data.resource = pick(result, ['id', 'name', 'version', 'file', 'sha256', 'nextOffset']);
  else if (name === 'gmail_read') data.mailbox = { readOnly: true, ...(Array.isArray(result.messages) ? { count: result.messages.length } : {}) };
  else if (['read_session_memory', 'expand_session_memory', 'search_knowledge', 'recall', 'get_task_state'].includes(name)) {
    data.contextResult = result; data.resultSourceSha256 = digest(result); data.resultBytes = Buffer.byteLength(JSON.stringify(result));
    if (name === 'get_task_state') {
      const previous = session.contextEfficiency || {}, identical = previous.lastPayloadSha256 === data.resultSourceSha256;
      const revision = typeof result?.revision === 'string' ? result.revision : data.resultSourceSha256;
      session.contextEfficiency = { version: 1, taskStateReads: (previous.taskStateReads || 0) + 1,
        identicalPayloadReads: (previous.identicalPayloadReads || 0) + Number(identical),
        repeatedPayloadBytes: (previous.repeatedPayloadBytes || 0) + (identical ? data.resultBytes : 0),
        unchangedRevisionReads: (previous.unchangedRevisionReads || 0) + Number(previous.lastRevision === revision),
        notModifiedReads: (previous.notModifiedReads || 0) + Number(result?.notModified === true),
        lastPayloadSha256: data.resultSourceSha256, lastRevision: revision, lastBytes: data.resultBytes, measuredAt: new Date().toISOString() };
      data.contextEfficiency = session.contextEfficiency;
      saveSession(session);
    }
  }
  appendEvent(session.id, 'diagnostic.tool', diagnosticRedactor({ roots: [session.cwd, session.projectRoot] }).scrub(data));
}

// Capture only BZZY-generated payloads and explicit backend acknowledgments.
// Native configuration, environments, credentials and provider reasoning never
// enter this record. Failure to write diagnostics cannot retry a model request.
export function recordBackendDiagnostics(session, input, type = 'diagnostic.backend') {
  const setupId = input.setupId || randomUUID();
  try {
    const run = getRecord('run', session.id);
    if (!run || run.state !== 'running') return setupId;
    const data = { version: 1, runId: run.id, goalId: run.goalMode ? run.goalId : null, setupId,
      provider: session.provider, backend: session.backend,
      ...pick(input, ['method', 'outcome', 'transport', 'toolsSource', 'tools', 'reportedTools', 'model', 'policy', 'delivery', 'reason', 'contextBudget', 'readiness', 'inputEstimate', 'budgetState']) };
    if (input.threadId) data.threadRef = digest(input.threadId);
    for (const field of ['instructions', 'prompt']) if (typeof input[field] === 'string') data[field] = {
      sourceSha256: digest(input[field]), sourceBytes: Buffer.byteLength(input[field]), text: input[field] };
    appendEvent(session.id, type, diagnosticRedactor({ roots: [session.cwd, session.projectRoot] }).scrub(data));
  } catch { /* Diagnostics never alter the request or its outcome. */ }
  return setupId;
}
