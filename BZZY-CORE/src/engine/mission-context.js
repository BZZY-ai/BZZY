import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { database, digest, getRecord, putRecord, now, transaction } from './database.js';
import { sharedSecrets } from './share-bundle-policy.js';
import { inside } from './evidence.js';

const fail = message => { throw Object.assign(new Error(message), { code: 'MISSION_CONTEXT_UNAVAILABLE' }); };
const atomic = operation => database().isTransaction ? operation(database()) : transaction(operation);
const uuid = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
const critical = parent => ({ sessionId: parent.id, goalId: parent.goal?.id || null,
  objective: parent.goal?.objective || parent.contract?.objective || '', instructions: parent.contract?.context || '',
  constraints: parent.contract?.constraints || [], scope: parent.contract?.scope || {}, policy: parent.policy || parent.contract?.policy || {},
  acceptanceCriteria: parent.contract?.acceptanceCriteria || [], artifacts: parent.contract?.artifacts || [], verification: parent.contract?.verification || [],
  reviewSource: parent.reviewSource || null });

// This revision deliberately excludes counters, timestamps and execution state.
// A new instruction or boundary does invalidate a worker's older brief.
function userDirectives(parent) {
  if (!parent.goal?.createdAt) return [];
  const completed = parent.goal.status === 'complete' && database().prepare("SELECT seq FROM events WHERE session_id=? AND type='goal.completed' AND json_extract(data,'$.goalId')=? ORDER BY seq DESC LIMIT 1").get(parent.id, parent.goal.id);
  return database().prepare("SELECT seq,data FROM events WHERE session_id=? AND type='message.user' AND created_at>=? AND seq<=? ORDER BY seq LIMIT 257").all(parent.id, parent.goal.createdAt, completed?.seq || Number.MAX_SAFE_INTEGER);
}
export const missionSourceRevision = (parent, { chat = false } = {}) => digest({ ...critical(parent), directives: chat ? [] : userDirectives(parent) });
export const missionResultRevision = parent => digest({ goalId: parent.goal?.id || null, status: parent.goal?.status || null,
  evidence: parent.goal?.evidence || [], acceptance: parent.acceptance || null, modeResult: parent.modeResult?.goalId === parent.goal?.id ? parent.modeResult : null });

// Preserve only inert reference syntax, never arbitrary angle-wrapped values.
// Real configured secrets are removed before this check. A safe token is one
// value, not permission to preserve the remainder of a credential-bearing line.
const referenceToken = String.raw`(?:<approved-private-host-reference>|\$\{[A-Z_][A-Z0-9_]{0,127}\}|\[redacted\])`;
const exactReferenceToken = new RegExp(`^${referenceToken}$`);
const quotedReference = `(?:"${referenceToken}"|'${referenceToken}'|${referenceToken})`;
const referenceValue = `(?:(?:Bearer|Basic)\\s+)?${quotedReference}`;
const referenceBoundary = String.raw`(?=$|[\s,;)}\]]|\.(?=\s|$))`;
const credentialAssignment = String.raw`((?:["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|cookie|authorization)["']?)\s*[=:]\s*)`;
// An attached suffix is part of a malformed value, not a safe reference token.
// Consume that malformed tail too, so removing its credential label cannot
// leave a following quoted secret exposed without its original assignment.
const quotedValue = String.raw`(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*')(?:(?!\.(?:\s|$))[^\s,;)}\]][^\r\n,;]*)?`;
const quotedAssignment = new RegExp(credentialAssignment + `(${quotedValue})`, 'gi');
const unquotedAssignment = new RegExp(credentialAssignment + `(${referenceValue}${referenceBoundary}|(?:Bearer|Basic)\\s+${quotedValue}|[^\\r\\n,;"']+)`, 'gi');
const authorizationValue = new RegExp(String.raw`\b(?:Bearer|Basic)\s+(?:` + quotedReference + referenceBoundary + '|' + quotedValue + String.raw`|<[^>\r\n]*>[^\s"']*|<[^\r\n]*|[^\s"']+)`, 'gi');
function referenceOnly(value) {
  const unquote = text => text.length >= 2 && ['"', "'"].includes(text[0]) && text.at(-1) === text[0] ? text.slice(1, -1) : text;
  const raw = unquote(value.trim()), authorization = /^(?:Bearer|Basic)\s+(.+)$/i.exec(raw);
  return exactReferenceToken.test(unquote(authorization ? authorization[1] : raw));
}

function sanitized(value, secrets) {
  if (typeof value === 'string') {
    let result = value;
    for (const secret of secrets) result = result.replaceAll(secret, '[redacted]');
    return result.replace(/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g, '[redacted]')
      .replace(quotedAssignment, (_match, prefix, assigned) => prefix + (referenceOnly(assigned) ? assigned : assigned[0] + '[redacted]' + assigned[0]))
      .replace(unquotedAssignment, (_match, prefix, assigned) => prefix + (referenceOnly(assigned) ? assigned : '[redacted]'))
      .replace(authorizationValue, match => referenceOnly(match) ? match : '[redacted]')
      .replace(/\bsk-[A-Za-z0-9_-]{12,}|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/gi, '[redacted]')
      .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@');
  }
  if (Array.isArray(value)) return value.map(item => sanitized(item, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/^(?:backendHomes|backendProcess|engineHome|credentials|accountBindings|ownerToken|privateKey|reasoning|analysis|chainOfThought)$/i.test(key))
    .map(([key, item]) => [key, /^(?:api[_-]?keys?|access[_-]?tokens?|refresh[_-]?tokens?|passwords?|passwd|secrets?|cookies?|authorization|.*_(?:API_KEY|TOKEN|SECRET|PASSWORD))$/i.test(key) ? '[redacted]' : sanitized(item, secrets)]));
  return value;
}
export const sanitizeMissionValue = value => sanitized(value, sharedSecrets());

function fileHash(file, budget) {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > budget.bytes || --budget.files < 0) fail('Mission evidence exceeds its bounded verification budget. Select a bounded review or supply the missing evidence.');
    budget.bytes -= stat.size;
    const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024); let length;
    while ((length = fs.readSync(descriptor, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, length));
    return hash.digest('hex');
  } finally { fs.closeSync(descriptor); }
}

export function missionEvidenceCurrent(entries) {
  const budget = { bytes: 256 * 1024 * 1024, files: 8192 };
  try {
    return entries.every(entry => {
      const item = getRecord('artifact', entry.id);
      if (!item || item.sha256 !== entry.sha256 || fileHash(item.path, budget) !== entry.sha256) return false;
      return !item.source || typeof item.sourceWorkspace === 'string' && typeof item.sourceSha256 === 'string' && fileHash(inside(item.sourceWorkspace, item.source), budget) === item.sourceSha256;
    });
  } catch { return false; }
}

export function createMissionContext(parent, { purpose = 'delegate', independent = false, evidenceIds = [], taskContext } = {}) {
  if (!uuid(parent?.id) || purpose !== 'subagent' && (!parent.contract || !parent.goal && !parent.contract.objective)) fail('A saved task is required for a mission brief.');
  if (!Array.isArray(evidenceIds) || evidenceIds.length > 4096 || evidenceIds.some(id => !uuid(id))) fail('Mission evidence must contain bounded recorded artifact IDs.');
  const source = critical(parent), secrets = sharedSecrets();
  const chat = purpose === 'subagent' && taskContext?.mode === 'chat';
  const checkpoint = !independent && !chat && getRecord('checkpoint', parent.id);
  const currentCheckpoint = checkpoint && checkpoint.objective === source.objective && (!parent.goal?.createdAt || checkpoint.updatedAt >= parent.goal.createdAt) ? checkpoint : null;
  const rows = chat ? [] : userDirectives(parent);
  if (rows.length > 256) fail('The mission has too many user directives for a safe automatic handoff. Consolidate the instructions explicitly.');
  const directives = rows.map(row => { const data = JSON.parse(row.data); return { sourceId: `${parent.id}:${row.seq}`, text: typeof data.text === 'string' ? data.text : '' }; });
  const evidence = [...new Set(evidenceIds)].map(id => {
    const item = getRecord('artifact', id);
    if (!item || !uuid(item.sessionId)) fail('Mission evidence is unavailable.');
    const worker = getRecord('session', item.sessionId), job = worker?.assignmentId && getRecord('assignment', worker.assignmentId);
    if (item.sessionId !== parent.id && !(parent.allowedArtifactIds || []).includes(id) &&
        !(job && job.parentSessionId === parent.id && (job.goalId === (parent.goal?.id || null) || job.chatRunId && job.sourceGoalId === (parent.goal?.id || null)) && job.workerSessionId === item.sessionId)) fail('Mission evidence is outside this task.');
    // The host supplies selected evidence; callers must already authorize the
    // assignment's share. Never discover unrelated evidence from a project path.
    return { id, sha256: item.sha256, label: item.label || 'recorded evidence', size: item.size, sessionId: item.sessionId };
  });
  if (!missionEvidenceCurrent(evidence)) fail('Mission evidence is missing, altered or no longer matches its recorded source.');
  const original = { goal: { id: chat ? null : source.goalId, objective: chat ? taskContext.assignment : source.objective }, instructions: chat ? taskContext.request : source.instructions,
    constraints: source.constraints, scope: source.scope, acceptanceCriteria: chat ? [{ id: 'specialist-result', description: taskContext.assignment }] : source.acceptanceCriteria,
    deliverables: chat ? [] : source.artifacts, verification: chat ? [] : source.verification, policy: source.policy,
    directives, decisions: currentCheckpoint?.decisions || [], pendingQuestions: currentCheckpoint?.unresolvedQuestions || [],
    completedWork: currentCheckpoint?.completedWork || [], evidence, independent,
    ...(purpose === 'subagent' && taskContext ? { currentTask: taskContext } : {}),
    ...(!chat && source.reviewSource ? { reviewSource: source.reviewSource } : {}) };
  const brief = sanitized(original, secrets), encoded = JSON.stringify(brief);
  if (Buffer.byteLength(encoded) > 2 * 1024 * 1024) fail('The mission brief exceeds 2 MiB. Consolidate its instructions explicitly; mandatory context was not truncated.');
  const sha256 = digest(brief), sourceRevision = missionSourceRevision(parent, { chat });
  const id = digest({ sourceSessionId: parent.id, sourceGoalId: source.goalId, sourceRevision, purpose, sha256 });
  const record = { version: 1, id, sourceSessionId: parent.id, sourceGoalId: source.goalId, sourceRevision, purpose,
    sha256, brief, redacted: JSON.stringify(original) !== encoded, createdAt: now() };
  return atomic(db => {
    const existing = getRecord('core.mission.context', id);
    if (existing && (existing.sha256 !== sha256 || digest(existing.brief) !== sha256)) fail('The saved mission brief failed its integrity check.');
    if (!existing) putRecord('core.mission.context', id, record, db);
    return existing || record;
  });
}

export function missionContextCurrent(parent, value) {
  const record = typeof value === 'string' ? getRecord('core.mission.context', value) : value;
  if (!record || record.sourceSessionId !== parent?.id || record.sourceGoalId !== (parent.goal?.id || null) || record.sourceRevision !== missionSourceRevision(parent,
    { chat: record.purpose === 'subagent' && record.brief?.currentTask?.mode === 'chat' })) return false;
  const saved = getRecord('core.mission.context', record.id);
  const expectedId = digest({ sourceSessionId: record.sourceSessionId, sourceGoalId: record.sourceGoalId,
    sourceRevision: record.sourceRevision, purpose: record.purpose, sha256: record.sha256 });
  return Boolean(saved && expectedId === record.id && saved.sourceSessionId === record.sourceSessionId && saved.sourceGoalId === record.sourceGoalId &&
    saved.sourceRevision === record.sourceRevision && saved.purpose === record.purpose && saved.sha256 === record.sha256 &&
    digest(saved.brief) === record.sha256 && digest(record.brief) === record.sha256 && missionEvidenceCurrent(record.brief.evidence || []));
}
