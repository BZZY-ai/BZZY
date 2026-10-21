#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { savedTask, preparationHeld } from './context-state.mjs';

if (process.argv.includes('--version')) { console.log('2.1.305 (Claude Code fixture)'); process.exit(0); }
if (process.argv.includes('auth') && process.argv.includes('status')) { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })); process.exit(0); }
const args = process.argv.slice(2);
const scenario = process.env.BZZY_TEST_SCENARIO || 'complete';
const promptFileIndex = args.indexOf('--append-system-prompt-file');
if (process.env.BZZY_TEST_LOG) fs.appendFileSync(process.env.BZZY_TEST_LOG, JSON.stringify({ args,
  apiKeyPresent: Boolean(process.env.ANTHROPIC_API_KEY), tokenPresent: Boolean(process.env.ANTHROPIC_AUTH_TOKEN),
  ...(process.env.BZZY_TEST_CAPTURE_TASK ? { savedTask: savedTask(),
    systemPrompt: promptFileIndex < 0 ? args[args.indexOf('--append-system-prompt') + 1] : fs.readFileSync(args[promptFileIndex + 1], 'utf8'),
    ...(promptFileIndex < 0 ? {} : { promptFileMode: fs.statSync(args[promptFileIndex + 1]).mode & 0o777 }) } : {}) }) + '\n');
const send = value => console.log(JSON.stringify(value));
let pending;
for await (const line of readline.createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.type === 'control_request' && message.request.subtype === 'initialize') {
    if (preparationHeld()) { if (process.env.BZZY_TEST_LOG) fs.appendFileSync(process.env.BZZY_TEST_LOG, JSON.stringify({ preparing: true }) + '\n'); continue; }
    send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {} } });
  } else if (message.type === 'user') {
    send({ type: 'system', subtype: 'init', session_id: args.includes('--resume') ? args[args.indexOf('--resume') + 1] : args[args.indexOf('--session-id') + 1] });
    if (scenario === 'error') { send({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Fixture infrastructure failure' }); process.exit(1); }
    if (scenario === 'web') {
      send({ type: 'assistant', message: { id: 'web-message', content: [{ type: 'tool_use', id: 'web-fetch', name: 'WebFetch', input: { url: 'https://www.paypal.com/?token=fixture-secret', prompt: 'Inspect the footer' } }] } });
      send({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'web-fetch', content: 'Supplied footer fixture', is_error: false }] } });
    }
    if (scenario === 'approval') {
      pending = true;
      send({ type: 'control_request', request_id: 'approval', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'touch example' } } });
      continue;
    }
    const mcpIndex = args.indexOf('--mcp-config');
    if (mcpIndex !== -1 && ['complete', 'blocked'].includes(scenario)) {
      const server = JSON.parse(fs.readFileSync(args[mcpIndex + 1], 'utf8')).mcpServers.bzzy_goal;
      const report = { status: scenario, evidence: ['Inspected current files and test output.'], ...(scenario === 'blocked' ? { blocker: 'The required external fixture is unavailable.' } : {}) };
      const input = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'update_goal', arguments: report } }) + '\n';
      const result = spawnSync(server.command, server.args, { input, env: { ...process.env, ...server.env }, encoding: 'utf8' });
      if (result.status !== 0 || !result.stdout.includes('Report recorded')) { console.error(result.stderr, result.stdout); process.exit(1); }
    }
    if (scenario !== 'empty') send({ type: 'assistant', message: { id: 'a1', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'example' } }] } });
    send({ type: 'stream_event', event: { delta: { type: 'text_delta', text: 'Verified work.\n' } } });
    send({ type: 'result', subtype: 'success', result: 'Verified work.', usage: { input_tokens: 10, output_tokens: 5 } });
  } else if (message.type === 'control_response' && pending) {
    send({ type: 'stream_event', event: { delta: { type: 'text_delta', text: `decision:${message.response.response.behavior}\n` } } });
    send({ type: 'result', subtype: 'success', result: 'Permission answered.' });
    pending = false;
  }
}
