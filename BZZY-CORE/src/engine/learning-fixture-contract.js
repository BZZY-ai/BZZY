import { digest } from './database.js';

export const fixtureContracts = {
  'security-decision-v1': ['real', 'false_positive', 'inconclusive'],
  'procedure-review-v1': ['supported', 'unsafe', 'inconclusive'],
};
export const fixtureApprovalHash = value => digest({ contract: value.contract || 'security-decision-v1', cases: value.cases, sourceGroups: value.sourceGroups || [] });
export function assertHeldOutSources(candidate, dataset) {
  const authoring = candidate.update?.sourceGroups || [];
  if (!authoring.length) return;
  if (!Array.isArray(dataset.sourceGroups) || !dataset.sourceGroups.length || dataset.sourceGroups.some(group => authoring.includes(group))) {
    throw Object.assign(new Error('Learning updates require owner-approved held-out fixtures from source groups separate from the authoring episode.'), { code: 'FIXTURE_REVIEW_REQUIRED' });
  }
}
