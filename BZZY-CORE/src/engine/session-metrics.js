import { database, transaction, digest } from './database.js';
import { home } from './files.js';

const caches = new Map(), MAX_SESSIONS = 2048, MAX_EVENTS = 2000, MAX_TRACKED = 100000, MAX_ROWS = 4096;
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value);
const libraryId = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,256}$/.test(value);
const safeName = value => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,127}$/i.test(value);
const readOnly = operation => database().isTransaction ? operation() : transaction(operation, { readOnly: true });
const sessionColumns = `id,json_extract(data,'$.parentSessionId') AS parentSessionId,json_extract(data,'$.assignmentId') AS assignmentId,
  json_extract(data,'$.role') AS role,json_extract(data,'$.purpose') AS purpose,json_extract(data,'$.goal.id') AS goalId,
  json_extract(data,'$.goal.status') AS status,substr(json_extract(data,'$.goal.reason'),1,256) AS reason,json_extract(data,'$.goal.createdAt') AS createdAt,
  substr(json_extract(data,'$.goal.objective'),1,2000) AS objective,json_extract(data,'$.reviewSource.sessionId') AS reviewParent,
  json_extract(data,'$.reviewSource.goalId') AS reviewGoalId,updated_at AS updatedAt`;
function sessionRecord(value) { return id(value) ? database().prepare(`SELECT ${sessionColumns} FROM records WHERE kind='session' AND id=?`).get(value) : null; }
function assignment(value) {
  return id(value) ? database().prepare(`SELECT id,json_extract(data,'$.parentSessionId') AS parentSessionId,
    json_extract(data,'$.workerSessionId') AS workerSessionId,json_extract(data,'$.goalId') AS goalId,
    json_extract(data,'$.chatRunId') AS chatRunId FROM records WHERE kind='assignment' AND id=?`).get(value) : null;
}
function peerGoal(parentId, childId) {
  const rows = database().prepare(`SELECT json_extract(data,'$.goalId') AS goalId FROM records
    WHERE (kind IN ('parallel','besties') AND id=? OR kind='coordination-history' AND id>=? AND id<?)
    AND EXISTS(SELECT 1 FROM json_each(json_extract(data,'$.peers')) WHERE json_extract(value,'$.sessionId')=?) LIMIT 3`)
    .all(parentId, `${parentId}:`, `${parentId};`, childId);
  const goals = [...new Set(rows.map(row => row.goalId).filter(id))];
  return goals.length === 1 ? goals[0] : undefined;
}

// Host-only attribution. A saved goal is never substituted for an ordinary chat
// run, and unrelated sessions sharing a directory are never traversed.
export function resolveSessionMetricsScope(value, { goalId, goalMode, stopAt } = {}) {
  return readOnly(() => {
    let current = sessionRecord(typeof value === 'string' ? value : value?.id);
    if (!current) return { rootSessionId: null, rootGoalId: null, attribution: 'unattributed', reason: 'session_unavailable' };
    let selected = goalMode === false ? null : goalId === undefined ? current.goalId : goalId;
    let attribution = selected == null ? 'chat' : id(selected) ? 'goal' : 'unattributed';
    const seen = new Set(); let reason;
    for (let depth = 0; current.parentSessionId && current.id !== stopAt; depth++) {
      if (depth >= 32 || seen.has(current.id)) { attribution = 'unattributed'; reason = 'ancestry_limit'; break; }
      seen.add(current.id);
      const parent = sessionRecord(current.parentSessionId);
      if (!parent) { attribution = 'unattributed'; reason = 'missing_parent'; break; }
      if (current.assignmentId) {
        const job = assignment(current.assignmentId);
        if (!job || job.parentSessionId !== parent.id || job.workerSessionId !== current.id) { attribution = 'unattributed'; reason = 'assignment_scope_unknown'; }
        // Assignment runners are ordinary model turns without their own goal.
        // Their immutable assignment, rather than goalMode:false, owns scope.
        else if (attribution !== 'unattributed') { selected = job.chatRunId ? null : job.goalId; attribution = selected == null ? 'chat' : id(selected) ? 'goal' : 'unattributed'; }
      } else if (current.reviewParent === parent.id) {
        if (attribution === 'goal' && selected === current.goalId) { selected = current.reviewGoalId; attribution = selected == null ? 'chat' : id(selected) ? 'goal' : 'unattributed'; }
        else if (attribution !== 'chat') { attribution = 'unattributed'; reason = 'review_goal_unknown'; }
      } else if (['peer', 'bestie'].includes(current.role)) {
        if (attribution !== 'chat') {
          selected = peerGoal(parent.id, current.id);
          if (!id(selected)) { attribution = 'unattributed'; reason = 'peer_goal_unknown'; }
        }
      } else { attribution = 'unattributed'; reason = 'ancestry_unknown'; }
      current = parent;
    }
    return { rootSessionId: current.id, rootGoalId: attribution === 'goal' ? selected : null, attribution, ...(reason ? { reason } : {}) };
  });
}

function family(root) {
  const sessions = new Map([[root.id, root]]); let frontier = [root.id], bounded = false;
  for (let depth = 0; frontier.length && depth < 32; depth++) {
    const rows = database().prepare(`SELECT ${sessionColumns} FROM records WHERE kind='session'
      AND json_extract(data,'$.parentSessionId') IN (SELECT value FROM json_each(?)) LIMIT ?`).all(JSON.stringify(frontier), MAX_SESSIONS + 1);
    frontier = [];
    for (const row of rows) {
      if (sessions.has(row.id) || !id(row.id) || ['learning-review', 'knowledge-review', 'skill-writer'].includes(row.role) || row.purpose === 'agent' || row.purpose === 'document-draft') continue;
      if (sessions.size >= MAX_SESSIONS) { bounded = true; continue; }
      const parent = sessions.get(row.parentSessionId), job = row.assignmentId && assignment(row.assignmentId);
      if (!(job?.parentSessionId === parent?.id && job.workerSessionId === row.id || row.reviewParent === parent?.id || ['peer', 'bestie'].includes(row.role))) continue;
      sessions.set(row.id, row); frontier.push(row.id);
    }
    if (rows.length > MAX_SESSIONS) bounded = true;
  }
  if (frontier.length) bounded = true;
  return { sessions, bounded };
}

// The diagnostic exporter uses the same explicit worker/review ancestry as
// usage. Sharing a cwd alone never admits another conversation.
export function sessionMetricsFamily(value) {
  return readOnly(() => {
    const root = sessionRecord(typeof value === 'string' ? value : value?.id);
    if (!root) return { sessionIds: [], bounded: false };
    const result = family(root);
    return { sessionIds: [...result.sessions.keys()], bounded: result.bounded };
  });
}
function blank() { return { skillInvocations: 0, subagentInvocations: 0, workerAssignments: 0, subagentFollowups: 0, workerFollowups: 0,
  skillRows: new Map(), agentRows: new Map(), workerRows: new Map(), rowsOmitted: false }; }
function increment(bucket, type, key, metadata, count = 1) {
  bucket[type] += count;
  const field = type === 'skillInvocations' ? 'skillRows' : type.startsWith('subagent') ? 'agentRows' : 'workerRows';
  const rows = bucket[field], previous = rows.get(key);
  const counter = type.endsWith('Followups') ? 'followups' : 'count';
  if (previous) previous[counter] = (previous[counter] || 0) + count;
  else if (rows.size < MAX_ROWS) rows.set(key, { ...metadata, count: counter === 'count' ? count : 0, ...(field !== 'skillRows' ? { followups: counter === 'followups' ? count : 0 } : {}) });
  else bucket.rowsOmitted = true;
}
function shown(bucket) {
  return { skillInvocations: bucket.skillInvocations, subagentInvocations: bucket.subagentInvocations, workerAssignments: bucket.workerAssignments,
    subagentFollowups: bucket.subagentFollowups, workerFollowups: bucket.workerFollowups,
    skillRows: [...bucket.skillRows.values()].map(row => ({ ...row })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    agentRows: [...bucket.agentRows.values()].map(row => ({ ...row })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    workerRows: [...bucket.workerRows.values()].map(row => ({ ...row })).sort((a, b) => b.count - a.count || a.role.localeCompare(b.role)) };
}
function goalRecords(root) {
  const previous = database().prepare(`SELECT id,json_extract(data,'$.status') AS status,substr(json_extract(data,'$.reason'),1,256) AS reason,json_extract(data,'$.createdAt') AS createdAt,
    substr(json_extract(data,'$.objective'),1,2000) AS objective FROM records WHERE kind='goal-history' AND json_extract(data,'$.sessionId')=?
    ORDER BY json_extract(data,'$.createdAt') DESC LIMIT 513`).all(root.id);
  const goals = new Map(previous.filter(row => id(row.id)).slice(0, 512).map(row => [row.id, row]));
  if (id(root.goalId)) goals.set(root.goalId, { id: root.goalId, status: root.status, reason: root.reason, createdAt: root.createdAt, objective: root.objective?.slice(0, 2000) || '' });
  return { goals, bounded: previous.length > 512 };
}

// A rebuildable read projection over host receipts and immutable event IDs. The
// cache only advances a scoped event cursor; it never writes counters or starts
// Core/model work. New family membership rebuilds the projection from that scope.
export function sessionMetrics(value) {
  return readOnly(() => {
    const root = sessionRecord(typeof value === 'string' ? value : value?.id);
    if (!root || database().prepare("SELECT 1 FROM records WHERE kind='session-deletion' AND id=?").get(root.id)) return {
      version: 1, sessionId: typeof value === 'string' ? value : value?.id || null, currentGoalId: null, available: false,
      session: shown(blank()), chat: shown(blank()), unattributed: shown(blank()), goals: [], updatedAt: null,
      coverage: { complete: false, skills: 'recorded-model-loads', legacySkillReads: 0, historicalEvents: 0, reasons: ['session_unavailable'] } };
    const relatives = family(root), ids = [...relatives.sessions.keys()], goals = goalRecords(root);
    const signature = digest([...relatives.sessions.values()].sort((a, b) => a.id.localeCompare(b.id))
      .map(item => [item.id, item.parentSessionId, item.assignmentId, item.reviewParent, item.reviewGoalId]));
    const cacheKey = `${home()}:${root.id}`; let state = caches.get(cacheKey);
    if (!state || state.signature !== signature) {
      state = { signature, after: 0, total: blank(), chat: blank(), unknown: blank(), goals: new Map(), goalsOmitted: false,
        seen: new Set(), legacy: new Map(), legacyUntracked: 0, loaded: new Set(), unknownFollowups: new Set(), historical: 0, updatedAt: null };
      if (caches.size >= 32) caches.delete(caches.keys().next().value);
      caches.set(cacheKey, state);
    }
    const imported = new Map(database().prepare(`SELECT session_id AS id,max(seq) AS seq FROM events WHERE type='project.imported'
      AND session_id IN (SELECT value FROM json_each(?)) GROUP BY session_id`).all(JSON.stringify(ids)).map(row => [row.id, row.seq]));
    const rows = database().prepare(`SELECT e.seq,e.session_id AS sessionId,e.type,e.created_at AS createdAt,
      json_extract(e.data,'$.id') AS id,json_extract(e.data,'$.version') AS version,json_extract(e.data,'$.kind') AS kind,
      json_extract(e.data,'$.runId') AS runId,json_extract(e.data,'$.goalId') AS goalId,
      json_extract(e.data,'$.skillId') AS skillId,json_extract(e.data,'$.name') AS name,json_extract(e.data,'$.skillVersion') AS skillVersion,
      json_extract(e.data,'$.scope') AS scope,json_extract(e.data,'$.file') AS file,json_extract(e.data,'$.offset') AS offset,
      json_extract(e.data,'$.rootSessionId') AS rootSessionId,json_extract(e.data,'$.rootGoalId') AS rootGoalId,json_extract(e.data,'$.attribution') AS attribution,
      json_extract(e.data,'$.usageId') AS usageId,json_extract(e.data,'$.loadedSeq') AS loadedSeq,
      coalesce(json_extract(e.data,'$.subagentDefinition.id'),json_extract(a.data,'$.subagentDefinition.id')) AS agentId,
      coalesce(json_extract(e.data,'$.subagentDefinition.name'),json_extract(a.data,'$.subagentDefinition.name')) AS agentName,
      coalesce(json_extract(e.data,'$.role'),json_extract(a.data,'$.role')) AS role,
      coalesce(json_extract(e.data,'$.chatRunId'),json_extract(a.data,'$.chatRunId')) AS chatRunId,
      json_extract(a.data,'$.goalId') AS assignmentGoalId,json_extract(e.data,'$.round') AS round,
      CASE WHEN r.data=e.data THEN 1 ELSE 0 END AS receipt
      FROM events e LEFT JOIN records r ON e.type='core.usage' AND r.kind='core.usage' AND r.id=json_extract(e.data,'$.id')
      LEFT JOIN records a ON e.type='assignment.followup' AND a.kind='assignment' AND a.id=json_extract(e.data,'$.id')
        AND json_extract(a.data,'$.parentSessionId')=e.session_id
      WHERE e.session_id IN (SELECT value FROM json_each(?)) AND e.seq>? AND e.type IN ('core.usage','skill.loaded','assignment.created','assignment.followup')
      ORDER BY e.seq LIMIT ?`).all(JSON.stringify(ids), state.after, MAX_EVENTS + 1);
    for (const row of rows.slice(0, MAX_EVENTS)) {
      state.after = row.seq; state.updatedAt = row.createdAt;
      if (row.seq <= (imported.get(row.sessionId) || 0)) { state.historical++; continue; }
      if (row.type === 'skill.loaded') {
        if (row.file === 'SKILL.md' && (row.offset || 0) === 0) {
          if (!row.usageId) state.legacyUntracked++;
          else if (!state.loaded.has(row.usageId) && state.legacy.size < MAX_TRACKED) state.legacy.set(row.seq, row.usageId);
        }
        continue;
      }
      let type, key, metadata;
      if (row.type === 'core.usage') {
        if (row.version !== 1 || row.kind !== 'skill' || !row.receipt || !id(row.id) || !id(row.runId) || !libraryId(row.skillId) || !safeName(row.name) || !/^[a-f0-9]{64}$/.test(row.skillVersion || '')) continue;
        type = 'skillInvocations'; key = `${row.skillId}:${row.skillVersion}`; metadata = { id: row.skillId, name: row.name, version: row.skillVersion, scope: row.scope };
      } else {
        if (!id(row.id)) continue;
        if (row.type === 'assignment.followup' && (!Number.isSafeInteger(row.round) || row.round < 2 || !row.role)) {
          if (state.unknownFollowups.size < MAX_TRACKED) state.unknownFollowups.add(`${row.id}:${row.round}`);
          continue;
        }
        const named = libraryId(row.agentId) && safeName(row.agentName);
        type = row.type === 'assignment.followup' ? named ? 'subagentFollowups' : 'workerFollowups' : named ? 'subagentInvocations' : 'workerAssignments';
        const role = ['executor', 'reviewer', 'peer', 'bestie'].includes(row.role) ? row.role : 'worker';
        key = named ? row.agentId : role;
        metadata = named ? { id: row.agentId, name: row.agentName } : { role };
      }
      const eventKey = `${row.type}:${row.id}${row.type === 'assignment.followup' ? ':' + row.round : ''}`;
      if (state.seen.has(eventKey) || state.seen.size >= MAX_TRACKED) continue;
      state.seen.add(eventKey);
      if (row.type === 'core.usage') {
        state.loaded.add(row.id);
        for (const [seq, usageId] of state.legacy) if (usageId === row.id || seq === row.loadedSeq) state.legacy.delete(seq);
      }
      const stamped = row.type === 'core.usage' && row.rootSessionId === root.id && ['goal', 'chat', 'unattributed'].includes(row.attribution) &&
        (row.attribution !== 'goal' || id(row.rootGoalId));
      const localGoalId = row.type === 'assignment.followup' ? row.assignmentGoalId : row.goalId;
      const scope = stamped ? row : resolveSessionMetricsScope(row.sessionId, { goalId: row.chatRunId ? null : localGoalId,
        goalMode: row.chatRunId ? false : localGoalId != null, stopAt: root.id });
      increment(state.total, type, key, metadata);
      if (scope.rootSessionId !== root.id || scope.attribution === 'unattributed') increment(state.unknown, type, key, metadata);
      else if (scope.attribution === 'chat') increment(state.chat, type, key, metadata);
      else {
        if (!state.goals.has(scope.rootGoalId)) {
          if (state.goals.size >= 512) { state.goals.delete(state.goals.keys().next().value); state.goalsOmitted = true; }
          state.goals.set(scope.rootGoalId, blank());
        }
        increment(state.goals.get(scope.rootGoalId), type, key, metadata);
      }
    }
    const legacySkillReads = state.legacyUntracked + state.legacy.size;
    const reasons = [...(relatives.bounded ? ['session_limit'] : []), ...(goals.bounded || state.goalsOmitted ? ['goal_limit'] : []), ...(rows.length > MAX_EVENTS ? ['event_backfill_pending'] : []),
      ...(state.seen.size >= MAX_TRACKED || state.legacy.size >= MAX_TRACKED || state.unknownFollowups.size >= MAX_TRACKED ? ['invocation_limit'] : []), ...(legacySkillReads ? ['legacy_skill_loads'] : []), ...(state.historical ? ['imported_history'] : []),
      ...(state.total.rowsOmitted ? ['row_limit'] : []),
      ...(state.unknownFollowups.size ? ['followup_attribution_unavailable'] : []),
      ...(state.unknown.skillInvocations || state.unknown.subagentInvocations || state.unknown.workerAssignments || state.unknown.subagentFollowups || state.unknown.workerFollowups ? ['unknown_goal_attribution'] : [])];
    for (const goalId of state.goals.keys()) if (!goals.goals.has(goalId)) goals.goals.set(goalId, { id: goalId, status: 'unknown', createdAt: null, objective: '' });
    return { version: 1, sessionId: root.id, currentGoalId: root.goalId || null, available: true,
      session: shown(state.total), chat: shown(state.chat), unattributed: shown(state.unknown),
      goals: [...goals.goals.values()].sort((a, b) => Number(b.id === root.goalId) - Number(a.id === root.goalId) || (b.createdAt || '').localeCompare(a.createdAt || '')).slice(0, 512)
        .map(goal => ({ ...goal, ...shown(state.goals.get(goal.id) || blank()) })),
      updatedAt: state.updatedAt, coverage: { skills: 'recorded-model-loads', complete: reasons.length === 0, legacySkillReads,
        historicalEvents: state.historical, unattributedFollowups: state.unknownFollowups.size, reasons } };
  });
}
