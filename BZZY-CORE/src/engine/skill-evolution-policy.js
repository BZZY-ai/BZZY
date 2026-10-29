import { database, getRecord, putRecord, transaction, now, digest } from './database.js';
import { fixtureApprovalHash } from './learning-fixture-contract.js';

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
      Object.keys(patch).some(key => !['newSkills', 'updates', 'updateEvaluation'].includes(key)) ||
      patch.newSkills !== undefined && !['auto', 'stage', 'off'].includes(patch.newSkills) ||
      patch.updates !== undefined && !['auto', 'stage', 'off'].includes(patch.updates)) fail('Review an explicit skill evolution policy. Automatic updates require approved semantic and continuation fixtures.');
  return transaction(db => {
    const previous = skillEvolutionSettings();
    if (previous.revision !== expectedRevision) fail('Skill evolution policy changed. Reload its revision.');
    const selection = patch.updateEvaluation === undefined ? previous.updateEvaluation : pinUpdateEvaluation(patch.updateEvaluation);
    if ((patch.updates || previous.updates) === 'auto' && !selection) fail('Select reviewed semantic and continuation fixtures before enabling automatic updates.');
    if ((patch.updates || previous.updates) === 'auto') for (const pin of [selection.semantic, selection.continuation]) currentEvolutionFixture(pin);
    const record = { ...previous, ...patch, ...(selection ? { updateEvaluation: selection } : {}), revision: previous.revision + 1, reviewed: true, updatedAt: now() };
    putRecord(kind, 'owner', record, db); return record;
  });
}

export function currentEvolutionFixture(pin) {
  const value = pin?.id && getRecord('core.learning.fixtures', pin.id);
  if (!value || !value.reviewed || value.revokedAt || value.revision !== pin.revision || value.hash !== pin.hash ||
      digest(value.cases) !== pin.hash || value.approvalHash !== pin.approvalHash || fixtureApprovalHash(value) !== pin.approvalHash ||
      (value.contract || 'security-decision-v1') !== pin.contract || (value.projectId || null) !== pin.projectId ||
      (value.agentNamespace || null) !== pin.agentNamespace) fail('Automatic update fixture approval changed; review the evolution policy again.');
  return value;
}

function pinUpdateEvaluation(selection) {
  if (!selection || typeof selection !== 'object' || Array.isArray(selection) ||
      Object.keys(selection).some(key => !['semanticDatasetId', 'continuationDatasetId'].includes(key))) fail('Select semanticDatasetId and continuationDatasetId.');
  const pin = (id, continuation) => {
    const value = typeof id === 'string' && getRecord('core.learning.fixtures', id);
    const contract = value?.contract || 'security-decision-v1';
    if (!value || continuation !== (contract === 'continuation-trace-v1') || !['security-decision-v1', 'procedure-review-v1', 'continuation-trace-v1'].includes(contract)) fail('Select semantic and continuation fixtures with their matching contracts.');
    const result = { id: value.id, revision: value.revision, hash: value.hash, approvalHash: value.approvalHash,
      contract, projectId: value.projectId || null, agentNamespace: value.agentNamespace || null };
    currentEvolutionFixture(result); return result;
  };
  const semantic = pin(selection.semanticDatasetId, false), continuation = pin(selection.continuationDatasetId, true);
  if (semantic.projectId !== continuation.projectId || semantic.agentNamespace !== continuation.agentNamespace) fail('Automatic update fixtures must share one reviewed scope.');
  return { semantic, continuation };
}
