import { randomUUID } from 'node:crypto';
import { database, getRecord, putRecord, listRecords, appendEvent, digest, now, reserveRequest } from './database.js';
import { projectIdentityForSession } from './project-identity.js';
import { normalizeProgramScope, normalizeContract } from './contracts.js';
import { assertKnowledgeText } from './knowledge-index.js';
import { identityAlive } from './process-identity.js';
import { newGoal } from './goals.js';
import { recordSessionLifecycle } from './store.js';
import { forkGoalWorkflowBinding } from './workflows.js';
import { budgetUsage } from './delegation-usage.js';
import { childPolicy } from './policy.js';

const prefix = 'core.program.scope.', kind = suffix => prefix + suffix;
const fail = (message, code = 'PROGRAM_SCOPE_INVALID') => { throw Object.assign(new Error(message), { code, status: code === 'CONFLICT' ? 409 : 400 }); };
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const plain = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const foreign = value => value?.importedHistorical || value?.importedUntrusted || value?.importProvenance;
const activeStates = ['queued', 'launching', 'starting', 'running', 'waiting_for_input', 'verifying'];
const isolatedReview = session => ['learning-review', 'knowledge-review', 'skill-writer'].includes(session?.role);
const hasScopes = () => Boolean(database().prepare('SELECT 1 FROM records WHERE kind=? LIMIT 1').get(kind('control')));
const bindingId = (sessionId, goalId) => digest([sessionId, goalId]);
const stateFor = projectId => getRecord(kind('control'), projectId) || { projectId, revision: 0, approvalId: null, fence: 0, enrolled: false };
const safeText = (value, maximum = 4000) => assertKnowledgeText(value, maximum);
function sessionFor(value, owner = false) {
  const session = getRecord('session', typeof value === 'string' ? value : value?.id);
  if (!session || getRecord('session-deletion', session.id)) fail('Scope requires an existing local session.', 'PROGRAM_SCOPE_UNAVAILABLE');
  if (owner && (session.parentSessionId || session.role || session.agentId || session.purpose && session.purpose !== 'terminal')) fail('Only the owner terminal can administer program scope.', 'FORBIDDEN');
  if (typeof value === 'object' && ['cwd', 'backend', 'parentSessionId', 'agentId', 'role', 'projectRoot'].some(key => (value[key] ?? null) !== (session[key] ?? null))) fail('Session scope changed. Reload it.', 'CONFLICT');
  return session;
}
function rootFor(value) {
  let session = sessionFor(value), child = session; const seen = new Set();
  while (session.parentSessionId) {
    if (seen.has(session.id) || seen.size >= 64) fail('Session ancestry is unavailable.', 'PROGRAM_SCOPE_UNAVAILABLE');
    seen.add(session.id); session = sessionFor(session.parentSessionId);
  }
  return { root: session, child };
}
function projectFor(session) { return projectIdentityForSession(session, { readOnly: true }); }
function intact(value) {
  if (!value || foreign(value) || !hash(value.sha256)) return false;
  const { sha256, ...body } = value;
  return digest(body) === sha256;
}
function writePinned(suffix, id, value, db) {
  const record = { ...value, sha256: digest(value) };
  putRecord(kind(suffix), id, record, db); return record;
}
function receipt(id, purpose, objectHash) {
  const record = getRecord(kind('receipt'), id);
  return intact(record) && record.purpose === purpose && record.objectHash === objectHash;
}
function approved(project, id, { current = true, validNow = true } = {}) {
  const control = stateFor(project.id), approval = getRecord(kind('approval'), id);
  if (!intact(approval) || approval.projectId !== project.id || approval.projectRoot !== project.root || approval.revokedAt
      || !receipt(approval.receiptId, 'approval', approval.versionId) || current && control.approvalId !== id) fail('Program scope approval is absent, changed or revoked.', 'PROGRAM_SCOPE_REVOKED');
  const version = getRecord(kind('version'), approval.versionId);
  if (!intact(version) || version.projectId !== project.id || version.projectRoot !== project.root) fail('Program scope version is unavailable.', 'PROGRAM_SCOPE_UNAVAILABLE');
  if (validNow && (version.effectiveAt && Date.parse(version.effectiveAt) > Date.now() || version.expiresAt && Date.parse(version.expiresAt) <= Date.now())) fail('Program scope approval is not currently effective.', 'PROGRAM_SCOPE_EXPIRED');
  return { control, approval, version };
}
function projectSessions(project) {
  return listRecords('session').filter(session => !getRecord('session-deletion', session.id) && (session.projectId === project.id || (session.projectRoot || session.cwd) === project.root));
}
function assertStopped(project) {
  const ids = new Set(projectSessions(project).map(session => session.id));
  for (const session of listRecords('session')) {
    try { if (ids.has(rootFor(session).root.id)) ids.add(session.id); } catch { /* Deleted ancestry cannot execute. */ }
  }
  if ([...ids].some(id => activeStates.includes(getRecord('session', id)?.executionState))
      || listRecords('execution').some(job => ids.has(job.sessionId) && activeStates.includes(job.state))
      || listRecords('run').some(run => ids.has(run.sessionId) && activeStates.includes(run.state) && identityAlive(run.runner))
      || [...ids].some(id => identityAlive(getRecord('session', id)?.backendProcess))) fail('Stop the program sessions and descendants before approving or changing scope.', 'CONFLICT');
}
export const programScopePermissionProfile = 'bzzy_program_core_http_v1';
export const programScopeDisabledFeatures = ['multi_agent', 'multi_agent_v2', 'view_image', 'image_generation', 'apps', 'plugins',
  'remote_plugin', 'hooks', 'skill_search', 'skill_mcp_dependency_install', 'browser_use', 'browser_use_external',
  'browser_use_full_cdp_access', 'computer_use', 'code_mode_host', 'code_mode', 'memories', 'external_agent_memory_import',
  'remote_control', 'mcp_2026_07_28', 'codex_apps_mcp_2026_07_28'];
export const programScopeCapabilities = () => ({ mediatedHttp: true, nativeTargetIsolation: false,
  nativeProfiles: [{ backend: 'codex', id: programScopePermissionProfile, mode: 'core-http-only', requiresRuntimeAcknowledgment: true }],
  limitation: 'Scoped Codex requires an acknowledged profile with native networking, MCP, apps, browsers and hooks disabled. Only Core HTTP requests can reach approved targets; raw sockets, native browsers and other backends are unsupported.' });

export function programScopeStatus(value) {
  const session = sessionFor(value, true), project = projectFor(session), control = stateFor(project.id);
  const binding = session.goal?.id && getRecord(kind('binding'), bindingId(session.id, session.goal.id));
  const approval = control.approvalId && getRecord(kind('approval'), control.approvalId);
  return { projectId: project.id, sessionId: session.id, revision: control.revision, fence: control.fence,
    state: !getRecord(kind('control'), project.id) ? 'legacy-unversioned' : !control.enrolled ? 'proposed' : approval && intact(approval) ? 'approved' : 'unapproved',
    approval: approval && intact(approval) ? approval : null, binding: binding && intact(binding) ? binding : null,
    proposals: listRecords(kind('proposal')).filter(item => item.projectId === project.id && intact(item)).slice(0, 20),
    capabilities: programScopeCapabilities() };
}

export function programScopeCapsule(value) {
  if (!hasScopes()) return { version: 1, enrolled: false, state: 'legacy-unversioned' };
  try {
    const { root } = rootFor(value), project = projectFor(root), control = getRecord(kind('control'), project.id);
    if (!control?.enrolled) return { version: 1, enrolled: false, state: 'legacy-unversioned' };
    const approval = control.approvalId && getRecord(kind('approval'), control.approvalId);
    const version = approval && getRecord(kind('version'), approval.versionId);
    const binding = root.goal?.id && getRecord(kind('binding'), bindingId(root.id, root.goal.id));
    let state = 'unapproved';
    if (approval) { try { approved(project, approval.id); state = 'approved'; } catch (error) { state = error.code === 'PROGRAM_SCOPE_EXPIRED' ? 'not-effective' : 'unavailable'; } }
    return { version: 1, enrolled: true, revision: control.revision, fence: control.fence, state,
      scopeVersion: intact(version) ? version.id : null, bindingId: intact(binding) ? binding.id : null,
      effectiveAt: intact(version) ? version.effectiveAt : null, expiresAt: intact(version) ? version.expiresAt : null,
      sources: intact(version) ? version.sources.slice(0, 3).map(source => ({ reference: source.reference.slice(0, 240), sha256: source.sha256 })) : [],
      omittedSources: intact(version) ? Math.max(0, version.sources.length - 3) : 0,
      capabilities: programScopeCapabilities(), authority: 'Scope status is navigation. Only live Core admission and current runtime policy authorize operations.' };
  } catch { return { version: 1, enrolled: false, state: 'unavailable', authority: 'Unavailable scope status grants no permissions.' }; }
}

function mutation(operation, input, value, action) {
  if (!plain(input) || input.reviewed !== true || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) fail('Review the scope diff and supply its current revision.');
  const session = sessionFor(value, true), project = projectFor(session);
  return reserveRequest(`program-scope:${project.id}`, input.requestId, { operation, sessionId: session.id, input }, db => {
    const live = sessionFor(value, true), current = stateFor(project.id);
    if (current.revision !== input.expectedRevision) fail('Program scope changed. Reload its revision.', 'CONFLICT');
    return action(live, project, current, db);
  });
}
function exact(input, fields) {
  if (!plain(input) || Object.keys(input).some(key => !['reviewed', 'expectedRevision', 'requestId', ...fields].includes(key))) fail('Unknown scope operation fields.');
}
function date(value, name) {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length > 40 || !Number.isFinite(Date.parse(value))) fail(`Invalid ${name}.`);
  return new Date(value).toISOString();
}
function advance(project, current, changes, db) {
  const next = { ...current, ...changes, projectRoot: project.root, revision: current.revision + 1, updatedAt: now() };
  putRecord(kind('control'), project.id, next, db); return next;
}
function inspectProposal(session, project, proposalId) {
  const control = stateFor(project.id), proposal = getRecord(kind('proposal'), proposalId);
  const version = proposal && getRecord(kind('version'), proposal.versionId);
  if (!intact(proposal) || !intact(version) || proposal.projectId !== project.id || version.projectRoot !== project.root) fail('Program scope proposal is unavailable.', 'PROGRAM_SCOPE_UNAVAILABLE');
  const approval = control.approvalId && getRecord(kind('approval'), control.approvalId);
  const prior = intact(approval) && getRecord(kind('version'), approval.versionId);
  const currentVersion = intact(prior) ? prior : null;
  const changes = Object.keys(version.scope).filter(field => digest(version.scope[field]) !== digest(currentVersion?.scope[field] ?? null))
    .map(field => ({ field, before: currentVersion?.scope[field] ?? null, after: version.scope[field] }));
  return { sessionId: session.id, proposal, version, currentVersion, changes, revision: control.revision,
    basedOnCurrentApproval: proposal.previousApprovalId === control.approvalId, startsWork: false, grantsAuthority: false };
}
export function programScopeOperation(operation, input = {}, { session } = {}) {
  if (operation === 'scope.status') { if (Object.keys(input).length) fail('Scope status takes no operation fields.'); return programScopeStatus(session); }
  if (operation === 'scope.inspect') {
    if (!plain(input) || Object.keys(input).some(key => key !== 'proposalId') || typeof input.proposalId !== 'string') fail('Scope inspection needs one proposal ID.');
    const live = sessionFor(session, true); return inspectProposal(live, projectFor(live), input.proposalId);
  }
  if (operation === 'scope.propose') {
    exact(input, ['scope', 'sources', 'effectiveAt', 'expiresAt', 'description']);
    const scope = normalizeProgramScope(input.scope), description = safeText(input.description || 'Program scope revision.', 2000);
    safeText(JSON.stringify(scope), 128 * 1024);
    if (!Array.isArray(input.sources) || !input.sources.length || input.sources.length > 32) fail('Scope proposals require bounded source references.');
    const sources = input.sources.map(source => {
      if (!plain(source) || Object.keys(source).some(key => !['reference', 'sha256'].includes(key)) || !hash(source.sha256)) fail('Each scope source needs a reference and SHA-256.');
      return { reference: safeText(source.reference, 2000), sha256: source.sha256 };
    });
    const effectiveAt = date(input.effectiveAt, 'effectiveAt'), expiresAt = date(input.expiresAt, 'expiresAt');
    if (effectiveAt && expiresAt && Date.parse(expiresAt) <= Date.parse(effectiveAt)) fail('Scope expiration must follow its effective time.');
    return mutation(operation, input, session, (live, project, control, db) => {
      const body = { version: 1, projectId: project.id, projectRoot: project.root, scope, sources, description, effectiveAt, expiresAt };
      const versionId = digest(body);
      if (!getRecord(kind('version'), versionId)) writePinned('version', versionId, { ...body, id: versionId }, db);
      const proposalId = randomUUID();
      const proposal = writePinned('proposal', proposalId, { id: proposalId, projectId: project.id, versionId,
        previousApprovalId: control.approvalId, createdAt: now(), sessionId: live.id }, db);
      const next = advance(project, control, {}, db);
      appendEvent(live.id, 'program.scope.proposed', { proposalId, versionId, revision: next.revision }, db);
      return inspectProposal(live, project, proposal.id);
    });
  }
  if (operation === 'scope.approve') {
    exact(input, ['proposalId']);
    return mutation(operation, input, session, (live, project, control, db) => {
      assertStopped(project);
      const proposal = getRecord(kind('proposal'), input.proposalId), version = proposal && getRecord(kind('version'), proposal.versionId);
      if (!intact(proposal) || !intact(version) || proposal.projectId !== project.id || proposal.previousApprovalId !== control.approvalId) fail('Scope proposal is unavailable or based on an older approval.', 'CONFLICT');
      const id = randomUUID(), receiptId = randomUUID();
      writePinned('receipt', receiptId, { id: receiptId, purpose: 'approval', objectHash: version.id, projectId: project.id, createdAt: now() }, db);
      const approval = writePinned('approval', id, { id, projectId: project.id, projectRoot: project.root, versionId: version.id,
        receiptId, approvedAt: now(), approvedBySession: live.id }, db);
      const next = advance(project, control, { approvalId: id, fence: control.fence + 1, enrolled: true }, db);
      appendEvent(live.id, 'program.scope.approved', { approvalId: id, versionId: version.id, revision: next.revision }, db);
      return { approval, revision: next.revision, startsWork: false };
    });
  }
  if (operation === 'scope.revoke') {
    exact(input, ['approvalId', 'reason']); const reason = safeText(input.reason, 2000);
    return mutation(operation, input, session, (live, project, control, db) => {
      const { approval } = approved(project, input.approvalId, { validNow: false });
      const { sha256, ...body } = approval;
      writePinned('approval', approval.id, { ...body, revokedAt: now(), reason }, db);
      const next = advance(project, control, { approvalId: null, fence: control.fence + 1 }, db);
      const ids = new Set(projectSessions(project).map(value => value.id));
      for (const candidate of listRecords('session')) { try { if (ids.has(rootFor(candidate).root.id)) ids.add(candidate.id); } catch {} }
      for (const id of ids) if (activeStates.includes(getRecord('session', id)?.executionState)) {
        const controlId = randomUUID();
        putRecord('control', controlId, { id: controlId, sessionId: id, action: 'pause', state: 'queued', reason: 'program_scope_revoked', createdAt: now() }, db);
      }
      for (const job of listRecords('execution')) if (ids.has(job.sessionId) && activeStates.includes(job.state)) putRecord('execution', job.id,
        { ...job, stopAction: job.stopAction || 'pause', stopReason: job.stopReason || 'program_scope_revoked', stopRequestedAt: job.stopRequestedAt || now(), stopDeadline: job.stopDeadline || Date.now() + 1500 }, db);
      appendEvent(live.id, 'program.scope.revoked', { approvalId: approval.id, reason, fence: next.fence }, db);
      return { revision: next.revision, fence: next.fence, state: 'revoked', stopsRequested: true, nativeProcessesMayStillBeStopping: true };
    });
  }
  if (operation === 'scope.continue') {
    exact(input, ['approvalId', 'expectedGoalId']);
    return mutation(operation, input, session, (live, project, control, db) => {
      assertStopped(project);
      if (!live.goal || live.goal.id !== input.expectedGoalId) fail('The goal changed. Reload before continuing under a new scope.', 'CONFLICT');
      const { approval, version } = approved(project, input.approvalId), previous = structuredClone(live);
      const oldBinding = getRecord(kind('binding'), bindingId(live.id, live.goal.id));
      if (intact(oldBinding) && oldBinding.approvalId === approval.id) {
        checked(live);
        return { sessionId: live.id, goalId: live.goal.id, revision: control.revision, changed: false, startsWork: false };
      }
      const old = live.goal, used = Math.max(old.tokensUsed || 0, budgetUsage(live));
      if (!Number.isSafeInteger(used) || used < 0) fail('Reconcile uncertain usage before carrying its budget into a scope successor.', 'PROGRAM_SCOPE_USAGE_UNCERTAIN');
      const remaining = old.tokenBudget == null ? null : Math.max(0, old.tokenBudget - used);
      const next = newGoal(old.objective, remaining, { workerBudgetPolicy: old.workerBudgetPolicy });
      Object.assign(next, { status: 'paused', reason: 'scope_transition', predecessorGoalId: old.id,
        budgetCarryover: { previousGoalId: old.id, previousTokenBudget: old.tokenBudget ?? null, previousTokensUsed: used, remainingTokens: remaining } });
      live.goal = next;
      live.contract = normalizeContract({ ...live.contract, scope: { ...version.scope }, policy: version.scope.networkMode === 'offline'
        ? { ...live.contract.policy, network: 'disabled' } : live.contract.policy }, next.objective);
      // Retain the original runtime ceiling and its consumed time; a successor
      // cannot recover a fresh allowance by changing its scope revision.
      next.runtimeUsedSeconds = old.runtimeUsedSeconds || old.timeUsedSeconds || 0;
      live.policy = live.contract.policy; live.strictPolicy = true; live.executionState = 'paused';
      live.acceptance = null; live.summary = null; live.failure = null; live.stopReason = null;
      live.engineTokenOffset = Math.max(live.engineTokenOffset || 0, live.usage?.tokens || 0);
      live.engineThreadId = null; live.engineSessionId = randomUUID(); live.nativeBackendReadiness = null;
      live.conversationHandoff = { pending: true, throughSeq: database().prepare('SELECT coalesce(max(seq),0) AS seq FROM events WHERE session_id=?').get(live.id).seq };
      forkGoalWorkflowBinding(previous, live);
      putRecord('goal-history', old.id, { sessionId: live.id, ...old, contract: previous.contract, supersededAt: now(), supersededBy: next.id }, db);
      live.updatedAt = now(); putRecord('session', live.id, live, db);
      const binding = bind(live, project, approval, version, db);
      recordSessionLifecycle(live, previous, db);
      const updated = advance(project, control, {}, db);
      appendEvent(live.id, 'program.scope.transitioned', { previousGoalId: old.id, goalId: next.id, bindingId: binding.id, versionId: version.id }, db);
      return { sessionId: live.id, goalId: next.id, predecessorGoalId: old.id, binding, revision: updated.revision, changed: true, startsWork: false };
    });
  }
  fail('Unknown program scope operation.');
}

function bind(session, project, approval, version, db = database()) {
  const id = bindingId(session.id, session.goal.id), receiptId = randomUUID();
  const body = { id, version: 1, sessionId: session.id, goalId: session.goal.id, projectId: project.id,
    approvalId: approval.id, scopeVersion: version.id, contractHash: digest(session.contract), policyHash: digest(session.policy || session.contract.policy), receiptId, createdAt: now() };
  writePinned('receipt', receiptId, { id: receiptId, purpose: 'binding', objectHash: digest(body), projectId: project.id, createdAt: now() }, db);
  return writePinned('binding', id, body, db);
}
function checked(value, { allowLegacy = true } = {}) {
  if (!hasScopes()) return null;
  const canonical = sessionFor(value);
  if (isolatedReview(canonical)) return null;
  const { root, child } = rootFor(canonical), project = projectFor(root), control = getRecord(kind('control'), project.id);
  if (!control?.enrolled && allowLegacy) return null;
  if (typeof value === 'object' && (value.goal?.id ?? null) !== (canonical.goal?.id ?? null)) fail('The execution goal changed after this scope was loaded.', 'PROGRAM_SCOPE_CHANGED');
  const binding = root.goal?.id && getRecord(kind('binding'), bindingId(root.id, root.goal.id));
  if (!intact(binding) || !receipt(binding.receiptId, 'binding', binding.sha256)) fail('Continue this goal under an approved program scope first.', 'PROGRAM_SCOPE_ADMISSION_REQUIRED');
  const { approval, version } = approved(project, binding.approvalId);
  if (binding.scopeVersion !== version.id || binding.contractHash !== digest(root.contract) || binding.policyHash !== digest(root.policy || root.contract.policy)) fail('The goal scope binding changed.', 'PROGRAM_SCOPE_CHANGED');
  if (child.id !== root.id && (foreign(child) || foreign(child.missionContext) || child.missionContext?.brief?.programScope?.bindingId !== binding.id)) fail('Worker scope belongs to another goal admission.', 'PROGRAM_SCOPE_CHANGED');
  childPolicy(root.policy || root.contract.policy, child.policy || root.policy);
  return { root, child, project, binding, approval, version, control };
}
export function scopeForMission(session) {
  const value = checked(session);
  return value ? { bindingId: value.binding.id, goalId: value.binding.goalId, scopeVersion: value.version.id, authority: 'Historical mission pin; current host scope checks still apply.' } : null;
}
export function preflightGoalScope(session, { allowNewBinding = false, policy = session.policy, strictPolicy = session.strictPolicy, yolo = false } = {}) {
  if (!hasScopes()) return null;
  const canonical = sessionFor(session);
  if (isolatedReview(canonical)) return null;
  const { root } = rootFor(canonical), project = projectFor(root), control = getRecord(kind('control'), project.id);
  if (!control?.enrolled) return null;
  if (allowNewBinding && session.goal?.id && !foreign(session.goal) && !(session.goal.turns || session.goal.evidence?.length)
      && !getRecord(kind('binding'), bindingId(session.id, session.goal.id))) {
    const { approval, version } = approved(project, control.approvalId);
    if (digest(session.contract?.scope) !== digest(version.scope)) fail('A new goal must retain the reviewed program scope.', 'PROGRAM_SCOPE_CHANGED');
    bind(session, project, approval, version);
  }
  const value = checked(session);
  if (session.backend !== 'codex' || value.version.scope.networkMode === 'offline' && policy?.network !== 'disabled'
      || !strictPolicy || yolo) fail('Program scope requires the verified Codex Core-HTTP-only permission profile without YOLO. Offline scope also requires disabled Core networking.', 'UNSUPPORTED_SCOPE_ENFORCEMENT');
  childPolicy(value.child.policy || value.root.policy, policy || value.child.policy);
  return { version: 1, bindingId: value.binding.id, scopeVersion: value.version.id, approvalId: value.approval.id,
    fingerprint: value.binding.sha256, fence: value.control.fence, nativeProfile: programScopePermissionProfile };
}
export function assertGoalScopeAdmission(session, admission) {
  const value = checked(session);
  if (!value && !admission) return;
  if (!value || !plain(admission) || digest(admission) !== digest(preflightGoalScope(session))) fail('Execution scope changed after queue admission.', 'PROGRAM_SCOPE_CHANGED');
}
export function programScopeCommandPolicy(session) {
  const policy = session.policy || session.contract?.policy;
  return checked(session) ? { ...policy, network: 'disabled' } : policy;
}
export function assertProgramToolAdmission(session, name) {
  if (!checked(session)) return;
  if (['gmail_read', 'interact_extension'].includes(name)) fail('This scoped execution permits external access only through Core http_request. Account and extension gateways require a separate supported scope admission.', 'PROGRAM_SCOPE_DENIED');
}
function matches(url, target) {
  if (/^https?:\/\//.test(target)) {
    const allowed = new URL(target.replace(/\*$/, ''));
    return allowed.origin === url.origin && (allowed.pathname === '/' || url.pathname === allowed.pathname || url.pathname.startsWith(allowed.pathname.replace(/\/$/, '') + '/'));
  }
  return target.startsWith('*.') ? url.hostname.endsWith(target.slice(1).toLowerCase()) : url.hostname === target.toLowerCase();
}
export function assertScopeOperation(session, { url, method = 'GET' } = {}) {
  const value = checked(session); if (!value) return;
  const scope = value.version.scope, target = new URL(url);
  const pathBounded = [...scope.allowedTargets, ...scope.excludedTargets].some(pattern => /^https?:\/\//.test(pattern) && new URL(pattern.replace(/\*$/, '')).pathname !== '/');
  // Encoded separators, characters and matrix parameters have server-specific
  // routing semantics. Do not guess their relationship to a reviewed URL path.
  if (pathBounded && /[%;]/.test(target.pathname)) fail('Path-scoped requests require an unambiguous canonical URL path.', 'PROGRAM_SCOPE_DENIED');
  if (scope.networkMode === 'offline' || !scope.allowedTargets.some(pattern => matches(target, pattern)) || scope.excludedTargets.some(pattern => matches(target, pattern))
      || !scope.allowedActions.includes(method) || scope.excludedActions.includes(method)) fail('This operation is outside the currently approved program scope.', 'PROGRAM_SCOPE_DENIED');
}
