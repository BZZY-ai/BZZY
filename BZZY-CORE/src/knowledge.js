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
import { readSessionMemory, expandSessionMemory, resetSessionMemory } from './engine/session-memory.js';
import { sessionCompactionStatus, queueSessionCompaction, controlSessionCompaction, configureSessionCompaction } from './engine/session-compactor.js';
import { episodeMaterial, episodeStatus } from './engine/episode.js';
import { readKnowledgeSource } from './engine/knowledge-index.js';
import { lookupResolutions, resolutionView } from './engine/resolutions.js';
import { projectFactsView, configureProjectFacts } from './engine/project-facts.js';
import { inspectSkillEvolution, suggestSkillCuration, curateSkill } from './engine/skill-curation.js';
import { readLearningPacket } from './engine/learning-packet.js';
import { skillEvolutionSettings, configureSkillEvolution } from './engine/skill-evolution-policy.js';
import { configureRetrieval, refreshLocalEmbeddings, retrievalQualityStatus, benchmarkRetrieval } from './engine/retrieval-quality.js';
import { programScopeOperation } from './engine/program-scope.js';
import { sessionMemoryDocument, exportSessionMemoryDocument } from './engine/session-memory-document.js';

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
    const historyScoped = fields => {
      shape(input, ['sessionId', ...fields]);
      if (typeof input.sessionId !== 'string' || !input.sessionId.trim()) fail('Choose a saved terminal conversation for session memory.');
      return this.context(input);
    };
    if (['scope.status', 'scope.inspect', 'scope.propose', 'scope.approve', 'scope.revoke', 'scope.continue'].includes(operation)) {
      if (typeof input.sessionId !== 'string' || !input.sessionId.trim() || input.cwd !== undefined) fail('Choose a saved terminal session for scope changes.');
      const { sessionId, ...fields } = input;
      return programScopeOperation(operation, fields, { session: this.context({ sessionId }) });
    }
    switch (operation) {
      case 'session-memory.status': return sessionCompactionStatus(historyScoped([]));
      case 'session-memory.document': return sessionMemoryDocument(historyScoped([]));
      case 'session-memory.export': return exportSessionMemoryDocument(historyScoped(['expectedRevision']), input);
      case 'session-memory.read': return readSessionMemory(historyScoped(['maxBytes', 'limit', 'query', 'recent']), input);
      case 'session-memory.expand': return expandSessionMemory(historyScoped(['id', 'offset', 'limit']), input);
      case 'session-memory.queue': return queueSessionCompaction(historyScoped([]), { force: true });
      case 'session-memory.rebuild': {
        const session = historyScoped(['expectedGeneration', 'reviewed']);
        if (input.reviewed !== true || typeof input.expectedGeneration !== 'string') fail('Review the current memory generation before rebuilding.');
        resetSessionMemory(session, { expectedGeneration: input.expectedGeneration });
        return queueSessionCompaction(session, { force: true });
      }
      case 'session-memory.control': return controlSessionCompaction(historyScoped(['action', 'expectedRevision']), input.action, { expectedRevision: input.expectedRevision });
      case 'session-memory.settings':
        shape(input, ['settings', 'expectedRevision', 'reviewed']);
        if (input.reviewed !== true) fail('Review the compactor budget settings before saving.');
        return configureSessionCompaction(input.settings, { expectedRevision: input.expectedRevision });
      case 'status': {
        const session = scoped([]), project = projectIdentityForSession(session);
        return { project: { id: project.id, root: project.root }, brief: knowledgeContextFor(session),
          settings: learningSettings(), evolution: skillEvolutionSettings(), usage: learningUsage(), facts: projectFactsView(session),
          episode: input.sessionId ? episodeStatus(session) : null, jobs: input.sessionId ? listLearningJobs(session) : [] };
      }
      case 'episode.status': return episodeStatus(historyScoped([]));
      case 'episode.read': return episodeMaterial(historyScoped(['throughSeq', 'goalId', 'runId', 'maxBytes']), input);
      case 'source.read': return readKnowledgeSource(scoped(['sourceId', 'sha256', 'offset', 'limit']), input);
      case 'resolutions.search': return lookupResolutions(scoped(['query', 'signature', 'limit', 'includeStale']), input);
      case 'resolution.inspect': return resolutionView(scoped(['id']), input.id);
      case 'retrieval.status': return retrievalQualityStatus(scoped([]));
      case 'retrieval.configure': return configureRetrieval(scoped(['settings', 'expectedRevision', 'reviewed']), input.settings,
        { expectedRevision: input.expectedRevision, reviewed: input.reviewed });
      case 'retrieval.refresh': return refreshLocalEmbeddings(scoped(['limit']), { limit: input.limit });
      case 'retrieval.benchmark': {
        const session = scoped(['cases', 'k', 'latencyBudgetMs', 'minRecall', 'minPrecision', 'expandSources']);
        if (input.expandSources !== undefined && typeof input.expandSources !== 'boolean') fail('Choose whether to inspect expanded held-out sources.');
        return benchmarkRetrieval({ cases: input.cases, k: input.k, latencyBudgetMs: input.latencyBudgetMs,
          minRecall: input.minRecall, minPrecision: input.minPrecision,
          search: query => searchProjectKnowledge(session, query),
          ...(input.expandSources ? { expand: hit => hit.kind === 'chat' && hit.sha256 ? readKnowledgeSource(session,
            { sourceId: hit.sourceId, sha256: hit.sha256, limit: 8192 }) : { text: hit.statement || '' } } : {}) });
      }
      case 'facts.read': return projectFactsView(scoped(['maxBytes', 'limit']), input);
      case 'facts.configure': return configureProjectFacts(scoped(['settings', 'expectedRevision', 'reviewed']), input.settings,
        { expectedRevision: input.expectedRevision, reviewed: input.reviewed });
      case 'skill.evolution': return inspectSkillEvolution(input.id, { session: scoped(['id']) });
      case 'skill.evolution.settings': {
        shape(input, ['settings', 'expectedRevision', 'reviewed']);
        return configureSkillEvolution(input.settings, { expectedRevision: input.expectedRevision, reviewed: input.reviewed });
      }
      case 'skill.curation.suggest': return suggestSkillCuration({ session: scoped(['limit']), limit: input.limit });
      case 'skill.curation': return curateSkill(input.id, { ...input, session: scoped(['id', 'action', 'expectedRevision', 'requestId', 'reviewed']) });
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
      case 'learning.packet': {
        const session = scoped(['id']), job = inspectLearningJob(input.id, { session });
        return readLearningPacket(job);
      }
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
