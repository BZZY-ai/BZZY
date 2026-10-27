#!/usr/bin/env node
// Offline protocol fixture: no model, account, HTTP or target operation.
import readline from 'node:readline';
if (process.argv.includes('auth')) { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })); process.exit(0); }
const send = value => console.log(JSON.stringify(value));
for await (const line of readline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.type === 'control_request') send({ type: 'control_response', response: { subtype: 'success', request_id: request.request_id, response: {} } });
  if (request.type !== 'user') continue;
  send({ type: 'system', subtype: 'init', session_id: 'offline-claude-thread', model: 'fixture-model', tools: ['mcp__bzzy_goal__list_skills'] });
  for (const id of ['message-1', 'message-2']) {
    send({ type: 'stream_event', event: { type: 'message_start', message: { id } } });
    send({ type: 'stream_event', event: { delta: { type: 'text_delta', text: `Visible ${id}.` } } });
    send({ type: 'assistant', session_id: 'offline-claude-thread', message: { id, content: [{ type: 'text', text: `Visible ${id}.` }] } });
    if (id === 'message-1') for (let duplicate = 0; duplicate < 2; duplicate++) send({ type: 'system', subtype: 'compact_boundary', uuid: 'compact-1', session_id: 'offline-claude-thread' });
  }
  send({ type: 'result', subtype: 'success', session_id: 'offline-claude-thread', result: 'The offline fixture ended.', usage: { input_tokens: 1, output_tokens: 1 } });
}
