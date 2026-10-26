import { database, transaction, getRecord, putRecord, digest, now } from './database.js';
import { assertShareText, sharedSecrets } from './share-bundle-policy.js';

// Explicitly saved/imported reusable objectives are private owner data, never historical goal
// outcomes or executable sessions. Selecting one still needs new-goal admission.
export const GOAL_TEMPLATE_KIND = 'core.goal.template';
export const GOAL_TEMPLATE_BYTES = 16 * 1024;
const atomic = operation => database().isTransaction ? operation(database()) : transaction(operation);
const fail = (message, code = 'INVALID_GOAL_TEMPLATE') => { throw Object.assign(new Error(message), { code }); };
const validId = id => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id);

function normalizedText(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
      Object.keys(input).some(key => key !== 'objective') || typeof input.objective !== 'string' ||
      !input.objective.trim() || Buffer.byteLength(input.objective) > GOAL_TEMPLATE_BYTES ||
      Buffer.from(input.objective).toString('utf8') !== input.objective ||
      /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/u.test(input.objective)) {
    fail('A saved goal contains only a nonempty objective of at most 16 KiB.');
  }
  return { objective: input.objective.trim() };
}
export function normalizeGoalTemplate(input) {
  const result = normalizedText(input);
  assertShareText(result.objective, sharedSecrets());
  return result;
}

function checkedRecord(record, id) {
  const value = normalizedText({ objective: record.objective });
  if (record.id !== id || record.version !== id || digest(value) !== id || !Number.isSafeInteger(record.revision) || record.revision < 1 ||
      typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt)) ||
      record.deletedAt !== undefined && (typeof record.deletedAt !== 'string' || !Number.isFinite(Date.parse(record.deletedAt)))) {
    fail('The saved goal template changed unexpectedly. Reopen /goal.', 'CONFLICT');
  }
  return structuredClone(record);
}
export function getGoalTemplate(id) {
  if (!validId(id)) fail('Choose a saved goal from its current list.');
  const record = getRecord(GOAL_TEMPLATE_KIND, id);
  if (!record || record.deletedAt) fail('This saved goal is no longer available. Reopen /goal.', 'SAVED_GOAL_UNAVAILABLE');
  return checkedRecord(record, id);
}

export function goalTemplateEntry(record) {
  return { id: `template:${record.id}`, revision: digest({ id: record.id, objective: record.objective,
    createdAt: record.createdAt, revision: record.revision }), goalId: null, sessionId: null, cwd: null,
    alias: 'Saved goal', createdAt: record.createdAt, objective: record.objective, status: null, source: 'template' };
}

// Library reads intentionally exclude execution and goal-history records.
export function listGoalTemplates(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['offset', 'limit'].includes(key))) fail('Choose a saved-goal page using offset and limit.', 'INVALID_REQUEST');
  const { offset = 0, limit = 20 } = options;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('Saved-goal offset must be nonnegative and limit must be 1–100.', 'INVALID_REQUEST');
  const read = db => {
    const filter = "kind=? AND json_extract(data,'$.deletedAt') IS NULL";
    const { total } = db.prepare(`SELECT count(*) AS total FROM records WHERE ${filter}`).get(GOAL_TEMPLATE_KIND);
    const goals = db.prepare(`SELECT id FROM records WHERE ${filter} ORDER BY json_extract(data,'$.createdAt') DESC,id LIMIT ? OFFSET ?`).all(GOAL_TEMPLATE_KIND, limit, offset).map(row => goalTemplateEntry(getGoalTemplate(row.id)));
    return { goals, total, nextOffset: offset + goals.length < total ? offset + goals.length : null };
  };
  return database().isTransaction ? read(database()) : transaction(read, { readOnly: true });
}
export function getSavedGoalTemplate(id, options = {}) {
  if (typeof id !== 'string' || !/^template:[a-f0-9]{64}$/.test(id) || !options || typeof options !== 'object' || Array.isArray(options) ||
      Object.keys(options).some(key => key !== 'revision') || options.revision !== undefined && (typeof options.revision !== 'string' || !/^[a-f0-9]{64}$/.test(options.revision))) fail('Choose a saved goal from the current list.', 'INVALID_REQUEST');
  const goal = goalTemplateEntry(getGoalTemplate(id.slice(9)));
  if (options.revision !== undefined && options.revision !== goal.revision) fail('This saved goal changed. Reopen /goal.', 'CONFLICT');
  return goal;
}
export function hasGoalTemplateObjective(objective) {
  const id = digest(normalizedText({ objective })), record = getRecord(GOAL_TEMPLATE_KIND, id);
  return record && !record.deletedAt ? Boolean(getGoalTemplate(id)) : false;
}

// Local-owner Library management only. Removing a template never edits a
// session, goal outcome or evidence. A later explicit save may restore its text
// with a new revision, so an old open picker cannot act on the replacement.
export function deleteGoalTemplate(id, { revision } = {}) {
  if (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)) fail('Review the current saved goal before removing it.', 'INVALID_REQUEST');
  return atomic(db => {
    const entry = getSavedGoalTemplate(id, { revision }), current = getGoalTemplate(id.slice(9));
    const next = current.revision + 1;
    if (!Number.isSafeInteger(next)) fail('The saved goal revision limit was reached.', 'CAPACITY');
    const record = { ...current, revision: next, deletedAt: now() };
    putRecord(GOAL_TEMPLATE_KIND, current.id, record, db);
    putRecord('core.goal.template.removal', digest([current.id, next]), { id, version: current.version, revision: next, removedAt: record.deletedAt }, db);
    return { deleted: true, id: entry.id, revision: next };
  });
}

export function saveGoalTemplate(input) {
  const value = normalizeGoalTemplate(input), id = digest(value);
  return atomic(db => {
    const existing = getRecord(GOAL_TEMPLATE_KIND, id);
    if (existing && !existing.deletedAt) return getGoalTemplate(id);
    if (existing) checkedRecord(existing, id);
    if (db.prepare("SELECT count(*) AS total FROM records WHERE kind=? AND json_extract(data,'$.deletedAt') IS NULL").get(GOAL_TEMPLATE_KIND).total >= 4096) {
      fail('The saved goal template limit was reached.', 'CAPACITY');
    }
    const revision = (existing?.revision || 0) + 1;
    if (!Number.isSafeInteger(revision)) fail('The saved goal revision limit was reached.', 'CAPACITY');
    const createdAt = now(), record = { ...value, id, version: id, revision, createdAt };
    putRecord(GOAL_TEMPLATE_KIND, id, record, db);
    return structuredClone(record);
  });
}
