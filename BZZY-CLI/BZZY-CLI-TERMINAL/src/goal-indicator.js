import { palette } from './terminal-theme.js';
import { clean } from './terminal-format.js';
const dots = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const validationReasons = {
  original_goal_unsupported: 'The original goal was not supported.',
  host_checks_incomplete: 'Required evidence or verification checks are incomplete.',
  source_or_evidence_changed: 'The original goal or its evidence changed.',
  review_goal_changed: 'The validation goal changed.', review_evidence_changed: 'The review evidence changed.',
  review_budget_limited: 'Validation stopped at its budget limit.', review_final_missing: 'The final validation record is missing.',
  review_not_completed: 'The validation did not finish.', review_not_recorded: 'The validation is not recorded.',
  review_paused: 'Validation is paused.', review_cancelled: 'Validation was cancelled.',
  agent_dissent: 'A reviewer found a conflicting result. The goal has not been validated.',
  missing_evidence: 'The available evidence did not settle the question.',
};
export function goalIndicator(goal, frame = 0, { validating = false } = {}) {
  if (!goal) return null;
  if (goal.status === 'complete') return { label: 'Goal achieved ✓', tone: palette.goalSuccess };
  if (['blocked', 'usage_limited', 'budget_limited', 'awaiting_review'].includes(goal.status) || goal.status === 'paused' && goal.reason === 'turn_limit')
    return { label: '✕ Goal stalled', tone: palette.danger };
  if (goal.status === 'paused') return { label: 'Ⅱ Goal paused', tone: palette.warning };
  if (goal.status === 'cancelled') return { label: '✕ Goal cancelled', tone: palette.muted };
  if (['active', 'verifying'].includes(goal.status)) return { label: dots[frame % dots.length] + (validating ? ' Validating…' : goal.status === 'verifying' ? ' Verifying goal...' : ' Pursuing goal...'), tone: palette.goalActive, animated: true };
  return null;
}

// Presentation follows the admitted execution, never an optimistic input submit
// or a remembered goal. Queued/stopping/input waits remain explicit.
export function chatWorkIndicator({ busy, state } = {}, frame = 0) {
  if (!busy) return null;
  if (state === 'needs your input') return { label: 'Needs your input', tone: palette.warning };
  const label = state === 'queued' ? 'Queued…' : state === 'starting' ? 'Starting…' : state === 'stopping' ? 'Stopping…' : 'Cooking…';
  return { label: dots[frame % dots.length] + ' ' + label, tone: palette.goalActive, animated: true };
}

export function goalValidationIndicator(goal, validation, frame = 0) {
  if (!goal?.id || goal.status !== 'complete' || !validation || validation.sourceGoalId !== goal.id
    || !Number.isSafeInteger(validation.revision) || validation.revision < 1) return null;
  const state = validation.state;
  if (state === 'none') return null;
  const reason = validationReasons[validation.reason] || clean(String(validation.reason || '')).replaceAll('_', ' ').replace(/\s+/g, ' ').trim();
  if (state === 'validated') {
    if (!validation.reviewSessionId || !['sourceRevision', 'resultRevision', 'evidenceFingerprint'].every(key => /^[a-f0-9]{64}$/.test(validation[key] || '')))
      return { label: 'Validation inconclusive', tone: palette.warning, reason: 'Core validation metadata is incomplete.' };
    return { label: 'Validated ✓', tone: palette.goalSuccess };
  }
  if (state === 'not_validated') return { label: 'Not validated ✗', tone: palette.danger, reason };
  if (state === 'inconclusive') return { label: 'Validation inconclusive', tone: palette.warning, reason };
  if (state === 'pending') return { label: dots[frame % dots.length] + ' Validating…', tone: palette.goalActive, animated: true };
  if (state === 'paused') return { label: 'Ⅱ Validation paused', tone: palette.muted, reason };
  if (state === 'cancelled') return { label: 'Validation cancelled', tone: palette.muted, reason };
  if (state === 'stale') return { label: 'Validation stale', tone: palette.warning, reason };
  return null;
}
