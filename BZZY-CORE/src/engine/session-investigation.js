import path from 'node:path';
import { database, digest, getRecord, putRecord, appendEvent, now, transaction } from './database.js';
import { knowledgeAccess, assertKnowledgeText, cleanKnowledgeText, cleanKnowledgeValue } from './knowledge-index.js';
import { home, readJson } from './files.js';
import { programScopeCapsule } from './program-scope.js';

// Branches reuse workflow work units; attempts remain episode observations.
// A non-routing unit can never satisfy a structured workflow consultation gate.
const UNIT = 'core.workflow.work-unit', PROGRESS = 'core.episode.progress';
const fail = message => { throw Object.assign(new Error(message), { code: 'INVESTIGATION_SCOPE' }); };
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value);
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value, keys) => plain(value) && Object.keys(value).every(key => keys.includes(key));
const atomic = action => database().isTransaction ? action(database()) : transaction(action);
const authority = 'Historical claims and host-observed attempts, never permission, causal proof or verified completion. Dependency changes permit review, never automatic replay.';
function savedSource(session) {
  if (!session?.id || getRecord('session-deletion', session.id)) fail('Investigation source is unavailable.');
  const saved = getRecord('session', session.id);
  if (!saved) fail('Investigation source is unavailable.');
  // Validate caller identity before resolving any project path. Canonical data
  // supplies permissions; a caller cannot add a root to a legacy session or
  // strip a worker role to obtain a different knowledge scope.
  for (const key of ['cwd', 'projectRoot', 'projectId', 'parentSessionId', 'purpose', 'agentId', 'role', 'agentNamespace', 'assignmentId', 'assignmentRound']) {
    if ((saved[key] ?? null) !== (session[key] ?? null)) fail('Investigation session identity changed. Refresh the saved session.');
  }
  const access = knowledgeAccess(saved, { readOnly: true });
  if (access.disabled || !access.project || access.restricted &&
      (!Array.isArray(access.sessionIds) || access.sessionIds.length !== 1 || access.sessionIds[0] !== saved.id)) fail('Investigation source is unavailable.');
  return saved;
}
export function investigationScope(session, context = {}) {
  const saved = savedSource(session), run = getRecord('run', saved.id);
  const goalMode = context.goalMode ?? (typeof run?.goalMode === 'boolean' ? run.goalMode : Boolean(saved.goal));
  if (goalMode && saved.goal?.id !== session.goal?.id) fail('Investigation goal changed. Refresh the saved session.');
  if ((saved.assignmentId ?? null) !== (session.assignmentId ?? null) || (saved.assignmentRound ?? null) !== (session.assignmentRound ?? null)) fail('Investigation assignment changed.');
  return { goalId: goalMode ? saved.goal?.id || null : null,
    runId: goalMode || saved.assignmentId ? null : context.runId || run?.id || null,
    assignmentId: saved.assignmentId || null, assignmentRound: saved.assignmentRound ?? null };
}
function live(session, context) {
  const saved = savedSource(session), run = getRecord('run', saved.id), scope = investigationScope(session, context);
  if (!context?.runId || run?.id !== context.runId || run.state !== 'running' || !['running', 'waiting_for_input'].includes(saved.executionState)
      || scope.goalId && saved.goal?.status !== 'active') fail('Investigation changes require the current live execution.');
  if (readJson(path.join(home(), 'runtime', 'operator-stop.json'), null)?.stopped || database().prepare("SELECT 1 FROM records WHERE kind='execution' AND json_extract(data,'$.sessionId')=? AND json_extract(data,'$.state') IN ('queued','launching','running') AND json_extract(data,'$.stopAction') IN ('pause','cancel') LIMIT 1").get(saved.id)) fail('The owner stopped this execution.');
  return { saved, scope };
}
function currentScopePin(session) {
  const value = programScopeCapsule(session);
  return { enrolled: value.enrolled, state: value.state, scopeVersion: value.scopeVersion || null,
    bindingId: value.bindingId || null, fence: value.fence ?? null };
}
function ownUnit(session, id, scope, current = true) {
  const unit = typeof id === 'string' && getRecord(UNIT, id);
  if (!unit || unit.sessionId !== session.id || unit.importedUntrusted || unit.importProvenance) fail('Investigation branch is outside this session.');
  if (unit.version === 2) {
    if (unit.routing !== false || unit.id !== digest([session.id, unit.scope, unit.requestId])) fail('Investigation branch integrity changed.');
    if (current && digest(unit.scope) !== digest(scope)) fail('Investigation branch belongs to another execution scope.');
  } else if (unit.version === 1) {
    if (unit.id !== digest([session.id, unit.goalId, unit.requestId]) || current && (unit.goalId !== scope.goalId || scope.assignmentId)) fail('Routing branch belongs to another execution scope.');
  } else fail('Investigation branch is unavailable.');
  return unit;
}
function dependencies(session, inputs = []) {
  if (!Array.isArray(inputs) || inputs.length > 8) fail('Use at most eight investigation dependencies.');
  return inputs.map(input => {
    if (!exact(input, ['kind', 'id']) || !['execution_policy', 'session_input', 'artifact', 'work_unit'].includes(input.kind)
        || input.id != null && !identifier(input.id)) fail('Invalid investigation dependency.');
    let value, id = input.id || input.kind;
    if (input.kind === 'execution_policy') {
      value = { policy: session.policy || null, scope: session.contract?.scope || null, constraints: session.contract?.constraints || [], programScope: currentScopePin(session) };
    } else if (input.kind === 'session_input') {
      const row = database().prepare("SELECT seq,data FROM events WHERE session_id=? AND type IN ('message.user','question.answered') ORDER BY seq DESC LIMIT 1").get(session.id);
      value = row ? { seq: row.seq, hash: digest(row.data) } : null;
    } else if (input.kind === 'artifact') {
      const item = getRecord('artifact', id);
      if (!item || item.sessionId !== session.id && !(session.allowedArtifactIds || []).includes(id)) fail('Dependency artifact is outside this session.');
      value = { sha256: item.sha256, sourceSha256: item.sourceSha256 || null, revision: item.revision || 1 };
    } else {
      const item = ownUnit(session, id, {}, false);
      value = { revision: item.revision || 1, state: item.state, outcome: item.outcome || null };
    }
    return { kind: input.kind, id, fingerprint: digest(value) };
  });
}
function dependencyState(session, unit) {
  const values = dependencies(session, (unit.dependencies || []).map(({ kind, id }) => ({ kind, id })));
  return { dependencies: values, dependencyFingerprint: digest(values) };
}
const publicBlocker = (blocker, observed) => ({ id: blocker.id, key: blocker.key, kind: blocker.kind,
  description: cleanKnowledgeText(blocker.description, 320), state: blocker.state, revision: blocker.revision,
  resolver: blocker.resolver || 'unavailable', affectedWork: cleanKnowledgeText(blocker.affectedWork, 240), neededChange: cleanKnowledgeText(blocker.neededChange, 240),
  dependencyFingerprint: blocker.dependencyFingerprint,
  dependencyChanged: observed != null && observed !== blocker.dependencyFingerprint,
  ...(blocker.resolution ? { resolution: cleanKnowledgeValue(blocker.resolution) } : {}) });
function publicUnit(session, unit) {
  let observed;
  try { observed = dependencyState(session, unit).dependencyFingerprint; } catch { /* Missing dependencies remain blocked, never resolved. */ }
  return { id: unit.id, sessionId: unit.sessionId, scope: unit.scope || { goalId: unit.goalId, runId: null, assignmentId: null, assignmentRound: null },
    revision: unit.revision || 1, hypothesis: cleanKnowledgeText(unit.hypothesis, 320), state: unit.state, outcome: unit.outcome || null,
    routing: unit.version === 1, dependencyFingerprint: unit.dependencyFingerprint || null,
    applicability: { sourcePinsAvailable: Boolean(unit.sourcePins), policyChanged: unit.sourcePins ? unit.sourcePins.policyFingerprint !== digest(session.policy || null) : null,
      instructionsChanged: unit.sourcePins?.instructionFingerprint ? unit.sourcePins.instructionFingerprint !== digest(session.contract || null) : null,
      programScopeChanged: unit.sourcePins?.programScope ? digest(unit.sourcePins.programScope) !== digest(currentScopePin(session)) : null },
    blockers: (unit.blockers || []).map(blocker => publicBlocker(blocker, observed)), historical: true, authority };
}

export function updateInvestigation(session, input, context = {}) {
  if (!exact(input, ['action', 'requestId', 'id', 'expectedRevision', 'hypothesis', 'dependencies', 'blocker', 'blockerId', 'expectedBlockerRevision', 'resolution', 'outcome', 'blockGoal'])
      || !['declare', 'select', 'block', 'resolve', 'close'].includes(input.action) || !identifier(input.requestId)) fail('Use a valid investigation action and stable requestId.');
  if (input.blockGoal != null && (typeof input.blockGoal !== 'boolean' || input.action !== 'block')) fail('Goal blocking is an explicit blocker action.');
  if (input.expectedRevision != null && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)) fail('Use the displayed branch revision.');
  const initial = live(session, context), requestKey = digest([session.id, initial.scope, input.requestId]), inputHash = digest(input);
  return atomic(db => {
    const { saved, scope } = live(session, context), priorRequest = getRecord('core.workflow.investigation-request', requestKey);
    if (priorRequest) {
      if (priorRequest.inputHash !== inputHash) fail('Investigation requestId was reused with changed input.');
      if (priorRequest.result.goalBlocker && priorRequest.sourceRunId !== context.runId) {
        const { goalBlocker: _goalBlocker, ...historical } = priorRequest.result;
        return { ...historical, historicalOnly: true };
      }
      return priorRequest.result;
    }
    let unit;
    if (input.action === 'declare') {
      const count = db.prepare("SELECT count(*) AS n FROM records WHERE kind=? AND json_extract(data,'$.sessionId')=? AND json_extract(data,'$.state')='open'").get(UNIT, saved.id).n;
      if (count >= 256) fail('Close existing branches before opening more than 256 active branches.');
      const hypothesis = assertKnowledgeText(input.hypothesis, 2000), material = dependencies(saved, input.dependencies || []);
      const id = digest([saved.id, scope, input.requestId]);
      unit = { version: 2, routing: false, id, sessionId: saved.id, projectId: saved.projectId, goalId: scope.goalId,
        scope, requestId: input.requestId, hypothesis, dependencies: material, dependencyFingerprint: digest(material),
        sourcePins: { ...scope, admittedRunId: context.runId, policyFingerprint: digest(saved.policy || null),
          instructionFingerprint: digest(saved.contract || null), programScope: currentScopePin(saved) },
        blockers: [], state: 'open', revision: 1, createdAt: now(), updatedAt: now() };
    } else {
      unit = ownUnit(saved, input.id, scope);
      if (input.expectedRevision != null && input.expectedRevision !== (unit.revision || 1)) fail('Investigation branch changed.');
      if (unit.state !== 'open') fail('Closed branches cannot restart work. Declare a new branch with current dependencies.');
      if (input.action !== 'select' && unit.version === 1) fail('Use workflow routing tools to change a routed work unit.');
      if (input.action === 'block') {
        const value = input.blocker;
        if (!exact(value, ['key', 'kind', 'description', 'resolver', 'affectedWork', 'neededChange']) || !identifier(value.key) || !['owner_input', 'scope', 'external', 'technical'].includes(value.kind)
            || !['owner', 'agent', 'external'].includes(value.resolver)) fail('Use a stable blocker key, kind and responsible resolver.');
        const description = assertKnowledgeText(value.description, 2000), blockers = [...unit.blockers], index = blockers.findIndex(item => item.key === value.key);
        if (index < 0 && blockers.length >= 32) fail('A branch supports at most 32 explicit blockers.');
        if (index >= 0 && blockers[index].state === 'resolved') fail('A resolved blocker needs a new distinct blocker key to recur.');
        const blocker = { ...(index >= 0 ? blockers[index] : {}), id: digest([unit.id, value.key]), key: value.key, kind: value.kind,
          description, state: 'open', revision: (index >= 0 ? blockers[index].revision : 0) + 1,
          resolver: value.resolver, affectedWork: assertKnowledgeText(value.affectedWork, 1000), neededChange: assertKnowledgeText(value.neededChange, 1000),
          dependencyFingerprint: dependencyState(saved, unit).dependencyFingerprint, recordedAt: now() };
        if (index >= 0) blockers[index] = blocker; else blockers.push(blocker);
        unit = { ...unit, blockers };
      } else if (input.action === 'resolve') {
        const blockers = [...unit.blockers], index = blockers.findIndex(item => item.id === input.blockerId), blocker = blockers[index];
        if (!blocker || blocker.state !== 'open' || blocker.revision !== input.expectedBlockerRevision) fail('Refresh the open blocker and its revision.');
        const observed = dependencyState(saved, unit), statement = assertKnowledgeText(input.resolution, 2000);
        if (observed.dependencyFingerprint === blocker.dependencyFingerprint) fail('The recorded dependency has not changed. A restated plan cannot resolve this blocker.');
        blockers[index] = { ...blocker, state: 'resolved', revision: blocker.revision + 1, resolution: { statement,
          previousFingerprint: blocker.dependencyFingerprint, observedFingerprint: observed.dependencyFingerprint, observedChange: true,
          recordedAt: now(), sourceRunId: context.runId, authority: 'Agent-declared resolution after a host-observed dependency change; not proof or authorization.' } };
        unit = { ...unit, blockers, ...observed };
      } else if (input.action === 'close') {
        if (!['inconclusive', 'disproved', 'investigated', 'abandoned'].includes(input.outcome)) fail('Branch closure is an investigation disposition, never verified completion.');
        if (unit.blockers.some(item => item.state === 'open') && input.outcome !== 'abandoned') fail('Resolve the open blockers or explicitly abandon this branch.');
        unit = { ...unit, state: 'closed', outcome: input.outcome, closedAt: now() };
      }
      if (input.action !== 'select') unit = { ...unit, revision: unit.revision + 1, updatedAt: now() };
    }
    putRecord(UNIT, unit.id, unit, db);
    if (input.action === 'declare' || input.action === 'select') {
      const progress = getRecord(PROGRESS, saved.id) || { sessionId: saved.id };
      putRecord(PROGRESS, saved.id, { ...progress, investigation: { workUnitId: unit.id, scope, selectedRunId: context.runId } }, db);
    }
    const result = publicUnit(saved, unit);
    if (input.blockGoal) {
      if (!scope.goalId || saved.parentSessionId || saved.role || saved.assignmentId) fail('Only the current root goal can report all remaining work blocked.');
      const open = db.prepare("SELECT data FROM records WHERE kind=? AND json_extract(data,'$.sessionId')=? AND json_extract(data,'$.state')='open' LIMIT 257").all(UNIT, saved.id)
        .map(row => JSON.parse(row.data)).filter(candidate => { try { ownUnit(saved, candidate.id, scope); return true; } catch { return false; } });
      if (!open.length || open.length > 256 || open.some(candidate => !(candidate.blockers || []).some(blocker => blocker.state === 'open'))) fail('Other current branches remain available; this blocker cannot stop the whole goal.');
      if (db.prepare("SELECT 1 FROM records WHERE kind='assignment' AND json_extract(data,'$.parentSessionId')=? AND json_extract(data,'$.goalId')=? AND json_extract(data,'$.closure')='open' LIMIT 1").get(saved.id, scope.goalId)) fail('Review or stop outstanding assignments before declaring the whole goal blocked.');
      const blockers = open.flatMap(candidate => candidate.blockers.filter(blocker => blocker.state === 'open'));
      result.goalBlocker = { status: 'blocked', reason: cleanKnowledgeText(blockers.map(blocker => `${blocker.description} Needed: ${blocker.neededChange}`).join('\n'), 2000),
        blockerIds: blockers.map(blocker => blocker.id).slice(0, 32), scope, coverage: 'all-declared-current-branches',
        requiresExecutionStop: true, authority: 'Explicit all-remaining-work claim checked against declared branches; not exhaustive semantic coverage or authorization.' };
    }
    appendEvent(saved.id, 'investigation.' + input.action, { ...result, sourceRunId: context.runId }, db);
    putRecord('core.workflow.investigation-request', requestKey, { sessionId: saved.id, scope, sourceRunId: context.runId, inputHash, result }, db);
    return result;
  });
}

export function currentInvestigationAttribution(session, context = {}) {
  const saved = savedSource(session), scope = investigationScope(saved, context), selection = getRecord(PROGRESS, saved.id)?.investigation;
  if (!selection || digest(selection.scope) !== digest(scope)) return {};
  try {
    const unit = ownUnit(saved, selection.workUnitId, scope);
    if (unit.state !== 'open') return {};
    return { workUnitId: unit.id, workUnitRevision: unit.revision || 1, ...dependencyState(saved, unit) };
  } catch { return {}; }
}
export function validateInvestigationBlockers(session, ids, context = {}) {
  if (!Array.isArray(ids) || ids.length > 32 || ids.some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))) fail('Use at most 32 current blocker IDs.');
  const saved = savedSource(session), scope = investigationScope(saved, context);
  const rows = database().prepare("SELECT data FROM records WHERE kind=? AND json_extract(data,'$.sessionId')=? AND json_extract(data,'$.version')=2 ORDER BY updated_at DESC LIMIT 257").all(UNIT, saved.id);
  const allowed = new Set();
  for (const row of rows) {
    const item = JSON.parse(row.data);
    try { ownUnit(saved, item.id, scope); for (const blocker of item.blockers || []) allowed.add(blocker.id); } catch { /* Historical scopes grant no current blocker identity. */ }
  }
  if (ids.some(id => !allowed.has(id))) fail('Checkpoint blocker belongs to another session or execution scope.');
  return [...new Set(ids)];
}
export function investigationCapsule(session, context = {}, { maxBytes = 2200 } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 800 || maxBytes > 8192) fail('Use a bounded investigation capsule budget.');
  const saved = savedSource(session), scope = investigationScope(saved, context);
  const candidates = database().prepare("SELECT data FROM records WHERE kind=? AND json_extract(data,'$.sessionId')=? ORDER BY updated_at DESC,id LIMIT 129").all(UNIT, saved.id);
  const current = [], historical = [];
  for (const row of candidates.slice(0, 128)) {
    const unit = JSON.parse(row.data);
    try { ownUnit(saved, unit.id, scope); current.push(unit); }
    catch { historical.push(unit.id); }
  }
  current.sort((a, b) => Number(b.state === 'open') - Number(a.state === 'open'));
  const branches = current.slice(0, 3).map(item => {
    const value = publicUnit(saved, item), active = value.blockers.filter(blocker => blocker.state === 'open');
    return { id: value.id, revision: value.revision, hypothesis: value.hypothesis.slice(0, 160), state: value.state, outcome: value.outcome,
      applicability: value.applicability,
      blockers: active.slice(0, 2).map(blocker => ({ id: blocker.id, kind: blocker.kind, revision: blocker.revision,
        description: blocker.description.slice(0, 120), resolver: blocker.resolver, neededChange: blocker.neededChange.slice(0, 120), dependencyChanged: blocker.dependencyChanged })),
      omittedBlockers: Math.max(0, active.length - 2), detail: 'read_investigation' };
  });
  const observations = database().prepare("SELECT data FROM records WHERE kind='core.episode.observation' AND json_extract(data,'$.sessionId')=? AND json_extract(data,'$.goalId') IS ? AND (? IS NOT NULL OR json_extract(data,'$.runId') IS ?) ORDER BY updated_at DESC,id LIMIT 64").all(saved.id, scope.goalId, scope.goalId, scope.runId);
  const repeats = new Map();
  for (const row of observations) {
    const item = JSON.parse(row.data);
    if (!item.operationFingerprint || (item.assignmentId || null) !== scope.assignmentId || (item.assignmentRound ?? null) !== scope.assignmentRound) continue;
    const key = digest([item.operationFingerprint, item.dependencyFingerprint || null, item.workUnitId || null]);
    const previous = repeats.get(key) || { fingerprint: key, workUnitId: item.workUnitId || null, count: 0, outcomes: {}, latestSourceId: item.id,
      dependencyCoverage: item.dependencyFingerprint ? 'recorded' : 'unavailable', authority: 'Same recorded operation and dependency fingerprint; no automatic replay or causal conclusion.' };
    previous.count++; previous.outcomes[item.outcome] = (previous.outcomes[item.outcome] || 0) + 1; repeats.set(key, previous);
  }
  const result = { scope, branches, repeatedAttempts: [...repeats.values()].filter(item => item.count > 1).slice(0, 3),
    historicalCount: historical.length, omittedBranches: Math.max(0, current.length - branches.length),
    coverage: { branchWindow: 128, moreBranches: candidates.length > 128, observationWindow: 64, historicalCountIsWindowed: true }, authority };
  while (Buffer.byteLength(JSON.stringify(result)) > maxBytes - 80 && (result.branches.length > 1 || result.repeatedAttempts.length)) {
    if (result.repeatedAttempts.length) result.repeatedAttempts.pop(); else { result.branches.pop(); result.omittedBranches++; }
  }
  while (Buffer.byteLength(JSON.stringify(result)) > maxBytes - 80 && result.branches.length) { result.branches.pop(); result.omittedBranches++; }
  result.revision = digest(result); return result;
}
export function readInvestigationSource(session, input, context = {}) {
  if (!exact(input, ['id', 'revision', 'offset', 'limit']) || typeof input.revision !== 'string') fail('Use a branch ID and its source revision.');
  const saved = savedSource(session), scope = investigationScope(saved, context), unit = ownUnit(saved, input.id, scope, false);
  const value = { ...publicUnit(saved, unit), hypothesis: cleanKnowledgeText(unit.hypothesis, 2000),
    currentScope: unit.version === 2 ? digest(unit.scope) === digest(scope) : unit.goalId === scope.goalId,
    blockers: (unit.blockers || []).map(item => ({ ...publicBlocker(item), description: cleanKnowledgeText(item.description, 2000) })) };
  const sourceRevision = digest(value);
  if (input.revision !== String(unit.revision || 1) && input.revision !== sourceRevision) fail('Investigation source changed. Refresh the branch revision.');
  const buffer = Buffer.from(JSON.stringify(value)), offset = input.offset ?? 0, limit = input.limit ?? 4096;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > buffer.length || offset && (buffer[offset] & 0xc0) === 0x80
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 8192 || offset && input.revision !== sourceRevision) fail('Use UTF-8 byte pages and preserve the returned source revision.');
  let end = Math.min(buffer.length, offset + limit);
  while (end > offset && end < buffer.length && (buffer[end] & 0xc0) === 0x80) end--;
  if (end === offset && end < buffer.length) fail('Page limit is too small for the next character.');
  return { id: unit.id, revision: sourceRevision, offset, nextOffset: end < buffer.length ? end : null, totalBytes: buffer.length, text: buffer.subarray(offset, end).toString('utf8'), authority };
}
export function investigationToolSpecs() {
  const string = { type: 'string' }, dependency = { type: 'object', additionalProperties: false,
    properties: { kind: { type: 'string', enum: ['execution_policy', 'session_input', 'artifact', 'work_unit'] }, id: string }, required: ['kind'] };
  return [{ name: 'update_investigation', description: 'Track an explicit branch, select it for observed attempts, or record/resolve a stable blocker. Resolution requires changed recorded dependencies. No action executes work, grants scope or verifies a finding. Routed units must use their existing routing tools.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      action: { type: 'string', enum: ['declare', 'select', 'block', 'resolve', 'close'] }, requestId: string, id: string,
      expectedRevision: { type: 'integer', minimum: 1 }, hypothesis: string, dependencies: { type: 'array', maxItems: 8, items: dependency },
      blocker: { type: 'object', additionalProperties: false, properties: { key: string, kind: { type: 'string', enum: ['owner_input', 'scope', 'external', 'technical'] }, description: string,
        resolver: { type: 'string', enum: ['owner', 'agent', 'external'] }, affectedWork: string, neededChange: string }, required: ['key', 'kind', 'description', 'resolver', 'affectedWork', 'neededChange'] },
      blockGoal: { type: 'boolean', description: 'Explicitly assert all remaining goal work is blocked. Rejected while another declared current branch or outstanding assignment can proceed. Stops work without replay.' },
      blockerId: string, expectedBlockerRevision: { type: 'integer', minimum: 1 }, resolution: string,
      outcome: { type: 'string', enum: ['inconclusive', 'disproved', 'investigated', 'abandoned'] } }, required: ['action', 'requestId'] } },
  { name: 'read_investigation', description: 'Read exact sanitized branch/blocker history in this session without resuming work. Keep the returned source revision for subsequent UTF-8 pages.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { id: string, revision: string, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 8192 } }, required: ['id', 'revision'] } }];
}

export function sanitizedNativeBlocker(value) {
  const text = typeof value === 'string' ? cleanKnowledgeText(value, 1000).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').trim() : '';
  return { reason: text || 'Native backend reported blocked without a usable reason.', reasonAvailable: Boolean(text),
    provenance: 'native-backend-reported', authority: 'Reported blocker, not a permission decision or verified diagnosis.' };
}
