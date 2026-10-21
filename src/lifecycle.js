import { randomUUID } from 'node:crypto';

export function goalEvent(session) {
  const goal = session.goal;
  if (!goal) return null;
  const completed = goal.status === 'complete';
  const stalled = ['blocked', 'usage_limited', 'budget_limited', 'awaiting_review'].includes(goal.status) || (goal.status === 'paused' && goal.reason === 'turn_limit');
  if (!completed && !stalled) return null;
  return { version: 1, id: randomUUID(), type: completed ? 'goal.completed' : 'goal.stalled', occurredAt: new Date().toISOString(),
    sessionId: session.id, goalId: goal.id, epoch: goal.notificationEpoch || 0, provider: session.provider, model: session.model,
    cwd: session.cwd, objective: goal.objective, status: goal.status, reason: goal.reason || null, evidence: goal.evidence || [],
    usage: { tokens: goal.tokensUsed || 0, seconds: goal.runtimeUsedSeconds ?? goal.timeUsedSeconds ?? null, turns: goal.turns || 0,
      available: session.summary?.usage?.complete ?? goal.tokensUsed != null, agents: session.summary?.usage?.agents || [] } };
}
