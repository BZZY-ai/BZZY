#!/usr/bin/env node
// A synthetic native supervisor calls the real Core delegate tool. Its worker
// reports inconclusive rather than inventing evidence or verified completion.
import fs from 'node:fs';
import readline from 'node:readline';

if (process.argv.includes('--version')) { console.log('codex-cli 0.162.0 (offline workflow fixture)'); process.exit(0); }
if (process.argv.includes('login')) { console.log('Logged in using ChatGPT'); process.exit(0); }
const profile = 'bzzy_agent_isolated_v1', isolated = process.argv.includes(`default_permissions="${profile}"`);
const send = value => console.log(JSON.stringify(value)), threadId = 'offline-delegate-thread';
const notify = (method, params) => send({ method, params: { threadId, ...params } });
let context, goal;
const completeTurn = () => notify('turn/completed', { turn: { id: 'offline-turn', status: 'completed' } });
for await (const line of readline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  fs.appendFileSync(process.env.BZZY_TEST_LOG, JSON.stringify(request) + '\n');
  if (!request.method) {
    if (request.id === 801) {
      goal = { ...goal, status: 'blocked', tokensUsed: 3 };
      notify('thread/goal/updated', { goal }); completeTurn();
    } else if (request.id === 802) completeTurn();
    continue;
  }
  let result = {};
  if (request.method === 'initialize') result = { userAgent: 'offline-workflow-delegate' };
  else if (request.method === 'permissionProfile/list') result = { data: isolated ? [{ id: profile, allowed: true }] : [] };
  else if (['thread/start', 'thread/resume'].includes(request.method)) {
    const instructions = request.params.developerInstructions, marker = 'DURABLE TASK CONTEXT:\n';
    context = JSON.parse(instructions.slice(instructions.lastIndexOf(marker) + marker.length));
    result = { thread: { id: threadId }, ...(isolated ? { activePermissionProfile: { id: profile, extends: null } } : {}) };
  } else if (request.method === 'thread/goal/get') result = { goal: goal || { status: 'paused' } };
  else if (request.method === 'thread/goal/clear') { goal = null; result = { cleared: true }; }
  else if (request.method === 'thread/goal/set') {
    goal = { goalId: 'offline-delegate-goal', objective: request.params.objective, status: request.params.status };
    result = { goal };
    if (goal.status === 'active') setTimeout(() => {
      notify('turn/started', { turn: { id: 'offline-turn' } });
      send({ id: 801, method: 'item/tool/call', params: { threadId, turnId: 'offline-turn', callId: 'workflow-delegate', tool: 'delegate',
        arguments: { requestId: 'offline-workflow-child', objective: 'Inspect the supplied offline control.', context: 'Preserve the complete immutable original mission and report uncertainty.',
          acceptanceCriteria: ['State the limited offline observation without inventing verification.'], limits: { runtimeSeconds: 5 }, waitSeconds: 5 } } });
    }, 10);
  } else if (request.method === 'turn/start') {
    result = { turn: { id: 'offline-turn' } };
    setTimeout(() => {
      notify('turn/started', { turn: { id: 'offline-turn' } });
      send({ id: 802, method: 'item/tool/call', params: { threadId, turnId: 'offline-turn', callId: 'workflow-worker', tool: 'finish_assignment',
        arguments: { status: 'inconclusive', summary: 'The offline workflow fixture received the full mission; no real model or external assessment was run.', evidence: [],
          uncertainties: ['This native-protocol fixture cannot verify a real objective.'] } } });
    }, 10);
  } else if (request.method === 'turn/interrupt') completeTurn();
  if (request.id !== undefined) send({ id: request.id, result });
}
