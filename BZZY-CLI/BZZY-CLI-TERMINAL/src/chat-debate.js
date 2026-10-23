import { createSession, loadSession, saveSession } from './store.js';
import { getProvider } from './providers.js';
import { events, getRecord, putRecord, appendEvent } from './database.js';
import { artifact } from './evidence.js';
import { prepareTask } from './task.js';
import { newGoal } from './goals.js';
import { childPolicy } from './policy.js';
import { formatDecision } from './debate-format.js';
import { duration } from './terminal-format.js';
import { configuredDebate, applyDebateSelection } from './debate-setup.js';

export function latestReply(sessionId) {
  let after = 0, question = '', text = '', finalReply = '', evidence = [];
  while (true) {
    const batch = events(sessionId, after, 1000);
    for (const event of batch) {
      after = event.seq;
      if (event.type === 'message.user') { question = event.data.text; text = ''; finalReply = ''; evidence = []; }
      if (event.type === 'text') { text += event.data.text; evidence.push(event.seq); }
      if (event.type === 'backend' && event.data.method === 'item/completed' && event.data.params?.item?.type === 'agentMessage' && event.data.params.item.phase === 'final') finalReply = event.data.params.item.text || finalReply;
    }
    if (batch.length < 1000) break;
  }
  if (!text.trim()) throw new Error('There is no assistant reply to debate yet. Ask a question first, then use /debate.');
  return { question, text: finalReply || text, eventSequences: evidence };
}
export function prepareChatDebate(source, focus, participants, options = {}) {
  const selected = latestReply(source.id);
  const material = artifact(source, `USER REQUEST\n${selected.question}\n\nASSISTANT REPLY\n${selected.text}`, 'debate-selected-reply');
  const session = createSession(getProvider(source.provider), source.cwd, source.model);
  const agents = configuredDebate({ ...options, provider: source.provider, model: source.model, effort: source.selectedEffort,
    participants, debateAgents: options.debateAgents });
  applyDebateSelection(session, agents);
  source.debateAgents = agents; saveSession(source);
  const objective = focus || `Assess the claims in the preceding reply to: ${selected.question.slice(0, 200)}`;
  prepareTask(session, { ...options, mode: 'debate' }, objective);
  if (source.contract) {
    session.contract.constraints = [...new Set([...source.contract.constraints, ...session.contract.constraints])];
    session.contract.scope = structuredClone(source.contract.scope || {});
    const inherited = source.policy || source.contract.policy;
    session.contract.policy = childPolicy(inherited, options.contract ? session.policy : options.readOnly ? { ...inherited, mode: 'read-only' } : inherited);
    for (const [key, value] of Object.entries(source.contract.limits)) session.contract.limits[key] = Math.min(value, session.contract.limits[key] ?? value);
    session.policy = session.contract.policy; session.strictPolicy ||= source.strictPolicy;
    if (options.yolo && session.policy.mode === 'read-only') throw new Error('--yolo conflicts with this conversation’s read-only policy.');
  }
  session.parentSessionId = source.id; session.backendHomes = source.backendHomes; session.goal = newGoal(objective, options.tokenBudget);
  saveSession(session);
  appendEvent(source.id, 'debate.linked', { sessionId: session.id, objective, selectedArtifact: material.id, eventSequences: selected.eventSequences });
  return { session, options: { ...options, mode: 'debate', debateAgents: agents, participants, rounds: options.rounds || 5, artifact: material.id, detach: false } };
}
export function finishChatDebate(sourceId, debateId) {
  const result = getRecord('debate', debateId), session = loadSession(debateId);
  const decision = result?.decision || null;
  const elapsedSeconds = session?.goal?.runtimeUsedSeconds || 0, usage = session?.summary?.usage || result?.usage;
  const statistics = `${duration(elapsedSeconds)} · ${usage ? usage.totalTokens.toLocaleString() + (usage.complete ? ' tokens' : ' known tokens · usage incomplete') : 'usage unavailable'}`;
  const record = { sessionId: debateId, status: session?.goal?.status, decision, elapsedSeconds, usage, unresolvedDisagreement: result?.unresolvedDisagreement || [], evidence: session?.goal?.evidence || [],
    message: `Debate ${session?.goal?.status === 'awaiting_review' ? 'finished · unresolved' : session?.goal?.status || 'interrupted'} · ${statistics}\nSession: ${debateId}\n${formatDecision(decision, result?.unresolvedDisagreement || [])}` };
  putRecord('conversation-debate', sourceId, record); appendEvent(sourceId, 'debate.result', record); return record;
}
