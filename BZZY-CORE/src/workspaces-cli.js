import { randomUUID } from 'node:crypto';
import { CoreWorkspaces } from './workspaces.js';
import { fail } from './validation.js';

export function workspaceCommand(args) {
  const [command = 'help', ...rest] = args;
  if (command === 'help') {
    console.log('Usage: bzzy-core workspace <status|set /absolute/host/folder>\nSets the default home for managed agents/imports; existing CLI terminals keep their original directories. Missing folders are created.');
    return;
  }
  const workspaces = new CoreWorkspaces();
  if (command === 'status' && !rest.length) console.log(JSON.stringify(workspaces.settings()));
  else if (command === 'set' && rest.length === 1) {
    const shown = workspaces.settings();
    console.log(JSON.stringify(workspaces.configure({ path: rest[0], create: true }, { expectedRevision: shown.revision, requestId: randomUUID() })));
  } else fail('INVALID_REQUEST', 'Run bzzy-core workspace help.');
}
