import { database, transaction, digest } from './database.js';
import { getGoalTemplate, goalTemplateEntry } from './goal-templates.js';

// Private local-owner history projection. This module grants no runtime access
// and is deliberately not exposed as a model tool or a scoped session endpoint.
const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const selectionID = new RegExp(`^(${UUID}):(${UUID})$`);
// Match String.prototype.trim(), preserving every internal space and newline.
const whitespace = '\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
const fail = (message, code = 'INVALID_REQUEST', status = 400) => { throw Object.assign(new Error(message), { code, status }); };
const read = operation => database().isTransaction ? operation(database()) : transaction(operation, { readOnly: true });

// Work in SQL so paging does not materialize the host's complete private goal
// history in the CLI. The count and page are read from one coherent snapshot.
const sources = `WITH terminals AS (
  SELECT s.id AS sessionId, s.data,
    json_extract(s.data,'$.cwd') AS cwd, json_extract(s.data,'$.alias') AS alias
  FROM records s WHERE s.kind='session'
    AND coalesce(json_extract(s.data,'$.parentSessionId'),'')=''
    AND coalesce(json_extract(s.data,'$.parallelSessionId'),'')=''
    AND coalesce(json_extract(s.data,'$.canvasParentId'),'')=''
    AND coalesce(json_extract(s.data,'$.assignmentId'),'')=''
    AND coalesce(json_extract(s.data,'$.role'),'')=''
    AND coalesce(json_extract(s.data,'$.purpose'),'') IN ('','terminal')
    AND coalesce(json_extract(s.data,'$.importedUntrusted'),0)=0
    AND json_extract(s.data,'$.deletedAt') IS NULL
    AND NOT EXISTS (SELECT 1 FROM records d WHERE d.kind='session-deletion' AND d.id=s.id)
    AND NOT EXISTS (SELECT 1 FROM records a WHERE a.kind='core.agent' AND json_extract(a.data,'$.sessionId')=s.id)
), candidates AS (
  SELECT t.sessionId,t.cwd,t.alias,json_extract(t.data,'$.goal.id') AS goalId,
    json_extract(t.data,'$.goal.objective') AS rawObjective,
    json_extract(t.data,'$.goal.createdAt') AS createdAt,
    json_extract(t.data,'$.goal.status') AS status,1 AS priority
  FROM terminals t
  UNION ALL
  SELECT t.sessionId,t.cwd,t.alias,g.id AS goalId,
    json_extract(g.data,'$.objective') AS rawObjective,
    json_extract(g.data,'$.createdAt') AS createdAt,
    json_extract(g.data,'$.status') AS status,0 AS priority
  FROM records g JOIN terminals t ON json_extract(g.data,'$.sessionId')=t.sessionId
  WHERE g.kind='goal-history' AND json_extract(g.data,'$.id')=g.id
    AND json_extract(t.data,'$.goal.id') IS NOT g.id
), valid AS (
  SELECT *,trim(rawObjective,?) AS objective,julianday(createdAt) AS createdTime
  FROM candidates WHERE typeof(rawObjective)='text' AND typeof(createdAt)='text'
    AND julianday(createdAt) IS NOT NULL AND typeof(cwd)='text' AND length(cwd)>0
    AND length(sessionId)=36 AND length(replace(sessionId,'-',''))=32 AND sessionId NOT GLOB '*[^a-f0-9-]*'
    AND substr(sessionId,9,1)='-' AND substr(sessionId,14,1)='-'
    AND substr(sessionId,19,1)='-' AND substr(sessionId,24,1)='-'
    AND length(goalId)=36 AND length(replace(goalId,'-',''))=32 AND goalId NOT GLOB '*[^a-f0-9-]*'
    AND substr(goalId,9,1)='-' AND substr(goalId,14,1)='-'
    AND substr(goalId,19,1)='-' AND substr(goalId,24,1)='-'
), source_versions AS (
  SELECT *,row_number() OVER (PARTITION BY sessionId,goalId ORDER BY priority DESC) AS sourceVersion
  FROM valid WHERE length(objective)>0
), source_goals AS (
  SELECT * FROM source_versions WHERE sourceVersion=1
)`;
const columns = 'sessionId,cwd,alias,goalId,objective,createdAt,status';
const reusable = `${sources}, reusable_goals AS (
  SELECT sessionId,cwd,alias,goalId,objective,createdAt,status,createdTime,NULL AS templateId FROM source_goals
  UNION ALL
  SELECT NULL,NULL,'Imported goal',NULL,json_extract(t.data,'$.objective'),json_extract(t.data,'$.createdAt'),NULL,
    julianday(json_extract(t.data,'$.createdAt')),t.id
  FROM records t WHERE t.kind='core.goal.template' AND json_extract(t.data,'$.id')=t.id
    AND json_extract(t.data,'$.version')=t.id AND json_extract(t.data,'$.deletedAt') IS NULL
    AND typeof(json_extract(t.data,'$.objective'))='text' AND length(json_extract(t.data,'$.objective'))>0
    AND julianday(json_extract(t.data,'$.createdAt')) IS NOT NULL
)`;
const order = "createdTime DESC,coalesce(sessionId,'') COLLATE BINARY,coalesce(goalId,templateId) COLLATE BINARY";
const library = `${reusable}, library AS (
  SELECT *,row_number() OVER (PARTITION BY objective COLLATE BINARY ORDER BY ${order}) AS occurrence
  FROM reusable_goals
)`;

function entry(row) {
  if (row.templateId) return goalTemplateEntry(getGoalTemplate(row.templateId));
  const { sessionId, goalId, objective, createdAt, cwd } = row;
  const alias = typeof row.alias === 'string' && row.alias.trim() ? row.alias.trim() : null;
  return { id: `${sessionId}:${goalId}`, revision: digest({ sessionId, goalId, objective, createdAt, cwd, alias }),
    goalId, sessionId, cwd, alias, createdAt, objective, status: typeof row.status === 'string' ? row.status : null };
}

export function listSavedGoals(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['offset', 'limit'].includes(key))) {
    fail('Choose a saved-goal page using only offset and limit.');
  }
  const { offset = 0, limit = 20 } = options;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    fail('Saved-goal offset must be nonnegative and limit must be 1–100.');
  }
  return read(db => {
    const { total } = db.prepare(`${library} SELECT count(*) AS total FROM library WHERE occurrence=1`).get(whitespace);
    const goals = db.prepare(`${library} SELECT ${columns},templateId FROM library WHERE occurrence=1 ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(whitespace, limit, offset).map(entry);
    return { goals, total, nextOffset: offset + goals.length < total ? offset + goals.length : null };
  });
}

// Resolve the exact displayed source, even if a newer duplicate was submitted
// elsewhere while the picker was open. A deleted source never falls back to it.
export function getSavedGoal(id, options = {}) {
  const match = typeof id === 'string' && selectionID.exec(id);
  const template = typeof id === 'string' && /^template:([a-f0-9]{64})$/.exec(id);
  if ((!match && !template) || !options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => key !== 'revision') ||
      options.revision !== undefined && (typeof options.revision !== 'string' || !/^[a-f0-9]{64}$/.test(options.revision))) {
    fail('Choose a saved goal from the current list.');
  }
  return read(db => {
    if (template) {
      const goal = goalTemplateEntry(getGoalTemplate(template[1]));
      if (options.revision !== undefined && goal.revision !== options.revision) fail('This saved goal changed. Reopen /goal before choosing it.', 'CONFLICT', 409);
      return goal;
    }
    const row = db.prepare(`${sources} SELECT ${columns} FROM source_goals WHERE sessionId=? AND goalId=?`).get(whitespace, match[1], match[2]);
    if (!row) fail('This saved goal is no longer available. Reopen /goal.', 'SAVED_GOAL_UNAVAILABLE', 404);
    const goal = entry(row);
    if (options.revision !== undefined && goal.revision !== options.revision) fail('This saved goal changed. Reopen /goal before choosing it.', 'CONFLICT', 409);
    return goal;
  });
}

// Private owner import deduplication. It does not restore a historical outcome
// and is safe to call inside the same transaction as a reviewed import.
export function hasSavedGoalObjective(objective) {
  if (typeof objective !== 'string' || !objective.trim()) fail('Supply a saved goal objective.');
  return read(db => Boolean(db.prepare(`${reusable} SELECT 1 FROM reusable_goals WHERE objective=? LIMIT 1`).get(whitespace, objective.trim())));
}
