#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';

if (process.argv.includes('--version')) { console.log('codex-cli 0.162.0 (standalone fixture)'); process.exit(0); }
if (process.argv.includes('login') && process.argv.includes('status')) { console.error('Logged in using ChatGPT'); process.exit(0); }

const body = '<message version="1"><p><b>Standalone Core</b> preserves &amp; replays the original message.</p><table><tr><th>Check</th><th>Status</th></tr><tr><td>Host execution</td><td><span color="mint">Recorded</span></td></tr></table></message>';
if (process.env.BZZY_TEST_LOG) {
  const parent = spawnSync('ps', ['-p', String(process.ppid), '-o', 'args='], { encoding: 'utf8' });
  fs.appendFileSync(process.env.BZZY_TEST_LOG, JSON.stringify({ parent: parent.stdout.trim(), body }) + '\n');
}
const send = value => console.log(JSON.stringify(value));
const notify = (method, params) => send({ method, params: { threadId: 'standalone-thread', ...params } });
for await (const line of readline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  let result = {};
  if (['thread/start', 'thread/resume'].includes(request.method)) result = { thread: { id: 'standalone-thread' } };
  if (request.method === 'turn/start') {
    result = { turn: { id: 'standalone-turn' } };
    setTimeout(() => {
      notify('turn/started', { turn: { id: 'standalone-turn' } });
      const boundary = 71;
      notify('item/agentMessage/delta', { itemId: 'standalone-message', delta: body.slice(0, boundary) });
      notify('item/agentMessage/delta', { itemId: 'standalone-message', delta: body.slice(boundary) });
      notify('turn/completed', { turn: { id: 'standalone-turn', status: 'completed' } });
    }, 20);
  }
  if (request.id != null) send({ id: request.id, result });
}
