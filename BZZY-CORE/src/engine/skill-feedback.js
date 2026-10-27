import { database, getRecord, putRecord, appendEvent, digest, transaction, now } from './database.js';
import { modelSkillUsageContext } from './skill-usage.js';
import { inspectSkill } from './skills.js';
import { sanitizeLearningText } from './learning.js';
import { home, readJson } from './files.js';
import path from 'node:path';

const kinds = ['wrong_step', 'missing_step', 'outdated', 'pitfall', 'preference', 'helpful', 'unhelpful'];
const fail = message => { throw Object.assign(new Error(message), { code: 'SKILL_FEEDBACK_SCOPE' }); };
export const skillFeedbackToolSpec = { name: 'skill_feedback', description: 'Propose feedback on an exact skill version fully read in this live run. Include factual rationale and permitted evidence; this never edits, enables or verifies a skill. Feedback can lead to a separately staged review.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['usageId', 'requestId', 'kind', 'rationale'], properties: {
    usageId: { type: 'string', maxLength: 64 }, requestId: { type: 'string', maxLength: 128 }, kind: { type: 'string', enum: kinds },
    rationale: { type: 'string', maxLength: 2000 }, file: { type: 'string', maxLength: 240 }, proposedText: { type: 'string', maxLength: 4000 },
    evidence: { type: 'array', maxItems: 16, items: { type: 'string' } } } } };
function readComplete(sessionId, usageId, version, file, total) {
  const rows = database().prepare(`SELECT json_extract(data,'$.offset') AS offset,json_extract(data,'$.bytes') AS bytes FROM events
    WHERE session_id=? AND type='skill.loaded' AND json_extract(data,'$.usageId')=? AND json_extract(data,'$.version')=?
    AND json_extract(data,'$.file')=? ORDER BY json_extract(data,'$.offset') LIMIT 257`).all(sessionId, usageId, version, file);
  if (rows.length > 256) return false;
  let end = 0;
  for (const row of rows) {
    if (!Number.isSafeInteger(row.offset) || !Number.isSafeInteger(row.bytes) || row.offset > end || row.offset < 0 || row.bytes < 0) return false;
    end = Math.max(end, row.offset + row.bytes);
  }
  return end >= total;
}
export function submitSkillFeedback(session, input, context = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['usageId', 'requestId', 'kind', 'rationale', 'file', 'proposedText', 'evidence'].includes(key)) ||
      !/^[a-f0-9]{64}$/.test(input.usageId || '') || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(input.requestId || '') || !kinds.includes(input.kind)) fail('Invalid skill feedback fields.');
  for (const [key, maximum] of [['rationale', 2000], ['proposedText', 4000]]) if (input[key] !== undefined && (typeof input[key] !== 'string' ||
      Buffer.byteLength(input[key]) > maximum || sanitizeLearningText(input[key]) !== input[key] || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(input[key]))) fail('Feedback must be bounded text without credentials.');
  if (!input.rationale?.trim() || !Array.isArray(input.evidence || []) || (input.evidence || []).length > 16) fail('Feedback requires rationale and at most sixteen evidence references.');
  return transaction(db => {
    const live = modelSkillUsageContext(session, context), saved = getRecord('session', session.id), usage = getRecord('core.usage', input.usageId);
    if (!live || getRecord('session-deletion', session.id) || ['paused', 'cancelled'].includes(saved.executionState) ||
        readJson(path.join(home(), 'runtime', 'operator-stop.json'), null)?.stopped || usage?.sessionId !== session.id || usage.runId !== live.runId || usage.goalId !== live.goalId ||
        !db.prepare("SELECT 1 FROM records r JOIN events e ON e.data=r.data AND e.type='core.usage' AND e.session_id=? WHERE r.kind='core.usage' AND r.id=? LIMIT 1").get(session.id, input.usageId) ||
        db.prepare("SELECT 1 FROM records WHERE kind='execution' AND json_extract(data,'$.sessionId')=? AND json_extract(data,'$.state') IN ('queued','launching','running') AND json_extract(data,'$.stopAction') IN ('pause','cancel') LIMIT 1").get(session.id)) fail('Feedback requires an actual skill load in the current live execution.');
    const skill = inspectSkill(usage.skillId, { session: saved });
    if (skill.id !== usage.skillId || skill.version !== usage.skillVersion || !skill.enabled) fail('The loaded skill changed, is disabled or was removed.');
    const file = input.file || 'SKILL.md', main = skill.files.find(item => item.path === 'SKILL.md'), selected = skill.files.find(item => item.path === file);
    if (!main || !selected || !readComplete(saved.id, usage.id, usage.skillVersion, 'SKILL.md', main.bytes) ||
        file !== 'SKILL.md' && !readComplete(saved.id, usage.id, usage.skillVersion, file, selected.bytes)) fail('Read the complete skill and referenced file before submitting feedback.');
    const evidence = [...new Set(input.evidence || [])];
    for (const id of evidence) {
      const artifact = typeof id === 'string' && getRecord('artifact', id);
      if (!artifact || artifact.sessionId !== saved.id && !saved.allowedArtifactIds?.includes(id)) fail('Feedback evidence is outside this execution.');
    }
    const id = digest([saved.id, live.runId, input.requestId]), inputHash = digest(input), previous = getRecord('core.skill.feedback', id);
    if (previous) { if (previous.inputHash !== inputHash) fail('Feedback request ID conflicts with earlier content.'); return previous; }
    const record = { id, sourceId: id, version: 1, inputHash, sessionId: saved.id, runId: live.runId, goalId: live.goalId,
      projectId: usage.projectId || saved.projectId || null, usageId: usage.id, skillId: usage.skillId, skillVersion: usage.skillVersion,
      kind: input.kind, file, rationale: input.rationale.trim(), proposedText: input.proposedText || null, evidence,
      state: 'proposed', authority: 'Model feedback only; not resource administration, causation or verified outcome.', createdAt: now() };
    putRecord('core.skill.feedback', id, record, db); appendEvent(saved.id, 'skill.feedback', record, db); return record;
  });
}

// Add associations, never mutate immutable usage receipts or their source events.
export function captureSkillOutcomes(session, runId) {
  const saved = getRecord('session', session.id), run = getRecord('run', session.id);
  if (!saved || getRecord('session-deletion', session.id) || run?.id !== runId || ['starting', 'running', 'waiting_for_input', 'verifying'].includes(run.state)) return { deferred: true, recorded: 0 };
  const rows = database().prepare(`SELECT r.data FROM records r WHERE r.kind='core.usage' AND json_extract(r.data,'$.sessionId')=?
    AND json_extract(r.data,'$.runId')=? AND EXISTS(SELECT 1 FROM events e WHERE e.type='core.usage' AND e.data=r.data AND e.session_id=?) LIMIT 128`).all(saved.id, runId, saved.id);
  let recorded = 0;
  const operation = db => {
    if (getRecord('session-deletion', saved.id)) return;
    for (const row of rows) {
      const use = JSON.parse(row.data), id = digest([use.id, 'run-outcome-v1']);
      if (getRecord('core.skill.outcome', id)) continue;
      const acceptance = saved.acceptance?.goalId === use.goalId ? saved.acceptance : null;
      const value = { id, version: 1, usageId: use.id, sessionId: saved.id, projectId: use.projectId || saved.projectId || null,
        runId, goalId: use.goalId, skillId: use.skillId, skillVersion: use.skillVersion, runState: run.state,
        goalStatus: run.goalMode && saved.goal?.id === use.goalId ? saved.goal.status : null,
        acceptance: acceptance ? { id: acceptance.id, passed: acceptance.passed, level: acceptance.level } : null,
        attribution: 'associated-with-run; skill contribution and causation are unverified', createdAt: now() };
      putRecord('core.skill.outcome', id, value, db); recorded++;
    }
  };
  if (database().isTransaction) operation(database()); else transaction(operation);
  return { recorded, deferred: false };
}
