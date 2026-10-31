const legacyStatuses = Object.freeze({
  usageLimited: 'usage_limited', budgetLimited: 'budget_limited', awaitingReview: 'awaiting_review',
});
const legacyReasons = Object.freeze({
  tokenLimit: 'token_limit', runtimeLimit: 'runtime_limit', turnLimit: 'turn_limit',
  recoveryRequired: 'recovery_required', contextNoProgress: 'context_no_progress',
});

// Native adapters and old saved sessions can use the protocol's camelCase
// spellings. Core exposes one lifecycle vocabulary without rewriting history.
export const canonicalGoalStatus = status => Object.hasOwn(legacyStatuses, status) ? legacyStatuses[status] : status;
export const canonicalGoalReason = reason => Object.hasOwn(legacyReasons, reason) ? legacyReasons[reason] : reason;

// Shared lifecycle classification; a manual pause/cancel is not a stalled goal.
export const isStalledGoal = goal => {
  if (!goal) return false;
  const status = canonicalGoalStatus(goal.status), reason = canonicalGoalReason(goal.reason);
  return ['blocked', 'usage_limited', 'budget_limited', 'awaiting_review'].includes(status)
    || status === 'paused' && ['turn_limit', 'recovery_required', 'context_no_progress'].includes(reason);
};
