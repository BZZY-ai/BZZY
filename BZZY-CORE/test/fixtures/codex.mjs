#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { savedTask, preparationHeld } from './context-state.mjs';

const scenario = process.env.BZZY_TEST_SCENARIO || 'complete';
const agentProfile = 'bzzy_agent_isolated_v1';
const agentProfileConfigured = process.argv.includes(`default_permissions="${agentProfile}"`);
const log = value => {
  const destination = process.env.BZZY_TEST_LOG || (agentProfileConfigured && process.env.CODEX_HOME ? path.join(process.env.CODEX_HOME, 'fixture-calls.jsonl') : null);
  if (destination) fs.appendFileSync(destination, JSON.stringify(value) + '\n');
};
if (process.argv.includes('--version')) { console.log('codex-cli 0.162.0 (fixture)'); process.exit(0); }
if (process.argv.includes('login') && process.argv.includes('status')) { console.error('Logged in using ChatGPT'); process.exit(0); }
log({ args: process.argv.slice(2), apiKeyPresent: Boolean(process.env.OPENAI_API_KEY) });
const send = value => console.log(JSON.stringify(value));
const notify = (method, params) => send({ method, params: { threadId: 'native-thread', ...params } });
let goal;
let pendingApproval = false;
const turns = (status = 'complete') => {
  notify('turn/started', { turn: { id: 't1' } });
  if (scenario.startsWith('context-')) {
    const item = { id: 'compact-1', type: 'contextCompaction' };
    notify('item/started', { turnId: 't1', item });
    notify('item/started', { turnId: 't1', item });
    notify('item/completed', { turnId: 't1', item });
    notify('item/completed', { turnId: 't1', item });
    notify('thread/compacted', { turnId: 't1' });
    return;
  }
  if (scenario === 'web') {
    const item = { id: 'open-page', type: 'webSearch', query: '', action: { type: 'openPage', url: 'https://www.paypal.com/?token=fixture-secret' } };
    notify('item/started', { item }); notify('item/completed', { item });
  }
  if (['interrupt', 'interrupt-response-race', 'exit-on-stop', 'rpc-error-on-stop'].includes(scenario)) return;
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
  if (scenario === 'hold-initialize' && request.method === 'initialize') continue;
  if (request.method === 'initialize' && request.params?.clientInfo?.name !== 'bzzy-usage' && preparationHeld()) { log({ preparing: true, savedTask: savedTask() }); continue; }
  if (['thread/start', 'thread/resume'].includes(request.method) && process.env.BZZY_TEST_CAPTURE_TASK) log({ savedTask: savedTask() });
  if (request.id === 900 && !request.method) {
    pendingApproval = false;
    send({ method: 'item/agentMessage/delta', params: { threadId: 'native-thread', itemId: 'approval', delta: `decision:${request.result.decision}\n` } });
    notify('turn/completed', { turn: { id: 't1', status: 'completed' } });
    continue;
  }
  let result = {};
  if (request.method === 'initialize') result = { userAgent: 'fixture',
    ...(['context-refresh', 'context-refresh-unacknowledged', 'context-refresh-rejected', 'context-refresh-held'].includes(scenario)
      ? { capabilities: { hostContextRefresh: { transport: 'turn/steer', acknowledgment: 'turn-id' } } } : {}) };
  else if (request.method === 'permissionProfile/list') result = { data: agentProfileConfigured ? [{ id: agentProfile, allowed: true }] : [] };
  else if (request.method === 'thread/start' || request.method === 'thread/resume') result = { thread: { id: 'native-thread' },
    ...(agentProfileConfigured && request.params.permissions === agentProfile ? { activePermissionProfile: { id: agentProfile, extends: null } } : {}) };
  else if (request.method === 'thread/goal/get') result = { goal: goal || { status: 'paused' } };
  else if (request.method === 'thread/goal/clear') { goal = null; result = { cleared: true }; }
  else if (request.method === 'thread/goal/set') {
    if (scenario === 'context-guard-noack-pause' && request.params.status === 'paused') continue;
    if (scenario === 'exit-on-stop' && request.params.status === 'paused') process.exit(23);
    if (scenario === 'rpc-error-on-stop' && request.params.status === 'paused') {
      send({ id: request.id, error: { code: -32603, message: 'Backend connection closed.' } });
      continue;
    }
    goal = { goalId: 'native-goal', objective: request.params.objective || goal?.objective || 'resume goal', status: request.params.status, tokensUsed: goal?.tokensUsed || 0 };
    result = { goal };
    if (scenario === 'hold-goal-start' && goal.status === 'active') continue;
    if (goal.status === 'active') setTimeout(() => turns(scenario === 'blocked' ? 'blocked' : 'complete'), 10);
    else notify('thread/goal/updated', { goal });
    if (scenario === 'interrupt-response-race' && goal.status === 'paused') {
      notify('turn/completed', { turn: { id: 't1', status: 'interrupted' } });
      setTimeout(() => send({ id: request.id, result }), 100);
      continue;
    }
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
    if (scenario !== 'context-guard-ack-no-turn-complete') notify('turn/completed', { turn: { id: request.params.turnId, status: 'interrupted' } });
    if (scenario === 'interrupt-response-race') {
      setTimeout(() => send({ id: request.id, result }), 100);
      continue;
    }
  } else if (request.method === 'turn/steer') {
    if (scenario === 'context-refresh-held') continue;
    if (scenario === 'context-refresh-rejected') {
      send({ id: request.id, error: { code: -32602, message: 'Fixture turn has already completed.' } }); continue;
    }
    result = scenario === 'context-refresh-unacknowledged' ? {} : { turnId: request.params.expectedTurnId };
  }
  if (request.id != null) send({ id: request.id, result });
}
