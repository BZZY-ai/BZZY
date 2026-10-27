import { database, getRecord, putRecord, digest, now, transaction } from './database.js';
import { knowledgeAccess, allowedKnowledgeSessionIds, assertKnowledgeText, indexKnowledgeRecord, searchKnowledgeIndex, knowledgeDatabase } from './knowledge-index.js';
import { remember, memoryFreshness, knowledgeVerificationBudget } from './memory.js';
import { signatureApplies } from './error-signature.js';

const KIND = 'core.resolution', atomic = operation => database().isTransaction ? operation(database()) : transaction(operation);
const fail = message => { throw Object.assign(new Error(message), { code: 'RESOLUTION_SCOPE' }); };
const text = (value, maximum) => assertKnowledgeText(value, maximum);
const list = (value, maximum = 16) => {
  if (!Array.isArray(value) || value.length > maximum || value.some(item => typeof item !== 'string' || !item || item.length > 200)) fail('Use bounded resolution source references.');
  return [...new Set(value)];
};
function scope(session) {
  const access = knowledgeAccess(session);
  if (access.disabled || getRecord('session-deletion', session.id)) fail('Resolution knowledge is unavailable.');
  return { access, ids: allowedKnowledgeSessionIds(session, access) };
}
function signatureValue(value) {
  if (!value || typeof value !== 'object' || !/^[a-f0-9]{64}$/.test(value.signatureHash || '')) fail('A resolution needs a host-pinned error signature.');
  const signature = { schemaVersion: 1, signatureHash: value.signatureHash };
  for (const field of ['errorClass', 'errorCode', 'ecosystem', 'tool', 'platform', 'version']) {
    if (value[field] != null && (typeof value[field] !== 'string' || value[field].length > 120)) fail('Invalid typed error context.');
    signature[field] = value[field] ?? null;
  }
  signature.normalizedMessage = text(value.normalizedMessage || 'Unspecified failure', 1600);
  return signature;
}
function sourceAllowed(session, id, ids) {
  const match = /^([a-f0-9-]{36}):(\d+)$/.exec(id), artifact = getRecord('artifact', id);
  return Boolean(match && ids.includes(match[1]) && database().prepare('SELECT 1 FROM events WHERE session_id=? AND seq=?').get(match[1], Number(match[2]))
    || artifact && ids.includes(artifact.sessionId));
}

// The facet adds retrieval structure to an existing uncertain knowledge record.
// It cannot independently confirm a cause, refresh evidence or grant authority.
export function recordResolution(session, input, { requestId, learningJobId, packet } = {}) {
  const { access, ids } = scope(session);
  if (access.restricted) fail('Resolution publication belongs to the supervising project context.');
  const signature = signatureValue(input.signature), symptom = text(input.symptom, 1500), rootCause = text(input.rootCause || 'Cause not established.', 2000);
  if (!Array.isArray(input.fixSteps) || !input.fixSteps.length || input.fixSteps.length > 12) fail('A resolution needs 1–12 bounded proposed fix steps.');
  const fixSteps = input.fixSteps.map(value => text(value, 1500)), sourceIds = list(input.sourceIds), evidence = list(input.evidenceIds || []);
  const statement = text(`${symptom}\nProposed fix: ${fixSteps.join(' ')}`, 6000);
  if (!sourceIds.length || typeof requestId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(requestId)) fail('Resolution publication needs sources and an idempotency request ID.');
  const proposalHash = digest({ signature, symptom, rootCause, fixSteps, sourceIds, evidence, inputs: input.inputs || [], freshness: input.freshness || {} }), requestKey = `${session.id}:${requestId}`;
  const prior = getRecord('core.resolution.request', requestKey);
  if (prior) {
    if (prior.proposalHash !== proposalHash) fail('Resolution request ID was reused for different content.');
    return resolutionView(session, prior.resolutionId);
  }
  const job = learningJobId && getRecord('core.learning.job', learningJobId);
  if (learningJobId) {
    const storedPacket = packet?.id && getRecord('core.learning.packet', packet.id);
    if (job?.state !== 'running' || job.sessionId !== session.id || job.projectId !== access.project.id ||
      !packet || job.packetId !== packet.id || !storedPacket || digest(storedPacket) !== digest(packet) ||
      packet.sessionId !== session.id || packet.projectId !== access.project.id || packet.throughSeq !== job.throughSeq ||
      !packet.signatures?.some(value => digest(signatureValue(value)) === digest(signature)) || sourceIds.some(id => !job.sourceRefs?.some(ref => ref.id === id))) fail('Resolution publication must match the active learning packet.');
  } else if (sourceIds.some(id => !sourceAllowed(session, id, ids))) fail('Resolution source belongs to another engagement or is unavailable.');
  const memory = remember(session, { kind: 'hypothesis', truth: 'hypothesis',
    statement, rationale: rootCause, evidence,
    inputs: input.inputs || [], freshness: input.freshness || {}, requestId: `resolution-${digest(requestKey).slice(0, 48)}` },
  learningJobId ? { learningJobId, sourceIds } : {});
  return atomic(db => {
    scope(session);
    if (learningJobId && getRecord('core.learning.job', learningJobId)?.state !== 'running') fail('Learning stopped before resolution publication.');
    const concurrent = getRecord('core.resolution.request', requestKey);
    if (concurrent) {
      if (concurrent.proposalHash !== proposalHash) fail('Resolution request changed concurrently.');
      return resolutionView(session, concurrent.resolutionId);
    }
    const id = digest([session.id, requestId]), record = { version: 1, id, memoryId: memory.id, sessionId: session.id,
      projectId: access.project.id, agentNamespace: session.agentNamespace || null, signature, symptom, rootCause, fixSteps,
      sourceIds, evidenceIds: evidence, goalId: learningJobId ? job.goalId : session.goal?.id || null, learningJobId: learningJobId || null,
      proposalHash, createdAt: now(), claim: 'proposed-resolution; observed sequence is not verified causality' };
    putRecord(KIND, id, record, db); indexResolution(access.project, record, memory);
    putRecord('core.resolution.request', requestKey,
      { sessionId: session.id, resolutionId: id, proposalHash, createdAt: now() }, db);
    return resolutionView(session, id);
  });
}

export function resolutionView(session, id, { budget = knowledgeVerificationBudget() } = {}) {
  const { access, ids } = scope(session), facet = getRecord(KIND, id), parent = facet && getRecord('memory', facet.memoryId);
  if (!facet || facet.projectId !== access.project.id || !ids.includes(facet.sessionId) || !parent || parent.projectId !== access.project.id ||
      !ids.includes(parent.sessionId) || getRecord('session-deletion', facet.sessionId)) fail('Resolution is outside this authorized project context.');
  const current = memoryFreshness(parent, access.project, session, { budget });
  const recordedInputCount = current.inputs?.length || 0;
  const sourceArtifactCount = (current.evidence || []).filter(id => Boolean(getRecord('artifact', id)?.source)).length;
  const unknownInputCoverage = recordedInputCount === 0 && sourceArtifactCount === 0;
  return { ...facet, truth: current.truth, stale: current.stale, staleReasons: current.staleReasons,
    disputed: current.disputed, contradictions: current.contradictions, verification: current.verification,
    causeVerified: false, causeStatus: 'hypothesis', procedureTruth: current.truth,
    unknownInputCoverage, applicability: { recordedInputCount, sourceArtifactCount, version: facet.signature.version || null,
      versionKnown: Boolean(facet.signature.version), coverage: unknownInputCoverage ? 'unknown' : 'recorded-inputs-only',
      currentProjectValidated: false },
    authority: 'Historical proposed procedure. A later successful action does not prove causality, permission or present applicability.' };
}

function indexResolution(project, facet, parent) {
  const value = { ...facet, truth: parent.truth, stale: Boolean(parent.invalidatedAt), verification: parent.verification };
  indexKnowledgeRecord(project, 'resolution', facet.id, value.sessionId,
    `${value.signature.normalizedMessage}\n${value.symptom}\n${value.rootCause}\n${value.fixSteps.join('\n')}`, value);
}

export function refreshResolutionIndex(session) {
  const { access, ids } = scope(session), rows = knowledgeDatabase().prepare(`SELECT id FROM records WHERE kind=? AND json_extract(data,'$.projectId')=?
    AND json_extract(data,'$.sessionId') IN (SELECT value FROM json_each(?))
    AND NOT EXISTS (SELECT 1 FROM knowledge_documents d WHERE d.key=? || ':resolution:' || records.id)
    ORDER BY updated_at,id LIMIT 1000`).all(KIND, access.project.id, JSON.stringify(ids), access.project.id);
  for (const { id } of rows) {
    const facet = getRecord(KIND, id), parent = facet && getRecord('memory', facet.memoryId);
    if (!facet || !parent || parent.projectId !== access.project.id || !ids.includes(parent.sessionId) || getRecord('session-deletion', facet.sessionId)) continue;
    indexResolution(access.project, facet, parent);
  }
  return { indexed: rows.length, bounded: rows.length === 1000 };
}

export function lookupResolutions(session, { signature, query = '', limit = 4, includeStale = false } = {}) {
  const { access, ids } = scope(session);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 12 || typeof includeStale !== 'boolean') fail('Use a bounded resolution lookup.');
  const typed = signature ? signatureValue(signature) : null;
  refreshResolutionIndex(session);
  const result = searchKnowledgeIndex(access, ids, { query: (query || typed?.normalizedMessage || '').slice(0, 500), limit: 50, types: ['resolution'] });
  const hits = [];
  if (typed) for (const row of database().prepare(`SELECT id FROM records WHERE kind=? AND json_extract(data,'$.projectId')=?
    AND json_extract(data,'$.signature.signatureHash')=? AND json_extract(data,'$.sessionId') IN (SELECT value FROM json_each(?)) LIMIT 32`)
    .all(KIND, access.project.id, typed.signatureHash, JSON.stringify(ids))) hits.push({ sourceId: row.id, exact: true });
  hits.push(...result.items);
  const seen = new Set(), items = [], budget = knowledgeVerificationBudget();
  for (const hit of hits) {
    if (seen.has(hit.sourceId)) continue; seen.add(hit.sourceId);
    let value; try { value = resolutionView(session, hit.sourceId, { budget }); } catch { continue; }
    if (typed && !signatureApplies(value.signature, typed) || !includeStale && (value.stale || value.disputed)) continue;
    items.push({ ...value, match: hit.exact ? 'exact-signature' : 'lexical-context', memoryId: value.memoryId });
    if (items.length >= limit) break;
  }
  return { projectId: access.project.id, items, semanticVerification: false };
}

export function publishLearningResolutions(session, proposals, { jobId, packet, requestId = jobId } = {}) {
  if (!Array.isArray(proposals) || proposals.length > 4) fail('A review may propose at most four resolutions.');
  return proposals.map((proposal, index) => {
    if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal) || Object.keys(proposal).some(key => !['signatureHash', 'symptom', 'rootCause', 'fixSteps', 'sourceIds', 'evidenceIds'].includes(key))) fail('Resolution reviews may only propose evidence-linked symptom, cause and fix fields.');
    const signature = packet?.signatures?.find(value => value.signatureHash === proposal.signatureHash);
    if (!signature) fail('Resolution refers to a signature absent from its pinned learning packet.');
    return recordResolution(session, { ...proposal, signature }, { learningJobId: jobId, packet,
      requestId: `learn-resolution-${digest([requestId, index]).slice(0, 48)}` });
  });
}
