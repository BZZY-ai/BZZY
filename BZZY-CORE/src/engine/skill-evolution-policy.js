import { database, getRecord, putRecord, transaction, now } from './database.js';

const kind = 'core.skill.evolution.settings';
const fail = message => { throw Object.assign(new Error(message), { code: 'SKILL_EVOLUTION_POLICY' }); };
export function skillEvolutionSettings() {
  const stored = getRecord(kind, 'owner');
  if (stored) return stored;
  const legacy = Boolean(database().prepare("SELECT 1 FROM records WHERE kind='core.learning.skill-publication' AND json_extract(data,'$.state')='published' LIMIT 1").get());
  return { id: 'owner', version: 1, revision: 0, newSkills: 'stage', updates: 'stage',
    migration: { priorAutomaticPublication: legacy, behavior: 'New proposals now stage for owner review; existing skills and enable decisions are preserved. Automatic creation requires explicit reviewed opt-in.' } };
}
export function configureSkillEvolution(patch, { expectedRevision, reviewed } = {}) {
  if (reviewed !== true || !patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length ||
      Object.keys(patch).some(key => !['newSkills', 'updates'].includes(key)) ||
      patch.newSkills !== undefined && !['auto', 'stage', 'off'].includes(patch.newSkills) ||
      patch.updates !== undefined && !['stage', 'off'].includes(patch.updates)) fail('Review an explicit skill evolution policy. Updates support staged review or off.');
  return transaction(db => {
    const previous = skillEvolutionSettings();
    if (previous.revision !== expectedRevision) fail('Skill evolution policy changed. Reload its revision.');
    const record = { ...previous, ...patch, revision: previous.revision + 1, reviewed: true, updatedAt: now() };
    putRecord(kind, 'owner', record, db); return record;
  });
}
