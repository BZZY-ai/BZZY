import fs from 'node:fs';
import { createSession, loadSession, saveSession } from './store.js';
import { getProvider, selectionFromSession, modeDefault } from './providers.js';
import { database, events, getRecord, putRecord, appendEvent, listRecords } from './database.js';
import { artifact } from './evidence.js';
import { prepareTask } from './task.js';
import { newGoal } from './goals.js';
import { childPolicy } from './policy.js';
import { formatDecision } from './debate-format.js';
import { duration } from './format-duration.js';
import { configuredDebate, applyDebateSelection } from './debate-setup.js';
import { createMissionContext, missionSourceRevision, missionResultRevision, missionEvidenceCurrent, missionContextCurrent, sanitizeMissionValue } from './mission-context.js';
import { debateIdentity, latestDebateResult, appendDebateResultOnce } from './debate-events.js';
import { identityAlive } from './process-identity.js';
import { queueSessionCompaction } from './session-compactor.js';
import { recordGoalValidationStarted, recordGoalValidationResult } from './goal-validation.js';

function completionBoundary(source) {
  if (!source.goal || source.goal.status !== 'complete') return null;
  return database().prepare("SELECT seq,created_at AS createdAt FROM events WHERE session_id=? AND type='goal.completed' AND json_extract(data,'$.goalId')=? ORDER BY seq DESC LIMIT 1").get(source.id, source.goal.id) || null;
}
function sourceEvidence(source) {
  const selected = new Set(source.goal?.evidence || []), workers = new Set([source.id]);
  for (const job of listRecords('assignment', { parentSessionId: source.id })) if (job.goalId === source.goal?.id && job.workerSessionId) workers.add(job.workerSessionId);
  const references = (value, automatic = false) => {
    if (typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value)) {
      const item = getRecord('artifact', value);
      if (item && (!automatic || !source.goal || (item.goalId ? item.goalId === source.goal.id : !source.goal.createdAt || item.createdAt >= source.goal.createdAt))) selected.add(value);
    } else if (Array.isArray(value)) value.forEach(item => references(item, automatic));
    else if (value && typeof value === 'object') Object.values(value).forEach(item => references(item, automatic || value.provenance === 'backend-model-judgment'));
  };
  references(source.acceptance);
  const rows = database().prepare("SELECT data FROM records WHERE kind='artifact' AND json_extract(data,'$.sessionId') IN (SELECT value FROM json_each(?)) AND json_extract(data,'$.createdAt')>=? AND json_extract(data,'$.createdAt')<=? AND (json_extract(data,'$.goalId') IS NULL OR json_extract(data,'$.goalId')=?) LIMIT 4097").all(JSON.stringify([...workers]), source.goal?.createdAt || '', completionBoundary(source)?.createdAt || '9999', source.goal?.id || null);
  for (const row of rows) selected.add(JSON.parse(row.data).id);
  if (selected.size > 4096) throw new Error('The goal evidence inventory exceeds the bounded review limit. Select a bounded evidence bundle explicitly; no evidence was silently omitted.');
  const evidence = [...selected].map(id => {
    const item = getRecord('artifact', id);
    if (!item || !workers.has(item.sessionId)) throw new Error('The goal cites missing evidence or evidence outside this goal’s sessions.');
    return item;
  });
  if (!missionEvidenceCurrent(evidence)) throw new Error('The goal evidence is missing, altered or stale. Recheck it before starting validation.');
  return evidence;
}

export function defaultChatDebateAgents(source) {
  const preset = source.debateAgents || modeDefault('debate');
  if (preset) return configuredDebate({ debateAgents: preset });
  const selected = selectionFromSession(source);
  // Independence comes from separate worker conversations and evidence access,
  // rather than requiring additional provider subscriptions.
  return configuredDebate({ debateAgents: [selected, { ...selected }] });
}

export function chatReviewSourceCurrent(session) {
  if (!session.reviewSource) return true;
  const pin = session.reviewSource, source = loadSession(pin.sessionId);
  return Boolean(source && (source.goal?.id || null) === pin.goalId && missionSourceRevision(source) === pin.sourceRevision &&
    (source.goal?.status || 'reply') === pin.claimedStatus && (!pin.resultRevision || missionResultRevision(source) === pin.resultRevision) &&
    (!pin.missionContextId || missionContextCurrent(source, pin.missionContextId)));
}

export function latestReply(sessionId, { throughSeq = Infinity, afterTime } = {}) {
  let after = 0, question = '', text = '', finalReply = '', evidence = [];
  while (true) {
    const batch = events(sessionId, after, 1000);
    for (const event of batch) {
      after = event.seq;
      if (event.seq > throughSeq) break;
      if (afterTime && event.createdAt < afterTime) continue;
      if (event.type === 'message.user') { question = event.data.text; text = ''; finalReply = ''; evidence = []; }
      if (event.type === 'text') { text += event.data.text; evidence.push(event.seq); }
      if (event.type === 'backend' && event.data.method === 'item/completed' && event.data.params?.item?.type === 'agentMessage' && event.data.params.item.phase === 'final') finalReply = event.data.params.item.text || finalReply;
    }
    if (batch.length < 1000 || after >= throughSeq) break;
  }
  if (!text.trim()) throw new Error('There is no assistant reply to validate yet. Ask a question first, then use /validate.');
  return { question, text: finalReply || text, eventSequences: evidence };
}
export function prepareChatDebate(source, focus, participants, options = {}) {
  if (source.goal?.importedHistorical) throw new Error('This achieved goal is imported history. Start a local goal with reviewed scope and verification before checking its achieved claim.');
  const boundary = completionBoundary(source);
  let selected;
  if (boundary) {
    try { selected = latestReply(source.id, { throughSeq: boundary.seq, afterTime: source.goal.createdAt }); }
    catch { /* Legacy completions may precede their historical message export. */ }
  }
  selected ||= latestReply(source.id);
  const evidence = sourceEvidence(source);
  const sourceMission = createMissionContext(source, { purpose: 'goal-review', independent: true, evidenceIds: evidence.map(item => item.id) });
  const originalObjective = source.goal?.objective || focus || source.contract?.objective || selected.question;
  const session = createSession(getProvider(source.provider), source.cwd, source.model);
  const agents = options.debateAgents || participants?.length
    ? configuredDebate({ ...options, provider: source.provider, model: source.model || source.resolvedModel, effort: source.selectedEffort,
      participants, debateAgents: options.debateAgents }) : defaultChatDebateAgents(source);
  applyDebateSelection(session, agents);
  source.debateAgents = agents; saveSession(source);
  const objective = originalObjective || focus || 'Assess the preceding reply against the supplied user request.';
  prepareTask(session, { ...options, mode: 'debate' }, objective);
  if (source.contract) {
    session.contract.constraints = [...new Set([...source.contract.constraints, ...session.contract.constraints])];
    session.contract.scope = structuredClone(source.contract.scope || {});
    session.contract.acceptanceCriteria = structuredClone(source.contract.acceptanceCriteria);
    session.contract.artifacts = structuredClone(source.contract.artifacts || []);
    session.contract.verification = structuredClone(source.contract.verification || []);
    session.contract.context = JSON.stringify({ intent: 'Verify whether the reported achieved result satisfies the ORIGINAL goal and every requirement, using all recorded goal evidence. Preserve unsupported and inconclusive outcomes. A real vulnerability does not establish requested severity or impact.',
      originalMission: sourceMission.brief, reviewFocus: focus || null });
    const inherited = source.policy || source.contract.policy;
    session.contract.policy = childPolicy(inherited, options.contract ? session.policy : options.readOnly ? { ...inherited, mode: 'read-only' } : inherited);
    for (const [key, value] of Object.entries(source.contract.limits)) session.contract.limits[key] = Math.min(value, session.contract.limits[key] ?? value);
    session.policy = session.contract.policy; session.strictPolicy ||= source.strictPolicy;
    if (options.yolo && session.policy.mode === 'read-only') throw new Error('--yolo conflicts with this conversation’s read-only policy.');
  }
  session.parentSessionId = source.id; session.backendHomes = source.backendHomes; session.goal = newGoal(objective, options.tokenBudget);
  const copied = evidence.map(item => {
    const copy = artifact(session, fs.readFileSync(item.path), `review-source:${item.label}`, item.mediaType);
    Object.assign(copy, { importedFrom: item.id, importedSha256: item.sha256,
      ...(item.source ? { source: item.source, sourceWorkspace: item.sourceWorkspace, sourceSha256: item.sourceSha256 } : {}) });
    putRecord('artifact', copy.id, copy); return { id: copy.id, originalId: item.id, originalGoalId: item.goalId || null, originalCreatedAt: item.createdAt,
      sha256: copy.sha256, label: copy.label, size: copy.size };
  });
  session.reviewSource = { sessionId: source.id, goalId: source.goal?.id || null, objective, sourceRevision: missionSourceRevision(source),
    resultRevision: missionResultRevision(source), missionContextId: sourceMission.id, claimedStatus: source.goal?.status || 'reply', evidenceIds: copied.map(item => item.id) };
  const material = artifact(session, JSON.stringify(sanitizeMissionValue({ version: 1, originalGoal: source.goal || { objective },
    requirements: source.contract?.acceptanceCriteria || [], achievedClaim: selected.text, userRequest: selected.question,
    originalAcceptance: source.acceptance || null, evidence: copied, reviewFocus: focus || null,
    evidencePolicy: 'All inventoried evidence is available through read_artifact. Inspect every source item; report missing proof, contradictory controls and unsupported severity explicitly.' }), null, 2), 'debate-selected-reply');
  saveSession(session);
  appendEvent(source.id, 'debate.linked', { sessionId: session.id, sourceGoalId: source.goal?.id || null, objective, selectedArtifact: material.id, eventSequences: selected.eventSequences });
  try { recordGoalValidationStarted(session); } catch { /* A badge cannot change the original goal or prevent its review. */ }
  return { session, options: { ...options, mode: 'debate', debateAgents: agents, participants, rounds: options.rounds || 5, artifact: material.id, detach: false } };
}
export function finishChatDebate(sourceId, debateId) {
  const result = getRecord('debate', debateId), session = loadSession(debateId);
  const identity = result?.debateId || (session && debateIdentity(session)) || debateId;
  const final = latestDebateResult(debateId, identity), run = getRecord('run', debateId);
  if (!final && (listRecords('execution', { sessionId: debateId, states: ['queued', 'launching', 'starting', 'running', 'waiting_for_input'] }).length ||
      run && ['starting', 'running', 'waiting_for_input'].includes(run.state) && identityAlive(run.runner))) {
    return { pending: true, debateId: identity, sessionId: debateId, status: session?.goal?.status };
  }
  const decision = result?.decision || null;
  const elapsedSeconds = session?.goal?.runtimeUsedSeconds || 0, usage = session?.summary?.usage || result?.usage;
  const statistics = `${duration(elapsedSeconds)} · ${usage ? usage.totalTokens.toLocaleString() + (usage.complete ? ' tokens' : ' known tokens · usage incomplete') : 'usage unavailable'}`;
  const record = { debateId: identity, sessionId: debateId, status: session?.goal?.status,
    consensus: result?.consensus || result?.investigationConsensus || null, goalSatisfaction: result?.goalSatisfaction || 'inconclusive', decision, elapsedSeconds, usage, unresolvedDisagreement: result?.unresolvedDisagreement || [], evidence: session?.goal?.evidence || [],
    message: final?.message || `Validation ${session?.goal?.status === 'awaiting_review' ? 'finished · unresolved' : session?.goal?.status || 'interrupted'} · ${statistics}\nSession: ${debateId}\n${result?.consensus?.state === 'ready' ? `Core consensus\n${result.consensus.text}\n\n` : ''}${formatDecision(decision, result?.unresolvedDisagreement || [])}` };
  putRecord('conversation-debate', sourceId, record);
  appendDebateResultOnce(sourceId, final ? { ...final, sourceSessionId: sourceId, elapsedSeconds, usage } : record);
  try { recordGoalValidationResult(session); } catch { /* The checked review remains durable if its badge is unavailable. */ }
  try { queueSessionCompaction(sourceId); } catch { /* A derived index cannot alter the durable review result. */ }
  return record;
}
