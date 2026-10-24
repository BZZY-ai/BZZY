import { randomUUID } from 'node:crypto';
import { goalReplyPreview } from './notification-preview.js';
import { isStalledGoal } from './goal-state.js';

export function goalEvent(session, { question } = {}) {
  const goal = session.goal;
  if (!goal) return null;
  if (goal.importedHistorical) return null;
  const completed = goal.status === 'complete';
  const stalled = isStalledGoal(goal);
  const paused = goal.status === 'paused', cancelled = goal.status === 'cancelled';
  if (!completed && !stalled && !paused && !cancelled && !question) return null;
  const usage = session.summary?.usage || session.delegationUsage;
  return { version: 1, id: randomUUID(), type: question ? 'goal.waiting_for_input' : completed ? 'goal.completed' : stalled ? 'goal.stalled' : paused ? 'goal.paused' : 'goal.cancelled', occurredAt: new Date().toISOString(),
    ...(question ? { question: { id: question.id, text: question.question, kind: question.kind } } : {}),
    sessionId: session.id, goalId: goal.id, epoch: question ? `${goal.notificationEpoch || 0}-${question.id}` : goal.notificationEpoch || 0, provider: session.provider, model: session.model, mode: session.mode || 'solo',
    ...(session.mode === 'delegate' ? { executor: { provider: session.executor?.provider, model: session.executor?.model || null } } : {}),
    ...(session.modeResult?.goalId === goal.id ? { result: session.modeResult } : {}),
    cwd: session.cwd, objective: goal.objective, replyPreview: question || goal.reason === 'verification_interrupted' ? '' : goalReplyPreview(session), status: goal.status, reason: goal.reason || null, evidence: goal.evidence || [],
    usage: { tokens: goal.tokensUsed || 0, seconds: goal.runtimeUsedSeconds ?? goal.timeUsedSeconds ?? null, turns: goal.turns || 0,
      available: session.summary?.usage?.complete ?? goal.tokensUsed != null, agents: session.summary?.usage?.agents || [],
      ...(session.mode === 'delegate' ? { supervisorTokens: usage?.supervisorTokens ?? goal.nativeTokensUsed ?? goal.supervisorTokensUsed ?? null,
        delegatedTokens: usage?.delegatedTokens ?? goal.delegatedTokensUsed ?? 0, assignmentCount: usage?.assignmentCount ?? null,
        providers: usage?.providers || [] } : {}) } };
}
