import { database, getRecord, putRecord, digest, now, transaction, appendEvent } from './database.js';
import { inspectSkill, skillVersionForDiagnostics, stageSkillTextUpdate } from './skills.js';
import { projectIdentityForSession } from './project-identity.js';
import { sanitizeLearningText } from './learning.js';
import { home, readJson } from './files.js';
import path from 'node:path';
import { skillEvolutionSettings } from './skill-evolution-policy.js';

const atomic = operation => database().isTransaction ? operation(database()) : transaction(operation);
const fail = message => { throw Object.assign(new Error(message), { code: 'SKILL_UPDATE_SCOPE' }); };
const shape = (value, fields) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => fields.includes(key));
const bounded = (value, max) => typeof value === 'string' && Buffer.byteLength(value) <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) && sanitizeLearningText(value) === value;
function source(session) {
  const saved = session?.id && getRecord('session', session.id);
  if (!saved || getRecord('session-deletion', session.id) || ['cwd', 'projectRoot', 'parentSessionId', 'role'].some(key => (session[key] ?? null) !== (saved[key] ?? null))) fail('The skill source session is unavailable or changed.');
  return saved;
}

// Trusted queue-time snapshot: only actually loaded, currently enabled scoped
// versions are eligible. Whole files are omitted rather than clipped.
export function snapshotLearningSkills(session, { throughSeq, runId, maxBytes = 12000 } = {}) {
  const saved = source(session), db = database();
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 512 || maxBytes > 48000) fail('Invalid skill snapshot budget.');
  throughSeq ??= db.prepare('SELECT coalesce(max(seq),0) AS seq FROM events WHERE session_id=?').get(saved.id).seq;
  const rows = db.prepare(`SELECT DISTINCT r.data FROM records r JOIN events e ON e.type='core.usage' AND e.data=r.data
    WHERE r.kind='core.usage' AND json_extract(r.data,'$.sessionId')=? AND e.seq<=?
    AND (? IS NULL OR json_extract(r.data,'$.runId')=?) ORDER BY r.updated_at DESC LIMIT 32`).all(saved.id, throughSeq, runId || null, runId || null);
  const items = [], seen = new Set(); let bytes = 0, omitted = 0;
  for (const row of rows) {
    const use = JSON.parse(row.data), key = `${use.skillId}:${use.skillVersion}`;
    if (seen.has(key)) continue; seen.add(key);
    try {
      const current = inspectSkill(use.skillId, { session: saved });
      if (!current.enabled || current.version !== use.skillVersion || current.id !== use.skillId) { omitted++; continue; }
      const metadata = skillVersionForDiagnostics(use.skillId, use.skillVersion, { session: saved });
      const raw = skillVersionForDiagnostics(use.skillId, use.skillVersion, { session: saved, file: 'SKILL.md', raw: true });
      const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
      if (!bounded(text, maxBytes)) { omitted++; continue; }
      const item = { skillId: current.id, name: current.name, scope: current.scope, ...(current.projectId ? { projectId: current.projectId } : {}),
        version: current.version, revision: current.revision, enabled: true,
        sourceId: `skill:${digest([use.skillId, use.skillVersion])}`, usageId: use.id, runId: use.runId, goalId: use.goalId || null,
        files: [{ path: 'SKILL.md', text, bytes: raw.length, sha256: digest(raw) }] };
      for (const file of metadata.files.filter(file => /^references\/.*\.(?:md|txt)$/.test(file.path)).slice(0, 4)) {
        const read = db.prepare(`SELECT 1 FROM events WHERE session_id=? AND type='skill.loaded' AND seq<=?
          AND json_extract(data,'$.usageId')=? AND json_extract(data,'$.file')=? LIMIT 1`).get(saved.id, throughSeq, use.id, file.path);
        if (!read || file.bytes > 4096) continue;
        const data = skillVersionForDiagnostics(use.skillId, use.skillVersion, { session: saved, file: file.path, raw: true });
        const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
        if (bounded(text, 4096)) item.files.push({ path: file.path, text, bytes: data.length, sha256: digest(data) });
      }
      const size = Buffer.byteLength(JSON.stringify(item));
      if (bytes + size > maxBytes) { omitted++; continue; }
      items.push(item); bytes += size;
    } catch { omitted++; }
  }
  return { items, bytes, omitted };
}

export function stageLearningSkillUpdates(session, updates, { jobId, packet, requestId = jobId } = {}) {
  if (!Array.isArray(updates) || updates.length > 2) fail('A review may propose at most two skill updates.');
  const saved = source(session), job = getRecord('core.learning.job', jobId);
  if (!job || job.sessionId !== saved.id || job.state !== 'running' || !packet?.id || job.packetId !== packet.id ||
      digest(getRecord('core.learning.packet', packet.id)) !== digest(packet) || packet.sessionId !== saved.id ||
      packet.projectId !== projectIdentityForSession(saved).id) fail('Skill updates require the exact active learning job and immutable source packet.');
  const allowed = new Set((packet.sourceRefs || []).map(item => item.id));
  return updates.map((update, index) => atomic(db => {
    source(saved);
    const live = getRecord('core.learning.job', jobId);
    if (live?.state !== 'running' || live.packetId !== packet.id || getRecord('core.learning.settings', 'owner')?.enabled === false ||
        readJson(path.join(home(), 'runtime', 'operator-stop.json'), null)?.stopped || ['paused', 'cancelled'].includes(getRecord('session', saved.id)?.executionState) ||
        db.prepare("SELECT 1 FROM records WHERE kind='execution' AND json_extract(data,'$.sessionId')=? AND json_extract(data,'$.state') IN ('queued','launching','running') AND json_extract(data,'$.stopAction') IN ('pause','cancel') LIMIT 1").get(saved.id)) fail('Learning was stopped or changed.');
    if (!shape(update, ['skillId', 'baseVersion', 'baseRevision', 'rationale', 'sourceIds', 'ops']) ||
        !bounded(update.rationale, 2000) || !update.rationale.trim() || !Array.isArray(update.sourceIds) || !update.sourceIds.length ||
        update.sourceIds.length > 12 || update.sourceIds.some(id => !allowed.has(id)) || !Array.isArray(update.ops) || !update.ops.length || update.ops.length > 8) fail('Invalid skill update or source references.');
    const id = digest([saved.id, requestId, index]), inputHash = digest({ update, packetId: packet.id }), previous = getRecord('core.skill.update', id);
    if (previous) { if (previous.inputHash !== inputHash) fail('Skill update request conflicts with earlier content.'); return previous; }
    const base = packet.skills?.find(item => item.skillId === update.skillId && item.version === update.baseVersion && item.revision === update.baseRevision);
    if (!base || !update.sourceIds.includes(base.sourceId)) fail('The exact skill base and its source reference must be present in the reviewed packet.');
    const policy = skillEvolutionSettings();
    if (policy.updates === 'off') {
      const receipt = { id, version: 1, inputHash, sessionId: saved.id, projectId: packet.projectId, jobId,
        packetId: packet.id, skillId: base.skillId, baseVersion: base.version, baseRevision: base.revision,
        candidateId: null, candidateVersion: null, state: 'off', policyRevision: policy.revision, createdAt: now() };
      putRecord('core.skill.update', id, receipt, db); appendEvent(saved.id, 'learning.skill-update-skipped', receipt, db); return receipt;
    }
    const current = inspectSkill(base.skillId, { session: saved });
    if (!current.enabled || current.version !== base.version || current.revision !== base.revision) fail('The skill changed or was disabled after the packet was captured.');
    const files = new Map((base.files || []).map(file => {
      if (!bounded(file.text, 128 * 1024) || digest(Buffer.from(file.text)) !== file.sha256 || Buffer.byteLength(file.text) !== file.bytes) fail('The captured skill file changed or was redacted.');
      return [file.path, file.text];
    })), changed = new Map();
    for (const operation of update.ops) {
      if (!shape(operation, ['op', 'path', 'find', 'replace', 'heading', 'text'])) fail('Invalid skill update operation.');
      const path = operation.path || 'SKILL.md';
      if (operation.op === 'replace_text') {
        const text = changed.get(path) ?? files.get(path);
        if (text === undefined || !bounded(operation.find, 12000) || !operation.find || !bounded(operation.replace, 12000) || text.split(operation.find).length !== 2) fail('Skill replacement requires exactly one match in a complete captured base file.');
        changed.set(path, text.replace(operation.find, operation.replace));
      } else if (operation.op === 'append_section') {
        if (path !== 'SKILL.md' || !bounded(operation.heading, 120) || !operation.heading.trim() || /[\r\n]/.test(operation.heading) || !bounded(operation.text, 12000)) fail('Invalid skill section.');
        changed.set(path, (changed.get(path) ?? files.get(path)) + `\n\n## ${operation.heading.trim()}\n\n${operation.text.trim()}\n`);
      } else if (operation.op === 'write_reference') {
        if (!/^references\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\.(?:md|txt)$/.test(path) || !bounded(operation.text, 12000) || current.files.some(file => file.path === path) && !files.has(path)) fail('Only new or fully captured safe text references can be proposed.');
        changed.set(path, operation.text);
      } else fail('Unsupported skill update operation. Scripts and assets cannot be edited.');
    }
    const candidate = stageSkillTextUpdate(base.skillId, [...changed].map(([path, text]) => ({ path, text })), {
      session: saved, baseVersion: base.version, expectedRevision: base.revision, requestId: id,
      provenance: { kind: 'learning-update', jobId, sourceSessionId: saved.id, sourceSkillId: base.skillId, sourceVersion: base.version },
      update: { packetId: packet.id, rationale: update.rationale, sourceIds: update.sourceIds,
        sourceGroups: [...new Set([packet.id, packet.runId, packet.goalId, base.runId, base.goalId, base.usageId, packet.episode?.sourceHash].filter(Boolean))],
        policy: 'staged-only-v1', operations: update.ops.map(op => ({ op: op.op, path: op.path || 'SKILL.md' })) } });
    const result = { id, version: 1, inputHash, sessionId: saved.id, projectId: packet.projectId, jobId,
      packetId: packet.id, skillId: base.skillId, baseVersion: base.version, baseRevision: base.revision,
      candidateId: candidate.id, candidateVersion: candidate.version, state: 'staged', policyRevision: policy.revision, createdAt: now() };
    putRecord('core.skill.update', id, result, db); appendEvent(saved.id, 'learning.skill-update-staged', result, db); return result;
  }));
}
