import { database, getRecord, putRecord, appendEvent, digest, now, transaction } from './database.js';
import { goalRoutingContract } from './workflows.js';
import { getSubagentDefinition } from './subagent-definitions.js';
import { listSkills } from './skills.js';
import { sanitizeMissionValue } from './mission-context.js';
import path from 'node:path';
import { home, readJson } from './files.js';

const UNIT = 'core.workflow.work-unit', READ = 'core.workflow.consultation';
const fail = (message, code = 'WORKFLOW_ROUTING_INCOMPLETE') => { throw Object.assign(new Error(message), { code }); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exact = (value, keys) => plain(value) && Object.keys(value).every(key => keys.includes(key));
const text = (value, maximum, label) => {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > maximum || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/u.test(value) || sanitizeMissionValue(value) !== value) fail(`Invalid ${label}.`, 'INVALID_REQUEST');
  return value.trim();
};
const evidenceIds = value => {
  if (!Array.isArray(value || []) || (value || []).length > 32 || (value || []).some(id => typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id))) fail('Work-unit evidence must contain at most 32 recorded artifact IDs.', 'INVALID_REQUEST');
  return [...new Set(value || [])];
};
function live(session, context) {
  const saved = session?.id && getRecord('session', session.id), run = saved && getRecord('run', saved.id);
  if (!context?.goalMode || !saved || getRecord('session-deletion', saved.id) || session.goal?.id !== saved.goal?.id || saved.goal?.status !== 'active' ||
      !context.runId || run?.id !== context.runId || run.state !== 'running' || !['running', 'waiting_for_input'].includes(saved.executionState)) fail('Routing changes require the current live goal execution.', 'WORKFLOW_ROUTING_STOPPED');
  if (readJson(path.join(home(), 'runtime', 'operator-stop.json'), null)?.stopped === true || database().prepare("SELECT 1 FROM records WHERE kind='execution' AND json_extract(data,'$.sessionId')=? AND json_extract(data,'$.state') IN ('queued','launching','running') AND json_extract(data,'$.stopAction') IN ('pause','cancel') LIMIT 1").get(saved.id)) fail('The owner has durably stopped this execution; routing cannot resume or close work.', 'WORKFLOW_ROUTING_STOPPED');
  const contract = goalRoutingContract(saved);
  if (!contract) fail('This goal has no structured routing contract.', 'WORKFLOW_ROUTING_UNAVAILABLE');
  return { saved, contract };
}
function rows(session, maximum = 257) {
  return database().prepare("SELECT data FROM records WHERE kind=? AND json_extract(data,'$.sessionId')=? AND json_extract(data,'$.goalId')=? ORDER BY updated_at,id LIMIT ?")
    .all(UNIT, session.id, session.goal?.id || '', maximum).map(row => JSON.parse(row.data));
}
function currentUnit(session, id, contract) {
  const unit = typeof id === 'string' && getRecord(UNIT, id);
  if (!unit || unit.version !== 1 || unit.sessionId !== session.id || unit.goalId !== session.goal?.id || unit.workflowVersion !== contract.workflowVersion || unit.bindingId !== contract.bindingId ||
      unit.id !== digest([session.id, session.goal.id, unit.requestId])) fail('Work unit belongs to another goal or workflow.', 'WORKFLOW_ROUTING_SCOPE');
  const rule = contract.routing.rules.find(value => value.classId === unit.classId);
  const requirements = value => ({ specialist: value.specialist?.name || null, skills: value.skills?.map(pin => pin.name),
    reportSkills: value.reportSkills?.map(pin => pin.name), allowedDispositions: value.allowedDispositions });
  if (!rule || digest(requirements(unit)) !== digest({ specialist: rule.specialist || null, skills: rule.skills,
    reportSkills: rule.reportSkills, allowedDispositions: rule.allowedDispositions })) fail('Work-unit requirements differ from the original pinned workflow.', 'WORKFLOW_ROUTING_SCOPE');
  return unit;
}
function checkedEvidence(session, ids) {
  for (const id of ids) {
    const artifact = getRecord('artifact', id);
    // Bounded evidence passed to a unit must already belong to this goal's
    // session or one of its assignments; a reference never expands visibility.
    const owner = artifact?.sessionId && getRecord('session', artifact.sessionId);
    const assignment = (artifact?.assignmentId || owner?.assignmentId) && getRecord('assignment', artifact.assignmentId || owner.assignmentId);
    if (!artifact || artifact.sessionId !== session.id && !(assignment?.parentSessionId === session.id && assignment.goalId === session.goal?.id)) fail('Work-unit evidence is unavailable in this goal.', 'WORKFLOW_ROUTING_SCOPE');
  }
}
function skillPins(session, names) {
  const enabled = [];
  for (let offset = 0; offset !== null && enabled.length <= 1024;) {
    const page = listSkills({ session, enabledOnly: true, offset, limit: 100 }); enabled.push(...page.skills); offset = page.nextOffset;
  }
  return names.map(name => {
    const value = enabled.find(skill => skill.name === name);
    return value ? { name, id: value.id, version: value.version, available: true } : { name, available: false, reason: 'missing-or-disabled' };
  });
}
const publicUnit = unit => ({ id: unit.id, workUnitId: unit.id, requestId: unit.requestId, classId: unit.classId, hypothesis: unit.hypothesis,
  state: unit.state, outcome: unit.outcome || null, specialist: unit.specialist, skills: unit.skills, reportSkills: unit.reportSkills,
  allowedDispositions: unit.allowedDispositions, ...(unit.assignmentId ? { assignmentId: unit.assignmentId } : {}),
  ...(unit.supersedes ? { supersedes: unit.supersedes } : {}), ...(unit.supersededBy ? { supersededBy: unit.supersededBy } : {}),
  ...(unit.rationale ? { rationale: unit.rationale } : {}), evidence: unit.evidence, workflowVersion: unit.workflowVersion });

export function declareWorkUnit(session, input, context) {
  const { saved, contract } = live(session, context);
  if (!exact(input, ['requestId', 'classId', 'hypothesis', 'evidence', 'supersedes'])) fail('Invalid work-unit fields.', 'INVALID_REQUEST');
  const requestId = text(input.requestId, 128, 'work-unit request ID'), hypothesis = text(input.hypothesis, 4096, 'work-unit hypothesis');
  if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(requestId)) fail('Invalid work-unit request ID.', 'INVALID_REQUEST');
  const rule = contract.routing.rules.find(value => value.classId === input.classId);
  if (!rule) fail('Choose a classId from the pinned routing contract; an unrecognized class cannot satisfy it.', 'WORKFLOW_ROUTING_CLASS');
  const evidence = evidenceIds(input.evidence); checkedEvidence(saved, evidence);
  const id = digest([saved.id, saved.goal.id, requestId]), inputSha256 = digest({ classId: rule.classId, hypothesis, evidence, supersedes: input.supersedes || null });
  return transaction(db => {
    live(session, context);
    const previous = getRecord(UNIT, id);
    if (previous) {
      if (previous.inputSha256 !== inputSha256) fail('Work-unit request ID was used for different input.', 'CONFLICT');
      return publicUnit(currentUnit(saved, id, contract));
    }
    if (rows(saved).length >= 256) fail('This goal has reached its bounded 256 work-unit limit.', 'CAPACITY');
    const superseded = input.supersedes && currentUnit(saved, input.supersedes, contract);
    if (superseded && (superseded.classId !== rule.classId || superseded.state !== 'closed' || superseded.outcome !== 'blocked' || superseded.supersededBy)) fail('Only an unresolved blocked unit of the same current-goal class may be explicitly superseded.');
    let specialist = null;
    if (rule.specialist) {
      try { const value = getSubagentDefinition(rule.specialist, { cwd: saved.projectRoot || saved.cwd, enabledOnly: true });
        specialist = { name: value.name, id: value.id, version: value.version, available: true };
      } catch { specialist = { name: rule.specialist, available: false, reason: 'missing-or-disabled' }; }
    }
    const unit = { version: 1, id, sessionId: saved.id, goalId: saved.goal.id, workflowVersion: contract.workflowVersion,
      bindingId: contract.bindingId, requestId, inputSha256, classId: rule.classId, hypothesis, evidence, specialist,
      skills: skillPins(saved, rule.skills), reportSkills: skillPins(saved, rule.reportSkills), allowedDispositions: rule.allowedDispositions,
      ...(superseded ? { supersedes: superseded.id } : {}),
      state: 'open', admittedRunId: context.runId, createdAt: now() };
    putRecord(UNIT, id, unit, db); appendEvent(saved.id, 'workflow.routing.declared', publicUnit(unit), db);
    if (superseded) putRecord(UNIT, superseded.id, { ...superseded, supersededBy: id }, db);
    return publicUnit(unit);
  });
}

// Read receipts are separate from invocation metrics and never assert attention
// or adherence. Full SKILL.md byte coverage is required for consultation gates.
export function recordRoutingSkillRead(session, skill, input, context) {
  let current; try { current = live(session, context); } catch { return null; }
  if (skill?.file !== 'SKILL.md' || !skill.text || !skill.id || !skill.version) return null;
  const offset = input?.offset || 0, bytes = Buffer.byteLength(skill.text), file = skill.files?.find(value => value.path === 'SKILL.md');
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(file?.bytes) || offset + bytes > file.bytes) return null;
  const id = digest([session.id, session.goal.id, 'skill', skill.id, skill.version]);
  return transaction(db => {
    live(session, context);
    const previous = getRecord(READ, id), ranges = [...(previous?.ranges || []), [offset, offset + bytes]].sort((a, b) => a[0] - b[0]), merged = [];
    for (const range of ranges) { const last = merged.at(-1); if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]); else merged.push([...range]); }
    if (merged.length > 128) return null;
    const receipt = { id, version: 1, kind: 'skill', sessionId: session.id, goalId: session.goal.id, workflowVersion: current.contract.workflowVersion,
      resourceId: skill.id, resourceVersion: skill.version, name: skill.name, ranges: merged, bytes: file.bytes,
      complete: merged.length === 1 && merged[0][0] === 0 && merged[0][1] === file.bytes, lastRunId: context.runId, updatedAt: now() };
    putRecord(READ, id, receipt, db);
    if (receipt.complete && !previous?.complete) appendEvent(session.id, 'workflow.routing.consulted', { ...receipt, ranges: undefined }, db);
    return receipt;
  });
}
export function recordRoutingSpecialistRead(session, definition, context) {
  let current; try { current = live(session, context); } catch { return null; }
  if (!definition?.id || !definition.version || !definition.instructions) return null;
  const id = digest([session.id, session.goal.id, 'specialist', definition.id, definition.version]);
  const receipt = { id, version: 1, kind: 'specialist', sessionId: session.id, goalId: session.goal.id,
    workflowVersion: current.contract.workflowVersion, resourceId: definition.id, resourceVersion: definition.version,
    name: definition.name, complete: true, lastRunId: context.runId, updatedAt: now() };
  if (!getRecord(READ, id)) transaction(db => { live(session, context); putRecord(READ, id, receipt, db); appendEvent(session.id, 'workflow.routing.consulted', receipt, db); });
  return receipt;
}
function consultation(session, kind, pin, workflowVersion) {
  if (!pin?.available) return false;
  const receipt = getRecord(READ, digest([session.id, session.goal.id, kind, pin.id, pin.version]));
  return Boolean(receipt?.complete && receipt.workflowVersion === workflowVersion);
}
export function assertRoutingSpawn(session, input, context, definition) {
  const contract = goalRoutingContract(session);
  if (!contract || !context.goalMode) return null;
  const { saved } = live(session, context), unit = currentUnit(saved, input.workUnitId, contract);
  if (unit.state !== 'open' || !unit.specialist?.available || unit.specialist.id !== definition.id || unit.specialist.version !== definition.version) fail('The open work unit requires its exact admitted enabled specialist. Declare a new unit if its Library version changed.');
  if (!consultation(saved, 'specialist', unit.specialist, contract.workflowVersion)) fail('Read the admitted specialist with read_subagent before assigning it.');
  return { version: 1, workUnitId: unit.id, sessionId: saved.id, goalId: saved.goal.id, workflowVersion: contract.workflowVersion, runId: context.runId };
}
export function reserveRoutingAssignment(session, routing, assignmentId, db = database()) {
  if (!routing) return;
  const { saved, contract } = live(session, { goalMode: true, runId: routing.runId }), unit = currentUnit(saved, routing.workUnitId, contract);
  if (unit.state !== 'open' || unit.assignmentId && unit.assignmentId !== assignmentId) fail('This work unit already has an assignment. Follow up its pinned worker or declare a distinct hypothesis.');
  putRecord(UNIT, unit.id, { ...unit, assignmentId }, db);
  appendEvent(session.id, 'workflow.routing.assigned', { goalId: unit.goalId, workUnitId: unit.id, assignmentId,
    workflowVersion: unit.workflowVersion, specialist: unit.specialist }, db);
}
export function assertRoutingFollowup(parent, job) {
  if (!job.subagentRouting) return;
  const { saved, contract } = live(parent, { goalMode: true, runId: getRecord('run', parent.id)?.id });
  const unit = currentUnit(saved, job.subagentRouting.workUnitId, contract);
  if (unit.state !== 'open' || unit.assignmentId !== job.id || unit.workflowVersion !== job.subagentRouting.workflowVersion) fail('A closed or superseded work unit cannot restart its specialist. Declare an explicit replacement for a blocked investigation.');
}
export function recordRoutingReview(parent, job, review, db = database()) {
  if (!job.subagentRouting) return;
  if (getRecord('session-deletion', parent.id)) fail('Deleted sessions cannot publish routing review receipts.', 'SESSION_DELETED');
  appendEvent(parent.id, 'workflow.routing.reviewed', { goalId: job.goalId, workUnitId: job.subagentRouting.workUnitId,
    assignmentId: job.id, round: review.round, outcome: review.outcome, reviewId: review.id,
    workflowVersion: job.subagentRouting.workflowVersion }, db);
}
function missingFor(session, unit, outcome, assignmentId) {
  const missing = [];
  if (unit.specialist) {
    const job = assignmentId && getRecord('assignment', assignmentId);
    if (!consultation(session, 'specialist', unit.specialist, unit.workflowVersion)) missing.push(`read_subagent:${unit.specialist.name}`);
    if (!job || job.parentSessionId !== session.id || job.goalId !== unit.goalId || job.subagentRouting?.workUnitId !== unit.id ||
        job.subagentRouting?.workflowVersion !== unit.workflowVersion || job.subagentDefinition?.id !== unit.specialist.id || job.subagentDefinition?.version !== unit.specialist.version) missing.push(`matching-specialist:${unit.specialist.name}`);
    else if (job.closure !== 'accepted' || job.review?.outcome !== 'accepted' || job.review.round !== job.currentRound || !job.review.inspectedEvidence?.length) missing.push('accepted-evidence-reviewed-assignment');
  }
  for (const pin of [...unit.skills, ...(outcome === 'confirmed' ? unit.reportSkills : [])]) if (!consultation(session, 'skill', pin, unit.workflowVersion)) missing.push(`read_skill:${pin.name}`);
  return missing;
}
export function closeWorkUnit(session, input, context) {
  const { saved, contract } = live(session, context);
  if (!exact(input, ['id', 'outcome', 'rationale', 'evidence', 'assignmentId']) || !['investigated', 'confirmed', 'disproved', 'inconclusive', 'not_applicable', 'policy_excluded', 'blocked'].includes(input.outcome)) fail('Invalid work-unit closure fields.', 'INVALID_REQUEST');
  const rationale = text(input.rationale, 4096, 'work-unit rationale'), evidence = evidenceIds(input.evidence); checkedEvidence(saved, evidence);
  const unit = currentUnit(saved, input.id, contract), closure = { outcome: input.outcome, rationale, evidence, assignmentId: input.assignmentId || null };
  if (unit.state === 'closed') {
    if (unit.closureSha256 !== digest(closure)) fail('Work unit is already closed with a different disposition.', 'CONFLICT');
    return publicUnit(unit);
  }
  const assigned = unit.assignmentId && getRecord('assignment', unit.assignmentId), assignedRound = assigned && getRecord('round', `${assigned.id}:${assigned.currentRound}`);
  if (['starting', 'running'].includes(assignedRound?.state)) fail('Finish or stop the assigned specialist before closing its work unit.');
  const disposition = ['not_applicable', 'policy_excluded', 'blocked'].includes(input.outcome);
  if (disposition && !unit.allowedDispositions.includes(input.outcome)) fail('The pinned workflow does not permit that consultation disposition.');
  if (!disposition) {
    const missing = missingFor(saved, unit, input.outcome, input.assignmentId);
    if (missing.length) fail(`Work-unit consultation is incomplete: ${missing.join(', ')}.`);
  }
  const record = { ...unit, ...closure, state: 'closed', closureSha256: digest(closure), closedAt: now(), closedRunId: context.runId };
  return transaction(db => {
    live(session, context); const latest = currentUnit(saved, unit.id, contract);
    if (latest.state === 'closed') {
      if (latest.closureSha256 !== record.closureSha256) fail('Work unit was concurrently closed with a different disposition.', 'CONFLICT');
      return publicUnit(latest);
    }
    putRecord(UNIT, unit.id, record, db); appendEvent(saved.id, 'workflow.routing.closed', publicUnit(record), db); return publicUnit(record);
  });
}

export function routingStatus(session, { limit = 20 } = {}) {
  if (session?.id && getRecord('session-deletion', session.id)) return { enforced: true, goalId: session.goal?.id || null,
    state: 'unavailable', reason: 'SESSION_DELETED', unmet: 1, total: 0, open: 0, closed: 0, blocked: 0, covered: 0, units: [] };
  let contract; try { contract = goalRoutingContract(session); }
  catch (error) { return { enforced: true, goalId: session.goal?.id || null, state: 'unavailable', reason: error.code || 'WORKFLOW_PIN_INVALID', unmet: 1, total: 0, open: 0, closed: 0, blocked: 0, units: [] }; }
  if (!contract) return { enforced: false, goalId: session?.goal?.id || null, reason: 'legacy-or-no-routing-contract' };
  const all = rows(session), open = all.filter(unit => unit.state !== 'closed'), blocked = all.filter(unit => unit.outcome === 'blocked' && !unit.supersededBy);
  const priority = unit => unit.state !== 'closed' ? 0 : unit.outcome === 'blocked' && !unit.supersededBy ? 1 : 2;
  const units = [...all].sort((a, b) => priority(a) - priority(b)).slice(0, Math.max(0, Math.min(256, limit))).map(unit => ({ id: unit.id, classId: unit.classId, state: unit.state,
    outcome: unit.outcome || null, specialist: unit.specialist?.name || null, assignmentId: unit.assignmentId || null,
    missing: unit.state === 'closed' ? [] : missingFor(session, unit, null, unit.assignmentId) }));
  return { enforced: true, goalId: session.goal.id, workflowVersion: contract.workflowVersion, state: open.length || !all.length ? 'incomplete' : 'closed',
    total: all.length, open: open.length, closed: all.length - open.length, blocked: blocked.length,
    covered: all.filter(unit => unit.state === 'closed' && ['investigated', 'confirmed', 'disproved', 'inconclusive'].includes(unit.outcome)).length,
    excluded: all.filter(unit => ['not_applicable', 'policy_excluded'].includes(unit.outcome)).length,
    unmet: open.length + blocked.length + (!all.length ? 1 : 0),
    units, nextOffset: all.length > units.length ? units.length : null };
}
export function assertRoutingCompletion(session) {
  const status = routingStatus(session, { limit: 0 });
  if (status.enforced && (status.unmet || status.state === 'unavailable')) fail('The pinned workflow requires declared, closed work units and their matching consultation receipts. Inspect get_task_state routing; resolve open units or record only workflow-permitted dispositions.');
  if (status.enforced) {
    const contract = goalRoutingContract(session);
    for (const candidate of rows(session)) {
      const unit = currentUnit(session, candidate.id, contract);
      if (!['not_applicable', 'policy_excluded', 'blocked'].includes(unit.outcome) && missingFor(session, unit, unit.outcome, unit.assignmentId).length) fail('A closed work unit no longer has its required current-goal consultation and reviewed assignment.');
    }
  }
  return status;
}
export function routingToolSpecs(session) {
  if (!goalRoutingContract(session)) return [];
  const strings = { type: 'array', items: { type: 'string' }, maxItems: 32 };
  const spec = (name, description, properties, required) => ({ name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } });
  return [spec('declare_work_unit', 'Before an eligible class investigation, declare its bounded hypothesis under the pinned routing contract. Returns exact specialist/skill version pins and availability. Stable requestId makes retries idempotent; no worker is started and no permission is granted.',
    { requestId: { type: 'string', maxLength: 128 }, classId: { type: 'string', maxLength: 64 }, hypothesis: { type: 'string', maxLength: 4096 }, evidence: strings,
      supersedes: { type: 'string', description: 'Explicit same-class blocked unit to replace with a new pinned investigation; old history remains retained.' } }, ['requestId', 'classId', 'hypothesis']),
  spec('close_work_unit', 'Close a declared hypothesis with evidence and a factual rationale. Investigated/confirmed/disproved/inconclusive require the pinned specialist accepted after supervisor evidence review and required full skill reads. Only the pinned workflow may permit blocked/not_applicable/policy_excluded dispositions. CONFIRMED also requires reporting skills; this is not verification of vulnerability truth.',
    { id: { type: 'string' }, outcome: { type: 'string', enum: ['investigated', 'confirmed', 'disproved', 'inconclusive', 'not_applicable', 'policy_excluded', 'blocked'] }, rationale: { type: 'string', maxLength: 4096 }, evidence: strings, assignmentId: { type: 'string' } }, ['id', 'outcome', 'rationale'])];
}
