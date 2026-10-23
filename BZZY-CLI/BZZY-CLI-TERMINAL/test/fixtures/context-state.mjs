import fs from 'node:fs';
import path from 'node:path';

// Capture the durable contract at the actual backend boundary, before any inference.
export function savedTask() {
  if (!process.env.BZZY_TEST_CAPTURE_TASK) return undefined;
  const directory = path.join(process.env.BZZY_HOME, 'sessions');
  const sessions = fs.readdirSync(directory).filter(name => name.endsWith('.json'))
    .map(name => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const session = sessions[0];
  return { id: session.id, goal: session.goal, contract: session.contract };
}

export function preparationHeld() {
  return Boolean(process.env.BZZY_TEST_PREPARATION_GATE && fs.existsSync(process.env.BZZY_TEST_PREPARATION_GATE));
}
