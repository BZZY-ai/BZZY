import { database, getRecord, putRecord, digest, now } from './database.js';
import { diagnosticRedactor } from './diagnostic-redaction.js';
import { conversationRedactionContext } from './conversation-source.js';
import { episodeMaterial } from './episode.js';
import { snapshotLearningSkills } from './skill-updates.js';
import { knowledgeAccess, allowedKnowledgeSessionIds } from './knowledge-index.js';

const KIND = 'core.learning.packet';
const hashBody = ({ id, createdAt, ...body }) => digest(body);
const fail = message => { throw Object.assign(new Error(message), { code: 'LEARNING_SCOPE' }); };

// Queue admission captures mutable records and model selection ONCE. Review
// dispatch never reconstructs them from the source session's later goal/state.
export function captureLearningPacket(session, job, { maxBytes = 16000 } = {}) {
  const { scrub } = diagnosticRedactor({ roots: [session.cwd, session.projectRoot], maxString: Infinity, maxItems: 256, maxFields: 128 });
  const material = [], recordPins = [], coverage = { omittedItems: 0, omittedBytes: 0, omittedRecords: 0, omittedMessages: 0,
    omittedCharacters: 0, unsealedMessages: 0, truncated: false, sourceCutoff: job.throughSeq, maxBytes };
  const excerpt = value => {
    const clean = scrub(value), limit = Math.min(2000, Math.floor(maxBytes / 8)), omittedCharacters = Math.max(0, clean.length - limit);
    if (omittedCharacters) { coverage.omittedCharacters += omittedCharacters; coverage.truncated = true; }
    return { text: clean.slice(0, limit), ...(omittedCharacters ? { omittedCharacters } : {}) };
  };
  const seen = new Set(); let bytes = 0;
  const add = value => {
    const item = scrub(value), size = Buffer.byteLength(JSON.stringify(item));
    if (!item?.sourceId || seen.has(item.sourceId)) return true;
    if (material.length >= 40 || bytes + size > maxBytes) {
      coverage.omittedItems++; coverage.omittedBytes += size; coverage.truncated = true; return false;
    }
    seen.add(item.sourceId); material.push(item); bytes += size; return true;
  };
  const goal = job.goalId && session.goal?.id === job.goalId ? session.goal : null;
  const sourceEvent = database().prepare("SELECT seq,type FROM events WHERE session_id=? AND type='message.user' AND seq<=? ORDER BY seq DESC LIMIT 1").get(session.id, job.throughSeq);
  const userContext = sourceEvent && conversationRedactionContext(session.id, sourceEvent, job.throughSeq);
  const objective = goal?.objective || userContext?.text || session.contract?.objective || '';
  add({ sourceId: goal ? `goal:${goal.id}` : sourceEvent ? `${session.id}:${sourceEvent.seq}` : `context:${session.id}:${job.throughSeq}`, type: goal ? 'goal' : sourceEvent ? 'message.user' : 'task-context',
    ...excerpt(objective),
    authority: 'Original task context, not a verified outcome or permission to execute.' });
  for (const trigger of job.triggers || [{ reason: job.reason, sourceId: job.sourceId }]) {
    const match = new RegExp('^' + session.id + ':(\\d+)$').exec(trigger.sourceId);
    const row = match && database().prepare("SELECT seq,type FROM events WHERE session_id=? AND seq=? AND seq<=? AND type='message.user'").get(session.id, Number(match[1]), job.throughSeq);
    if (row) {
      const context = conversationRedactionContext(session.id, row, job.throughSeq);
      add({ sourceId: trigger.sourceId, type: 'message.user', ...excerpt(context.text), reason: trigger.reason });
    }
    if (trigger.reason === 'skill_feedback') {
      const feedback = getRecord('core.skill.feedback', trigger.sourceId);
      const observed = feedback && database().prepare("SELECT seq FROM events WHERE session_id=? AND type='skill.feedback' AND json_extract(data,'$.id')=? AND seq<=? LIMIT 1").get(session.id, feedback.id, job.throughSeq);
      if (observed && feedback.sessionId === session.id && (feedback.goalId || null) === job.goalId &&
          (!job.runId || feedback.runId === job.runId)) {
        if (add({ sourceId: feedback.id, type: 'skill-feedback', skillId: feedback.skillId, version: feedback.skillVersion,
          usageId: feedback.usageId, file: feedback.file, kind: feedback.kind, rationale: feedback.rationale,
          proposedText: feedback.proposedText, evidence: feedback.evidence,
          authority: 'Model feedback on a loaded version; neither verified causality nor authority to activate a patch.' })) {
          recordPins.push({ kind: 'core.skill.feedback', id: feedback.id, revision: feedback.version || 1, sha256: digest(feedback) });
        }
      }
    }
  }
  const observedEpisode = episodeMaterial(session, { throughSeq: job.throughSeq, goalId: job.goalId, runId: job.runId,
    maxBytes: Math.max(1024, Math.min(7000, maxBytes - bytes - 256)) });
  const episode = (observedEpisode?.attempts?.length || observedEpisode?.verification?.length) &&
    add({ sourceId: `episode:${observedEpisode.sourceHash}`, type: 'episode', ...observedEpisode }) ? observedEpisode : null;
  coverage.episode = observedEpisode?.coverage || null;
  const access = knowledgeAccess(session), allowedSessions = new Set(allowedKnowledgeSessionIds(session, access));
  const decisiveEvidence = [...new Set([
    ...(episode?.verification || []).flatMap(item => item.evidence || []),
    ...(episode?.attempts || []).flatMap(item => item.evidence || []),
  ])].slice(0, 16);
  for (const id of decisiveEvidence) {
    const artifact = getRecord('artifact', id);
    if (!artifact || !allowedSessions.has(artifact.sessionId) || artifact.importProvenance || artifact.importedUntrusted) { coverage.omittedRecords++; continue; }
    if (add({ sourceId: artifact.id, type: 'artifact', label: artifact.label, sha256: artifact.sha256, size: artifact.size })) {
      recordPins.push({ kind: 'artifact', id: artifact.id, revision: artifact.revision || null, sha256: digest(artifact) });
    }
  }
  const learnedSkills = snapshotLearningSkills(session, { throughSeq: job.throughSeq, runId: job.runId, maxBytes: Math.min(12000, Math.floor(maxBytes / 2)) });
  const skills = [];
  for (const skill of learnedSkills.items || []) {
    const clean = scrub(skill);
    if (digest(skill) !== digest(clean)) { coverage.omittedSkills = (coverage.omittedSkills || 0) + 1; continue; }
    if (add({ ...skill, type: 'skill', sourceId: skill.sourceId })) skills.push(clean);
  }
  coverage.omittedSkills = (coverage.omittedSkills || 0) + (learnedSkills.omitted || 0);
  for (const recordKind of ['checkpoint', 'issue', 'memory', 'artifact']) {
    for (const record of database().prepare('SELECT id,data FROM records WHERE kind=? AND json_extract(data,\'$.sessionId\')=? ORDER BY updated_at DESC,id LIMIT 20').all(recordKind, session.id)) {
      const value = JSON.parse(record.data);
      if (value.goalId && value.goalId !== job.goalId || value.importedUntrusted || value.importProvenance) { coverage.omittedRecords++; continue; }
      if (recordKind === 'checkpoint' && (value.schemaVersion !== 2 || value.scope?.goalId !== job.goalId ||
        value.scope?.kind === 'chat' && value.scope.chatRunId && value.scope.chatRunId !== job.runId)) { coverage.omittedRecords++; continue; }
      const pin = { kind: recordKind, id: record.id, revision: value.revision || null, sha256: digest(value) };
      const item = recordKind === 'artifact' ? { sourceId: record.id, type: 'artifact', label: value.label, sha256: value.sha256, size: value.size }
        : { sourceId: value.id || value.sessionId, type: recordKind, revision: value.revision || null,
          statement: value.statement || value.title, rationale: value.rationale, details: value.details, status: value.status,
          kind: value.kind, truth: value.truth, evidence: value.evidence, revisitWhen: value.revisitWhen,
          completedWork: value.completedWork, decisions: value.decisions, unresolvedQuestions: value.unresolvedQuestions };
      if (add(item)) recordPins.push(pin); else coverage.omittedRecords++;
    }
  }
  const rows = database().prepare("SELECT seq,type FROM events WHERE session_id=? AND seq<=? AND type IN ('message.user','text') ORDER BY seq DESC LIMIT 40").all(session.id, job.throughSeq).reverse();
  const contexts = new Set();
  for (const row of rows) {
    const context = conversationRedactionContext(session.id, row, job.throughSeq);
    if (contexts.has(context.key)) continue;
    contexts.add(context.key);
    if (context.omitted || context.completionSeq > job.throughSeq || row.type === 'text' && !context.completionSeq && context.end > job.throughSeq &&
      ['running', 'starting', 'waiting_for_input', 'verifying'].includes(session.executionState)) { coverage.unsealedMessages++; continue; }
    const firstSeq = context.rows?.[0]?.seq || row.seq;
    if (!add({ sourceId: `${session.id}:${firstSeq}`, type: row.type, ...excerpt(context.text),
      firstSeq, lastSeq: context.rows?.at(-1)?.seq || row.seq, sourceHash: context.sourceHash, provenance: 'sealed-conversation-message' })) coverage.omittedMessages++;
  }
  const signatures = [...new Map((episode?.attempts || []).filter(attempt => attempt.error?.signatureHash || attempt.error?.hash).map(attempt => {
    const error = attempt.error, signatureHash = error.signatureHash || error.hash;
    return [signatureHash, scrub({ signatureHash, errorClass: error.errorClass || null, errorCode: error.errorCode || error.code || null,
      ecosystem: error.ecosystem || null, tool: error.tool || attempt.name, platform: error.platform || process.platform,
      version: error.version || null, normalizedMessage: error.normalizedMessage || error.text || '' })];
  })).values()];
  const packet = { version: 2, sessionId: session.id, projectId: job.projectId, agentNamespace: job.agentNamespace || null,
    goalId: job.goalId, runId: job.runId || null, throughSeq: job.throughSeq, selection: job.selection || null,
    selectionSource: job.selectionSource, selectionResolution: job.selectionResolution,
    modelSettingsRevision: job.modelSettingsRevision, modelCapabilities: job.modelCapabilities || null, providerFingerprint: job.providerFingerprint || null,
    backgroundModelRevision: job.backgroundModelRevision ?? null, coordinatorRevision: job.coordinatorRevision ?? null,
    material, skills, signatures, episode: episode ? scrub(episode) : null, recordPins,
    sourceRefs: material.map(item => ({ id: item.sourceId, type: item.type, sha256: digest(item) })), coverage: { ...coverage, includedItems: material.length, includedBytes: bytes },
    authority: 'Immutable historical learning inputs. Temporal sequences, reviews and model output do not establish causation or verified findings.' };
  packet.id = hashBody(packet); packet.createdAt = now();
  const previous = getRecord(KIND, packet.id);
  if (previous) return previous;
  putRecord(KIND, packet.id, packet); return packet;
}
export function readLearningPacket(job) {
  const packet = job.packetId && getRecord(KIND, job.packetId);
  if (!packet || packet.id !== hashBody(packet) || packet.sessionId !== job.sessionId || packet.projectId !== job.projectId ||
    packet.goalId !== job.goalId || (packet.runId || null) !== (job.runId || null) || (packet.agentNamespace || null) !== (job.agentNamespace || null) || packet.throughSeq !== job.throughSeq ||
    packet.providerFingerprint !== (job.providerFingerprint || null) ||
    packet.selectionSource !== job.selectionSource || packet.selectionResolution !== job.selectionResolution || packet.modelSettingsRevision !== job.modelSettingsRevision ||
    packet.backgroundModelRevision !== (job.backgroundModelRevision ?? null) || packet.coordinatorRevision !== (job.coordinatorRevision ?? null) ||
    digest(packet.modelCapabilities) !== digest(job.modelCapabilities || null) ||
    digest(packet.selection) !== digest(job.selection || null)) fail('The learning source snapshot is unavailable or changed. Queue a fresh reviewed snapshot.');
  return packet;
}
