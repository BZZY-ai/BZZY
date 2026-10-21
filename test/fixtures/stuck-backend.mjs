#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
import { createHash } from 'node:crypto';
const args = process.argv.slice(2), claude = !args.includes('app-server');
if (args.includes('--version')) { console.log('codex-cli 0.162.0 (fixture)'); process.exit(0); }
if (args.includes('login') && args.includes('status')) { console.error('Logged in using ChatGPT'); process.exit(0); }
if (args.includes('auth') && args.includes('status')) { console.log('{"loggedIn":true,"authMethod":"claude.ai"}'); process.exit(0); }
const send = value => fs.writeSync(1, JSON.stringify(value) + '\n');
const notify = (method, params) => send({ method, params: { threadId: 'fixture-thread', ...params } });
process.on('SIGINT', () => {}); process.on('SIGTERM', () => {});
function reply() {
  const mode = fs.readFileSync(process.env.BZZY_TEST_BACKEND_FILE, 'utf8');
  if (mode === 'wait') { fs.appendFileSync(process.env.BZZY_TEST_LOG, JSON.stringify({ backend: process.pid }) + '\n'); return; }
  if (mode === 'slow') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  if (fs.readFileSync(process.env.BZZY_TEST_BACKEND_FILE, 'utf8') === 'block') {
    fs.appendFileSync(process.env.BZZY_TEST_LOG, JSON.stringify({ backend: process.pid }) + '\n');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20000);
  }
  if (claude) {
    send({ type: 'system', subtype: 'init', session_id: 'fixture-thread', model: 'resolved-claude-model' });
    send({ type: 'assistant', message: { id: 'reply', model: 'resolved-claude-model', content: [{ type: 'text', text: 'BZZY_OK' }], usage: { input_tokens: 4, output_tokens: 3 } } });
    send({ type: 'result', subtype: 'success', usage: { input_tokens: 4, output_tokens: 3 } });
    if (fs.readFileSync(process.env.BZZY_TEST_BACKEND_FILE, 'utf8') === 'linger') setInterval(() => {}, 1000);
  } else {
    notify('item/agentMessage/delta', { itemId: 'reply', delta: 'BZZY_OK' });
    notify('thread/tokenUsage/updated', { tokenUsage: { total: { totalTokens: 7 } } });
    notify('turn/completed', { turn: { id: 'turn', status: 'completed' } });
  }
}
for await (const line of readline.createInterface({ input: process.stdin })) {
  const event = JSON.parse(line);
  if (event.method === 'initialize') send({ id: event.id, result: {} });
  else if (event.method === 'initialized') continue;
  else if (event.method === 'thread/start' || event.method === 'thread/resume') send({ id: event.id, result: { thread: { id: 'fixture-thread' }, model: event.params.model || 'fixture-model' } });
  else if (event.method === 'thread/goal/get') send({ id: event.id, result: { goal: null } });
  else if (event.method === 'turn/interrupt') { send({ id: event.id, result: {} }); notify('turn/completed', { turn: { id: 'turn', status: 'interrupted' } }); }
  else if (event.method === 'turn/start') {
    send({ id: event.id, result: { turn: { id: 'turn' } } }); notify('turn/started', { turn: { id: 'turn' } }); reply();
  } else if (event.type === 'control_request') send({ type: 'control_response', response: { request_id: event.request_id, subtype: 'success', response: {} } });
  else if (event.type === 'user') reply();
  if (process.env.BZZY_PROVIDER_API_KEY && event.method === 'turn/start') fs.appendFileSync(process.env.BZZY_TEST_LOG, JSON.stringify({ keyHash: createHash('sha256').update(process.env.BZZY_PROVIDER_API_KEY).digest('hex') }) + '\n');
}
