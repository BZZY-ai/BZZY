#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
import { savedTask, preparationHeld } from './context-state.mjs';

const scenario = process.env.BZZY_TEST_SCENARIO || 'complete';
const log = value => { if (process.env.BZZY_TEST_LOG) fs.appendFileSync(process.env.BZZY_TEST_LOG, JSON.stringify(value) + '\n'); };
if (process.argv.includes('--version')) { console.log('codex-cli 0.162.0 (fixture)'); process.exit(0); }
if (process.argv.includes('login') && process.argv.includes('status')) { console.error('Logged in using ChatGPT'); process.exit(0); }
log({ args: process.argv.slice(2), apiKeyPresent: Boolean(process.env.OPENAI_API_KEY) });
const send = value => console.log(JSON.stringify(value));
const notify = (method, params) => send({ method, params: { threadId: 'native-thread', ...params } });
let goal;
let pendingApproval = false;
const turns = (status = 'complete') => {
  notify('turn/started', { turn: { id: 't1' } });
  if (scenario === 'web') {
    const item = { id: 'open-page', type: 'webSearch', query: '', action: { type: 'openPage', url: 'https://www.paypal.com/?token=fixture-secret' } };
    notify('item/started', { item }); notify('item/completed', { item });
  }
  if (scenario === 'interrupt') return;
  notify('item/agentMessage/delta', { itemId: 'message-1', delta: 'First pass.\n' });
  notify('turn/completed', { turn: { id: 't1', status: 'completed' } });
  if (!goal) return;
  setTimeout(() => {
    notify('turn/started', { turn: { id: 't2' } });
    goal = { ...goal, status, tokensUsed: 42 };
    notify('thread/goal/updated', { goal });
    notify('item/agentMessage/delta', { itemId: 'message-2', delta: 'Verified the full objective.\n' });
    notify('turn/completed', { turn: { id: 't2', status: 'completed' } });
  }, 20);
};
for await (const line of readline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  log(request);
  if (request.method === 'initialize' && request.params?.clientInfo?.name !== 'bzzy-usage' && preparationHeld()) { log({ preparing: true, savedTask: savedTask() }); continue; }
  if (['thread/start', 'thread/resume'].includes(request.method) && process.env.BZZY_TEST_CAPTURE_TASK) log({ savedTask: savedTask() });
  if (request.id === 900 && !request.method) {
    pendingApproval = false;
    send({ method: 'item/agentMessage/delta', params: { threadId: 'native-thread', itemId: 'approval', delta: `decision:${request.result.decision}\n` } });
    notify('turn/completed', { turn: { id: 't1', status: 'completed' } });
    continue;
  }
  let result = {};
  if (request.method === 'initialize') result = { userAgent: 'fixture' };
  else if (request.method === 'thread/start' || request.method === 'thread/resume') result = { thread: { id: 'native-thread' } };
  else if (request.method === 'thread/goal/get') result = { goal: goal || { status: 'paused' } };
  else if (request.method === 'thread/goal/clear') { goal = null; result = { cleared: true }; }
  else if (request.method === 'thread/goal/set') {
    goal = { goalId: 'native-goal', objective: request.params.objective || goal?.objective || 'resume goal', status: request.params.status, tokensUsed: goal?.tokensUsed || 0 };
    result = { goal };
    if (goal.status === 'active') setTimeout(() => turns(scenario === 'blocked' ? 'blocked' : 'complete'), 10);
    else notify('thread/goal/updated', { goal });
  } else if (request.method === 'turn/start') {
    result = { turn: { id: 't1' } };
    setTimeout(() => {
      if (scenario === 'approval') {
        notify('turn/started', { turn: { id: 't1' } });
        pendingApproval = true;
        send({ id: 900, method: 'item/commandExecution/requestApproval', params: { threadId: 'native-thread', command: 'touch example' } });
      } else turns();
    }, 20);
  } else if (request.method === 'turn/interrupt') {
    notify('turn/completed', { turn: { id: request.params.turnId, status: 'interrupted' } });
  }
  if (request.id != null) send({ id: request.id, result });
}
