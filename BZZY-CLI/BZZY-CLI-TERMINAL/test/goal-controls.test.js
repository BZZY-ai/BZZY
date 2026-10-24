import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmGoalReplacement } from '../src/goal-controls.js';

test('replacement picker defaults to No and returns the confirmed goal identity only on Yes', async () => {
  const goal = { id: 'current-goal', status: 'verifying', objective: 'Current objective' };
  const ui = { tui: {}, chooseOne: async (title, content) => {
    assert.equal(title, 'Replace current goal?'); assert.equal(content.choices[0].selected, true); return 'no';
  } };
  assert.deepEqual(await confirmGoalReplacement(ui, goal), { confirmed: false });
  ui.chooseOne = async () => 'yes';
  assert.deepEqual(await confirmGoalReplacement(ui, goal), { confirmed: true, replaceGoalId: goal.id });
  ui.chooseOne = async () => null;
  assert.deepEqual(await confirmGoalReplacement(ui, goal), { confirmed: false });
  for (const status of ['complete', 'blocked', 'awaiting_review', 'cancelled']) {
    assert.deepEqual(await confirmGoalReplacement(ui, { ...goal, status }), { confirmed: true });
  }
});
