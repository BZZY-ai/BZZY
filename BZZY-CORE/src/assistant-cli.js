import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CoreAssistant } from './assistant.js';
import { fail } from './validation.js';

const HELP = 'Usage: bzzy-core assistant <status|providers|set PROVIDER [--model MODEL] [--effort EFFORT]|copy-cli|context WORKSPACE>\nCore has its own provider/model/effort selection. copy-cli copies the current CLI selection once; inherit is a compatibility alias for copy-cli. Provider login stays in the existing bzzy auth flow. Context creation is idle and grants no new access.';
export function assistantCommand(args) {
  const [command = 'help', ...rest] = args;
  if (command === 'help') { console.log(HELP); return; }
  const assistant = new CoreAssistant();
  let result;
  if (command === 'set') {
    if (!rest[0] || rest.length % 2 !== 1) fail('INVALID_REQUEST', HELP);
    const input = { source: 'core', provider: rest[0] };
    for (let index = 1; index < rest.length; index += 2) {
      const field = { '--model': 'model', '--effort': 'effort' }[rest[index]];
      if (!field || Object.hasOwn(input, field)) fail('INVALID_REQUEST', HELP);
      input[field] = rest[index + 1];
    }
    result = assistant.configure(input, { requestId: randomUUID(), expectedRevision: assistant.settings().revision });
  } else if (command === 'context') {
    if (rest.length !== 1) fail('INVALID_REQUEST', HELP);
    result = assistant.createContext({ cwd: path.resolve(rest[0]) }, { requestId: randomUUID() });
  } else {
    if (rest.length) fail('INVALID_REQUEST', HELP);
    if (command === 'status') result = assistant.settings();
    else if (command === 'providers') result = assistant.providers();
    else if (['copy-cli', 'inherit'].includes(command)) result = assistant.configure({ source: 'cli' }, { requestId: randomUUID(), expectedRevision: assistant.settings().revision });
    else fail('INVALID_REQUEST', HELP);
  }
  console.log(JSON.stringify(result));
}
