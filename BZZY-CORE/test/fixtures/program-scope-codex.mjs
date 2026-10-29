#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

if (process.argv.includes('--version')) { console.log('codex-cli 0.165.0 (scope fixture)'); process.exit(0); }
if (process.argv.includes('login')) { console.log('Logged in using ChatGPT'); process.exit(0); }
const fixture = JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME, 'fixture-config.json'), 'utf8'));
const profile = 'bzzy_program_core_http_v1';
for await (const line of readline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  fs.appendFileSync(path.join(process.env.CODEX_HOME, 'fixture-calls.jsonl'), JSON.stringify({ method: request.method }) + '\n');
  let result = {};
  if (request.method === 'initialize') result = { userAgent: 'synthetic scoped backend' };
  else if (request.method === 'config/read') result = fixture.failure === 'config' ? { config: {} } : { config: fixture.config };
  else if (request.method === 'permissionProfile/list') result = { data: fixture.failure === 'profile' ? [] : [{ id: profile, allowed: true }] };
  else if (request.method === 'thread/start') result = { thread: { id: 'scope-fixture-thread' },
    activePermissionProfile: { id: fixture.failure === 'activation' ? 'unexpected-profile' : profile, extends: null } };
  if (request.id != null) process.stdout.write(JSON.stringify({ id: request.id, result }) + '\n');
}
