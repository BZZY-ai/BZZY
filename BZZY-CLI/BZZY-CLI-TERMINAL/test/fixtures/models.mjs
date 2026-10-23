#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';

const send = value => console.log(JSON.stringify(value));
const log = value => { if (process.env.BZZY_TEST_LOG) fs.appendFileSync(process.env.BZZY_TEST_LOG, JSON.stringify(value) + '\n'); };
log({ args: process.argv.slice(2), home: process.env.CODEX_HOME || process.env.CLAUDE_CONFIG_DIR, pid: process.pid });
let doctor = false;
const connectionMode = process.env.BZZY_TEST_CONNECTION_MODE;
for await (const line of readline.createInterface({ input: process.stdin })) {
  const message = JSON.parse(line); log(message);
  if (process.env.BZZY_TEST_MODEL_MODE === 'timeout' || connectionMode === 'init-timeout') continue;
  if (message.method === 'initialize') { doctor = message.params.clientInfo.name === 'bzzy-doctor'; send({ id: message.id, result: {} }); }
  else if (message.method === 'initialized') continue;
  else if (message.method === 'model/list') {
    if (process.env.BZZY_TEST_MODEL_MODE === 'error') send({ id: message.id, error: { message: 'Private backend error should not appear in the picker' } });
    else send({ id: message.id, result: { data: message.params.cursor ? [
      { id: 'fixture-light', model: 'fixture-light', displayName: 'Light model', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] },
    ] : [
      { id: 'fixture-brain', model: 'fixture-brain', displayName: 'Brain model', description: 'A model supplied by the installed backend', defaultReasoningEffort: 'medium', supportedReasoningEfforts: ['medium', 'high', 'xhigh'].map(reasoningEffort => ({ reasoningEffort })) },
      { id: 'internal-only', hidden: true },
    ], nextCursor: message.params.cursor ? null : 'page-2' } });
  } else if (message.type === 'control_request' && message.request.subtype === 'initialize') { doctor = process.argv.includes('--no-session-persistence'); send({ type: 'control_response', response: { request_id: message.request_id, subtype: 'success', response: { models: [
    { value: 'default', displayName: 'Default' }, { value: 'sonnet', displayName: 'Sonnet', supportsEffort: true, supportedEffortLevels: ['medium', 'high'] }, { value: 'haiku', displayName: 'Haiku' },
  ] } } }); }
  else if (doctor && message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'doctor-thread' }, model: message.params.model || 'fixture-brain' } });
  else if (doctor && message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: 'doctor-turn' } } });
    if (connectionMode === 'reply-timeout') continue;
    if (connectionMode === 'error') { send({ method: 'error', params: { threadId: 'doctor-thread', willRetry: false, error: { message: 'Rejected model; Bearer secret-example' } } }); continue; }
    if (connectionMode !== 'empty') send({ method: 'item/agentMessage/delta', params: { threadId: 'doctor-thread', delta: 'BZZY_OK' } });
    send({ method: 'thread/tokenUsage/updated', params: { threadId: 'doctor-thread', tokenUsage: { total: { totalTokens: 7 } } } });
    send({ method: 'turn/completed', params: { threadId: 'doctor-thread', turn: { id: 'doctor-turn', status: 'completed' } } });
  } else if (doctor && message.type === 'user') {
    if (connectionMode === 'reply-timeout') continue;
    send({ type: 'result', subtype: connectionMode === 'error' ? 'error_during_execution' : 'success', is_error: connectionMode === 'error',
      result: connectionMode === 'error' ? 'Rejected model; Bearer secret-example' : connectionMode === 'empty' ? '' : 'BZZY_OK', usage: { input_tokens: 4, output_tokens: 3 } });
  }
  else { console.error('Model discovery must never create a thread, send a user prompt or execute tools.'); process.exit(72); }
}
