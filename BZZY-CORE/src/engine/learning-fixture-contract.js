import { digest, getRecord } from './database.js';

export const fixtureContracts = {
  'security-decision-v1': ['real', 'false_positive', 'inconclusive'],
  'procedure-review-v1': ['supported', 'unsafe', 'inconclusive'],
  'continuation-trace-v1': ['completed', 'blocked', 'inconclusive'],
};
export const fixtureApprovalHash = value => digest({ contract: value.contract || 'security-decision-v1', cases: value.cases, sourceGroups: value.sourceGroups || [] });
export function assertHeldOutSources(candidate, dataset) {
  const provenance = candidate.provenance || {}, job = provenance.jobId && getRecord('core.learning.job', provenance.jobId);
  const packetId = candidate.update?.packetId || job?.packetId, packet = packetId && getRecord('core.learning.packet', packetId);
  const authoring = [...new Set([
    ...(candidate.update?.sourceGroups || []), ...(candidate.update?.sourceIds || []),
    provenance.sourceSessionId, provenance.sourceGoalId, ...(provenance.sourceEventIds || []),
    ...(job ? [job.sessionId, job.goalId, job.runId, job.packetId, ...(job.sourceRefs || []).map(item => item.id)] : []),
    ...(packet ? [packet.id, packet.sessionId, packet.goalId, packet.runId, packet.episode?.sourceHash,
      ...(packet.sourceRefs || []).map(item => item.id)] : []),
  ].filter(value => typeof value === 'string' && value.length > 0))].sort();
  const fixtures = [...new Set((dataset.sourceGroups || []).filter(value => typeof value === 'string' && value.length > 0))].sort();
  const complete = Array.isArray(dataset.cases) && dataset.cases.length > 0 && dataset.cases.every(item =>
    typeof item.sourceGroup === 'string' && fixtures.includes(item.sourceGroup));
  // Session IDs also cover event groups beneath that conversation. A new
  // authoring attempt does not turn a reused conversation into held-out data.
  const overlap = fixtures.some(group => authoring.some(source => group === source || group.startsWith(source + ':')));
  if (overlap || candidate.update && (!authoring.length || !fixtures.length || !complete)) {
    throw Object.assign(new Error('Learning updates require owner-approved held-out fixtures from source groups separate from the authoring episode.'), { code: 'FIXTURE_REVIEW_REQUIRED' });
  }
  return { status: authoring.length && complete ? 'independent' : 'unknown',
    authoringSourceCount: authoring.length, fixtureSourceCount: fixtures.length,
    authoringSourcesHash: digest(authoring), fixtureSourcesHash: digest(fixtures) };
}
