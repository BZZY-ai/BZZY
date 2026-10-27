#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

if (process.argv.includes('--version')) { console.log('codex-cli 0.162.0 (missing-thread fixture)'); process.exit(0); }
if (process.argv.includes('login') && process.argv.includes('status')) { console.error('Logged in using ChatGPT'); process.exit(0); }
const spec = JSON.parse(process.env.BZZY_TEST_SCENARIO || '{}');
const log = request => fs.appendFileSync(process.env.BZZY_TEST_LOG, JSON.stringify(request) + '\n');
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const notify = (method, params) => send({ method, params });
let loaded = Boolean(spec.initiallyLoaded), threadId = 'old-native-thread';
let goal = spec.nativeGoalMissing ? null : { id: 'old-native-goal', status: spec.existingGoalActive ? 'active' : 'paused', tokensUsed: 50 };
function failure(request, definition) {
  if (!definition) return false;
  if (definition === 'transport') { process.stderr.write('Fixture transport ended without a definitive RPC missing-thread response.'); process.exit(23); }
  send({ id: request.id, error: { code: definition.code, message: definition.message } }); return true;
}
for await (const line of readline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(line); log(request); let result = {};
  if (request.method === 'initialize') result = { userAgent: 'explicit-missing-thread-fixture' };
  else if (request.method === 'thread/resume') {
    if (spec.resumeDelayMs) await delay(spec.resumeDelayMs);
    if (spec.startupTurnBeforeResumeError) {
      notify('turn/started', { threadId, turn: { id: 'unexpected-startup-turn' } });
      notify('turn/completed', { threadId, turn: { id: 'unexpected-startup-turn', status: 'completed' } });
    }
    if (failure(request, spec.resumeError)) continue;
    if (spec.resumeReplyKind) {
      send({ id: request.id, ...(spec.resumeReplyKind === 'missing' ? {} : { result: spec.resumeReplyKind === 'null' ? null : false }) }); continue;
    }
    if (request.params.threadId !== 'old-native-thread') throw new Error('Unexpected fixture resume identity.');
    loaded = true; result = { thread: { id: threadId } };
  } else if (request.method === 'thread/start') {
    if (failure(request, spec.startError)) continue;
    loaded = true; threadId = 'replacement-native-thread'; goal = null; result = { thread: { id: threadId } };
  } else if (request.method === 'thread/goal/get') {
    if (!loaded) { send({ id: request.id, error: { code: -32600, message: `thread not found: ${request.params.threadId}` } }); continue; }
    if (failure(request, spec.getError)) continue;
    result = { goal };
  } else if (request.method === 'thread/goal/clear') { goal = null; result = { cleared: true }; }
  else if (request.method === 'thread/goal/set') {
    if (request.params.status === 'paused' && failure(request, spec.pauseError)) continue;
    if (request.params.status === 'active' && failure(request, spec.activeGoalError)) continue;
    if (!goal && request.params.status === 'active' && !request.params.objective) {
      send({ id: request.id, error: { code: -32602, message: 'The new fixture goal requires the complete original objective.' } }); continue;
    }
    goal = { id: goal?.id || 'replacement-native-goal', status: request.params.status, tokensUsed: goal?.tokensUsed || 0 };
    result = { goal };
    if (request.params.status === 'active') {
      setTimeout(() => {
        notify('turn/started', { threadId, turn: { id: 'fixture-goal-turn' } });
        goal = { ...goal, status: 'paused', tokensUsed: goal.tokensUsed + 2 };
        notify('thread/goal/updated', { threadId, goal });
        notify('turn/completed', { threadId, turn: { id: 'fixture-goal-turn', status: 'completed' } });
      }, 10);
    }
  } else if (request.method === 'turn/start') {
    if (failure(request, spec.turnError)) continue;
    result = { turn: { id: 'fixture-chat-turn' } };
    setTimeout(() => {
      notify('turn/started', { threadId, turn: { id: 'fixture-chat-turn' } });
      notify('turn/completed', { threadId, turn: { id: 'fixture-chat-turn', status: 'completed' } });
    }, 10);
  } else if (request.method === 'turn/interrupt') {
    notify('turn/completed', { threadId, turn: { id: request.params.turnId, status: 'interrupted' } });
  }
  if (request.id !== undefined) send({ id: request.id, result });
}
