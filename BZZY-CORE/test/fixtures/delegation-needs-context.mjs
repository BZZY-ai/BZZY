#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

if (process.argv.includes('--version')) { console.log('codex-cli 0.163.0 (offline context fixture)'); process.exit(0); }
if (process.argv.includes('login')) { console.log('Logged in using ChatGPT'); process.exit(0); }
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const thread = 'offline-needs-context-thread', turn = 'offline-needs-context-turn';
const notify = (method, params) => send({ method, params: { threadId: thread, ...params } });
// Deliberately fail to complete the turn after interrupt, ignore signals and
// retain an event-loop handle after EOF. The host must close/kill this backend.
process.on('SIGINT', () => {}); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);
for await (const line of readline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(line); if (!request.method) continue;
  let result = {};
  if (['thread/start', 'thread/resume'].includes(request.method)) result = { thread: { id: thread } };
  if (request.method === 'turn/start') {
    result = { turn: { id: turn } };
    setTimeout(() => {
      const pidFile = path.join(process.env.CODEX_HOME, 'offline-needs-context-pid.json');
      fs.writeFileSync(pidFile + '.tmp', JSON.stringify({ pid: process.pid })); fs.renameSync(pidFile + '.tmp', pidFile);
      notify('turn/started', { turn: { id: turn } });
      send({ id: 901, method: 'item/tool/call', params: { threadId: thread, turnId: turn, callId: 'context-request', tool: 'finish_assignment',
        arguments: { status: 'needs_context', requestId: 'native-missing-baseline', summary: 'The offline fixture lacks a named authorized baseline.', evidence: [],
          questions: [{ id: 'baseline', question: 'Which supplied observation is the authorized baseline?' }] } } });
    }, 10);
  }
  if (request.id !== undefined) send({ id: request.id, result });
}
