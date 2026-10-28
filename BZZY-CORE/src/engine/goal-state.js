// Shared lifecycle classification; a manual pause/cancel is not a stalled goal.
export const isStalledGoal = goal => Boolean(goal && (['blocked', 'usage_limited', 'budget_limited', 'awaiting_review'].includes(goal.status)
  || goal.status === 'paused' && ['turn_limit', 'recovery_required', 'context_no_progress'].includes(goal.reason)));
