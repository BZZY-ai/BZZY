import { database, getRecord, putRecord, transaction, digest, now } from './database.js';
import { inspectSkill, listSkills, skillVersionForDiagnostics, setSkillEnabled, activeSkillVersionPins } from './skills.js';
import { projectIdentityForSession } from './project-identity.js';
import fs from 'node:fs';

const fail = message => { throw Object.assign(new Error(message), { code: 'SKILL_CURATION_CONFLICT' }); };
const atomic = operation => database().isTransaction ? operation(database()) : transaction(operation);
const learned = item => ['learning', 'learning-update'].includes(item.provenance?.kind);
const page = (kind, skillId, projectId, limit = 60) => database().prepare(`SELECT data FROM records WHERE kind=?
  AND json_extract(data,'$.skillId')=? AND (? IS NULL OR json_extract(data,'$.projectId')=?)
  ORDER BY updated_at DESC,id LIMIT ?`).all(kind, skillId, projectId, projectId, limit).map(row => JSON.parse(row.data));

// Owner-facing diagnostics do not confer resource mutation or execution rights.
// Even a global method's feedback stays in the selected project's scope.
export function inspectSkillEvolution(identifier, { session } = {}) {
  const skill = inspectSkill(identifier, { session });
  const projectId = session ? projectIdentityForSession(session, { create: false })?.id : null;
  if (session && !projectId) fail('Select an initialized project.');
  const feedback = page('core.skill.feedback', skill.id, projectId), outcomes = page('core.skill.outcome', skill.id, projectId);
  return { skill, feedback, outcomes, updates: page('core.skill.update', skill.id, projectId),
    candidates: page('core.skill.candidate', skill.id, projectId), curation: page('core.skill.curation', skill.id, projectId),
    activePins: activeSkillVersionPins(skill.id, skill.version),
    summary: { feedbackCount: feedback.length, associatedOutcomes: outcomes.length,
      helpful: feedback.filter(item => item.kind === 'helpful').length,
      caution: 'Counts cover the most recent bounded records. Outcomes are associations, not measured skill efficacy. Infrequent use is not an archive recommendation.' } };
}

const securityPolicy = () => fs.readFileSync(new URL('../../assets/generation-security.txt', import.meta.url), 'utf8').trim();
function terms(item, session) {
  const text = skillVersionForDiagnostics(item.id, item.version, { session, file: 'SKILL.md', raw: true }).toString('utf8');
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').replaceAll(securityPolicy(), '');
  return new Set((body.toLowerCase().match(/[a-z0-9_-]{3,}/g) || []).slice(0, 6000));
}
// Deliberately advisory. Similarity can hide a critical scope or prerequisite;
// there is no merge/alias/archive operation in this automatic path.
export function suggestSkillCuration({ session, limit = 20 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) fail('Invalid curation suggestion limit.');
  const items = [], suggestions = [];
  for (let offset = 0; offset < 300; offset += 100) {
    const result = listSkills({ session, offset, limit: 100 });
    items.push(...result.skills.filter(item => learned(item) && !item.archived));
    if (result.nextOffset === null) break;
  }
  const entries = items.flatMap(item => { try { return [{ item, words: terms(item, session) }]; } catch { return []; } });
  for (let a = 0; a < entries.length && suggestions.length < limit; a++) for (let b = a + 1; b < entries.length && suggestions.length < limit; b++) {
    const left = entries[a], right = entries[b];
    if (left.item.scope !== right.item.scope || left.item.projectId !== right.item.projectId || Math.min(left.words.size, right.words.size) < 16) continue;
    const common = [...left.words].filter(word => right.words.has(word)).length;
    const score = common / (left.words.size + right.words.size - common);
    if (score < 0.82) continue;
    suggestions.push({ id: digest([left.item.id, left.item.version, right.item.id, right.item.version]), kind: 'similarity-review',
      skills: [left.item, right.item].map(item => ({ id: item.id, version: item.version, revision: item.revision })),
      score: Math.round(score * 1000) / 1000, action: 'advisory-only',
      caution: 'Compare prerequisites, scope, evidence and failure cases before any owner decision. Similarity is not equivalence; methods and immutable workflow pins remain separate.' });
  }
  return { suggestions, scanned: entries.length, limit: 300, automaticChanges: 0 };
}

// Called only by authenticated owner APIs; never exposed as a model tool.
export function curateSkill(identifier, { action, expectedRevision, requestId, reviewed, session } = {}) {
  if (reviewed !== true || !['archive', 'restore'].includes(action) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1 ||
      !/^[a-zA-Z0-9_.:-]{1,128}$/.test(requestId || '')) fail('Review the current skill revision and provide a stable curation request ID.');
  const selected = inspectSkill(identifier, { session });
  const id = digest([selected.id, requestId]), inputHash = digest([selected.id, action, expectedRevision]);
  return atomic(db => {
    const previous = getRecord('core.skill.curation', id);
    if (previous) { if (previous.inputHash !== inputHash) fail('Curation request conflicts with its earlier result.'); return previous; }
    const current = getRecord('core.skill', selected.id);
    if (!current || current.revision !== expectedRevision || current.version !== selected.version || current.scope !== 'project' || !learned(current)) fail('Only the current learned project method may be curated. Reload its revision.');
    if (activeSkillVersionPins(current.id, current.version).length) fail('Open workflow work units pin this version. Close them before curating it.');
    if (action === 'archive' && current.archived || action === 'restore' && !current.archived) fail('The archive state changed. Reload it.');
    const disabled = setSkillEnabled(current.id, false, current.revision, { session });
    const changed = { ...getRecord('core.skill', current.id), archived: action === 'archive',
      archivedAt: action === 'archive' ? now() : null };
    putRecord('core.skill', current.id, changed, db);
    const receipt = { id, inputHash, version: 1, skillId: current.id, projectId: current.projectId, skillVersion: current.version,
      action, previousRevision: current.revision, revision: disabled.revision, enabled: false, archived: changed.archived,
      reviewed: true, createdAt: now() };
    putRecord('core.skill.curation', id, receipt, db); return receipt;
  });
}
