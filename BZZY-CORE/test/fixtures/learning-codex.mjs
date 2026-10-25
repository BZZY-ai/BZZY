#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';

const profile = 'bzzy_learning_review_v1';
const log = value => { if (process.env.BZZY_TEST_LEARNING_LOG) fs.appendFileSync(process.env.BZZY_TEST_LEARNING_LOG, JSON.stringify(value) + '\n'); };
if (process.argv.includes('--version')) { console.log('codex-cli 0.163.0 (learning fixture)'); process.exit(0); }
if (process.argv.includes('login')) { console.log('Logged in using ChatGPT'); process.exit(0); }
log({ args: process.argv.slice(2) });
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const notify = (method, params) => send({ method, params: { threadId: 'learning-thread', ...params } });
for await (const line of readline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(line); log(request);
  if (process.env.BZZY_TEST_LEARNING_STARTUP_FAILURE && request.method === process.env.BZZY_TEST_LEARNING_STARTUP_FAILURE) {
    send({ id: request.id, error: { code: -32602, message: 'Fixture startup failed: SYNTHETIC_PRIVATE_STARTUP_DETAIL.' } });
    continue;
  }
  if (request.id === 900 && !request.method) {
    notify('item/agentMessage/delta', { itemId: 'review', delta: '{"lessons":[],"skills":[],"profiles":[]}' });
    notify('thread/tokenUsage/updated', { tokenUsage: { total: { totalTokens: 75 } } });
    notify('turn/completed', { turn: { id: 'learning-turn', status: 'completed' } }); continue;
  }
  let result = {};
  if (request.method === 'initialize') result = { userAgent: 'offline learning fixture' };
  else if (request.method === 'permissionProfile/list') result = { data: process.env.BZZY_TEST_LEARNING_BAD_PROFILE ? [] : [{ id: profile, allowed: true }] };
  else if (request.method === 'thread/start') result = { thread: { id: 'learning-thread' }, activePermissionProfile: { id: profile, extends: null } };
  else if (request.method === 'turn/start') {
    result = { turn: { id: 'learning-turn' } };
    setTimeout(() => {
      notify('turn/started', { turn: { id: 'learning-turn' } });
      send({ id: 900, method: 'item/commandExecution/requestApproval', params: { threadId: 'learning-thread', command: 'fixture-only blocked command' } });
    }, 5);
  }
  send({ id: request.id, result });
}
