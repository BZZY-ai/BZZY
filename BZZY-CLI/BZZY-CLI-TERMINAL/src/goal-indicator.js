import { palette } from './terminal-theme.js';
const dots = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
export function goalIndicator(goal, frame = 0) {
  if (!goal) return null;
  if (goal.status === 'complete') return { label: '✔ Goal achieved', tone: palette.goalSuccess };
  if (['blocked', 'usage_limited', 'budget_limited', 'awaiting_review'].includes(goal.status) || goal.status === 'paused' && goal.reason === 'turn_limit')
    return { label: '✕ Goal stalled', tone: palette.danger };
  if (goal.status === 'paused') return { label: 'Ⅱ Goal paused', tone: palette.warning };
  if (goal.status === 'cancelled') return { label: '✕ Goal cancelled', tone: palette.muted };
  if (['active', 'verifying'].includes(goal.status)) return { label: dots[frame % dots.length] + (goal.status === 'verifying' ? ' Verifying goal...' : ' Pursuing goal...'), tone: palette.goalActive, animated: true };
  return null;
}
