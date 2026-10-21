#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';

const args = process.argv.slice(2), claude = !args.includes('app-server');
if (args.includes('--version')) { console.log('codex-cli 0.162.0 (fixture)'); process.exit(0); }
if (args.includes('login')) { console.error('Logged in using ChatGPT'); process.exit(0); }
if (args.includes('auth')) { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })); process.exit(0); }
const log = value => { if (process.env.BZZY_TEST_LOG) fs.appendFileSync(process.env.BZZY_TEST_LOG, JSON.stringify(value) + '\n'); };
const send = value => console.log(JSON.stringify(value));
log({ args });
function document(prompt) {
  const name = /frontmatter name: ([a-z0-9-]+)/.exec(prompt)?.[1] || 'fixture-skill';
  return `---\nname: ${name}\ndescription: Validate response differences using controlled positive and negative checks.\n---\n\n# Controlled verification\n\nEstablish the required environment and supply the authorized target as <TARGET_URL>.\n\n1. Capture the baseline response using the same inputs as the observed run.\n2. Run the positive control and record the observed output.\n3. Run the negative control and preserve disagreements or inconclusive results.\n4. Accept the conclusion only when both controls match the recorded success criteria.\n\nRead [the complete run records](references/run-records.jsonl) for commands, failed attempts and outcomes, and [the evidence index](references/evidence.json) for original artifacts.\n`;
}
for await (const line of readline.createInterface({ input: process.stdin })) {
  const message = JSON.parse(line); log(message);
  if (message.method === 'initialize') send({ id: message.id, result: {} });
  else if (message.method === 'initialized') continue;
  else if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'fixture-document-thread' } } });
  else if (message.method === 'account/rateLimits/read') send({ id: message.id, result: {} });
  else if (message.method === 'turn/start') {
    const prompt = message.params.input[0].text;
    send({ id: message.id, result: { turn: { id: 'document-turn' } } });
    send({ method: 'turn/started', params: { threadId: 'fixture-document-thread', turn: { id: 'document-turn', status: 'inProgress' } } });
    send({ method: 'item/agentMessage/delta', params: { threadId: 'fixture-document-thread', itemId: 'document', delta: document(prompt) } });
    send({ method: 'turn/completed', params: { threadId: 'fixture-document-thread', turn: { id: 'document-turn', status: 'completed' } } });
  } else if (claude && message.type === 'control_request') {
    send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {} } });
  } else if (claude && message.type === 'user') {
    const text = document(message.message.content);
    send({ type: 'stream_event', event: { delta: { type: 'text_delta', text } } });
    send({ type: 'result', subtype: 'success', result: text, usage: { input_tokens: 10, output_tokens: 20 } });
    process.exit(0);
  } else { console.error('Document drafting must not execute goals or tools.'); process.exit(72); }
}
