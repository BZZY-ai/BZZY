import { needsGoalReplacement, parseGoalCommand } from '@bzzy/core/engine/goals.js';
import { chooseSavedGoal } from './saved-goals-ui.js';

// A selected objective is data, including words such as "resume" or "clear".
// Keep that intent separate from slash-command parsing all the way to admission.
export async function resolveInteractiveGoal(input, ui, options) {
  const command = parseGoalCommand(input);
  if (!command) return null;
  if (input.trim() !== '/goal') return command;
  const saved = await chooseSavedGoal(ui, options);
  return saved ? { objective: saved.objective } : { cancelled: true };
}

export async function confirmGoalReplacement(ui, goal) {
  if (!needsGoalReplacement(goal)) return { confirmed: true };
  const answer = ui.tui ? await ui.chooseOne('Replace current goal?', {
    description: goal.objective,
    choices: [{ value: 'no', label: 'No · Keep current goal', selected: true }, { value: 'yes', label: 'Yes · Replace goal' }],
  }) : await ui.ask(`Replace current goal? ${goal.objective} [y/N] `);
  return ['yes', 'y'].includes(String(answer || '').trim().toLowerCase())
    ? { confirmed: true, replaceGoalId: goal.id } : { confirmed: false };
}
