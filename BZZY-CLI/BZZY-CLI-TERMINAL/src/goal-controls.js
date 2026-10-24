import { needsGoalReplacement } from '@bzzy/core/engine/goals.js';

export async function confirmGoalReplacement(ui, goal) {
  if (!needsGoalReplacement(goal)) return { confirmed: true };
  const answer = ui.tui ? await ui.chooseOne('Replace current goal?', {
    description: goal.objective,
    choices: [{ value: 'no', label: 'No · Keep current goal', selected: true }, { value: 'yes', label: 'Yes · Replace goal' }],
  }) : await ui.ask(`Replace current goal? ${goal.objective} [y/N] `);
  return ['yes', 'y'].includes(String(answer || '').trim().toLowerCase())
    ? { confirmed: true, replaceGoalId: goal.id } : { confirmed: false };
}
