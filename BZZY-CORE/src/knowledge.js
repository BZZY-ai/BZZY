import fs from 'node:fs';
import { home } from './engine/files.js';
import { loadSession } from './engine/store.js';
import { digest } from './engine/database.js';
import { projectIdentityForSession, relinkProjectIdentity } from './engine/project-identity.js';
import { searchProjectKnowledge, knowledgeContextFor, listKnowledgeProfiles, updateKnowledgeProfile,
  knowledgeProfileProposals, reviewKnowledgeProfileProposal, knowledgeProfileHistory, rollbackKnowledgeProfile } from './engine/knowledge.js';
import { reviewMemory, invalidateMemory, memoryHistory, rollbackMemory } from './engine/memory.js';
import { learningSettings, configureLearning, listLearningJobs, inspectLearningJob, controlLearningJob,
  queueLearningReview, learningUsage } from './engine/learning.js';
import { listSkillCandidates, inspectSkillCandidate, readSkillCandidate, acceptSkillCandidate, rejectSkillCandidate } from './engine/skills.js';
import { registerLearningFixtures, listLearningFixtures, inspectLearningFixtures, revokeLearningFixtures, queueLearningEvaluation, inspectLearningEvaluation } from './engine/learning-evaluation.js';

const fail = message => { throw new Error(message); };
const shape = (input, fields) => {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !fields.includes(key))) fail('Invalid knowledge operation fields.');
};

// Privileged LOCAL host API, like BzzyCore/CoreAgents. Models receive only the
// scoped search/remember tools, never this administration object or dispatcher.
export class CoreKnowledge {
  #home = home();
  #check() { if (home() !== this.#home) fail('BZZY_HOME changed. Use a separate knowledge instance for each host.'); }
  context({ sessionId, cwd } = {}) {
    this.#check();
    if (sessionId) {
      const session = loadSession(sessionId);
      if (!session) fail('This conversation is unavailable.');
      return session;
    }
    if (typeof cwd !== 'string') fail('Choose a conversation or project directory.');
    const root = fs.realpathSync(cwd);
    if (!fs.statSync(root).isDirectory()) fail('Project directory is unavailable.');
    return { id: `owner-knowledge-${digest(root).slice(0, 24)}`, cwd: root };
  }
  request(operation, input = {}) {
    this.#check();
    const contextFields = ['sessionId', 'cwd'];
    const scoped = fields => { shape(input, [...contextFields, ...fields]); return this.context(input); };
    switch (operation) {
      case 'status': {
        const session = scoped([]), project = projectIdentityForSession(session);
        return { project: { id: project.id, root: project.root }, brief: knowledgeContextFor(session),
          settings: learningSettings(), usage: learningUsage(), jobs: input.sessionId ? listLearningJobs(session) : [] };
      }
      case 'search': {
        const session = scoped(['query', 'limit', 'offset', 'types', 'includeStale']);
        const { sessionId, cwd, ...query } = input;
        return searchProjectKnowledge(session, query);
      }
      case 'profiles': shape(input, []); return { profiles: listKnowledgeProfiles() };
      case 'profile.update': {
        shape(input, ['target', 'text', 'expiresAt', 'expectedRevision', 'reviewed']);
        if (input.reviewed !== true) fail('Review the profile before saving it.');
        return updateKnowledgeProfile(input.target, { text: input.text, expiresAt: input.expiresAt }, { expectedRevision: input.expectedRevision, explicit: true });
      }
      case 'profile.proposals': shape(input, ['offset', 'limit']); return knowledgeProfileProposals(input);
      case 'profile.history': shape(input, ['target', 'offset', 'limit']); return knowledgeProfileHistory(input.target, input);
      case 'profile.rollback':
        shape(input, ['target', 'fromRevision', 'expectedRevision', 'reviewed']);
        return rollbackKnowledgeProfile(input.target, { ...input, explicit: input.reviewed === true });
      case 'profile.review': shape(input, ['id', 'expectedRevision', 'action', 'reviewed']);
        if (input.reviewed !== true) fail('Review the exact profile proposal first.');
        return reviewKnowledgeProfileProposal(input.id, { ...input, explicit: true });
      case 'memory.review': {
        const session = scoped(['id', 'truth', 'expectedRevision', 'rationale', 'reviewed']);
        return reviewMemory(session, input.id, { ...input, explicit: input.reviewed === true });
      }
      case 'memory.invalidate': {
        const session = scoped(['id', 'reason', 'expectedRevision']);
        return invalidateMemory(input.id, input.reason, { session, expectedRevision: input.expectedRevision });
      }
      case 'memory.history': return memoryHistory(scoped(['id', 'offset', 'limit']), input.id, input);
      case 'memory.rollback': return rollbackMemory(scoped(['id', 'fromRevision', 'expectedRevision', 'reviewed']), input.id, { ...input, explicit: input.reviewed === true });
      case 'project.relink': shape(input, ['cwd', 'projectId', 'expectedRoot', 'reviewed']);
        return relinkProjectIdentity(input.cwd, { ...input, explicit: input.reviewed === true });
      case 'learning.list': return listLearningJobs(scoped(['limit']), { limit: input.limit });
      case 'learning.inspect': return inspectLearningJob(input.id, { session: scoped(['id']) });
      case 'learning.queue': return queueLearningReview(scoped(['requestId']), { reason: 'explicit', sourceId: 'owner-review', requestId: input.requestId });
      case 'learning.control': return controlLearningJob(input.id, input.action, { session: scoped(['id', 'action', 'expectedRevision']), expectedRevision: input.expectedRevision });
      case 'learning.settings':
        shape(input, ['settings', 'expectedRevision', 'reviewed']);
        if (input.reviewed !== true) fail('Review learning settings before saving.');
        return configureLearning(input.settings, { expectedRevision: input.expectedRevision });
      case 'candidates': return listSkillCandidates({ session: scoped(['offset', 'limit', 'state']), offset: input.offset, limit: input.limit, state: input.state });
      case 'candidate.inspect': return inspectSkillCandidate(input.id, { session: scoped(['id']) });
      case 'candidate.read': return readSkillCandidate(input.id, { session: scoped(['id', 'file', 'offset', 'limit']), file: input.file, offset: input.offset, limit: input.limit });
      case 'candidate.reject': return rejectSkillCandidate(input.id, input.expectedRevision, { session: scoped(['id', 'expectedRevision']) });
      case 'candidate.accept': {
        const session = scoped(['id', 'expectedRevision', 'expectedSkillRevision', 'expectedEvaluationId', 'reviewed', 'activate']);
        return acceptSkillCandidate(input.id, input, { session });
      }
      case 'fixtures.list': return listLearningFixtures(scoped([]));
      case 'fixtures.inspect': return inspectLearningFixtures(input.id, { session: scoped(['id', 'includeCases']), includeCases: input.includeCases === true });
      case 'fixtures.revoke': return revokeLearningFixtures(input.id, { session: scoped(['id', 'expectedRevision']), expectedRevision: input.expectedRevision });
      case 'fixtures.register': {
        const session = scoped(['definition', 'scope', 'reviewed', 'requestId']);
        return registerLearningFixtures(input.definition, { session, scope: input.scope, reviewed: input.reviewed, requestId: input.requestId });
      }
      case 'candidate.evaluate': {
        const session = scoped(['id', 'datasetId', 'expectedRevision', 'requestId']);
        return queueLearningEvaluation(input.id, { session, datasetId: input.datasetId, expectedRevision: input.expectedRevision, requestId: input.requestId });
      }
      case 'evaluation.inspect': return inspectLearningEvaluation(input.id, { session: scoped(['id']) });
      default: fail('Unknown knowledge operation.');
    }
  }
}
