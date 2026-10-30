import path from 'node:path';
import { database, getRecord, putRecord, appendEvent, digest, now, transaction } from './database.js';
import { diagnosticRedactor } from './diagnostic-redaction.js';
import { privateWorkspacePath } from './private-paths.js';
import { normalizeErrorSignature } from './error-signature.js';
import { currentInvestigationAttribution } from './session-investigation.js';

const kinds = ['work.observed', 'diagnostic.tool', 'assignment.reviewed', 'acceptance', 'verification.finished', 'artifact'];
const ignored = new Set(['activity', 'get_task_state', 'read_task_state_details', 'get_goal', 'list_skills', 'read_skill', 'list_subagents', 'read_subagent',
  'recall', 'search_knowledge', 'read_knowledge_source', 'read_session_memory', 'expand_session_memory', 'checkpoint', 'remember', 'skill_feedback']);
const unavailable = () => { throw Object.assign(new Error('Episode source is unavailable.'), { code: 'EPISODE_SCOPE' }); };
function source(session) {
  const saved = session?.id && getRecord('session', session.id);
  if (!saved || getRecord('session-deletion', session.id) || ['learning-review', 'knowledge-review', 'skill-writer'].includes(saved.role) ||
    ['cwd', 'parentSessionId', 'assignmentId', 'agentNamespace'].some(key => (saved[key] ?? null) !== (session[key] ?? null))) unavailable();
  return saved;
}
const privateOperation = text => String(text || '').split(/[\s"'`<>()[\]{}=,;]+/).some(part => privateWorkspacePath(part) || part === 'env')
  || /\b(?:printenv|keychain|security\s+find-(?:generic|internet)-password)\b/i.test(String(text || ''));
function scrubber(session) { return diagnosticRedactor({ roots: [session.cwd, session.projectRoot], maxString: Infinity, maxItems: 64 }).scrub; }
function excerpt(text, size = 1200) { return text.length <= size ? text : text.slice(0, size / 2) + '\n[bounded excerpt]\n' + text.slice(-size / 2); }

// Adapters call only after a complete tool result. Redaction precedes excerpts;
// incomplete/oversize output never becomes an independently scrubbed fragment.
export function recordWorkObservation(session, input) {
  const saved = source(session), run = getRecord('run', saved.id);
  if (!input.itemId || !input.runId || run?.id !== input.runId || run.state !== 'running') return null;
  const scrub = scrubber(saved), command = typeof input.command === 'string' ? input.command : '';
  const output = typeof input.output === 'string' ? input.output : '';
  const suppressed = privateOperation(command), oversized = Buffer.byteLength(output) > 128 * 1024;
  const clean = suppressed || oversized ? '' : scrub(output);
  const safeCommand = suppressed || Buffer.byteLength(command) > 32768 ? '' : scrub(command);
  const outcome = input.status === 'interrupted' ? 'interrupted' : ['denied', 'declined'].includes(input.status) ? 'denied'
    : input.failed === true || Number.isInteger(input.exitCode) && input.exitCode !== 0 ? 'failed'
      : input.failed === false || input.exitCode === 0 || input.kind === 'file_change' && input.status === 'completed' ? 'succeeded' : 'unknown';
  const id = digest([saved.id, input.runId, input.threadRef || null, input.turnId || null, input.itemId]);
  const error = outcome === 'failed' && clean ? normalizeErrorSignature(clean, { tool: input.name || input.kind || 'tool', platform: process.platform }) : null;
  const changedFiles = (input.changes || []).slice(0, 32).flatMap(change => {
    const relative = path.isAbsolute(change.path || '') ? path.relative(saved.projectRoot || saved.cwd, change.path) : change.path;
    if (!relative || relative.startsWith('..') || privateWorkspacePath(relative)) return [];
    const diff = typeof change.diff === 'string' && Buffer.byteLength(change.diff) <= 16384 ? scrub(change.diff) : null;
    return [{ path: scrub(relative), ...(diff ? { diff: excerpt(diff, 1600), diffHash: digest(diff) } : {}) }];
  });
  const observation = { version: 1, id, sessionId: saved.id, runId: run.id, goalId: run.goalMode ? run.goalId : null,
    assignmentId: saved.assignmentId || null, assignmentRound: saved.assignmentRound ?? null,
    ...(() => { try { const { dependencies: _dependencies, ...attribution } = currentInvestigationAttribution(saved, { goalMode: run.goalMode, runId: run.id }); return attribution; } catch { return {}; } })(),
    kind: input.kind || 'tool', name: suppressed ? 'private-operation' : scrub(String(input.name || 'tool')).slice(0, 120),
    operationFingerprint: safeCommand ? digest(safeCommand) : null, outcome,
    exitCode: Number.isInteger(input.exitCode) ? input.exitCode : null, durationMs: Number.isFinite(input.durationMs) ? Math.max(0, input.durationMs) : null,
    summary: clean ? excerpt(clean) : oversized ? '[omitted: complete output exceeds privacy bound]' : suppressed ? '[omitted: private operation]' : '',
    ...(error ? { error } : {}), changedFiles, omittedPrivate: suppressed, omittedOversize: oversized,
    authority: 'Host-observed tool outcome; successful execution does not establish a finding or root cause.' };
  return database().isTransaction ? save(database()) : transaction(save);
  function save(db) {
    source(saved);
    const prior = getRecord('core.episode.observation', id);
    if (prior) return prior;
    const event = appendEvent(saved.id, 'work.observed', observation, db);
    const result = { ...observation, sourceSeq: event.seq, throughSeq: event.seq, createdAt: event.createdAt };
    putRecord('core.episode.observation', id, result, db); return result;
  }
}

function scopeBounds(session, { throughSeq, goalId, runId } = {}) {
  const saved = source(session), db = database(), end = db.prepare('SELECT coalesce(max(seq),0) AS seq FROM events WHERE session_id=?').get(saved.id).seq;
  throughSeq ??= end;
  if (!Number.isSafeInteger(throughSeq) || throughSeq < 0 || throughSeq > end) unavailable();
  return { saved, throughSeq, goalId: goalId === undefined ? saved.goal?.id || null : goalId, runId: runId || null };
}

export function episodeMaterial(session, options = {}) {
  const { saved, throughSeq, goalId, runId } = scopeBounds(session, options), db = database();
  const maxBytes = options.maxBytes ?? 16000;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 64000) throw new Error('Invalid episode material budget.');
  const conditions = `session_id=? AND seq<=? AND type IN (SELECT value FROM json_each(?))
    AND (? IS NULL OR json_extract(data,'$.runId')=? OR type='assignment.reviewed')
    AND (json_extract(data,'$.goalId') IS ? OR type='assignment.reviewed')`;
  const args = [saved.id, throughSeq, JSON.stringify(kinds), runId, runId, goalId];
  const total = db.prepare(`SELECT count(*) AS count FROM events WHERE ${conditions}`).get(...args).count;
  const recent = db.prepare(`SELECT seq,type,created_at,length(CAST(data AS BLOB)) AS bytes,
    CASE WHEN length(CAST(data AS BLOB))<=262144 THEN data ELSE NULL END AS data FROM events WHERE ${conditions} ORDER BY seq DESC LIMIT 512`).all(...args).reverse();
  const attempts = [], verification = [], scrub = scrubber(saved); let omittedOversize = 0, omittedPrivate = 0;
  for (const row of recent) {
    if (!row.data) { omittedOversize++; continue; }
    const data = JSON.parse(row.data);
    if (row.type === 'work.observed') {
      attempts.push({ id: data.id, sourceSeq: row.seq, throughSeq: row.seq, kind: data.kind, name: data.name,
        workUnitId: data.workUnitId || null, workUnitRevision: data.workUnitRevision || null,
        dependencyFingerprint: data.dependencyFingerprint || null, assignmentId: data.assignmentId || null, assignmentRound: data.assignmentRound ?? null,
        operationFingerprint: data.operationFingerprint, outcome: data.outcome, exitCode: data.exitCode, durationMs: data.durationMs,
        summary: data.summary, ...(data.error ? { error: data.error } : {}), changedFiles: data.changedFiles || [],
        omittedPrivate: data.omittedPrivate, omittedOversize: data.omittedOversize });
      omittedOversize += Number(data.omittedOversize); omittedPrivate += Number(data.omittedPrivate);
    } else if (row.type === 'diagnostic.tool' && data.outcome !== 'started' && !ignored.has(data.name)) {
      if (String(data.name).includes('mcp__')) continue;
      const outcome = data.outcome === 'failed' ? data.code === 'FORBIDDEN' ? 'denied' : 'failed' : 'succeeded';
      attempts.push({ id: data.callId || digest([saved.id, row.seq]), sourceSeq: row.seq, throughSeq: row.seq,
        kind: 'bzzy_tool', name: data.name, outcome, durationMs: data.durationMs, exitCode: null,
        summary: data.message ? scrub(data.message) : '',
        ...(outcome === 'failed' && data.message ? { error: normalizeErrorSignature(scrub(data.message), { tool: data.name, platform: process.platform }) } : {}) });
    } else if (row.type === 'assignment.reviewed') {
      const job = getRecord('assignment', data.assignmentId);
      if (!job || job.parentSessionId !== saved.id || (goalId || null) !== (job.goalId || null) || runId &&
        (goalId === null ? job.chatRunId !== runId : job.chatRunId && runId !== job.chatRunId)) continue;
      verification.push({ kind: 'worker-review', sourceSeq: row.seq, assignmentId: job.id, round: data.round,
        outcome: data.outcome, evidence: (data.inspectedEvidence || []).slice(0, 16), authority: 'Supervisor review; not independent verification of the parent goal.' });
    } else if (row.type === 'acceptance' || row.type === 'verification.finished') {
      verification.push({ kind: row.type, sourceSeq: row.seq, id: data.id, passed: data.passed === true,
        level: scrub(String(data.level || 'host-observed')).slice(0, 160), evidence: Array.isArray(data.evidence) ? data.evidence.filter(id => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id)).slice(0, 16) : [] });
    }
  }
  // Temporal linkage is deliberately weaker than root-cause or proof authority.
  const failures = new Map(), transitions = [];
  for (const item of attempts) {
    const key = item.operationFingerprint;
    if (!key) continue;
    if (item.outcome === 'failed') failures.set(key, item);
    if (item.outcome === 'succeeded' && failures.has(key)) {
      const failed = failures.get(key);
      const changeIds = attempts.filter(candidate => candidate.sourceSeq > failed.sourceSeq && candidate.sourceSeq < item.sourceSeq && candidate.kind === 'file_change').slice(-4).map(candidate => candidate.id);
      transitions.push({ failureId: failed.id, successId: item.id, changeIds, relation: 'candidate-fix', authority: 'temporal-sequence-only' });
      failures.delete(key);
    }
  }
  const result = { version: 1, sessionId: saved.id, goalId, runId, throughSeq, attempts: [], transitions: [], verification: verification.slice(-16),
    counts: { attempts: attempts.length, failed: attempts.filter(item => item.outcome === 'failed').length,
      succeeded: attempts.filter(item => item.outcome === 'succeeded').length, workerReviews: verification.filter(item => item.kind === 'worker-review').length },
    coverage: { fromSeq: recent[0]?.seq || throughSeq, throughSeq, sourceEvents: total, omittedEvents: Math.max(0, total - recent.length), omittedPrivate, omittedOversize, truncated: total > recent.length },
    authority: 'Derived observations only. Temporal success does not establish cause, permissions or verified completion.' };
  const fixedBudget = Math.max(900, Math.min(3000, Math.floor(maxBytes / 3)));
  while (Buffer.byteLength(JSON.stringify(result)) > fixedBudget && (result.verification.length || result.transitions.length)) {
    if (result.verification.length) result.verification.shift(); else result.transitions.shift();
    result.coverage.truncated = true;
  }
  const included = new Set();
  for (const transition of transitions.slice(-16).reverse()) {
    const groupIds = new Set([transition.failureId, ...transition.changeIds, transition.successId]);
    const group = attempts.filter(item => groupIds.has(item.id) && !included.has(item.id));
    let selected = group;
    const fits = values => Buffer.byteLength(JSON.stringify({ ...result, transitions: [...result.transitions, transition], attempts: [...result.attempts, ...values] })) <= maxBytes - 180;
    if (!fits(selected)) selected = group.map(item => ({ ...item, summary: excerpt(item.summary || '', 240),
      ...(item.error ? { error: { ...item.error, normalizedMessage: excerpt(item.error.normalizedMessage || '', 200) } } : {}),
      changedFiles: (item.changedFiles || []).slice(0, 4).map(file => ({ ...file, ...(file.diff ? { diff: excerpt(file.diff, 240) } : {}) })), packetExcerpted: true }));
    if (!fits(selected)) { result.coverage.truncated = true; continue; }
    result.transitions.push(transition); result.attempts.push(...selected); for (const item of selected) included.add(item.id);
  }
  const prioritized = [...attempts].filter(item => !included.has(item.id)).sort((a, b) => Number(b.outcome === 'failed') - Number(a.outcome === 'failed') || b.sourceSeq - a.sourceSeq);
  const repeated = new Set();
  for (const attempt of prioritized) {
    const key = digest([attempt.operationFingerprint || attempt.id, attempt.outcome, attempt.summary]);
    if (repeated.has(key)) continue;
    repeated.add(key);
    const next = { ...result, attempts: [...result.attempts, attempt] };
    if (Buffer.byteLength(JSON.stringify(next)) > maxBytes - 150) { result.coverage.truncated = true; continue; }
    result.attempts.push(attempt);
  }
  result.attempts.sort((a, b) => a.sourceSeq - b.sourceSeq);
  const retained = new Set(result.attempts.map(item => item.id));
  result.transitions = result.transitions.filter(item => retained.has(item.failureId) && retained.has(item.successId) && item.changeIds.every(id => retained.has(id)));
  result.coverage.omittedAttempts = attempts.length - result.attempts.length;
  result.sourceHash = digest(result); return result;
}

export function captureEpisode(session, options = {}) {
  const material = episodeMaterial(session, { ...options, maxBytes: 64000 });
  const latest = Math.max(0, ...material.attempts.map(item => item.sourceSeq), ...material.verification.map(item => item.sourceSeq));
  const progress = getRecord('core.episode.progress', session.id);
  if (progress?.runId === material.runId && progress.goalId === material.goalId && progress.observedThroughSeq === latest) return getRecord('core.episode', progress.episodeId);
  if (!latest) return null;
  const id = digest([material.sessionId, material.goalId, material.runId, material.throughSeq, material.sourceHash]);
  const record = { id, ...material, createdAt: now() };
  const operation = db => {
    source(session);
    const prior = getRecord('core.episode', id);
    if (prior) return prior;
    putRecord('core.episode', id, record, db);
    putRecord('core.episode.progress', session.id, { ...getRecord('core.episode.progress', session.id), sessionId: session.id, goalId: material.goalId, runId: material.runId,
      episodeId: id, throughSeq: material.throughSeq, observedThroughSeq: latest, counts: material.counts, authority: material.authority, updatedAt: now() }, db);
    return record;
  };
  return database().isTransaction ? operation(database()) : transaction(operation);
}

export function episodeStatus(session) {
  source(session);
  return getRecord('core.episode.progress', session.id) || { sessionId: session.id, episodeId: null, counts: { attempts: 0 } };
}

export function recentErrorSignatures(session, { goalId, runId, limit = 4 } = {}) {
  source(session);
  const rows = database().prepare(`SELECT data FROM records WHERE kind='core.episode.observation'
    AND json_extract(data,'$.sessionId')=? AND json_extract(data,'$.goalId') IS ?
    AND (? IS NOT NULL OR json_extract(data,'$.runId') IS ?)
    AND json_extract(data,'$.outcome')='failed' ORDER BY updated_at DESC LIMIT 16`).all(session.id, goalId ?? null, goalId ?? null, runId ?? null);
  const unique = new Map();
  for (const row of rows) {
    const error = JSON.parse(row.data).error;
    if (error?.signatureHash && !unique.has(error.signatureHash)) unique.set(error.signatureHash, error);
    if (unique.size >= Math.min(8, Math.max(1, limit))) break;
  }
  return [...unique.values()];
}
