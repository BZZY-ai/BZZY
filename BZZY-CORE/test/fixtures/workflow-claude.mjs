#!/usr/bin/env node
// Offline native-protocol actor. It records only synthetic test inputs and
// deliberately makes no goal-completion claim or model/network request.
import fs from 'node:fs';
import readline from 'node:readline';

if (process.argv.includes('--version')) { console.log('2.1.80 (offline Claude workflow fixture)'); process.exit(0); }
if (process.argv.includes('auth')) { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })); process.exit(0); }
const log = value => fs.appendFileSync(process.env.BZZY_TEST_LOG, JSON.stringify(value) + '\n');
const args = process.argv.slice(2), fileIndex = args.indexOf('--append-system-prompt-file'), promptIndex = args.indexOf('--append-system-prompt');
const instructions = fileIndex >= 0 ? fs.readFileSync(args[fileIndex + 1], 'utf8') : args[promptIndex + 1];
log({ backend: 'claude', instructions, promptFromFile: fileIndex >= 0 });
for await (const line of readline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(line); log(request);
  if (request.type === 'control_request') console.log(JSON.stringify({ type: 'control_response',
    response: { subtype: 'success', request_id: request.request_id, response: {} } }));
  else if (request.type === 'user') console.log(JSON.stringify({ type: 'result', subtype: 'success', session_id: 'offline-workflow-thread',
    result: 'The offline fixture received the instructions; it makes no completion claim.', usage: { input_tokens: 1, output_tokens: 1 } }));
}
