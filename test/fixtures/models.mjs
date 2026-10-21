#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';

const send = value => console.log(JSON.stringify(value));
const log = value => { if (process.env.BZZY_TEST_LOG) fs.appendFileSync(process.env.BZZY_TEST_LOG, JSON.stringify(value) + '\n'); };
log({ args: process.argv.slice(2), home: process.env.CODEX_HOME || process.env.CLAUDE_CONFIG_DIR });
for await (const line of readline.createInterface({ input: process.stdin })) {
  const message = JSON.parse(line); log(message);
  if (process.env.BZZY_TEST_MODEL_MODE === 'timeout') continue;
  if (message.method === 'initialize') send({ id: message.id, result: {} });
  else if (message.method === 'initialized') continue;
  else if (message.method === 'model/list') {
    if (process.env.BZZY_TEST_MODEL_MODE === 'error') send({ id: message.id, error: { message: 'Private backend error should not appear in the picker' } });
    else send({ id: message.id, result: { data: message.params.cursor ? [
      { id: 'fixture-light', model: 'fixture-light', displayName: 'Light model', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] },
    ] : [
      { id: 'fixture-brain', model: 'fixture-brain', displayName: 'Brain model', description: 'A model supplied by the installed backend', defaultReasoningEffort: 'medium', supportedReasoningEfforts: ['medium', 'high', 'xhigh'].map(reasoningEffort => ({ reasoningEffort })) },
      { id: 'internal-only', hidden: true },
    ], nextCursor: message.params.cursor ? null : 'page-2' } });
  } else if (message.type === 'control_request' && message.request.subtype === 'initialize') send({ type: 'control_response', response: { request_id: message.request_id, subtype: 'success', response: { models: [
    { value: 'default', displayName: 'Default' }, { value: 'sonnet', displayName: 'Sonnet', supportsEffort: true, supportedEffortLevels: ['medium', 'high'] }, { value: 'haiku', displayName: 'Haiku' },
  ] } } });
  else { console.error('Model discovery must never create a thread, send a user prompt or execute tools.'); process.exit(72); }
}
