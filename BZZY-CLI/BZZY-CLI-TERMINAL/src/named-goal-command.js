import { savedGoalStatus, controlNamedGoal } from '@bzzy/core/engine/host-goal-control.js';

export async function namedGoalCLI(options) {
  try {
    const result = options.goalAction === 'status' ? savedGoalStatus(options.attach)
      : await controlNamedGoal(options.attach, options.goalAction, { requestId: options.requestId, tokenBudget: options.tokenBudget });
    if (options.json) process.stdout.write(JSON.stringify(result) + '\n');
    else {
      const label = result.alias || result.sessionId;
      process.stdout.write(`${label} · ${result.status}\n`);
      if (result.accepted) process.stdout.write(`Goal ${result.action === 'pause' ? 'pause' : 'continue'} accepted${result.executionId ? ' · execution ' + result.executionId : ''}.\n`);
      if (result.reason) process.stdout.write(`Reason: ${result.reason}\n`);
      if (result.notice) process.stdout.write(result.notice + '\n');
    }
    return 0;
  } catch (error) {
    const message = error.message || 'Goal control failed.';
    process.stderr.write(options.json ? JSON.stringify({ error: message, code: error.code || 'GOAL_CONTROL_FAILED' }) + '\n' : `bzzy: ${message}\n`);
    return 1;
  }
}
